/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, Point2D, RepeatLink, RepeatSession } from '../types';
import { BodyTransform, selectionBounds, transformBody } from './transform';

const SAMPLES = 240;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface PathStop {
  x: number;
  y: number;
  /** Direction of travel here, radians. */
  tangent: number;
}

/** The curve a path repeat follows: straight, or a quadratic curve through `bend` at its middle. */
export function pathControl(s: RepeatSession): Point2D | null {
  return s.bend ?? null;
}

/** Densely sampled path from start to end, with the length run so far at each sample. */
function samplePath(s: RepeatSession): { pts: Point2D[]; along: number[] } {
  const c = pathControl(s);
  const pts: Point2D[] = [];
  for (let i = 0; i <= SAMPLES; i++) {
    const t = i / SAMPLES;
    const u = 1 - t;
    pts.push(
      c
        ? { x: u * u * s.start.x + 2 * u * t * c.x + t * t * s.end.x, y: u * u * s.start.y + 2 * u * t * c.y + t * t * s.end.y }
        : { x: s.start.x + (s.end.x - s.start.x) * t, y: s.start.y + (s.end.y - s.start.y) * t }
    );
  }
  const along = [0];
  for (let i = 1; i < pts.length; i++) along.push(along[i - 1] + Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y));
  return { pts, along };
}

/** Length of the whole path (a path repeat) or of the circle (an around repeat). */
export function pathLength(s: RepeatSession): number {
  if (s.kind === 'around') return 2 * Math.PI * Math.hypot(s.start.x - s.end.x, s.start.y - s.end.y);
  return samplePath(s).along[SAMPLES];
}

/** Distance between neighbouring copies, measured along the path. */
export function spacing(s: RepeatSession): number {
  const n = Math.max(2, Math.round(s.count));
  return s.kind === 'around' ? pathLength(s) / n : pathLength(s) / (n - 1);
}

/** Where every copy sits, the first being the original. A path puts the last copy at its end; "around" spreads them over the full circle. */
export function stops(s: RepeatSession): PathStop[] {
  const n = Math.max(2, Math.round(s.count));
  if (s.kind === 'around') {
    const r = Math.hypot(s.start.x - s.end.x, s.start.y - s.end.y);
    const a0 = Math.atan2(s.start.y - s.end.y, s.start.x - s.end.x);
    return Array.from({ length: n }, (_, i) => {
      const a = a0 + (2 * Math.PI * i) / n;
      return { x: s.end.x + r * Math.cos(a), y: s.end.y + r * Math.sin(a), tangent: a + Math.PI / 2 };
    });
  }
  const { pts, along } = samplePath(s);
  const total = along[SAMPLES];
  const out: PathStop[] = [];
  let seg = 1;
  for (let i = 0; i < n; i++) {
    // Equal steps of distance, not of the curve parameter, so the gaps really are equal.
    const d = (total * i) / (n - 1);
    while (seg < SAMPLES && along[seg] < d) seg++;
    const a = pts[seg - 1];
    const b = pts[seg];
    const span = along[seg] - along[seg - 1];
    const f = span > 1e-9 ? (d - along[seg - 1]) / span : 0;
    out.push({ x: a.x + (b.x - a.x) * f, y: a.y + (b.y - a.y) * f, tangent: Math.atan2(b.y - a.y, b.x - a.x) });
  }
  return out;
}

/** The move that takes the original to copy `i` (1 and up). */
export function copyTransforms(s: RepeatSession): BodyTransform[] {
  const all = stops(s);
  const first = all[0];
  return all.slice(1).map((p) => {
    if (s.kind === 'around') {
      const turn = Math.atan2(p.y - s.end.y, p.x - s.end.x) - Math.atan2(first.y - s.end.y, first.x - s.end.x);
      // Turning the copy about the circle's centre carries it round; without "turn" it only slides there, keeping its heading.
      return s.follow
        ? { dx: 0, dy: 0, dz: 0, angle: turn, cx: s.end.x, cy: s.end.y }
        : { dx: p.x - first.x, dy: p.y - first.y, dz: 0, angle: 0, cx: first.x, cy: first.y };
    }
    return {
      dx: p.x - first.x,
      dy: p.y - first.y,
      dz: 0,
      angle: s.follow ? p.tangent - first.tangent : 0,
      cx: first.x,
      cy: first.y,
    };
  });
}

/** A new session beside the shape: a few copies in a row along +X, a little apart, with no setup. */
export function defaultSession(body: Body3D): RepeatSession {
  const b = selectionBounds([body])!;
  const count = 4;
  const gap = Math.max(10, (b.maxX - b.minX) * 1.3);
  const start = { x: round2(b.centerX), y: round2(b.centerY) };
  return { bodyId: body.id, kind: 'path', start, end: { x: round2(start.x + gap * (count - 1)), y: start.y }, bend: null, count, follow: false };
}

/** Changes the distance between copies by stretching the path (or circle) about its start. */
export function withSpacing(s: RepeatSession, gap: number): RepeatSession {
  const now = spacing(s);
  if (now < 1e-6 || gap <= 0) return s;
  const k = gap / now;
  const scale = (p: Point2D): Point2D => ({ x: round2(s.start.x + (p.x - s.start.x) * k), y: round2(s.start.y + (p.y - s.start.y) * k) });
  return { ...s, end: scale(s.end), bend: s.bend ? scale(s.bend) : null };
}

/** Quadratic control point that makes the curve pass through `through` at its middle. */
export function bendThrough(s: RepeatSession, through: Point2D): Point2D {
  return { x: round2(2 * through.x - (s.start.x + s.end.x) / 2), y: round2(2 * through.y - (s.start.y + s.end.y) / 2) };
}

/** Where the middle of the curve is (the bend handle). */
export function bendHandle(s: RepeatSession): Point2D {
  const c = s.bend;
  return c ? { x: (s.start.x + 2 * c.x + s.end.x) / 4, y: (s.start.y + 2 * c.y + s.end.y) / 4 } : { x: (s.start.x + s.end.x) / 2, y: (s.start.y + s.end.y) / 2 };
}

/** The copies of `body` along `s`, with ids that stay the same every time they are rebuilt. */
export function makeCopies(body: Body3D, s: RepeatSession, idPrefix: string | number): Body3D[] {
  // A shape on a wall repeats inside its wall: the path is in the shape's own space, so its outline moves and the frame stays.
  const flat = body.frame ? { ...body, frame: undefined } : body;
  return copyTransforms(s).map((t, i) => ({
    ...body,
    ...transformBody(flat, t),
    id: `${idPrefix}_${i + 1}`,
    name: `${body.name} ${i + 2}`,
    groupId: undefined,
    repeatOf: body.id,
    createdAt: body.createdAt,
  }));
}

/** `ids` plus every live-repeat copy that follows one of them: what moves or turns when the shape does. */
export function withCopies(ids: string[], bodies: Body3D[]): string[] {
  if (!bodies.some((b) => b.repeatOf)) return ids;
  const set = new Set(ids);
  return [...new Set([...ids, ...bodies.filter((b) => b.repeatOf && set.has(b.repeatOf)).map((b) => b.id)])];
}

const round2b = (n: number) => Math.round(n * 100) / 100;

/** The same rigid move/turn a body gets, applied to a repeat's path so the whole row travels with its shape. */
export function transformLink<T extends RepeatSession>(link: T, t: BodyTransform): T {
  const cos = Math.cos(t.angle);
  const sin = Math.sin(t.angle);
  const move = (p: Point2D): Point2D => {
    const rx = p.x - t.cx;
    const ry = p.y - t.cy;
    return { x: round2b(t.cx + rx * cos - ry * sin + t.dx), y: round2b(t.cy + rx * sin + ry * cos + t.dy) };
  };
  return { ...link, start: move(link.start), end: move(link.end), bend: link.bend ? move(link.bend) : null };
}

const cache = new Map<string, { source: Body3D; link: RepeatLink; copies: Body3D[] }>();

/**
 * Makes the copies match their repeats: rebuilds them from the source shape and the path, keeping their ids.
 * A repeat whose source has gone (joined, deleted) lets go of its copies, which stay as ordinary shapes.
 */
export function syncRepeats(bodies: Body3D[], repeats: RepeatLink[]): { bodies: Body3D[]; repeats: RepeatLink[] } {
  if (!repeats.length && !bodies.some((b) => b.repeatOf)) return { bodies, repeats };
  const base = bodies.filter((b) => !b.repeatOf);
  const byId = new Map(base.map((b) => [b.id, b]));
  const kept: RepeatLink[] = [];
  const derived: Body3D[] = [];
  const followed = new Set<string>();
  for (const link of repeats) {
    const source = byId.get(link.bodyId);
    if (!source || followed.has(source.id)) continue;
    followed.add(source.id);
    // The path is anchored to the shape's centre: when the shape grows on one side or moves, the path follows.
    const c = selectionBounds([source])!;
    const shift = { x: c.centerX - link.start.x, y: c.centerY - link.start.y };
    let l = link;
    if (Math.abs(shift.x) > 0.011 || Math.abs(shift.y) > 0.011) l = transformLink(link, { dx: shift.x, dy: shift.y, dz: 0, angle: 0, cx: 0, cy: 0 });
    const hit = cache.get(l.linkId);
    const copies = hit && hit.source === source && hit.link === l ? hit.copies : makeCopies(source, l, l.linkId);
    cache.set(l.linkId, { source, link: l, copies });
    kept.push(l);
    derived.push(...copies);
  }
  const loose = bodies.filter((b) => b.repeatOf && !followed.has(b.repeatOf)).map((b) => ({ ...b, repeatOf: undefined }));
  return { bodies: [...base, ...loose, ...derived], repeats: kept };
}

/** Switches a path repeat to going round a circle, keeping about the same gap between copies. */
export function toAround(s: RepeatSession): RepeatSession {
  const r = Math.max(10, (spacing(s) * s.count) / (2 * Math.PI));
  return { ...s, kind: 'around', bend: null, end: { x: s.start.x, y: round2(s.start.y + r) } };
}

/** Switches back to a straight path along +X with the same gap. */
export function toPath(s: RepeatSession): RepeatSession {
  const gap = spacing(s);
  return { ...s, kind: 'path', bend: null, end: { x: round2(s.start.x + gap * (s.count - 1)), y: s.start.y } };
}

/** Changes how many copies there are, keeping the gap (a path grows or shrinks; a circle just re-divides). */
export function withCount(s: RepeatSession, count: number): RepeatSession {
  const n = Math.max(2, Math.min(MAX_COPIES, Math.round(count)));
  if (s.kind === 'around') return { ...s, count: n };
  const gap = spacing(s);
  return withSpacing({ ...s, count: n }, gap);
}

export const MAX_COPIES = 60;
