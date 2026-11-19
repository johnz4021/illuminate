// The map format: shape validation, defaults, and references between areas, boxes, arrows, absences and tour stops.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { isSafeRelativePath, parseMap } from '../src/format';

const minimal = () => ({
  version: 1,
  question: 'What happens when staff convert a patient?',
  areas: [{ id: 'patients', label: 'Patients' }],
  nodes: [
    { id: 'a', area: 'patients', name: 'Click', evidence: [{ file: 'src/ui.tsx', line: 3, text: 'onClick' }] },
    { id: 'b', area: 'patients', name: 'Save', evidence: [{ file: 'src/save.ts', line: 1, text: 'save(' }] },
  ],
});

describe('parseMap', () => {
  it('accepts a minimal map and fills defaults', () => {
    const r = parseMap(minimal());
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.map.nodes[0]!.kind).toBe('step');
    expect(r.map).toMatchObject({ edges: [], absences: [], tour: [] });
  });

  it('reports shape problems with their paths', () => {
    const m: any = minimal();
    m.version = 2;
    m.nodes[0].evidence = [];
    m.nodes[1].symbol = 'no-hash';
    const r = parseMap(m);
    expect(r.ok).toBe(false);
    if (r.ok) return;
    expect(r.problems).toEqual(expect.arrayContaining([
      expect.stringMatching(/^version: /),
            'nodes.1.symbol: symbol is <file>#<name>',
    ]));
  });

  it('reports broken references and duplicate ids', () => {
    const m: any = minimal();
    m.nodes.push({ id: 'a', area: 'billing', name: 'Dup', evidence: [{ file: 'x.ts', line: 1, text: 'x' }] });
    m.edges = [{ id: 'e1', from: 'a', to: 'zzz', label: 'calls', evidence: [{ file: 'x.ts', line: 1, text: 'x' }] }];
    m.absences = [{ id: 'g', claim: 'none', between: { from: 'b', to: 'nope' }, search: { pattern: 'x' }, matches: 0 }];
    m.tour = [{ id: 't', title: 'Start', text: 'Hi', focus: { edges: ['e9'], areas: ['patients'] } }];
    const r = parseMap(m);
    expect(r).toEqual({
      ok: false,
      problems: [
        'node id "a" is used twice',
        'node "a": unknown area "billing"',
        'edge "e1": unknown node "zzz"',
        'absence "g": unknown node "nope"',
        'tour stop "t": unknown edge "e9"',
      ],
    });
  });
});

describe('isSafeRelativePath', () => {
  it('allows repo-relative paths and rejects anything that could leave the repo', () => {
    expect(['src/a.ts', 'a.ts', '.github/workflows/ci.yml'].every(isSafeRelativePath)).toBe(true);
    expect(['/etc/passwd', '../x.ts', 'src/../../x', 'C:/x', 'src\\x.ts', 'src//x.ts', ''].some(isSafeRelativePath)).toBe(false);
  });
});

describe('a journey map', () => {
  const raw = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/care-app.journey.json', import.meta.url)), 'utf8'));

  it('is the same format with a view and its own box kinds', () => {
    const r = parseMap(raw);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.map.view).toBe('journey');
    expect(r.map.nodes.map((n) => n.kind)).toEqual(['screen', 'action', 'external', 'action', 'action', 'external']);
  });

  it('keeps the branch each box and arrow is on, and leaves the main path without one', () => {
    const r = parseMap(raw);
    if (!r.ok) throw new Error(r.problems.join('\n'));
    expect(r.map.nodes.map((n) => n.branch ?? null)).toEqual([null, null, null, 'Writes a note instead', 'Goes back to the lists', 'No welcome rule']);
    expect(r.map.edges.find((e) => e.id === 'jd')?.branch).toBe('Writes a note instead');
    expect(r.map.edges.find((e) => e.id === 'ja')?.branch).toBeUndefined();
    // Parsing what was parsed gives the same map back.
    expect(parseMap(JSON.parse(JSON.stringify(r.map)))).toEqual({ ok: true, map: r.map });
  });

  it('wants a branch named in a few words', () => {
    const named = (branch: unknown) => parseMap({ ...raw, nodes: raw.nodes.map((n: any) => (n.id === 'j4' ? { ...n, branch } : n)) });
    expect(named('Saves for later').ok).toBe(true);
    for (const bad of ['', '   ', 'x'.repeat(61), 3]) expect(named(bad).ok).toBe(false);
    const long = parseMap({ ...raw, edges: raw.edges.map((e: any) => (e.id === 'jc' ? { ...e, branch: 'y'.repeat(61) } : e)) });
    expect(long.ok ? [] : long.problems).toEqual([expect.stringMatching(/^edges\.2\.branch: /)]);
  });

  it('still reads a journey written before branches', () => {
    const old = { ...raw, nodes: raw.nodes.slice(0, 3).map(({ branch: _, ...n }: any) => n), edges: raw.edges.slice(0, 2), tour: raw.tour.slice(0, 2) };
    const r = parseMap(old);
    expect(r.ok).toBe(true);
    if (r.ok) expect([...r.map.nodes, ...r.map.edges].every((x) => x.branch === undefined)).toBe(true);
  });

  it('rejects a view it does not know', () => {
    expect(parseMap({ ...raw, view: 'poster' }).ok).toBe(false);
  });
});
