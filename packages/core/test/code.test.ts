// The code behind a box, an arrow or an answer's notes: which lines are shown, which are marked, and that it is read
// by the same rules as the check (the line check, the secret guard, the commit a map of a change is compared with).
import { execFileSync } from 'node:child_process';
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { checkNotes, codeForNotes, codeOf } from '../src/code';
import { parseMap, type CodeMap } from '../src/format';

const APP = fileURLToPath(new URL('./fixtures/care-app', import.meta.url));
const MAP_JSON = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/care-app.map.json', import.meta.url)), 'utf8'));
const parsed = (m: unknown): CodeMap => {
  const r = parseMap(m);
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.map;
};
const map = parsed(MAP_JSON);

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
function copy(): string {
  const dir = mkdtempSync(join(tmpdir(), 'illuminate-code-'));
  tmp.push(dir);
  cpSync(APP, dir, { recursive: true });
  return dir;
}

describe('the code behind a box', () => {
  it('shows the whole function a box names, with its cited line marked', () => {
    const view = codeOf(map, APP, 's3')!;
    expect(view).toMatchObject({ when: 'now', missing: 0 });
    expect(view.blocks).toHaveLength(1);
    const b = view.blocks[0]!;
    expect(b).toMatchObject({ file: 'src/patients/service.ts', name: 'markConverted', whole: true, start: 4, cited: [5] });
    expect(b.lines[0]).toContain('export async function markConverted');
    expect(b.lines[b.lines.length - 1]).toBe('}');
  });

  it('shows the function an arrow\'s line is in, though an arrow names none', () => {
    const b = codeOf(map, APP, 'e23')!.blocks[0]!;
    expect(b.file).toBe('src/server/routes.ts');
    expect(b.cited).toEqual([9]);
    expect(b.name).toBe('convertPatient');
    expect(b.lines[9 - b.start]).toContain('markConverted(req.params.id)');
  });

  it('follows a cited line that moved, the way the check does', () => {
    const dir = copy();
    const file = join(dir, 'src/patients/service.ts');
    writeFileSync(file, `// a comment\n// another\n${readFileSync(file, 'utf8')}`);
    const b = codeOf(map, dir, 's3')!.blocks[0]!;
    expect(b.start).toBe(6);
    expect(b.cited).toEqual([7]);
  });

  it('counts a citation the code no longer has, and still shows the function', () => {
    const dir = copy();
    const file = join(dir, 'src/patients/service.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace("db.update('patients'", "db.save('people'"));
    const view = codeOf(map, dir, 's3')!;
    expect(view.missing).toBe(1);
    expect(view.blocks[0]).toMatchObject({ name: 'markConverted', cited: [] });
  });

  it('shows a long function only around its cited line', () => {
    const dir = copy();
    const filler = Array.from({ length: 200 }, (_, i) => `  const v${i} = ${i};`).join('\n');
    writeFileSync(join(dir, 'src/patients/service.ts'), `export async function markConverted(patientId: string) {\n${filler}\n  await db.update('patients', { id: patientId });\n}\n`);
    const m = parsed({ ...MAP_JSON, nodes: MAP_JSON.nodes.map((n: any) => (n.id === 's3' ? { ...n, evidence: [{ file: 'src/patients/service.ts', line: 202, text: "db.update('patients'" }] } : n)) });
    const b = codeOf(m, dir, 's3')!.blocks[0]!;
    expect(b).toMatchObject({ name: 'markConverted', whole: false, cited: [202] });
    expect(b.lines.length).toBeLessThan(20);
  });

  it('gives the lines around a citation in a file the facts can\'t read as code', () => {
    const dir = copy();
    writeFileSync(join(dir, 'Vault.sol'), Array.from({ length: 30 }, (_, i) => (i === 14 ? '    requests[id].status = Status.Pending;' : `    // line ${i + 1}`)).join('\n'));
    const m = parsed({ ...MAP_JSON, nodes: [...MAP_JSON.nodes, { id: 'sol', area: MAP_JSON.areas[0].id, name: 'Marks it pending', evidence: [{ file: 'Vault.sol', line: 15, text: 'status = Status.Pending' }] }] });
    const b = codeOf(m, dir, 'sol')!.blocks[0]!;
    expect(b).toMatchObject({ file: 'Vault.sol', name: null, whole: false, start: 9, cited: [15] });
    expect(b.lines).toHaveLength(13);
  });

  it('has nothing for an id that isn\'t a box or arrow, and never reads a secret file', () => {
    expect(codeOf(map, APP, 'nope')).toBeNull();
    const m = parsed({ ...MAP_JSON, nodes: [...MAP_JSON.nodes, { id: 'env', area: MAP_JSON.areas[0].id, name: 'The key', evidence: [{ file: '.env', line: 1, text: 'KEY' }] }] });
    expect(codeOf(m, APP, 'env')).toEqual({ when: 'now', blocks: [], missing: 1 });
  });
});

describe('the code as it was', () => {
  const git = (dir: string, ...args: string[]) =>
    execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@example.com', '-c', 'commit.gpgsign=false', ...args], { cwd: dir, stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

  it('reads a changed function from the commit the map is compared with', () => {
    const dir = copy();
    git(dir, 'init', '-q');
    git(dir, 'add', '-A');
    git(dir, 'commit', '-q', '-m', 'the care app');
    const file = join(dir, 'src/patients/service.ts');
    writeFileSync(file, readFileSync(file, 'utf8').replace("  bus.emit('patient.converted', { patientId });", "  console.log('converted', patientId);\n  bus.emit('patient.converted', { patientId });"));
    const m = parsed({ ...MAP_JSON, since: 'HEAD' });
    const now = codeOf(m, dir, 's4')!.blocks[0]!;
    const was = codeOf(m, dir, 's4', 'before')!;
    expect(now.lines.join('\n')).toContain('console.log');
    expect(now.cited).toEqual([7]);
    expect(was.when).toBe('before');
    expect(was.blocks[0]!.lines.join('\n')).not.toContain('console.log');
    expect(was.blocks[0]!.cited).toEqual([6]);
  });

  it('has no earlier version on a map that compares with nothing', () => {
    expect(codeOf(map, APP, 's3', 'before')).toBeNull();
  });
});

describe('notes on an answer', () => {
  const note = (line: number, text: string, file = 'src/patients/service.ts') => ({ file, line, text, note: 'What this line does.' });

  it('keeps the notes whose line is in the code, on the line where it was found', () => {
    const r = checkNotes(APP, [note(5, "db.update('patients'"), note(1, "bus.emit('patient.converted'"), note(3, 'no such text')]);
    expect(r.notes.map((n) => n.line)).toEqual([5, 6]);
    expect(r.dropped).toHaveLength(1);
    expect(r.dropped[0]).toContain('src/patients/service.ts:3');
  });

  it('drops a second note on the same line, and a note on a secret file', () => {
    const r = checkNotes(APP, [note(5, "db.update('patients'"), note(5, 'status:'), note(1, 'KEY', '.env')]);
    expect(r.notes).toHaveLength(1);
    expect(r.dropped).toEqual(['.env:1: secret files are never read']);
  });

  it('shows the code with each note on its line, and counts notes the code no longer has', () => {
    const view = codeForNotes(APP, [note(6, "bus.emit('patient.converted'"), note(2, 'gone')]);
    expect(view.missing).toBe(1);
    expect(view.blocks).toHaveLength(1);
    expect(view.blocks[0]).toMatchObject({ name: 'markConverted', cited: [6], notes: [{ line: 6, note: 'What this line does.' }] });
  });
});

describe('a box whose cited line is outside the function it names', () => {
  it('keeps the function\'s name on the block that holds both', () => {
    // s2 names convertPatient (lines 8-11) and cites the route on line 6: one block, still named.
    const view = codeOf(map, APP, 's2')!;
    expect(view.blocks).toHaveLength(1);
    expect(view.blocks[0]).toMatchObject({ name: 'convertPatient', whole: false, cited: [6] });
  });
});
