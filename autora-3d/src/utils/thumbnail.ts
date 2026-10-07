/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D, Point2D } from '../types';

/**
 * A small picture of some shapes, as SVG text: an isometric view from the front right, drawn with a painter's
 * algorithm (far shapes first, back walls culled). It needs no GL and no DOM, so an agent can ask for one too.
 * It shows each shape's outline, height and colour; bevels are not drawn.
 */

const SIN = 0.5; // sin(30°): how much depth shows as height on screen
const COS = Math.sqrt(3) / 2;
const R = Math.SQRT1_2;

interface P2 {
  u: number;
  v: number;
}

/** Screen position (u right, v up) of a plan point at height z. The viewer stands at +x, -y, above. */
const project = (p: Point2D, z: number): P2 => ({ u: (p.x + p.y) * R, v: z * COS + (p.y - p.x) * R * SIN });
/** How near a plan point is to the viewer. */
const near = (p: Point2D) => (p.x - p.y) * R;

const shade = (hex: string, k: number) => {
  const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
  const n = m ? parseInt(m[1], 16) : 0x94a3b8;
  const c = [(n >> 16) & 255, (n >> 8) & 255, n & 255].map((v) => Math.max(0, Math.min(255, Math.round(v * k))));
  return `rgb(${c[0]},${c[1]},${c[2]})`;
};

const area = (pts: Point2D[]) => pts.reduce((a, p, i) => a + (p.x * pts[(i + 1) % pts.length].y - pts[(i + 1) % pts.length].x * p.y), 0) / 2;

interface Face {
  pts: P2[];
  fill: string;
  holes?: P2[][];
}

function facesOf(b: Body3D): Face[] {
  const pts = b.points;
  if (pts.length < 3) return [];
  const z0 = b.elevation ?? 0;
  const z1 = z0 + b.extrusionHeight;
  const ccw = area(pts) > 0;
  const walls: { face: Face; depth: number }[] = [];
  for (let i = 0; i < pts.length; i++) {
    const a = pts[i];
    const c = pts[(i + 1) % pts.length];
    const dx = c.x - a.x;
    const dy = c.y - a.y;
    const len = Math.hypot(dx, dy) || 1;
    // Outward normal; only walls turned toward the viewer are drawn.
    const nx = (ccw ? dy : -dy) / len;
    const ny = (ccw ? -dx : dx) / len;
    const facing = (nx - ny) * R;
    if (facing <= 0.01) continue;
    walls.push({
      face: { pts: [project(a, z0), project(c, z0), project(c, z1), project(a, z1)], fill: shade(b.color, 0.55 + 0.3 * facing) },
      depth: near({ x: (a.x + c.x) / 2, y: (a.y + c.y) / 2 }),
    });
  }
  walls.sort((x, y) => x.depth - y.depth);
  return [...walls.map((w) => w.face), { pts: pts.map((p) => project(p, z1)), fill: shade(b.color, 1.08), holes: b.holes?.map((h) => h.map((p) => project(p, z1))) }];
}

/** SVG text for a square picture of `bodies`, `size` px wide. Empty shapes give an empty picture. */
export function thumbnailSvg(bodies: Body3D[], size = 96): string {
  const shown = bodies.filter((b) => b.visible !== false && !b.frame);
  const ordered = [...shown].sort((a, b) => {
    const ca = near({ x: a.points.reduce((s, p) => s + p.x, 0) / a.points.length, y: a.points.reduce((s, p) => s + p.y, 0) / a.points.length });
    const cb = near({ x: b.points.reduce((s, p) => s + p.x, 0) / b.points.length, y: b.points.reduce((s, p) => s + p.y, 0) / b.points.length });
    return ca - cb || (a.elevation ?? 0) - (b.elevation ?? 0);
  });
  const faces = ordered.flatMap(facesOf);
  const all = faces.flatMap((f) => f.pts);
  if (!all.length) return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}"/>`;
  const minU = Math.min(...all.map((p) => p.u));
  const maxU = Math.max(...all.map((p) => p.u));
  const minV = Math.min(...all.map((p) => p.v));
  const maxV = Math.max(...all.map((p) => p.v));
  const pad = size * 0.08;
  const scale = (size - pad * 2) / Math.max(maxU - minU, maxV - minV, 1e-6);
  const ox = (size - (maxU - minU) * scale) / 2;
  const oy = (size - (maxV - minV) * scale) / 2;
  const sx = (p: P2) => `${(ox + (p.u - minU) * scale).toFixed(1)},${(oy + (maxV - p.v) * scale).toFixed(1)}`;
  const d = (ps: P2[]) => `M${ps.map(sx).join('L')}Z`;
  const body = faces.map((f) => `<path d="${d(f.pts)}${(f.holes ?? []).map(d).join('')}" fill="${f.fill}" fill-rule="evenodd" stroke="rgba(0,0,0,0.25)" stroke-width="0.6" stroke-linejoin="round"/>`).join('');
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${size} ${size}" width="${size}" height="${size}">${body}</svg>`;
}

const cache = new WeakMap<object, Map<number, string>>();

/** The same picture as a data URL for an <img>, remembered per object (library objects are replaced when edited, never mutated). */
export function thumbnailUrl(item: { bodies: Body3D[] }, size = 96): string {
  let bySize = cache.get(item);
  if (!bySize) cache.set(item, (bySize = new Map()));
  let url = bySize.get(size);
  if (!url) bySize.set(size, (url = `data:image/svg+xml;utf8,${encodeURIComponent(thumbnailSvg(item.bodies, size))}`));
  return url;
}
