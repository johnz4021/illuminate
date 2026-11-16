// A map of a change, on the server side: Claude is told what differs from the last commit, the commit a map names is
// pinned, and removed code is read as it was.
import { execFileSync } from 'node:child_process';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { changesSince, recentChanges } from '../src/changes';
import { citedExcerpts } from '../src/explainer';
import { headStart } from '../src/hints';
import { makeMap } from '../src/maker';
import { explainerPrompt, makerPrompt } from '../src/prompts';
import { CARE_MAP, cleanup, copyCareApp, scriptedAgent } from './helpers';

afterAll(cleanup);

const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

/** The care app committed, then changed: a listener added, the service edited, the nightly job deleted. */
function changedApp(): { root: string; first: string } {
  const root = copyCareApp();
  git(root, 'init', '-q');
  git(root, 'add', '-A');
  git(root, 'commit', '-q', '-m', 'the care app');
  const first = git(root, 'rev-parse', 'HEAD');
  writeFileSync(join(root, 'src/automations/listeners.ts'), "import { bus } from '../events/bus';\nimport { evaluateRules } from './evaluate';\n\nexport function listenForConversions() {\n  bus.on('patient.converted', ({ patientId }) => evaluateRules({ patientId }));\n}\n");
  const service = join(root, 'src/patients/service.ts');
  writeFileSync(service, readFileSync(service, 'utf8').replace("  bus.emit('patient.converted', { patientId });", "  console.log('converted', patientId);\n  bus.emit('patient.converted', { patientId });"));
  rmSync(join(root, 'src/jobs/nightly.ts'));
  writeFileSync(join(root, 'NOTES.md'), 'a note\n');
  return { root, first };
}

/** The care-app map, drawn as a map of that change. */
const changeMap = (since = 'HEAD') => {
  const m = structuredClone(CARE_MAP);
  m.since = since;
  m.absences = [];
  m.tour = [];
  m.nodes.push({ id: 'l1', area: 'automations', name: 'Hears the announcement', symbol: 'src/automations/listeners.ts#listenForConversions', evidence: [{ file: 'src/automations/listeners.ts', line: 5, text: "bus.on('patient.converted'" }] });
  m.edges.push({ id: 'el', from: 'l1', to: 'u1', kind: 'calls', label: 'runs the rules', evidence: [{ file: 'src/automations/listeners.ts', line: 5, text: 'evaluateRules({ patientId })' }] });
  m.edges.find((e: any) => e.id === 'e34').evidence[0].line = 7;
  for (const x of [m.nodes.find((n: any) => n.id === 'j1'), m.edges.find((e: any) => e.id === 'ej')]) x.removed = true;
  return m;
};

describe('what differs from a commit', () => {
  it('lists the files, code first, with the functions that are new, different or gone', () => {
    const { root, first } = changedApp();
    const c = changesSince(root, 'HEAD')!;
    expect(c).toMatchObject({ commit: first, subject: 'the care app' });
    expect(c.files).toEqual([
      { file: 'src/automations/listeners.ts', what: 'new', detail: 'new: listenForConversions' },
      { file: 'src/jobs/nightly.ts', what: 'deleted', detail: 'removed: schedule, runNightly' },
      { file: 'src/patients/service.ts', what: 'changed', detail: 'changed: markConverted' },
      { file: 'NOTES.md', what: 'new', detail: '' },
    ]);
  });

  it('is null for a name that is no commit, and never lists secrets or illuminate\'s own files', () => {
    const { root } = changedApp();
    expect(changesSince(root, 'nope')).toBeNull();
    writeFileSync(join(root, '.env.local'), 'KEY=1\n');
    expect(changesSince(root, 'HEAD')!.files.map((f) => f.file)).not.toContain('.env.local');
  });

  it('gives Claude the work not committed yet, or else what the last commit did', async () => {
    const { root } = changedApp();
    expect(recentChanges(root)!.title).toContain('a map of these sets `since`: "HEAD"');
    const { text } = await headStart(root);
    expect(text).toContain('  - changed src/patients/service.ts (changed: markConverted)');
    git(root, 'add', '-A');
    git(root, 'commit', '-q', '-m', 'listen');
    const last = recentChanges(root)!;
    expect(last.title).toContain('`since`: "HEAD~1"');
    expect(last.lines).toContain('  - new src/automations/listeners.ts (new: listenForConversions)');
  });

  it('says nothing outside a git repo', async () => {
    const root = copyCareApp();
    expect(recentChanges(root)).toBeNull();
    expect((await headStart(root)).text).not.toContain('Not committed yet');
  });
});

describe('making a map of a change', () => {
  it('pins the commit the map names, so it shows the same change after a commit', async () => {
    const { root, first } = changedApp();
    const r = await makeMap({ root, question: 'What did that change do?', agent: scriptedAgent([() => changeMap('HEAD')]) });
    expect(r.map.since).toBe(first);
    expect(r.report.summary).toMatchObject({ unconfirmed: 0, changes: { added: 2, changed: 2, removed: 2 } });
    expect(r.rounds).toBe(1);
  });

  it('sends back a starting point that is no commit', async () => {
    const { root, first } = changedApp();
    const agent = scriptedAgent([() => changeMap('the-old-branch'), () => changeMap('HEAD')]);
    const r = await makeMap({ root, question: 'What did that change do?', agent });
    expect(agent.calls[1]!.prompt).toContain('"the-old-branch" isn\'t a commit in this repo');
    expect(r.map.since).toBe(first);
  });

  it('sends back code marked removed that is still there', async () => {
    const { root } = changedApp();
    const wrong = changeMap();
    wrong.nodes.find((n: any) => n.id === 'u3').removed = true;
    wrong.edges.find((e: any) => e.id === 'eu23').removed = true;
    const fixed = { nodes: [{ ...wrong.nodes.find((n: any) => n.id === 'u3'), removed: false }], edges: [{ ...wrong.edges.find((e: any) => e.id === 'eu23'), removed: false }] };
    const agent = scriptedAgent([() => wrong, () => fixed]);
    const r = await makeMap({ root, question: 'What did that change do?', agent });
    expect(agent.calls[1]!.prompt).toContain('still in the code');
    expect(r.report.summary.unconfirmed).toBe(0);
  });

  it('tells Claude how to draw a change', () => {
    const p = makerPrompt('What did you just change?', '(head start)');
    expect(p).toContain('## When the question is about a change');
    expect(p).toContain('`"removed": true`');
  });
});

describe('answering on a map of a change', () => {
  it('reads removed code as it was, and tells Claude what the checker found', async () => {
    const { root } = changedApp();
    const r = await makeMap({ root, question: 'What did that change do?', agent: scriptedAgent([() => changeMap()]) });
    const excerpts = citedExcerpts(root, r.map, { nodes: ['j1'] });
    expect(excerpts).toContain('src/jobs/nightly.ts:1-9 (removed since; as it was, cited by j1)');
    expect(excerpts).toContain("export const schedule = '0 2 * * *';");
    const prompt = explainerPrompt(r.map, r.report, [], 'what changed?');
    expect(prompt).toContain('## This map shows a change');
    expect(prompt).toContain('s3 (changed)');
    expect(prompt).toContain("+   console.log('converted', patientId);");
  });
});
