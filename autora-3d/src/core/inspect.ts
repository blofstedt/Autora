/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import { Body3D, EdgeBevel, Frame, Point2D } from '../types';
import { buildBodyGeometry } from '../utils/bodyGeometry';
import { listEdges } from '../utils/edges';
import { faceMeasure } from '../utils/faces';
import { frameMatrix } from '../utils/frame';
import { spacing } from '../utils/repeat';
import { selectionBounds } from '../utils/transform';
import { getBase, holeIndex, holeLoops, outwardNormal, wallEnds } from '../utils/outline';
import { Doc } from './doc';

const round1 = (n: number) => Math.round(n * 10) / 10;
const round2 = (n: number) => Math.round(n * 100) / 100;

export interface Vec3 {
  x: number;
  y: number;
  z: number;
}

/** What an agent sees of a shape: enough to reason about it without the raw outline. Axes: x right, y away from the front, z up. mm. */
export interface ShapeSummary {
  id: string;
  name: string;
  visible: boolean;
  color: string;
  material: string;
  /** Footprint centre and the shape's overall size. */
  center: { x: number; y: number };
  size: { width: number; depth: number; height: number };
  /** Bottom and top of the shape, in z. For a shape on a wall these are measured out from the wall. */
  bottom: number;
  top: number;
  /** The box that contains the shape in the world. */
  bounds: { min: Vec3; max: Vec3 };
  corners: number;
  holes: number;
  bevels: EdgeBevel[];
  cornerBevels: { vertex: number; size: number; style: string }[];
  cornerRadii?: number[];
  group?: string;
  /** Present on a copy made by a live repeat: the shape it follows. Copies cannot be edited; edit that shape. */
  copyOf?: string;
  /** Part of a linked library object (the placed object's group id). */
  linkedTo?: string;
  /** Present on a shape that has a live repeat: the id to pass to repeat commands is this shape's id. */
  repeat?: { kind: string; count: number; gap: number; follow: boolean; start: Point2D; end: Point2D; bend: Point2D | null };
  /** Present on a shape drawn on a wall. */
  wall?: Frame;
}

/** The corners of a shape, in the world, top and bottom. */
function worldCorners(body: Body3D): Vec3[] {
  const lo = body.elevation ?? 0;
  const hi = lo + body.extrusionHeight;
  const m = body.frame ? frameMatrix(body.frame) : null;
  const out: Vec3[] = [];
  for (const p of body.points) {
    for (const y of [lo, hi]) {
      const v = new THREE.Vector3(p.x, y, -p.y);
      if (m) v.applyMatrix4(m);
      out.push({ x: v.x, y: -v.z, z: v.y });
    }
  }
  return out;
}

export function boundsOf(bodies: Body3D[]): { min: Vec3; max: Vec3 } | null {
  const pts = bodies.flatMap(worldCorners);
  if (!pts.length) return null;
  return {
    min: { x: Math.min(...pts.map((p) => p.x)), y: Math.min(...pts.map((p) => p.y)), z: Math.min(...pts.map((p) => p.z)) },
    max: { x: Math.max(...pts.map((p) => p.x)), y: Math.max(...pts.map((p) => p.y)), z: Math.max(...pts.map((p) => p.z)) },
  };
}

const r3 = (v: Vec3): Vec3 => ({ x: round2(v.x), y: round2(v.y), z: round2(v.z) });

export function summarize(doc: Doc, body: Body3D): ShapeSummary {
  const xs = body.points.map((p) => p.x);
  const ys = body.points.map((p) => p.y);
  const b = boundsOf([body])!;
  const link = doc.repeats.find((l) => l.bodyId === body.id);
  const bottom = body.elevation ?? 0;
  const out: ShapeSummary = {
    id: body.id,
    name: body.name,
    visible: body.visible,
    color: body.color,
    material: body.materialType,
    center: { x: round2((Math.min(...xs) + Math.max(...xs)) / 2), y: round2((Math.min(...ys) + Math.max(...ys)) / 2) },
    size: { width: round2(Math.max(...xs) - Math.min(...xs)), depth: round2(Math.max(...ys) - Math.min(...ys)), height: round2(body.extrusionHeight) },
    bottom: round2(bottom),
    top: round2(bottom + body.extrusionHeight),
    bounds: { min: r3(b.min), max: r3(b.max) },
    corners: getBase(body).length,
    holes: body.holes?.length ?? 0,
    bevels: body.edgeBevels ?? [],
    cornerBevels: (body.cornerBevels ?? []).map((c) => ({ vertex: c.vertex, size: c.size, style: c.style })),
  };
  if (body.cornerRadii?.some((r) => r > 0)) out.cornerRadii = body.cornerRadii;
  if (body.groupId) out.group = body.groupId;
  if (body.repeatOf) out.copyOf = body.repeatOf;
  if (body.instanceOf) out.linkedTo = body.instanceOf;
  if (link) out.repeat = { kind: link.kind, count: link.count, gap: round2(spacing(link)), follow: link.follow, start: link.start, end: link.end, bend: link.bend };
  if (body.frame) out.wall = body.frame;
  return out;
}

/** A compass word for a plan direction: the viewer's front is −y, right is +x. */
export function directionWord(n: Point2D): string {
  const ax = Math.abs(n.x);
  const ay = Math.abs(n.y);
  if (ax > 0.92) return n.x > 0 ? 'right (+x)' : 'left (−x)';
  if (ay > 0.92) return n.y > 0 ? 'back (+y)' : 'front (−y)';
  const deg = Math.round((Math.atan2(n.y, n.x) * 180) / Math.PI);
  return `${deg}° from +x`;
}

export interface FaceInfo {
  /** How to name it in a command: "top", "bottom", or {"kind":"wall","index":n}. */
  face: 'top' | 'bottom' | { kind: 'wall'; index: number };
  description: string;
  /** The number a person would type for this face (its height, or its size across). */
  measure?: { label: string; value: number };
  /** For walls: which way it faces, and how long it is. */
  facing?: string;
  length?: number;
}

export function describeFaces(body: Body3D): FaceInfo[] {
  const faces: FaceInfo[] = [
    { face: 'top', description: 'the top face', measure: faceMeasure(body, { bodyId: body.id, kind: 'top' }) ?? undefined },
    { face: 'bottom', description: 'the underside', measure: faceMeasure(body, { bodyId: body.id, kind: 'bottom' }) ?? undefined },
  ];
  const walls = [...getBase(body).map((_, j) => j), ...holeLoops(body).flatMap((l, h) => l.base.map((_, j) => holeIndex(h, j)))];
  for (const j of walls) {
    const ends = wallEnds(body, j);
    if (!ends) continue;
    const n = outwardNormal(ends.a, ends.b, ends.winding);
    const length = round2(Math.hypot(ends.b.x - ends.a.x, ends.b.y - ends.a.y));
    faces.push({
      face: { kind: 'wall', index: j },
      description: `wall ${j}, ${length} mm long, facing ${directionWord(n)}${j >= 1000 ? ' (inside a hole)' : ''}`,
      measure: faceMeasure(body, { bodyId: body.id, kind: 'wall', index: j }) ?? undefined,
      facing: directionWord(n),
      length,
    });
  }
  return faces;
}

export interface EdgeInfo {
  /** "top" or "bottom" rim runs, or a vertical "corner". Pass these as {"kind","index"} in edge commands. */
  kind: 'top' | 'bottom' | 'corner';
  index: number;
  length: number;
  bevel?: { size: number; style: string };
}

export function describeEdgesOf(body: Body3D): EdgeInfo[] {
  return listEdges(body).map((e) => {
    let length = 0;
    for (let i = 0; i + 1 < e.points.length; i++) {
      length += Math.hypot(e.points[i + 1].x - e.points[i].x, e.points[i + 1].y - e.points[i].y, e.points[i + 1].z - e.points[i].z);
    }
    const bevel = e.kind === 'corner' ? body.cornerBevels?.find((c) => c.vertex === e.index) : body.edgeBevels?.find((b) => b.side === e.kind && b.edge === e.index);
    return { kind: e.kind, index: e.index, length: round1(length), ...(bevel && bevel.size > 0 ? { bevel: { size: bevel.size, style: bevel.style } } : {}) };
  });
}

export interface MeshReport {
  triangles: number;
  /** Cubic millimetres. */
  volume: number;
  surfaceArea: number;
  /** True when every edge is shared by exactly two triangles: the shape would print. */
  watertight: boolean;
  openEdges: number;
}

/** Builds the real solid (bevels and all) and measures it. */
export function meshReport(body: Body3D): MeshReport | null {
  const g = buildBodyGeometry(body);
  if (!g) return null;
  const pos = g.attributes.position;
  const count = g.index ? g.index.count : pos.count;
  const at = (i: number) => (g.index ? g.index.getX(i) : i);
  const key = (i: number) => `${Math.round(pos.getX(i) * 1000)},${Math.round(pos.getY(i) * 1000)},${Math.round(pos.getZ(i) * 1000)}`;
  const edges = new Map<string, number>();
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  let volume = 0;
  let area = 0;
  for (let t = 0; t < count; t += 3) {
    a.fromBufferAttribute(pos, at(t));
    b.fromBufferAttribute(pos, at(t + 1));
    c.fromBufferAttribute(pos, at(t + 2));
    volume += a.dot(new THREE.Vector3().crossVectors(b, c)) / 6;
    area += new THREE.Vector3().subVectors(b, a).cross(new THREE.Vector3().subVectors(c, a)).length() / 2;
    const k = [key(at(t)), key(at(t + 1)), key(at(t + 2))];
    for (let e = 0; e < 3; e++) {
      const p = k[e];
      const q = k[(e + 1) % 3];
      if (p === q) continue;
      const id = p < q ? `${p}|${q}` : `${q}|${p}`;
      edges.set(id, (edges.get(id) ?? 0) + 1);
    }
  }
  let open = 0;
  edges.forEach((n) => {
    if (n !== 2) open++;
  });
  const report = { triangles: count / 3, volume: round1(Math.abs(volume)), surfaceArea: round1(area), watertight: open === 0, openEdges: open };
  g.dispose();
  return report;
}

export interface SceneSummary {
  shapes: ShapeSummary[];
  groups: { id: string; name: string; shapes: string[]; joined: boolean; parent?: string; library?: string; linked?: boolean; place?: { x: number; y: number; z: number; degrees: number } }[];
  bounds: { min: Vec3; max: Vec3 } | null;
  /** How to read the numbers. */
  units: string;
}

export function sceneSummary(doc: Doc, options: { includeCopies?: boolean } = {}): SceneSummary {
  const shown = options.includeCopies ? doc.bodies : doc.bodies.filter((b) => !b.repeatOf);
  const out: SceneSummary = {
    shapes: shown.map((b) => summarize(doc, b)),
    groups: doc.groups.map((g) => ({ id: g.id, name: g.name, shapes: g.bodyIds, joined: !!g.joined, parent: g.parentId, library: g.libraryId, linked: g.place ? true : undefined, place: g.place ? { x: g.place.x, y: g.place.y, z: g.place.z, degrees: round2((g.place.angle * 180) / Math.PI) } : undefined })),
    bounds: boundsOf(doc.bodies.filter((b) => b.visible)),
    units: 'millimetres. x is to the right, y is away from the front of the view, z is up. A shape stands on its bottom (z) and rises to its top.',
  };
  return out;
}

/** The project library, with each object's size and how many linked copies are placed. */
export function libraryItems(doc: Doc) {
  return doc.library.map((item) => {
    const box = selectionBounds(item.bodies)!;
    return {
      id: item.id,
      name: item.name,
      shared: !!item.shared,
      shapes: item.bodies.length,
      size: { x: round2(box.maxX - box.minX), y: round2(box.maxY - box.minY), z: round2(box.maxTop - box.minElevation) },
      placed: doc.groups.filter((g) => g.libraryId === item.id && g.place).map((g) => g.id),
      open: doc.groups.filter((g) => g.libraryId === item.id && !g.place).map((g) => g.id),
    };
  });
}
