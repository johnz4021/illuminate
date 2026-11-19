// A journey with one main path and branches, on the server side: Claude is told how to name branches, the output
// schemas let it, and a map that has them keeps them through making and checking.
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { makeMap } from '../src/maker';
import { explainerPrompt, makerPrompt } from '../src/prompts';
import { ANSWER_SCHEMA, MAP_PATCH_SCHEMA, MAP_SCHEMA, validatorFor } from '../src/schemas';
import { cleanup, copyCareApp, scriptedAgent } from './helpers';

afterAll(cleanup);

const JOURNEY = JSON.parse(readFileSync(fileURLToPath(new URL('../../core/test/fixtures/care-app.journey.json', import.meta.url)), 'utf8'));

/** The properties a node and an edge may have in an output schema, found by walking it. */
function itemProps(schema: unknown, list: 'nodes' | 'edges'): string[] {
  const found: string[] = [];
  const walk = (v: unknown) => {
    if (!v || typeof v !== 'object') return;
    const props = (v as { properties?: Record<string, unknown> }).properties;
    const items = props?.[list] as { items?: { properties?: Record<string, unknown> } } | undefined;
    if (items?.items?.properties) found.push(...Object.keys(items.items.properties));
    for (const x of Object.values(v)) walk(x);
  };
  walk(schema);
  return found;
}

describe('pages on a journey', () => {
  it('tells Claude a page is one state of a screen, so a wireframe never shows states that are never on screen together', () => {
    const prompt = makerPrompt('What does someone go through when they make a map?', '');
    expect(prompt).toContain('A page is what the person sees at one moment');
    expect(prompt).toContain('each state they see is its own page');
    expect(prompt).toContain('Never put things that are never on screen together in one page');
    expect(prompt).not.toContain('Define each page once');
  });
});

describe('a journey with branches', () => {
  it('tells Claude what the main path is and how to name a branch', () => {
    const p = makerPrompt('What does a patient go through?', '(head start)');
    expect(p).toContain('One main path, with branches');
    expect(p).toContain('`"branch"`');
    expect(p).toContain('at most 5');
  });

  it('lets Claude write a branch on boxes and arrows, in a map, a repair and an answer', () => {
    for (const schema of [MAP_SCHEMA, MAP_PATCH_SCHEMA, ANSWER_SCHEMA]) {
      expect(itemProps(schema, 'nodes')).toContain('branch');
      expect(itemProps(schema, 'edges')).toContain('branch');
    }
    const parsed = validatorFor(MAP_SCHEMA)!.safeParse(JOURNEY);
    expect(parsed.success && (parsed.data as { nodes: { branch?: string }[] }).nodes.map((n) => n.branch ?? null)).toEqual([null, null, null, 'Writes a note instead', 'Goes back to the lists', 'No welcome rule']);
  });

  it('keeps the branches through making the map, and checks every part of it', async () => {
    const r = await makeMap({ root: copyCareApp(), question: JOURNEY.question, agent: scriptedAgent([() => structuredClone(JOURNEY)]) });
    expect(r.report.summary).toMatchObject({ claims: 12, confirmed: 12, unconfirmed: 0 });
    expect(r.map.edges.filter((e) => e.branch).map((e) => [e.id, e.branch])).toEqual([
      ['jc', 'Writes a note instead'], ['jd', 'Writes a note instead'], ['je', 'Goes back to the lists'], ['jf', 'No welcome rule'],
    ]);
    // Asked about it later, Claude sees the branches in the map and is told to name the branch of what it adds.
    const p = explainerPrompt(r.map, r.report, [], 'And if they write a note?');
    expect(p).toContain('"branch":"Writes a note instead"');
    expect(p).toContain('carries the `branch` it is on');
  });
});
