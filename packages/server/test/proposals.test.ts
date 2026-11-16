// Proposals through the maker and the explainer: Claude draws a change on top of the code as it is, and the checker
// decides where each proposal stands. One the code already settles was misread, and goes back or isn't drawn.
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, describe, expect, it } from 'vitest';
import { check, parseMap } from '@illuminate/core';
import { answer } from '../src/explainer';
import { makeMap } from '../src/maker';
import { CARE_MAP, cleanup, copyCareApp, scriptedAgent } from './helpers';

afterAll(cleanup);

const careMap = () => {
  const r = parseMap(CARE_MAP);
  if (!r.ok) throw new Error(r.problems.join('\n'));
  return r.map;
};
const AREA = CARE_MAP.nodes.find((n: any) => n.id === 'u1').area;
const LISTENER_BOX = { id: 'pl', area: AREA, name: 'Listen for conversions', symbol: 'src/automations/listeners.ts#onConverted', proposed: { kind: 'add', note: 'Run the rules right away.' } };
const LISTENER_ARROWS = [
  { id: 'p1', from: 's4', to: 'pl', kind: 'then', label: 'is heard by', proposed: { kind: 'add' } },
  { id: 'p2', from: 'pl', to: 'u1', kind: 'calls', label: 'runs the rules', proposed: { kind: 'add' } },
];
const needsCode = () => ({ route: 'code', missing: 'What a listener would look like.' });

describe('a map with a proposal', () => {
  it('is made in one round when the proposal sits on confirmed code', async () => {
    const root = copyCareApp();
    const drafted = { ...structuredClone(CARE_MAP), nodes: [...CARE_MAP.nodes, LISTENER_BOX], edges: [...CARE_MAP.edges, ...LISTENER_ARROWS] };
    const agent = scriptedAgent([() => drafted]);
    const r = await makeMap({ root, question: 'How would we send the welcome email right away?', agent });
    expect(r.rounds).toBe(1);
    expect(r.report.summary).toEqual({ claims: 15, confirmed: 15, unconfirmed: 0, proposals: { pending: 3, done: 0 } });
    expect(agent.calls[0]!.prompt).toContain('## Proposals (`proposed` on a box or arrow; only when a change is asked for)');
    expect(agent.calls[0]!.prompt).toContain('## When the question is about what a person sees or does');
  });

  it('sends back a proposal to add what the code already has', async () => {
    const root = copyCareApp();
    const exists = { ...LISTENER_BOX, symbol: 'src/automations/evaluate.ts#evaluateRules' };
    const drafted = { ...structuredClone(CARE_MAP), nodes: [...CARE_MAP.nodes, exists], edges: [...CARE_MAP.edges, ...LISTENER_ARROWS] };
    const agent = scriptedAgent([() => drafted, () => ({ nodes: [LISTENER_BOX] })]);
    const r = await makeMap({ root, question: 'q', agent });
    expect(r.rounds).toBe(2);
    expect(agent.calls[1]!.prompt).toContain('- box pl: you propose adding it, but the code already has it.');
    expect(r.report.nodes.pl).toMatchObject({ status: 'proposed', proposal: { kind: 'add', state: 'pending' } });
  });

  it('turns from proposed to done when the same map is checked after the change is built', async () => {
    const root = copyCareApp();
    const drafted = { ...structuredClone(CARE_MAP), nodes: [...CARE_MAP.nodes, LISTENER_BOX], edges: [...CARE_MAP.edges, ...LISTENER_ARROWS] };
    const r = await makeMap({ root, question: 'q', agent: scriptedAgent([() => drafted]) });
    writeFileSync(join(root, 'src/automations/listeners.ts'), "import { evaluateRules } from './evaluate';\nexport function onConverted({ patientId }: { patientId: string }) {\n  return evaluateRules({ patientId });\n}\n");
    const after = check(r.map, root);
    expect(after.nodes.pl).toMatchObject({ status: 'confirmed', proposal: { kind: 'add', state: 'done' } });
    expect(after.edges.p2).toMatchObject({ status: 'confirmed', proposal: { kind: 'add', state: 'done' } });
  });
});

describe('a proposal in an answer', () => {
  it('draws new boxes as proposed and marks what is already on the map as to change or remove', async () => {
    const root = copyCareApp();
    const agent = scriptedAgent([needsCode, () => ({
      concept: 'Listen for the announcement and drop the nightly job.',
      refs: ['pl', 'j1'],
      add: { nodes: [LISTENER_BOX], edges: LISTENER_ARROWS },
      propose: [
        { id: 'j1', proposed: { kind: 'remove', note: 'Not needed once the listener exists.' } },
        { id: 'pl', proposed: { kind: 'change' } },
        { id: 'nope', proposed: { kind: 'remove' } },
      ],
    })]);
    const r = await answer({ root, map: careMap(), selection: {}, question: 'What would it take to send it right away?', agent, session: null });
    expect(r.answer.added).toEqual(['pl', 'p1', 'p2']);
    expect(r.answer.proposed).toEqual(['j1']);
    expect(r.map.nodes.find((n) => n.id === 'j1')!.proposed).toEqual({ kind: 'remove', note: 'Not needed once the listener exists.' });
    expect(r.report.summary).toMatchObject({ unconfirmed: 0, proposals: { pending: 4, done: 0 } });
    expect(r.answer.refs).toEqual([{ id: 'pl', status: 'proposed' }, { id: 'j1', status: 'confirmed' }]);
    expect(r.answer.problems).toEqual([
      'Not marked as a proposal: "Listen for conversions" (new boxes and arrows carry their own `proposed`)',
      'Not marked as a proposal: "nope" isn\'t a confirmed box or arrow on this map',
    ]);
    expect(agent.calls[1]!.prompt).toContain('draw it on the map as proposals');
  });

  it('does not draw a box proposed as new when the code already has it', async () => {
    const root = copyCareApp();
    const exists = { ...LISTENER_BOX, symbol: 'src/automations/evaluate.ts#evaluateRules' };
    const agent = scriptedAgent([needsCode, () => ({ concept: 'Add a listener.', refs: [], add: { nodes: [exists], edges: LISTENER_ARROWS } })]);
    const r = await answer({ root, map: careMap(), selection: {}, question: 'q', agent, session: null });
    expect(r.answer.added).toEqual([]);
    expect(r.answer.problems[0]).toBe('Not drawn, pl was proposed as new but the code already has it');
    expect(r.map).toEqual(careMap());
  });
});
