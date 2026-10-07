/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import * as THREE from 'three';
import type { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { Body3D, DrawSession, Frame, Point2D } from '../types';
import { frameMatrix, wallFrame } from '../utils/frame';
import { DrawnOutline, circleOutline, rectangleOutline, shapeOutline, sidePoints, sketchOutline, snapDrawPoint } from '../utils/draw';

/** What the Draw tool needs from the viewer: the camera and scene, and a way to ask for a redraw. */
export interface DrawApi {
  scene: THREE.Scene;
  camera: THREE.PerspectiveCamera;
  controls: OrbitControls;
  dom: HTMLElement;
  bodyGroup: THREE.Group;
  invalidate: () => void;
  bodies: () => Body3D[];
  /** A small number beside the pointer (a length, a size), or null to hide it. */
  setLabel: (label: { text: string; x: number; y: number } | null) => void;
}

export interface DrawCallbacks {
  /** The sketch changed. */
  set: (next: DrawSession) => void;
  /** A finished outline to turn into a shape on the surface at `planeY`. */
  finish: (outline: DrawnOutline, planeY: number, frame?: Frame) => void;
  notify: (message: string) => void;
}

const ACCENT = '#8b7cf6';
const ACCENT_LIGHT = '#a99dff';
/** How far a press may wander and still be a tap: a fingertip drifts more than a mouse. */
const tapSlop = (e: { pointerType: string }) => (e.pointerType === 'touch' ? 10 : 5);
const NO_SURFACE = 'Draw on the ground, the top of a shape, or one of its walls.';
const LIFT = 0.6;

let dotTexture: THREE.Texture | null = null;
const dot = () => {
  if (dotTexture) return dotTexture;
  const c = document.createElement('canvas');
  c.width = c.height = 64;
  const g = c.getContext('2d')!;
  g.beginPath();
  g.arc(32, 32, 28, 0, Math.PI * 2);
  g.fillStyle = '#fff';
  g.fill();
  dotTexture = new THREE.CanvasTexture(c);
  return dotTexture;
};

const distToSegment = (px: number, py: number, a: { x: number; y: number }, b: { x: number; y: number }) => {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : Math.max(0, Math.min(1, ((px - a.x) * dx + (py - a.y) * dy) / len2));
  return Math.hypot(px - (a.x + t * dx), py - (a.y + t * dy));
};

type Gesture =
  | { kind: 'point'; index: number; moved: boolean; id: number }
  | { kind: 'bend'; index: number; id: number }
  | { kind: 'form'; anchor: Point2D; planeY: number; current: Point2D; id: number }
  | { kind: 'tap'; x: number; y: number; id: number; slop: number };

/**
 * Sketching on the ground or on the top of a shape. Tap to place corners, drag a corner to move it, drag a side to curve it,
 * tap the first corner to close. (Rectangle / Circle: drag it out.) The sketch itself lives in the app; this draws it and reads the pointer.
 */
export function createDrawTool(api: DrawApi, getSession: () => DrawSession | null, cb: DrawCallbacks) {
  const { camera, controls, dom, scene } = api;
  const group = new THREE.Group();
  scene.add(group);
  const raycaster = new THREE.Raycaster();
  const ndc = new THREE.Vector2();

  let cur: DrawSession | null = getSession();
  let gesture: Gesture | null = null;
  /** Where the pointer is over the surface (mouse only), for the rubber band and the first-tap hint. */
  let hover: { point: Point2D; y: number } | null = null;

  const rect = () => dom.getBoundingClientRect();
  const ray = (cx: number, cy: number) => {
    const r = rect();
    ndc.set(((cx - r.left) / r.width) * 2 - 1, -((cy - r.top) / r.height) * 2 + 1);
    raycaster.setFromCamera(ndc, camera);
  };
  /** Where the sketch lies: the scene itself, or a wall (then everything below is in the wall's own space). */
  const sketchMatrix = (f?: Frame) => (f ? frameMatrix(f) : new THREE.Matrix4());
  const onPlane = (cx: number, cy: number, y: number, f: Frame | undefined = cur?.frame): Point2D | null => {
    ray(cx, cy);
    const r = f ? raycaster.ray.clone().applyMatrix4(sketchMatrix(f).invert()) : raycaster.ray;
    const p = new THREE.Vector3();
    return r.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -y), p) ? { x: p.x, y: -p.z } : null;
  };
  const toScreen = (p: Point2D, y: number) => {
    const v = new THREE.Vector3(p.x, y + LIFT, -p.y).applyMatrix4(sketchMatrix(cur?.frame)).project(camera);
    const r = rect();
    return { x: (v.x * 0.5 + 0.5) * r.width + r.left, y: (-v.y * 0.5 + 0.5) * r.height + r.top };
  };

  /**
   * Which surface a tap at this spot would draw on: the ground, the top of a shape, or one of its walls.
   * `null` means somewhere that cannot be drawn on (an underside, a slope, a shape that is itself on a wall).
   */
  type Surface = { y: number; frame?: Frame; hostId?: string } | null;
  const surfaceAt = (cx: number, cy: number): Surface => {
    ray(cx, cy);
    const hit = raycaster.intersectObjects(api.bodyGroup.children, true)[0];
    if (!hit) return { y: 0 };
    let obj: THREE.Object3D | null = hit.object;
    while (obj && !obj.userData.bodyId) obj = obj.parent;
    const body = obj && api.bodies().find((b) => b.id === obj!.userData.bodyId);
    const n = hit.face ? hit.face.normal.clone().transformDirection(hit.object.matrixWorld) : null;
    if (!body || !n || body.frame) return null;
    if (n.y > 0.75) return { y: Math.round(((body.elevation ?? 0) + body.extrusionHeight) * 100) / 100, hostId: body.repeatOf ?? body.id };
    if (Math.abs(n.y) < 0.25) {
      // A wall: the sketch lies in the wall's plane, with its origin where the tap landed.
      const at = { x: Math.round(hit.point.x), y: Math.round(-hit.point.z) };
      return { y: 0, frame: { ...wallFrame(at, { x: n.x, y: -n.z }), h: Math.round(hit.point.y) } };
    }
    return null;
  };

  const corners = (): Point2D[] => (cur?.frame ? [] : api.bodies().flatMap((b) => (b.visible && !b.frame ? b.points : [])));

  // ---- Drawing the sketch -------------------------------------------------
  const disposeGroup = () => {
    while (group.children.length) {
      const c = group.children[0] as THREE.Mesh;
      group.remove(c);
      c.geometry?.dispose();
      (c.material as THREE.Material | undefined)?.dispose();
    }
  };
  const world = (p: Point2D, y: number) => new THREE.Vector3(p.x, y + LIFT, -p.y);
  const pointsObject = (pts: THREE.Vector3[], size: number, color: string, order: number) => {
    const o = new THREE.Points(
      new THREE.BufferGeometry().setFromPoints(pts),
      new THREE.PointsMaterial({ size, sizeAttenuation: false, map: dot(), alphaTest: 0.4, transparent: true, color, depthTest: false })
    );
    o.renderOrder = order;
    return o;
  };
  const lineObject = (pts: THREE.Vector3[], color: string, opacity = 1) => {
    const l = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color, transparent: true, opacity, depthTest: false }));
    l.renderOrder = 45;
    return l;
  };
  const fillObject = (outline: Point2D[], y: number) => {
    try {
      const m = new THREE.Mesh(
        new THREE.ShapeGeometry(new THREE.Shape(outline.map((p) => new THREE.Vector2(p.x, p.y)))),
        new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.22, side: THREE.DoubleSide, depthWrite: false })
      );
      m.rotation.x = -Math.PI / 2;
      m.position.y = y + LIFT * 0.5;
      m.renderOrder = 44;
      return m;
    } catch {
      return null;
    }
  };

  /** The outline a rectangle or circle drag would make, as points to show. */
  const formPreview = (g: Extract<Gesture, { kind: 'form' }>, form: 'rectangle' | 'circle'): Point2D[] => {
    if (form === 'rectangle') return rectangleOutline(g.anchor, g.current)?.basePoints ?? [];
    const r = Math.hypot(g.current.x - g.anchor.x, g.current.y - g.anchor.y);
    return Array.from({ length: 64 }, (_, i) => ({ x: g.anchor.x + r * Math.cos((i / 64) * Math.PI * 2), y: g.anchor.y + r * Math.sin((i / 64) * Math.PI * 2) }));
  };

  const redraw = () => {
    disposeGroup();
    const s = cur;
    group.matrixAutoUpdate = false;
    group.matrix.copy(sketchMatrix(s?.frame));
    group.matrixWorldNeedsUpdate = true;
    if (!s) return;
    const y = gesture?.kind === 'form' ? gesture.planeY : s.planeY ?? hover?.y ?? 0;

    if (gesture?.kind === 'form' && s.form !== 'shape') {
      const pts = formPreview(gesture, s.form);
      if (pts.length > 2) {
        group.add(lineObject([...pts, pts[0]].map((p) => world(p, y)), ACCENT_LIGHT));
        const f = fillObject(pts, y);
        if (f) group.add(f);
      }
      api.invalidate();
      return;
    }

    if (s.form === 'shape' && s.points.length) {
      const open = sketchOutline(s.points, s.bends, false);
      const rubber = !gesture && hover && s.planeY !== null ? hover.point : null;
      if (rubber) group.add(lineObject([world(s.points[s.points.length - 1], y), world(rubber, y)], ACCENT_LIGHT, 0.5));
      group.add(lineObject(open.map((p) => world(p, y)), ACCENT));
      if (s.points.length >= 3) {
        const f = fillObject(sketchOutline(s.points, s.bends, true), y);
        if (f) group.add(f);
        // The side that closes the sketch, so the finished shape is visible before it is closed.
        const closing = sidePoints(s.points[s.points.length - 1], s.points[0], s.bends[s.points.length - 1] ?? null);
        group.add(lineObject([...closing, s.points[0]].map((p) => world(p, y)), ACCENT, 0.45));
      }
      // Handles at the middle of every side: drag to curve it.
      const mids: THREE.Vector3[] = [];
      for (let i = 0; i < s.points.length - 1; i++) {
        const via = s.bends[i];
        const a = s.points[i];
        const b = s.points[i + 1];
        mids.push(world(via ?? { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, y));
      }
      if (mids.length) group.add(pointsObject(mids, 9, ACCENT_LIGHT, 46));
      const [first, ...rest] = s.points;
      group.add(pointsObject([world(first, y)], s.points.length >= 3 ? 17 : 13, s.points.length >= 3 ? '#34d399' : '#ffffff', 48));
      if (rest.length) group.add(pointsObject(rest.map((p) => world(p, y)), 12, '#ffffff', 47));
    } else if (hover && !gesture) {
      group.add(pointsObject([world(hover.point, hover.y)], 11, ACCENT_LIGHT, 47));
    }
    api.invalidate();
  };

  // ---- Reading the pointer --------------------------------------------------
  const reachFor = (e: PointerEvent) => (e.pointerType === 'touch' ? 24 : 12);

  const label = (e: { clientX: number; clientY: number }, text: string | null) => {
    const r = rect();
    api.setLabel(text ? { text, x: e.clientX - r.left + 16, y: e.clientY - r.top - 28 } : null);
  };

  const apply = (next: DrawSession) => {
    cur = next;
    cb.set(next);
    redraw();
  };

  const snapped = (cx: number, cy: number, y: number, ignoreIndex = -1): Point2D | null => {
    const p = onPlane(cx, cy, y);
    if (!p) return null;
    const s = cur!;
    const others = s.points.filter((_, i) => i !== ignoreIndex);
    const last = ignoreIndex < 0 ? s.points[s.points.length - 1] ?? null : null;
    return snapDrawPoint(p, [...corners(), ...others], last);
  };

  const onDown = (e: PointerEvent) => {
    if (!cur) return;
    if (!e.isPrimary) {
      gesture = null;
      if (controls) controls.enabled = true;
      return;
    }
    if (e.button !== 0) return;
    const s = cur;
    const reach = reachFor(e);
    if (s.form === 'shape' && s.planeY !== null) {
      // A corner: drag to move it (tap the first one to close).
      for (let i = 0; i < s.points.length; i++) {
        const sp = toScreen(s.points[i], s.planeY);
        if (Math.hypot(sp.x - e.clientX, sp.y - e.clientY) <= reach) return grab({ kind: 'point', index: i, moved: false, id: e.pointerId }, e);
      }
      // A side: drag to curve it.
      for (let i = 0; i < s.points.length - 1; i++) {
        const via = s.bends[i];
        const run = [...sidePoints(s.points[i], s.points[i + 1], via), s.points[i + 1]].map((p) => toScreen(p, s.planeY!));
        let d = Infinity;
        for (let k = 0; k < run.length - 1; k++) d = Math.min(d, distToSegment(e.clientX, e.clientY, run[k], run[k + 1]));
        const ends = Math.min(Math.hypot(run[0].x - e.clientX, run[0].y - e.clientY), Math.hypot(run[run.length - 1].x - e.clientX, run[run.length - 1].y - e.clientY));
        if (d <= reach * 0.7 && ends > reach) return grab({ kind: 'bend', index: i, id: e.pointerId }, e);
      }
    }
    if (s.form !== 'shape') {
      const surface = s.planeY !== null ? { y: s.planeY, frame: s.frame } : surfaceAt(e.clientX, e.clientY);
      if (!surface) {
        cb.notify(NO_SURFACE);
        return;
      }
      // The first touch on a wall only picks the wall: the view turns to face it, then you draw.
      if (s.planeY === null && surface.frame) return void apply({ ...s, planeY: surface.y, frame: surface.frame });
      const a = snapped(e.clientX, e.clientY, surface.y);
      if (!a) return;
      if (s.planeY === null) apply({ ...s, planeY: surface.y, hostId: surface.hostId });
      return grab({ kind: 'form', anchor: a, planeY: surface.y, current: a, id: e.pointerId }, e);
    }
    // Empty space: a tap places a corner; a drag is left to the camera.
    gesture = { kind: 'tap', x: e.clientX, y: e.clientY, id: e.pointerId, slop: tapSlop(e) };
  };

  const grab = (g: Gesture, e: PointerEvent) => {
    gesture = g;
    controls.enabled = false;
    dom.setPointerCapture(e.pointerId);
  };

  const onMove = (e: PointerEvent) => {
    const s = cur;
    if (!s) return;
    if (gesture?.kind === 'point' && s.planeY !== null) {
      const g = gesture;
      const p = snapped(e.clientX, e.clientY, s.planeY, g.index);
      if (p) {
        g.moved = true;
        const pts = s.points.map((q, i) => (i === g.index ? p : q));
        // A curve is only meaningful between its two corners: moving one lets go of the curves beside it.
        const bends = s.bends.map((b, i) => (i === g.index || i === g.index - 1 ? null : b));
        apply({ ...s, points: pts, bends });
        const prev = pts[g.index - 1];
        label(e, prev ? `${Math.round(Math.hypot(p.x - prev.x, p.y - prev.y))} mm` : `${p.x}, ${p.y}`);
      }
      return;
    }
    if (gesture?.kind === 'bend' && s.planeY !== null) {
      const p = onPlane(e.clientX, e.clientY, s.planeY);
      if (p) {
        const a = s.points[gesture.index];
        const b = s.points[gesture.index + 1];
        // Close to the straight line: keep it straight, so a flat side is easy to get back.
        const off = distToSegment(p.x, p.y, a, b);
        const chord = Math.hypot(b.x - a.x, b.y - a.y) || 1;
        const straight = off < Math.max(1.5, chord * 0.015);
        const bends = s.bends.slice();
        bends[gesture.index] = straight ? null : { x: Math.round(p.x), y: Math.round(p.y) };
        apply({ ...s, bends });
        label(e, straight ? 'Straight' : `Curve ${Math.round(off)} mm`);
      }
      return;
    }
    if (gesture?.kind === 'form') {
      const p = snapped(e.clientX, e.clientY, gesture.planeY);
      if (p) {
        gesture.current = p;
        redraw();
        label(e, s.form === 'circle' ? `Ø ${Math.round(Math.hypot(p.x - gesture.anchor.x, p.y - gesture.anchor.y) * 2)} mm` : `${Math.abs(p.x - gesture.anchor.x)} × ${Math.abs(p.y - gesture.anchor.y)} mm`);
      }
      return;
    }
    if (gesture?.kind === 'tap') {
      if (Math.hypot(e.clientX - gesture.x, e.clientY - gesture.y) > gesture.slop) gesture = null; // it is a camera drag
      return;
    }
    // Hovering (mouse): show where a tap would land.
    if (e.pointerType === 'mouse' && e.buttons === 0) {
      const surface = s.planeY !== null ? { y: s.planeY, frame: s.frame } : surfaceAt(e.clientX, e.clientY);
      // Before the first tap on a wall there is no flat sketch to show a cursor on yet.
      const p = !surface || (s.planeY === null && surface.frame) ? null : snapped(e.clientX, e.clientY, surface.y);
      const y = surface?.y ?? 0;
      hover = p ? { point: p, y } : null;
      label(e, p && s.form === 'shape' && s.points.length && s.planeY !== null ? `${Math.round(Math.hypot(p.x - s.points[s.points.length - 1].x, p.y - s.points[s.points.length - 1].y))} mm` : null);
      redraw();
    }
  };

  const onUp = (e: PointerEvent) => {
    const g = gesture;
    gesture = null;
    controls.enabled = true;
    if (dom.hasPointerCapture(e.pointerId)) dom.releasePointerCapture(e.pointerId);
    api.setLabel(null);
    const s = cur;
    if (!g || !s || e.type === 'pointercancel') {
      redraw();
      return;
    }
    if (g.kind === 'point') {
      if (!g.moved && g.index === 0 && s.points.length >= 3) {
        const o = shapeOutline(s);
        if (o && s.planeY !== null) cb.finish(o, s.planeY, s.frame);
        else cb.notify('Those corners do not make a shape yet.');
      }
    } else if (g.kind === 'form') {
      const o = s.form === 'rectangle' ? rectangleOutline(g.anchor, g.current) : circleOutline(g.anchor, g.current);
      if (o) cb.finish(o, g.planeY, s.frame);
      else redraw();
    } else if (g.kind === 'tap' && Math.hypot(e.clientX - g.x, e.clientY - g.y) <= g.slop) {
      const surface = s.planeY !== null ? { y: s.planeY, frame: s.frame } : surfaceAt(e.clientX, e.clientY);
      if (!surface) {
        cb.notify(NO_SURFACE);
      } else if (s.planeY === null && surface.frame) {
        // The first tap on a wall only picks the wall: the view turns to face it, then you draw.
        apply({ ...s, planeY: surface.y, frame: surface.frame });
      } else {
        const p = snapped(e.clientX, e.clientY, surface.y);
        if (p && !s.points.some((q) => q.x === p.x && q.y === p.y)) apply({ ...s, planeY: surface.y, hostId: s.planeY === null ? surface.hostId : s.hostId, points: [...s.points, p], bends: [...s.bends, null] });
      }
    }
    redraw();
  };

  const onLeave = () => {
    hover = null;
    api.setLabel(null);
    redraw();
  };

  // Capture phase, ahead of the camera controls and the viewer's own handlers.
  dom.addEventListener('pointerdown', onDown, { capture: true });
  dom.addEventListener('pointermove', onMove);
  dom.addEventListener('pointerup', onUp);
  dom.addEventListener('pointercancel', onUp);
  dom.addEventListener('pointerleave', onLeave);
  redraw();

  return {
    /** The sketch changed from outside (a corner removed, the form switched). */
    refresh() {
      if (gesture) return; // the pointer is mid-drag: the sketch it is making is already the newest
      const next = getSession();
      if (next === cur) return;
      cur = next;
      hover = null;
      redraw();
    },
    dispose() {
      dom.removeEventListener('pointerdown', onDown, { capture: true });
      dom.removeEventListener('pointermove', onMove);
      dom.removeEventListener('pointerup', onUp);
      dom.removeEventListener('pointercancel', onUp);
      dom.removeEventListener('pointerleave', onLeave);
      controls.enabled = true;
      api.setLabel(null);
      disposeGroup();
      scene.remove(group);
      api.invalidate();
    },
  };
}
