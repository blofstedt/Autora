/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, Point2D } from '../types';
import { mergeShapes } from './geometry';

type Footprint = { points: Point2D[]; holes: Point2D[][] };

const round2 = (n: number) => Math.round(n * 100) / 100;
const sig = (fp: Footprint[]) =>
  JSON.stringify(
    fp
      .map((f) => [f.points.map((p) => [round2(p.x), round2(p.y)]), f.holes.map((h) => h.map((p) => [round2(p.x), round2(p.y)]))])
      .map((s) => JSON.stringify(s))
      .sort()
  );

/**
 * Sticks shapes together so the result looks like one solid: wherever shapes overlap or touch their outlines
 * are united, and every shape keeps its own height and elevation. A tall shape next to a short one stays tall
 * where it is tall. Stacks with the same outline become a single taller shape. When the result needs more than
 * one extrusion (steps, or parts that do not touch) it comes back as several bodies for the caller to group.
 */
export function joinBodies(targets: Body3D[], stamp: number | string): Body3D[] {
  if (targets.length < 2) return targets;
  const first = targets[0];
  const levels = [...new Set(targets.flatMap((b) => [round2(b.elevation ?? 0), round2((b.elevation ?? 0) + b.extrusionHeight)]))].sort((a, b) => a - b);

  type Slab = { lo: number; hi: number; footprint: Footprint[]; signature: string };
  const slabs: Slab[] = [];
  for (let i = 0; i + 1 < levels.length; i++) {
    const lo = levels[i];
    const hi = levels[i + 1];
    const active = targets.filter((b) => round2(b.elevation ?? 0) <= lo && round2((b.elevation ?? 0) + b.extrusionHeight) >= hi);
    if (!active.length) continue;
    const footprint = mergeShapes(active.map((b) => ({ points: b.points, holes: b.holes })));
    const signature = sig(footprint);
    const prev = slabs[slabs.length - 1];
    if (prev && prev.hi === lo && prev.signature === signature) prev.hi = hi; // same outline directly above: one taller shape
    else slabs.push({ lo, hi, footprint, signature });
  }

  const out: Body3D[] = [];
  slabs.forEach((slab, si) => {
    slab.footprint.forEach((fp) => {
      const n = out.length;
      out.push({
        ...first,
        id: `body_join_${stamp}_${n}`,
        name: n === 0 ? first.name : `${first.name} (part ${n + 1})`,
        points: fp.points,
        basePoints: fp.points,
        cornerRadii: undefined,
        edgeBevels: undefined,
        cornerBevels: undefined,
        holes: fp.holes,
        elevation: slab.lo,
        extrusionHeight: slab.hi - slab.lo,
        groupId: undefined,
      });
    });
    void si;
  });
  return out;
}
