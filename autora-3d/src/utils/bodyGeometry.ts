/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { Brush, Evaluator, SUBTRACTION } from 'three-bvh-csg';
import { toCreasedNormals } from 'three/examples/jsm/utils/BufferGeometryUtils.js';
import { BevelStyle, Body3D, Point2D } from '../types';
import { cleanPolygonPoints, ensureWinding } from './geometry';
import { getOutline, outwardNormal, runId, runPath, sideRun } from './outline';
import { loopFor, runLimit } from './edges';
import { HEAL, healTriangles, weldVertices } from './meshHeal';
import { manifoldReady, subtractAll } from './manifoldBoolean';
import { buildCornerCutter } from './cornerBevel';

const toPath = <T extends THREE.Path>(path: T, pts: { x: number; y: number }[]): T => {
  path.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) path.lineTo(pts[i].x, pts[i].y);
  path.closePath();
  return path;
};

/** The 2D outline (with holes) of a body as a three.js Shape, or null if degenerate. */
export function buildBodyShape(body: Body3D): THREE.Shape | null {
  const cleaned = cleanPolygonPoints(body.points);
  if (cleaned.length < 3) return null;
  const shape = toPath(new THREE.Shape(), ensureWinding(cleaned, false));
  for (const rawHole of body.holes ?? []) {
    const hole = cleanPolygonPoints(rawHole);
    if (hole.length >= 3) shape.holes.push(toPath(new THREE.Path(), ensureWinding(hole, true)));
  }
  return shape;
}

// ---------------------------------------------------------------------------
// Bevel cutters
// ---------------------------------------------------------------------------

const ARC_STEPS = 12;

/**
 * Used only when the exact engine (Manifold) is not running. A cutter whose surface runs tangent to, or has an edge lying
 * in, a face of the body is the one thing a triangle-mesh boolean cannot do cleanly (hair-thin slivers along the whole edge),
 * so the profile is nudged by this much to cross the body's faces at a small angle: far below anything a printer can show.
 */
const nudge = () => (manifoldReady() ? 0 : 0.02);

/** Cross-section (h = outward, v = up) of the material a bevel removes at a top edge. */
function bevelProfile(size: number, style: BevelStyle): THREE.Vector2[] {
  const e = size + 1;
  const pts: THREE.Vector2[] = [];
  if (style === 'round') {
    // The arc, with its centre a hair out and up: it then meets the top and the wall at a slight angle, not tangent.
    for (let k = 0; k <= ARC_STEPS; k++) {
      const t = (k / ARC_STEPS) * (Math.PI / 2);
      pts.push(new THREE.Vector2(-size + nudge() + size * Math.sin(t), -size + nudge() + size * Math.cos(t)));
    }
    pts.push(new THREE.Vector2(e, -size + nudge()));
  } else {
    // The flat bevel's line, run a hair past both ends so no corner of the cutter sits in the top or the wall.
    pts.push(new THREE.Vector2(-size - nudge(), nudge()), new THREE.Vector2(nudge(), -size - nudge()));
    pts.push(new THREE.Vector2(e, -size - nudge()));
  }
  pts.push(new THREE.Vector2(e, e), new THREE.Vector2(-size - nudge(), e));
  return pts;
}

const signedVolume = (pos: number[], idx: number[]) => {
  let v = 0;
  for (let i = 0; i < idx.length; i += 3) {
    const a = idx[i] * 3;
    const b = idx[i + 1] * 3;
    const c = idx[i + 2] * 3;
    v +=
      (pos[a] * (pos[b + 1] * pos[c + 2] - pos[b + 2] * pos[c + 1]) -
        pos[a + 1] * (pos[b] * pos[c + 2] - pos[b + 2] * pos[c]) +
        pos[a + 2] * (pos[b] * pos[c + 1] - pos[b + 1] * pos[c])) /
      6;
  }
  return v;
};

/**
 * Sweeps the bevel profile along an edge path to make a closed solid that, subtracted
 * from the body, leaves a chamfer or round. Mitred at the joints between path segments.
 */
export function buildBevelCutter(
  path: Point2D[],
  closed: boolean,
  winding: 1 | -1,
  side: 'top' | 'bottom',
  size: number,
  style: BevelStyle,
  planeY: number,
  /** Outward normals of the walls an open path runs into, at its start and end. */
  ends?: { start?: Point2D; end?: Point2D }
): THREE.BufferGeometry | null {
  // Drop repeated points (closed paths repeat the first point at the end).
  const pts: Point2D[] = [];
  path.forEach((p) => {
    const last = pts[pts.length - 1];
    if (!last || Math.hypot(p.x - last.x, p.y - last.y) > 0.01) pts.push(p);
  });
  if (closed && pts.length > 1 && Math.hypot(pts[0].x - pts[pts.length - 1].x, pts[0].y - pts[pts.length - 1].y) < 0.01) {
    pts.pop();
  }
  const m = pts.length;
  if (m < 2 || (closed && m < 3)) return null;

  const segCount = closed ? m : m - 1;
  const segNormal = (k: number) => outwardNormal(pts[k % m], pts[(k + 1) % m], winding);

  // Per-station outward direction, scaled so the offset stays `h` from the edge at a mitre.
  const stations = pts.map((_, i) => {
    const prev = closed ? segNormal((i - 1 + m) % m) : i > 0 ? segNormal(i - 1) : null;
    const next = closed ? segNormal(i) : i < segCount ? segNormal(i) : null;
    const a = prev ?? next!;
    const b = next ?? prev!;
    let nx = a.x + b.x;
    let ny = a.y + b.y;
    const len = Math.hypot(nx, ny);
    if (len < 1e-6) {
      nx = a.x;
      ny = a.y;
    } else {
      nx /= len;
      ny /= len;
    }
    const scale = 1 / Math.max(0.4, nx * a.x + ny * a.y);
    return { nx, ny, scale };
  });

  const profile = bevelProfile(size, style).map((v) => (side === 'top' ? v : new THREE.Vector2(v.x, -v.y)));
  const P = profile.length;
  const positions: number[] = [];
  // An open end that meets an outside corner is mitred onto the neighbouring wall and pushed just past it: a cap
  // lying exactly in that wall's plane leaves slivers of the wall standing after the boolean cut.
  const endCap = (i: number, wall: Point2D | undefined) => {
    if (closed || !wall || (i !== 0 && i !== m - 1)) return null;
    const from = pts[i === 0 ? 1 : m - 2];
    const len = Math.hypot(pts[i].x - from.x, pts[i].y - from.y) || 1;
    const d = { x: (pts[i].x - from.x) / len, y: (pts[i].y - from.y) / len };
    const dn = d.x * wall.x + d.y * wall.y;
    return dn > 0.2 ? { d, dn, wall } : null;
  };
  const caps = [endCap(0, ends?.start), endCap(m - 1, ends?.end)];
  const PAST = 0.5;
  stations.forEach((st, i) => {
    const cap = i === 0 ? caps[0] : i === m - 1 ? caps[1] : null;
    profile.forEach((q) => {
      let x = pts[i].x + st.nx * q.x * st.scale;
      let y = pts[i].y + st.ny * q.x * st.scale;
      if (cap) {
        const t = (PAST - ((x - pts[i].x) * cap.wall.x + (y - pts[i].y) * cap.wall.y)) / cap.dn;
        x += cap.d.x * t;
        y += cap.d.y * t;
      }
      positions.push(x, planeY + q.y, -y);
    });
  });

  const index: number[] = [];
  for (let i = 0; i < segCount; i++) {
    const i2 = (i + 1) % m;
    for (let k = 0; k < P; k++) {
      const k2 = (k + 1) % P;
      const A = i * P + k;
      const B = i * P + k2;
      const C = i2 * P + k2;
      const D = i2 * P + k;
      index.push(A, B, C, A, C, D);
    }
  }

  if (!closed) {
    const faces = THREE.ShapeUtils.triangulateShape(profile.map((v) => v.clone()), []);
    const polyArea = THREE.ShapeUtils.area(profile);
    const triArea = (f: number[]) => {
      const [a, b, c] = f.map((i) => profile[i]);
      return ((b.x - a.x) * (c.y - a.y) - (c.x - a.x) * (b.y - a.y)) / 2;
    };
    faces.forEach((f) => {
      const sameAsPolygon = Math.sign(triArea(f)) === Math.sign(polyArea);
      const [a, b, c] = f;
      // End cap follows the polygon's order, start cap runs against it.
      if (sameAsPolygon) {
        index.push((m - 1) * P + a, (m - 1) * P + b, (m - 1) * P + c);
        index.push(a, c, b);
      } else {
        index.push((m - 1) * P + a, (m - 1) * P + c, (m - 1) * P + b);
        index.push(a, b, c);
      }
    });
  }

  if (signedVolume(positions, index) < 0) {
    for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];
  }

  const geometry = new THREE.BufferGeometry();
  geometry.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  geometry.setIndex(index);
  geometry.computeVertexNormals();
  return geometry;
}

const asBrush = (geometry: THREE.BufferGeometry) => {
  const g = geometry.index ? geometry.clone() : geometry.clone();
  g.clearGroups();
  g.deleteAttribute('uv');
  if (!g.index) {
    const count = g.attributes.position.count;
    g.setIndex(Array.from({ length: count }, (_, i) => i));
  }
  if (!g.attributes.normal) g.computeVertexNormals();
  const brush = new Brush(g);
  brush.updateMatrixWorld(true);
  return brush;
};

interface ResolvedBevel {
  side: 'top' | 'bottom';
  size: number;
  style: BevelStyle;
  path: Point2D[];
  closed: boolean;
  ends: { start?: Point2D; end?: Point2D };
  /** Overrides the outline's winding (a hole's material is on the other side of its loop). */
  winding?: 1 | -1;
  /** Which loop of the outline (the outer edge, or one of the holes) the path runs along. */
  loop: number;
  /** The size that was asked for, before limits: bevels only join up when they were asked for alike. */
  requested: number;
}

const samePoint = (a: Point2D, b: Point2D) => Math.hypot(a.x - b.x, a.y - b.y) < 0.02;

/**
 * Edges that were beveled alike and meet at a corner become ONE cutter running round that corner, instead of one
 * cutter per edge. Separate cutters overlap at the corner, and the boolean cut there leaves cracks and doubled faces
 * (a rim of four edges was not watertight, which shows as dark specks and fails in a slicer). One mitred cutter is clean.
 */
function joinBevelRuns(list: ResolvedBevel[]): ResolvedBevel[] {
  const groups = new Map<string, ResolvedBevel[]>();
  for (const r of list) {
    const key = `${r.loop}|${r.side}|${r.style}|${r.requested}`;
    groups.set(key, [...(groups.get(key) ?? []), r]);
  }
  const out: ResolvedBevel[] = [];
  groups.forEach((group) => {
    out.push(...group.filter((r) => r.closed));
    const open = group.filter((r) => !r.closed);
    const used = new Set<ResolvedBevel>();
    for (const first of open) {
      if (used.has(first)) continue;
      used.add(first);
      const chain = [first];
      let tail = first;
      for (;;) {
        const next = open.find((o) => !used.has(o) && samePoint(o.path[0], tail.path[tail.path.length - 1]));
        if (!next) break;
        used.add(next);
        chain.push(next);
        tail = next;
      }
      let head = first;
      for (;;) {
        const prev = open.find((o) => !used.has(o) && samePoint(o.path[o.path.length - 1], head.path[0]));
        if (!prev) break;
        used.add(prev);
        chain.unshift(prev);
        head = prev;
      }
      if (chain.length === 1) {
        out.push(first);
        continue;
      }
      const path: Point2D[] = [];
      chain.forEach((c, i) => path.push(...(i === 0 ? c.path : c.path.slice(1))));
      const closed = samePoint(path[0], path[path.length - 1]);
      if (closed) path.pop();
      out.push({
        ...first,
        size: Math.min(...chain.map((c) => c.size)),
        path,
        closed,
        ends: closed ? {} : { start: chain[0].ends.start, end: chain[chain.length - 1].ends.end },
      });
    }
  });
  return out;
}

function resolveBevels(body: Body3D): ResolvedBevel[] {
  const height = Math.max(1, body.extrusionHeight);
  const done = new Set<string>();
  const out: ResolvedBevel[] = [];

  // Later entries win when two bevels end up on the same run.
  for (const bevel of [...(body.edgeBevels ?? [])].reverse()) {
    const found = bevel.size > 0 && bevel.edge >= 0 ? loopFor(body, bevel.edge) : null;
    if (!found) continue;
    const { loop, local } = found;
    const { outline, offset, away } = loop;
    const n = loop.base.length;
    if (local >= n) continue;
    const run = sideRun(outline, n, local);
    const key = `${bevel.side}:${offset + runId(run)}`;
    if (done.has(key)) continue;
    done.add(key);

    const size = Math.min(bevel.size, runLimit(height, outline, run, n, offset));
    if (size < 0.1) continue;

    const { pts, closed } = runPath(outline, run, n);
    const ends: { start?: Point2D; end?: Point2D } = {};
    if (!closed) {
      const m = outline.points.length;
      const first = outline.points.indexOf(pts[0]);
      const last = outline.points.indexOf(pts[pts.length - 1]);
      if (first >= 0) ends.start = outwardNormal(outline.points[(first - 1 + m) % m], pts[0], away);
      if (last >= 0) ends.end = outwardNormal(pts[pts.length - 1], outline.points[(last + 1) % m], away);
    }
    out.push({ side: bevel.side, size, style: bevel.style, path: pts, closed, ends, winding: away, loop: offset, requested: bevel.size });
  }
  return joinBevelRuns(out);
}

/**
 * Solid geometry for a body, Y-up, underside at `elevation`, top at elevation + height.
 * Only edges listed in `edgeBevels` are beveled. `fast` skips the bevel cuts, for live previews while dragging.
 */
export function buildBodyGeometry(body: Body3D, options: { fast?: boolean } = {}): THREE.BufferGeometry | null {
  const shape = buildBodyShape(body);
  if (!shape) return null;

  const height = Math.max(1, body.extrusionHeight || 20);
  let geometry: THREE.BufferGeometry;
  try {
    geometry = new THREE.ExtrudeGeometry(shape, { depth: height, bevelEnabled: false, curveSegments: 12 });
  } catch (err) {
    console.error(`Could not extrude "${body.name}"`, err);
    return null;
  }
  geometry.rotateX(-Math.PI / 2);

  let cutIsExact = false;
  const bevels = !options.fast && body.edgeBevels?.length ? resolveBevels(body) : [];
  const cornerCutters = options.fast ? [] : (body.cornerBevels ?? []).map((cb) => buildCornerCutter(body, cb)).filter((g): g is THREE.BufferGeometry => !!g);
  if (bevels.length || cornerCutters.length) {
    const winding = getOutline(body).winding;
    const cutters: THREE.BufferGeometry[] = [];
    for (const b of bevels) {
      const cutter = buildBevelCutter(b.path, b.closed, b.winding ?? winding, b.side, b.size, b.style, b.side === 'top' ? height : 0, b.ends);
      if (cutter) cutters.push(cutter);
    }
    for (const cutter of cornerCutters) {
      // Cutters are built in world height; the body is extruded from zero.
      cutter.translate(0, -(body.elevation ?? 0), 0);
      cutters.push(cutter);
    }
    // First choice: Manifold, which always returns a closed solid. If it is not started (or an input is not a clean solid)
    // fall back to the triangle-mesh cut, whose result is tidied afterwards.
    const exact = subtractAll(geometry, cutters);
    if (exact) {
      geometry.dispose();
      geometry = exact;
      cutIsExact = true;
    } else {
      try {
        const evaluator = new Evaluator();
        evaluator.attributes = ['position', 'normal'];
        evaluator.useGroups = false;
        let result = asBrush(geometry);
        for (const cutter of cutters) result = evaluator.evaluate(result, asBrush(cutter), SUBTRACTION);
        geometry.dispose();
        geometry = result.geometry;
      } catch (err) {
        console.error(`Bevel failed on "${body.name}"; showing it without bevels`, err);
      }
    }
  }

  geometry.deleteAttribute('uv');
  const crease = THREE.MathUtils.degToRad(32);
  // Boolean cuts leave slivers and T-junctions behind: cleanMesh drops the one and closes the other.
  const smooth = bevels.length || cornerCutters.length ? cleanMesh(geometry, crease, cutIsExact) : toCreasedNormals(geometry, crease);
  if (smooth !== geometry) geometry.dispose();
  smooth.translate(0, body.elevation ?? 0, 0);
  return smooth;
}
/**
 * Tidies a boolean result for shading: welds coincident vertices, drops zero-area triangles (their normals come out
 * blank and render black), and splits triangles where another triangle's vertex sits on their edge, so the surface
 * has no hairline cracks for the background to show through. Returns it with creased normals.
 */
export function cleanMesh(source: THREE.BufferGeometry, creaseAngle: number, exact = false): THREE.BufferGeometry {
  const pos = source.getAttribute('position');
  const idx = source.getIndex();
  const count = idx ? idx.count : pos.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();

  // Weld what is meant to be one vertex (by distance, not by rounding, so two points a hair apart on either side of a
  // rounding boundary are still joined), then heal what a boolean cut leaves: slivers, doubled faces, T-junctions, hairline cracks.
  const corners: number[] = [];
  for (let t = 0; t + 2 < count; t += 3) {
    for (let k = 0; k < 3; k++) {
      const i = idx ? idx.getX(t + k) : t + k;
      corners.push(pos.getX(i), pos.getY(i), pos.getZ(i));
    }
  }
  const welded = weldVertices(corners, exact ? 1e-5 : HEAL.weld);
  const coords = welded.coords;
  const soup: number[][] = [];
  for (let t = 0; t + 2 < welded.ids.length; t += 3) {
    const [i, j, k] = [welded.ids[t], welded.ids[t + 1], welded.ids[t + 2]];
    // Welding can fold a sliver onto a line: a triangle with two corners at one point has no area and no place in a solid.
    if (i !== j && j !== k && k !== i) soup.push([i, j, k]);
  }
  // An exact cut is already a closed solid: only a cut made on triangles needs healing.
  const kept = exact ? soup : healTriangles(coords, soup);

  // Creased normals weighted by each triangle's corner angle, so how a surface happens to be cut into triangles
  // does not show (a plain average leans toward whichever side has more slivers and the curve looks banded).
  const faceNormal = kept.map(([i, j, k]) => {
    a.fromArray(coords, i * 3);
    b.fromArray(coords, j * 3).sub(a);
    c.fromArray(coords, k * 3).sub(a);
    return b.clone().cross(c).normalize();
  });
  const cornerAngle = (i: number, j: number, k: number) => {
    a.fromArray(coords, i * 3);
    b.fromArray(coords, j * 3).sub(a);
    c.fromArray(coords, k * 3).sub(a);
    return b.angleTo(c);
  };
  // Cuts also leave near-twins a hair apart where a cutter's diagonal crosses a wall; shade them as one point.
  const root = Array.from({ length: coords.length / 3 }, (_, i) => i);
  const find = (i: number): number => (root[i] === i ? i : (root[i] = find(root[i])));
  const TWIN = 0.05;
  const twinGrid = new Map<string, number[]>();
  const tk = (x: number, y: number, z: number) => `${x},${y},${z}`;
  for (let i = 0; i < coords.length / 3; i++) {
    const [x, y, z] = [coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]];
    const [cx, cy, cz] = [Math.floor(x / TWIN), Math.floor(y / TWIN), Math.floor(z / TWIN)];
    for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of twinGrid.get(tk(cx + dx, cy + dy, cz + dz)) ?? []) {
            if (Math.hypot(coords[j * 3] - x, coords[j * 3 + 1] - y, coords[j * 3 + 2] - z) < TWIN) root[find(j)] = find(i);
          }
    const list = twinGrid.get(tk(cx, cy, cz));
    if (list) list.push(i);
    else twinGrid.set(tk(cx, cy, cz), [i]);
  }
  const around = new Map<number, { f: number; w: number }[]>();
  kept.forEach((t, f) =>
    t.forEach((id, k) => {
      const w = cornerAngle(id, t[(k + 1) % 3], t[(k + 2) % 3]);
      const list = around.get(find(id));
      if (list) list.push({ f, w });
      else around.set(find(id), [{ f, w }]);
    })
  );
  const creaseCos = Math.cos(creaseAngle);
  const positions = new Float32Array(kept.length * 9);
  const normals = new Float32Array(kept.length * 9);
  const sum = new THREE.Vector3();
  kept.forEach((t, f) =>
    t.forEach((id, k) => {
      sum.set(0, 0, 0);
      for (const { f: g, w } of around.get(find(id))!) {
        if (faceNormal[g].dot(faceNormal[f]) > creaseCos) sum.addScaledVector(faceNormal[g], w);
      }
      if (sum.lengthSq() < 1e-12) sum.copy(faceNormal[f]);
      sum.normalize();
      const o = f * 9 + k * 3;
      positions.set([coords[id * 3], coords[id * 3 + 1], coords[id * 3 + 2]], o);
      normals.set([sum.x, sum.y, sum.z], o);
    })
  );
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.BufferAttribute(positions, 3));
  g.setAttribute('normal', new THREE.BufferAttribute(normals, 3));
  return g;
}

const edgesOf = (ring: { x: number; y: number }[]) =>
  ring.map((p, i) => [p, ring[(i + 1) % ring.length]] as const);

/**
 * A point guaranteed to lie on the body's top face (unlike the vertex average,
 * which falls in the notch of a concave outline). Scans at the centroid height
 * and picks the middle of the widest interior span.
 */
export function getInteriorAnchor(body: Body3D): { x: number; y: number } {
  const pts = body.points;
  const n = pts.length;
  const avg = {
    x: pts.reduce((a, p) => a + p.x, 0) / n,
    y: pts.reduce((a, p) => a + p.y, 0) / n,
  };
  const rings = [pts, ...(body.holes ?? [])];

  const widestSpanAt = (y: number) => {
    const xs: number[] = [];
    for (const ring of rings) {
      for (const [a, b] of edgesOf(ring)) {
        if ((a.y <= y && b.y > y) || (b.y <= y && a.y > y)) {
          xs.push(a.x + ((y - a.y) / (b.y - a.y)) * (b.x - a.x));
        }
      }
    }
    xs.sort((p, q) => p - q);
    let best: { x: number; width: number } | null = null;
    for (let i = 0; i + 1 < xs.length; i += 2) {
      const width = xs[i + 1] - xs[i];
      if (!best || width > best.width) best = { x: (xs[i] + xs[i + 1]) / 2, width };
    }
    return best;
  };

  const minY = Math.min(...pts.map((p) => p.y));
  const maxY = Math.max(...pts.map((p) => p.y));
  // Try the centroid height first, then fan out; offsets avoid hitting vertices exactly.
  for (const t of [0.5, 0.4, 0.6, 0.3, 0.7, 0.2, 0.8]) {
    const y = t === 0.5 ? avg.y + 0.01 : minY + (maxY - minY) * t + 0.01;
    const span = widestSpanAt(y);
    if (span && span.width > 1) return { x: span.x, y };
  }
  return avg;
}


/**
 * Feature edges of a mesh for the selection outline: the lines where two faces meet at more than `angleDeg`.
 * Unlike THREE.EdgesGeometry this heals T-junctions (a long edge facing two short ones, which boolean cuts leave
 * behind) so flat faces do not get stray diagonal lines drawn across them.
 */
export function featureEdges(source: THREE.BufferGeometry, angleDeg: number): THREE.BufferGeometry {
  const pos = source.getAttribute('position');
  const idx = source.getIndex();
  const triCount = (idx ? idx.count : pos.count) / 3;
  const Q = 1000;
  const keyOf = (x: number, y: number, z: number) => `${Math.round(x * Q)},${Math.round(y * Q)},${Math.round(z * Q)}`;

  const vertexId = new Map<string, number>();
  const coords: number[] = [];
  const weld = (i: number) => {
    const x = pos.getX(i);
    const y = pos.getY(i);
    const z = pos.getZ(i);
    const k = keyOf(x, y, z);
    let id = vertexId.get(k);
    if (id === undefined) {
      id = coords.length / 3;
      vertexId.set(k, id);
      coords.push(x, y, z);
    }
    return id;
  };

  type Half = { u: number; v: number; n: THREE.Vector3 };
  const edgeMap = new Map<string, Half[]>();
  const add = (u: number, v: number, n: THREE.Vector3) => {
    if (u === v) return;
    const k = u < v ? `${u}_${v}` : `${v}_${u}`;
    const list = edgeMap.get(k);
    if (list) list.push({ u, v, n });
    else edgeMap.set(k, [{ u, v, n }]);
  };

  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  for (let t = 0; t < triCount; t++) {
    const ids = [0, 1, 2].map((k) => weld(idx ? idx.getX(t * 3 + k) : t * 3 + k));
    a.fromArray(coords, ids[0] * 3);
    b.fromArray(coords, ids[1] * 3);
    c.fromArray(coords, ids[2] * 3);
    const n = new THREE.Vector3().subVectors(c, b).cross(new THREE.Vector3().subVectors(a, b));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    add(ids[0], ids[1], n);
    add(ids[1], ids[2], n);
    add(ids[2], ids[0], n);
  }

  // Split edges that have vertices of other triangles sitting on them, so both sides line up.
  const cell = 8;
  const grid = new Map<string, number[]>();
  const cellKey = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < coords.length / 3; i++) {
    const k = cellKey(coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  const pieces: { u: number; v: number; n: THREE.Vector3 }[] = [];
  const done: Half[][] = [];
  edgeMap.forEach((list) => {
    if (list.length !== 1) {
      done.push(list);
      return;
    }
    const { u, v, n } = list[0];
    a.fromArray(coords, u * 3);
    b.fromArray(coords, v * 3);
    const dir = new THREE.Vector3().subVectors(b, a);
    const len2 = dir.lengthSq();
    const on: { id: number; t: number }[] = [];
    const lo = [Math.min(a.x, b.x), Math.min(a.y, b.y), Math.min(a.z, b.z)];
    const hi = [Math.max(a.x, b.x), Math.max(a.y, b.y), Math.max(a.z, b.z)];
    for (let cx = Math.floor(lo[0] / cell); cx <= Math.floor(hi[0] / cell); cx++)
      for (let cy = Math.floor(lo[1] / cell); cy <= Math.floor(hi[1] / cell); cy++)
        for (let cz = Math.floor(lo[2] / cell); cz <= Math.floor(hi[2] / cell); cz++) {
          for (const w of grid.get(`${cx},${cy},${cz}`) ?? []) {
            if (w === u || w === v) continue;
            c.fromArray(coords, w * 3);
            const t = new THREE.Vector3().subVectors(c, a).dot(dir) / len2;
            if (t <= 1e-4 || t >= 1 - 1e-4) continue;
            const closest = a.clone().addScaledVector(dir, t);
            if (closest.distanceToSquared(c) < 4e-6) on.push({ id: w, t });
          }
        }
    on.sort((p, q) => p.t - q.t);
    let prev = u;
    for (const o of on) {
      pieces.push({ u: prev, v: o.id, n });
      prev = o.id;
    }
    pieces.push({ u: prev, v, n });
  });
  const second = new Map<string, Half[]>();
  const push = (h: Half) => {
    const k = h.u < h.v ? `${h.u}_${h.v}` : `${h.v}_${h.u}`;
    const list = second.get(k);
    if (list) list.push(h);
    else second.set(k, [h]);
  };
  done.forEach((l) => l.forEach(push));
  pieces.forEach(push);

  const cos = Math.cos(THREE.MathUtils.degToRad(angleDeg));
  const out: number[] = [];
  second.forEach((list) => {
    if (list.length !== 2) return;
    if (list[0].n.dot(list[1].n) > cos) return; // nearly flat: not a feature
    out.push(coords[list[0].u * 3], coords[list[0].u * 3 + 1], coords[list[0].u * 3 + 2], coords[list[0].v * 3], coords[list[0].v * 3 + 1], coords[list[0].v * 3 + 2]);
  });
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
}
