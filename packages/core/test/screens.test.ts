// Screens on boxes: the checker shows a screenshot, an image or a sketch only when it can tie it to the repo.
import { createHash } from 'node:crypto';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import { check } from '../src/check';
import { parseMap, type CodeMap } from '../src/format';
import { capturePaths, type Capture } from '../src/screens';

const APP = fileURLToPath(new URL('./fixtures/care-app', import.meta.url));
const MAP_JSON = JSON.parse(readFileSync(fileURLToPath(new URL('./fixtures/care-app.map.json', import.meta.url)), 'utf8'));
const tmp: string[] = [];
afterAll(() => { for (const d of tmp) rmSync(d, { recursive: true, force: true }); });
const copyApp = () => {
  const dir = mkdtempSync(join(tmpdir(), 'illuminate-screens-'));
  tmp.push(dir);
  cpSync(APP, dir, { recursive: true });
  return dir;
};
/** The fixture map with `screen` on its first box (the Convert button, cited in src/ui/PatientHeader.tsx). */
const withScreen = (screen: unknown): CodeMap => {
  const m = structuredClone(MAP_JSON);
  m.nodes[0].screen = screen;
  const parsed = parseMap(m);
  if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
  return parsed.map;
};
const BOX = MAP_JSON.nodes[0].id as string;
const PNG = Buffer.from('not really a png, but the checker only hashes it');
const saveCapture = (root: string, over: Partial<Capture> = {}) => {
  const record: Capture = {
    id: 'scr-test1', source: { kind: 'page', url: 'http://localhost:3000/patients' }, title: 'Patients', width: 1000, height: 500,
    sha256: createHash('sha256').update(PNG).digest('hex'), takenAt: '2026-11-12T00:00:00.000Z',
    elements: [{ tag: 'a', text: 'Care journeys', x: 0, y: 0, w: 200, h: 40 }, { tag: 'button', text: 'Mark as converted', x: 500, y: 100, w: 100, h: 50 }],
    ...over,
  };
  const p = capturePaths(root, record.id);
  mkdirSync(dirname(p.image), { recursive: true });
  writeFileSync(p.image, PNG);
  writeFileSync(p.record, JSON.stringify(record));
};

describe('the format', () => {
  it('reads maps with and without screens, and says what a screen is missing', () => {
    expect(parseMap(MAP_JSON).ok).toBe(true);
    const bad = structuredClone(MAP_JSON);
    bad.nodes[0].screen = { kind: 'capture' };
    bad.nodes[1].screen = { kind: 'sketch', file: '../outside.tsx' };
    const parsed = parseMap(bad);
    expect(parsed.ok).toBe(false);
    if (!parsed.ok) expect(parsed.problems.join('\n')).toMatch(/needs the `capture` id[\s\S]*needs `file`, a path inside the repo/);
  });
});

describe('a screenshot', () => {
  it('is shown, with the highlighted label marked, when the label is on the screen and in the cited code', () => {
    const root = copyApp();
    saveCapture(root);
    const report = check(withScreen({ kind: 'capture', capture: 'scr-test1', highlight: 'Mark as converted' }), root);
    expect(report.screens[BOX]).toMatchObject({
      status: 'confirmed',
      show: { kind: 'capture', capture: 'scr-test1', from: 'http://localhost:3000/patients', box: { x: 0.5, y: 0.2, w: 0.1, h: 0.1 } },
    });
    // Screens aren't claims: the count is the map's own.
    expect(report.summary).toEqual({ claims: 15, confirmed: 15, unconfirmed: 0, proposals: { pending: 0, done: 0 } });
  });

  it('is left out when illuminate took no such capture, or its image was swapped', () => {
    const root = copyApp();
    expect(check(withScreen({ kind: 'capture', capture: 'scr-none' }), root).screens[BOX]).toMatchObject({ status: 'unconfirmed', show: null });
    saveCapture(root);
    writeFileSync(capturePaths(root, 'scr-test1').image, 'a picture Claude drew');
    const swapped = check(withScreen({ kind: 'capture', capture: 'scr-test1' }), root).screens[BOX]!;
    expect(swapped.status).toBe('unconfirmed');
    expect(swapped.reasons[0]).toContain("isn't the one illuminate took");
  });

  it('is left out when the highlight is not on the screen, or not in the code the box cites', () => {
    const root = copyApp();
    saveCapture(root);
    expect(check(withScreen({ kind: 'capture', capture: 'scr-test1', highlight: 'Delete patient' }), root).screens[BOX]!.reasons[0]).toContain("isn't on the captured screen");
    // "Care journeys" is on the screen, but the box's code (the header component) never says it.
    expect(check(withScreen({ kind: 'capture', capture: 'scr-test1', highlight: 'Care journeys' }), root).screens[BOX]!.reasons[0]).toContain("isn't in the code this box cites");
  });
});

describe('a sketch', () => {
  it('is shown when every element is in the markup file, and left out when one is invented', () => {
    const file = 'src/ui/PatientHeader.tsx';
    const ok = check(withScreen({ kind: 'sketch', file, elements: [{ kind: 'button', text: 'Mark as converted' }], highlight: 'Mark as converted' }), APP);
    expect(ok.screens[BOX]).toMatchObject({ status: 'confirmed', show: { kind: 'sketch', file, highlight: 'Mark as converted' } });
    const invented = check(withScreen({ kind: 'sketch', file, elements: [{ kind: 'button', text: 'Mark as converted' }, { kind: 'button', text: 'Archive' }] }), APP);
    expect(invented.screens[BOX]).toMatchObject({ status: 'unconfirmed', reasons: [`"Archive" isn't in ${file}`] });
  });
});

describe('an image file', () => {
  it('is shown when the cited code names it, and never when it is outside the repo, a secret or not an image', () => {
    const root = copyApp();
    writeFileSync(join(root, 'src/ui/convert.svg'), '<svg xmlns="http://www.w3.org/2000/svg"/>');
    expect(check(withScreen({ kind: 'image', file: 'src/ui/convert.svg' }), root).screens[BOX]!.reasons[0]).toContain("doesn't mention convert.svg");
    const header = join(root, 'src/ui/PatientHeader.tsx');
    writeFileSync(header, `${readFileSync(header, 'utf8')}\nexport const icon = './convert.svg';\n`);
    expect(check(withScreen({ kind: 'image', file: 'src/ui/convert.svg' }), root).screens[BOX]).toMatchObject({ status: 'confirmed', show: { kind: 'image', file: 'src/ui/convert.svg' } });
    expect(check(withScreen({ kind: 'image', file: '.env' }), root).screens[BOX]!.status).toBe('unconfirmed');
    expect(check(withScreen({ kind: 'image', file: 'src/ui/PatientHeader.tsx' }), root).screens[BOX]!.reasons[0]).toContain('not an image file');
  });
});

describe('a wireframe of a page', () => {
  const PAGE = {
    id: 'patient',
    name: 'Patient page',
    file: 'src/ui/PatientPage.tsx',
    regions: [
      { id: 'header', slot: 'top', label: 'Header', file: 'src/ui/PatientHeader.tsx', elements: [{ kind: 'button', text: 'Mark as converted' }] },
      { id: 'links', slot: 'left', label: 'Links', file: 'src/ui/PatientSidebar.tsx', elements: [{ kind: 'link', text: 'All patients' }, { kind: 'link', text: 'Leads' }] },
      { id: 'notes', slot: 'main', label: 'Notes', file: 'src/ui/PatientNotes.tsx', elements: [{ kind: 'heading', text: 'Notes' }, { kind: 'button', text: 'Save note' }] },
    ],
  };
  const MARK = { kind: 'wireframe', page: 'patient', region: 'header', highlight: 'Mark as converted' };
  /** The fixture map with a page, and a wireframe of it on the given boxes (the first box cites PatientHeader.tsx). */
  const withPage = (edit: (page: any) => void = () => {}, screens: Record<string, unknown> = { [BOX]: MARK }) => {
    const m = structuredClone(MAP_JSON);
    const page = structuredClone(PAGE);
    edit(page);
    m.pages = [page];
    for (const n of m.nodes) if (screens[n.id]) n.screen = screens[n.id];
    return parseMap(m);
  };
  const checked = (...args: Parameters<typeof withPage>) => {
    const parsed = withPage(...args);
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    return check(parsed.map, APP);
  };

  it('draws the whole page, with the box\'s region and element marked', () => {
    const c = checked().screens[BOX]!;
    expect(c).toMatchObject({ status: 'confirmed', show: { kind: 'wireframe', region: 'header', highlight: 'Mark as converted', page: { id: 'patient', name: 'Patient page' } } });
    const show = c.show as Extract<typeof c.show, { kind: 'wireframe' }>;
    expect(show.page.regions.map((r) => [r.id, r.slot])).toEqual([['header', 'top'], ['links', 'left'], ['notes', 'main']]);
  });

  it('leaves off a region whose text isn\'t in its file, or whose file the page doesn\'t bring in', () => {
    const made = checked((p) => { p.regions[1].elements.push({ kind: 'link', text: 'Billing' }); });
    expect((made.screens[BOX]!.show as any).page.regions.map((r: any) => r.id)).toEqual(['header', 'notes']);
    const elsewhere = checked((p) => { p.regions[2].file = 'src/email/send.ts'; p.regions[2].elements = []; });
    expect((elsewhere.screens[BOX]!.show as any).page.regions.map((r: any) => r.id)).toEqual(['header', 'links']);
  });

  it('is not shown when the box\'s own region fails, and says why', () => {
    const c = checked((p) => { p.regions[0].file = 'src/email/send.ts'; p.regions[0].elements = []; }, { [BOX]: { kind: 'wireframe', page: 'patient', region: 'header' } }).screens[BOX]!;
    expect(c).toMatchObject({ status: 'unconfirmed', show: null, reasons: ["src/email/send.ts isn't part of this page: src/ui/PatientPage.tsx doesn't bring it in"] });
  });

  it('follows imports through other files to find a region\'s file', () => {
    const root = copyApp();
    writeFileSync(join(root, 'src/ui/App.tsx'), "import { PatientPage } from './PatientPage';\nexport function App() {\n  return <PatientPage patientId=\"1\" />;\n}\n");
    const parsed = withPage((p) => { p.file = 'src/ui/App.tsx'; });
    if (!parsed.ok) throw new Error(parsed.problems.join('\n'));
    expect((check(parsed.map, root).screens[BOX]!.show as any).page.regions).toHaveLength(3);
  });

  it('needs the box to be about the page it shows', () => {
    // The last box cites the nightly job, which has nothing to do with the patient page.
    const other = MAP_JSON.nodes.find((n: any) => n.id === 'j1').id;
    const c = checked(undefined, { [other]: { kind: 'wireframe', page: 'patient', region: 'notes', highlight: 'Save note' } }).screens[other]!;
    expect(c.status).toBe('unconfirmed');
    expect(c.reasons[0]).toContain("isn't part of what it marks");
  });

  it('marks only an element that is in the region', () => {
    const c = checked(undefined, { [BOX]: { ...MARK, highlight: 'Save note' } }).screens[BOX]!;
    expect(c).toMatchObject({ status: 'unconfirmed', reasons: ['the highlight "Save note" isn\'t one of the elements of region "header"'] });
  });

  it('is checked once and shared by every box on the page', () => {
    const second = MAP_JSON.nodes[1].id as string; // cites src/server/routes.ts, so it has to mark something its code names
    const r = checked(undefined, { [BOX]: MARK, [second]: { kind: 'wireframe', page: 'patient' } });
    expect(r.screens[BOX]!.status).toBe('confirmed');
    expect(r.screens[second]!.status).toBe('unconfirmed');
  });

  it('is refused by the format when the page or region doesn\'t exist, or a file leaves the repo', () => {
    const problems = (...args: Parameters<typeof withPage>) => { const r = withPage(...args); return r.ok ? [] : r.problems; };
    expect(problems(undefined, { [BOX]: { kind: 'wireframe', page: 'nope' } })).toEqual([expect.stringContaining('there is no page "nope"')]);
    expect(problems(undefined, { [BOX]: { kind: 'wireframe', page: 'patient', region: 'footer' } })).toEqual([expect.stringContaining('has no region "footer"')]);
    expect(problems(undefined, { [BOX]: { kind: 'wireframe', page: 'patient', highlight: 'Notes' } })).toEqual([expect.stringContaining('needs the `region`')]);
    expect(problems((p) => { p.regions[0].file = '../outside.tsx'; })).toEqual([expect.stringContaining('must be a path inside the repo')]);
    expect(problems((p) => { p.regions[1].id = 'header'; })).toEqual([expect.stringContaining('region id "header" is used twice')]);
    expect(problems((p) => { p.regions[0].slot = 'footer'; })).toHaveLength(1);
  });
});
