/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { Body3D, CornerBevel } from '../types';
import { findBevel } from './edges';
import { getBase, getOutline, outwardNormal, runId, sideRun } from './outline';

type V2 = { x: number; y: number };
const w3 = (p: V2, y: number) => new THREE.Vector3(p.x, y, -p.y);
const dir3 = (d: V2) => new THREE.Vector3(d.x, 0, -d.y);
const UP = new THREE.Vector3(0, 1, 0);

interface Station {
  p: THREE.Vector3;
  /** Outward normals of the two surfaces meeting along the corner at this point (wall A side, wall B side). */
  na: THREE.Vector3;
  nb: THREE.Vector3;
  /** Share of the full radius here: a bevel fades out where it runs into an edge that is still sharp. */
  scale?: number;
}

/**
 * The solid removed by a corner bevel. It runs up the vertical corner and, where the edge above (or below) is
 * itself beveled, carries on along that bevel's curve, so the rounding follows the edge as you see it.
 */
export function buildCornerCutter(body: Body3D, cb: CornerBevel): THREE.BufferGeometry | null {
  const base = getBase(body);
  const n = base.length;
  const v = cb.vertex;
  if (n < 3 || v < 0 || v >= n || (body.cornerRadii?.[v] ?? 0) > 0) return null;
  const outline = getOutline(body);
  const height = Math.max(1, body.extrusionHeight);
  const bottom = body.elevation ?? 0;
  const top = bottom + height;

  const V = base[v];
  const prev = base[(v - 1 + n) % n];
  const next = base[(v + 1) % n];
  const nA2 = outwardNormal(prev, V, outline.winding);
  const nB2 = outwardNormal(V, next, outline.winding);
  // Only an outside corner can be rounded off.
  const toNext = { x: next.x - V.x, y: next.y - V.y };
  if (nA2.x * toNext.x + nA2.y * toNext.y > -1e-6) return null;

  const lenA = Math.hypot(V.x - prev.x, V.y - prev.y);
  const lenB = Math.hypot(next.x - V.x, next.y - V.y);
  const r = Math.min(cb.size, height / 2 - 0.05, lenA * 0.45, lenB * 0.45);
  if (r < 0.2) return null;
  const nA = dir3(nA2);
  const nB = dir3(nB2);

  const eff = (side: number, kind: 'top' | 'bottom') => {
    const bevel = findBevel(body, kind, runId(sideRun(outline, n, side)));
    return bevel && bevel.size > 0 ? { size: Math.min(bevel.size, height / 2 - 0.05), style: bevel.style } : null;
  };

  /** Stations along the curve of the larger neighbouring bevel at one end (top or bottom), from the corner line outward. */
  const endCurve = (kind: 'top' | 'bottom'): Station[] | null => {
    const a = eff((v - 1 + n) % n, kind);
    const b = eff(v, kind);
    const pick = (a?.size ?? 0) >= (b?.size ?? 0) ? (a ? 'A' : null) : 'B';
    if (!pick) return null;
    const bev = pick === 'A' ? a! : b!;
    // The beveled wall X curves away; the corner follows that curve within the plane of the other wall Y.
    const nX2 = pick === 'A' ? nA2 : nB2;
    const nY2 = pick === 'A' ? nB2 : nA2;
    // If the other wall's edge here is beveled too, the two meet; if it is sharp, fade the rounding out along the curve.
    const yBeveled = !!eff(pick === 'A' ? v : (v - 1 + n) % n, kind);
    const far = pick === 'A' ? prev : next;
    const dl = Math.hypot(far.x - V.x, far.y - V.y) || 1;
    const dn = { x: (far.x - V.x) / dl, y: (far.y - V.y) / dl };
    const nIn = { x: -nX2.x, y: -nX2.y };
    const dm = dn.x * nY2.x + dn.y * nY2.y;
    const nm = nIn.x * nY2.x + nIn.y * nY2.y;
    const sign = kind === 'top' ? -1 : 1;
    const y0 = kind === 'top' ? top : bottom;
    const R = bev.size;
    const steps = bev.style === 'round' ? 10 : 1;
    const out: Station[] = [];
    for (let k = 0; k <= steps; k++) {
      const phi = (k / steps) * (Math.PI / 2);
      const [u, w] = bev.style === 'round' ? [R * (1 - Math.cos(phi)), R * (1 - Math.sin(phi))] : [R * (k / steps), R * (1 - k / steps)];
      const t = Math.abs(dm) < 1e-3 ? 0 : (-u * nm) / dm;
      const p = w3({ x: V.x + dn.x * t + nIn.x * u, y: V.y + dn.y * t + nIn.y * u }, y0 + sign * w);
      const vertical = kind === 'top' ? UP : UP.clone().negate();
      const surface =
        bev.style === 'round'
          ? dir3(nX2).multiplyScalar(Math.cos(phi)).addScaledVector(vertical, Math.sin(phi)).normalize()
          : dir3(nX2).add(vertical).normalize();
      const nY = dir3(nY2);
      const scale = yBeveled ? 1 : Math.max(0.03, 1 - k / steps);
      out.push(pick === 'A' ? { p, na: surface, nb: nY, scale } : { p, na: nY, nb: surface, scale });
    }
    // A flat bevel turns sharply where it meets the wall: start on the plain corner there.
    if (bev.style === 'chamfer') out.unshift({ p: out[0].p.clone(), na: nA, nb: nB });
    return out;
  };

  const topCurve = endCurve('top');
  const bottomCurve = endCurve('bottom');
  const ext = r + 1;
  const stations: Station[] = [];
  if (bottomCurve) stations.push(...[...bottomCurve].reverse());
  else stations.push({ p: w3(V, bottom - ext), na: nA, nb: nB });
  if (topCurve) stations.push(...topCurve);
  else stations.push({ p: w3(V, top + ext), na: nA, nb: nB });
  if (bottomCurve && topCurve && topCurve[0].p.y <= bottomCurve[0].p.y) return null;

  // Cross-section at each station: the corner region outside a circle of radius r touching both surfaces.
  const arcSteps = cb.style === 'round' ? 8 : 1;
  const rFull = r;
  const e = r + 1;
  const ring = (s: Station) => {
    const r = rFull * (s.scale ?? 1);
    const cosT = s.na.dot(s.nb);
    const c = s.p.clone().addScaledVector(s.na.clone().add(s.nb), -r / (1 + cosT));
    const pts: THREE.Vector3[] = [];
    for (let k = 0; k <= arcSteps; k++) {
      const d = s.na.clone().lerp(s.nb, k / arcSteps).normalize();
      pts.push(cb.style === 'round' ? c.clone().addScaledVector(d, r) : c.clone().addScaledVector(k === 0 ? s.na : s.nb, r));
    }
    const tA = pts[0];
    const tB = pts[pts.length - 1];
    pts.push(tB.clone().addScaledVector(s.nb, e));
    pts.push(s.p.clone().addScaledVector(s.na.clone().add(s.nb).normalize(), e * 1.5));
    pts.push(tA.clone().addScaledVector(s.na, e));
    return pts;
  };
  const rings = stations.map(ring);
  const P = rings[0].length;
  const hub = P - 2; // the point outside the corner: every other profile point is visible from it

  const positions: number[] = [];
  rings.forEach((ringPts) => ringPts.forEach((q) => positions.push(q.x, q.y, q.z)));
  const index: number[] = [];
  for (let i = 0; i + 1 < rings.length; i++) {
    for (let k = 0; k < P; k++) {
      const k2 = (k + 1) % P;
      const A = i * P + k;
      const B = i * P + k2;
      const C = (i + 1) * P + k2;
      const D = (i + 1) * P + k;
      index.push(A, B, C, A, C, D);
    }
  }
  const last = (rings.length - 1) * P;
  for (let k = 0; k < P; k++) {
    const k2 = (k + 1) % P;
    if (k === hub || k2 === hub) continue;
    index.push(hub, k2, k);
    index.push(last + hub, last + k, last + k2);
  }

  // Orient outward (positive volume).
  let vol = 0;
  for (let i = 0; i < index.length; i += 3) {
    const a = index[i] * 3;
    const b = index[i + 1] * 3;
    const c = index[i + 2] * 3;
    vol +=
      positions[a] * (positions[b + 1] * positions[c + 2] - positions[b + 2] * positions[c + 1]) -
      positions[a + 1] * (positions[b] * positions[c + 2] - positions[b + 2] * positions[c]) +
      positions[a + 2] * (positions[b] * positions[c + 1] - positions[b + 1] * positions[c]);
  }
  if (vol < 0) for (let i = 0; i < index.length; i += 3) [index[i + 1], index[i + 2]] = [index[i + 2], index[i + 1]];

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(positions, 3));
  g.setIndex(index);
  g.computeVertexNormals();
  return g;
}
