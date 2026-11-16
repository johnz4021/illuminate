// ELK layout of the care-app map: steps stack down inside their area, areas run left to right along the arrows, every
// box stays inside its area, and arrows attach to the sides that face each other.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { describe, expect, it } from 'vitest';
import { parseMap } from '@illuminate/core';
import { layoutKey, layoutMap, rowOf, sides } from '../src/layout';

const map = (() => {
  const r = parseMap(JSON.parse(readFileSync(fileURLToPath(new URL('../../core/test/fixtures/care-app.map.json', import.meta.url)), 'utf8')));
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.map;
})();

describe('layoutMap', () => {
  it('places every box inside its area, and every area', async () => {
    const l = await layoutMap(map);
    expect(Object.keys(l.areas).sort()).toEqual(['automations', 'events', 'jobs', 'patients']);
    for (const n of map.nodes) {
      const box = l.nodes[n.id]!;
      const area = l.areas[n.area]!;
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.x + box.w).toBeLessThanOrEqual(area.w);
      expect(box.y + box.h).toBeLessThanOrEqual(area.h);
    }
  });

  it('stacks steps down inside an area, and runs areas left to right along the path', async () => {
    const l = await layoutMap(map);
    expect(l.nodes.s1!.y).toBeLessThan(l.nodes.s2!.y);
    expect(l.nodes.s2!.y).toBeLessThan(l.nodes.s3!.y);
    expect(l.nodes.u1!.y).toBeLessThan(l.nodes.u3!.y);
    expect(l.areas.patients!.x).toBeLessThan(l.areas.events!.x);
    expect(l.areas.events!.x).toBeLessThan(l.areas.automations!.x); // the missing connection still pulls Automations right
    expect(l.areas.jobs!.x).toBeLessThan(l.areas.automations!.x);
  });

  it('attaches arrows to facing sides: down within an area, across between areas', async () => {
    const l = await layoutMap(map);
    expect(sides(map, l, 's1', 's2')).toEqual(['b', 't']);
    expect(sides(map, l, 's3', 's4')).toEqual(['r', 'l']);
    expect(sides(map, l, 'j1', 'u1')).toEqual(['r', 'l']);
  });

  it('keeps the original boxes in place when answers add to the map', async () => {
    const grown = {
      ...map,
      areas: [...map.areas, { id: 'mail', label: 'Email' }],
      nodes: [...map.nodes, { ...map.nodes.find((n) => n.area === 'jobs')!, id: 'n9' }, { ...map.nodes[0]!, id: 'n10', area: 'mail' }],
      edges: [...map.edges, { ...map.edges[0]!, id: 'e9', from: 'j1', to: 'n9' }, { ...map.edges[0]!, id: 'e10', from: 'n9', to: 'n10' }],
    };
    const before = await layoutMap(map);
    const after = await layoutMap(grown, [], new Set(['mail', 'n9', 'n10', 'e9', 'e10']));
    for (const n of map.nodes) expect(after.nodes[n.id]).toEqual(before.nodes[n.id]); // same place inside its area
    for (const a of map.areas) {
      expect(after.areas[a.id]!.x).toBe(before.areas[a.id]!.x);
      expect(after.areas[a.id]!.y).toBeGreaterThanOrEqual(before.areas[a.id]!.y); // only ever slides down
    }
    const jobs = after.areas.jobs!;
    expect(after.nodes.n9!.y + after.nodes.n9!.h).toBeLessThanOrEqual(jobs.h); // inside the area, which grew
    expect(after.areas.mail!.x).toBeGreaterThan(Math.max(...map.areas.map((a) => before.areas[a.id]!.x + before.areas[a.id]!.w)));
    const boxes = Object.values(after.areas);
    for (const [i, a] of boxes.entries()) {
      for (const b of boxes.slice(i + 1)) expect(a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h).toBe(false);
    }
  });

  it('changes its key only when the structure changes', () => {
    const renamed = { ...map, nodes: map.nodes.map((n) => (n.id === 's1' ? { ...n, name: 'Different words' } : n)) };
    expect(layoutKey(renamed)).toBe(layoutKey(map));
    expect(layoutKey(map, [{ id: 'fix-1', from: 's4', to: 'u1' }])).not.toBe(layoutKey(map));
  });
});

describe('layoutMap on a journey', () => {
  const journey = (() => {
    const r = parseMap(JSON.parse(readFileSync(fileURLToPath(new URL('../../core/test/fixtures/care-app.journey.json', import.meta.url)), 'utf8')));
    if (!r.ok) throw new Error(r.problems.join('\n'));
    return r.map;
  })();

  it('lays the boxes out in one line, left to right, with no area boxes', async () => {
    const l = await layoutMap(journey);
    expect(l.flat).toBe(true);
    expect(l.areas).toEqual({});
    expect(l.nodes.j1!.x).toBeLessThan(l.nodes.j2!.x);
    expect(l.nodes.j2!.x).toBeLessThan(l.nodes.j3!.x);
    expect(sides(journey, l, 'j1', 'j2')).toEqual(['r', 'l']);
  });

  it('gives a choice more room than a screen, and lays out again when a box changes kind', async () => {
    const forked = { ...journey, nodes: journey.nodes.map((n) => (n.id === 'j2' ? { ...n, kind: 'choice' as const } : n)) };
    const l = await layoutMap(forked);
    expect(l.nodes.j2!.h).toBeGreaterThan(l.nodes.j1!.h);
    expect(layoutKey(forked)).not.toBe(layoutKey(journey));
  });

  it('wraps a long journey onto rows, and joins the rows from the bottom of one to the top of the next', async () => {
    const base = journey.nodes[0]!;
    const ids = Array.from({ length: 10 }, (_, i) => `k${i}`);
    const long = {
      ...journey,
      nodes: ids.map((id) => ({ ...base, id, screen: undefined })),
      edges: ids.slice(1).map((id, i) => ({ ...journey.edges[0]!, id: `ke${i}`, from: ids[i]!, to: id })),
      tour: [],
    };
    const l = await layoutMap(long);
    const rows = new Set(ids.map((id) => Math.round(l.nodes[id]!.y)));
    expect(rows.size).toBeGreaterThan(1);
    expect(l.width).toBeLessThan(1900);
    const turn = ids.findIndex((id, i) => i > 0 && l.nodes[id]!.x < l.nodes[ids[i - 1]!]!.x);
    expect(turn).toBeGreaterThan(0);
    expect(sides(long, l, ids[turn - 1]!, ids[turn]!)).toEqual(['b', 't']);
  });

  it('gives a screen box with a picture more room, and still wraps a long journey of them', async () => {
    const base = journey.nodes[0]!;
    const ids = Array.from({ length: 8 }, (_, i) => `p${i}`);
    const long = { ...journey, nodes: ids.map((id) => ({ ...base, id })), edges: ids.slice(1).map((id, i) => ({ ...journey.edges[0]!, id: `pe${i}`, from: ids[i]!, to: id })), tour: [] };
    const plain = await layoutMap(long);
    const l = await layoutMap(long, [], new Set(), new Set(ids));
    expect(l.nodes.p0!.h).toBeGreaterThan(plain.nodes.p0!.h);
    expect(l.width).toBeLessThan(1900);
    expect(layoutKey(long, [], [], ids)).not.toBe(layoutKey(long));
  });

  it('starts a journey that loops back where the person starts, not in the middle of the loop', async () => {
    const base = journey.nodes[0]!;
    const ids = ['a', 'b', 'c', 'd', 'e', 'f'];
    const arrows = [['a', 'b'], ['b', 'c'], ['c', 'd'], ['d', 'e'], ['e', 'f'], ['f', 'b']];
    const loop = { ...journey, nodes: ids.map((id) => ({ ...base, id })), edges: arrows.map(([from, to], i) => ({ ...journey.edges[0]!, id: `le${i}`, from: from!, to: to! })), tour: [] };
    const l = await layoutMap(loop);
    const rank = (id: string) => rowOf(l, id) * 100_000 + l.nodes[id]!.x; // reading order: row, then column
    for (let i = 1; i < ids.length; i++) expect(rank(ids[i - 1]!)).toBeLessThan(rank(ids[i]!));
  });
});
