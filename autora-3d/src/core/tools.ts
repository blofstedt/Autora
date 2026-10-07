/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

import { Body3D } from '../types';
import { Doc, IdGen } from './doc';
import { fail } from './errors';
import { AgentError } from './errors';
import { thumbnailSvg } from '../utils/thumbnail';
import { describeEdgesOf, describeFaces, libraryItems, meshReport, sceneSummary, summarize } from './inspect';
import * as ops from './ops';

/** A JSON-Schema-described command an agent can call. These specs are what MCP and LLM tool-use want. */
export interface ToolSpec {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  /** True when it only reads: it never changes the model. */
  readOnly?: boolean;
  /** True when only the live app can do it (it needs a screen). */
  uiOnly?: boolean;
}

const point = { type: 'object', properties: { x: { type: 'number' }, y: { type: 'number' } }, required: ['x', 'y'], description: 'A point on the ground plane, mm.' };
const ids = { type: 'array', items: { type: 'string' }, minItems: 1, description: 'Shape ids.' };
const face = {
  description: 'A face: "top", "bottom", or {"kind":"wall","index":n}. shape_faces lists them with their indices.',
  oneOf: [{ type: 'string', enum: ['top', 'bottom'] }, { type: 'object', properties: { kind: { const: 'wall' }, index: { type: 'integer' } }, required: ['kind', 'index'] }],
};
const surface = {
  description:
    'Where to draw. "ground" (default); {"topOf": id} the top face of a shape; {"z": mm} a horizontal plane at a height; or {"wallOf": id, "wall": index, "along"?: mm, "up"?: mm} one of its walls (the sketch then lies in the wall: x runs to the right as you face it, y runs up, both from the middle of the wall; "along"/"up" shift that origin).',
  oneOf: [
    { type: 'string', enum: ['ground'] },
    { type: 'object', properties: { topOf: { type: 'string' } }, required: ['topOf'] },
    { type: 'object', properties: { z: { type: 'number' } }, required: ['z'] },
    { type: 'object', properties: { wallOf: { type: 'string' }, wall: { type: 'integer' }, along: { type: 'number' }, up: { type: 'number' } }, required: ['wallOf', 'wall'] },
  ],
};
const sketch = {
  form: { type: 'string', enum: ['polygon', 'rectangle', 'circle'] },
  points: { type: 'array', items: point, minItems: 3, description: 'polygon: the corners in order.' },
  bends: { type: 'array', items: { oneOf: [point, { type: 'null' }] }, description: 'polygon: for each side (corner i to corner i+1, the last closes the shape) a point the side passes through, making it a curve; null keeps it straight.' },
  from: { ...point, description: 'rectangle: one corner.' },
  to: { ...point, description: 'rectangle: the opposite corner.' },
  center: { ...point, description: 'circle: its centre.' },
  radius: { type: 'number', description: 'circle: radius, mm.' },
};
const material = { type: 'string', enum: ['matte', 'metal', 'glossy', 'glass', 'neon'] };
const color = { type: 'string', description: 'Hex colour such as "#3b82f6".' };

const obj = (properties: Record<string, unknown>, required: string[] = []) => ({ type: 'object', properties, required, additionalProperties: false });

export const TOOL_SPECS: ToolSpec[] = [
  {
    name: 'scene_get',
    description:
      'List every shape in the model with its id, name, size, position, material, bevels, group and repeat, plus groups and the overall bounding box. Start here. Axes: x to the right, y away from the front, z up; all in millimetres. A shape stands on its "bottom" z and rises to its "top".',
    inputSchema: obj({ includeCopies: { type: 'boolean', description: 'Also list the copies a live repeat makes (hidden by default; they follow their source).' } }),
    readOnly: true,
  },
  { name: 'shape_get', description: 'Everything about one shape: its summary, raw outline, faces and edges.', inputSchema: obj({ id: { type: 'string' } }, ['id']), readOnly: true },
  { name: 'shape_faces', description: 'The faces of a shape (top, bottom, each wall) with how to name them in commands, which way each wall faces, and its measurement.', inputSchema: obj({ id: { type: 'string' } }, ['id']), readOnly: true },
  { name: 'shape_edges', description: 'The bevel-able edges of a shape (top/bottom rims by index, vertical corners), with their length and any bevel.', inputSchema: obj({ id: { type: 'string' } }, ['id']), readOnly: true },
  {
    name: 'shape_measure',
    description: 'Build the real solid (bevels and all) and report its volume (mm³), surface area, triangle count and whether it is watertight (printable). Slower than the others.',
    inputSchema: obj({ id: { type: 'string' } }, ['id']),
    readOnly: true,
  },
  {
    name: 'shape_add',
    description:
      'Add a stock shape: box, roundedBox, cylinder, triangle, wedge, pentagon, hexagon, octagon or star. It is centred at x,y (default: beside the existing shapes), stands on elevation (default 0, the ground) and rises height mm. With onTopOf it sits on top of that shape.',
    inputSchema: obj(
      {
        kind: { type: 'string', enum: ['box', 'roundedBox', 'cylinder', 'triangle', 'wedge', 'pentagon', 'hexagon', 'octagon', 'star'] },
        x: { type: 'number' },
        y: { type: 'number' },
        width: { type: 'number', description: 'Size along x, mm (default 60).' },
        depth: { type: 'number', description: 'Size along y, mm (default: same as width for round and regular shapes, else 60).' },
        height: { type: 'number', description: 'Default 40.' },
        elevation: { type: 'number', description: 'Height of its underside above the ground.' },
        onTopOf: { type: 'string', description: 'Id of a shape to sit on.' },
        name: { type: 'string' },
        color,
        material,
      },
      ['kind']
    ),
  },
  {
    name: 'shape_draw',
    description:
      'Sketch an outline (polygon with optional curved sides, rectangle or circle) on a surface and extrude it into a new shape (default 20 mm). On a wall the shape grows out of the wall.',
    inputSchema: obj({ ...sketch, surface, height: { type: 'number', description: 'How far it extrudes, mm (default 20). On a wall: out from the wall.' }, name: { type: 'string' }, color, material }, ['form']),
  },
  {
    name: 'shape_cut',
    description:
      'Cut a hole or pocket into a shape: sketch an outline on its top face and cut it down by depth mm (or all the way through when depth is omitted). Upright shapes only.',
    inputSchema: obj({ target: { type: 'string' }, ...sketch, surface, depth: { type: 'number' } }, ['target', 'form']),
  },
  {
    name: 'shape_set',
    description:
      'Change a shape: name, colour, material, visibility, height, elevation (its underside), one radius for all vertical corners, or replace its outline with new corner points (this clears its holes and bevels).',
    inputSchema: obj(
      {
        id: { type: 'string' },
        name: { type: 'string' },
        color,
        material,
        visible: { type: 'boolean' },
        height: { type: 'number' },
        elevation: { type: 'number' },
        cornerRadius: { type: 'number' },
        outline: obj({ points: { type: 'array', items: point, minItems: 3 }, cornerRadii: { type: 'array', items: { type: 'number' } } }, ['points']),
      },
      ['id']
    ),
  },
  {
    name: 'shape_move',
    description: 'Move shapes (and their group-mates; a live repeat\'s path goes with its shape). Either by an offset, or to a place: footprint centre x,y and underside z.',
    inputSchema: obj(
      {
        ids,
        by: obj({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }),
        to: obj({ x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' } }),
      },
      ['ids']
    ),
  },
  {
    name: 'shape_turn',
    description: 'Turn shapes about the vertical axis. Positive degrees turn counter-clockwise seen from above. Default pivot: the centre of the shapes.',
    inputSchema: obj({ ids, degrees: { type: 'number' }, about: point }, ['ids', 'degrees']),
  },
  {
    name: 'shape_resize',
    description: 'Set a shape\'s overall width (x), depth (y) and/or height (z). Corners and bevels stay valid.',
    inputSchema: obj({ id: { type: 'string' }, width: { type: 'number' }, depth: { type: 'number' }, height: { type: 'number' } }, ['id']),
  },
  {
    name: 'face_set',
    description: 'Type a number for a face, as a person would: set the height (top/bottom) or the size across a wall. The shape grows or shrinks to match.',
    inputSchema: obj({ id: { type: 'string' }, face, value: { type: 'number' } }, ['id', 'face', 'value']),
  },
  {
    name: 'face_push',
    description: 'Push or pull a face by a distance (positive pulls it outward, negative pushes it in).',
    inputSchema: obj({ id: { type: 'string' }, face, by: { type: 'number' } }, ['id', 'face', 'by']),
  },
  {
    name: 'edge_bevel',
    description:
      'Bevel edges: curved ("round") or flat ("chamfer"). Choose edges by list, by group (top, bottom, corner = vertical corners, all) or every edge around a face. size 0 removes the bevel; for vertical corners size is the corner radius. Sizes are held to what the shape allows; the result reports the size you got.',
    inputSchema: obj(
      {
        id: { type: 'string' },
        edges: { type: 'array', items: obj({ kind: { type: 'string', enum: ['top', 'bottom', 'corner'] }, index: { type: 'integer' } }, ['kind', 'index']) },
        group: { type: 'string', enum: ['top', 'bottom', 'corner', 'all'] },
        aroundFace: face,
        size: { type: 'number' },
        style: { type: 'string', enum: ['round', 'chamfer'] },
      },
      ['id', 'size']
    ),
  },
  { name: 'shape_delete', description: 'Delete shapes (and their group-mates, and the copies of their live repeats).', inputSchema: obj({ ids }, ['ids']) },
  {
    name: 'shape_duplicate',
    description: 'Duplicate shapes, offset by (35, −35) mm unless by is given.',
    inputSchema: obj({ ids, by: obj({ x: { type: 'number' }, y: { type: 'number' } }) }, ['ids']),
  },
  { name: 'group_create', description: 'Group shapes so they select, move and turn together, and give the group a name (it becomes the object name in GLB export). Groups nest: a group that is wholly inside the ids is put inside the new one, so group "head" + "body" makes one "character".', inputSchema: obj({ ids, name: { type: 'string' } }, ['ids']) },
  { name: 'group_rename', description: 'Rename a group (e.g. "head"). Find group ids with scene_get.', inputSchema: obj({ group: { type: 'string' }, name: { type: 'string' } }, ['group', 'name']) },
  {
    name: 'library_list',
    description: 'The project library: reusable objects with their size and how many linked copies are placed.',
    inputSchema: obj({}),
    readOnly: true,
  },
  {
    name: 'library_save',
    description: 'Save a group (or one ungrouped shape) to the project library under its name. It stays in the scene as the first linked copy. If the group was opened with object_unlink it updates its library object instead, and every linked copy follows.',
    inputSchema: obj({ group: { type: 'string' }, id: { type: 'string', description: 'A single ungrouped shape, when there is no group.' }, name: { type: 'string' } }),
  },
  {
    name: 'library_place',
    description: 'Place a linked copy of a library object (default: beside the scene; or on top of a shape). A linked copy moves, turns and deletes as one piece and follows its library object; to change the object use object_unlink then library_save.',
    inputSchema: obj({ item: { type: 'string' }, x: { type: 'number' }, y: { type: 'number' }, z: { type: 'number' }, angle: { type: 'number', description: 'Degrees, counter-clockwise from above.' }, onTopOf: { type: 'string' }, name: { type: 'string' } }, ['item']),
  },
  {
    name: 'object_unlink',
    description: 'Open a linked copy for editing: its shapes become ordinary, you edit them, then library_save the group to update the library object (all copies follow). With forget:true it becomes separate shapes for good.',
    inputSchema: obj({ group: { type: 'string' }, forget: { type: 'boolean' } }, ['group']),
  },
  { name: 'library_thumbnail', description: 'A small picture of a library object (or of a shape group in the scene via `shapes`) as SVG text: isometric, coloured, no GL needed.', inputSchema: obj({ item: { type: 'string' }, shapes: { type: 'array', items: { type: 'string' } }, size: { type: 'number', description: 'Pixels, default 96.' } }), readOnly: true },
  { name: 'library_share', description: 'Keep a library object in the app-wide library too, so every project can place it (shared:false stops that; placed copies stay). Only the live app has an app-wide library; elsewhere use library_export / library_import to carry objects between projects.', inputSchema: obj({ item: { type: 'string' }, shared: { type: 'boolean', description: 'Default true.' } }, ['item']) },
  { name: 'library_export', description: 'The library objects as JSON (all, or the ones in `items`), to keep or to hand to library_import in another project.', inputSchema: obj({ items: { type: 'array', items: { type: 'string' } } }), readOnly: true },
  { name: 'library_import', description: 'Add library objects from library_export. An object already here is replaced only by a newer one (its linked copies follow).', inputSchema: obj({ items: { type: 'array', items: { type: 'object' } } }, ['items']) },
  { name: 'library_rename', description: 'Rename a library object.', inputSchema: obj({ item: { type: 'string' }, name: { type: 'string' } }, ['item', 'name']) },
  { name: 'library_remove', description: 'Remove a library object. Its placed copies stay as ordinary shapes.', inputSchema: obj({ item: { type: 'string' } }, ['item']) },
  { name: 'group_remove', description: 'Dissolve one group (its shapes and inner groups stay, moving up into the group around it).', inputSchema: obj({ group: { type: 'string' } }, ['group']) },
  {
    name: 'shapes_join',
    description: 'Join shapes into one solid: outlines are united wherever they overlap or touch, each keeping its own height and elevation. Bevels on the inputs are not kept.',
    inputSchema: obj({ ids }, ['ids']),
  },
  {
    name: 'shapes_subtract',
    description: 'Cut the cutters out of the "from" shapes where they overlap in height (the cutters are used up). A short cutter leaves a slab above and below.',
    inputSchema: obj({ from: ids, cutters: ids }, ['from', 'cutters']),
  },
  {
    name: 'repeat_set',
    description:
      'Make (or change) a live repeat: copies of a shape equally spaced along a straight or curved path, or around a circle. The copies follow the shape: edit the source and all of them update. count includes the original. Path: give "end", or "direction" (degrees) and "gap"; "bend" curves it. Around: "center" of the circle. Call again with the same id to change the repeat.',
    inputSchema: obj(
      {
        id: { type: 'string', description: 'The shape to repeat.' },
        kind: { type: 'string', enum: ['path', 'around'] },
        count: { type: 'integer' },
        gap: { type: 'number', description: 'Distance between neighbours along the path, mm.' },
        end: point,
        direction: { type: 'number' },
        bend: { oneOf: [point, { type: 'null' }] },
        center: point,
        follow: { type: 'boolean', description: 'Turn each copy to face along the path.' },
      },
      ['id']
    ),
  },
  { name: 'repeat_remove', description: 'Let go of a live repeat: its copies stay as ordinary shapes you can edit one by one.', inputSchema: obj({ id: { type: 'string' } }, ['id']) },
  { name: 'doc_get', description: 'The whole document as JSON (shapes, groups, repeats): save it, or hand it back to doc_set later.', inputSchema: obj({}), readOnly: true },
  { name: 'doc_set', description: 'Replace the whole model with a document from doc_get.', inputSchema: obj({ doc: { type: 'object' } }, ['doc']) },
  { name: 'doc_clear', description: 'Remove every shape.', inputSchema: obj({}) },
  { name: 'history_undo', description: 'Undo the last change.', inputSchema: obj({}) },
  { name: 'history_redo', description: 'Redo the last undone change.', inputSchema: obj({}) },
  {
    name: 'export',
    description: 'Export the visible shapes. format "stl" (binary, Z-up, returned as base64), "glb" (binary glTF for game engines: metres, Y-up, keeps colours and materials, returned as base64), "obj" (text) or "json" (the document). glb options: scale (output metres per scene mm, default 0.001) and pivot ("scene" as placed, "asset" centred on the ground, "shape" one pivot per shape at the centre of its base).',
    inputSchema: obj({ format: { type: 'string', enum: ['stl', 'glb', 'obj', 'json'] }, scale: { type: 'number' }, pivot: { type: 'string', enum: ['scene', 'asset', 'shape'] } }, ['format']),
    readOnly: true,
  },
  {
    name: 'batch',
    description: 'Run several commands in order. By default all-or-nothing: if one fails nothing is changed and you are told which. Later commands can use ids returned earlier only by calling again, so give shapes explicit names and look them up with scene_get, or use ids from the response.',
    inputSchema: obj({ commands: { type: 'array', items: obj({ tool: { type: 'string' }, args: { type: 'object' } }, ['tool']) }, atomic: { type: 'boolean' } }, ['commands']),
  },
  // Only the live app can do these: they need a screen.
  { name: 'ui_select', description: 'Select shapes in the live app, so the person sees what you mean.', inputSchema: obj({ ids: { type: 'array', items: { type: 'string' } } }, ['ids']), uiOnly: true },
  {
    name: 'ui_view',
    description: 'Turn the live app\'s camera: iso, top, bottom, front, back, left or right; "fit" frames everything.',
    inputSchema: obj({ view: { type: 'string', enum: ['iso', 'top', 'bottom', 'front', 'back', 'left', 'right', 'fit'] } }, ['view']),
    uiOnly: true,
  },
  { name: 'ui_xray', description: 'Turn See through mode on or off in the live app.', inputSchema: obj({ on: { type: 'boolean' } }, ['on']), uiOnly: true },
  { name: 'ui_screenshot', description: 'A PNG of the live app\'s 3D view, as a data URL.', inputSchema: obj({}), readOnly: true, uiOnly: true },
];

export const toolByName = (name: string) => TOOL_SPECS.find((t) => t.name === name);

export interface ToolContext {
  doc: Doc;
  ids: IdGen;
}

export interface ToolOutcome {
  doc: Doc;
  result: unknown;
}

const asArgs = (args: unknown): Record<string, any> => (args && typeof args === 'object' ? (args as Record<string, any>) : {});

/** Runs one document tool against a document: pure, no history, no side effects. Throws AgentError on a bad request. */
export function runDocTool(ctx: ToolContext, name: string, rawArgs: unknown): ToolOutcome {
  const a = asArgs(rawArgs);
  const { doc, ids } = ctx;
  const done = <T>(r: ops.OpResult<T>): ToolOutcome => ({ doc: r.doc, result: r.result });
  switch (name) {
    case 'scene_get':
      return { doc, result: sceneSummary(doc, { includeCopies: !!a.includeCopies }) };
    case 'shape_get': {
      const b = ops.need(doc, a.id);
      return { doc, result: { summary: summarize(doc, b), outline: { points: b.points, basePoints: b.basePoints, cornerRadii: b.cornerRadii, holes: b.holes }, faces: describeFaces(b), edges: describeEdgesOf(b) } };
    }
    case 'shape_faces':
      return { doc, result: describeFaces(ops.need(doc, a.id)) };
    case 'shape_edges':
      return { doc, result: describeEdgesOf(ops.need(doc, a.id)) };
    case 'shape_measure': {
      const b = ops.need(doc, a.id);
      const report = meshReport(b);
      return { doc, result: report ?? fail('That shape has no solid (its outline is degenerate).') };
    }
    case 'shape_add':
      return done(ops.addShape(doc, ids, a as ops.AddShapeArgs));
    case 'shape_draw':
      return done(ops.drawShape(doc, ids, a as ops.DrawArgs));
    case 'shape_cut':
      return done(ops.cutInto(doc, ids, a as ops.CutArgs));
    case 'shape_set':
      return done(ops.setShape(doc, a as ops.SetArgs));
    case 'shape_move':
      return done(ops.moveShapes(doc, a as ops.MoveArgs));
    case 'shape_turn':
      return done(ops.turnShapes(doc, a as ops.TurnArgs));
    case 'shape_resize':
      return done(ops.resizeShape(doc, a as { id: string }));
    case 'face_set':
      return done(ops.setFace(doc, a as { id: string; face: ops.FaceSpec; value: number }));
    case 'face_push':
      return done(ops.pushFace(doc, a as { id: string; face: ops.FaceSpec; by: number }));
    case 'edge_bevel':
      return done(ops.bevelEdges(doc, a as ops.BevelArgs));
    case 'shape_delete':
      return done(ops.deleteShapes(doc, a as { ids: string[] }));
    case 'shape_duplicate':
      return done(ops.duplicateShapes(doc, ids, a as { ids: string[] }));
    case 'group_create':
      return done(ops.groupShapes(doc, ids, a as { ids: string[] }));
    case 'group_rename':
      return done(ops.renameGroup(doc, a as { group: string; name: string }));
    case 'library_list':
      return { doc: ctx.doc, result: { items: libraryItems(doc) } };
    case 'library_save':
      return done(ops.saveToLibrary(doc, ids, a as { group?: string; id?: string; name?: string }));
    case 'library_place':
      return done(ops.placeFromLibrary(doc, ids, a as ops.PlaceArgs));
    case 'object_unlink':
      return done(ops.unlinkObject(doc, ids, a as { group: string; forget?: boolean }));
    case 'library_thumbnail': {
      const size = Math.max(16, Math.min(512, Number(a.size) || 96));
      if (Array.isArray(a.shapes)) return { doc, result: { svg: thumbnailSvg(a.shapes.map((id: string) => ops.need(doc, id)), size) } };
      const item = doc.library.find((i) => i.id === a.item);
      if (!item) throw new AgentError(`No library object "${String(a.item)}".`, `Library: ${doc.library.map((i) => i.id).join(', ') || 'empty'}`);
      return { doc, result: { item: item.id, svg: thumbnailSvg(item.bodies, size) } };
    }
    case 'library_share':
      return done(ops.shareLibraryItem(doc, a as { item: string; shared?: boolean }));
    case 'library_export': {
      const want = Array.isArray(a.items) ? new Set<string>(a.items) : null;
      return { doc, result: { items: doc.library.filter((i) => !want || want.has(i.id)) } };
    }
    case 'library_import':
      return done(ops.importLibrary(doc, a as { items: unknown }));
    case 'library_rename':
      return done(ops.renameLibraryItem(doc, a as { item: string; name: string }));
    case 'library_remove':
      return done(ops.removeLibraryItem(doc, a as { item: string }));
    case 'group_remove':
      return done(ops.ungroupShapes(doc, ids, a as { group: string }));
    case 'shapes_join':
      return done(ops.joinShapes(doc, ids, a as { ids: string[] }));
    case 'shapes_subtract':
      return done(ops.subtractShapes(doc, ids, { from: a.from, cutters: a.cutters }));
    case 'repeat_set':
      return done(ops.setRepeat(doc, ids, a as ops.RepeatArgs));
    case 'repeat_remove':
      return done(ops.removeRepeat(doc, a as { id: string }));
    default:
      return fail(`Unknown tool "${name}".`, `Tools: ${TOOL_SPECS.map((t) => t.name).join(', ')}`);
  }
}

/** The ids of real shapes mentioned anywhere in a result, so a response can describe them without another call. */
export function mentionedShapes(doc: Doc, result: unknown): Body3D[] {
  const found = new Set<string>();
  const walk = (v: unknown, depth: number) => {
    if (depth > 4 || v === null || v === undefined) return;
    if (typeof v === 'string') {
      if (doc.bodies.some((b) => b.id === v && !b.repeatOf)) found.add(v);
    } else if (Array.isArray(v)) v.forEach((x) => walk(x, depth + 1));
    else if (typeof v === 'object') Object.values(v as Record<string, unknown>).forEach((x) => walk(x, depth + 1));
  };
  walk(result, 0);
  return [...found].map((id) => doc.bodies.find((b) => b.id === id)!).filter(Boolean).slice(0, 12);
}
