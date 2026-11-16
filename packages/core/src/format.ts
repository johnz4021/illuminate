// The map format: what Claude (or later the engine) writes, the checker verifies and the viewer draws.
// This is the one-way door. Statuses are never part of it: the checker computes them from the repo every time.
// That goes for proposals too: a map says what it would add, change or remove, and the checker says where that stands.
import { z } from 'zod';

const Id = z.string().regex(/^[A-Za-z0-9_.:-]{1,64}$/, 'ids use letters, digits, _ . : - (at most 64)');

/** A line of code that backs a claim. `text` must appear on that line (whitespace-insensitive) or within a few lines of it. */
export const Evidence = z.object({
  file: z.string().min(1),
  line: z.number().int().positive(),
  text: z.string().min(1).max(400),
});

/**
 * How a box is drawn: a way in (button, route, CLI), a step, a store (table, queue), something outside the repo, a job.
 * On a journey: a screen the person looks at, something they do, a point where they choose between ways forward.
 */
export const NodeKind = z.enum(['entry', 'step', 'store', 'external', 'job', 'screen', 'action', 'choice']);

/**
 * What an arrow claims. `calls`, `request` (fetch → route) and `imports` are also proven from code facts;
 * `then` (and anything the extractors can't see yet, like events) is proven by its evidence text alone.
 */
export const EdgeKind = z.enum(['calls', 'request', 'imports', 'then']);

/**
 * What the person sees at a box, when a picture helps. Optional, and the checker decides whether it's shown:
 * - `capture`: a screenshot illuminate took itself (`capture` is its id under `.illuminate/screens/`).
 * - `image`: an image file in the repo that the box's cited code uses (an icon, a sprite).
 * - `sketch`: a rough wireframe of the visible things in a markup `file`; every element's text must be in that file.
 * `highlight` is the text of the thing on screen this box is about (the button's label), which gets marked.
 * On a box that carries `proposed`, a sketch may hold elements that are `proposed` too: the screen as it would be.
 */
export const ScreenElement = z.object({
  kind: z.enum(['heading', 'button', 'field', 'link', 'text', 'image']),
  text: z.string().min(1).max(80),
  /** Not on the screen yet: something a proposal would put there. Only on a box that carries `proposed`. */
  proposed: z.boolean().optional(),
});
export const Screen = z.object({
  kind: z.enum(['capture', 'image', 'sketch']),
  capture: Id.optional(),
  file: z.string().min(1).optional(),
  elements: z.array(ScreenElement).min(1).max(12).optional(),
  highlight: z.string().min(1).max(80).optional(),
});

/**
 * A proposal: this box or arrow is something the map suggests adding, changing or removing, not a claim about the
 * code as it is. Where it stands (still proposed, or done) is computed by the checker from the repo, never stored.
 * - `add`: not in the code yet, so it cites nothing. A box says where it would live with `symbol`, and an arrow says
 *   what it would be with `kind`, so the checker can tell once it has been built.
 * - `change`, `remove`: in the code today, and cited like any other claim.
 */
export const Proposal = z.object({
  kind: z.enum(['add', 'change', 'remove']),
  /** What would change and why, in a plain sentence. */
  note: z.string().min(1).max(300).optional(),
});

export const Area = z.object({ id: Id, label: z.string().min(1).max(40) });

export const Node = z.object({
  id: Id,
  area: Id,
  kind: NodeKind.default('step'),
  name: z.string().min(1).max(80),
  /** `<file>#<symbol>` as the facts name it, e.g. `src/patients/service.ts#markConverted`. */
  symbol: z.string().regex(/^[^#]+#.+$/, 'symbol is <file>#<name>').optional(),
  explain: z.object({ concept: z.string(), how: z.string(), code: z.string() }).partial().optional(),
  /** At least one line, except on a proposed addition (`parseMap` enforces it). */
  evidence: z.array(Evidence).default([]),
  screen: Screen.optional(),
  proposed: Proposal.optional(),
});

export const Edge = z.object({
  id: Id,
  from: Id,
  to: Id,
  kind: EdgeKind.default('then'),
  label: z.string().min(1).max(60),
  /** At least one line, except on a proposed addition (`parseMap` enforces it). */
  evidence: z.array(Evidence).default([]),
  proposed: Proposal.optional(),
});

/** A claim that something is missing, proven by a search the checker runs again: `matches` is the count claimed. */
export const Absence = z.object({
  id: Id,
  claim: z.string().min(1).max(200),
  /** Draw it as a missing arrow between these boxes. */
  between: z.object({ from: Id, to: Id }).optional(),
  search: z.object({
    pattern: z.string().min(1).max(200),
    regex: z.boolean().default(false),
    /** Globs to search; the whole repo when omitted. */
    paths: z.array(z.string().min(1)).optional(),
  }),
  matches: z.number().int().min(0),
});

export const TourStop = z.object({
  id: Id,
  title: z.string().min(1).max(80),
  text: z.string().min(1).max(1200),
  focus: z.object({
    areas: z.array(Id).optional(),
    nodes: z.array(Id).optional(),
    edges: z.array(Id).optional(),
    absences: z.array(Id).optional(),
  }),
  terms: z.array(z.string()).optional(),
  ask: z.array(z.string()).optional(),
});

export const CodeMap = z.object({
  version: z.literal(1),
  question: z.string().min(1).max(300),
  /** The commit the map was made from, when known. */
  commit: z.string().nullable().optional(),
  /** `journey`: drawn as a user flow (left to right, shapes by kind, no code on the boxes). The claims are checked the same. */
  view: z.enum(['journey']).optional(),
  areas: z.array(Area).min(1),
  nodes: z.array(Node).min(1),
  edges: z.array(Edge).default([]),
  absences: z.array(Absence).default([]),
  tour: z.array(TourStop).default([]),
});

export type Evidence = z.output<typeof Evidence>;
export type Screen = z.output<typeof Screen>;
export type Proposal = z.output<typeof Proposal>;
export type MapNode = z.output<typeof Node>;
export type MapEdge = z.output<typeof Edge>;
export type MapAbsence = z.output<typeof Absence>;
export type TourStop = z.output<typeof TourStop>;
export type CodeMap = z.output<typeof CodeMap>;

export type ParseResult = { ok: true; map: CodeMap } | { ok: false; problems: string[] };

/** A repo-relative path that can't climb out of the repo: no absolute paths, no `..`, no backslashes. */
export function isSafeRelativePath(path: string): boolean {
  if (!path || path.startsWith('/') || path.includes('\\') || /^[A-Za-z]:/.test(path)) return false;
  return path.split('/').every((seg) => seg !== '..' && seg !== '');
}

/** A box or arrow the map proposes adding: the only kind of claim that cites no code. */
export const isAddition = (x: { proposed?: Proposal }): boolean => x.proposed?.kind === 'add';

/**
 * Validates shape, then references: unique ids, edges between real boxes, tour stops that point at real things.
 * Proposals have to hang off the code: everything cites a line except a proposed addition, an arrow to or from a
 * proposed box is itself proposed, and every proposed box connects, through arrows, to a box that exists.
 */
export function parseMap(input: unknown): ParseResult {
  const parsed = CodeMap.safeParse(input);
  if (!parsed.success) {
    return { ok: false, problems: parsed.error.issues.map((i) => `${i.path.join('.') || '(map)'}: ${i.message}`) };
  }
  const map = parsed.data;
  const problems: string[] = [];
  const ids = (kind: string, items: readonly { id: string }[]) => {
    const seen = new Set<string>();
    for (const { id } of items) {
      if (seen.has(id)) problems.push(`${kind} id "${id}" is used twice`);
      seen.add(id);
    }
    return seen;
  };
  const areas = ids('area', map.areas);
  const nodes = ids('node', map.nodes);
  const edges = ids('edge', map.edges);
  const absences = ids('absence', map.absences);
  ids('tour stop', map.tour);

  const evidence = (where: string, item: { evidence: readonly Evidence[]; proposed?: Proposal }) => {
    if (!item.evidence.length && !isAddition(item)) problems.push(`${where}: cite at least one line of code in \`evidence\` (only a proposed addition goes without)`);
    for (const e of item.evidence) if (!isSafeRelativePath(e.file)) problems.push(`${where}: evidence file "${e.file}" must be a path inside the repo`);
  };
  const added = new Set(map.nodes.filter(isAddition).map((n) => n.id));
  for (const n of map.nodes) {
    if (!areas.has(n.area)) problems.push(`node "${n.id}": unknown area "${n.area}"`);
    if (n.symbol && !isSafeRelativePath(n.symbol.slice(0, n.symbol.indexOf('#')))) problems.push(`node "${n.id}": symbol file must be a path inside the repo`);
    evidence(`node "${n.id}"`, n);
    const sc = n.screen;
    if (sc?.kind === 'capture' && !sc.capture) problems.push(`node "${n.id}": a capture screen needs the \`capture\` id illuminate_capture returned`);
    if (sc && sc.kind !== 'capture' && (!sc.file || !isSafeRelativePath(sc.file))) problems.push(`node "${n.id}": a ${sc.kind} screen needs \`file\`, a path inside the repo`);
    if (sc?.kind === 'sketch' && !sc.elements) problems.push(`node "${n.id}": a sketch screen needs \`elements\``);
    if (!n.proposed && sc?.elements?.some((e) => e.proposed)) problems.push(`node "${n.id}": only a box that carries \`proposed\` can have proposed screen elements`);
  }
  for (const e of map.edges) {
    if (!nodes.has(e.from)) problems.push(`edge "${e.id}": unknown node "${e.from}"`);
    if (!nodes.has(e.to)) problems.push(`edge "${e.id}": unknown node "${e.to}"`);
    evidence(`edge "${e.id}"`, e);
    const end = [e.from, e.to].find((id) => added.has(id));
    if (end && !isAddition(e)) problems.push(`edge "${e.id}": box "${end}" is a proposed addition, so an arrow to or from it must be one too (\`proposed\`: { "kind": "add" })`);
  }
  // A proposed box that touches nothing real is a drawing, not a change to this code.
  if (added.size) {
    const anchored = new Set(map.nodes.filter((n) => !added.has(n.id)).map((n) => n.id));
    for (let grew = true; grew; ) {
      grew = false;
      for (const e of map.edges) {
        if (anchored.has(e.from) === anchored.has(e.to)) continue;
        anchored.add(e.from).add(e.to);
        grew = true;
      }
    }
    for (const id of added) if (nodes.has(id) && !anchored.has(id)) problems.push(`node "${id}": a proposed box must connect, through arrows, to a box that exists in the code`);
  }
  for (const a of map.absences) {
    if (a.between && !nodes.has(a.between.from)) problems.push(`absence "${a.id}": unknown node "${a.between.from}"`);
    if (a.between && !nodes.has(a.between.to)) problems.push(`absence "${a.id}": unknown node "${a.between.to}"`);
    const end = a.between && [a.between.from, a.between.to].find((id) => added.has(id));
    if (end) problems.push(`absence "${a.id}": box "${end}" is a proposed addition; an absence is about the code as it is`);
  }
  for (const t of map.tour) {
    const refs: [string, readonly string[] | undefined, Set<string>][] = [
      ['area', t.focus.areas, areas], ['node', t.focus.nodes, nodes], ['edge', t.focus.edges, edges], ['absence', t.focus.absences, absences],
    ];
    for (const [kind, list, known] of refs) for (const id of list ?? []) if (!known.has(id)) problems.push(`tour stop "${t.id}": unknown ${kind} "${id}"`);
  }
  return problems.length ? { ok: false, problems } : { ok: true, map };
}
