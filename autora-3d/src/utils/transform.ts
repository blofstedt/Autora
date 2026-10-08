/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, Point2D } from '../types';
import { moveFrame } from './frame';
import { holeLoops, withHoles, withOutline } from './outline';

export interface BodyTransform {
  dx: number;
  dy: number;
  dz: number;
  /** Radians, counter-clockwise seen from above, about (cx, cy). */
  angle: number;
  cx: number;
  cy: number;
}

const round2 = (n: number) => Math.round(n * 100) / 100;

/** Rigid move/rotate of a body. Edge bevels and corner radii are index-based, so they carry over unchanged. */
export function transformBody(body: Body3D, t: BodyTransform): Partial<Body3D> {
  // A shape standing on a wall keeps its outline; it is the wall frame that travels.
  if (body.frame) return { frame: moveFrame(body.frame, t) };
  const cos = Math.cos(t.angle);
  const sin = Math.sin(t.angle);
  const move = (p: Point2D): Point2D => {
    const rx = p.x - t.cx;
    const ry = p.y - t.cy;
    return {
      x: round2(t.cx + rx * cos - ry * sin + t.dx),
      y: round2(t.cy + rx * sin + ry * cos + t.dy),
    };
  };
  return {
    points: body.points.map(move),
    basePoints: body.basePoints?.map(move),
    holes: body.holes?.map((h) => h.map(move)),
    holeBases: body.holeBases?.map((h) => h.map(move)),
    elevation: Math.max(0, round2((body.elevation ?? 0) + t.dz)),
  };
}

export interface SelectionBounds {
  minX: number;
  maxX: number;
  minY: number;
  maxY: number;
  centerX: number;
  centerY: number;
  minElevation: number;
  maxTop: number;
}

export function selectionBounds(bodies: Body3D[]): SelectionBounds | null {
  if (bodies.length === 0) return null;
  let minX = Infinity;
  let maxX = -Infinity;
  let minY = Infinity;
  let maxY = -Infinity;
  let minElevation = Infinity;
  let maxTop = -Infinity;
  bodies.forEach((b) => {
    b.points.forEach((p) => {
      minX = Math.min(minX, p.x);
      maxX = Math.max(maxX, p.x);
      minY = Math.min(minY, p.y);
      maxY = Math.max(maxY, p.y);
    });
    minElevation = Math.min(minElevation, b.elevation ?? 0);
    maxTop = Math.max(maxTop, (b.elevation ?? 0) + b.extrusionHeight);
  });
  return { minX, maxX, minY, maxY, centerX: (minX + maxX) / 2, centerY: (minY + maxY) / 2, minElevation, maxTop };
}

/** Scales a body's footprint by (sx, sy) about the point (ax, ay), keeping corner radii and bevel indices valid. */
export function scaleBodyAbout(body: Body3D, ax: number, ay: number, sx: number, sy: number): Partial<Body3D> {
  const scale = (p: Point2D): Point2D => ({
    x: round2(ax + (p.x - ax) * sx),
    y: round2(ay + (p.y - ay) * sy),
  });
  const base = (body.basePoints ?? body.points).map(scale);
  return {
    ...withOutline(body, { basePoints: base }),
    ...(body.holeBases ? withHoles(body, { holeBases: holeLoops(body).map((l) => l.base.map(scale)) }) : { holes: body.holes?.map((h) => h.map(scale)) }),
  };
}

/** Resizes a body's footprint about its centre, keeping corner radii and bevel indices valid. */
export function resizeBody(body: Body3D, width: number, depth: number): Partial<Body3D> {
  const b = selectionBounds([body]);
  if (!b) return {};
  const w = Math.max(1, b.maxX - b.minX);
  const d = Math.max(1, b.maxY - b.minY);
  return scaleBodyAbout(body, b.centerX, b.centerY, Math.max(1, width) / w, Math.max(1, depth) / d);
}
