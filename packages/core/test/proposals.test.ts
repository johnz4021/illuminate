// Proposals: what a map suggests adding, changing or removing, drawn on top of the code as it is. The map says what is
// proposed; where each proposal stands is computed from the repo, like every other status.
import { cpSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { check, settledProposals } from '../src/check';
import { parseMap, type CodeMap } from '../src/format';

const APP = fileURLToPath(new URL('./fixtures/care-app', import.meta.url));
const MAP_JSON = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/care-app.map.json', import.meta.url)), 'utf8'));

const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const copyApp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'illuminate-proposal-'));
  tmp.push(dir);
  cpSync(APP, dir, { recursive: true });
  return dir;
};

/** The care-app map plus a proposal: listen for the announcement, and stop relying on the nightly job. */
const proposal = (edit: (m: any) => void = () => undefined): any => {
  const m = structuredClone(MAP_JSON);
  m.nodes.push({
    id: 'pl', area: m.nodes.find((n: any) => n.id === 'u1').area, name: 'Listen for conversions',
    symbol: 'src/automations/listeners.ts#onConverted', proposed: { kind: 'add', note: 'Run the rules as soon as a patient converts.' },
  });
  m.edges.push({ id: 'p1', from: 's4', to: 'pl', kind: 'then', label: 'is heard by', proposed: { kind: 'add' } });
  m.edges.push({ id: 'p2', from: 'pl', to: 'u1', kind: 'calls', label: 'runs the rules', proposed: { kind: 'add' } });
  m.nodes.find((n: any) => n.id === 'j1').proposed = { kind: 'remove', note: 'No longer needed once the listener exists.' };
  m.edges.find((e: any) => e.id === 'ej').proposed = { kind: 'remove' };
  edit(m);
  return m;
};
const load = (json: unknown): CodeMap => {
  const parsed = parseMap(json);
  if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
  return parsed.map;
};
const LISTENER = "import { bus } from '../events/bus';\nimport { evaluateRules } from './evaluate';\n\nexport function onConverted({ patientId }: { patientId: string }) {\n  return evaluateRules({ patientId });\n}\nbus.on('patient.converted', onConverted);\n";

describe('a proposal in the map format', () => {
  it('lets a proposed addition cite nothing, and nothing else', () => {
    expect(parseMap(proposal()).ok).toBe(true);
    const r = parseMap(proposal((m) => { m.nodes.find((n: any) => n.id === 'j1').evidence = []; }));
    expect(r).toMatchObject({ ok: false, problems: ['node "j1": cite at least one line of code in `evidence` (only a proposed addition goes without)'] });
  });

  it('makes an arrow to or from a proposed box a proposal too', () => {
    const r = parseMap(proposal((m) => { delete m.edges.find((e: any) => e.id === 'p2').proposed; m.edges.find((e: any) => e.id === 'p2').evidence = [{ file: 'src/db.ts', line: 1, text: 'x' }]; }));
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems[0]).toContain('edge "p2": box "pl" is a proposed addition, so an arrow to or from it must be one too');
  });

  it('refuses a proposed box that connects to nothing in the code', () => {
    const r = parseMap(proposal((m) => { m.edges = m.edges.filter((e: any) => !['p1', 'p2'].includes(e.id)); }));
    expect(r).toMatchObject({ ok: false, problems: ['node "pl": a proposed box must connect, through arrows, to a box that exists in the code'] });
    // Two proposed boxes that only connect to each other aren't anchored either.
    const island = parseMap(proposal((m) => {
      m.edges = m.edges.filter((e: any) => !['p1', 'p2'].includes(e.id));
      m.nodes.push({ id: 'pm', area: m.nodes[0].area, name: 'Another new step', proposed: { kind: 'add' } });
      m.edges.push({ id: 'p3', from: 'pl', to: 'pm', label: 'then', proposed: { kind: 'add' } });
    }));
    expect(island.ok).toBe(false);
  });

  it('keeps proposed screen elements to boxes that carry a proposal', () => {
    const r = parseMap(proposal((m) => {
      m.nodes.find((n: any) => n.id === 's2').screen = { kind: 'sketch', file: 'src/ui/PatientHeader.tsx', elements: [{ kind: 'button', text: 'Archive', proposed: true }] };
    }));
    expect(r).toMatchObject({ ok: false, problems: ['node "s2": only a box that carries `proposed` can have proposed screen elements'] });
  });
});

describe('where a proposal stands', () => {
  it('is pending while the code is as it was: additions are proposed, not failed claims', () => {
    const report = check(load(proposal()), APP);
    expect(report.nodes.pl).toMatchObject({ status: 'proposed', proposal: { kind: 'add', state: 'pending' } });
    expect(report.edges.p1).toMatchObject({ status: 'proposed', proposal: { kind: 'add', state: 'pending' } });
    expect(report.edges.p2).toMatchObject({ status: 'proposed', proposal: { kind: 'add', state: 'pending' } });
    // What would be removed is still real code, and is checked as such.
    expect(report.nodes.j1).toMatchObject({ status: 'confirmed', proof: 'fact', proposal: { kind: 'remove', state: 'pending' } });
    expect(report.edges.ej).toMatchObject({ status: 'confirmed', proposal: { kind: 'remove', state: 'pending' } });
    expect(report.summary).toEqual({ claims: 15, confirmed: 15, unconfirmed: 0, proposals: { pending: 5, done: 0 } });
    expect(settledProposals(report)).toEqual([]);
  });

  it('is done once the code has the addition and no longer has what was to go', () => {
    const root = copyApp();
    writeFileSync(join(root, 'src/automations/listeners.ts'), LISTENER);
    rmSync(join(root, 'src/jobs/nightly.ts'));
    const report = check(load(proposal()), root);
    expect(report.nodes.pl).toMatchObject({ status: 'confirmed', proof: 'fact', proposal: { kind: 'add', state: 'done' } });
    expect(report.edges.p2).toMatchObject({ status: 'confirmed', proof: 'fact', proposal: { kind: 'add', state: 'done' } });
    // "is heard by" isn't a call, request or import, so the facts can't show it was built: it stays proposed.
    expect(report.edges.p1).toMatchObject({ status: 'proposed', proposal: { kind: 'add', state: 'pending' } });
    expect(report.nodes.j1).toMatchObject({ status: 'proposed', proposal: { kind: 'remove', state: 'done' } });
    expect(report.edges.ej).toMatchObject({ status: 'proposed', proposal: { kind: 'remove', state: 'done' } });
    expect(report.summary.proposals).toEqual({ pending: 1, done: 4 });
    // The gap the proposal was for is no longer a gap: its search now finds the listener.
    expect(report.absences.miss).toMatchObject({ status: 'unconfirmed', found: 1 });
    expect(report.summary.unconfirmed).toBe(1);
  });

  it('reports a proposal the code already settles, so a map being written can be sent back', () => {
    const report = check(load(proposal((m) => {
      m.nodes.find((n: any) => n.id === 'pl').symbol = 'src/automations/evaluate.ts#evaluateRules'; // already there
      m.nodes.find((n: any) => n.id === 'j1').evidence[0].text = 'function runWeekly('; // not there
    })), APP);
    expect(settledProposals(report).map((p) => `${p.what} ${p.id} ${p.kind}`)).toEqual(['box j1 remove', 'box pl add']);
  });

  it('never counts a tour stop about a proposal as unconfirmed', () => {
    const map = load(proposal((m) => { m.tour.push({ id: 'tp', title: 'The proposal', text: 'Listen instead of waiting for the night.', focus: { nodes: ['pl', 'j1'], edges: ['p1'] } }); }));
    expect(check(map, APP).tour.tp).toEqual({ status: 'ok', unconfirmed: [] });
  });
});

describe('a proposed screen', () => {
  const file = 'src/ui/PatientHeader.tsx';
  const withSketch = (m: any) => {
    const s1 = m.nodes.find((n: any) => n.id === 's1');
    s1.proposed = { kind: 'change', note: 'Add a way to undo a conversion.' };
    s1.screen = { kind: 'sketch', file, elements: [{ kind: 'button', text: 'Mark as converted' }, { kind: 'button', text: 'Undo conversion', proposed: true }] };
  };

  it('shows what would be added next to what is there, and still refuses an invented element that is not marked', () => {
    const report = check(load(proposal(withSketch)), APP);
    expect(report.screens.s1).toMatchObject({
      status: 'confirmed',
      show: { kind: 'sketch', elements: [{ kind: 'button', text: 'Mark as converted' }, { kind: 'button', text: 'Undo conversion', proposed: true }] },
    });
    const invented = check(load(proposal((m) => { withSketch(m); m.nodes.find((n: any) => n.id === 's1').screen.elements.push({ kind: 'link', text: 'Help' }); })), APP);
    expect(invented.screens.s1).toMatchObject({ status: 'unconfirmed', reasons: [`"Help" isn't in ${file}`] });
  });

  it('stops calling an element proposed once the file has it, whatever the map says', () => {
    const root = copyApp();
    writeFileSync(join(root, file), `${readFileSync(join(root, file), 'utf8')}\n// <button>Undo conversion</button>\n`);
    const show = check(load(proposal(withSketch)), root).screens.s1!.show;
    expect(show).toMatchObject({ elements: [{ text: 'Mark as converted' }, { text: 'Undo conversion' }] });
    expect(JSON.stringify(show)).not.toContain('proposed');
  });

  it('draws a new screen for a proposed box whose file does not exist yet', () => {
    const report = check(load(proposal((m) => {
      m.nodes.find((n: any) => n.id === 'pl').screen = { kind: 'sketch', file: 'src/ui/Welcome.tsx', elements: [{ kind: 'heading', text: 'Welcome aboard' }] };
    })), APP);
    expect(report.screens.pl).toMatchObject({ status: 'confirmed', show: { elements: [{ kind: 'heading', text: 'Welcome aboard', proposed: true }] } });
  });
});

describe('a missing connection', () => {
  it('says how many files its search covered, and proves nothing when it covered none', () => {
    expect(check(load(MAP_JSON), APP).absences.miss).toMatchObject({ status: 'confirmed', found: 0, searched: 9 });
    const narrow = structuredClone(MAP_JSON);
    narrow.absences[0].search.paths = ['src/nowhere/**'];
    expect(check(load(narrow), APP).absences.miss).toMatchObject({ status: 'unconfirmed', searched: 0, reasons: ['no files match src/nowhere/**, so nothing was searched'] });
  });
});
