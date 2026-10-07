/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, FaceSel, Point2D } from '../types';
import { getBase, holeLocal, holeLoops, holeOf, isHoleIndex, outwardNormal, wallEnds, withHoles, withOutline } from './outline';

export const MIN_HEIGHT = 2;
export const MAX_HEIGHT = 600;

/** The sharp outline a wall belongs to: the shape's own, or one hole's. */
export const wallBase = (body: Body3D, index: number) => (isHoleIndex(index) ? holeLoops(body)[holeOf(index)]?.base ?? [] : getBase(body));

/**
 * Slides one wall along its outward normal (away from the material); positive pushes it out.
 * `from` is the outline to start from, so a drag can be re-applied to where it began.
 */
export function offsetWall(body: Body3D, index: number, dist: number, from?: Point2D[]): Partial<Body3D> | null {
  const ends = wallEnds(body, index);
  if (!ends) return null;
  const n = outwardNormal(ends.a, ends.b, ends.winding);
  const base = (from ?? wallBase(body, index)).map((p) => ({ ...p }));
  const side = isHoleIndex(index) ? holeLocal(index) : index;
  [side, (side + 1) % base.length].forEach((i) => {
    base[i] = { x: Math.round(base[i].x + n.x * dist), y: Math.round(base[i].y + n.y * dist) };
  });
  if (isHoleIndex(index)) {
    const bases = holeLoops(body).map((l) => l.base);
    bases[holeOf(index)] = base;
    return withHoles(body, { holeBases: bases });
  }
  return withOutline(body, { basePoints: base });
}

/** Limits for pulling the bottom face down (negative) or pushing it up (positive) with the top fixed. */
export function bottomRange(body: Body3D): { min: number; max: number } {
  return { min: -(body.elevation ?? 0), max: body.extrusionHeight - MIN_HEIGHT };
}

/** Moves the bottom face by `delta` (negative = down) while the top stays where it is. */
export function moveBottom(body: Body3D, delta: number): Partial<Body3D> {
  const { min, max } = bottomRange(body);
  const d = Math.max(min, Math.min(max, Math.round(delta)));
  return { elevation: (body.elevation ?? 0) + d, extrusionHeight: body.extrusionHeight - d };
}

/** Pulls a face outward by `delta` mm (negative pushes it in). Returns the changes to apply to the body. */
export function extrudeFace(body: Body3D, face: FaceSel, delta: number): Partial<Body3D> | null {
  if (face.kind === 'top') {
    return { extrusionHeight: Math.max(MIN_HEIGHT, Math.min(MAX_HEIGHT, Math.round(body.extrusionHeight + delta))) };
  }
  if (face.kind === 'bottom') return moveBottom(body, -delta);
  return face.index === undefined ? null : offsetWall(body, face.index, delta);
}

export const sameFace = (a: FaceSel | null | undefined, b: FaceSel | null | undefined) =>
  !!a && !!b && a.bodyId === b.bodyId && a.kind === b.kind && a.index === b.index;

/** The one number that describes a face: the shape's height for top and bottom, its size across the wall for a wall. */
export function faceMeasure(body: Body3D, face: FaceSel): { label: string; value: number } | null {
  if (face.kind !== 'wall') return { label: 'Height', value: body.extrusionHeight };
  if (face.index === undefined) return null;
  const ends = wallEnds(body, face.index);
  if (!ends) return null;
  const n = outwardNormal(ends.a, ends.b, ends.winding);
  const ring = isHoleIndex(face.index) ? holeLoops(body)[holeOf(face.index)].outline.points : body.points;
  const d = ring.map((p) => p.x * n.x + p.y * n.y);
  const label = Math.abs(n.x) > 0.7 ? 'Width' : Math.abs(n.y) > 0.7 ? 'Depth' : 'Size';
  return { label, value: Math.max(...d) - Math.min(...d) };
}

/** Changes made by typing a new value for a face's number. */
export function setFaceMeasure(body: Body3D, face: FaceSel, value: number): Partial<Body3D> | null {
  const m = faceMeasure(body, face);
  // Pushing a hole's wall out of the material makes the hole smaller.
  const sign = face.index !== undefined && isHoleIndex(face.index) ? -1 : 1;
  return m ? extrudeFace(body, face, (value - m.value) * sign) : null;
}
