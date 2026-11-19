// Where each arrow's label goes, so no label covers a box or another label. A label stays at the middle of its arrow
// when that spot is clear; otherwise it slides along its own arrow to the first clear spot; if there is none, it
// becomes a small dot on the arrow that shows its words when pointed at. Pure geometry, in the map's own coordinates.

export type Rect = { x: number; y: number; w: number; h: number };
export type Point = { x: number; y: number };
export type LabelPlace = Point | 'dot';

export type LabelInput = {
  id: string;
  /** The label's size. */
  w: number;
  h: number;
  /** Where the arrow puts it on its own (the middle of the arrow, or the spot a routed arrow chose). */
  at: Point;
  /** The point a fraction of the way along the arrow, or null when the arrow can't be measured. */
  along: (t: number) => Point | null;
  /** Never made a dot (a missing connection: the map's most important words); placed first, kept where it is if nothing is clear. */
  keep?: boolean;
};

/** Fractions along the arrow to try, nearest the middle first, keeping clear of the arrow's ends. */
export const SPOTS = [0.5, 0.42, 0.58, 0.34, 0.66, 0.26, 0.74, 0.2, 0.8];
/** Room kept around boxes and between labels. */
const GAP = 4;

const overlaps = (a: Rect, b: Rect): boolean =>
  a.x < b.x + b.w + GAP && b.x < a.x + a.w + GAP && a.y < b.y + b.h + GAP && b.y < a.y + a.h + GAP;

const around = (p: Point, w: number, h: number): Rect => ({ x: p.x - w / 2, y: p.y - h / 2, w, h });

/**
 * A place for every label: labels that must stay readable first, then the rest in order; each avoids the boxes and
 * the labels placed before it. `soft` things (area titles) are avoided when possible, but a label would rather cross
 * one than become a dot. A label whose own spot is clear is left out of the result (it stays where its arrow put it).
 */
export function placeLabels(labels: readonly LabelInput[], boxes: readonly Rect[], soft: readonly Rect[] = []): Record<string, LabelPlace> {
  const taken: Rect[] = [];
  const out: Record<string, LabelPlace> = {};
  const clearOf = (r: Rect, avoidSoft: boolean) =>
    !boxes.some((b) => overlaps(r, b)) && !taken.some((t) => overlaps(r, t)) && (!avoidSoft || !soft.some((s) => overlaps(r, s)));
  const ordered = [...labels.filter((l) => l.keep), ...labels.filter((l) => !l.keep)];
  for (const l of ordered) {
    const own = around(l.at, l.w, l.h);
    let spot: Point | null = null;
    for (const avoidSoft of [true, false]) {
      if (clearOf(own, avoidSoft)) {
        spot = l.at;
        break;
      }
      for (const t of SPOTS) {
        const p = l.along(t);
        if (p && clearOf(around(p, l.w, l.h), avoidSoft)) {
          spot = p;
          break;
        }
      }
      if (spot) break;
    }
    if (!spot && l.keep) spot = l.at;
    if (!spot) {
      out[l.id] = 'dot';
      continue;
    }
    taken.push(around(spot, l.w, l.h));
    if (spot !== l.at) out[l.id] = spot;
  }
  return out;
}
