// Changing a map after it's made: additions are validated like a new map; closed gaps drop out of the tour too.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { addToMap, freshId, patchMap, removeAbsences, removeFromMap, slugify } from '../src/edit';
import { parseMap, type CodeMap } from '../src/format';

const MAP = (() => {
  const r = parseMap(JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/care-app.map.json', import.meta.url)), 'utf8')));
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.map;
})();

describe('addToMap', () => {
  it('adds an area, a box and an arrow found while answering', () => {
    const r = addToMap(MAP, {
      nodes: [{ id: 'n9', area: 'jobs', name: 'Filter to yesterday', evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: 'createdAfter' }] }],
      edges: [{ id: 'e9', from: 'j1', to: 'n9', label: 'then', evidence: [{ file: 'src/jobs/nightly.ts', line: 9, text: 'db.where' }] }],
    });
    expect(r.ok).toBe(true);
    if (r.ok) expect(r.map.nodes.map((n) => n.id)).toContain('n9');
  });

  it('rejects additions that clash with existing ids or point at nothing', () => {
    const r = addToMap(MAP, {
      nodes: [{ id: 's1', area: 'patients', name: 'Again', evidence: [{ file: 'a.ts', line: 1, text: 'x' }] }],
      edges: [{ id: 'e10', from: 'u1', to: 'ghost', label: 'calls', evidence: [{ file: 'a.ts', line: 1, text: 'x' }] }],
    });
    expect(r).toEqual({ ok: false, problems: ['node id "s1" is used twice', 'edge "e10": unknown node "ghost"'] });
  });
});

describe('removeAbsences', () => {
  it('drops a closed gap from the map and from tour stops that pointed at it', () => {
    const m: CodeMap = removeAbsences(MAP, ['miss']);
    expect(m.absences).toEqual([]);
    expect(m.tour.find((t) => t.id === 't5')!.focus.absences).toEqual([]);
    expect(parseMap(m).ok).toBe(true);
  });
});

describe('ids', () => {
  it('picks the next free id and slugs questions', () => {
    expect(freshId(MAP, 'e')).toBe('e1');
    expect(freshId(MAP, 's')).toBe('s5');
    expect(slugify('What happens when a patient converts? Does the welcome email go out?')).toBe('patient-converts-welcome-email');
    expect(slugify('???')).toBe('map');
  });
});

describe('patchMap', () => {
  const u2 = () => structuredClone(MAP.nodes.find((n) => n.id === 'u2')!);

  it('replaces items by id in place, adds new ones, and leaves the rest alone', () => {
    const r = patchMap(MAP, {
      nodes: [{ ...u2(), name: 'Email waits in a queue' }, { id: 'n9', area: 'jobs', name: 'New step', evidence: [{ file: 'a.ts', line: 1, text: 'x' }] }],
    });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.map.nodes.map((n) => n.id)).toEqual([...MAP.nodes.map((n) => n.id), 'n9']);
    expect(r.map.nodes.find((n) => n.id === 'u2')!.name).toBe('Email waits in a queue');
    expect({ ...r.map, nodes: [] }).toEqual({ ...MAP, nodes: [] });
  });

  it('drops removed ids with the arrows and tour mentions that point at them', () => {
    const r = patchMap(MAP, { remove: ['u3'] });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.map.nodes.some((n) => n.id === 'u3')).toBe(false);
    expect(r.map.edges.some((e) => e.from === 'u3' || e.to === 'u3')).toBe(false);
    expect(r.map.tour.every((t) => !(t.focus.nodes ?? []).includes('u3'))).toBe(true);
  });

  it('refuses changes that leave the map broken', () => {
    const r = patchMap(MAP, { edges: [{ ...MAP.edges[0]!, to: 'nowhere' }] });
    expect(r).toEqual({ ok: false, problems: [`edge "${MAP.edges[0]!.id}": unknown node "nowhere"`] });
  });

  it('keeps the branches of a journey through additions, patches and removals', () => {
    const r = parseMap(JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/care-app.journey.json', import.meta.url)), 'utf8')));
    if (!r.ok) throw new Error(r.problems.join('\n'));
    const journey = r.map;
    const branches = (m: CodeMap) => Object.fromEntries([...m.nodes, ...m.edges].flatMap((x) => (x.branch ? [[x.id, x.branch]] : [])));
    const added = addToMap(journey, {
      nodes: [{ id: 'j7', area: 'page', kind: 'action', name: 'Opens settings', branch: 'Goes back to the lists', evidence: [{ file: 'src/ui/PatientSidebar.tsx', line: 7, text: 'Settings' }] }],
      edges: [{ id: 'jg', from: 'j1', to: 'j7', label: 'clicks Settings', branch: 'Goes back to the lists', evidence: [{ file: 'src/ui/PatientSidebar.tsx', line: 7, text: 'href="/settings"' }] }],
    });
    if (!added.ok) throw new Error(added.problems.join('\n'));
    expect(branches(added.map)).toEqual({ ...branches(journey), j7: 'Goes back to the lists', jg: 'Goes back to the lists' });
    const patched = patchMap(added.map, { nodes: [{ ...structuredClone(journey.nodes.find((n) => n.id === 'j4')!), name: 'Saves the note' }], remove: ['j5'] });
    if (!patched.ok) throw new Error(patched.problems.join('\n'));
    const { j5: _n, je: _e, ...rest } = branches(added.map);
    expect(branches(patched.map)).toEqual(rest);
  });

  it('changes nothing when there is nothing to change', () => {
    expect(patchMap(MAP, {})).toEqual({ ok: true, map: MAP });
    expect(removeFromMap(MAP, new Set())).toBe(MAP);
  });
});

