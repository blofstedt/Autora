/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';

/** Tolerances in mm. Exported so they can be tuned against a test grid. */
export const HEAL = { weld: 0.02, tee: 0.02, merge: 0.08 };

/** A triangle soup: `coords` is x,y,z per vertex; each triangle is three vertex ids. */
type Tris = number[][];

const v3 = (coords: number[], i: number) => new THREE.Vector3(coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]);
const key = (u: number, v: number) => (u < v ? `${u}_${v}` : `${v}_${u}`);

/** A spatial index over vertices, for "what is near this point". */
function indexVertices(coords: number[], cell: number) {
  const grid = new Map<string, number[]>();
  const cellKey = (x: number, y: number, z: number) => `${Math.floor(x / cell)},${Math.floor(y / cell)},${Math.floor(z / cell)}`;
  for (let i = 0; i < coords.length / 3; i++) {
    const k = cellKey(coords[i * 3], coords[i * 3 + 1], coords[i * 3 + 2]);
    const list = grid.get(k);
    if (list) list.push(i);
    else grid.set(k, [i]);
  }
  return {
    /** Ids of vertices in the cells overlapping the box around (x,y,z) ± r. */
    near(x: number, y: number, z: number, r: number): number[] {
      const out: number[] = [];
      for (let cx = Math.floor((x - r) / cell); cx <= Math.floor((x + r) / cell); cx++)
        for (let cy = Math.floor((y - r) / cell); cy <= Math.floor((y + r) / cell); cy++)
          for (let cz = Math.floor((z - r) / cell); cz <= Math.floor((z + r) / cell); cz++) out.push(...(grid.get(`${cx},${cy},${cz}`) ?? []));
      return out;
    },
  };
}

const area2 = (coords: number[], t: number[]) => {
  const a = v3(coords, t[0]);
  const b = v3(coords, t[1]).sub(a);
  const c = v3(coords, t[2]).sub(a);
  return b.cross(c).length();
};

/** Triangles that have collapsed to a line or a point. */
const dropDegenerate = (tris: Tris, coords: number[], minArea2 = 1e-6): Tris =>
  tris.filter((t) => t[0] !== t[1] && t[1] !== t[2] && t[2] !== t[0] && area2(coords, t) >= minArea2);

/** Counts how many triangles use each edge. */
function edgeCounts(tris: Tris): Map<string, number> {
  const uses = new Map<string, number>();
  tris.forEach((t) => t.forEach((u, k) => uses.set(key(u, t[(k + 1) % 3]), (uses.get(key(u, t[(k + 1) % 3])) ?? 0) + 1)));
  return uses;
}

/**
 * A triangle whose edge has another triangle's corner sitting on it (a T-junction) leaves a crack: split it so the
 * corner is shared. No new vertices are made, so smooth shading across curved strips stays intact.
 */
function splitTJunctions(tris: Tris, coords: number[]): Tris {
  const uses = edgeCounts(tris);
  // Only a vertex on an open edge of its own can be the corner that this edge is missing.
  const openVertex = new Set<number>();
  tris.forEach((t) =>
    t.forEach((u, k) => {
      if (uses.get(key(u, t[(k + 1) % 3])) === 1) {
        openVertex.add(u);
        openVertex.add(t[(k + 1) % 3]);
      }
    })
  );
  const cell = 8;
  const index = indexVertices(coords, cell);
  const onEdge = (u: number, v: number): number[] => {
    if (uses.get(key(u, v)) !== 1) return [];
    const p = v3(coords, u);
    const q = v3(coords, v);
    const dir = q.clone().sub(p);
    const len2 = dir.lengthSq();
    const found: { id: number; t: number }[] = [];
    const mid = p.clone().add(q).multiplyScalar(0.5);
    const reach = Math.sqrt(len2) / 2 + 0.01;
    for (const id of index.near(mid.x, mid.y, mid.z, reach)) {
      if (id === u || id === v || !openVertex.has(id)) continue;
      const w = v3(coords, id);
      const t = w.clone().sub(p).dot(dir) / len2;
      if (t <= 1e-4 || t >= 1 - 1e-4) continue;
      if (p.clone().addScaledVector(dir, t).distanceToSquared(w) < HEAL.tee * HEAL.tee) found.push({ id, t }); // close enough to the edge to be a corner of it
    }
    return found.sort((m, n) => m.t - n.t).map((f) => f.id);
  };

  const kept: Tris = [];
  const emit = (i: number, j: number, k: number) => {
    if (area2(coords, [i, j, k]) >= 1e-6) kept.push([i, j, k]);
  };
  for (const [p0, p1, p2] of tris) {
    const splits = [onEdge(p0, p1), onEdge(p1, p2), onEdge(p2, p0)];
    const total = splits[0].length + splits[1].length + splits[2].length;
    if (!total) {
      emit(p0, p1, p2);
      continue;
    }
    const corners = [p0, p1, p2];
    const only = splits.filter((s) => s.length).length === 1 ? splits.findIndex((s) => s.length) : -1;
    if (only >= 0) {
      // Fan from the corner facing the split edge.
      const apex = corners[(only + 2) % 3];
      const chain = [corners[only], ...splits[only], corners[(only + 1) % 3]];
      for (let k = 0; k + 1 < chain.length; k++) emit(chain[k], chain[k + 1], apex);
      continue;
    }
    // Several edges split: clip ears off the (convex) outline.
    const ring = [p0, ...splits[0], p1, ...splits[1], p2, ...splits[2]];
    const normal = v3(coords, p1).sub(v3(coords, p0)).cross(v3(coords, p2).sub(v3(coords, p0)));
    const turn = (i: number, j: number, k: number) => v3(coords, j).sub(v3(coords, i)).cross(v3(coords, k).sub(v3(coords, i))).dot(normal);
    for (let guard = 0; ring.length > 3 && guard < 200; guard++) {
      let ear = -1;
      for (let k = 0; k < ring.length; k++) {
        if (turn(ring[(k - 1 + ring.length) % ring.length], ring[k], ring[(k + 1) % ring.length]) > 1e-9) {
          ear = k;
          break;
        }
      }
      if (ear < 0) break;
      emit(ring[(ear - 1 + ring.length) % ring.length], ring[ear], ring[(ear + 1) % ring.length]);
      ring.splice(ear, 1);
    }
    if (ring.length === 3) emit(ring[0], ring[1], ring[2]);
  }
  return kept;
}

/**
 * Where a crack is only a hair wide, its two sides are two vertices a hair apart that were never joined. Snap vertices that
 * sit on the open boundary and are within `tol` of each other into one. Returns whether anything moved.
 */
function mergeBoundaryNeighbours(tris: Tris, coords: number[], tol: number): boolean {
  const uses = edgeCounts(tris);
  const boundary = new Set<number>();
  tris.forEach((t) =>
    t.forEach((u, k) => {
      const v = t[(k + 1) % 3];
      if (uses.get(key(u, v)) === 1) {
        boundary.add(u);
        boundary.add(v);
      }
    })
  );
  if (boundary.size < 2) return false;
  const ids = [...boundary];
  const index = indexVertices(coords, Math.max(tol * 2, 0.05));
  const parent = new Map<number, number>(ids.map((i) => [i, i]));
  const find = (i: number): number => {
    const p = parent.get(i)!;
    if (p === i) return i;
    const r = find(p);
    parent.set(i, r);
    return r;
  };
  let any = false;
  for (const i of ids) {
    const x = coords[i * 3];
    const y = coords[i * 3 + 1];
    const z = coords[i * 3 + 2];
    for (const j of index.near(x, y, z, tol)) {
      if (j <= i || !boundary.has(j)) continue;
      if (Math.hypot(coords[j * 3] - x, coords[j * 3 + 1] - y, coords[j * 3 + 2] - z) <= tol) {
        const a = find(i);
        const b = find(j);
        if (a !== b) {
          parent.set(b, a);
          any = true;
        }
      }
    }
  }
  if (!any) return false;
  const remap = (i: number) => (parent.has(i) ? find(i) : i);
  tris.forEach((t) => {
    t[0] = remap(t[0]);
    t[1] = remap(t[1]);
    t[2] = remap(t[2]);
  });
  return true;
}

/**
 * Two triangles on the same three vertices are the same face twice (keep one), or a face and its back-to-back twin.
 * A twin pair that fills a hole in the surface is kept as the one triangle that fits the neighbours; a pair with nothing
 * around it is an internal wall, no part of the surface, and is removed.
 */
function dropDuplicates(tris: Tris): Tris {
  const groups = new Map<string, number[][]>();
  tris.forEach((t) => {
    const k = [...t].sort((a, b) => a - b).join('_');
    const list = groups.get(k);
    if (list) list.push(t);
    else groups.set(k, [t]);
  });
  const orientation = (t: number[]) => {
    const r = t.indexOf(Math.min(...t));
    return `${t[r]}_${t[(r + 1) % 3]}_${t[(r + 2) % 3]}`;
  };
  // Every directed edge in use, so a triangle can ask whether its neighbours run the opposite way.
  const directed = new Map<string, number>();
  tris.forEach((t) => t.forEach((u, k) => directed.set(`${u}_${t[(k + 1) % 3]}`, (directed.get(`${u}_${t[(k + 1) % 3]}`) ?? 0) + 1)));
  const out: Tris = [];
  groups.forEach((group) => {
    const byOrientation = new Map<string, number[]>();
    group.forEach((t) => byOrientation.set(orientation(t), t));
    const choices = [...byOrientation.values()];
    if (choices.length === 1) {
      out.push(choices[0]);
      return;
    }
    // Both ways round. How many neighbours would each one join, edge to edge (not counting the pair itself)?
    const fit = (t: number[]) =>
      t.reduce((n, u, k) => {
        const v = t[(k + 1) % 3];
        const others = (directed.get(`${v}_${u}`) ?? 0) - group.filter((g) => g.some((x, j) => x === v && g[(j + 1) % 3] === u)).length;
        return n + (others > 0 ? 1 : 0);
      }, 0);
    const best = choices.map((t) => ({ t, n: fit(t) })).sort((p, q) => q.n - p.n)[0];
    if (best.n >= 2) out.push(best.t);
  });
  return out;
}

/**
 * An edge in a solid has exactly two triangles, running opposite ways. Where a cut leaves a third (a fin, or a face
 * overlapped by a sliver), take away the extra triangle that does the least harm: the one whose other edges are also
 * overcrowded, so removing it opens nothing, and among those the smallest.
 */
function resolveNonManifold(input: Tris, coords: number[]): Tris {
  let tris = input;
  for (let round = 0; round < 6; round++) {
    const uses = edgeCounts(tris);
    const forward = new Map<string, number[]>();
    tris.forEach((t, ti) =>
      t.forEach((u, k) => {
        const v = t[(k + 1) % 3];
        const dirKey = `${u}>${v}`;
        const list = forward.get(dirKey);
        if (list) list.push(ti);
        else forward.set(dirKey, [ti]);
      })
    );
    const remove = new Set<number>();
    uses.forEach((count, k) => {
      if (count <= 2) return;
      const [u, v] = k.split('_').map(Number);
      const a = (forward.get(`${u}>${v}`) ?? []).filter((t) => !remove.has(t));
      const b = (forward.get(`${v}>${u}`) ?? []).filter((t) => !remove.has(t));
      // Surplus is in whichever direction has more triangles than the other.
      const surplus = a.length > b.length ? a : b.length > a.length ? b : [];
      if (!surplus.length) return;
      const harm = (ti: number) => tris[ti].reduce((n, x, j) => n + ((uses.get(key(x, tris[ti][(j + 1) % 3])) ?? 0) <= 2 ? 1 : 0), 0);
      const best = [...surplus].sort((p, q) => harm(p) - harm(q) || area2(coords, tris[p]) - area2(coords, tris[q]))[0];
      remove.add(best);
    });
    if (!remove.size) break;
    tris = tris.filter((_, ti) => !remove.has(ti));
  }
  return tris;
}

/** Closes small leftover holes with a flat patch. Large openings are left alone: they are real. */
function fillSmallHoles(tris: Tris, coords: number[], maxEdges: number, maxSpan: number): Tris {
  const directed = new Map<string, [number, number]>();
  const uses = edgeCounts(tris);
  tris.forEach((t) =>
    t.forEach((u, k) => {
      const v = t[(k + 1) % 3];
      if (uses.get(key(u, v)) === 1) directed.set(`${u}_${v}`, [u, v]);
    })
  );
  const outgoing = new Map<number, number[]>();
  directed.forEach(([u, v]) => outgoing.set(u, [...(outgoing.get(u) ?? []), v]));
  const used = new Set<string>();
  const patches: Tris = [];
  for (const [u0, v0] of directed.values()) {
    if (used.has(`${u0}_${v0}`)) continue;
    const loop = [u0];
    let cur = v0;
    used.add(`${u0}_${v0}`);
    let closed = false;
    for (let guard = 0; guard <= maxEdges + 1; guard++) {
      if (cur === u0) {
        closed = true;
        break;
      }
      loop.push(cur);
      const next = (outgoing.get(cur) ?? []).find((n) => !used.has(`${cur}_${n}`));
      if (next === undefined) break;
      used.add(`${cur}_${next}`);
      cur = next;
    }
    if (!closed || loop.length < 3 || loop.length > maxEdges) continue;
    const pts = loop.map((i) => v3(coords, i));
    const box = new THREE.Box3().setFromPoints(pts);
    if (box.getSize(new THREE.Vector3()).length() > maxSpan) continue;
    // The patch must run the other way round the loop to meet the existing triangles edge to edge.
    const normal = new THREE.Vector3();
    pts.forEach((p, i) => {
      const q = pts[(i + 1) % pts.length];
      normal.x += (p.y - q.y) * (p.z + q.z);
      normal.y += (p.z - q.z) * (p.x + q.x);
      normal.z += (p.x - q.x) * (p.y + q.y);
    });
    if (normal.lengthSq() < 1e-12) continue;
    normal.normalize();
    const helper = Math.abs(normal.x) < 0.9 ? new THREE.Vector3(1, 0, 0) : new THREE.Vector3(0, 1, 0);
    const ax = helper.clone().cross(normal).normalize();
    const ay = normal.clone().cross(ax);
    const flat = pts.map((p) => new THREE.Vector2(p.dot(ax), p.dot(ay)));
    const faces = THREE.ShapeUtils.triangulateShape(flat, []);
    const ccw = THREE.ShapeUtils.area(flat) > 0;
    faces.forEach(([a, b, c]) => {
      // `normal` follows the loop order (right-hand rule), so the loop is counter-clockwise in (ax, ay) when area > 0.
      // The patch has to be the reverse of the loop.
      const tri = ccw ? [loop[a], loop[c], loop[b]] : [loop[a], loop[b], loop[c]];
      patches.push(tri);
    });
  }
  return patches.length ? [...tris, ...patches] : tris;
}

/**
 * Makes a boolean result a solid a slicer accepts: joins vertices that should be one, drops slivers and doubled faces,
 * closes T-junctions and hair-wide cracks, and patches what is left of tiny holes. Edits `coords` in place.
 */
export function healTriangles(coords: number[], input: Tris): Tris {
  let tris = dropDegenerate(input.map((t) => [...t]), coords);
  for (let pass = 0; pass < 4; pass++) {
    tris = splitTJunctions(tris, coords);
    const moved = mergeBoundaryNeighbours(tris, coords, HEAL.merge);
    tris = dropDegenerate(tris, coords);
    if (!moved) break;
  }
  tris = resolveNonManifold(tris, coords);
  tris = dropDuplicates(tris);
  tris = fillSmallHoles(tris, coords, 40, 6);
  return tris;
}

/** Welds vertices that are within `eps` of each other, in place, and returns the id of each input vertex. */
export function weldVertices(positions: ArrayLike<number>, eps = 1e-3): { coords: number[]; ids: Int32Array } {
  const coords: number[] = [];
  const grid = new Map<string, number[]>();
  const n = positions.length / 3;
  const ids = new Int32Array(n);
  const cell = eps * 2;
  for (let i = 0; i < n; i++) {
    const x = positions[i * 3];
    const y = positions[i * 3 + 1];
    const z = positions[i * 3 + 2];
    const cx = Math.floor(x / cell);
    const cy = Math.floor(y / cell);
    const cz = Math.floor(z / cell);
    let found = -1;
    search: for (let dx = -1; dx <= 1; dx++)
      for (let dy = -1; dy <= 1; dy++)
        for (let dz = -1; dz <= 1; dz++)
          for (const j of grid.get(`${cx + dx},${cy + dy},${cz + dz}`) ?? []) {
            if (Math.hypot(coords[j * 3] - x, coords[j * 3 + 1] - y, coords[j * 3 + 2] - z) <= eps) {
              found = j;
              break search;
            }
          }
    if (found < 0) {
      found = coords.length / 3;
      coords.push(x, y, z);
      const k = `${cx},${cy},${cz}`;
      const list = grid.get(k);
      if (list) list.push(found);
      else grid.set(k, [found]);
    }
    ids[i] = found;
  }
  return { coords, ids };
}
