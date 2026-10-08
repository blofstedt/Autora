/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import polygonClipping, { Polygon, Ring, Pair, MultiPolygon } from 'polygon-clipping';
import { Point2D } from '../types';

/**
 * Calculate signed polygon area (Shoelace formula).
 * Returns positive for counter-clockwise, negative for clockwise.
 */
export function getPolygonSignedArea(pts: Point2D[]): number {
  if (pts.length < 3) return 0;
  let area = 0;
  const n = pts.length;
  for (let i = 0; i < n; i++) {
    const j = (i + 1) % n;
    area += pts[i].x * pts[j].y;
    area -= pts[j].x * pts[i].y;
  }
  return area / 2;
}

export function isPolygonClockwise(pts: Point2D[]): boolean {
  return getPolygonSignedArea(pts) < 0;
}

/**
 * Remove duplicate/near-identical consecutive vertices and strip closing duplicate
 */
export function cleanPolygonPoints(points: Point2D[], minDistance = 0.5): Point2D[] {
  if (points.length < 3) return [...points];
  const cleaned: Point2D[] = [];

  for (let i = 0; i < points.length; i++) {
    const p = points[i];
    if (cleaned.length === 0) {
      cleaned.push({ ...p });
      continue;
    }
    const prev = cleaned[cleaned.length - 1];
    if (Math.hypot(p.x - prev.x, p.y - prev.y) >= minDistance) {
      cleaned.push({ ...p });
    }
  }

  // If first and last are coincident, remove last
  if (cleaned.length > 2) {
    const first = cleaned[0];
    const last = cleaned[cleaned.length - 1];
    if (Math.hypot(first.x - last.x, first.y - last.y) < minDistance) {
      cleaned.pop();
    }
  }

  return cleaned;
}

/**
 * Ensure polygon vertices follow a specific winding order (true = clockwise, false = counter-clockwise)
 */
export function ensureWinding(points: Point2D[], clockwise: boolean): Point2D[] {
  if (points.length < 3) return [...points];
  const isCurrentlyClockwise = isPolygonClockwise(points);
  if (isCurrentlyClockwise !== clockwise) {
    return [...points].reverse();
  }
  return [...points];
}

/**
 * Converts an open sequence of curve points into a closed 2D ribbon polygon with thickness
 * so that it can be extruded as a genuine 3D manifold CAD solid!
 */
export function createClosedCurveRibbon(curvePoints: Point2D[], thickness = 24): Point2D[] {
  if (curvePoints.length < 2) return curvePoints;
  const cleaned = cleanPolygonPoints(curvePoints);
  if (cleaned.length < 2) return cleaned;

  const halfT = thickness / 2;
  const topSide: Point2D[] = [];
  const bottomSide: Point2D[] = [];
  const n = cleaned.length;

  for (let i = 0; i < n; i++) {
    const curr = cleaned[i];
    let tx = 0;
    let ty = 0;

    if (i === 0) {
      tx = cleaned[1].x - curr.x;
      ty = cleaned[1].y - curr.y;
    } else if (i === n - 1) {
      tx = curr.x - cleaned[i - 1].x;
      ty = curr.y - cleaned[i - 1].y;
    } else {
      tx = cleaned[i + 1].x - cleaned[i - 1].x;
      ty = cleaned[i + 1].y - cleaned[i - 1].y;
    }

    const len = Math.hypot(tx, ty) || 1;
    // Perpendicular normal (-ty, tx)
    const nx = -ty / len;
    const ny = tx / len;

    topSide.push({
      x: Math.round((curr.x + nx * halfT) * 10) / 10,
      y: Math.round((curr.y + ny * halfT) * 10) / 10,
    });
    bottomSide.push({
      x: Math.round((curr.x - nx * halfT) * 10) / 10,
      y: Math.round((curr.y - ny * halfT) * 10) / 10,
    });
  }

  // Combine top side and reversed bottom side into a closed loop
  const closed = [...topSide, ...bottomSide.reverse()];
  return cleanPolygonPoints(closed);
}

/**
 * Converts Point2D array and optional holes to polygon-clipping Polygon format
 */
export function toClipPolygon(points: Point2D[], holes?: Point2D[][]): Polygon {
  const ensureClosed = (pts: Point2D[]): Ring => {
    if (pts.length < 3) return [];
    const ring: Ring = pts.map((p) => [p.x, p.y] as Pair);
    const first = ring[0];
    const last = ring[ring.length - 1];
    if (Math.hypot(first[0] - last[0], first[1] - last[1]) > 0.001) {
      ring.push([first[0], first[1]]);
    }
    return ring;
  };

  const exterior = ensureClosed(points);
  const rings: Ring[] = [exterior];

  if (holes && holes.length > 0) {
    holes.forEach((h) => {
      const holeRing = ensureClosed(h);
      if (holeRing.length >= 4) {
        rings.push(holeRing);
      }
    });
  }

  return rings;
}

/**
 * Converts polygon-clipping MultiPolygon back to array of { points: Point2D[], holes: Point2D[][] }
 */
export function fromClipMultiPolygon(multiPoly: MultiPolygon): { points: Point2D[]; holes: Point2D[][] }[] {
  const results: { points: Point2D[]; holes: Point2D[][] }[] = [];

  for (const poly of multiPoly) {
    if (!poly || poly.length === 0) continue;
    const extRing = poly[0];
    if (extRing.length < 3) continue;

    // Convert exterior ring (strip duplicate closing point)
    const points: Point2D[] = [];
    const n = extRing.length;
    const limit = (n > 1 && extRing[0][0] === extRing[n - 1][0] && extRing[0][1] === extRing[n - 1][1]) ? n - 1 : n;
    for (let i = 0; i < limit; i++) {
      points.push({ x: extRing[i][0], y: extRing[i][1] });
    }

    // Convert hole rings
    const holes: Point2D[][] = [];
    for (let h = 1; h < poly.length; h++) {
      const holeRing = poly[h];
      const hLimit = (holeRing.length > 1 && holeRing[0][0] === holeRing[holeRing.length - 1][0] && holeRing[0][1] === holeRing[holeRing.length - 1][1])
        ? holeRing.length - 1
        : holeRing.length;
      const holePts: Point2D[] = [];
      for (let i = 0; i < hLimit; i++) {
        holePts.push({ x: holeRing[i][0], y: holeRing[i][1] });
      }
      if (holePts.length >= 3) {
        holes.push(holePts);
      }
    }

    if (points.length >= 3) {
      results.push({ points, holes });
    }
  }

  return results;
}

/**
 * Boolean Difference: Cut cutter shape out of target shape
 */
export function cutShape(
  targetPoints: Point2D[],
  targetHoles: Point2D[][] | undefined,
  cutterPoints: Point2D[],
  cutterHoles?: Point2D[][]
): { points: Point2D[]; holes: Point2D[][] }[] {
  const targetGeom = toClipPolygon(targetPoints, targetHoles);
  const cutterGeom = toClipPolygon(cutterPoints, cutterHoles);

  try {
    const diff = polygonClipping.difference(targetGeom, cutterGeom);
    return fromClipMultiPolygon(diff);
  } catch (err) {
    console.error('Polygon clipping difference error:', err);
    return [{ points: targetPoints, holes: targetHoles || [] }];
  }
}

/**
 * Boolean Union: Merge multiple shapes into compound polygon(s)
 */
export function mergeShapes(
  shapes: { points: Point2D[]; holes?: Point2D[][] }[]
): { points: Point2D[]; holes: Point2D[][] }[] {
  if (shapes.length === 0) return [];
  if (shapes.length === 1) return [{ points: shapes[0].points, holes: shapes[0].holes || [] }];

  const clipGeoms = shapes.map((s) => toClipPolygon(s.points, s.holes));

  try {
    const merged = polygonClipping.union(clipGeoms[0], ...clipGeoms.slice(1));
    return fromClipMultiPolygon(merged);
  } catch (err) {
    console.error('Polygon clipping union error:', err);
    return shapes.map((s) => ({ points: s.points, holes: s.holes || [] }));
  }
}

/**
 * Fillet Corner Rounding: Rounds polygon vertices with circular arcs of given radius
 */
export function roundPolygonCorners(points: Point2D[], radius: number, segmentsPerCorner = 4): Point2D[] {
  if (radius <= 0.5 || points.length < 3) return points;

  const n = points.length;
  const result: Point2D[] = [];

  for (let i = 0; i < n; i++) {
    const prev = points[(i - 1 + n) % n];
    const curr = points[i];
    const next = points[(i + 1) % n];

    // Vectors to adjacent vertices
    const v1 = { x: prev.x - curr.x, y: prev.y - curr.y };
    const v2 = { x: next.x - curr.x, y: next.y - curr.y };

    const len1 = Math.hypot(v1.x, v1.y);
    const len2 = Math.hypot(v2.x, v2.y);

    if (len1 < 0.001 || len2 < 0.001) {
      result.push(curr);
      continue;
    }

    const u1 = { x: v1.x / len1, y: v1.y / len1 };
    const u2 = { x: v2.x / len2, y: v2.y / len2 };

    // Angle between edges
    const dot = u1.x * u2.x + u1.y * u2.y;
    // Clamp to avoid numerical issues with acos
    const clampedDot = Math.max(-0.999, Math.min(0.999, dot));
    const angle = Math.acos(clampedDot);

    // If edges are collinear or nearly so, keep sharp
    if (angle < 0.1 || angle > Math.PI - 0.1) {
      result.push(curr);
      continue;
    }

    // Distance from vertex to fillet tangent points
    const halfAngle = angle / 2;
    const tangentDist = radius / Math.tan(halfAngle);

    // Limit radius so it doesn't exceed half the shortest adjacent edge
    const maxTangent = Math.min(len1, len2) * 0.48;
    const actualTangentDist = Math.min(tangentDist, maxTangent);
    const actualRadius = actualTangentDist * Math.tan(halfAngle);

    if (actualRadius < 0.5) {
      result.push(curr);
      continue;
    }

    // Tangent start and end points
    const t1 = {
      x: curr.x + u1.x * actualTangentDist,
      y: curr.y + u1.y * actualTangentDist,
    };
    const t2 = {
      x: curr.x + u2.x * actualTangentDist,
      y: curr.y + u2.y * actualTangentDist,
    };

    // Center of the rounding circle
    // Bisector vector
    const bisector = { x: u1.x + u2.x, y: u1.y + u2.y };
    const bLen = Math.hypot(bisector.x, bisector.y);
    if (bLen < 0.001) {
      result.push(curr);
      continue;
    }
    const uBisector = { x: bisector.x / bLen, y: bisector.y / bLen };
    const distToCenter = actualRadius / Math.sin(halfAngle);
    const center = {
      x: curr.x + uBisector.x * distToCenter,
      y: curr.y + uBisector.y * distToCenter,
    };

    // Angles from center to t1 and t2
    let a1 = Math.atan2(t1.y - center.y, t1.x - center.x);
    let a2 = Math.atan2(t2.y - center.y, t2.x - center.x);

    // Determine arc direction (clockwise vs counter-clockwise)
    let diff = a2 - a1;
    while (diff < -Math.PI) diff += 2 * Math.PI;
    while (diff > Math.PI) diff -= 2 * Math.PI;

    // Cross product to check turn direction
    const cross = u1.x * u2.y - u1.y * u2.x;
    if (cross > 0 && diff < 0) diff += 2 * Math.PI;
    if (cross < 0 && diff > 0) diff -= 2 * Math.PI;

    // Generate arc interpolation points
    for (let s = 0; s <= segmentsPerCorner; s++) {
      const t = s / segmentsPerCorner;
      const curAngle = a1 + diff * t;
      result.push({
        x: Math.round((center.x + Math.cos(curAngle) * actualRadius) * 100) / 100,
        y: Math.round((center.y + Math.sin(curAngle) * actualRadius) * 100) / 100,
      });
    }
  }

  return result;
}
