// A map of a change (`since`): the checker compares the code with a commit and says what is new, different or gone.
// The care app is committed, then changed the way a fix would change it: a listener is added, the service is edited,
// and the nightly job is deleted.
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { createBaseReader, lineDiff, resolveCommit } from '../src/base';
import { check } from '../src/check';
import { parseMap, type CodeMap } from '../src/format';

const APP = fileURLToPath(new URL('./fixtures/care-app', import.meta.url));
const MAP_JSON = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/care-app.map.json', import.meta.url)), 'utf8'));

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const git = (dir: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

/** The care app in a new git repo, committed as it is. */
function committedApp(): { dir: string; first: string } {
  const dir = mkdtempSync(join(tmpdir(), 'illuminate-change-'));
  tmp.push(dir);
  cpSync(APP, dir, { recursive: true });
  git(dir, 'init', '-q');
  git(dir, 'add', '-A');
  git(dir, 'commit', '-q', '-m', 'the care app');
  return { dir, first: git(dir, 'rev-parse', 'HEAD') };
}

/** The change: something now listens for the announcement, the service says so, and the nightly job is gone. */
function change(dir: string) {
  writeFileSync(
    join(dir, 'src/automations/listeners.ts'),
    "import { bus } from '../events/bus';\nimport { evaluateRules } from './evaluate';\n\nexport function listenForConversions() {\n  bus.on('patient.converted', ({ patientId }) => evaluateRules({ patientId }));\n}\n",
  );
  const service = join(dir, 'src/patients/service.ts');
  writeFileSync(service, readFileSync(service, 'utf8').replace("  bus.emit('patient.converted', { patientId });", "  console.log('converted', patientId);\n  bus.emit('patient.converted', { patientId });"));
  rmSync(join(dir, 'src/jobs/nightly.ts'));
}

/** The care-app map as a map of that change. */
const changeMap = (since: string | undefined, edit: (m: any) => void = () => {}): CodeMap => {
  const m = structuredClone(MAP_JSON);
  if (since) m.since = since;
  m.absences = [];
  m.tour = [];
  m.nodes.push({ id: 'l1', area: 'automations', name: 'Hears the announcement', symbol: 'src/automations/listeners.ts#listenForConversions', evidence: [{ file: 'src/automations/listeners.ts', line: 5, text: "bus.on('patient.converted'" }] });
  m.edges.push({ id: 'el', from: 'l1', to: 'u1', kind: 'calls', label: 'runs the rules', evidence: [{ file: 'src/automations/listeners.ts', line: 5, text: 'evaluateRules({ patientId })' }] });
  m.edges.find((e: any) => e.id === 'e34').evidence[0].line = 7;
  for (const x of [m.nodes.find((n: any) => n.id === 'j1'), m.edges.find((e: any) => e.id === 'ej')]) x.removed = true;
  edit(m);
  const parsed = parseMap(m);
  if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
  return parsed.map;
};

describe('a map of a change', () => {
  const { dir, first } = committedApp();
  change(dir);
  const report = check(changeMap('HEAD'), dir);
  const kinds = (group: Record<string, { change?: { kind: string } }>) => Object.fromEntries(Object.entries(group).flatMap(([id, c]) => (c.change ? [[id, c.change.kind]] : [])));

  it('says what it is compared with', () => {
    expect(report.since).toMatchObject({ ref: 'HEAD', commit: first, subject: 'the care app' });
    expect(report.since!.date).toMatch(/^\d{4}-\d\d-\d\d/);
  });

  it('marks what is new, what is different and what has gone, and leaves the rest alone', () => {
    expect(kinds(report.nodes)).toEqual({ l1: 'added', s3: 'changed', s4: 'changed', j1: 'removed' });
    expect(kinds(report.edges)).toEqual({ el: 'added', ej: 'removed' });
    expect(report.summary).toEqual({ claims: 16, confirmed: 16, unconfirmed: 0, proposals: { pending: 0, done: 0 }, changes: { added: 2, changed: 2, removed: 2 } });
  });

  it('shows the lines of a changed function', () => {
    expect(report.nodes.s3!.change!.diff).toContain("+   console.log('converted', patientId);");
    expect(report.nodes.s3!.change!.diff!.some((l) => l.startsWith('- '))).toBe(false);
  });

  it('confirms removed code against the code as it was', () => {
    expect(report.nodes.j1).toMatchObject({ status: 'confirmed', proof: 'fact', evidence: [{ ok: true, foundAt: 5 }] });
    expect(report.edges.ej).toMatchObject({ status: 'confirmed', proof: 'fact' });
  });

  it('does not take the map\'s word that something was removed', () => {
    const r = check(changeMap('HEAD', (m) => { m.nodes.find((n: any) => n.id === 'u3').removed = true; m.edges.find((e: any) => e.id === 'eu23').removed = true; }), dir);
    expect(r.nodes.u3).toMatchObject({ status: 'unconfirmed', reasons: [expect.stringContaining('still in the code')] });
    expect(r.edges.eu23).toMatchObject({ status: 'unconfirmed', reasons: [expect.stringContaining('still in the code')] });
    expect(r.nodes.u3!.change).toBeUndefined();
  });

  it('does not confirm removed code that was never there', () => {
    const r = check(changeMap('HEAD', (m) => { m.nodes.find((n: any) => n.id === 'j1').symbol = 'src/jobs/nightly.ts#runHourly'; }), dir);
    expect(r.nodes.j1).toMatchObject({ status: 'unconfirmed', reasons: [expect.stringContaining('in the code as it was: the code has no symbol')] });
  });

  it('goes by cited lines for a box that names no function', () => {
    const r = check(
      changeMap('HEAD', (m) => {
        delete m.nodes.find((n: any) => n.id === 'l1').symbol; // every cited file is new
        const s4 = m.nodes.find((n: any) => n.id === 's4');
        delete s4.symbol;
        s4.evidence = [{ file: 'src/patients/service.ts', line: 6, text: "console.log('converted'" }]; // a new line in an old file
        delete m.nodes.find((n: any) => n.id === 'u3').symbol; // untouched
        m.edges.find((e: any) => e.id === 'el').kind = 'then';
      }),
      dir,
    );
    expect(kinds(r.nodes)).toMatchObject({ l1: 'added', s4: 'changed' });
    expect(r.nodes.u3!.change).toBeUndefined();
    expect(r.edges.el!.change).toEqual({ kind: 'added' });
    expect(r.edges.e34!.change).toBeUndefined(); // its line was there before
  });

  it('keeps comparing with the same commit after the change is committed', () => {
    const later = committedApp();
    change(later.dir);
    git(later.dir, 'add', '-A');
    git(later.dir, 'commit', '-q', '-m', 'listen for conversions');
    expect(kinds(check(changeMap('HEAD'), later.dir).nodes)).toEqual({}); // nothing has changed since the new commit
    const r = check(changeMap(later.first), later.dir);
    expect(kinds(r.nodes)).toEqual({ l1: 'added', s3: 'changed', s4: 'changed', j1: 'removed' });
    expect(check(changeMap('HEAD~1'), later.dir).since!.commit).toBe(later.first);
  });

  it('says so when the commit can\'t be found, and marks nothing', () => {
    const r = check(changeMap('no-such-branch'), dir);
    expect(r.since).toEqual({ ref: 'no-such-branch', commit: null, date: null, subject: null });
    expect(r.nodes.j1).toMatchObject({ status: 'unconfirmed', reasons: [expect.stringContaining("isn't a commit in this repo")] });
    expect(kinds(r.nodes)).toEqual({});
    expect(r.nodes.l1!.status).toBe('confirmed');
  });

  it('marks nothing on a map that isn\'t about a change', () => {
    const r = check(changeMap(undefined, (m) => { for (const x of [...m.nodes, ...m.edges]) delete x.removed; m.nodes = m.nodes.filter((n: any) => n.id !== 'j1'); m.edges = m.edges.filter((e: any) => e.id !== 'ej'); }), dir);
    expect(r.since).toBeUndefined();
    expect(r.summary.changes).toBeUndefined();
    expect(kinds(r.nodes)).toEqual({});
  });
});

describe('the map format for a change', () => {
  const problems = (edit: (m: any) => void) => {
    const m = structuredClone(MAP_JSON);
    edit(m);
    const r = parseMap(m);
    return r.ok ? [] : r.problems;
  };

  it('needs a commit for anything to have been removed after', () => {
    expect(problems((m) => { m.nodes[7].removed = true; m.edges.find((e: any) => e.id === 'ej').removed = true; })).toEqual([expect.stringContaining('needs the map\'s `since`'), expect.stringContaining('needs the map\'s `since`')]);
  });

  it('removes the arrows of a removed box with it, and keeps gaps about the code as it is', () => {
    expect(problems((m) => { m.since = 'HEAD'; m.nodes.find((n: any) => n.id === 'j1').removed = true; })).toEqual([expect.stringContaining('an arrow to or from it was removed too')]);
    expect(problems((m) => { m.since = 'HEAD'; m.nodes.find((n: any) => n.id === 's4').removed = true; m.edges.find((e: any) => e.id === 'e34').removed = true; })).toEqual([expect.stringContaining('an absence is about the code as it is')]);
  });

  it('only takes a name git can read as a revision', () => {
    for (const since of ['HEAD', 'main', 'HEAD~2', 'origin/main', 'v1.2.0', 'a1b2c3d']) expect(problems((m) => { m.since = since; })).toEqual([]);
    for (const since of ['--output=/tmp/x', '-n', 'a b', 'HEAD; rm -rf .', '']) expect(problems((m) => { m.since = since; })).toHaveLength(1);
  });

  it('can\'t be removed and proposed at once', () => {
    expect(problems((m) => { m.since = 'HEAD'; Object.assign(m.nodes.find((n: any) => n.id === 'u3'), { removed: true, proposed: { kind: 'remove' } }); m.edges.find((e: any) => e.id === 'eu23').removed = true; })).toEqual([expect.stringContaining('both `removed`')]);
  });
});

describe('reading the code as it was', () => {
  const { dir, first } = committedApp();
  change(dir);

  it('reads a commit\'s files, including ones deleted since, and not ones added since', () => {
    const base = createBaseReader(dir, 'HEAD')!;
    expect(base.commit).toBe(first);
    expect(base.text('src/jobs/nightly.ts')).toContain('runNightly');
    expect(base.text('src/patients/service.ts')).not.toContain('console.log');
    expect(base.has('src/automations/listeners.ts')).toBe(false);
    expect(base.read('src/automations/listeners.ts')).toEqual({ ok: false, reason: 'file not found' });
  });

  it('never reads secrets or paths outside the repo, even from history', () => {
    const base = createBaseReader(dir, 'HEAD')!;
    expect(base.has('.env')).toBe(true);
    expect(base.read('.env')).toEqual({ ok: false, reason: 'secret files are never read' });
    expect(base.read('../outside.ts').ok).toBe(false);
  });

  it('resolves only real commits, and nothing that looks like an option', () => {
    expect(resolveCommit(dir, 'HEAD')).toBe(first);
    expect(resolveCommit(dir, 'nope')).toBeNull();
    expect(resolveCommit(dir, '--all')).toBeNull();
    expect(createBaseReader(tmpdir(), 'HEAD')).toBeNull(); // not a git repo
  });
});

describe('lineDiff', () => {
  it('lists added and removed lines with a little of what surrounds them', () => {
    const before = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'].join('\n');
    const after = ['a', 'b', 'c', 'D', 'e', 'f', 'g', 'h', 'i'].join('\n');
    expect(lineDiff(before, after, 1)).toEqual(['  c', '- d', '+ D', '  e', '…', '  h', '+ i']);
  });

  it('is empty for the same text, and gives up on texts too long to compare', () => {
    expect(lineDiff('a\nb', 'a\nb')).toEqual([]);
    const long = (seed: string) => Array.from({ length: 1100 }, (_, i) => `${seed}${i}`).join('\n');
    expect(lineDiff(long('x'), long('y'))).toBeNull();
  });
});
