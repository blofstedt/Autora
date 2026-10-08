/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

export interface Point2D {
  x: number;
  y: number;
}

export type MaterialType = 'matte' | 'metal' | 'glossy' | 'glass' | 'neon';

export interface MaterialPreset {
  id: MaterialType;
  name: string;
  color: string;
  roughness: number;
  metalness: number;
  emissiveIntensity?: number;
  transmission?: number;
  ior?: number;
}

export type BevelStyle = 'chamfer' | 'round';

/** A bevel on one top or bottom edge loop of a body. `edge` is a side index of the body's base outline. */
export interface EdgeBevel {
  side: 'top' | 'bottom';
  edge: number;
  size: number;
  style: BevelStyle;
}

/** A rounded or flat bevel on a vertical corner, cut so it follows any bevel on the edges above and below it. */
export interface CornerBevel {
  vertex: number;
  size: number;
  style: BevelStyle;
}

/**
 * Where a shape that stands on a wall sits in the world. Its outline, height and bevels are ordinary (as if it stood on the ground),
 * but its "ground" is the wall plane and its "up" points out of the wall. Shapes drawn on the ground or a top face have no frame.
 */
export interface Frame {
  /** The wall point the outline's origin sits on: plan position and height above the ground. */
  x: number;
  y: number;
  h: number;
  /** Direction the shape grows out of the wall, as an angle in plan (radians, counter-clockwise from +X). */
  angle: number;
}

export interface Body3D {
  id: string;
  name: string;
  /** Final outline as drawn (base outline with corner radii applied). Always derived; edit via withOutline(). */
  points: Point2D[];
  /** Sharp outline the user edits. Defaults to `points` when absent. */
  basePoints?: Point2D[];
  /** Radius of the vertical edge at each base vertex, in mm (0 = sharp). */
  cornerRadii?: number[];
  holes?: Point2D[][];
  /** Sharp outlines of the holes, and the corner radius at each of their vertices, once a hole has been edited. `holes` is derived. */
  holeBases?: Point2D[][];
  holeRadii?: number[][];
  extrusionHeight: number;
  /** Height of the body's underside above the ground plane. */
  elevation?: number;
  /** Bevels on individual top/bottom edges. Nothing is beveled by default. */
  edgeBevels?: EdgeBevel[];
  cornerBevels?: CornerBevel[];
  color: string;
  materialType: MaterialType;
  visible: boolean;
  createdAt: string;
  groupId?: string;
  /** Set on a shape drawn on a wall: see Frame. Absent for everything standing upright. */
  frame?: Frame;
  /** Set on a derived copy made by a live repeat: the id of the shape it follows. Never edited directly. */
  repeatOf?: string;
  /** Set on a shape that belongs to a linked library object: the id of that placed object (a group). Derived from the library, rebuilt on every change. */
  instanceOf?: string;
}

/** A selectable edge of a body: a top or bottom edge loop, or a vertical corner edge. */
/** A tapped face of a shape: its top or bottom, or one of its walls (`index` = base side). */
export interface FaceSel {
  bodyId: string;
  kind: 'top' | 'bottom' | 'wall';
  index?: number;
}

export interface EdgeSel {
  bodyId: string;
  kind: 'top' | 'bottom' | 'corner';
  /** Canonical side index for top/bottom, base vertex index for corner. Holes use `1000 * (hole + 1) + n` (see outline.ts). */
  index: number;
}

/** Where a placed library object sits: its footprint centre, its underside, and a turn (radians, counter-clockwise from above). */
export interface Placement {
  x: number;
  y: number;
  z: number;
  angle: number;
}

/**
 * A reusable object kept in the project: a snapshot of a group (or one shape), centred on the ground at the origin.
 * Placed copies follow it. `bodies[].groupId === ROOT` means directly inside the object.
 */
export interface LibraryItem {
  id: string;
  name: string;
  /** Also kept in the app-wide library, so every project can place it. */
  shared?: boolean;
  /** When it was last changed (ms). The newer copy wins when a project and the app-wide library disagree. */
  rev?: number;
  bodies: Body3D[];
  /** The groups inside the object (not the object itself); their parentId may be ROOT. */
  groups: ShapeGroup[];
}

export const ROOT = '@root';

export interface ShapeGroup {
  id: string;
  name: string;
  /** Every shape inside, at any depth. Derived: see utils/groups.ts. */
  bodyIds: string[];
  /** The group this one sits inside, when groups nest (a "head" inside a "character"). */
  parentId?: string;
  /** A placed library object: the item it follows. With `place` it is linked (its shapes are derived); without, it is open for editing. */
  libraryId?: string;
  place?: Placement;
  /** On the inner groups of a placed object: the placed object they belong to. Derived with the shapes. */
  instanceOf?: string;
  /** Made by Join or Subtract: the pieces form one solid, so it is presented as a single shape. */
  joined?: boolean;
}

/** An open Repeat: the shape being copied and the path its copies follow, edited live until Done. */
export interface RepeatSession {
  bodyId: string;
  /** `path`: along a line (bent by `bend`). `around`: round the circle centred on `end` that passes through `start`. */
  kind: 'path' | 'around';
  /** Centre of the original shape. */
  start: Point2D;
  /** End of the path, or the centre of the circle. */
  end: Point2D;
  /** Control point of the curve; null keeps the path straight. */
  bend: Point2D | null;
  /** Number of shapes including the original. */
  count: number;
  /** Turn each copy to face along the path. */
  follow: boolean;
  /** Set once the repeat is kept: it then lives in the document and its copies follow the source. */
  linkId?: string;
}

/** A kept repeat. The copies it makes are derived: they are rebuilt whenever the source or the path changes. */
export type RepeatLink = RepeatSession & { linkId: string };

/** What the Draw tool is making. */
export type DrawForm = 'shape' | 'rectangle' | 'circle';

/** An open Draw: an outline being sketched on the ground or on the top of a shape. */
export interface DrawSession {
  form: DrawForm;
  /** Height of the surface being drawn on; null until the first tap picks the ground or a top face. */
  planeY: number | null;
  /** Corners placed so far (`shape`). */
  points: Point2D[];
  /** `bends[i]`: a point the side from corner i to the next passes through, making it a curve. Null = straight. */
  bends: (Point2D | null)[];
  /** Drawing on a wall: the wall the sketch lies on. Absent on the ground or a top face. */
  frame?: Frame;
  /** Drawing on the top of this shape. */
  hostId?: string;
  /** Cut the sketch out of that shape (a hole straight through) instead of adding a new shape. */
  cut?: boolean;
}

export const MATERIAL_PRESETS: MaterialPreset[] = [
  {
    id: 'matte',
    name: 'Matte Polymer',
    color: '#3b82f6', // blue
    roughness: 0.8,
    metalness: 0.1
  },
  {
    id: 'metal',
    name: 'Anodized Steel',
    color: '#94a3b8', // slate/gray
    roughness: 0.2,
    metalness: 0.95
  },
  {
    id: 'glossy',
    name: 'Polished Lacquer',
    color: '#ef4444', // red
    roughness: 0.05,
    metalness: 0.0
  },
  {
    id: 'glass',
    name: 'Translucent Acrylic',
    color: '#10b981', // green
    roughness: 0.1,
    metalness: 0.0,
    transmission: 0.8,
    ior: 1.5
  },
  {
    id: 'neon',
    name: 'Emissive Lasing',
    color: '#eab308', // yellow
    roughness: 0.5,
    metalness: 0.0,
    emissiveIntensity: 1.5
  }
];

export const GRID_SPACING = 20; // grid snap interval in pixels

export interface ColorSwatch {
  name: string;
  value: string;
}

export const SWATCHES: ColorSwatch[] = [
  { name: 'Cobalt Blue', value: '#3b82f6' },
  { name: 'Lead Gray', value: '#475569' },
  { name: 'Crimson Red', value: '#ef4444' },
  { name: 'Teal Forest', value: '#0d9488' },
  { name: 'Neon Amber', value: '#f59e0b' },
  { name: 'Emerald', value: '#10b981' },
  { name: 'Hot Pink', value: '#db2777' },
  { name: 'Brass Gold', value: '#b45309' },
  { name: 'Royal Violet', value: '#6d28d9' },
  { name: 'Snow Pearl', value: '#f1f5f9' },
];

