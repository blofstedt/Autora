/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, DrawSession, Frame, Point2D } from '../types';
import { getPolygonSignedArea } from './geometry';
import { withOutline } from './outline';

const round2 = (n: number) => Math.round(n * 100) / 100;
/** Smallest outline worth keeping, in mm. */
export const MIN_DRAWN_SIZE = 2;
/** Height a freshly drawn shape starts with: low enough to read as a plate, ready to pull up. */
export const DRAWN_HEIGHT = 20;
const ARC_STEP = (Math.PI / 180) * 7;

/** Centre and radius of the circle through three points, or null when they are in a line. */
export function circleThrough(a: Point2D, b: Point2D, c: Point2D): { cx: number; cy: number; r: number } | null {
  const d = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(d) < 1e-6) return null;
  const a2 = a.x * a.x + a.y * a.y;
  const b2 = b.x * b.x + b.y * b.y;
  const c2 = c.x * c.x + c.y * c.y;
  const cx = (a2 * (b.y - c.y) + b2 * (c.y - a.y) + c2 * (a.y - b.y)) / d;
  const cy = (a2 * (c.x - b.x) + b2 * (a.x - c.x) + c2 * (b.x - a.x)) / d;
  return { cx, cy, r: Math.hypot(a.x - cx, a.y - cy) };
}

/** Points along the side a→b, curving through `via` when given. Includes `a`, leaves out `b`. */
export function sidePoints(a: Point2D, b: Point2D, via: Point2D | null): Point2D[] {
  const arc = via && circleThrough(a, via, b);
  if (!via || !arc) return [a];
  const ang = (p: Point2D) => Math.atan2(p.y - arc.cy, p.x - arc.cx);
  const a0 = ang(a);
  const am = ang(via);
  let a1 = ang(b);
  // Sweep the way that passes through `via`.
  const norm = (x: number) => ((x % (2 * Math.PI)) + 2 * Math.PI) % (2 * Math.PI);
  const toMid = norm(am - a0);
  const toEnd = norm(a1 - a0);
  const sweep = toMid <= toEnd ? toEnd : toEnd - 2 * Math.PI;
  const n = Math.max(2, Math.ceil(Math.abs(sweep) / ARC_STEP));
  const out: Point2D[] = [a];
  for (let i = 1; i < n; i++) {
    const t = a0 + (sweep * i) / n;
    out.push({ x: round2(arc.cx + arc.r * Math.cos(t)), y: round2(arc.cy + arc.r * Math.sin(t)) });
  }
  return out;
}

/** The sketch as one polyline: straight sides stay straight, bent sides become arcs. `closed` adds the side back to the first corner. */
export function sketchOutline(points: Point2D[], bends: (Point2D | null)[], closed: boolean): Point2D[] {
  const out: Point2D[] = [];
  const sides = closed ? points.length : points.length - 1;
  for (let i = 0; i < sides; i++) out.push(...sidePoints(points[i], points[(i + 1) % points.length], bends[i] ?? null));
  if (!closed && points.length) out.push(points[points.length - 1]);
  return out;
}

/** What a finished sketch becomes: the outline to extrude, and corner rounding for a true circle. */
export interface DrawnOutline {
  basePoints: Point2D[];
  cornerRadii?: number[];
  name: string;
}

export function rectangleOutline(a: Point2D, b: Point2D): DrawnOutline | null {
  const x0 = Math.min(a.x, b.x);
  const x1 = Math.max(a.x, b.x);
  const y0 = Math.min(a.y, b.y);
  const y1 = Math.max(a.y, b.y);
  if (x1 - x0 < MIN_DRAWN_SIZE || y1 - y0 < MIN_DRAWN_SIZE) return null;
  return {
    name: 'Sketch box',
    basePoints: [
      { x: x0, y: y0 },
      { x: x1, y: y0 },
      { x: x1, y: y1 },
      { x: x0, y: y1 },
    ],
  };
}

/** A circle is a square rounded all the way, like the stock cylinder, so it stays smooth and resizable. */
export function circleOutline(centre: Point2D, edge: Point2D): DrawnOutline | null {
  const r = round2(Math.hypot(edge.x - centre.x, edge.y - centre.y));
  if (r < MIN_DRAWN_SIZE / 2) return null;
  return {
    name: 'Sketch circle',
    basePoints: [
      { x: round2(centre.x - r), y: round2(centre.y - r) },
      { x: round2(centre.x + r), y: round2(centre.y - r) },
      { x: round2(centre.x + r), y: round2(centre.y + r) },
      { x: round2(centre.x - r), y: round2(centre.y + r) },
    ],
    cornerRadii: [r, r, r, r],
  };
}

/** The finished outline of a corner-by-corner sketch, or null while it is too small or in a line. */
export function shapeOutline(s: Pick<DrawSession, 'points' | 'bends'>): DrawnOutline | null {
  if (s.points.length < 3) return null;
  const flat = sketchOutline(s.points, s.bends, true);
  const area = getPolygonSignedArea(flat);
  if (Math.abs(area) < MIN_DRAWN_SIZE * MIN_DRAWN_SIZE) return null;
  return { name: 'Sketch', basePoints: area < 0 ? flat.slice().reverse() : flat };
}

/** A new shape from a drawn outline: standing on a surface at `elevation`, or growing out of a wall (`frame`). */
export function drawnBody(outline: DrawnOutline, elevation: number, id: string, name: string, color: string, frame?: Frame): Body3D {
  const base: Body3D = {
    id,
    name,
    points: outline.basePoints,
    basePoints: outline.basePoints,
    extrusionHeight: DRAWN_HEIGHT,
    // On a wall the surface is the shape's own ground: it stands out of the wall rather than up from a height.
    elevation: frame ? 0 : round2(elevation),
    ...(frame ? { frame } : {}),
    color,
    materialType: 'matte',
    visible: true,
    createdAt: new Date().toISOString(),
  };
  return outline.cornerRadii ? { ...base, ...withOutline(base, { basePoints: outline.basePoints, cornerRadii: outline.cornerRadii }) } : base;
}

/**
 * Where a drawn point lands: whole millimetres, pulled onto a corner of an existing shape when close,
 * or lined up with the last corner placed (straight across or straight down).
 */
export function snapDrawPoint(p: Point2D, corners: Point2D[], last: Point2D | null, reach = 4): Point2D {
  let best: Point2D | null = null;
  let bestD = reach;
  for (const c of corners) {
    const d = Math.hypot(c.x - p.x, c.y - p.y);
    if (d < bestD) {
      bestD = d;
      best = c;
    }
  }
  if (best) return { x: best.x, y: best.y };
  const out = { x: Math.round(p.x), y: Math.round(p.y) };
  if (last) {
    if (Math.abs(out.x - last.x) <= 2) out.x = last.x;
    if (Math.abs(out.y - last.y) <= 2) out.y = last.y;
  }
  return out;
}
