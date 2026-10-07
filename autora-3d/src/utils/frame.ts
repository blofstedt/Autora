/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { Frame, Point2D } from '../types';

/** Direction a wall shape grows in, in scene coordinates (plan y is scene -z). */
export const frameNormal = (f: Pick<Frame, 'angle'>) => new THREE.Vector3(Math.cos(f.angle), 0, -Math.sin(f.angle));

/**
 * Local → scene. A wall shape is built like any other (x, up, -y); this stands it on its wall:
 * local x runs along the wall (to the right as you face it), local up points out of the wall, local -y points down the wall.
 */
export function frameMatrix(f: Frame): THREE.Matrix4 {
  const n = frameNormal(f);
  const t = new THREE.Vector3(0, 1, 0).cross(n); // along the wall, to the right when facing it
  const z = new THREE.Vector3(0, -1, 0);
  return new THREE.Matrix4().makeBasis(t, n, z).setPosition(f.x, f.h, -f.y);
}

/** The frame of the wall whose outward direction is `normal` (plan), through the plan point `at`, at the ground. */
export function wallFrame(at: Point2D, normal: Point2D): Frame {
  const len = Math.hypot(normal.x, normal.y) || 1;
  return { x: Math.round(at.x * 100) / 100, y: Math.round(at.y * 100) / 100, h: 0, angle: Math.atan2(normal.y / len, normal.x / len) };
}

/** The same shape, moved and turned by a plan transform (the frame goes with it). */
export function moveFrame(f: Frame, t: { dx: number; dy: number; dz: number; angle: number; cx: number; cy: number }): Frame {
  const cos = Math.cos(t.angle);
  const sin = Math.sin(t.angle);
  const rx = f.x - t.cx;
  const ry = f.y - t.cy;
  const r2 = (n: number) => Math.round(n * 100) / 100;
  return { x: r2(t.cx + rx * cos - ry * sin + t.dx), y: r2(t.cy + rx * sin + ry * cos + t.dy), h: r2(f.h + t.dz), angle: f.angle + t.angle };
}
