/**
 * Putting two people's edits to the same file together.
 *
 * The agent works from the file as it last saw it (`base`) and has made its
 * change (`ours`); meanwhile the person has saved theirs (`theirs`). If the two
 * touched different parts, both stay. If they touched the same lines
 * differently, nothing is written: the agent is told what they did and decides.
 * Edits that make the same change to the same lines agree, and are taken once.
 *
 * Lines, as in any three-way merge: each side is compared with the base, the
 * regions each changed are found, and regions that do not overlap are both
 * applied. Changes that merely touch (one ends where the next begins) are not
 * a conflict: neither overwrites the other.
 */

import { diffLines } from "./codediff";

interface Hunk {
  /** In the base: lines [start, end) are replaced by `lines`. An insertion has start === end. */
  start: number;
  end: number;
  lines: string[];
}

interface Conflict {
  /** Where, in the base, the conflicting region begins (1-based). */
  line: number;
  base: string[];
  ours: string[];
  theirs: string[];
}

interface Merged {
  text: string;
  conflicts: Conflict[];
  /** Whether the person's changes are in the result (they changed something and it was kept). */
  withTheirs: boolean;
}

const linesOf = (text: string): { lines: string[]; ends: boolean } => {
  const ends = text.endsWith("\n");
  const lines = text.split(/\r?\n/);
  if (ends) lines.pop();
  return { lines, ends };
};

/** The regions of the base that `other` replaces. */
function hunksOf(base: string[], other: string[]): Hunk[] {
  const out: Hunk[] = [];
  let at = 0;
  let open: Hunk | null = null;
  for (const op of diffLines(base, other)) {
    if (op.t === " ") {
      open = null;
      at += 1;
    } else {
      if (!open) {
        open = { start: at, end: at, lines: [] };
        out.push(open);
      }
      if (op.t === "-") {
        open.end += 1;
        at += 1;
      } else open.lines.push(op.s);
    }
  }
  return out;
}

/** Whether two regions of the base clash: they share a line, or are insertions at one point. */
function clash(a: Hunk, b: Hunk): boolean {
  if (a.start === a.end && b.start === b.end) return a.start === b.start;
  if (a.start === a.end) return a.start > b.start && a.start < b.end;
  if (b.start === b.end) return b.start > a.start && b.start < a.end;
  return a.start < b.end && b.start < a.end;
}

const same = (a: string[], b: string[]) => a.length === b.length && a.every((l, i) => l === b[i]);

export function merge3(baseText: string, oursText: string, theirsText: string): Merged {
  const base = linesOf(baseText);
  const ours = linesOf(oursText);
  const theirs = linesOf(theirsText);
  // Nothing of theirs to keep: the agent's change stands as it is.
  if (baseText === theirsText) return { text: oursText, conflicts: [], withTheirs: false };
  // Nothing of ours: theirs stands.
  if (baseText === oursText) return { text: theirsText, conflicts: [], withTheirs: true };

  const a = hunksOf(base.lines, ours.lines);
  const b = hunksOf(base.lines, theirs.lines);
  const out: string[] = [];
  const conflicts: Conflict[] = [];
  let at = 0;
  let i = 0, j = 0;
  let withTheirs = false;

  const take = (upto: number) => {
    for (; at < upto; at += 1) out.push(base.lines[at]);
  };

  while (i < a.length || j < b.length) {
    const ha = a[i], hb = b[j];
    // The next region, and everything on the other side that clashes with it.
    const first = !hb || (ha && ha.start <= hb.start) ? "a" : "b";
    const lead = first === "a" ? ha : hb;
    const rivals = first === "a" ? b : a;
    let ri = first === "a" ? j : i;
    // Grow the region while the other side has something that clashes with it.
    let start = lead.start, end = lead.end;
    const mineList: Hunk[] = [lead];
    const theirList: Hunk[] = [];
    let grew = true;
    while (grew) {
      grew = false;
      while (ri < rivals.length && clash({ start, end, lines: [] }, rivals[ri])) {
        theirList.push(rivals[ri]);
        start = Math.min(start, rivals[ri].start);
        end = Math.max(end, rivals[ri].end);
        ri += 1;
        grew = true;
      }
      // The lead side's next hunks may now clash with the grown region too.
      const own = first === "a" ? a : b;
      let oi = (first === "a" ? i : j) + mineList.length;
      while (oi < own.length && clash({ start, end, lines: [] }, own[oi])) {
        mineList.push(own[oi]);
        start = Math.min(start, own[oi].start);
        end = Math.max(end, own[oi].end);
        oi += 1;
        grew = true;
      }
    }
    if (first === "a") {
      i += mineList.length;
      j += theirList.length;
    } else {
      j += mineList.length;
      i += theirList.length;
    }
    const aSide = first === "a" ? mineList : theirList;
    const bSide = first === "a" ? theirList : mineList;

    take(start);
    // Each side's version of the region [start, end).
    const render = (hunks: Hunk[]) => {
      const lines: string[] = [];
      let pos = start;
      for (const h of hunks) {
        for (; pos < h.start; pos += 1) lines.push(base.lines[pos]);
        lines.push(...h.lines);
        pos = h.end;
      }
      for (; pos < end; pos += 1) lines.push(base.lines[pos]);
      return lines;
    };
    if (aSide.length > 0 && bSide.length > 0) {
      const o = render(aSide), t = render(bSide);
      if (same(o, t)) out.push(...o);
      else {
        conflicts.push({ line: start + 1, base: base.lines.slice(start, end), ours: o, theirs: t });
        out.push(...o);
      }
      withTheirs = true;
    } else if (aSide.length > 0) {
      out.push(...render(aSide));
    } else {
      out.push(...render(bSide));
      withTheirs = true;
    }
    at = end;
  }
  take(base.lines.length);
  const ends = base.ends || ours.ends || theirs.ends;
  return { text: out.join("\n") + (ends && out.length > 0 ? "\n" : ""), conflicts, withTheirs };
}
