// Making a map: a head start from the code facts, Claude explores and drafts, the checker re-reads the code, and Claude
// gets up to `repairs` chances to fix what didn't check out. A repair returns only the changes (`patchMap`), not the
// whole map again, since writing the map is most of the time a map takes. The best attempt wins; nothing unconfirmed
// is hidden.
import { check, parseMap, patchMap, resolveCommit, settledProposals, type CheckReport, type CodeMap, type ParseResult } from '@illuminate/core';
import type { Agent, Progress } from './agent';
import { headStart, symbolIndexOf } from './hints';
import { evidenceRepairPrompt, makerPrompt, patchRepairPrompt, shapeRepairPrompt } from './prompts';
import { MAP_PATCH_SCHEMA, MAP_SCHEMA, RawMapPatch } from './schemas';

export type Status = { kind: 'status'; text: string };
export type MakeOptions = {
  root: string;
  question: string;
  agent: Agent;
  model?: string;
  repairs?: number;
  /** Who does the drafting, as the progress names them (default "Claude"; "Codex" when the channel runs in Codex). */
  agentName?: string;
  onProgress?: (p: Progress | Status) => void;
  signal?: AbortSignal;
};
export type MakeResult = { map: CodeMap; report: CheckReport; sessionId: string | null; cost: number; rounds: number };

const withQuestion = (output: unknown, question: string) =>
  output && typeof output === 'object' ? { ...(output as Record<string, unknown>), version: 1, question } : output;

/** Claude's changes applied to the map they're for, or what stops them from applying. */
function applyPatch(map: CodeMap, output: unknown): ParseResult {
  const raw = RawMapPatch.safeParse(output);
  if (!raw.success) return { ok: false, problems: raw.error.issues.map((i) => `${i.path.join('.') || '(changes)'}: ${i.message}`) };
  return patchMap(map, raw.data);
}

/**
 * A map of a change names what it is compared with (`since`: "HEAD", a branch). That is pinned to the commit it means
 * right now, so the map shows the same change after the work is committed. A name that is no commit is sent back.
 */
function pinned(parsed: ParseResult, root: string): ParseResult {
  if (!parsed.ok || !parsed.map.since) return parsed;
  const commit = resolveCommit(root, parsed.map.since);
  if (!commit) return { ok: false, problems: [`since: "${parsed.map.since}" isn't a commit in this repo. Use "HEAD" for work that isn't committed yet, "HEAD~1" for the last commit, or leave \`since\` out if the map isn't about a change.`] };
  return { ok: true, map: { ...parsed.map, since: commit } };
}

export async function makeMap(o: MakeOptions): Promise<MakeResult> {
  const status = (text: string) => o.onProgress?.({ kind: 'status', text });
  const who = o.agentName ?? 'Claude';
  status('Scanning the code for ways in, routes and tables');
  const hints = await headStart(o.root);
  const symbolsIn = symbolIndexOf(hints.scan);
  status(`${who} is exploring the code`);
  const run = (prompt: string, resume: string | null, schema: Record<string, unknown>) =>
    o.agent({ prompt, label: `Making the map for "${o.question}"`, schema, cwd: o.root, resume, model: o.model, onProgress: o.onProgress, signal: o.signal });

  let res = await run(makerPrompt(o.question, hints.text), null, MAP_SCHEMA);
  let cost = res.cost ?? 0;
  let rounds = 1;
  /** What the check sends back: claims it couldn't confirm, and proposals the code shows were misread. */
  const off = (r: CheckReport) => r.summary.unconfirmed + settledProposals(r).length;
  let best: { map: CodeMap; report: CheckReport } | null = null;
  let lastProblems: string[] = [];
  /** What the last reply is: a whole map, or changes to `current`, the last map that could be read. */
  let reply: 'map' | 'patch' = 'map';
  let current: CodeMap | null = null;

  for (let attempt = 0; ; attempt++) {
    const parsed: ParseResult = pinned(reply === 'map' || !current ? parseMap(withQuestion(res.output, o.question)) : applyPatch(current, res.output), o.root);
    let repair: { prompt: string; reply: 'map' | 'patch' } | null = null;
    if (!parsed.ok) {
      lastProblems = parsed.problems;
      repair = current ? { prompt: patchRepairPrompt(parsed.problems), reply: 'patch' } : { prompt: shapeRepairPrompt(parsed.problems), reply: 'map' };
    } else {
      current = parsed.map;
      status('Checking every claim against the code');
      const report = check(parsed.map, o.root);
      if (!best || off(report) < off(best.report)) best = { map: parsed.map, report };
      status(`${report.summary.confirmed} of ${report.summary.claims} claims confirmed`);
      if (off(report) > 0) repair = { prompt: evidenceRepairPrompt(report, symbolsIn), reply: 'patch' };
    }
    if (!repair || attempt >= (o.repairs ?? 2)) break;
    status(parsed.ok ? `Asking ${who} to fix the claims that didn't check out` : current ? `Asking ${who} to fix its changes` : `Asking ${who} to fix the map's structure`);
    res = await run(repair.prompt, res.sessionId, repair.reply === 'map' ? MAP_SCHEMA : MAP_PATCH_SCHEMA);
    reply = repair.reply;
    cost += res.cost ?? 0;
    rounds++;
  }
  if (!best) throw new Error(`${who}'s map couldn't be read: ${lastProblems.slice(0, 5).join('; ')}`);
  return { ...best, sessionId: res.sessionId, cost, rounds };
}
