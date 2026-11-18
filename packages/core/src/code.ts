// The code behind a box, an arrow or the notes on an answer, as blocks a person can read: the function a cited line is
// in (whole when it is short, the lines around the citation when it is long), with the cited lines marked. Read through
// the same readers and located with the same line check as everything else, so what is shown is what was checked. No
// model, and nothing is stored: it is worked out from the repo each time.
import type { SymbolFact } from '@illuminate/facts';
import { DEFAULT_LINE_WINDOW, checkEvidence, sidesOf, type Side } from './check';
import type { CodeMap, Evidence } from './format';

/** A line of code an answer points at, with what it says about that line. Checked like any citation. */
export type CodeNote = Evidence & { note: string };

export type CodeBlock = {
  file: string;
  /** The function, class or type these lines are in, as the code facts name it. Null when the facts know of none. */
  name: string | null;
  /** Whether the block is all of it, or only the lines around what is cited. */
  whole: boolean;
  /** The line number of the first line. */
  start: number;
  lines: string[];
  /** Line numbers the box, arrow or answer cites. */
  cited: number[];
  notes: { line: number; note: string }[];
};
export type CodeView = {
  /** `before`: the code as it was at the commit a map of a change is compared with. */
  when: 'now' | 'before';
  blocks: CodeBlock[];
  /** Citations or notes whose line that version of the code doesn't have, so nothing is shown for them. */
  missing: number;
};

/** A function is shown whole up to this many lines; a longer one is shown around its cited lines. */
const WHOLE_NAMED = 160;
const WHOLE_FOUND = 60;
const CONTEXT = 6;
const MAX_BLOCKS = 8;
const MAX_LINES = 500;
const MAX_LINE_CHARS = 400;

type Mark = { file: string; line: number; note?: string };
type Range = { from: number; to: number; name: string | null; whole: boolean };

const fileOf = (symbol: string) => symbol.slice(0, symbol.indexOf('#'));

/** Line numbers for offsets into `text`. */
function lineFinder(text: string): (offset: number) => number {
  const starts = [0];
  for (let i = text.indexOf('\n'); i !== -1; i = text.indexOf('\n', i + 1)) starts.push(i + 1);
  return (offset) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
}

function join(a: Range, b: Range): Range {
  const from = Math.min(a.from, b.from);
  const to = Math.max(a.to, b.to);
  // One inside the other keeps the outer one's extent, and the name of whichever is a whole function. Two that only
  // overlap are just lines of the file.
  const outer = [a, b].find((r) => r.from === from && r.to === to);
  const inner = outer === a ? b : a;
  return outer ? { ...outer, name: outer.whole ? outer.name : inner.whole ? inner.name : outer.name ?? inner.name } : { from, to, name: a.name === b.name ? a.name : a.name ?? b.name, whole: false };
}

function blocksFor(side: Side, marks: readonly Mark[], symbol?: string): CodeBlock[] {
  const files = [...new Set([...(symbol ? [fileOf(symbol)] : []), ...marks.map((m) => m.file)])];
  const out: CodeBlock[] = [];
  let total = 0;
  for (const file of files) {
    const text = side.repo.text(file);
    if (text === null) continue;
    const lines = text.split('\n');
    const lineOf = lineFinder(text);
    const span = (s: SymbolFact) => ({ from: lineOf(s.span.start), to: lineOf(Math.max(s.span.start, s.span.end - 1)) });
    const symbols = (side.facts.get(file)?.symbols ?? []).filter((s) => s.kind !== 'property').map((s) => ({ name: s.name, id: s.id, ...span(s) }));
    const here = marks.filter((m) => m.file === file && m.line >= 1 && m.line <= lines.length);
    const around = (line: number, name: string | null): Range => ({ from: Math.max(1, line - CONTEXT), to: Math.min(lines.length, line + CONTEXT), name, whole: false });

    const ranges: Range[] = [];
    const named = symbol && fileOf(symbol) === file ? symbols.find((s) => s.id === symbol) : undefined;
    if (named) {
      if (named.to - named.from < WHOLE_NAMED) ranges.push({ from: named.from, to: named.to, name: named.name, whole: true });
      // Too long to show whole: its opening lines, unless a cited line inside it says where to look.
      else if (!here.some((m) => m.line >= named.from && m.line <= named.to)) ranges.push({ from: named.from, to: named.from + 2 * CONTEXT, name: named.name, whole: false });
    }
    for (const m of here) {
      // The smallest function (or class, or type) the line is in. One-liners say nothing more than the line itself.
      const inside = symbols.filter((s) => s.from <= m.line && m.line <= s.to && s.to - s.from >= 2).sort((a, b) => a.to - a.from - (b.to - b.from))[0];
      if (inside && inside.to - inside.from < WHOLE_FOUND) ranges.push({ from: inside.from, to: inside.to, name: inside.name, whole: true });
      else ranges.push(around(m.line, inside?.name ?? null));
    }
    ranges.sort((a, b) => a.from - b.from || b.to - a.to);
    const merged: Range[] = [];
    for (const r of ranges) {
      const last = merged[merged.length - 1];
      if (last && r.from <= last.to + 1) merged[merged.length - 1] = join(last, r);
      else merged.push(r);
    }
    for (const r of merged) {
      if (out.length >= MAX_BLOCKS || total >= MAX_LINES) return out;
      const to = Math.min(r.to, r.from + (MAX_LINES - total) - 1);
      const inRange = here.filter((m) => m.line >= r.from && m.line <= to);
      out.push({
        file,
        name: r.name,
        whole: r.whole && to === r.to,
        start: r.from,
        lines: lines.slice(r.from - 1, to).map((l) => (l.length > MAX_LINE_CHARS ? `${l.slice(0, MAX_LINE_CHARS)}…` : l)),
        cited: [...new Set(inRange.map((m) => m.line))].sort((a, b) => a - b),
        notes: inRange.flatMap((m) => (m.note ? [{ line: m.line, note: m.note }] : [])),
      });
      total += to - r.from + 1;
    }
  }
  return out;
}

/** Where each citation is in that version of the code. Ones it doesn't have are counted, not shown. */
function locate<T extends Evidence>(side: Side, evidence: readonly T[]): { found: (T & { line: number })[]; missing: number } {
  const found: (T & { line: number })[] = [];
  let missing = 0;
  for (const e of evidence) {
    const c = checkEvidence(side.repo, e, DEFAULT_LINE_WINDOW);
    if (c.ok && c.foundAt !== null) found.push({ ...e, line: c.foundAt });
    else missing++;
  }
  return { found, missing };
}

/**
 * The code behind a box or arrow of a map. `before` reads the commit a map of a change is compared with. Null when
 * the map has no such box or arrow, or `before` is asked of a map that has nothing to compare with.
 */
export function codeOf(map: CodeMap, root: string, id: string, when: CodeView['when'] = 'now'): CodeView | null {
  const item = map.nodes.find((n) => n.id === id) ?? map.edges.find((e) => e.id === id);
  if (!item) return null;
  const { now, base } = sidesOf(map, root);
  const side = when === 'before' ? base : now;
  if (!side) return null;
  const { found, missing } = locate(side, item.evidence);
  return { when, blocks: blocksFor(side, found, 'symbol' in item ? item.symbol : undefined), missing };
}

/** The notes that hold against the code as it is, each on the line where its text was found, and why the others don't. */
export function checkNotes(root: string, notes: readonly CodeNote[]): { notes: CodeNote[]; dropped: string[] } {
  const { now } = sidesOf({}, root);
  const kept: CodeNote[] = [];
  const dropped: string[] = [];
  for (const n of notes) {
    const c = checkEvidence(now.repo, n, DEFAULT_LINE_WINDOW);
    if (!c.ok || c.foundAt === null) dropped.push(`${n.file}:${n.line}: ${c.reason ?? 'not found'}`);
    else if (!kept.some((k) => k.file === n.file && k.line === c.foundAt)) kept.push({ ...n, line: c.foundAt });
  }
  return { notes: kept, dropped };
}

/** The code an answer's notes point at, checked again against the code as it is now. */
export function codeForNotes(root: string, notes: readonly CodeNote[]): CodeView {
  const { now } = sidesOf({}, root);
  const { found, missing } = locate(now, notes);
  return { when: 'now', blocks: blocksFor(now, found), missing };
}
