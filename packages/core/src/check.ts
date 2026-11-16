// The checker: decides which claims in a map the code actually backs. It reads the repo and never writes. One function,
// used everywhere a map reaches a person: when it's published, on every answer, when a saved map is reopened, after a fix.
// No model calls. Python and Go facts need `initTreeSitter()` to have been awaited once; TS/JS needs nothing.
import {
  DEFAULT_IGNORE,
  carryResolver,
  createFactsIndex,
  fileExistsIn,
  findFetchSites,
  listRepoFiles,
  matchRoute,
  matchesAny,
  settleCalls,
  squash,
  symbolNames,
  type CallFact,
  type Exists,
  type FileFacts,
} from '@illuminate/facts';
import { commitInfo, createBaseReader, lineDiff, type BaseReader } from './base';
import { isAddition, type CodeMap, type Evidence, type MapAbsence, type MapEdge, type MapNode, type Proposal } from './format';
import { createRepoReader, isSecretPath, type RepoReader } from './repo';
import { checkScreen, type ScreenCheck } from './screens';

/**
 * Whether the code backs a claim. `proposed` is only for a box or arrow that carries a proposal: it isn't in the code,
 * and the proposal says it shouldn't be (an addition not built yet, or a change or removal already made).
 */
export type Status = 'confirmed' | 'unconfirmed' | 'proposed';
/**
 * Where a proposal stands, computed from the repo like everything else. `pending`: still to do (an addition the code
 * doesn't have, a change or removal whose cited code is still there). `done`: the code now has the addition, or no
 * longer has what was to change or go.
 */
export type ProposalCheck = { kind: Proposal['kind']; state: 'pending' | 'done' };
/** `fact`: the extracted code facts back the claim. `text`: the cited lines say what the claim says. */
export type Proof = 'fact' | 'text';
export type EvidenceCheck = { file: string; line: number; ok: boolean; foundAt: number | null; reason: string | null };
/**
 * On a map of a change (`since`): how this box or arrow differs from that commit, worked out from the two versions of
 * the code. `added`: it wasn't there. `changed`: the function is there in both and its code differs (`diff` holds the
 * lines, see `lineDiff`). `removed`: the map says it has gone, and it was there then and isn't now.
 */
export type ChangeCheck = { kind: 'added' | 'changed' | 'removed'; diff?: string[] };
export type ClaimCheck = { status: Status; proof: Proof | null; evidence: EvidenceCheck[]; reasons: string[]; proposal?: ProposalCheck; change?: ChangeCheck };
/** What a map of a change is compared with. `commit` is null when `ref` names no commit in this repo. */
export type SinceCheck = { ref: string; commit: string | null; date: string | null; subject: string | null };
/** `searched` is how many files the search covered, so a person can judge whether it looked widely enough. */
export type AbsenceCheck = { status: Exclude<Status, 'proposed'>; found: number; searched: number; locations: { file: string; line: number }[]; reasons: string[] };
export type TourCheck = { status: 'ok' | 'mentions-unconfirmed'; unconfirmed: string[] };
export type CheckReport = {
  nodes: Record<string, ClaimCheck>;
  edges: Record<string, ClaimCheck>;
  absences: Record<string, AbsenceCheck>;
  tour: Record<string, TourCheck>;
  /** By box id, for boxes that carry a screen. Not counted as claims: a screen that fails is simply not shown. */
  screens: Record<string, ScreenCheck>;
  /** `claims` counts what the map says about the code as it is; what is only proposed is counted under `proposals`. */
  summary: { claims: number; confirmed: number; unconfirmed: number; proposals: { pending: number; done: number }; changes?: { added: number; changed: number; removed: number } };
  /** Only on a map of a change. */
  since?: SinceCheck;
};
export type CheckOptions = {
  /** Extra globs to leave out of searches (build output and `.illuminate/` are always left out). */
  ignore?: readonly string[];
  /** How far a cited line may have moved and still count (default 3). */
  lineWindow?: number;
};

const MAX_LOCATIONS = 20;
const fileOf = (symbol: string) => symbol.slice(0, symbol.indexOf('#'));
const within = (from: string, symbol: string) => from === symbol || from.startsWith(`${symbol}.`);
const short = (text: string) => (text.length > 60 ? `${text.slice(0, 57)}…` : text);

export function check(map: CodeMap, root: string, options: CheckOptions = {}): CheckReport {
  const repo = createRepoReader(root);
  const window = options.lineWindow ?? 3;
  const now: Side = { repo, facts: factsFor(repo, fileExistsIn(repo.root)) };
  // A map of a change: the same facts, read from the commit it is compared with.
  const baseRepo = map.since ? createBaseReader(repo.root, map.since) : null;
  const base: BaseSide | null = baseRepo && { repo: baseRepo, facts: factsFor(baseRepo, carryResolver((p: string) => baseRepo.has(p), fileExistsIn(repo.root))) };
  const cmp: Compare | null = map.since ? { ref: map.since, base } : null;
  const byId = new Map(map.nodes.map((n) => [n.id, n]));
  let repoFiles: string[] | null = null;
  const files = () => (repoFiles ??= listRepoFiles(repo.root, [...DEFAULT_IGNORE, ...(options.ignore ?? [])]).filter((f) => !isSecretPath(f)));

  const nodes: Record<string, ClaimCheck> = {};
  for (const n of map.nodes) nodes[n.id] = checkNode(n, now, cmp, window);
  const edges: Record<string, ClaimCheck> = {};
  for (const e of map.edges) edges[e.id] = checkEdge(e, byId, now, cmp, window);
  const absences: Record<string, AbsenceCheck> = {};
  for (const a of map.absences) absences[a.id] = checkAbsence(a, repo, files());

  const screens: Record<string, ScreenCheck> = {};
  for (const n of map.nodes) {
    const sc = checkScreen(n, repo);
    if (sc) screens[n.id] = sc;
  }

  const tour: Record<string, TourCheck> = {};
  for (const t of map.tour) {
    const unconfirmed = [
      ...(t.focus.nodes ?? []).filter((id) => nodes[id]?.status === 'unconfirmed'),
      ...(t.focus.edges ?? []).filter((id) => edges[id]?.status === 'unconfirmed'),
      ...(t.focus.absences ?? []).filter((id) => absences[id]?.status !== 'confirmed'),
    ];
    tour[t.id] = { status: unconfirmed.length ? 'mentions-unconfirmed' : 'ok', unconfirmed };
  }

  const all = [...Object.values(nodes), ...Object.values(edges), ...Object.values(absences)];
  const count = (status: Status) => all.filter((c) => c.status === status).length;
  const proposals = [...Object.values(nodes), ...Object.values(edges)].flatMap((c) => (c.proposal ? [c.proposal] : []));
  const confirmed = count('confirmed');
  const unconfirmed = count('unconfirmed');
  const changes = [...Object.values(nodes), ...Object.values(edges)].flatMap((c) => (c.change ? [c.change.kind] : []));
  return {
    nodes, edges, absences, tour, screens,
    summary: {
      claims: confirmed + unconfirmed,
      confirmed,
      unconfirmed,
      proposals: { pending: proposals.filter((p) => p.state === 'pending').length, done: proposals.filter((p) => p.state === 'done').length },
      ...(cmp && { changes: { added: changes.filter((k) => k === 'added').length, changed: changes.filter((k) => k === 'changed').length, removed: changes.filter((k) => k === 'removed').length } }),
    },
    ...(cmp && { since: { ref: cmp.ref, commit: baseRepo?.commit ?? null, ...(baseRepo ? commitInfo(repo.root, baseRepo.commit) : { date: null, subject: null }) } }),
  };
}

/**
 * Proposals the code has already settled: an addition it has, or a change or removal whose cited code isn't there.
 * On a map made earlier that is the proposal carried out. In a map being written it is a mistake (the code was misread),
 * so the maker and the explainer send these back instead of drawing them.
 */
export function settledProposals(report: CheckReport): { id: string; what: 'box' | 'arrow'; kind: Proposal['kind']; reasons: string[] }[] {
  const of = (what: 'box' | 'arrow', group: Record<string, ClaimCheck>) =>
    Object.entries(group).flatMap(([id, c]) => (c.proposal?.state === 'done' ? [{ id, what, kind: c.proposal.kind, reasons: c.reasons }] : []));
  return [...of('box', report.nodes), ...of('arrow', report.edges)];
}

/** Facts per file, extracted on demand and cached for one check. */
function factsFor(repo: RepoReader, exists: Exists) {
  const index = createFactsIndex(repo.root, exists, repo.text);
  const cache = new Map<string, FileFacts | null>();
  const get = (file: string): FileFacts | null => {
    if (!cache.has(file)) {
      const text = repo.text(file);
      cache.set(file, text === null ? null : index.extract(file, text).facts);
    }
    return cache.get(file) ?? null;
  };
  return {
    get,
    /** Calls made in `file`, settled against the symbols of `file` and `others`. */
    calls(file: string, others: readonly string[]): CallFact[] {
      const own = get(file);
      if (!own) return [];
      const known: Record<string, FileFacts> = {};
      for (const p of [file, ...others]) {
        const f = get(p);
        if (f) known[p] = f;
      }
      return settleCalls(own.calls, symbolNames(known));
    },
  };
}
type Facts = ReturnType<typeof factsFor>;
/** One version of the code: the working tree, or the commit a map of a change is compared with. */
type Side = { repo: RepoReader; facts: Facts };
/** Set for a map of a change. `base` is null when its `since` names no commit here, so nothing can be compared. */
type BaseSide = { repo: BaseReader; facts: Facts };
type Compare = { ref: string; base: BaseSide | null };

function checkEvidence(repo: RepoReader, e: Evidence, window: number): EvidenceCheck {
  const base = { file: e.file, line: e.line };
  const read = repo.read(e.file);
  if (!read.ok) return { ...base, ok: false, foundAt: null, reason: read.reason };
  const lines = read.text.split('\n');
  const want = squash(e.text);
  for (let d = 0; d <= window; d++) {
    for (const at of d === 0 ? [e.line] : [e.line - d, e.line + d]) {
      const line = lines[at - 1];
      if (line !== undefined && squash(line).includes(want)) return { ...base, ok: true, foundAt: at, reason: null };
    }
  }
  // Code moves (a fix above it, a new import). Text that appears on exactly one line of the file is still that line.
  const hits = lines.flatMap((line, i) => (squash(line).includes(want) ? [i + 1] : []));
  if (hits.length === 1) return { ...base, ok: true, foundAt: hits[0]!, reason: null };
  const reason =
    hits.length > 1
      ? `"${short(e.text)}" isn't on line ${e.line} or near it, and appears ${hits.length} times elsewhere in the file`
      : e.line > lines.length
        ? `the file has only ${lines.length} lines`
        : `"${short(e.text)}" isn't on line ${e.line} or near it`;
  return { ...base, ok: false, foundAt: null, reason };
}

function evidenceReasons(evidence: readonly EvidenceCheck[]): string[] {
  return evidence.filter((x) => !x.ok).map((x) => `${x.file}:${x.line}: ${x.reason}`);
}

function result(evidence: EvidenceCheck[], reasons: string[], proof: Proof): ClaimCheck {
  return reasons.length ? { status: 'unconfirmed', proof: null, evidence, reasons } : { status: 'confirmed', proof, evidence, reasons };
}

/**
 * A box or arrow that carries a proposal, read from what the ordinary check found. An addition is checked without its
 * evidence (it has none): once the code has it, it is simply confirmed, and until then it is `proposed`, not a failed
 * claim. A change or removal is the other way round: its cited code must be there while it is pending, and once it
 * isn't, the proposal is done.
 */
function asProposal(kind: Proposal['kind'], c: ClaimCheck): ClaimCheck {
  const inCode = c.status === 'confirmed';
  if (kind === 'add') return inCode ? { ...c, proposal: { kind, state: 'done' } } : { ...c, status: 'proposed', proposal: { kind, state: 'pending' } };
  return inCode ? { ...c, proposal: { kind, state: 'pending' } } : { ...c, status: 'proposed', proposal: { kind, state: 'done' } };
}

function checkNode(n: MapNode, now: Side, cmp: Compare | null, window: number): ClaimCheck {
  if (n.removed) return checkGone(cmp, (side) => checkNodeNow(n, side.repo, side.facts, window), (base) => nodeStillThere(n, now, base));
  const c = checkNodeAsIs(n, now.repo, now.facts, window);
  // Only what is in the code and isn't a proposal can have changed since.
  if (!cmp?.base || n.proposed || c.status !== 'confirmed') return c;
  const change = nodeChange(n, now, cmp.base);
  return change ? { ...c, change } : c;
}

function checkNodeAsIs(n: MapNode, repo: RepoReader, facts: Facts, window: number): ClaimCheck {
  if (!n.proposed) return checkNodeNow(n, repo, facts, window);
  if (!isAddition(n)) return asProposal(n.proposed.kind, checkNodeNow(n, repo, facts, window));
  // An addition is in the code once the function it names exists. Without a name there is nothing to look for.
  if (!n.symbol) return asProposal('add', { status: 'unconfirmed', proof: null, evidence: [], reasons: ['it names no `symbol`, so the code can\'t show whether it has been built'] });
  return asProposal('add', checkNodeNow({ ...n, evidence: [] }, repo, facts, window));
}

/**
 * Code the map says was removed: it must check out against the commit the map is compared with (its lines are cited
 * as they were then), and no longer be in the code now. Anything else is a claim that doesn't hold.
 */
function checkGone(cmp: Compare | null, at: (side: Side) => ClaimCheck, stillThere: (base: Side) => boolean): ClaimCheck {
  const fail = (evidence: EvidenceCheck[], reasons: string[]): ClaimCheck => ({ status: 'unconfirmed', proof: null, evidence, reasons });
  if (!cmp) return fail([], ['the map names no commit (`since`) for this to have been removed after']);
  if (!cmp.base) return fail([], [`"${cmp.ref}" isn't a commit in this repo, so there is nothing to compare with`]);
  const was = at(cmp.base);
  if (was.status !== 'confirmed') return fail(was.evidence, was.reasons.map((r) => `in the code as it was: ${r}`));
  if (stillThere(cmp.base)) return fail(was.evidence, ['it is still in the code, so it wasn\'t removed (drop `removed`)']);
  return { ...was, change: { kind: 'removed' } };
}

/** Whether `text` is on some line of `file` in that version of the code. */
function hasLine(side: Side, file: string, text: string): boolean {
  const source = side.repo.text(file);
  if (source === null) return false;
  const want = squash(text);
  return source.split('\n').some((line) => squash(line).includes(want));
}

const symbolIn = (side: Side, symbol: string) => side.facts.get(fileOf(symbol))?.symbols.find((s) => s.id === symbol) ?? null;

/** A removed box is still there while its function exists, or (when it names none) while any line it cites does. */
function nodeStillThere(n: MapNode, now: Side, _base: Side): boolean {
  if (n.symbol && now.facts.get(fileOf(n.symbol))) return !!symbolIn(now, n.symbol);
  return n.evidence.some((e) => hasLine(now, e.file, e.text));
}

/**
 * How a box that is in the code differs from the commit the map is compared with. A box that names a function is
 * compared as that function: new if it wasn't there, changed if its signature or body differs. A box that names none
 * goes by its cited lines: new if none of their files existed, changed if a cited line wasn't there.
 */
function nodeChange(n: MapNode, now: Side, base: BaseSide): ChangeCheck | null {
  if (n.symbol) {
    const file = fileOf(n.symbol);
    const cur = symbolIn(now, n.symbol);
    if (cur && !base.repo.has(file)) return { kind: 'added' };
    if (cur && base.facts.get(file)) {
      const old = symbolIn(base, n.symbol);
      if (!old) return { kind: 'added' };
      if (old.sigHash === cur.sigHash && old.bodyHash === cur.bodyHash) return null;
      const diff = lineDiff(base.repo.text(file)!.slice(old.span.start, old.span.end), now.repo.text(file)!.slice(cur.span.start, cur.span.end));
      return { kind: 'changed', ...(diff?.length && { diff }) };
    }
  }
  if (!n.evidence.length) return null;
  if (n.evidence.every((e) => !base.repo.has(e.file))) return { kind: 'added' };
  return n.evidence.some((e) => !hasLine(base, e.file, e.text)) ? { kind: 'changed' } : null;
}

function checkNodeNow(n: MapNode, repo: RepoReader, facts: Facts, window: number): ClaimCheck {
  const evidence = n.evidence.map((e) => checkEvidence(repo, e, window));
  const reasons = evidenceReasons(evidence);
  if (reasons.length || !n.symbol) return result(evidence, reasons, 'text');
  const found = facts.get(fileOf(n.symbol))?.symbols.some((s) => s.id === n.symbol);
  if (!found) reasons.push(`the code has no symbol ${n.symbol}`);
  return result(evidence, reasons, 'fact');
}

/**
 * Whether the code facts alone can show an arrow: a call, request or import between boxes that name their code. A
 * `then` arrow, or one between boxes that name no function, is proven only by the lines it cites.
 */
function factBacked(e: MapEdge, byId: ReadonlyMap<string, MapNode>): boolean {
  const from = byId.get(e.from);
  const to = byId.get(e.to);
  return e.kind !== 'then' && !!from && !!to && (e.kind !== 'calls' || (!!from.symbol && !!to.symbol)) && [from, to].every((n) => n.symbol || n.evidence.length);
}

function checkEdge(e: MapEdge, byId: ReadonlyMap<string, MapNode>, now: Side, cmp: Compare | null, window: number): ClaimCheck {
  const inFacts = (side: Side) => factBacked(e, byId) && checkEdgeNow({ ...e, evidence: [] }, byId, side.repo, side.facts, window).status === 'confirmed';
  if (e.removed) {
    // Gone when the facts no longer show it, or (for an arrow only its lines prove) when a line it cites has gone.
    const stillThere = () => (factBacked(e, byId) ? inFacts(now) : e.evidence.every((x) => hasLine(now, x.file, x.text)));
    return checkGone(cmp, (side) => checkEdgeNow(e, byId, side.repo, side.facts, window), stillThere);
  }
  const c = checkEdgeAsIs(e, byId, now.repo, now.facts, window);
  if (!cmp?.base || e.proposed || c.status !== 'confirmed') return c;
  // An arrow is new, or it isn't: new when the facts didn't show it then, or when a line that proves it wasn't there.
  const base = cmp.base;
  const added = factBacked(e, byId) ? !inFacts(base) : e.evidence.some((x) => !hasLine(base, x.file, x.text));
  return added ? { ...c, change: { kind: 'added' } } : c;
}

function checkEdgeAsIs(e: MapEdge, byId: ReadonlyMap<string, MapNode>, repo: RepoReader, facts: Facts, window: number): ClaimCheck {
  if (!e.proposed) return checkEdgeNow(e, byId, repo, facts, window);
  if (!isAddition(e)) return asProposal(e.proposed.kind, checkEdgeNow(e, byId, repo, facts, window));
  // An added arrow is in the code once the facts show the call, request or import it stands for.
  if (!factBacked(e, byId)) return asProposal('add', { status: 'unconfirmed', proof: null, evidence: [], reasons: ['the code facts can\'t show whether this arrow has been built (it isn\'t a call, request or import between named functions)'] });
  return asProposal('add', checkEdgeNow({ ...e, evidence: [] }, byId, repo, facts, window));
}

function checkEdgeNow(e: MapEdge, byId: ReadonlyMap<string, MapNode>, repo: RepoReader, facts: Facts, window: number): ClaimCheck {
  const evidence = e.evidence.map((x) => checkEvidence(repo, x, window));
  const reasons = evidenceReasons(evidence);
  const from = byId.get(e.from);
  const to = byId.get(e.to);
  if (reasons.length || !from || !to || e.kind === 'then') return result(evidence, reasons, 'text');

  if (e.kind === 'calls') {
    if (!from.symbol || !to.symbol) return result(evidence, reasons, 'text');
    const calls = facts.calls(fileOf(from.symbol), [fileOf(to.symbol)]);
    if (!calls.some((c) => within(c.from, from.symbol!) && c.to === to.symbol)) reasons.push(`the code has no call from ${from.symbol} to ${to.symbol}`);
    return result(evidence, reasons, 'fact');
  }

  const fromFile = from.symbol ? fileOf(from.symbol) : from.evidence[0]!.file;
  const toFile = to.symbol ? fileOf(to.symbol) : to.evidence[0]!.file;
  const fromFacts = facts.get(fromFile);
  if (!fromFacts) {
    reasons.push(`${fromFile} can't be read`);
    return result(evidence, reasons, 'fact');
  }

  if (e.kind === 'imports') {
    if (!fromFacts.imports.some((i) => i.to === toFile)) reasons.push(`${fromFile} doesn't import ${toFile}`);
    return result(evidence, reasons, 'fact');
  }

  // request: a fetch in the `from` box (direct, or through a wrapper it imports) that matches a route in the `to` box.
  const neighbours = [fromFile, ...fromFacts.imports.filter((i) => !i.to.startsWith('vendor:')).map((i) => i.to)];
  const sources = neighbours.flatMap((path) => {
    const source = repo.text(path);
    const f = facts.get(path);
    return source !== null && f ? [{ path, source, symbols: f.symbols }] : [];
  });
  const routes = facts.get(toFile)?.routes ?? [];
  const matched = findFetchSites(sources).some((site) => {
    if (site.file !== fromFile || (from.symbol && !within(site.from, from.symbol))) return false;
    const m = matchRoute(site, routes);
    return !!m && (to.symbol ? m.route.handler === to.symbol : true);
  });
  if (!matched) reasons.push(`no request from ${from.symbol ?? fromFile} matches a route handled by ${to.symbol ?? toFile}`);
  return result(evidence, reasons, 'fact');
}

function checkAbsence(a: MapAbsence, repo: RepoReader, files: readonly string[]): AbsenceCheck {
  let pattern: RegExp;
  try {
    pattern = new RegExp(a.search.regex ? a.search.pattern : a.search.pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');
  } catch {
    return { status: 'unconfirmed', found: 0, searched: 0, locations: [], reasons: ['the search pattern is not a valid regular expression'] };
  }
  let found = 0;
  let searched = 0;
  const locations: { file: string; line: number }[] = [];
  for (const file of files) {
    if (a.search.paths && !matchesAny(a.search.paths, file)) continue;
    const text = repo.text(file);
    if (text === null) continue;
    searched++;
    text.split('\n').forEach((line, i) => {
      const n = line.match(pattern)?.length ?? 0;
      if (!n) return;
      found += n;
      if (locations.length < MAX_LOCATIONS) locations.push({ file, line: i + 1 });
    });
  }
  const reasons = found === a.matches ? [] : [`the search finds ${found} ${found === 1 ? 'match' : 'matches'}; the map says ${a.matches}`];
  // A search that read no files proves nothing, whatever it claims to have found.
  if (!searched) reasons.push(a.search.paths ? `no files match ${a.search.paths.join(', ')}, so nothing was searched` : 'there were no files to search');
  return { status: reasons.length ? 'unconfirmed' : 'confirmed', found, searched, locations, reasons };
}
