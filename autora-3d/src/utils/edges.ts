/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { BevelStyle, Body3D, CornerBevel, EdgeBevel, EdgeSel, FaceSel, Point2D } from '../types';
import { Outline, getBase, getOutline, holeIndex, holeLocal, holeLoops, holeOf, isHoleIndex, outwardNormal, runId, runPath, sideRun, withHoles, withOutline } from './outline';

export const DEFAULT_BEVEL_SIZE = 2;
export const MAX_BEVEL_SIZE = 30;

export interface EdgePath {
  kind: EdgeSel['kind'];
  index: number;
  /** World-space polyline (Y up). */
  points: { x: number; y: number; z: number }[];
}

const edgeCache = new WeakMap<Body3D, EdgePath[]>();

/** Every pickable edge of a body, in world space. Cached per body object (bodies are immutable). */
export function listEdges(body: Body3D): EdgePath[] {
  let edges = edgeCache.get(body);
  if (!edges) {
    edges = computeEdges(body);
    edgeCache.set(body, edges);
  }
  return edges;
}


const effectiveSize = (body: Body3D, bevel: EdgeBevel | undefined) =>
  bevel && bevel.size > 0 ? Math.min(bevel.size, body.extrusionHeight / 2 - 0.05) : 0;

/** For an open run: where it starts and ends in the outline, and the sides that continue past each end. */
function runEnds(outline: ReturnType<typeof getOutline>, run: number[], n: number) {
  const inRun = new Set(run);
  const m = outline.points.length;
  const segIn = outline.roles.map((role) =>
    role.kind === 'side' ? inRun.has(role.index) : inRun.has(role.index) && inRun.has((role.index - 1 + n) % n)
  );
  if (segIn.every(Boolean)) return null;
  let start = segIn.findIndex((on, k) => on && !segIn[(k - 1 + m) % m]);
  if (start < 0) return null;
  let end = start;
  for (let g = 0; g < m && segIn[(end + 1) % m]; g++) end++;
  end %= m;
  const before = outline.roles[(start - 1 + m) % m];
  const after = outline.roles[(end + 1) % m];
  return {
    start,
    end,
    beforeSide: before.kind === 'side' ? before.index : -1,
    afterSide: after.kind === 'side' ? after.index : -1,
  };
}

export interface Loop {
  base: Point2D[];
  outline: Outline;
  /** Added to every side/vertex index of this loop: 0 for the shape's own outline, HOLE * (hole + 1) for a hole. */
  offset: number;
  /** Winding whose outward normal points away from the material (into a hole). */
  away: 1 | -1;
}

/** The shape's outline followed by each of its holes. */
export function loopsOf(body: Body3D): Loop[] {
  const outline = getOutline(body);
  return [
    { base: getBase(body), outline, offset: 0, away: outline.winding },
    ...holeLoops(body).map((l, h): Loop => ({ base: l.base, outline: l.outline, offset: holeIndex(h), away: (-l.outline.winding) as 1 | -1 })),
  ];
}

/** The loop an edge/side index belongs to, with the index made local to it. */
export function loopFor(body: Body3D, index: number): { loop: Loop; local: number } | null {
  const loops = loopsOf(body);
  const loop = isHoleIndex(index) ? loops[holeOf(index) + 1] : loops[0];
  return loop ? { loop, local: isHoleIndex(index) ? holeLocal(index) : index } : null;
}

/** The index edges on the same run of sides share (a rounded corner joins its neighbours into one). */
export function edgeId(body: Body3D, side: number): number {
  const f = loopFor(body, side);
  return f ? f.loop.offset + runId(sideRun(f.loop.outline, f.loop.base.length, f.local)) : side;
}

function computeEdges(body: Body3D): EdgePath[] {
  const bottom = body.elevation ?? 0;
  const top = bottom + body.extrusionHeight;
  return loopsOf(body).flatMap((ctx) => loopEdges(body, ctx, bottom, top));
}

/** The edges of one outline: the shape's own, or one of its cutouts. A hole's indices are offset (see outline.ts). */
function loopEdges(body: Body3D, ctx: Loop, bottom: number, top: number): EdgePath[] {
  const { base, outline, offset, away } = ctx;
  const n = base.length;
  if (n < 3) return [];
  const edges: EdgePath[] = [];

  const seen = new Set<number>();
  for (let j = 0; j < n; j++) {
    const run = sideRun(outline, n, j);
    const id = offset + runId(run);
    if (seen.has(id)) continue;
    seen.add(id);
    const { pts, closed } = runPath(outline, run, n);
    const ends = closed ? null : runEnds(outline, run, n);
    const m = outline.points.length;

    // Once an edge is beveled, the pickable/highlighted line lies on the bevel itself, not in the air at the old sharp edge.
    const lineFor = (kind: 'top' | 'bottom') => {
      const own = effectiveSize(body, findBevel(body, kind, id));
      const ownBevel = findBevel(body, kind, id);
      // A touch short of the true surface midpoint (0.29 round, 0.5 chamfer) so the line sits just outside it and never hides inside.
      const inset = own > 0 ? own * (ownBevel!.style === 'round' ? 0.18 : 0.4) : 0;
      const y0 = kind === 'top' ? top : bottom;
      const sign = kind === 'top' ? -1 : 1;
      // Where the next edge round the corner is beveled just the same, the two highlight lines meet at one mitred point
      // (each used to stop square to its own edge, leaving little crosses at every corner of a rim).
      const sameAs = (side: number) => {
        const nb = side >= 0 ? findBevel(body, kind, offset + runId(sideRun(outline, n, side))) : undefined;
        return !!nb && !!ownBevel && nb.style === ownBevel.style && Math.abs(effectiveSize(body, nb) - own) < 0.01;
      };
      const line = pts.map((p, i) => {
        if (inset <= 0) return { x: p.x, y: y0, z: -p.y };
        const prev = i > 0 ? pts[i - 1] : closed ? pts[pts.length - 1] : null;
        const next = i < pts.length - 1 ? pts[i + 1] : closed ? pts[0] : null;
        const startNb = !prev && ends && sameAs(ends.beforeSide) ? outwardNormal(outline.points[(ends.start - 1 + m) % m], p, away) : null;
        const endNb = !next && ends && sameAs(ends.afterSide) ? outwardNormal(p, outline.points[(ends.end + 2) % m], away) : null;
        const a = prev ? outwardNormal(prev, p, away) : startNb;
        const b = next ? outwardNormal(p, next, away) : endNb;
        const a2 = a ?? b!;
        const b2 = b ?? a!;
        const nx = (a2.x + b2.x) / 2;
        const ny = (a2.y + b2.y) / 2;
        const len = Math.hypot(nx, ny) || 1;
        return { x: p.x - (nx / len) * inset, y: y0 + sign * inset, z: -(p.y - (ny / len) * inset) };
      });
      if (!ends || own > 0) return line;

      // A neighbouring edge is beveled but this one is not: stop where its bevel starts, follow the bevel's profile
      // curve across this wall, and meet the corner line where it now ends.
      const detour = (atStart: boolean) => {
        const nbSide = atStart ? ends.beforeSide : ends.afterSide;
        if (nbSide < 0) return null;
        const nbBevel = findBevel(body, kind, offset + runId(sideRun(outline, n, nbSide)));
        const r = effectiveSize(body, nbBevel);
        if (!nbBevel || r <= 0) return null;
        const vIdx = atStart ? ends.start : (ends.end + 1) % m;
        const V = outline.points[vIdx];
        const far = atStart ? outline.points[(ends.start - 1 + m) % m] : outline.points[(ends.end + 2) % m];
        const dn = { x: far.x - V.x, y: far.y - V.y };
        const dl = Math.hypot(dn.x, dn.y) || 1;
        dn.x /= dl;
        dn.y /= dl;
        const outN = atStart ? outwardNormal(far, V, away) : outwardNormal(V, far, away);
        const nIn = { x: -outN.x, y: -outN.y };
        const segA = atStart ? pts[0] : pts[pts.length - 2];
        const segB = atStart ? pts[1] : pts[pts.length - 1];
        const mOut = outwardNormal(segA, segB, away);
        const dm = dn.x * mOut.x + dn.y * mOut.y;
        const nm = nIn.x * mOut.x + nIn.y * mOut.y;
        const steps = nbBevel.style === 'round' ? 8 : 1;
        const arc: { x: number; y: number; z: number }[] = [];
        for (let k = steps; k >= 0; k--) {
          const phi = (k / steps) * (Math.PI / 2);
          const [u0, w0] = nbBevel.style === 'round' ? [r * (1 - Math.cos(phi)), r * (1 - Math.sin(phi))] : [r * (k / steps), r * (1 - k / steps)];
          const u = u0 * 0.97; // a hair toward the sharp corner: just outside the surface, so it stays visible
          const w = w0 * 0.97;
          const t = Math.abs(dm) < 1e-3 ? 0 : (-u * nm) / dm;
          arc.push({ x: V.x + dn.x * t + nIn.x * u, y: y0 + sign * w, z: -(V.y + dn.y * t + nIn.y * u) });
        }
        return arc; // from the point on this edge (u = r) down to the corner (u = 0)
      };
      let out = line;
      const startArc = detour(true);
      if (startArc) out = [...startArc.reverse(), ...out.slice(1)];
      const endArc = detour(false);
      if (endArc) out = [...out.slice(0, -1), ...endArc];
      return out;
    };
    edges.push({ kind: 'top', index: id, points: lineFor('top') });
    edges.push({ kind: 'bottom', index: id, points: lineFor('bottom') });
  }
  for (let v = 0; v < n; v++) {
    const a = outline.arcMid.get(v) ?? base[v];
    // Where the edges above or below this corner are beveled, the corner line stops short of the sharp end.
    const reach = (kind: 'top' | 'bottom') =>
      Math.max(0, ...[(v - 1 + n) % n, v].map((side) => effectiveSize(body, findBevel(body, kind, offset + runId(sideRun(outline, n, side))))));
    let yLo = bottom + reach('bottom');
    let yHi = top - reach('top');
    if (yHi - yLo < 1) {
      yLo = bottom;
      yHi = top;
    }
    // A beveled corner: draw the line on the bevel, a little in from the old sharp corner.
    const cb = offset === 0 ? (body.cornerBevels ?? []).find((c) => c.vertex === v) : undefined;
    let cx = a.x;
    let cy = a.y;
    if (cb && cb.size > 0 && !outline.arcMid.has(v)) {
      const na = outwardNormal(base[(v - 1 + n) % n], base[v], away);
      const nb = outwardNormal(base[v], base[(v + 1) % n], away);
      const bx = na.x + nb.x;
      const by = na.y + nb.y;
      const bl = Math.hypot(bx, by) || 1;
      const inset = cb.size * (cb.style === 'round' ? 0.25 : 0.5);
      cx -= (bx / bl) * inset;
      cy -= (by / bl) * inset;
    }
    edges.push({
      kind: 'corner',
      index: offset + v,
      points: [
        { x: cx, y: yLo, z: -cy },
        { x: cx, y: yHi, z: -cy },
      ],
    });
  }
  return edges;
}

const sameRun = (body: Body3D, a: number, b: number) => edgeId(body, a) === edgeId(body, b);

export function findBevel(body: Body3D, side: 'top' | 'bottom', id: number): EdgeBevel | undefined {
  return (body.edgeBevels ?? []).find((b) => b.side === side && sameRun(body, b.edge, id));
}

/** Current size (bevel) or radius (corner) of an edge; 0 when untouched. */
const cornerBevelAt = (body: Body3D, v: number) => (body.cornerBevels ?? []).find((c) => c.vertex === v);

const holeRadius = (body: Body3D, index: number) => body.holeRadii?.[holeOf(index)]?.[holeLocal(index)] ?? 0;

export function edgeSize(body: Body3D, sel: EdgeSel): number {
  if (sel.kind === 'corner' && isHoleIndex(sel.index)) return holeRadius(body, sel.index);
  if (sel.kind === 'corner') return cornerBevelAt(body, sel.index)?.size ?? body.cornerRadii?.[sel.index] ?? 0;
  return findBevel(body, sel.kind, sel.index)?.size ?? 0;
}

export function edgeStyle(body: Body3D, sel: EdgeSel): BevelStyle | undefined {
  if (sel.kind === 'corner' && isHoleIndex(sel.index)) return holeRadius(body, sel.index) > 0 ? 'round' : undefined;
  return sel.kind === 'corner' ? cornerBevelAt(body, sel.index)?.style : findBevel(body, sel.kind, sel.index)?.style;
}

/** Applies a size/style change to the given edges of `body` and returns the update. */
export function applyEdgeChange(
  body: Body3D,
  sels: EdgeSel[],
  patch: { size?: number; style?: BevelStyle }
): Partial<Body3D> {
  let bevels = [...(body.edgeBevels ?? [])];
  const hasRim = sels.some((e) => e.bodyId === body.id && e.kind !== 'corner');
  let corners = [...(body.cornerBevels ?? [])];
  let cornersChanged = false;
  const radii = getBase(body).map((_, i) => body.cornerRadii?.[i] ?? 0);
  let radiiChanged = false;
  const holeRadiiNext = holeLoops(body).map((l) => [...l.radii]);
  let holeRadiiChanged = false;

  for (const sel of sels) {
    if (sel.bodyId !== body.id) continue;
    if (sel.kind === 'corner' && isHoleIndex(sel.index)) {
      // A hole's corners are rounded in plan, unless they were picked together with its rims (then they just stay as they are).
      const row = holeRadiiNext[holeOf(sel.index)];
      const local = holeLocal(sel.index);
      if (!row || local >= row.length || patch.size === undefined || hasRim) continue;
      row[local] = Math.max(0, Math.min(MAX_BEVEL_SIZE * 2, patch.size));
      holeRadiiChanged = true;
      continue;
    }
    if (sel.kind === 'corner') {
      const v = sel.index;
      const cb = corners.find((c) => c.vertex === v);
      if (cb || (hasRim && (radii[v] ?? 0) === 0)) {
        // A corner bevel: cut along the corner and on around any bevel above or below it.
        if (patch.size !== undefined && patch.size <= 0) {
          corners = corners.filter((c) => c.vertex !== v);
        } else if (cb || patch.size !== undefined) {
          const next: CornerBevel = {
            vertex: v,
            size: Math.min(MAX_BEVEL_SIZE, patch.size ?? cb?.size ?? DEFAULT_BEVEL_SIZE),
            style: patch.style ?? cb?.style ?? 'round',
          };
          corners = cb ? corners.map((c) => (c === cb ? next : c)) : [...corners, next];
        }
        cornersChanged = true;
        continue;
      }
      // Picked together with top/bottom edges, a corner that is already curved keeps its curve.
      if (patch.size === undefined || hasRim) continue;
      radii[v] = Math.max(0, Math.min(MAX_BEVEL_SIZE * 2, patch.size));
      radiiChanged = true;
      continue;
    }
    const existing = findBevel(body, sel.kind, sel.index);
    if (patch.size !== undefined && patch.size <= 0) {
      bevels = bevels.filter((b) => b !== existing);
      continue;
    }
    if (!existing && patch.size === undefined && patch.style === undefined) continue;
    // What you set is what you get: a size beyond what the shape allows is held at the largest that fits.
    const cap = Math.max(0.5, Math.min(MAX_BEVEL_SIZE, bevelLimit(body, sel.index)));
    const next: EdgeBevel = {
      side: sel.kind,
      edge: sel.index,
      size: patch.size !== undefined ? Math.min(cap, patch.size) : existing?.size ?? Math.min(cap, defaultBevelSize(body)),
      style: patch.style ?? existing?.style ?? 'round',
    };
    bevels = existing ? bevels.map((b) => (b === existing ? next : b)) : [...bevels, next];
  }

  return {
    edgeBevels: bevels,
    ...(cornersChanged ? { cornerBevels: corners } : {}),
    ...(radiiChanged ? withOutline(body, { cornerRadii: radii }) : {}),
    ...(holeRadiiChanged ? withHoles(body, { holeRadii: holeRadiiNext }) : {}),
  };
}

export interface FeatureRow {
  sel: EdgeSel;
  label: string;
  detail: string;
}

/** Bevels and rounded corners on a body, for the inspector. */
export function listFeatures(body: Body3D): FeatureRow[] {
  const rows: FeatureRow[] = [];
  const outline = getOutline(body);
  const n = getBase(body).length;
  const seen = new Set<string>();
  let top = 0;
  let bottom = 0;
  for (const b of body.edgeBevels ?? []) {
    const id = edgeId(body, b.edge);
    const key = `${b.side}:${id}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const count = b.side === 'top' ? ++top : ++bottom;
    rows.push({
      sel: { bodyId: body.id, kind: b.side, index: id },
      label: `${b.side === 'top' ? 'Top' : 'Bottom'} edge ${count}`,
      detail: `${b.style === 'round' ? 'Round' : 'Chamfer'} ${b.size} mm`,
    });
  }
  (body.cornerRadii ?? []).forEach((r, v) => {
    if (r > 0.5 && outline.radii[v] > 0) {
      rows.push({
        sel: { bodyId: body.id, kind: 'corner', index: v },
        label: `Corner ${v + 1}`,
        detail: `Radius ${Math.round(outline.radii[v] * 10) / 10} mm`,
      });
    }
  });
  return rows;
}

export const edgeKey = (s: EdgeSel) => `${s.bodyId}:${s.kind}:${s.index}`;

// ---------------------------------------------------------------------------
// Selecting edges in bulk
// ---------------------------------------------------------------------------

export type EdgeGroup = 'top' | 'bottom' | 'corner' | 'all';

/** Every edge of one kind on a body: the whole top rim, the whole bottom rim, the vertical corner lines, or all of them. */
export function edgesOfKind(body: Body3D, group: EdgeGroup): EdgeSel[] {
  return listEdges(body)
    .filter((e) => group === 'all' || e.kind === group)
    .map((e) => ({ bodyId: body.id, kind: e.kind, index: e.index }));
}

/** The edges that border a face: its whole rim for the top or bottom; for a wall, its top, bottom and both vertical corner lines. */
export function edgesAroundFace(body: Body3D, face: FaceSel): EdgeSel[] {
  if (face.kind === 'top') return edgesOfKind(body, 'top');
  if (face.kind === 'bottom') return edgesOfKind(body, 'bottom');
  if (face.index === undefined) return [];
  if (isHoleIndex(face.index)) {
    const loop = holeLoops(body)[holeOf(face.index)];
    if (!loop) return [];
    const k = loop.base.length;
    const side = holeLocal(face.index);
    const offset = face.index - side;
    const id = edgeId(body, face.index);
    return [
      { bodyId: body.id, kind: 'top', index: id },
      { bodyId: body.id, kind: 'bottom', index: id },
      { bodyId: body.id, kind: 'corner', index: offset + side },
      { bodyId: body.id, kind: 'corner', index: offset + ((side + 1) % k) },
    ];
  }
  const n = getBase(body).length;
  const id = runId(sideRun(getOutline(body), n, face.index));
  // The wall's top and bottom edge, plus the vertical corner line at each end (a rounded corner counts too).
  return [
    { bodyId: body.id, kind: 'top', index: id },
    { bodyId: body.id, kind: 'bottom', index: id },
    { bodyId: body.id, kind: 'corner', index: face.index },
    { bodyId: body.id, kind: 'corner', index: (face.index + 1) % n },
  ];
}

const keyset = (sels: EdgeSel[]) => new Set(sels.map(edgeKey));

/** True when `sels` is exactly every edge in `group` of the body. */
export function isWholeGroup(body: Body3D, sels: EdgeSel[], group: EdgeGroup): boolean {
  const all = edgesOfKind(body, group);
  if (!all.length || all.length !== sels.length) return false;
  const have = keyset(sels);
  return all.every((e) => have.has(edgeKey(e)));
}

/** Short words for what is selected: "Edge", "5 edges", with "Top loop" etc. when it is a whole rim. */
export function describeEdges(body: Body3D, sels: EdgeSel[]): { title: string; sub: string } {
  const onlyCorners = sels.every((e) => e.kind === 'corner');
  const noun = onlyCorners ? 'corner' : 'edge';
  const title = sels.length === 1 ? (onlyCorners ? 'Corner' : 'Edge') : `${sels.length} ${noun}s`;
  if (sels.length > 1 && isWholeGroup(body, sels, 'top')) return { title, sub: 'Top loop' };
  if (sels.length > 1 && isWholeGroup(body, sels, 'bottom')) return { title, sub: 'Bottom loop' };
  if (sels.length > 1 && isWholeGroup(body, sels, 'corner')) return { title, sub: 'All corners' };
  if (sels.length > 1 && isWholeGroup(body, sels, 'all')) return { title, sub: 'Every edge' };
  return { title, sub: body.name };
}

/** Adds the edge to the selection, or removes it when it is already in. */
export function toggleEdge(current: EdgeSel[], sel: EdgeSel): EdgeSel[] {
  const k = edgeKey(sel);
  return current.some((c) => edgeKey(c) === k) ? current.filter((c) => edgeKey(c) !== k) : [...current, sel];
}

/** The edge whose size and style the controls show: a top or bottom edge if there is one, else the first. */
export const primaryEdge = (sels: EdgeSel[]): EdgeSel => sels.find((e) => e.kind !== 'corner') ?? sels[0];

const inradiusCache = new WeakMap<Point2D[], number>();

/** The radius of the biggest circle that fits inside an outline (found on a grid, so approximate). A bevel cannot be deeper than this: past it the top face would be gone. */
export function inradius(points: Point2D[]): number {
  const cached = inradiusCache.get(points);
  if (cached !== undefined) return cached;
  const xs = points.map((p) => p.x);
  const ys = points.map((p) => p.y);
  const x0 = Math.min(...xs);
  const y0 = Math.min(...ys);
  const w = Math.max(...xs) - x0;
  const h = Math.max(...ys) - y0;
  const N = 36;
  let best = 0;
  for (let i = 0; i <= N; i++) {
    for (let j = 0; j <= N; j++) {
      const px = x0 + (w * i) / N;
      const py = y0 + (h * j) / N;
      let inside = false;
      let d = Infinity;
      for (let k = 0, m = points.length; k < m; k++) {
        const a = points[k];
        const b = points[(k + 1) % m];
        if (a.y > py !== b.y > py && px < ((b.x - a.x) * (py - a.y)) / (b.y - a.y) + a.x) inside = !inside;
        const dx = b.x - a.x;
        const dy = b.y - a.y;
        const t = Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / (dx * dx + dy * dy || 1)));
        d = Math.min(d, Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy)));
      }
      if (inside && d > best) best = d;
    }
  }
  // The grid can only miss the very middle, so this errs on the small, safe side.
  inradiusCache.set(points, best);
  return best;
}

/** How large a bevel on this run can get: not more than half the body's height, nor than the rounding it wraps around. */
export function runLimit(height: number, outline: Outline, run: number[], n: number, offset: number): number {
  let size = height / 2 - 0.05;
  const corners = outline.radii.filter((r, v) => r > 0 && run.includes(v) && run.includes((v - 1 + n) % n));
  if (offset > 0) {
    // A hole's cutter reaches `size + 1` into the hole, so it has to stay well inside it.
    const xs = outline.points.map((p) => p.x);
    const ys = outline.points.map((p) => p.y);
    size = Math.min(size, (Math.min(Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys)) * 0.5) / 1.5 - 1);
    if (corners.length) size = Math.min(size, Math.min(...corners) - 1.2);
  } else {
    // Deeper than the shape is wide, and the top face is gone and the cut folds over itself.
    size = Math.min(size, inradius(outline.points) * 0.97 - 0.05);
    if (corners.length) size = Math.min(size, Math.min(...corners) * 0.9);
  }
  return size;
}

/** The largest size the bevel on this edge can have before it stops growing. */
export function bevelLimit(body: Body3D, edge: number): number {
  const found = loopFor(body, edge);
  if (!found) return Infinity;
  const { loop, local } = found;
  const n = loop.base.length;
  if (local >= n) return Infinity;
  return Math.max(0, runLimit(Math.max(1, body.extrusionHeight), loop.outline, sideRun(loop.outline, n, local), n, loop.offset));
}


/** The largest size every selected edge can take at once (corner rounding has its own, larger, range). */
export function maxBevelSize(body: Body3D, sels: EdgeSel[]): number {
  const limits = sels.filter((s) => s.kind !== 'corner').map((s) => bevelLimit(body, s.index));
  return Math.max(0.5, Math.min(MAX_BEVEL_SIZE, ...limits));
}

/** A first bevel you can see: about an eighth of the shape's smallest size, so it reads at once without eating the shape. */
export function defaultBevelSize(body: Body3D): number {
  const xs = body.points.map((p) => p.x);
  const ys = body.points.map((p) => p.y);
  const smallest = Math.min(body.extrusionHeight, Math.max(...xs) - Math.min(...xs), Math.max(...ys) - Math.min(...ys));
  return Math.max(1, Math.min(6, Math.round((smallest / 8) * 2) / 2));
}
