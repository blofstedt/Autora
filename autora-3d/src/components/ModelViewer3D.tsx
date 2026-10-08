/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import * as THREE from 'three';
import { AnimatePresence, motion } from 'motion/react';
import { BevelPicker, DrawChip, MeasureReadout, RepeatChip } from './FloatingControls';
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js';
import { RoomEnvironment } from 'three/examples/jsm/environments/RoomEnvironment.js';
import { Line2 } from 'three/examples/jsm/lines/Line2.js';
import { LineGeometry } from 'three/examples/jsm/lines/LineGeometry.js';
import { LineMaterial } from 'three/examples/jsm/lines/LineMaterial.js';
import { BevelStyle, Body3D, EdgeSel, FaceSel, MATERIAL_PRESETS, DrawForm, DrawSession, Frame, Point2D, RepeatSession, ShapeGroup } from '../types';
import { withGroupMates } from '../utils/groups';
import { buildBodyGeometry, buildBodyShape, featureEdges, getInteriorAnchor } from '../utils/bodyGeometry';
import { bottomRange, faceMeasure, moveBottom, offsetWall, sameFace, wallBase } from '../utils/faces';
import { EdgePath, defaultBevelSize, maxBevelSize, edgeKey, edgeSize, edgeStyle, edgesAroundFace, edgesOfKind, listEdges, primaryEdge, toggleEdge } from '../utils/edges';
import { getBase, holeIndex, holeLoops, isHoleIndex, outwardNormal, wallEnds } from '../utils/outline';
import { DrawApi, createDrawTool } from './drawTool';
import { DrawnOutline } from '../utils/draw';
import { frameMatrix, frameNormal } from '../utils/frame';
import { BodyTransform, scaleBodyAbout, selectionBounds, transformBody } from '../utils/transform';
import { bendHandle, bendThrough, copyTransforms, stops, withCopies } from '../utils/repeat';
import { Eye } from 'lucide-react';
import ViewCube, { CubeFace } from './ViewCube';

type GizmoKind = 'repeat-end' | 'repeat-bend' | 'extrude-height' | 'extrude-bottom' | 'offset-wall' | 'scale-corner' | 'edge-size' | 'rotate' | 'move-axis';
type Axis = 'x' | 'y' | 'z';

type Hit =
  | { type: 'gizmo'; gizmo: GizmoKind; bodyId?: string; index?: number; axis?: Axis }
  | { type: 'edge'; sel: EdgeSel }
  | { type: 'body'; bodyId: string; point: THREE.Vector3; face: FaceSel };

interface Drag {
  kind: 'height' | 'bottom' | 'wall' | 'corner' | 'edge-size' | 'move' | 'rotate' | 'axis' | 'repeat';
  /** Which repeat handle is being dragged. */
  repeatHandle?: 'end' | 'bend';
  /** The grabbed shape stands on a wall: pointer rays are read in the wall's own space. */
  frame?: THREE.Matrix4;
  /** Screen direction in which a wall shape's height grows (unit vector). Absent for upright shapes: up the screen. */
  axisScreen?: { x: number; y: number };
  startClientY: number;
  startClientX?: number;
  /** Furthest the pointer travelled from where it went down (px): tells a tap from a drag. */
  moved?: number;
  mmPerPixel: number;
  bodyId?: string;
  planeY?: number;
  startPoint?: THREE.Vector3;
  // height
  initialHeight?: number;
  nextHeight?: number;
  // face number shown while dragging
  measure0?: number;
  measureLabel?: string;
  // axis move
  axis?: Axis;
  dz?: number;
  minLift?: number;
  // bottom
  initialElevation?: number;
  nextDelta?: number;
  // wall
  index?: number;
  initialBase?: Point2D[];
  normal?: Point2D;
  // corner resize
  initialBody?: Body3D;
  anchor?: Point2D;
  corner0?: Point2D;
  // edge size
  sels?: EdgeSel[];
  initialSize?: number;
  // move / rotate
  ids?: string[];
  center?: Point2D;
  a0?: number;
  dx?: number;
  dy?: number;
  angle?: number;
}

/** What the app (and through it, an agent) can ask of the 3D view. */
export interface ViewerApi {
  view(view: CubeFace | 'fit'): void;
  /** A PNG of the current view, as a data URL. */
  screenshot(): string;
}

export interface ModelViewer3DProps {
  apiRef?: React.MutableRefObject<ViewerApi | null>;
  bodies: Body3D[];
  groups?: ShapeGroup[];
  selectedBodyId: string | null;
  selectedBodyIds: string[];
  onSelectBody: (id: string | null, isMultiSelect?: boolean) => void;
  onUpdateBody: (id: string, updates: Partial<Body3D>) => void;
  onTransformBodies: (ids: string[], t: BodyTransform) => void;
  selectedEdges: EdgeSel[];
  onSelectEdges: (edges: EdgeSel[]) => void;
  selectedFace: FaceSel | null;
  onSelectFace: (face: FaceSel | null) => void;
  onEdgeChange: (edges: EdgeSel[], patch: { size?: number; style?: BevelStyle }) => void;
  /** The open Repeat, drawn as ghost copies with handles; null when none. */
  repeat: RepeatSession | null;
  onUpdateRepeat: React.Dispatch<React.SetStateAction<RepeatSession | null>>;
  onFinishRepeat: () => void;
  /** See-through mode: every shape turns glassy so what is inside another shape can be seen and picked. */
  xray: boolean;
  onToggleXray: () => void;
  /** The open Draw sketch, or null. The viewer shows it and reads the pointer; the app owns it. */
  draw: DrawSession | null;
  onUpdateDraw: (next: DrawSession) => void;
  onFinishDraw: (outline: DrawnOutline, planeY: number, frame?: Frame) => void;
  onNotify: (message: string) => void;
  /** Switch what is being drawn, finish the corners sketched so far, or stop drawing. */
  onDrawForm: (form: DrawForm) => void;
  onDrawDone: () => void;
  onDrawCancel: () => void;
  onDrawUndoCorner: () => void;
  onDrawCut: (cut: boolean) => void;
  onRepeatCancel: () => void;
  /** Fired when a drag starts/ends so the app can treat it as a single undo step. */
  onDragStateChange?: (dragging: boolean) => void;
  /** One line saying what the pointer is over and what dragging it will do. */
  onHint?: (text: string) => void;
  /** Typing an exact number for the selected face (millimetres). */
  onFaceValue?: (face: FaceSel, mm: number) => void;
  /** Show the X / Y / Z move arrows on the selection. */
  moveOn?: boolean;
  /** Two-finger tap asks to show or hide the move arrows. */
  onToggleMove?: () => void;
}

const ACCENT = '#8b7cf6';
const ACCENT_LIGHT = '#a99dff';
const WARN = '#fbbf24';
const BACKGROUND = '#08090d';
const CLICK_SLOP_PX = 5;
const EDGE_PICK_PX = 9;
/** Fingers are less exact than a mouse: touch gets a wider catch area around every edge. */
const EDGE_PICK_TOUCH_PX = 18;
const MAX_WALL_HANDLES = 16;

const IDENTITY = new THREE.Matrix4();
/** Turns that land within 3° of a 15° step snap to it: a fingertip can't hold Shift, so the common angles come to you. */
const magnet15 = (deg: number) => {
  const near = Math.round(deg / 15) * 15;
  return Math.abs(deg - near) <= 3 ? near : deg;
};
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const signed = (n: number) => `${n >= 0 ? '+' : '−'}${Math.abs(n)}`;

function distanceToSegment2D(px: number, py: number, ax: number, ay: number, bx: number, by: number) {
  const dx = bx - ax;
  const dy = by - ay;
  const len2 = dx * dx + dy * dy;
  const t = len2 === 0 ? 0 : clamp(((px - ax) * dx + (py - ay) * dy) / len2, 0, 1);
  return { distance: Math.hypot(px - (ax + t * dx), py - (ay + t * dy)), t };
}

/** Fat lines need the viewport size to draw at a pixel width; every live one is tracked here. */
const lineMaterials = new Set<LineMaterial>();
const viewportSize = new THREE.Vector2(1, 1);

function makeFatLine(points: { x: number; y: number; z: number }[], color: string, widthPx: number) {
  const geometry = new LineGeometry();
  geometry.setPositions(points.flatMap((p) => [p.x, p.y, p.z]));
  const material = new LineMaterial({
    color: new THREE.Color(color).getHex(),
    linewidth: widthPx,
    resolution: viewportSize.clone(),
  });
  // Pull selection lines slightly toward the camera so they never fight with the surface they lie on.
  material.polygonOffset = true;
  material.polygonOffsetFactor = -4;
  material.polygonOffsetUnits = -4;
  lineMaterials.add(material);
  const line = new Line2(geometry, material);
  line.computeLineDistances();
  line.renderOrder = 20;
  return line;
}

// Handle geometry and materials are built once and shared; they are never disposed.
const shared = <T extends THREE.BufferGeometry | THREE.Material>(item: T): T => {
  item.userData.shared = true;
  return item;
};
const HANDLE = {
  dot: shared(new THREE.SphereGeometry(1, 16, 12)),
  shaft: shared(new THREE.CylinderGeometry(1.1, 1.1, 18, 12)),
  head: shared(new THREE.ConeGeometry(4.2, 9, 20)),
  arrowHit: shared(new THREE.CylinderGeometry(11, 11, 40, 12)),
};
const handleMaterials = new Map<string, THREE.MeshBasicMaterial>();
const handleMaterial = (color: string, opacity = 1, depthTest = false) => {
  const key = `${color}:${opacity}:${depthTest}`;
  let m = handleMaterials.get(key);
  if (!m) {
    m = shared(new THREE.MeshBasicMaterial({ color, depthTest, transparent: true, opacity }));
    handleMaterials.set(key, m);
  }
  return m;
};
const hiddenMaterial = shared(new THREE.MeshBasicMaterial({ visible: false }));

function disposeObject(root: THREE.Object3D) {
  root.traverse((obj) => {
    const o = obj as THREE.Mesh;
    if (o.geometry && !o.geometry.userData.shared) o.geometry.dispose();
    // A shape's see-through twin is not on the mesh while it is hidden: let go of it too.
    (o.userData?.ghost as THREE.Material | undefined)?.dispose();
    const m = o.material;
    const dispose = (mat: THREE.Material) => {
      if (mat.userData.shared) return;
      if (mat instanceof LineMaterial) lineMaterials.delete(mat);
      mat.dispose();
    };
    if (Array.isArray(m)) m.forEach(dispose);
    else if (m) dispose(m);
  });
}

/** Copies the triangles of `source` that pass `test` (flat-shaded normal + centroid), nudged along `lift`. */
function pickTriangles(
  source: THREE.BufferGeometry,
  test: (n: THREE.Vector3, c: THREE.Vector3) => boolean,
  lift: THREE.Vector3
): THREE.BufferGeometry {
  const pos = source.getAttribute('position');
  const idx = source.getIndex();
  const count = idx ? idx.count : pos.count;
  const a = new THREE.Vector3();
  const b = new THREE.Vector3();
  const c = new THREE.Vector3();
  const n = new THREE.Vector3();
  const centroid = new THREE.Vector3();
  const out: number[] = [];
  for (let i = 0; i + 2 < count; i += 3) {
    a.fromBufferAttribute(pos, idx ? idx.getX(i) : i);
    b.fromBufferAttribute(pos, idx ? idx.getX(i + 1) : i + 1);
    c.fromBufferAttribute(pos, idx ? idx.getX(i + 2) : i + 2);
    n.subVectors(c, b).cross(centroid.subVectors(a, b));
    if (n.lengthSq() < 1e-12) continue;
    n.normalize();
    centroid.copy(a).add(b).add(c).multiplyScalar(1 / 3);
    if (!test(n, centroid)) continue;
    [a, b, c].forEach((v) => out.push(v.x + lift.x, v.y + lift.y, v.z + lift.z));
  }
  return new THREE.BufferGeometry().setAttribute('position', new THREE.Float32BufferAttribute(out, 3));
}

function clearGroup(group: THREE.Group) {
  while (group.children.length) {
    const child = group.children[0];
    group.remove(child);
    disposeObject(child);
  }
}

function createMaterial(body: Body3D): THREE.Material {
  const preset = MATERIAL_PRESETS.find((p) => p.id === body.materialType) || MATERIAL_PRESETS[0];
  const color = body.color || preset.color;
  const common = {
    color,
    roughness: preset.roughness,
    metalness: preset.metalness,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  };
  switch (body.materialType) {
    case 'glossy':
      return new THREE.MeshPhysicalMaterial({ ...common, clearcoat: 1, clearcoatRoughness: 0.08 });
    case 'glass':
      return new THREE.MeshPhysicalMaterial({
        ...common,
        transmission: preset.transmission ?? 0.8,
        ior: preset.ior ?? 1.5,
        thickness: 8,
        transparent: true,
        opacity: 0.92,
      });
    case 'neon':
      return new THREE.MeshStandardMaterial({
        ...common,
        emissive: color,
        emissiveIntensity: preset.emissiveIntensity ?? 1.2,
      });
    default:
      return new THREE.MeshStandardMaterial(common);
  }
}

/** Stands a shape on its wall (or leaves it upright). */
function placeFrame(root: THREE.Group, body: Body3D) {
  root.matrixAutoUpdate = false;
  if (body.frame) root.matrix.copy(frameMatrix(body.frame));
  else root.matrix.identity();
  root.matrixWorldNeedsUpdate = true;
}

const bodySignature = (b: Body3D) =>
  JSON.stringify([
    b.points,
    b.basePoints,
    b.cornerRadii,
    b.holes,
    b.extrusionHeight,
    b.elevation,
    b.edgeBevels,
    b.cornerBevels,
    b.materialType,
    b.color,
  ]);

interface BodyEntry {
  body: Body3D;
  /** Carries the wall frame (identity for upright shapes); `group` inside it takes drag previews in the shape's own space. */
  root: THREE.Group;
  group: THREE.Group;
  outline: THREE.LineSegments;
  signature: string;
}

export default function ModelViewer3D({
  apiRef,
  bodies,
  groups,
  selectedBodyId,
  selectedBodyIds,
  onSelectBody,
  onUpdateBody,
  onTransformBodies,
  selectedEdges,
  onSelectEdges,
  selectedFace,
  onSelectFace,
  onEdgeChange,
  repeat,
  onUpdateRepeat,
  onFinishRepeat,
  xray,
  onToggleXray,
  draw,
  onUpdateDraw,
  onFinishDraw,
  onNotify,
  onDrawForm,
  onDrawDone,
  onDrawCancel,
  onDrawUndoCorner,
  onDrawCut,
  onRepeatCancel,
  onDragStateChange,
  onHint,
  moveOn,
  onToggleMove,
  onFaceValue,
}: ModelViewer3DProps) {
  const mountRef = useRef<HTMLDivElement | null>(null);
  const [isSceneReady, setIsSceneReady] = useState(false);
  /** Body whose bevel cuts are skipped while its outline is being dragged. */
  const [fastId, setFastId] = useState<string | null>(null);
  const [dragLabel, setDragLabel] = useState<{ text: string; x: number; y: number } | null>(null);

  const cameraRef = useRef<THREE.PerspectiveCamera | null>(null);
  const bodyGroupRef = useRef<THREE.Group | null>(null);
  const gizmoGroupRef = useRef<THREE.Group | null>(null);
  const helperGroupRef = useRef<THREE.Group | null>(null);
  const previewGroupRef = useRef<THREE.Group | null>(null);
  const entriesRef = useRef<Map<string, BodyEntry>>(new Map());
  const heightArrowRef = useRef<THREE.Object3D | null>(null);
  const panelRef = useRef<HTMLDivElement | null>(null);
  /** Where the floating panel is pinned: a world point, plus how far above it (px) the card floats. */
  const anchorRef = useRef<{ pos: THREE.Vector3; lift: number } | null>(null);
  const gizmoFrameRef = useRef<THREE.Group | null>(null);
  const drawApiRef = useRef<DrawApi | null>(null);
  const drawToolRef = useRef<ReturnType<typeof createDrawTool> | null>(null);
  const repeatAnchorRef = useRef<THREE.Vector3 | null>(null);
  const repeatChipRef = useRef<HTMLDivElement | null>(null);
  const mmPerPixelRef = useRef<() => number>(() => 1);
  const tipRef = useRef(0);
  const [pickerOpen, setPickerOpen] = useState(false);
  /** Where a press-and-hold is filling its ring, in viewer pixels. */
  const [hold, setHold] = useState<{ x: number; y: number } | null>(null);
  /** The number for the face being worked on; it fades 3 seconds after the last change. */
  const [readout, setReadout] = useState<{ key: string; label: string; value: number } | null>(null);
  const readoutTimer = useRef(0);
  const readoutHold = useRef(false);
  const showReadout = useCallback((key: string, label: string, value: number) => {
    setReadout({ key, label, value });
    window.clearTimeout(readoutTimer.current);
    if (!readoutHold.current) readoutTimer.current = window.setTimeout(() => setReadout(null), 3000);
  }, []);
  const holdReadout = useCallback((hold: boolean) => {
    readoutHold.current = hold;
    window.clearTimeout(readoutTimer.current);
    if (!hold) readoutTimer.current = window.setTimeout(() => setReadout(null), 3000);
  }, []);
  const pickerDrag = useRef<{ startY: number; start: number; sels: EdgeSel[]; limit: number } | null>(null);
  const placePanelRef = useRef<() => void>(() => {});
  /** When the handles last popped in (ms), and the selection they popped in for. */
  const popRef = useRef<{ start: number } | null>(null);
  const popKeyRef = useRef('');
  const invalidateRef = useRef<(shadows?: boolean) => void>(() => {});
  const refreshOutlinesRef = useRef<() => void>(() => {});
  const applyXrayRef = useRef<() => void>(() => {});
  const clearHoverRef = useRef<() => void>(() => {});
  const frameViewRef = useRef<(face: CubeFace | 'keep', instant?: boolean, from?: THREE.Vector3, focus?: { center: THREE.Vector3; radius: number }) => void>(() => {});
  const knownIdsRef = useRef<Set<string> | null>(null);
  const tweenRef = useRef<{
    start: number;
    fromPos: THREE.Vector3;
    toPos: THREE.Vector3;
    fromTarget: THREE.Vector3;
    toTarget: THREE.Vector3;
  } | null>(null);

  // Latest props for long-lived event handlers
  const live = useRef({} as ModelViewer3DProps);
  live.current = {
    apiRef,
    bodies,
    groups: groups ?? [],
    selectedBodyId,
    selectedBodyIds,
    selectedEdges,
    selectedFace,
    onSelectFace,
    repeat,
    onSelectBody,
    onUpdateBody,
    onTransformBodies,
    onSelectEdges,
    onEdgeChange,
    onUpdateRepeat,
    onFinishRepeat,
    xray,
    onToggleXray,
    draw,
    onUpdateDraw,
    onFinishDraw,
    onNotify,
    onDrawForm,
    onDrawDone,
    onDrawCancel,
    onDrawUndoCorner,
    onDrawCut,
    onRepeatCancel,
    onDragStateChange,
    onHint,
    moveOn,
    onToggleMove,
    onFaceValue,
  };

  // ---- Scene setup (once) -------------------------------------------------
  useEffect(() => {
    const container = mountRef.current;
    if (!container) return;

    const width = container.clientWidth || 600;
    const height = container.clientHeight || 500;

    const scene = new THREE.Scene();
    // The background follows the theme (Autora sends its own when this is its window).
    scene.background = new THREE.Color(getComputedStyle(document.documentElement).getPropertyValue('--color-slate-950').trim() || BACKGROUND);
    scene.fog = new THREE.Fog(BACKGROUND, 900, 2800);

    const camera = new THREE.PerspectiveCamera(40, width / height, 1, 4000);
    cameraRef.current = camera;

    const renderer = new THREE.WebGLRenderer({ antialias: true, powerPreference: 'high-performance' });
    const fullRatio = Math.min(window.devicePixelRatio, 2);
    renderer.setSize(width, height);
    renderer.setPixelRatio(fullRatio);
    renderer.toneMapping = THREE.ACESFilmicToneMapping;
    renderer.toneMappingExposure = 0.95;
    renderer.shadowMap.enabled = true;
    renderer.shadowMap.type = THREE.PCFShadowMap;
    // Shadows only change when something moves, so they are redrawn on request.
    renderer.shadowMap.autoUpdate = false;
    renderer.domElement.style.touchAction = 'none';
    renderer.domElement.style.display = 'block';
    container.appendChild(renderer.domElement);
    viewportSize.set(width, height);

    // Image-based lighting: without an environment map, metals render near-black.
    const pmrem = new THREE.PMREMGenerator(renderer);
    const envTexture = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    scene.environment = envTexture;
    scene.environmentIntensity = 0.55;

    const key = new THREE.DirectionalLight('#ffffff', 1.15);
    key.position.set(240, 420, 260);
    key.castShadow = true;
    key.shadow.mapSize.set(1536, 1536);
    key.shadow.camera.near = 50;
    key.shadow.camera.far = 1400;
    key.shadow.camera.left = -420;
    key.shadow.camera.right = 420;
    key.shadow.camera.top = 420;
    key.shadow.camera.bottom = -420;
    key.shadow.bias = -0.0005;
    key.shadow.normalBias = 0.6;
    scene.add(key);

    const shadowCatcher = new THREE.Mesh(
      new THREE.PlaneGeometry(2400, 2400).rotateX(-Math.PI / 2),
      new THREE.ShadowMaterial({ opacity: 0.35 })
    );
    shadowCatcher.position.y = -0.05;
    shadowCatcher.receiveShadow = true;
    scene.add(shadowCatcher);

    const grid = new THREE.GridHelper(1200, 60, '#252a3b', '#151824');
    grid.position.y = -0.1;
    scene.add(grid);

    const axis = (to: THREE.Vector3, color: string) =>
      new THREE.Line(
        new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(0, 0.05, 0), to]),
        new THREE.LineBasicMaterial({ color })
      );
    const axisX = axis(new THREE.Vector3(140, 0.05, 0), '#fb7185');
    const axisY = axis(new THREE.Vector3(0, 0.05, -140), '#34d399');
    scene.add(axisX, axisY);

    const bodyGroup = new THREE.Group();
    const helperGroup = new THREE.Group();
    const hoverGroup = new THREE.Group();
    const gizmoGroup = new THREE.Group();
    const previewGroup = new THREE.Group();
    // Handles for a wall shape are built in its own space; this carries them onto its wall.
    const gizmoFrame = new THREE.Group();
    gizmoFrame.matrixAutoUpdate = false;
    gizmoFrame.add(helperGroup, gizmoGroup);
    gizmoFrameRef.current = gizmoFrame;
    scene.add(bodyGroup, gizmoFrame, hoverGroup, previewGroup);
    bodyGroupRef.current = bodyGroup;
    gizmoGroupRef.current = gizmoGroup;
    helperGroupRef.current = helperGroup;
    previewGroupRef.current = previewGroup;

    // ---- On-demand rendering and adaptive resolution ----------------------
    let needsRender = true;
    let shadowsDirty = true;
    const invalidate = (shadows = false) => {
      needsRender = true;
      if (shadows) shadowsDirty = true;
    };
    invalidateRef.current = invalidate;

    let qualityTimer = 0;
    const lowerQualityWhileBusy = () => {
      if (fullRatio > 1 && renderer.getPixelRatio() !== 1) renderer.setPixelRatio(1);
      window.clearTimeout(qualityTimer);
      qualityTimer = window.setTimeout(() => {
        if (renderer.getPixelRatio() !== fullRatio) {
          renderer.setPixelRatio(fullRatio);
          invalidate();
        }
      }, 220);
    };

    const raycaster = new THREE.Raycaster();
    const ndc = new THREE.Vector2();
    const setRay = (clientX: number, clientY: number) => {
      const rect = renderer.domElement.getBoundingClientRect();
      ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1);
      raycaster.setFromCamera(ndc, camera);
    };
    /** Where the pointer's ray meets the horizontal plane at `planeY`; with a wall frame, the plane and the answer are in the wall shape's own space. */
    const intersectPlane = (clientX: number, clientY: number, planeY: number, frame?: THREE.Matrix4): THREE.Vector3 | null => {
      setRay(clientX, clientY);
      const ray = frame ? raycaster.ray.clone().applyMatrix4(frame.clone().invert()) : raycaster.ray;
      const point = new THREE.Vector3();
      return ray.intersectPlane(new THREE.Plane(new THREE.Vector3(0, 1, 0), -planeY), point) ? point : null;
    };
    const frameOfBody = (b?: Body3D) => (b?.frame ? frameMatrix(b.frame) : undefined);
    /** Which way along the screen a wall shape's height grows, so dragging along its arrow extrudes it. */
    const axisScreenFor = (b: Body3D): { x: number; y: number } | undefined => {
      if (!b.frame) return undefined;
      const m = frameMatrix(b.frame);
      const n = frameNormal(b.frame);
      const top = (b.elevation ?? 0) + b.extrusionHeight;
      const p0 = new THREE.Vector3(0, top, 0).applyMatrix4(m);
      const p1 = p0.clone().addScaledVector(n, 40);
      const rect = renderer.domElement.getBoundingClientRect();
      const a = p0.clone().project(camera);
      const c = p1.clone().project(camera);
      const dx = ((c.x - a.x) * rect.width) / 2;
      const dy = (-(c.y - a.y) * rect.height) / 2;
      const len = Math.hypot(dx, dy);
      // Looking straight at the wall the arrow points at you: fall back to dragging up the screen.
      return len < 6 ? { x: 0, y: -1 } : { x: dx / len, y: dy / len };
    };
    /** How far the pointer has moved along the grow direction (pixels, positive = taller). */
    const alongGrow = (d: Drag, m: { x: number; y: number }) => (d.axisScreen ? (m.x - (d.startClientX ?? m.x)) * d.axisScreen.x + (m.y - d.startClientY) * d.axisScreen.y : d.startClientY - m.y);

    // ---- Edge picking (screen-space distance to each edge's polyline) -----
    let pickPx = EDGE_PICK_PX;
    const pickEdge = (clientX: number, clientY: number): EdgeSel | null => {
      const rect = renderer.domElement.getBoundingClientRect();
      const px = clientX - rect.left;
      const py = clientY - rect.top;
      camera.updateMatrixWorld();
      const candidates: { sel: EdgeSel; dist: number; point: THREE.Vector3 }[] = [];
      const a = new THREE.Vector3();
      const b = new THREE.Vector3();

      for (const body of live.current.bodies) {
        if (!body.visible || body.repeatOf || body.frame) continue; // a live copy is picked through its shape; wall shapes have no bevels yet
        for (const edge of listEdges(body)) {
          let best = Infinity;
          let bestPoint: THREE.Vector3 | null = null;
          for (let i = 0; i + 1 < edge.points.length; i++) {
            const p = edge.points[i];
            const q = edge.points[i + 1];
            a.set(p.x, p.y, p.z).project(camera);
            b.set(q.x, q.y, q.z).project(camera);
            if (a.z > 1 || b.z > 1) continue;
            const ax = (a.x * 0.5 + 0.5) * rect.width;
            const ay = (-a.y * 0.5 + 0.5) * rect.height;
            const bx = (b.x * 0.5 + 0.5) * rect.width;
            const by = (-b.y * 0.5 + 0.5) * rect.height;
            // Cheap reject before the exact distance.
            if (Math.min(ax, bx) - pickPx > px || Math.max(ax, bx) + pickPx < px) continue;
            if (Math.min(ay, by) - pickPx > py || Math.max(ay, by) + pickPx < py) continue;
            const { distance, t } = distanceToSegment2D(px, py, ax, ay, bx, by);
            if (distance < best) {
              best = distance;
              bestPoint = new THREE.Vector3(p.x + (q.x - p.x) * t, p.y + (q.y - p.y) * t, p.z + (q.z - p.z) * t);
            }
          }
          if (bestPoint && best <= pickPx) {
            candidates.push({ sel: { bodyId: body.id, kind: edge.kind, index: edge.index }, dist: best, point: bestPoint });
          }
        }
      }
      candidates.sort((c1, c2) => c1.dist - c2.dist);

      // Skip edges hidden behind the body (in see-through mode nothing hides anything).
      for (const c of candidates.slice(0, 6)) {
        if (live.current.xray) return c.sel;
        const toPoint = c.point.clone().sub(camera.position);
        const dist = toPoint.length();
        raycaster.set(camera.position, toPoint.normalize());
        const hit = raycaster.intersectObjects(bodyGroup.children, true)[0];
        if (!hit || hit.distance >= dist - 1.2) return c.sel;
      }
      return null;
    };

    /** Which face of the shape a ray hit: top, bottom, or the wall whose flat side is nearest. */
    const faceAt = (bodyId: string, hit: THREE.Intersection, at: THREE.Vector3 = hit.point): FaceSel => {
      const ny = hit.face?.normal.y ?? 0;
      if (ny > 0.75) return { bodyId, kind: 'top' };
      if (ny < -0.75) return { bodyId, kind: 'bottom' };
      const body = live.current.bodies.find((b) => b.id === bodyId);
      let best = -1;
      let bestDist = Infinity;
      if (body) {
        const walls = [...getBase(body).map((_, j) => j), ...holeLoops(body).flatMap((l, h) => l.base.map((_, j) => holeIndex(h, j)))];
        walls.forEach((j) => {
          const ends = wallEnds(body, j);
          if (!ends) return;
          const { distance } = distanceToSegment2D(at.x, -at.z, ends.a.x, ends.a.y, ends.b.x, ends.b.y);
          if (distance < bestDist) {
            bestDist = distance;
            best = j;
          }
        });
      }
      return best >= 0 ? { bodyId, kind: 'wall', index: best } : { bodyId, kind: 'top' };
    };

    // ---- Hit testing: handles first, then edges, then solids ---------------
    /** Which shape a ray at this spot picks: the nearest; in see-through mode the smallest (the one inside); Alt-click, the next one behind. */
    const chooseBodyHit = (hits: THREE.Intersection[], behind: boolean): THREE.Intersection | undefined => {
      const meshes = hits.filter((h) => h.object instanceof THREE.Mesh);
      const rootOf = (h: THREE.Intersection) => {
        let obj: THREE.Object3D | null = h.object;
        while (obj && !obj.userData.bodyId) obj = obj.parent;
        const id: string | undefined = obj?.userData.bodyId;
        return id ? bodyOf(id)?.repeatOf ?? id : undefined;
      };
      const firstPerShape = new Map<string, THREE.Intersection>();
      meshes.forEach((h) => {
        const id = rootOf(h);
        if (id && !firstPerShape.has(id)) firstPerShape.set(id, h);
      });
      const stack = [...firstPerShape.entries()];
      if (!stack.length) return undefined;
      if (behind) {
        const sel = live.current.selectedBodyIds;
        const at = stack.findIndex(([id]) => sel.includes(id));
        return stack[(at + 1) % stack.length][1];
      }
      if (live.current.xray && stack.length > 1) {
        const volume = (id: string) => {
          const b = bodyOf(id);
          const bb = b && selectionBounds([b]);
          return b && bb ? (bb.maxX - bb.minX) * (bb.maxY - bb.minY) * b.extrusionHeight : Infinity;
        };
        return stack.reduce((best, cur) => (volume(cur[0]) < volume(best[0]) ? cur : best))[1];
      }
      return stack[0][1];
    };

    const resolveHit = (clientX: number, clientY: number, behind = false): Hit | null => {
      setRay(clientX, clientY);

      if (live.current.repeat) {
        const handleHit = raycaster.intersectObjects(previewGroup.children, true).find((h) => h.object.userData.repeatHandle || h.object.parent?.userData.repeatHandle);
        const handle = handleHit && (handleHit.object.userData.repeatHandle ? handleHit.object : handleHit.object.parent!);
        return handle ? { type: 'gizmo', gizmo: handle.userData.repeatHandle === 'end' ? 'repeat-end' : 'repeat-bend' } : null;
      }

      if (gizmoGroup.visible && gizmoGroup.children.length) {
        const gizmoHit = raycaster.intersectObjects(gizmoGroup.children, true)[0];
        if (gizmoHit) {
          let obj: THREE.Object3D | null = gizmoHit.object;
          while (obj && !obj.userData.gizmo) obj = obj.parent;
          // The rotation halo lies on the floor: where a shape stands in front of it, the shape wins.
          const hiddenBehindShape =
            obj?.userData.gizmo === 'rotate' && (raycaster.intersectObjects(bodyGroup.children, true)[0]?.distance ?? Infinity) < gizmoHit.distance;
          if (obj && !hiddenBehindShape) {
            return { type: 'gizmo', gizmo: obj.userData.gizmo, bodyId: obj.userData.bodyId, index: obj.userData.index, axis: obj.userData.axis };
          }
        }
      }

      // Alt-click is about shapes, not edges: it goes straight to the one behind.
      const sel = behind ? null : pickEdge(clientX, clientY);
      if (sel) return { type: 'edge', sel };
      setRay(clientX, clientY);

      const hit = chooseBodyHit(raycaster.intersectObjects(bodyGroup.children, true), behind);
      if (!hit) return null;
      let obj: THREE.Object3D | null = hit.object;
      while (obj && !obj.userData.bodyId) obj = obj.parent;
      if (!obj) return null;
      const hitId: string = obj.userData.bodyId;
      // The point is kept in the shape's own space, so dragging works the same on a wall shape.
      const local = entriesRef.current.get(hitId)?.root.worldToLocal(hit.point.clone()) ?? hit.point.clone();
      const face = faceAt(hitId, hit, local);
      // Touching a live copy is touching the shape it follows: that is the one that can be edited.
      const bodyId = bodyOf(hitId)?.repeatOf ?? hitId;
      return { type: 'body', bodyId, point: local, face: { ...face, bodyId } };
    };

    // ---- Hover feedback ----------------------------------------------------
    let hoverEdgeKey: string | null = null;
    let hoverBodyId: string | null = null;
    let lastHint = '';
    const showHint = (text: string) => {
      if (text !== lastHint) {
        lastHint = text;
        live.current.onHint?.(text);
      }
    };

    const setHoverEdge = (sel: EdgeSel | null) => {
      const k = sel ? edgeKey(sel) : null;
      if (k === hoverEdgeKey) return;
      hoverEdgeKey = k;
      clearGroup(hoverGroup);
      if (sel) {
        const body = live.current.bodies.find((b) => b.id === sel.bodyId);
        const edge = body && listEdges(body).find((e) => e.kind === sel.kind && e.index === sel.index);
        if (edge) hoverGroup.add(makeFatLine(edge.points, ACCENT_LIGHT, 4));
      }
      invalidate();
    };
    clearHoverRef.current = () => {
      setHoverEdge(null);
      if (hoverBodyId) {
        hoverBodyId = null;
        refreshOutlines();
      }
    };

    const refreshOutlines = () => {
      const { selectedBodyIds: ids, selectedBodyId: id } = live.current;
      entriesRef.current.forEach((entry, bodyId) => {
        const root = entry.body.repeatOf ?? bodyId;
        const selected = root === id || ids.includes(root);
        const hovered = root === hoverBodyId;
        const see = live.current.xray;
        entry.outline.visible = selected || hovered || see;
        const line = entry.outline.material as THREE.LineBasicMaterial;
        line.opacity = selected ? 1 : see ? 0.6 : 0.45;
        // What is selected shows through whatever covers it, so a shape buried inside another is never lost.
        line.depthTest = !selected;
        entry.outline.renderOrder = selected ? 36 : 0;
        const mesh = entry.group.children[0] as THREE.Mesh;
        const ghost = mesh.userData.ghost as THREE.MeshStandardMaterial | undefined;
        if (ghost) ghost.opacity = selected ? 0.42 : 0.2;
      });
      invalidate();
    };
    refreshOutlinesRef.current = refreshOutlines;

    /** Swaps every shape between solid and see-through. */
    const applyXray = () => {
      const see = live.current.xray;
      entriesRef.current.forEach((entry) => {
        const mesh = entry.group.children[0] as THREE.Mesh;
        mesh.material = see ? mesh.userData.ghost : mesh.userData.solid;
        mesh.castShadow = !see;
        mesh.receiveShadow = !see;
      });
      refreshOutlines();
      invalidate(true);
    };
    applyXrayRef.current = applyXray;

    const idleHint = () => {
      if (live.current.xray && !live.current.selectedBodyIds.length) return 'See-through is on: tap anything, even inside another shape · X turns it off';
      if (live.current.draw) return 'Tap to place corners · drag a side to curve it · tap the green corner to finish';
      if (live.current.repeat) return 'Drag a dot to place the copies · − + sets how many · Enter keeps them · Esc cancels';
      if (live.current.moveOn && live.current.selectedBodyIds.length) return 'Drag an arrow to move along X, Y or Z · two-finger tap to hide';
      const f = live.current.selectedFace;
      if (f) return 'Drag the highlighted face (or its arrow) to extrude it · drag the rest of the shape to move it';
      return live.current.selectedBodyIds.length
        ? 'Drag to move · hold another shape to add it · arrow = height · dots = walls · ring = rotate'
        : 'Click a shape to select it · drag empty space to orbit';
    };

    const hover = (clientX: number, clientY: number) => {
      if (drag || candidate || live.current.draw) return;
      const hit = resolveHit(clientX, clientY);
      setHoverEdge(hit?.type === 'edge' ? hit.sel : null);
      const bodyHover = hit?.type === 'body' ? hit.bodyId : hit?.type === 'edge' ? hit.sel.bodyId : null;
      if (bodyHover !== hoverBodyId) {
        hoverBodyId = bodyHover;
        refreshOutlines();
      }

      let cursor = 'default';
      let text = idleHint();
      if (hit?.type === 'gizmo' && (hit.gizmo === 'repeat-end' || hit.gizmo === 'repeat-bend')) {
        cursor = 'grab';
        text = hit.gizmo === 'repeat-end' ? 'Drag to set where the copies end' : 'Drag to bend the path';
      } else if (hit?.type === 'gizmo') {
        cursor = hit.gizmo === 'move-axis' ? (hit.axis === 'z' ? 'ns-resize' : 'ew-resize') : hit.gizmo === 'extrude-height' || hit.gizmo === 'extrude-bottom' || hit.gizmo === 'edge-size' ? 'ns-resize' : 'grab';
        text =
          hit.gizmo === 'move-axis'
            ? `Drag to move along ${hit.axis?.toUpperCase()}`
            : hit.gizmo === 'extrude-height'
            ? 'Drag to change the height'
            : hit.gizmo === 'extrude-bottom'
              ? 'Drag to extend the bottom face'
            : hit.gizmo === 'scale-corner'
              ? 'Drag to resize the shape · hold Shift to keep its proportions'
            : hit.gizmo === 'offset-wall'
              ? 'Drag to push or pull this wall'
              : hit.gizmo === 'edge-size'
                ? 'Tap to choose curved or flat · drag to change the size'
                : 'Drag to rotate';
      } else if (hit?.type === 'edge') {
        cursor = 'pointer';
        text = 'Click to select this edge and bevel it · drag to move the shape';
      } else if (hit?.type === 'body') {
        const onSelectedFace = sameFace(live.current.selectedFace, hit.face);
        cursor = onSelectedFace ? 'ns-resize' : 'move';
        text = onSelectedFace
          ? 'Drag to extrude this face'
          : live.current.selectedBodyIds.includes(hit.bodyId)
            ? 'Click to select this face · drag to move · click an edge to bevel it'
            : 'Click to select this face · drag to move the shape';
      }
      renderer.domElement.style.cursor = cursor;
      showHint(text);
    };

    // ---- Drag sessions ----------------------------------------------------
    let drag: Drag | null = null;
    let candidate: { x: number; y: number; hit: Hit | null; pointerId: number } | null = null;
    let pending: { x: number; y: number; shift: boolean } | null = null;
    let pendingHover: { x: number; y: number } | null = null;

    const mmPerPixel = () => {
      const dist = camera.position.distanceTo(controls.target);
      return (2 * dist * Math.tan(THREE.MathUtils.degToRad(camera.fov / 2))) / (renderer.domElement.clientHeight || 1);
    };
    mmPerPixelRef.current = mmPerPixel;

    const resetPreviews = () => {
      entriesRef.current.forEach((entry) => {
        entry.group.position.set(0, 0, 0);
        entry.group.rotation.set(0, 0, 0);
        entry.group.scale.set(1, 1, 1);
      });
    };

    const bodyOf = (id?: string) => live.current.bodies.find((b) => b.id === id);

    /** Bodies that move together when `id` is dragged: the selection if it includes it, else its group. */
    const movingSet = (id: string): string[] => {
      const { selectedBodyIds: sel, bodies: all } = live.current;
      if (sel.includes(id)) return withCopies(sel, all);
      return withCopies(withGroupMates(live.current.groups, all, id), all);
    };

    const restoreGizmos = () => {
      gizmoGroup.visible = true;
      helperGroup.visible = true;
      gizmoGroup.children.forEach((c) => (c.visible = true));
    };

    const beginDrag = (d: Drag, pointerId: number) => {
      drag = d;
      window.clearTimeout(longPress);
      setHold(null);
      controls.enabled = false;
      renderer.domElement.setPointerCapture(pointerId);
      // Show only the handle being dragged; the rest would be stale until the edit lands.
      gizmoGroup.visible = d.kind === 'repeat' || d.kind === 'height' || d.kind === 'bottom' || d.kind === 'edge-size' || d.kind === 'axis';
      helperGroup.visible = d.kind === 'edge-size';
      if (d.kind === 'height' || d.kind === 'bottom') gizmoGroup.children.forEach((c) => (c.visible = c === heightArrowRef.current));
      setHoverEdge(null);
      if (d.kind === 'wall' || d.kind === 'corner') setFastId(d.bodyId ?? null);
      if (d.kind === 'height' || d.kind === 'bottom' || d.kind === 'wall') holdReadout(true);
      live.current.onDragStateChange?.(true);
      invalidate(true);
    };

    const wallDrag = (body: Body3D, index: number, e: { clientX: number; clientY: number }): Drag | null => {
      const ends = wallEnds(body, index);
      if (!ends) return null;
      const planeY = (body.elevation ?? 0) + body.extrusionHeight / 2;
      const m0 = faceMeasure(body, { bodyId: body.id, kind: 'wall', index });
      return {
        measure0: m0?.value,
        measureLabel: m0?.label,
        startClientY: e.clientY,
        mmPerPixel: mmPerPixel(),
        kind: 'wall',
        bodyId: body.id,
        index,
        initialBase: wallBase(body, index).map((p) => ({ ...p })),
        normal: outwardNormal(ends.a, ends.b, ends.winding),
        planeY,
        frame: frameOfBody(body),
        startPoint: intersectPlane(e.clientX, e.clientY, planeY, frameOfBody(body)) ?? undefined,
      };
    };

    /** Corner handles sit at the corners of the footprint's bounding box; the opposite corner stays put. */
    const cornerDrag = (body: Body3D, index: number, e: { clientX: number; clientY: number }): Drag | null => {
      const b = selectionBounds([body]);
      if (!b) return null;
      const xs = [b.minX, b.maxX, b.maxX, b.minX];
      const ys = [b.minY, b.minY, b.maxY, b.maxY];
      const planeY = body.elevation ?? 0;
      return {
        startClientY: e.clientY,
        mmPerPixel: mmPerPixel(),
        kind: 'corner',
        bodyId: body.id,
        index,
        planeY,
        initialBody: body,
        corner0: { x: xs[index], y: ys[index] },
        anchor: { x: xs[(index + 2) % 4], y: ys[(index + 2) % 4] },
        frame: frameOfBody(body),
        startPoint: intersectPlane(e.clientX, e.clientY, planeY, frameOfBody(body)) ?? undefined,
      };
    };

    /** Dragging a selected face pulls that face out (or pushes it in). */
    const faceDrag = (face: FaceSel, e: { clientX: number; clientY: number }): Drag | null => {
      const body = bodyOf(face.bodyId);
      if (!body) return null;
      const common = { startClientY: e.clientY, startClientX: e.clientX, mmPerPixel: mmPerPixel(), bodyId: body.id, axisScreen: axisScreenFor(body) };
      if (face.kind === 'top') return { ...common, kind: 'height', initialHeight: body.extrusionHeight, nextHeight: body.extrusionHeight };
      if (face.kind === 'bottom') {
        return { ...common, kind: 'bottom', initialElevation: body.elevation ?? 0, initialHeight: body.extrusionHeight, nextDelta: 0 };
      }
      return face.index === undefined ? null : wallDrag(body, face.index, e);
    };

    const startGizmoDrag = (hit: Extract<Hit, { type: 'gizmo' }>, e: PointerEvent): Drag | null => {
      const body = bodyOf(hit.bodyId);
      const common = { startClientY: e.clientY, startClientX: e.clientX, mmPerPixel: mmPerPixel() };
      switch (hit.gizmo) {
        case 'repeat-end':
        case 'repeat-bend': {
          const r = live.current.repeat;
          const src = bodyOf(r?.bodyId);
          if (!r || !src) return null;
          return { ...common, kind: 'repeat', repeatHandle: hit.gizmo === 'repeat-end' ? 'end' : 'bend', planeY: (src.elevation ?? 0) + src.extrusionHeight, frame: frameOfBody(src) };
        }
        case 'extrude-height':
          return body ? { ...common, axisScreen: axisScreenFor(body), kind: 'height', bodyId: body.id, initialHeight: body.extrusionHeight, nextHeight: body.extrusionHeight } : null;
        case 'move-axis': {
          const ids = withCopies(live.current.selectedBodyIds, live.current.bodies);
          const picked = ids.map((i) => bodyOf(i)).filter((b): b is Body3D => !!b);
          const bounds = selectionBounds(picked);
          if (!bounds || !hit.axis) return null;
          const top = Math.max(...picked.map((b) => (b.elevation ?? 0) + b.extrusionHeight));
          const planeY = (bounds.minElevation + top) / 2;
          return {
            ...common,
            kind: 'axis',
            axis: hit.axis,
            ids,
            center: { x: bounds.centerX, y: bounds.centerY },
            planeY,
            minLift: bounds.minElevation,
            startPoint: intersectPlane(e.clientX, e.clientY, planeY) ?? undefined,
            dx: 0,
            dy: 0,
            dz: 0,
          };
        }
        case 'extrude-bottom':
          return body ? { ...common, axisScreen: axisScreenFor(body), kind: 'bottom', bodyId: body.id, initialElevation: body.elevation ?? 0, initialHeight: body.extrusionHeight, nextDelta: 0 } : null;
        case 'offset-wall':
          return body && hit.index !== undefined ? wallDrag(body, hit.index, e) : null;
        case 'scale-corner':
          return body && hit.index !== undefined ? cornerDrag(body, hit.index, e) : null;
        case 'edge-size': {
          const sels = live.current.selectedEdges;
          const first = sels[0] && bodyOf(sels[0].bodyId);
          return first ? { ...common, kind: 'edge-size', sels, initialSize: edgeSize(first, primaryEdge(sels)) } : null;
        }
        default: {
          const ids = withCopies(live.current.selectedBodyIds, live.current.bodies);
          const bounds = selectionBounds(ids.map((i) => bodyOf(i)).filter((b): b is Body3D => !!b));
          if (!bounds) return null;
          const planeY = bounds.minElevation + 0.3;
          const p = intersectPlane(e.clientX, e.clientY, planeY);
          if (!p) return null;
          const center = { x: bounds.centerX, y: bounds.centerY };
          return { ...common, kind: 'rotate', ids, center, planeY, a0: Math.atan2(-p.z - center.y, p.x - center.x), angle: 0 };
        }
      }
    };

    const startMoveDrag = (bodyId: string, point: THREE.Vector3, e: { clientY: number }): Drag | null => {
      const ids = movingSet(bodyId);
      const bounds = selectionBounds(ids.map((i) => bodyOf(i)).filter((b): b is Body3D => !!b));
      if (!bounds) return null;
      if (!live.current.selectedBodyIds.includes(bodyId)) live.current.onSelectBody(bodyId);
      return {
        kind: 'move',
        startClientY: e.clientY,
        mmPerPixel: mmPerPixel(),
        ids,
        center: { x: bounds.centerX, y: bounds.centerY },
        planeY: point.y,
        startPoint: point,
        // A wall shape slides along its wall, whatever the camera sees.
        frame: frameOfBody(bodyOf(bodyId)),
        dx: 0,
        dy: 0,
        dz: 0,
      };
    };

    const applyDrag = (d: Drag, m: { x: number; y: number; shift: boolean }) => {
      const rect = renderer.domElement.getBoundingClientRect();
      let text = '';
      lowerQualityWhileBusy();
      if (d.startClientX !== undefined) d.moved = Math.max(d.moved ?? 0, Math.hypot(m.x - d.startClientX, m.y - d.startClientY));

      if (d.kind === 'repeat') {
        const p = intersectPlane(m.x, m.y, d.planeY ?? 0, d.frame);
        const r = live.current.repeat;
        if (p && r) {
          let at: Point2D = { x: Math.round(p.x), y: Math.round(-p.z) };
          const here0 = (Math.atan2(at.y - r.start.y, at.x - r.start.x) * 180) / Math.PI;
          // Shift keeps the path to 15° steps from the original; without it the common angles still pull the path in.
          const snapDeg = m.shift ? Math.round(here0 / 15) * 15 : magnet15(here0);
          if (m.shift || snapDeg !== here0) {
            const ang = (snapDeg * Math.PI) / 180;
            const len = Math.hypot(at.x - r.start.x, at.y - r.start.y);
            at = { x: Math.round(r.start.x + len * Math.cos(ang)), y: Math.round(r.start.y + len * Math.sin(ang)) };
          } else {
            // Snap to a corner of another shape when close.
            if (!d.frame) live.current.bodies.forEach((b) => b.id !== r.bodyId && !b.frame && b.points.forEach((pt) => { if (Math.hypot(pt.x - at.x, pt.y - at.y) < 8) at = { x: pt.x, y: pt.y }; }));
          }
          const here = at;
          live.current.onUpdateRepeat((cur) => {
            if (!cur) return cur;
            if (d.repeatHandle === 'end') return { ...cur, end: here, bend: cur.bend ? cur.bend : null };
            return { ...cur, bend: bendThrough(cur, here) };
          });
        }
        invalidate();
        return;
      }

      if (d.kind === 'height') {
        const next = clamp(Math.round(d.initialHeight! + alongGrow(d, m) * d.mmPerPixel), 2, 600);
        d.nextHeight = next;
        // Preview by stretching the existing mesh; the exact geometry is rebuilt on release.
        const body = bodyOf(d.bodyId);
        const entry = entriesRef.current.get(d.bodyId!);
        if (body && entry) {
          const s = next / d.initialHeight!;
          const elev = body.elevation ?? 0;
          entry.group.scale.y = s;
          entry.group.position.y = elev * (1 - s);
          heightArrowRef.current?.position.setY(elev + next + 0.2);
        }
        text = `Height ${next} mm`;
        showReadout(`${d.bodyId}:top:`, 'Height', next);
        if (anchorRef.current && body) anchorRef.current.pos.y = (body.elevation ?? 0) + next + 0.2 + tipRef.current;
      } else if (d.kind === 'bottom') {
        const body = bodyOf(d.bodyId);
        const entry = entriesRef.current.get(d.bodyId!);
        if (body && entry) {
          // Down is positive: pulling the bottom face down grows the shape, the top stays put.
          const range = bottomRange(body);
          const delta = clamp(Math.round(-alongGrow(d, m) * d.mmPerPixel), -range.max, -range.min);
          d.nextDelta = delta;
          const top = d.initialElevation! + d.initialHeight!;
          const s = (d.initialHeight! + delta) / d.initialHeight!;
          entry.group.scale.y = s;
          entry.group.position.y = top * (1 - s);
          heightArrowRef.current?.position.setY(d.initialElevation! - delta - 0.2);
          showReadout(`${d.bodyId}:bottom:`, 'Height', d.initialHeight! + delta);
          text = delta === 0 ? 'Bottom unchanged' : `Bottom ${delta > 0 ? 'down' : 'up'} ${Math.abs(delta)} mm`;
        }
      } else if (d.kind === 'axis') {
        let dx = 0;
        let dy = 0;
        let dz = 0;
        if (d.axis === 'z') {
          dz = Math.max(-(d.minLift ?? 0), Math.round((d.startClientY - m.y) * d.mmPerPixel));
        } else {
          const cur = intersectPlane(m.x, m.y, d.planeY!);
          if (!cur || !d.startPoint) return;
          if (d.axis === 'x') dx = Math.round(cur.x - d.startPoint.x);
          else dy = Math.round(-(cur.z - d.startPoint.z));
        }
        d.dx = dx;
        d.dy = dy;
        d.dz = dz;
        d.ids!.forEach((id) => entriesRef.current.get(id)?.group.position.set(dx, dz, -dy));
        gizmoGroup.position.set(dx, dz, -dy);
        text = `${d.axis!.toUpperCase()} ${signed(d.axis === 'x' ? dx : d.axis === 'y' ? dy : dz)} mm`;
      } else if (d.kind === 'edge-size') {
        if ((d.moved ?? 0) <= CLICK_SLOP_PX) return; // a tap opens the picker; only a real drag resizes
        setPickerOpen(false);
        const raw = d.initialSize! + (d.startClientY - m.y) * d.mmPerPixel * 0.35;
        const owner = bodyOf(d.sels![0].bodyId);
        const limit = owner && !d.sels!.every((x) => x.kind === 'corner') ? maxBevelSize(owner, d.sels!) : 30;
        const next = clamp(Math.round(raw * 2) / 2, 0, limit);
        live.current.onEdgeChange(d.sels!, { size: next });
        text = next <= 0 ? 'No bevel' : next >= limit ? `Size ${next} mm · largest that fits` : `Size ${next} mm`;
      } else if (d.kind === 'corner') {
        const body = bodyOf(d.bodyId);
        const cur = intersectPlane(m.x, m.y, d.planeY!, d.frame);
        if (!body || !cur || !d.startPoint || !d.initialBody || !d.anchor || !d.corner0) return;
        const w0 = Math.max(1, Math.abs(d.corner0.x - d.anchor.x));
        const h0 = Math.max(1, Math.abs(d.corner0.y - d.anchor.y));
        const sgnX = d.corner0.x >= d.anchor.x ? 1 : -1;
        const sgnY = d.corner0.y >= d.anchor.y ? 1 : -1;
        const nw = Math.max(2, Math.round(w0 + sgnX * (cur.x - d.startPoint.x)));
        const nh = Math.max(2, Math.round(h0 - sgnY * (cur.z - d.startPoint.z)));
        let sx = nw / w0;
        let sy = nh / h0;
        if (m.shift) sx = sy = Math.max(sx, sy);
        live.current.onUpdateBody(body.id, scaleBodyAbout(d.initialBody, d.anchor.x, d.anchor.y, sx, sy));
        text = `${Math.round(w0 * sx)} × ${Math.round(h0 * sy)} mm`;
      } else if (d.kind === 'wall') {
        const body = bodyOf(d.bodyId);
        const cur = intersectPlane(m.x, m.y, d.planeY!, d.frame);
        if (!body || !cur || !d.normal || !d.startPoint) return;
        const n = d.normal;
        const dist = Math.round((cur.x - d.startPoint.x) * n.x - (cur.z - d.startPoint.z) * n.y);
        const update = offsetWall(body, d.index!, dist, d.initialBase);
        if (update) live.current.onUpdateBody(body.id, update);
        text = `Wall ${signed(dist)} mm`;
        if (d.measure0 !== undefined) showReadout(`${d.bodyId}:wall:${d.index}`, d.measureLabel ?? 'Size', d.measure0 + (isHoleIndex(d.index!) ? -dist : dist));
      } else if (d.kind === 'move') {
        const cur = intersectPlane(m.x, m.y, d.planeY!, d.frame);
        if (!cur) return;
        // The move in the grabbed shape's own space: across the ground, or across its wall.
        let du = Math.round(cur.x - d.startPoint!.x);
        let dv = Math.round(-(cur.z - d.startPoint!.z));
        if (m.shift) {
          if (Math.abs(du) >= Math.abs(dv)) dv = 0;
          else du = 0;
        }
        // …and in the scene, which is what every selected shape is moved by.
        const w = new THREE.Vector3(du, 0, -dv);
        if (d.frame) w.applyMatrix3(new THREE.Matrix3().setFromMatrix4(d.frame));
        const dx = Math.round(w.x * 100) / 100;
        const dy = Math.round(-w.z * 100) / 100;
        const dz = d.frame ? Math.round(w.y * 100) / 100 : 0;
        d.dx = dx;
        d.dy = dy;
        d.dz = dz;
        // A pure transform of the existing meshes: no geometry is rebuilt while dragging.
        d.ids!.forEach((id) => {
          const f = frameOfBody(bodyOf(id));
          const local = f ? new THREE.Vector3(dx, dz, -dy).applyMatrix3(new THREE.Matrix3().setFromMatrix4(f).invert()) : new THREE.Vector3(dx, dz, -dy);
          entriesRef.current.get(id)?.group.position.copy(local);
        });
        text = d.frame ? `Across ${signed(du)}, up ${signed(dv)} mm` : `X ${signed(dx)}, Y ${signed(dy)} mm`;
      } else if (d.kind === 'rotate') {
        const cur = intersectPlane(m.x, m.y, d.planeY!);
        if (!cur) return;
        let delta = Math.atan2(-cur.z - d.center!.y, cur.x - d.center!.x) - d.a0!;
        while (delta > Math.PI) delta -= 2 * Math.PI;
        while (delta < -Math.PI) delta += 2 * Math.PI;
        const step = m.shift ? 15 : 1;
        const deg = m.shift ? Math.round((delta * 180) / Math.PI / step) * step : magnet15(Math.round((delta * 180) / Math.PI));
        const angle = (deg * Math.PI) / 180;
        d.angle = angle;
        const pivot = new THREE.Vector3(d.center!.x, 0, -d.center!.y);
        const shift = pivot.clone().sub(pivot.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), angle));
        d.ids!.forEach((id) => {
          const group = entriesRef.current.get(id)?.group;
          if (group) {
            group.rotation.y = angle;
            group.position.copy(shift);
          }
        });
        text = `Rotate ${deg}°`;
      }
      // The anchored number already shows these; the floating label would repeat it.
      if (d.kind !== 'height' && d.kind !== 'bottom' && d.kind !== 'wall') setDragLabel({ text, x: m.x - rect.left + 16, y: m.y - rect.top - 28 });
      invalidate(d.kind === 'move' || d.kind === 'rotate' || d.kind === 'height' || d.kind === 'bottom' || d.kind === 'axis');
    };

    const endDrag = () => {
      const d = drag;
      if (!d) return;
      drag = null;
      controls.enabled = true;
      setDragLabel(null);
      gizmoGroup.position.set(0, 0, 0);
      if (d.kind === 'edge-size' && (d.moved ?? 0) <= CLICK_SLOP_PX) setPickerOpen((open) => !open);

      // Commit the previewed change in one update.
      if (d.kind === 'move' && (d.dx || d.dy || d.dz)) {
        live.current.onTransformBodies(d.ids!, { dx: d.dx!, dy: d.dy!, dz: d.dz ?? 0, angle: 0, cx: d.center!.x, cy: d.center!.y });
      } else if (d.kind === 'rotate' && d.angle) {
        live.current.onTransformBodies(d.ids!, { dx: 0, dy: 0, dz: 0, angle: d.angle, cx: d.center!.x, cy: d.center!.y });
      } else if (d.kind === 'height' && d.nextHeight !== d.initialHeight) {
        live.current.onUpdateBody(d.bodyId!, { extrusionHeight: d.nextHeight! });
      } else if (d.kind === 'axis' && (d.dx || d.dy || d.dz)) {
        live.current.onTransformBodies(d.ids!, { dx: d.dx!, dy: d.dy!, dz: d.dz!, angle: 0, cx: d.center!.x, cy: d.center!.y });
      } else if (d.kind === 'bottom' && d.nextDelta) {
        const body = bodyOf(d.bodyId);
        if (body) live.current.onUpdateBody(body.id, moveBottom(body, -d.nextDelta));
      } else {
        resetPreviews();
      }
      setFastId(null);
      restoreGizmos();
      if (d.kind === 'height' || d.kind === 'bottom' || d.kind === 'wall') holdReadout(false);
      live.current.onDragStateChange?.(false);
      invalidate(true);
    };

    const cancelDrag = () => {
      if (!drag) return;
      holdReadout(false);
      drag = null;
      resetPreviews();
      controls.enabled = true;
      setDragLabel(null);
      gizmoGroup.position.set(0, 0, 0);
      restoreGizmos();
      setFastId(null);
      live.current.onDragStateChange?.(false);
      invalidate(true);
    };

    // ---- Pointer pipeline -------------------------------------------------
    // Press and hold another shape while something is selected: add it to the selection (hold a selected one to drop it).
    let longPress = 0;
    let longFired = false;

    // Two fingers tapped together (and lifted without moving) show or hide the move arrows.
    const touches = new Map<number, { x0: number; y0: number }>();
    let twoTap: { start: number; ups: number } | null = null;
    const trackTouchDown = (e: PointerEvent) => {
      if (e.pointerType !== 'touch') return;
      touches.set(e.pointerId, { x0: e.clientX, y0: e.clientY });
      twoTap = touches.size === 2 ? { start: performance.now(), ups: 0 } : null;
    };
    const trackTouchMove = (e: PointerEvent) => {
      const t = touches.get(e.pointerId);
      if (t && twoTap && Math.hypot(e.clientX - t.x0, e.clientY - t.y0) > 14) twoTap = null;
    };
    const trackTouchUp = (e: PointerEvent) => {
      if (!touches.delete(e.pointerId)) return;
      if (!twoTap || e.type === 'pointercancel') {
        twoTap = null;
        return;
      }
      twoTap.ups += 1;
      if (performance.now() - twoTap.start > 500) twoTap = null;
      else if (twoTap.ups === 2) {
        twoTap = null;
        live.current.onToggleMove?.();
      }
    };

    const onPointerDown = (e: PointerEvent) => {
      if (live.current.draw) return; // the Draw tool reads the pointer while a sketch is open
      trackTouchDown(e);
      pickPx = e.pointerType === 'touch' ? EDGE_PICK_TOUCH_PX : EDGE_PICK_PX;
      // A second finger means the user wants to orbit/pinch: abandon any one-finger drag.
      if (!e.isPrimary) {
        cancelDrag();
        candidate = null;
        return;
      }
      if (e.button !== 0) return;
      const hit = resolveHit(e.clientX, e.clientY, e.altKey);
      candidate = { x: e.clientX, y: e.clientY, hit, pointerId: e.pointerId };
      if (!hit) return; // empty space: let OrbitControls take it

      if (hit.type === 'gizmo') {
        const d = startGizmoDrag(hit, e);
        if (d) {
          beginDrag(d, e.pointerId);
          applyDrag(d, { x: e.clientX, y: e.clientY, shift: e.shiftKey });
          candidate = null;
          return;
        }
      }
      longFired = false;
      window.clearTimeout(longPress);
      const held = live.current.selectedBodyIds;
      const armShape = hit.type === 'body' && held.length >= 1 && !(held.length === 1 && held[0] === hit.bodyId);
      // Holding an edge of the selected shape adds that edge (or drops it, if it is already in).
      const armEdge = hit.type === 'edge' && held.includes(hit.sel.bodyId);
      // Holding another face of the shape while edges are selected keeps those edges and picks that face too.
      const armFace =
        hit.type === 'body' && held.length === 1 && held[0] === hit.bodyId && live.current.selectedEdges.length > 0 && !sameFace(live.current.selectedFace, hit.face);
      if (armShape || armEdge || armFace) {
        const pressed = candidate;
        const rect = renderer.domElement.getBoundingClientRect();
        setHold({ x: e.clientX - rect.left, y: e.clientY - rect.top });
        longPress = window.setTimeout(() => {
          if (candidate !== pressed) return; // it turned into a drag, or the finger lifted
          longFired = true;
          setHold(null);
          navigator.vibrate?.(15);
          if (hit.type === 'edge') {
            live.current.onSelectFace(null);
            live.current.onSelectEdges(toggleEdge(live.current.selectedEdges, hit.sel));
          } else if (hit.type === 'body' && armFace) live.current.onSelectFace(hit.face);
          else if (hit.type === 'body') live.current.onSelectBody(hit.bodyId, true);
        }, 420);
      }
      // Pressing on a shape never orbits: it either selects it or starts moving it.
      controls.enabled = false;
      renderer.domElement.setPointerCapture(e.pointerId);
    };

    const onPointerMove = (e: PointerEvent) => {
      if (live.current.draw) return;
      trackTouchMove(e);
      if (drag || candidate) pending = { x: e.clientX, y: e.clientY, shift: e.shiftKey };
      else if (e.pointerType === 'mouse' && e.buttons === 0) pendingHover = { x: e.clientX, y: e.clientY };
    };

    const processMove = (m: { x: number; y: number; shift: boolean }) => {
      if (drag) {
        applyDrag(drag, m);
        return;
      }
      if (!candidate?.hit || candidate.hit.type === 'gizmo') return;
      if (Math.hypot(m.x - candidate.x, m.y - candidate.y) <= CLICK_SLOP_PX) return;
      const hit = candidate.hit;
      // Pressing the face that is already selected and dragging pulls that face out.
      if (hit.type === 'body' && live.current.selectedBodyIds.length === 1 && sameFace(live.current.selectedFace, hit.face)) {
        const fd = faceDrag(hit.face, { clientX: candidate.x, clientY: candidate.y });
        const pid = candidate.pointerId;
        candidate = null;
        if (fd) {
          beginDrag(fd, pid);
          applyDrag(fd, m);
        }
        return;
      }
      const bodyId = hit.type === 'body' ? hit.bodyId : hit.sel.bodyId;
      // For an edge, the move still grabs the body: use the pointer ray's ground hit as the anchor.
      const start = hit.type === 'body' ? hit.point : (() => {
        const body = bodyOf(bodyId);
        return intersectPlane(candidate!.x, candidate!.y, (body?.elevation ?? 0) + (body?.extrusionHeight ?? 0)) ?? new THREE.Vector3();
      })();
      const pointerId = candidate.pointerId;
      const d = startMoveDrag(bodyId, start, { clientY: candidate.y });
      candidate = null;
      if (d) {
        beginDrag(d, pointerId);
        applyDrag(d, m);
      }
    };

    const finishPointer = (e: PointerEvent, cancelled: boolean) => {
      if (live.current.draw) return;
      if (!e.isPrimary) return;
      window.clearTimeout(longPress);
      setHold(null);
      if (pending) {
        const m = pending;
        pending = null;
        processMove(m);
      }
      const hadDrag = !!drag;
      if (renderer.domElement.hasPointerCapture(e.pointerId)) renderer.domElement.releasePointerCapture(e.pointerId);
      if (hadDrag) {
        if (cancelled) cancelDrag();
        else endDrag();
        candidate = null;
        return;
      }
      const down = candidate;
      candidate = null;
      controls.enabled = true;
      if (longFired) {
        longFired = false;
        return; // the hold already changed the selection
      }
      if (cancelled || !down || down.pointerId !== e.pointerId) return;
      if (Math.hypot(e.clientX - down.x, e.clientY - down.y) > CLICK_SLOP_PX) return; // it was an orbit/pan

      if (live.current.repeat) return; // taps do nothing while copies are being placed

      const multi = e.shiftKey || e.metaKey || e.ctrlKey;
      const hit = down.hit;
      if (!hit) {
        live.current.onSelectBody(null);
        live.current.onSelectFace(null);
      } else if (hit.type === 'edge') {
        const current = live.current.selectedEdges;
        const sameBody = current.length > 0 && current[0].bodyId === hit.sel.bodyId;
        const already = current.some((s) => edgeKey(s) === edgeKey(hit.sel));
        live.current.onSelectBody(hit.sel.bodyId);
        live.current.onSelectFace(null);
        // Tapping the only selected edge again widens it to the whole rim; tapping the rim narrows it back to that edge.
        const body = bodyOf(hit.sel.bodyId);
        const rim = body && hit.sel.kind !== 'corner' ? edgesOfKind(body, hit.sel.kind) : [];
        const justThis = current.length === 1 && already;
        const isRim = rim.length > 1 && current.length === rim.length && rim.every((r) => current.some((c) => edgeKey(c) === edgeKey(r)));
        let next: EdgeSel[] = [hit.sel];
        if (multi && sameBody) next = toggleEdge(current, hit.sel);
        else if (justThis && rim.length > 1) next = rim;
        else if (isRim && already) next = [hit.sel];
        live.current.onSelectEdges(next);
      } else if (hit.type === 'body') {
        live.current.onSelectBody(hit.bodyId, multi);
        // A tap on a face selects that face; a shift-tap is about picking shapes, not faces.
        live.current.onSelectFace(multi ? null : hit.face);
      }
    };
    const onPointerUp = (e: PointerEvent) => {
      trackTouchUp(e);
      finishPointer(e, false);
    };
    const onPointerCancel = (e: PointerEvent) => {
      trackTouchUp(e);
      finishPointer(e, true);
    };
    const onPointerLeave = () => {
      pendingHover = null;
      clearHoverRef.current();
    };

    // Registered in the capture phase, ahead of OrbitControls, so a press on a shape can keep it from orbiting.
    renderer.domElement.addEventListener('pointerdown', onPointerDown, { capture: true });
    renderer.domElement.addEventListener('pointermove', onPointerMove);
    renderer.domElement.addEventListener('pointerup', onPointerUp);
    renderer.domElement.addEventListener('pointercancel', onPointerCancel);
    renderer.domElement.addEventListener('pointerleave', onPointerLeave);
    const onContextMenu = (e: Event) => e.preventDefault();
    renderer.domElement.addEventListener('contextmenu', onContextMenu);

    const controls = new OrbitControls(camera, renderer.domElement);
    controls.enableDamping = true;
    controls.dampingFactor = 0.1;
    controls.screenSpacePanning = true;
    controls.zoomToCursor = true;
    controls.minDistance = 20;
    controls.maxDistance = 2500;
    controls.addEventListener('change', () => {
      invalidate();
      lowerQualityWhileBusy();
    });

    drawApiRef.current = {
      scene,
      camera,
      controls,
      dom: renderer.domElement,
      bodyGroup,
      invalidate: () => invalidate(),
      bodies: () => live.current.bodies,
      setLabel: setDragLabel,
    };

    // ---- Camera framing ---------------------------------------------------
    const frameView = (face: CubeFace | 'keep', instant = false, from?: THREE.Vector3, focus?: { center: THREE.Vector3; radius: number }) => {
      const box = new THREE.Box3();
      let any = false;
      live.current.bodies.forEach((b) => {
        if (!b.visible) return;
        any = true;
        const lo = b.elevation ?? 0;
        const m = frameOfBody(b);
        b.points.forEach((p) => {
          box.expandByPoint(new THREE.Vector3(p.x, lo, -p.y).applyMatrix4(m ?? IDENTITY));
          box.expandByPoint(new THREE.Vector3(p.x, lo + b.extrusionHeight, -p.y).applyMatrix4(m ?? IDENTITY));
        });
      });
      // While copies are being placed, frame them too so the whole row is in view.
      const r = live.current.repeat;
      if (r) {
        const fm = frameOfBody(bodyOf(r.bodyId));
        stops(r).forEach((p) => box.expandByPoint(new THREE.Vector3(p.x, 0, -p.y).applyMatrix4(fm ?? IDENTITY)));
      }
      if (!any) box.set(new THREE.Vector3(-100, 0, -100), new THREE.Vector3(100, 50, 100));

      const center = focus ? focus.center.clone() : box.getCenter(new THREE.Vector3());
      const radius = focus ? focus.radius : Math.max(box.getBoundingSphere(new THREE.Sphere()).radius, 40);
      const vFov = THREE.MathUtils.degToRad(camera.fov);
      const fitFov = camera.aspect < 1 ? 2 * Math.atan(Math.tan(vFov / 2) * camera.aspect) : vFov;
      const distance = (radius / Math.sin(fitFov / 2)) * 1.2;

      const directions: Record<CubeFace, THREE.Vector3> = {
        iso: new THREE.Vector3(0.62, 0.55, 0.72),
        top: new THREE.Vector3(0, 1, 0.0001),
        bottom: new THREE.Vector3(0, -1, 0.0001),
        front: new THREE.Vector3(0, 0.08, 1),
        back: new THREE.Vector3(0, 0.08, -1),
        right: new THREE.Vector3(1, 0.08, 0),
        left: new THREE.Vector3(-1, 0.08, 0),
      };
      const dir = from ? from.clone() : face === 'keep' ? camera.position.clone().sub(controls.target) : directions[face].clone();
      const toPos = center.clone().add(dir.normalize().multiplyScalar(distance));

      if (instant) {
        camera.position.copy(toPos);
        controls.target.copy(center);
        controls.update();
        tweenRef.current = null;
      } else {
        tweenRef.current = {
          start: performance.now(),
          fromPos: camera.position.clone(),
          toPos,
          fromTarget: controls.target.clone(),
          toTarget: center,
        };
      }
      invalidate();
    };
    frameViewRef.current = frameView;
    if (live.current.apiRef) {
      live.current.apiRef.current = {
        view: (v) => frameView(v === 'fit' ? 'keep' : v),
        screenshot: () => {
          renderer.render(scene, camera);
          return renderer.domElement.toDataURL('image/png');
        },
      };
    }
    frameView('iso', true);

    // ---- Resize + render loop ---------------------------------------------
    const resizeObserver = new ResizeObserver(() => {
      const w = container.clientWidth;
      const h = container.clientHeight;
      if (!w || !h) return;
      camera.aspect = w / h;
      camera.updateProjectionMatrix();
      renderer.setSize(w, h);
      viewportSize.set(w, h);
      lineMaterials.forEach((m) => m.resolution.set(w, h));
      invalidate();
    });
    resizeObserver.observe(container);

    const placePanel = () => {
      const chip = repeatChipRef.current;
      const ra = repeatAnchorRef.current;
      if (chip && ra) {
        // The repeat pill sits under the original shape, clear of the path and its handles.
        const v = ra.clone().project(camera);
        const w = container.clientWidth;
        const h = container.clientHeight;
        const x = clamp((v.x * 0.5 + 0.5) * w - chip.offsetWidth / 2, 8, Math.max(8, w - chip.offsetWidth - 8));
        let y = (-v.y * 0.5 + 0.5) * h + 22;
        y = clamp(y, 8, Math.max(8, h - chip.offsetHeight - 8));
        chip.style.transform = `translate(${x}px, ${y}px)`;
        chip.style.visibility = v.z > 1 || !live.current.repeat ? 'hidden' : 'visible';
      }
      const el = panelRef.current;
      const anchor = anchorRef.current;
      if (!el) return;
      if (drag && drag.kind !== 'height' && drag.kind !== 'bottom' && drag.kind !== 'wall') {
        el.style.visibility = 'hidden';
        return;
      }
      if (!anchor) return; // nothing selected: keep the spot so the card can animate out
      const v = anchor.pos.clone().applyMatrix4(gizmoFrame.matrix).project(camera);
      const w = container.clientWidth;
      const h = container.clientHeight;
      const pw = el.offsetWidth;
      const ph = el.offsetHeight;
      const x = clamp((v.x * 0.5 + 0.5) * w - pw / 2, 8, Math.max(8, w - pw - 8));
      let y = (-v.y * 0.5 + 0.5) * h - anchor.lift - ph;
      if (y < 8) y = (-v.y * 0.5 + 0.5) * h + anchor.lift * 0.5; // no room above: sit below
      y = clamp(y, 8, Math.max(8, h - ph - 8));
      el.style.transform = `translate(${x}px, ${y}px)`;
      el.style.visibility = v.z > 1 ? 'hidden' : 'visible';
    };
    placePanelRef.current = placePanel;

    let raf = 0;
    const animate = () => {
      raf = requestAnimationFrame(animate);

      // Input is applied once per frame, however fast the pointer reports.
      if (pending) {
        const m = pending;
        pending = null;
        processMove(m);
      }
      if (pendingHover && !drag && !candidate) {
        const h = pendingHover;
        pendingHover = null;
        hover(h.x, h.y);
      }

      const pop = popRef.current;
      if (pop) {
        const elapsed = performance.now() - pop.start;
        let running = false;
        gizmoGroup.children.forEach((child, i) => {
          const t = clamp((elapsed - i * 35) / 380, 0, 1);
          // Ease out with a little overshoot, so handles spring into place.
          const c = 1.70158;
          const k = t === 0 ? 0.0001 : t >= 1 ? 1 : 1 + (c + 1) * Math.pow(t - 1, 3) + c * Math.pow(t - 1, 2);
          child.scale.setScalar((child.userData.baseScale ?? 1) * k);
          if (t < 1) running = true;
        });
        if (!running) popRef.current = null;
        needsRender = true;
      }

      const tween = tweenRef.current;
      if (tween) {
        const t = clamp((performance.now() - tween.start) / 450, 0, 1);
        const ease = 1 - Math.pow(1 - t, 3);
        camera.position.lerpVectors(tween.fromPos, tween.toPos, ease);
        controls.target.lerpVectors(tween.fromTarget, tween.toTarget, ease);
        if (t >= 1) tweenRef.current = null;
        needsRender = true;
      }
      const moved = controls.update();
      if (!moved && !needsRender) return; // nothing changed: skip the frame entirely

      if (shadowsDirty) {
        renderer.shadowMap.needsUpdate = true;
        shadowsDirty = false;
      }
      needsRender = false;
      renderer.render(scene, camera);
      placePanel();
    };
    animate();
    setIsSceneReady(true);

    return () => {
      setIsSceneReady(false);
      cancelAnimationFrame(raf);
      window.clearTimeout(qualityTimer);
      resizeObserver.disconnect();
      renderer.domElement.removeEventListener('pointerdown', onPointerDown, { capture: true });
      renderer.domElement.removeEventListener('pointermove', onPointerMove);
      renderer.domElement.removeEventListener('pointerup', onPointerUp);
      renderer.domElement.removeEventListener('pointercancel', onPointerCancel);
      renderer.domElement.removeEventListener('pointerleave', onPointerLeave);
      renderer.domElement.removeEventListener('contextmenu', onContextMenu);
      window.clearTimeout(longPress);
      controls.dispose();
      entriesRef.current.clear();
      [bodyGroup, gizmoGroup, helperGroup, previewGroup, hoverGroup].forEach(clearGroup);
      [shadowCatcher, grid, axisX, axisY].forEach(disposeObject);
      envTexture.dispose();
      pmrem.dispose();
      renderer.dispose();
      renderer.domElement.remove();
      cameraRef.current = null;
    };
  }, []);

  // ---- Sync solids with the document -------------------------------------
  // Layout effect so a rebuilt mesh replaces the previewed one before the next paint.
  useLayoutEffect(() => {
    const group = bodyGroupRef.current;
    if (!isSceneReady || !group) return;
    const entries = entriesRef.current;
    const visible = new Map(bodies.filter((b) => b.visible).map((b) => [b.id, b]));

    entries.forEach((entry, id) => {
      if (!visible.has(id)) {
        group.remove(entry.root);
        disposeObject(entry.group);
        entries.delete(id);
      }
    });

    visible.forEach((body, id) => {
      const existing = entries.get(id);
      const fast = id === fastId;
      if (existing?.body === body && existing.signature.endsWith('|fast') === fast) return; // untouched object
      const signature = bodySignature(body) + (fast ? '|fast' : '');
      if (existing && existing.signature === signature) {
        // Where a wall shape stands is not part of its geometry: a move arrives as a new frame, replacing the drag preview.
        if (JSON.stringify(existing.body.frame) !== JSON.stringify(body.frame)) {
          existing.group.position.set(0, 0, 0);
          existing.group.rotation.set(0, 0, 0);
          existing.group.scale.set(1, 1, 1);
        }
        existing.body = body;
        placeFrame(existing.root, body);
        return;
      }
      if (existing) {
        group.remove(existing.root);
        disposeObject(existing.group);
        entries.delete(id);
      }

      const geometry = buildBodyGeometry(body, { fast });
      if (!geometry) return;
      const solid = createMaterial(body);
      const mesh = new THREE.Mesh(geometry, solid);
      mesh.userData.solid = solid;
      mesh.userData.ghost = new THREE.MeshStandardMaterial({ color: body.color, roughness: 0.6, transparent: true, opacity: 0.2, depthWrite: false, side: THREE.DoubleSide });
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      const outline = new THREE.LineSegments(
        featureEdges(geometry, 30),
        new THREE.LineBasicMaterial({ color: ACCENT, transparent: true })
      );
      outline.visible = false;

      const bodyGroup = new THREE.Group();
      bodyGroup.userData.bodyId = id;
      bodyGroup.add(mesh, outline);
      const root = new THREE.Group();
      root.add(bodyGroup);
      placeFrame(root, body);
      group.add(root);
      entries.set(id, { body, root, group: bodyGroup, outline, signature });
    });
    applyXrayRef.current();

    // A newly added shape may land outside the view: bring everything back into frame, keeping the angle.
    const known = knownIdsRef.current;
    const added = known ? [...visible.keys()].some((id) => !known.has(id)) : false;
    knownIdsRef.current = new Set(visible.keys());
    if (added) frameViewRef.current('keep');
  }, [bodies, isSceneReady, fastId]);

  useEffect(() => {
    refreshOutlinesRef.current();
  }, [selectedBodyId, selectedBodyIds, isSceneReady]);
  useEffect(() => {
    applyXrayRef.current();
  }, [xray, isSceneReady]);

  const repeating = !!repeat;
  const drawing = !!draw;
  const handsOff = repeating || drawing;
  // Opening a repeat brings the whole row into view; dragging it afterwards never moves the camera.
  useEffect(() => {
    if (repeating && isSceneReady) frameViewRef.current('keep');
  }, [repeating, isSceneReady]);

  // ---- Handles for what is selected ---------------------------------------
  useLayoutEffect(() => {
    const gizmoGroup = gizmoGroupRef.current;
    const helperGroup = helperGroupRef.current;
    if (!isSceneReady || !gizmoGroup || !helperGroup) return;
    clearGroup(gizmoGroup);
    clearGroup(helperGroup);
    heightArrowRef.current = null;
    anchorRef.current = null;
    if (handsOff) {
      // While copies are placed or a sketch is drawn the shape's own handles step aside so the path handles are the only thing to grab.
      invalidateRef.current();
      return;
    }

    const ids = selectedBodyIds.length ? selectedBodyIds : selectedBodyId ? [selectedBodyId] : [];
    const core = ids.map((id) => bodies.find((b) => b.id === id)).filter((b): b is Body3D => !!b && b.visible);
    // The move arrows and the turning ring take in a shape's live copies; the shape's own handles are for the shape alone.
    const picked = withCopies(core.map((b) => b.id), bodies).map((id) => bodies.find((b) => b.id === id)!).filter((b) => b.visible);
    if (!picked.length) {
      popRef.current = null;
      popKeyRef.current = '';
      invalidateRef.current();
      return;
    }
    // One wall shape: its handles are built in its own space and carried onto its wall. Moving and turning by arrows or ring need upright shapes.
    const walled = picked.some((b) => b.frame);
    const gf = gizmoFrameRef.current;
    if (gf) {
      if (walled && core.length === 1 && core[0].frame) gf.matrix.copy(frameMatrix(core[0].frame));
      else gf.matrix.identity();
      gf.matrixWorldNeedsUpdate = true;
    }
    const bounds = selectionBounds(picked)!;
    const extent = Math.max(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY);
    const s = clamp(extent / 170, 0.7, 2.4);

    if (moveOn && !walled) {
      const top = Math.max(...picked.map((b) => (b.elevation ?? 0) + b.extrusionHeight));
      const midY = (bounds.minElevation + top) / 2;
      const up = new THREE.Vector3(0, 1, 0);
      const ringGeo = shared(new THREE.RingGeometry(4.5, 6.5, 40).rotateX(-Math.PI / 2));
      const axisArrow = (axis: Axis, color: string, pos: THREE.Vector3, dir: THREE.Vector3) => {
        const mat = handleMaterial(color);
        const arrow = new THREE.Group();
        arrow.position.copy(pos);
        arrow.quaternion.setFromUnitVectors(up, dir);
        arrow.scale.setScalar(s);
        arrow.userData = { gizmo: 'move-axis', axis };
        const base = new THREE.Mesh(ringGeo, mat);
        const shaft = new THREE.Mesh(HANDLE.shaft, mat);
        shaft.position.y = 9;
        const head = new THREE.Mesh(HANDLE.head, mat);
        head.position.y = 22.5;
        base.renderOrder = shaft.renderOrder = head.renderOrder = 30;
        const hit = new THREE.Mesh(HANDLE.arrowHit, hiddenMaterial);
        hit.position.y = 16;
        arrow.add(base, shaft, head, hit);
        gizmoGroup.add(arrow);
      };
      // The three axes meet at one point: a dot at the middle of the selection, with a line out to each arrow.
      const hub = new THREE.Group();
      hub.position.set(bounds.centerX, midY, -bounds.centerY);
      const spoke = (to: { x: number; y: number; z: number }, color: string) => {
        const line = makeFatLine([{ x: 0, y: 0, z: 0 }, to], color, 2.5);
        const m = line.material as LineMaterial;
        m.depthTest = false;
        m.transparent = true;
        line.renderOrder = 29;
        line.raycast = () => {};
        hub.add(line);
      };
      spoke({ x: bounds.maxX + 6 - bounds.centerX, y: 0, z: 0 }, '#fb7185');
      spoke({ x: 0, y: 0, z: -(bounds.maxY + 6 - bounds.centerY) }, '#34d399');
      spoke({ x: 0, y: top + 6 - midY, z: 0 }, '#60a5fa');
      const origin = new THREE.Mesh(HANDLE.dot, handleMaterial('#ffffff'));
      origin.scale.setScalar(3.2 * s);
      origin.renderOrder = 31;
      origin.raycast = () => {};
      hub.add(origin);
      gizmoGroup.add(hub);
      axisArrow('x', '#fb7185', new THREE.Vector3(bounds.maxX + 6, midY, -bounds.centerY), new THREE.Vector3(1, 0, 0));
      axisArrow('y', '#34d399', new THREE.Vector3(bounds.centerX, midY, -(bounds.maxY + 6)), new THREE.Vector3(0, 0, -1));
      axisArrow('z', '#60a5fa', new THREE.Vector3(bounds.centerX, top + 6, -bounds.centerY), up);
      gizmoGroup.children.forEach((c) => (c.userData.baseScale = c.scale.x));
      if (popKeyRef.current !== `move|${ids.join(',')}`) {
        popKeyRef.current = `move|${ids.join(',')}`;
        popRef.current = { start: performance.now() };
        gizmoGroup.children.forEach((c) => c.scale.setScalar(0.0001));
      }
      invalidateRef.current();
      return;
    }

    // Rotation halo around the selection, on the ground it stands on.
    if (!walled) {
    const radius = 0.5 * Math.hypot(bounds.maxX - bounds.minX, bounds.maxY - bounds.minY) + 12;
    const ring = new THREE.Group();
    ring.position.set(bounds.centerX, bounds.minElevation + 0.3, -bounds.centerY);
    ring.userData = { gizmo: 'rotate' };
    const ringLine = new THREE.Mesh(new THREE.TorusGeometry(radius, 0.8, 6, 96).rotateX(Math.PI / 2), handleMaterial('#d4d9e6', 0.55, true));
    ringLine.renderOrder = 28;
    const ringHit = new THREE.Mesh(new THREE.TorusGeometry(radius, 6, 5, 48).rotateX(Math.PI / 2), hiddenMaterial);
    ring.add(ringLine, ringHit);
    gizmoGroup.add(ring);
    }

    const body = core.length === 1 ? core[0] : null;
    if (body) {
      const elev = body.elevation ?? 0;
      const top = elev + body.extrusionHeight;
      const topY = top + 0.2;

      // The selected face (if any), lit up, with an arrow that pulls it out.
      const face = selectedFace && selectedFace.bodyId === body.id ? selectedFace : null;
      const anchor = getInteriorAnchor(body);
      const up = new THREE.Vector3(0, 1, 0);
      const arrowMat = handleMaterial('#ffffff');
      const arrowRingGeo = shared(new THREE.RingGeometry(4.5, 6.5, 40).rotateX(-Math.PI / 2));
      const makeArrow = (pos: THREE.Vector3, dir: THREE.Vector3, userData: Record<string, unknown>) => {
        const arrow = new THREE.Group();
        arrow.position.copy(pos);
        arrow.quaternion.setFromUnitVectors(up, dir);
        arrow.scale.setScalar(s);
        arrow.userData = userData;
        const arrowRing = new THREE.Mesh(arrowRingGeo, arrowMat);
        const shaft = new THREE.Mesh(HANDLE.shaft, arrowMat);
        shaft.position.y = 9;
        const head = new THREE.Mesh(HANDLE.head, arrowMat);
        head.position.y = 22.5;
        arrowRing.renderOrder = shaft.renderOrder = head.renderOrder = 30;
        const hit = new THREE.Mesh(HANDLE.arrowHit, hiddenMaterial);
        hit.position.y = 16;
        arrow.add(arrowRing, shaft, head, hit);
        gizmoGroup.add(arrow);
        return arrow;
      };
      const faceTint = new THREE.MeshBasicMaterial({
        color: ACCENT_LIGHT,
        transparent: true,
        opacity: 0.32,
        side: THREE.DoubleSide,
        depthWrite: false,
        polygonOffset: true,
        polygonOffsetFactor: -2,
        polygonOffsetUnits: -2,
      });
      // The tint is cut from the real mesh, so it follows bevels and rounded corners exactly.
      const bodyMesh = entriesRef.current.get(body.id)?.group.children[0] as THREE.Mesh | undefined;
      const tint = (test: (n: THREE.Vector3, c: THREE.Vector3) => boolean, lift: THREE.Vector3) => {
        if (!bodyMesh) return;
        const mesh = new THREE.Mesh(pickTriangles(bodyMesh.geometry, test, lift), faceTint);
        mesh.renderOrder = 18;
        helperGroup.add(mesh);
      };

      if (face?.kind === 'bottom') {
        tint((n, c) => n.y < -0.98 && Math.abs(c.y - elev) < 0.05, new THREE.Vector3(0, -0.15, 0));
        heightArrowRef.current = makeArrow(new THREE.Vector3(anchor.x, elev - 0.2, -anchor.y), new THREE.Vector3(0, -1, 0), {
          gizmo: 'extrude-bottom',
          bodyId: body.id,
        });
      } else if (face?.kind === 'wall' && face.index !== undefined && wallEnds(body, face.index)) {
        const ends = wallEnds(body, face.index)!;
        const n = outwardNormal(ends.a, ends.b, ends.winding);
        const o = 0.25;
        const dir = new THREE.Vector3(n.x, 0, -n.y);
        const from = new THREE.Vector3(ends.a.x, 0, -ends.a.y);
        const along = new THREE.Vector3(ends.b.x - ends.a.x, 0, -(ends.b.y - ends.a.y));
        const len = along.length();
        along.normalize();
        tint((tn, c) => {
          if (tn.dot(dir) < 0.98) return false;
          const rel = c.clone().sub(from);
          const t = rel.dot(along);
          return Math.abs(rel.dot(dir)) < 0.1 && t > -0.1 && t < len + 0.1;
        }, dir.clone().multiplyScalar(o));
        const mid = new THREE.Vector3((ends.a.x + ends.b.x) / 2 + n.x * o, (elev + top) / 2, -((ends.a.y + ends.b.y) / 2 + n.y * o));
        heightArrowRef.current = makeArrow(mid, new THREE.Vector3(n.x, 0, -n.y), {
          gizmo: 'offset-wall',
          bodyId: body.id,
          index: face.index,
        });
      } else {
        if (face?.kind === 'top') tint((n, c) => n.y > 0.98 && Math.abs(c.y - top) < 0.05, new THREE.Vector3(0, 0.2, 0));
        // Arrow on the top face: height.
        heightArrowRef.current = makeArrow(new THREE.Vector3(anchor.x, topY, -anchor.y), up, {
          gizmo: 'extrude-height',
          bodyId: body.id,
        });
      }

      if (face && heightArrowRef.current) {
        // Pin the number just past the arrow's tip so it never covers the arrow.
        const arrow = heightArrowRef.current;
        const dir = new THREE.Vector3(0, 1, 0).applyQuaternion(arrow.quaternion);
        tipRef.current = 28 * arrow.scale.x;
        anchorRef.current = { pos: arrow.position.clone().addScaledVector(dir, tipRef.current), lift: 14 };
      }

      // A dot at the middle of each wall: push or pull it.
      const wallIds = [...getBase(body).map((_, j) => j), ...holeLoops(body).flatMap((l, h) => l.base.map((_, j) => holeIndex(h, j)))];
      if (wallIds.length <= MAX_WALL_HANDLES) {
        for (const j of wallIds) {
          const ends = wallEnds(body, j);
          if (!ends) continue;
          const len = Math.hypot(ends.b.x - ends.a.x, ends.b.y - ends.a.y);
          if (len < 14) continue;
          const n = outwardNormal(ends.a, ends.b, ends.winding);
          const dot = new THREE.Group();
          dot.position.set((ends.a.x + ends.b.x) / 2 + n.x * 6 * s, elev + body.extrusionHeight / 2, -((ends.a.y + ends.b.y) / 2 + n.y * 6 * s));
          dot.userData = { gizmo: 'offset-wall', bodyId: body.id, index: j };
          const knob = new THREE.Mesh(HANDLE.dot, handleMaterial('#ffffff'));
          knob.scale.setScalar(2.6 * s);
          knob.renderOrder = 30;
          const knobHit = new THREE.Mesh(HANDLE.dot, hiddenMaterial);
          knobHit.scale.setScalar(7 * s);
          dot.add(knob, knobHit);
          gizmoGroup.add(dot);
        }
      }

      // A dot at each corner of the footprint: drag to resize the shape from the opposite corner.
      {
        const bb = selectionBounds([body]);
        if (bb) {
          const xs = [bb.minX, bb.maxX, bb.maxX, bb.minX];
          const ys = [bb.minY, bb.minY, bb.maxY, bb.maxY];
          const out = [[-1, -1], [1, -1], [1, 1], [-1, 1]];
          for (let k = 0; k < 4; k++) {
            const dot = new THREE.Group();
            dot.position.set(xs[k] + out[k][0] * 5 * s, elev + 0.4, -(ys[k] + out[k][1] * 5 * s));
            dot.userData = { gizmo: 'scale-corner', bodyId: body.id, index: k };
            const knob = new THREE.Mesh(HANDLE.dot, handleMaterial('#6e5bff'));
            knob.scale.setScalar(3 * s);
            knob.renderOrder = 30;
            const ring = new THREE.Mesh(HANDLE.dot, handleMaterial('#ffffff'));
            ring.scale.setScalar(3.9 * s);
            ring.renderOrder = 29;
            const knobHit = new THREE.Mesh(HANDLE.dot, hiddenMaterial);
            knobHit.scale.setScalar(8 * s);
            dot.add(ring, knob, knobHit);
            gizmoGroup.add(dot);
          }
        }
      }

      // The selected edges, and a handle to size their bevel.
      const chosen = selectedEdges
        .map((sel) => {
          const edge = sel.bodyId === body.id ? listEdges(body).find((e) => e.kind === sel.kind && e.index === sel.index) : undefined;
          return edge ? edge : null;
        })
        .filter((e): e is EdgePath => !!e);
      chosen.forEach((edge) => helperGroup.add(makeFatLine(edge.points, WARN, 4.5)));

      if (chosen.length) {
        const edge = chosen[0];
        const mi = Math.floor(edge.points.length / 2);
        const mid = edge.points[mi];
        const prev = edge.points[Math.max(0, mi - 1)];
        const next = edge.points[Math.min(edge.points.length - 1, mi + 1)];
        const cx = body.points.reduce((acc, p) => acc + p.x, 0) / body.points.length;
        const cy = body.points.reduce((acc, p) => acc + p.y, 0) / body.points.length;
        const out = new THREE.Vector3(mid.x - cx, 0, mid.z + cy);
        const tangent = new THREE.Vector3(next.x - prev.x, next.y - prev.y, next.z - prev.z);
        if (edge.kind !== 'corner' && tangent.lengthSq() > 0) {
          const side = new THREE.Vector3(0, 1, 0).cross(tangent).normalize();
          if (side.dot(out) < 0) side.negate();
          out.copy(side);
        }
        out.y = 0;
        out.normalize().multiplyScalar(9 * s);

        const handle = new THREE.Group();
        handle.position.set(mid.x + out.x, mid.y + (edge.kind === 'bottom' ? -4 * s : edge.kind === 'top' ? 4 * s : 0), mid.z + out.z);
        handle.userData = { gizmo: 'edge-size', bodyId: body.id };
        const knob = new THREE.Mesh(HANDLE.dot, handleMaterial(WARN));
        knob.scale.setScalar(3.6 * s);
        knob.renderOrder = 32;
        const knobHit = new THREE.Mesh(HANDLE.dot, hiddenMaterial);
        knobHit.scale.setScalar(9 * s);
        handle.add(knob, knobHit);
        gizmoGroup.add(handle);
        anchorRef.current = { pos: handle.position.clone(), lift: 40 };
      }
    }

    // Handles spring in when the selection changes (not on every edit of the same selection).
    const popKey = `${ids.join(',')}|${selectedFace ? `${selectedFace.kind}${selectedFace.index ?? ''}` : ''}|${selectedEdges.length}`;
    gizmoGroup.children.forEach((c) => (c.userData.baseScale = c.scale.x));
    if (popKeyRef.current !== popKey) {
      popKeyRef.current = popKey;
      popRef.current = { start: performance.now() };
      gizmoGroup.children.forEach((c) => c.scale.setScalar(0.0001));
    }
    invalidateRef.current();
  }, [bodies, selectedBodyId, selectedBodyIds, selectedEdges, selectedFace, moveOn, isSceneReady, handsOff]);

  // ---- Draw tool: lives while a sketch is open --------------------------------
  useEffect(() => {
    const api = drawApiRef.current;
    if (!drawing || !isSceneReady || !api) return;
    const tool = createDrawTool(api, () => live.current.draw, {
      set: (next) => live.current.onUpdateDraw(next),
      finish: (outline, planeY, frame) => live.current.onFinishDraw(outline, planeY, frame),
      notify: (m) => live.current.onNotify(m),
    });
    drawToolRef.current = tool;
    return () => {
      tool.dispose();
      drawToolRef.current = null;
    };
  }, [drawing, isSceneReady]);
  useEffect(() => {
    drawToolRef.current?.refresh();
  }, [draw]);

  // The camera looks straight at whatever is being drawn on: down at the ground or a top face, or square on to a wall.
  const wallKey = draw?.frame ? JSON.stringify(draw.frame) : null;
  useEffect(() => {
    if (!drawing || !isSceneReady) return;
    if (!draw?.frame) {
      frameViewRef.current('top');
      return;
    }
    const f = draw.frame;
    const centre = new THREE.Vector3(f.x, f.h, -f.y);
    frameViewRef.current('keep', false, frameNormal(f), { center: centre, radius: 90 });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [drawing, isSceneReady, wallKey]);

  // Drawing is flat work: the camera looks straight down at the surface, turning is off so it stays like paper
  // (drag pans, pinch or scroll zooms), and the old viewing angle comes back when the sketch is done.
  useEffect(() => {
    const api = drawApiRef.current;
    if (!drawing || !isSceneReady || !api) return;
    const { camera, controls } = api;
    const saved = { pos: camera.position.clone(), target: controls.target.clone() };
    controls.enableRotate = false;
    controls.mouseButtons.LEFT = THREE.MOUSE.PAN;
    controls.touches.ONE = THREE.TOUCH.PAN;
    return () => {
      controls.enableRotate = true;
      controls.mouseButtons.LEFT = THREE.MOUSE.ROTATE;
      controls.touches.ONE = THREE.TOUCH.ROTATE;
      // After this commit's other effects (a new shape reframes the view): go back to where the user was looking.
      // It looks the same way as before, framed so the new shape is in view too.
      window.setTimeout(() => frameViewRef.current('keep', false, saved.pos.clone().sub(saved.target)), 0);
    };
  }, [drawing, isSceneReady]);

  // ---- Repeat preview: ghost copies, the path and its two handles -----------
  useEffect(() => {
    const group = previewGroupRef.current;
    if (!isSceneReady || !group) return;
    clearGroup(group);
    const src = repeat && bodies.find((b) => b.id === repeat.bodyId);
    // The path and ghosts of a shape on a wall are drawn in its own space and stood on the wall.
    group.matrixAutoUpdate = false;
    if (src?.frame) group.matrix.copy(frameMatrix(src.frame));
    else group.matrix.identity();
    group.matrixWorldNeedsUpdate = true;
    if (!repeat || !src) {
      invalidateRef.current();
      return;
    }

    const top = (src.elevation ?? 0) + src.extrusionHeight;
    const at = (p: Point2D, lift = 0.6) => new THREE.Vector3(p.x, top + lift, -p.y);
    const fillMat = shared(new THREE.MeshBasicMaterial({ color: ACCENT, transparent: true, opacity: 0.28, depthWrite: false, side: THREE.DoubleSide }));
    const edgeMat = shared(new THREE.LineBasicMaterial({ color: ACCENT_LIGHT, transparent: true, opacity: 0.9 }));

    // Ghost of every copy: its top face outline, lightly filled, placed with the same move the real copy will get.
    copyTransforms(repeat).forEach((t) => {
      const pts = transformBody(src.frame ? { ...src, frame: undefined } : src, t).points!;
      const fill = new THREE.Mesh(new THREE.ShapeGeometry(new THREE.Shape(pts.map((p) => new THREE.Vector2(p.x, p.y)))), fillMat);
      fill.rotation.x = -Math.PI / 2;
      fill.position.y = top + 0.4;
      fill.renderOrder = 37;
      const edge = new THREE.LineLoop(new THREE.BufferGeometry().setFromPoints(pts.map((p) => at(p, 0.5))), edgeMat);
      edge.renderOrder = 38;
      group.add(fill, edge);
    });

    // The path itself.
    const toWorld = (p: Point2D) => at(p);
    const pts: THREE.Vector3[] = [];
    for (let i = 0; i <= 64; i++) {
      const u = i / 64;
      if (repeat.kind === 'around') {
        const r = Math.hypot(repeat.start.x - repeat.end.x, repeat.start.y - repeat.end.y);
        const a0 = Math.atan2(repeat.start.y - repeat.end.y, repeat.start.x - repeat.end.x);
        pts.push(toWorld({ x: repeat.end.x + r * Math.cos(a0 + u * 2 * Math.PI), y: repeat.end.y + r * Math.sin(a0 + u * 2 * Math.PI) }));
      } else {
        const c = repeat.bend;
        const v = 1 - u;
        pts.push(
          toWorld(
            c
              ? { x: v * v * repeat.start.x + 2 * v * u * c.x + u * u * repeat.end.x, y: v * v * repeat.start.y + 2 * v * u * c.y + u * u * repeat.end.y }
              : { x: repeat.start.x + (repeat.end.x - repeat.start.x) * u, y: repeat.start.y + (repeat.end.y - repeat.start.y) * u }
          )
        );
      }
    }
    const pathLine = new THREE.Line(new THREE.BufferGeometry().setFromPoints(pts), new THREE.LineBasicMaterial({ color: ACCENT, depthTest: false }));
    pathLine.renderOrder = 39;
    group.add(pathLine);

    // Handles: where the copies end (or the circle's centre), and the middle of the path to bend it.
    const sizeNow = Math.max(...src.points.map((p) => Math.hypot(p.x - repeat.start.x, p.y - repeat.start.y)), 10);
    const s = clamp(sizeNow / 22, 0.7, 2.4);
    const addHandle = (kind: 'end' | 'bend', p: Point2D, color: string) => {
      const h = new THREE.Group();
      h.position.copy(at(p));
      h.userData.repeatHandle = kind;
      const knob = new THREE.Mesh(HANDLE.dot, handleMaterial(color));
      knob.scale.setScalar(3.4 * s);
      knob.renderOrder = 42;
      const hit = new THREE.Mesh(HANDLE.dot, hiddenMaterial);
      hit.scale.setScalar(9 * s);
      h.add(knob, hit);
      group.add(h);
    };
    addHandle('end', repeat.end, '#ffffff');
    if (repeat.kind === 'path') addHandle('bend', bendHandle(repeat), ACCENT_LIGHT);
    repeatAnchorRef.current = new THREE.Vector3(repeat.start.x, 0, -repeat.start.y).applyMatrix4(group.matrix);
    placePanelRef.current();
    invalidateRef.current();
  }, [repeat, bodies, isSceneReady]);

  useEffect(() => setPickerOpen(false), [selectedEdges]);

  // Tapping a face shows its number; so does editing it by any other route.
  const faceId = selectedFace ? `${selectedFace.bodyId}:${selectedFace.kind === 'wall' ? 'wall' : selectedFace.kind}:${selectedFace.index ?? ''}` : null;
  const faceBody = selectedFace && selectedBodyIds.length === 1 ? bodies.find((b) => b.id === selectedFace.bodyId) : undefined;
  const measureNow = selectedFace && faceBody ? faceMeasure(faceBody, selectedFace) : null;
  useEffect(() => {
    if (faceId && measureNow) showReadout(faceId, measureNow.label, measureNow.value);
    else {
      window.clearTimeout(readoutTimer.current);
      setReadout(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [faceId]);
  useEffect(() => {
    if (measureNow) setReadout((r) => (r && r.key === faceId && r.value !== measureNow.value ? { ...r, value: measureNow.value } : r));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [measureNow?.value]);
  useEffect(() => () => window.clearTimeout(readoutTimer.current), []);

  // The picker needs placing even if the camera is still.
  useLayoutEffect(() => {
    invalidateRef.current();
    placePanelRef.current();
  }, [pickerOpen, readout?.key, isSceneReady, repeat?.count, repeat?.kind]);

  // The idle hint depends on selection; hover text takes over while the pointer is over something.
  useEffect(() => {
    clearHoverRef.current();
    onHint?.(
      draw
        ? draw.form === 'shape'
          ? draw.points.length >= 3
            ? 'Tap to add a corner · drag a side to curve it · tap the green corner to finish'
            : draw.planeY === null
              ? 'Tap the ground, the top of a shape, or a wall to start drawing'
              : 'Tap to place corners · drag a corner to move it · drag empty space to pan'
          : draw.cut
            ? 'Drag it out · release to cut it through'
            : 'Drag it out · release to make it'
        : repeat
        ? 'Drag a dot to place the copies · − + sets how many · Enter keeps them · Esc cancels'
        : moveOn && selectedBodyIds.length
          ? 'Drag an arrow to move along X, Y or Z · two-finger tap to hide'
          : selectedFace
          ? 'Drag the highlighted face (or its arrow) to extrude it · drag the rest of the shape to move it'
          : selectedBodyIds.length
          ? 'Drag to move · hold another shape to add it · arrow = height · dots = walls · ring = rotate'
          : 'Click a shape to select it · drag empty space to orbit'
    );
  }, [selectedBodyIds, selectedFace, moveOn, repeating, drawing, draw?.form, draw?.points.length, draw?.planeY, onHint]);

  const pickerBody = selectedEdges.length ? bodies.find((b) => b.id === selectedEdges[0].bodyId) : undefined;
  const pickerStyle: BevelStyle = pickerBody ? edgeStyle(pickerBody, selectedEdges.find((e) => e.kind !== 'corner') ?? selectedEdges[0]) ?? 'round' : 'round';

  // Press a picker button and drag: that profile, sized by the drag.
  const beginPickerDrag = (style: BevelStyle, e: React.PointerEvent<HTMLElement>) => {
    if (!pickerBody) return;
    e.currentTarget.setPointerCapture(e.pointerId);
    const limit = maxBevelSize(pickerBody, selectedEdges);
    const current = edgeSize(pickerBody, primaryEdge(selectedEdges));
    // A first press gives a bevel you can actually see; pressing the other style keeps the size you had.
    const start = Math.min(limit, current > 0 ? current : defaultBevelSize(pickerBody));
    pickerDrag.current = { startY: e.clientY, start, sels: selectedEdges, limit };
    onDragStateChange?.(true);
    onEdgeChange(selectedEdges, { style, size: start });
  };
  const movePickerDrag = (e: React.PointerEvent<HTMLElement>) => {
    const d = pickerDrag.current;
    if (!d) return;
    const size = clamp(Math.round((d.start + (d.startY - e.clientY) * mmPerPixelRef.current() * 0.35) * 2) / 2, 0, d.limit);
    onEdgeChange(d.sels, { size });
    const rect = mountRef.current?.getBoundingClientRect();
    setDragLabel({ text: size <= 0 ? 'No bevel' : size >= d.limit ? `${size} mm · largest that fits` : `${size} mm`, x: e.clientX - (rect?.left ?? 0) + 24, y: e.clientY - (rect?.top ?? 0) - 40 });
  };
  const endPickerDrag = () => {
    if (!pickerDrag.current) return;
    pickerDrag.current = null;
    setDragLabel(null);
    setPickerOpen(false);
    onDragStateChange?.(false);
  };

  const handleSelectCameraAngle = useCallback((face: CubeFace) => frameViewRef.current(face), []);

  return (
    <div className="absolute inset-0 select-none touch-none overflow-hidden">
      <div ref={mountRef} className="absolute inset-0" />

      {hold && (
        <svg className="absolute z-30 pointer-events-none" style={{ left: hold.x - 30, top: hold.y - 30 }} width={60} height={60} viewBox="0 0 60 60">
          <circle cx={30} cy={30} r={24} fill="none" stroke="rgba(255,255,255,0.18)" strokeWidth={4} />
          <motion.circle
            cx={30}
            cy={30}
            r={24}
            fill="none"
            stroke="#a99dff"
            strokeWidth={4}
            strokeLinecap="round"
            transform="rotate(-90 30 30)"
            initial={{ pathLength: 0 }}
            animate={{ pathLength: 1 }}
            transition={{ duration: 0.42, ease: 'linear' }}
          />
        </svg>
      )}

      <div ref={repeatChipRef} className="absolute left-0 top-0 z-20 will-change-transform" style={{ visibility: 'hidden' }}>
        <AnimatePresence>
          {repeat && <RepeatChip session={repeat} onChange={onUpdateRepeat as (fn: (s: RepeatSession) => RepeatSession) => void} onDone={onFinishRepeat} onCancel={onRepeatCancel} />}
        </AnimatePresence>
      </div>

      <div ref={panelRef} className="absolute left-0 top-0 z-20 will-change-transform" style={{ visibility: 'hidden' }}>
        <AnimatePresence mode="wait">
          {readout && selectedFace && !pickerOpen && (
            <MeasureReadout
              key={readout.key}
              label={readout.label}
              value={readout.value}
              onEditStart={() => holdReadout(true)}
              onEditEnd={() => holdReadout(false)}
              onCommit={(mm) => onFaceValue?.(selectedFace, mm)}
              onEdges={
                faceBody && !faceBody.frame
                  ? () => {
                      // Edges already picked on this shape stay selected; this face's edges join them.
                      const kept = selectedEdges.filter((e) => e.bodyId === faceBody.id);
                      onSelectEdges(edgesAroundFace(faceBody, selectedFace).reduce((all, e) => (all.some((k) => edgeKey(k) === edgeKey(e)) ? all : [...all, e]), kept));
                      onSelectFace(null);
                    }
                  : undefined
              }
            />
          )}
          {pickerOpen && selectedEdges.length > 0 && (
            <BevelPicker current={pickerStyle} onPress={beginPickerDrag} onMove={movePickerDrag} onRelease={endPickerDrag} />
          )}
        </AnimatePresence>
      </div>

      <div className="absolute bottom-12 left-0 right-0 z-20 flex justify-center pointer-events-none">
        <AnimatePresence>
          {draw && (
            <div className="pointer-events-auto">
              <DrawChip draw={draw} onForm={onDrawForm} onDone={onDrawDone} onCancel={onDrawCancel} onUndoCorner={onDrawUndoCorner} onCut={onDrawCut} />
            </div>
          )}
        </AnimatePresence>
      </div>

      <ViewCube
        camera={isSceneReady ? cameraRef.current : null}
        onSelectFace={handleSelectCameraAngle}
        onResetCamera={() => handleSelectCameraAngle('iso')}
      >
        <button
          type="button"
          onClick={onToggleXray}
          aria-pressed={xray}
          aria-label="See through shapes"
          title="See through every shape, to pick what is inside another (X). Alt-click picks what is behind."
          className={`h-7 px-2.5 rounded-full border flex items-center gap-1.5 text-xs transition-colors ${
            xray ? 'bg-accent-500 border-accent-300 text-white' : 'bg-slate-800/90 border-white/10 text-slate-300 hover:text-white hover:bg-slate-800'
          }`}
        >
          <Eye size={13} />
          See through
        </button>
      </ViewCube>

      {dragLabel && (
        <div
          className="absolute z-30 pointer-events-none px-2 py-1 rounded-lg bg-slate-950/90 border border-white/15 text-xs font-medium text-white tabular-nums shadow-lg whitespace-nowrap"
          style={{ left: dragLabel.x, top: dragLabel.y }}
        >
          {dragLabel.text}
        </div>
      )}
    </div>
  );
}
