/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The agent's hand, inside Autora's frame (Visible work): one of the agent's tool calls done with this app's own controls,
 * the way a person does it, while the person watches. Shapes come from the Shape tray or are drawn with Draw (corners
 * tapped on the ground, a rectangle or a circle dragged out); shapes, faces and edges are picked by clicks in the view
 * (Shift for more); numbers are typed into Size & position, Properties and the number a picked face shows; colours and
 * finishes are pressed in Material; a turn is the ring dragged round; a bevel is its handle tapped and its profile dragged;
 * a repeat is its dots dragged and its count stepped; the bar's tools (Join, Subtract, Group, Delete, the library's) and the
 * top bar's undo and redo are pressed. Every act is a real pointer, mouse, wheel or key event into the element the app drew,
 * so the app's own handlers make the change.
 *
 * Autora works the finished model out itself (server/caddesk.ts) and sends it as `goal`, so the hand knows what each number
 * should end up as, and puts it in afterwards: where the app lands a little off (a corner snapped to its neighbour, a turn
 * pulled to 15°), the exact model follows. What the window has no control for is said, not hidden.
 */
import type { Doc } from './core/doc';
import type { ViewerApi, ViewerHit } from './components/ModelViewer3D';
import { MATERIAL_PRESETS, SWATCHES, type Body3D, type DrawSession, type EdgeSel, type FaceSel, type Frame, type Point2D, type RepeatSession } from './types';
import { SHAPE_LABELS, type ShapeKind } from './utils/primitives';
import { selectionBounds } from './utils/transform';
import { defaultBevelSize, edgeKey, edgeSize, edgeStyle, edgesAroundFace, edgesOfKind, listEdges, maxBevelSize, primaryEdge } from './utils/edges';
import { wallEnds } from './utils/outline';
import { faceMeasure } from './utils/faces';
import { groupChain, withGroupMates } from './utils/groups';
import { bendHandle } from './utils/repeat';
import { handAt, handGo, handRest } from './agentCursor';

type Point = { x: number; y: number };
type M3 = { x: number; y: number; z: number };

/** What the hand needs from the app: the model, what is picked, what is open, and the 3D view. */
export interface HandApi {
  doc: () => Doc;
  selected: () => string[];
  face: () => FaceSel | null;
  edges: () => EdgeSel[];
  repeat: () => RepeatSession | null;
  draw: () => DrawSession | null;
  view: () => ViewerApi | null;
}

export interface HandResult {
  /** What was done by hand, in a few words each. */
  did: string[];
  /** Why the rest was not, when it was not. */
  skipped?: string;
}

class Skip extends Error {}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 2500): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(50);
  }
}

const centre = (el: Element): Point => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

const pointer = (type: string, p: Point, shift = false, held = type === 'pointerdown'): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0,
    buttons: held ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, shiftKey: shift,
  });
const mouse = (type: string, p: Point, shift = false): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, buttons: type === 'mousedown' ? 1 : 0, shiftKey: shift });

/** Go to a control and press it, with the events a mouse makes. */
async function press(el: HTMLElement | null, words?: string, shift = false): Promise<void> {
  if (!el) throw new Skip('a control was not on the screen');
  if ((el as HTMLButtonElement).disabled) throw new Skip(`${el.getAttribute('aria-label') ?? el.textContent?.trim() ?? 'a control'} was not available`);
  const p = centre(el);
  await handGo(p, true, el, words);
  el.dispatchEvent(pointer('pointerdown', p));
  el.dispatchEvent(mouse('mousedown', p));
  el.dispatchEvent(pointer('pointerup', p));
  el.dispatchEvent(mouse('mouseup', p));
  el.dispatchEvent(mouse('click', p, shift));
  await sleep(rand(160, 260));
}

const buttons = (root: ParentNode | null, sel = 'button') => Array.from(root?.querySelectorAll<HTMLElement>(sel) ?? []);
const byText = (root: ParentNode | null, text: string, prefix = false) =>
  buttons(root).find((b) => (prefix ? b.textContent?.trim().startsWith(text) : b.textContent?.trim() === text)) ?? null;

/** A tool of the bar by its name: on the bar, or in its All tools grid. */
async function tool(label: string, words?: string, prefix = false): Promise<void> {
  const onBar = buttons(document.querySelector('nav[aria-label="Tools"]')).find((b) => {
    const l = b.getAttribute('aria-label') ?? '';
    return prefix ? l.startsWith(label) : l === label;
  });
  if (onBar) return press(onBar, words);
  await press(document.querySelector<HTMLElement>('nav[aria-label="Tools"] button[aria-label="All tools"]'), words);
  const tile = await waitFor(() => byText(document.querySelector('[role="dialog"][aria-label="All tools"]'), label, prefix));
  if (!tile) throw new Skip(`${label} is not among the tools`);
  await press(tile, words);
}

/** The card a tool of the bar opens, open. */
async function card(label: string): Promise<HTMLElement> {
  const open = () => document.querySelector<HTMLElement>(`section[aria-label="${label} options"]`);
  const now = open();
  if (now) return now;
  await tool(label, `Opening ${label}`);
  const got = await waitFor(open);
  if (!got) throw new Skip(`${label} did not open`);
  return got;
}

const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
};

/** Click into a field and type into it a key at a time; with `enter`, Enter puts it in. */
async function typeInto(input: HTMLInputElement | null, text: string, words?: string, enter = true): Promise<void> {
  if (!input) throw new Skip('a field was not on the screen');
  await press(input, words);
  input.focus();
  await sleep(60);
  input.select();
  let typed = '';
  for (const ch of text) {
    typed += ch;
    input.dispatchEvent(new KeyboardEvent('keydown', { key: ch, bubbles: true }));
    setValue(input, typed);
    input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
    input.dispatchEvent(new KeyboardEvent('keyup', { key: ch, bubbles: true }));
    await sleep(rand(55, 140));
  }
  await sleep(rand(120, 220));
  if (enter) input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(rand(180, 260));
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const mm = (v: number) => String(Math.round(v * 100) / 100);
const str = (v: unknown) => (typeof v === 'string' ? v : null);
const sameSet = (a: string[], b: string[]) => a.length === b.length && a.every((x) => b.includes(x));

function view(api: HandApi): ViewerApi {
  const v = api.view();
  if (!v) throw new Skip('the 3D view was not ready');
  return v;
}
const canvasAt = (p: Point) => {
  const el = document.elementFromPoint(p.x, p.y);
  return el instanceof HTMLCanvasElement ? el : null;
};

/** A click on the view itself, with Shift held when adding to the pick. */
async function tap(p: Point, words: string, shift = false): Promise<void> {
  const hit = canvasAt(p);
  if (!hit) throw new Skip('something was in front of the model');
  await handGo(p, true, null, words);
  hit.dispatchEvent(pointer('pointerdown', p, shift));
  await sleep(40);
  hit.dispatchEvent(pointer('pointerup', p, shift));
  // The arrows of what is picked now spring in over a moment: where the next click is safe is known after.
  await sleep(rand(600, 700));
}

/** Press here and drag there, the pointer moving a frame at a time, as a hand does. `on` is what the press is on. */
async function drag(on: Element, from: Point, to: Point, words: string, opts: { via?: Point[]; shift?: boolean } = {}): Promise<void> {
  await handGo(from, true, null, words);
  on.dispatchEvent(pointer('pointerdown', from, opts.shift));
  await sleep(60);
  const path = [from, ...(opts.via ?? []), to];
  let last = from;
  for (let k = 1; k < path.length; k++) {
    const a = path[k - 1];
    const b = path[k];
    const steps = Math.max(6, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / 10));
    for (let i = 1; i <= steps; i++) {
      last = { x: a.x + ((b.x - a.x) * i) / steps, y: a.y + ((b.y - a.y) * i) / steps };
      handAt(last);
      on.dispatchEvent(pointer('pointermove', last, opts.shift, true));
      await sleep(rand(16, 26));
    }
  }
  await sleep(120);
  on.dispatchEvent(pointer('pointerup', last, opts.shift));
  await sleep(rand(450, 600));
}

// ---- Finding where to press -------------------------------------------------------------------------------------------

type Cand = { p: M3; frame?: Frame };

/** A shape's footprint, in its own plane (a wall shape's is in its wall). */
function footprint(b: Body3D) {
  const xs = b.points.map((p) => p.x);
  const ys = b.points.map((p) => p.y);
  return { minX: Math.min(...xs), maxX: Math.max(...xs), minY: Math.min(...ys), maxY: Math.max(...ys) };
}
const GRID: Array<[number, number]> = [[0.5, 0.5], [0.3, 0.5], [0.7, 0.5], [0.5, 0.3], [0.5, 0.7], [0.2, 0.2], [0.8, 0.2], [0.2, 0.8], [0.8, 0.8], [0.1, 0.5], [0.9, 0.5], [0.5, 0.1], [0.5, 0.9]];

/** Points on a shape a press might pick it at: its top, then its sides. */
function shapePoints(b: Body3D): Cand[] {
  const f = footprint(b);
  const low = b.frame ? 0 : b.elevation ?? 0;
  const top = low + b.extrusionHeight;
  const at = (fx: number, fy: number, fz: number): Cand => ({ p: { x: f.minX + fx * (f.maxX - f.minX), y: f.minY + fy * (f.maxY - f.minY), z: low + fz * (top - low) }, frame: b.frame });
  const out = GRID.map(([fx, fy]) => at(fx, fy, 1));
  for (const s of [0.5, 0.25, 0.75]) for (const h of [0.5, 0.25, 0.75]) out.push(at(s, 0, h), at(s, 1, h), at(0, s, h), at(1, s, h));
  return out;
}

/** Points on one face of a shape. */
function facePoints(b: Body3D, face: { kind: FaceSel['kind']; index?: number }): Cand[] {
  const f = footprint(b);
  const low = b.frame ? 0 : b.elevation ?? 0;
  const top = low + b.extrusionHeight;
  if (face.kind !== 'wall') {
    const z = face.kind === 'top' ? top : low;
    return GRID.map(([fx, fy]) => ({ p: { x: f.minX + fx * (f.maxX - f.minX), y: f.minY + fy * (f.maxY - f.minY), z }, frame: b.frame }));
  }
  const ends = face.index !== undefined ? wallEnds(b, face.index) : null;
  if (!ends) return [];
  const out: Cand[] = [];
  for (const t of [0.5, 0.35, 0.65, 0.2, 0.8]) for (const h of [0.5, 0.3, 0.7]) {
    out.push({ p: { x: ends.a.x + (ends.b.x - ends.a.x) * t, y: ends.a.y + (ends.b.y - ends.a.y) * t, z: low + h * (top - low) }, frame: b.frame });
  }
  return out;
}

/** Points along one edge of a shape. */
function edgePoints(b: Body3D, sel: { kind: EdgeSel['kind']; index: number }): Cand[] {
  const path = listEdges(b).find((e) => e.kind === sel.kind && e.index === sel.index);
  if (!path || path.points.length < 2) return [];
  const out: Cand[] = [];
  const n = path.points.length - 1;
  for (const t of [0.5, 0.35, 0.65, 0.2, 0.8, 0.1, 0.9]) {
    const at = t * n;
    const i = Math.min(n - 1, Math.floor(at));
    const u = at - i;
    const p = path.points[i];
    const q = path.points[i + 1];
    // The edge's points are the scene's own (y up): back to the model's x, y, z.
    out.push({ p: { x: p.x + (q.x - p.x) * u, y: -(p.z + (q.z - p.z) * u), z: p.y + (q.y - p.y) * u } });
  }
  return out;
}

/**
 * Where to press so the press touches what `ok` wants: the first of these points that is in view and that a press would
 * land on. When none is, what a person does to reach it: close a card over the view, let go of what is picked (when
 * `letGo`), fit the model in view, scroll in on it, look from another side.
 */
async function spot(api: HandApi, cands: () => Cand[], ok: (h: ViewerHit) => boolean, letGo = false): Promise<Point> {
  const find = () => {
    const v = view(api);
    for (const c of cands()) {
      const s = v.project(c.p, c.frame);
      if (!s || !canvasAt(s)) continue;
      const h = v.hitAt(s.x, s.y);
      if (h && ok(h)) return s;
    }
    return null;
  };
  const again = async (step: () => Promise<boolean>) => ((await step()) ? find() : null);
  let s = find();
  if (s) return s;
  s = await again(async () => {
    const close = document.querySelector<HTMLElement>('button[aria-label="Close options"]');
    if (!close) return false;
    await press(close, 'Closing the card');
    return true;
  });
  if (s) return s;
  if (letGo) {
    s = await again(async () => {
      const empty = api.selected().length ? view(api).emptySpot() : null;
      if (!empty) return false;
      await tap(empty, 'Letting go of the pick');
      return true;
    });
    if (s) return s;
  }
  s = await again(async () => {
    await press(document.querySelector<HTMLElement>('button[aria-label="Fit model in view"]'), 'Fitting the model in view');
    await sleep(700);
    return true;
  });
  if (s) return s;
  // Small on the screen, so a handle or a neighbour covers it: a person scrolls in on it.
  for (let n = 0; n < 8 && !s; n++) {
    const v = view(api);
    const on = cands().map((c) => v.project(c.p, c.frame)).find((p): p is Point => !!p && !!canvasAt(p));
    if (!on) break;
    await handGo(on, false, null, 'Zooming in');
    canvasAt(on)!.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: on.x, clientY: on.y, deltaY: -300, deltaMode: 0 }));
    await sleep(rand(260, 360));
    s = find();
  }
  if (s) return s;
  // Round the back or underneath: the view cube's sides that show.
  for (const side of ['Top', 'Front', 'Right', 'Left', 'Back', 'Bottom']) {
    const b = document.querySelector<HTMLElement>(`button[aria-label="${side} view"]`);
    if (!b || document.elementFromPoint(centre(b).x, centre(b).y) !== b) continue;
    await press(b, `Looking from the ${side.toLowerCase()}`);
    await sleep(700);
    s = find();
    if (s) return s;
  }
  throw new Skip('it could not be reached in the view');
}

// ---- The parts pane ---------------------------------------------------------------------------------------------------

type PartKind = 'shape' | 'object' | 'item';
const TAB_OF: Record<PartKind, string> = { shape: 'Shapes', object: 'Objects', item: 'Library' };
/** More cards than this and a person would search for the one they want rather than look for it. */
const SEARCH_ABOVE = 6;

const parts = () => document.querySelector<HTMLElement>('aside[aria-label="Parts"]');
const partCard = (kind: PartKind, id: string) => parts()?.querySelector<HTMLElement>(`[data-part-kind="${kind}"][data-part-id="${CSS.escape(id)}"]`) ?? null;

/**
 * The card of a shape, an object or a library item in the parts pane, with its tab open: through the search box when the
 * list is long. Null when there is no pane (a phone) or the thing is not listed (a piece of a joined shape).
 */
async function paneFind(kind: PartKind, id: string, name: string): Promise<HTMLElement | null> {
  const pane = parts();
  if (!pane) return null;
  const tab = Array.from(pane.querySelectorAll<HTMLElement>('[role="tab"]')).find((t) => t.textContent?.trim().startsWith(TAB_OF[kind]));
  if (tab && tab.getAttribute('aria-selected') !== 'true') await press(tab, `Opening ${TAB_OF[kind]}`);
  const search = pane.querySelector<HTMLInputElement>('input[aria-label="Search by name"]');
  let found = await waitFor(() => partCard(kind, id), 1200);
  if (search && search.value) {
    // A search left in the box hides what is wanted: clear it.
    setValue(search, '');
    search.dispatchEvent(new Event('input', { bubbles: true }));
    await sleep(120);
    found = partCard(kind, id);
  }
  if (!found) return null;
  if (search && pane.querySelectorAll('[data-part-kind]').length > SEARCH_ABOVE && name) {
    await typeInto(search, name, `Searching for ${name}`, false);
    found = (await waitFor(() => partCard(kind, id))) ?? found;
  }
  found.scrollIntoView({ block: 'nearest' });
  return found;
}

/** Whether the pane has a thumbnail for it: a piece of a joined shape, a copy of a repeat and a linked object's insides have none. */
function listedInPane(api: HandApi, t: { kind: PartKind; id: string }): boolean {
  const d = api.doc();
  if (t.kind === 'object') {
    const g = d.groups.find((x) => x.id === t.id);
    return !!g && !g.joined && !g.instanceOf;
  }
  const b = d.bodies.find((x) => x.id === t.id);
  return !!b && !b.repeatOf && !groupChain(d.groups, b.groupId).some((g) => g.joined);
}

/** Empty the search box again, as a person does once they have what they came for. */
async function paneClearSearch(): Promise<void> {
  const search = parts()?.querySelector<HTMLInputElement>('input[aria-label="Search by name"]');
  if (!search || !search.value) return;
  setValue(search, '');
  search.dispatchEvent(new Event('input', { bubbles: true }));
  await sleep(rand(120, 200));
}

/** What a shape or an object is called now, by id. */
const nameOfPart = (api: HandApi, kind: PartKind, id: string) =>
  kind === 'object' || (kind === 'shape' && api.doc().groups.some((g) => g.id === id)) ? api.doc().groups.find((g) => g.id === id)?.name ?? '' : kind === 'item' ? api.doc().library.find((i) => i.id === id)?.name ?? '' : api.doc().bodies.find((b) => b.id === id)?.name ?? '';

/** A card pressed to pick it: Shift for each after the first. False when the pane does not list it. */
async function panePick(api: HandApi, kind: PartKind, id: string, words: string, extend = false): Promise<boolean> {
  const card = await paneFind(kind, id, nameOfPart(api, kind, id));
  const button = card?.querySelector<HTMLElement>('button[aria-pressed]');
  if (!button) return false;
  await press(button, words, extend);
  return true;
}

/**
 * Name a shape, an object or a library item in the pane: double-click its name, type, Enter. False when there is no pane
 * or it does not list the thing, so the caller names it the other way (Properties, the top bar).
 */
async function paneRename(api: HandApi, kind: PartKind, id: string, name: string, did: string[]): Promise<boolean> {
  const card = await paneFind(kind, id, nameOfPart(api, kind, id));
  const label = card?.querySelector<HTMLElement>('span[title$="(double-click to rename)"]');
  if (!card || !label) return false;
  const p = centre(label);
  await handGo(p, true, label, `Naming it ${name}`);
  label.dispatchEvent(mouse('dblclick', p));
  const input = await waitFor(() => card.querySelector<HTMLInputElement>('input[aria-label^="Name of"]'));
  await typeInto(input, name, 'Typing the name');
  await paneClearSearch();
  did.push(`named it "${name}" in the parts pane`);
  return true;
}

// ---- Picking ----------------------------------------------------------------------------------------------------------

/** A click that picked something else is tried once more, as a person tries again after a slip. */
async function again(fn: () => Promise<void>): Promise<void> {
  try {
    await fn();
  } catch (err) {
    if (!(err instanceof Skip) || !/picked/.test(err.message)) throw err;
    await sleep(500);
    await fn();
  }
}

const bodyIn = (api: HandApi, id: string) => {
  const b = api.doc().bodies.find((x) => x.id === id && !x.repeatOf);
  if (!b) throw new Skip(`there is no shape ${id} in the window`);
  return b;
};
const onShape = (id: string) => (h: ViewerHit) => h.type === 'body' && h.bodyId === id;

/**
 * Pick shapes the way the app picks them: a click on the first (which takes its whole group), Shift-click on each of the
 * rest. With `alone`, the one shape itself: a click again steps into its groups until only it is picked.
 */
const pick = (api: HandApi, want: string[], alone = false) => again(() => pickOnce(api, want, alone));
async function pickOnce(api: HandApi, want: string[], alone = false): Promise<void> {
  if (!want.length) throw new Skip('no shape was named');
  const doc = api.doc();
  const target = alone ? [want[0]] : [...new Set(want.flatMap((id) => withGroupMates(doc.groups, doc.bodies, id)))];
  if (sameSet(api.selected(), target)) return;
  if (await pickInPane(api, want, alone)) {
    if (!sameSet(api.selected(), target)) throw new Skip('the click picked something else');
    return;
  }
  if (alone) {
    const b = bodyIn(api, want[0]);
    const depth = groupChain(doc.groups, b.groupId).length;
    for (let i = 0; i <= depth + 1 && !sameSet(api.selected(), target); i++) {
      await tap(await spot(api, () => shapePoints(b), onShape(b.id), i === 0), i === 0 ? 'Picking the shape' : 'Picking it inside its group');
    }
  } else {
    for (let i = 0; i < want.length; i++) {
      if (i > 0 && api.selected().includes(want[i])) continue;
      const b = bodyIn(api, want[i]);
      await tap(await spot(api, () => shapePoints(b), onShape(b.id), i === 0), i === 0 ? 'Picking the shape' : 'Adding it to the pick', i > 0);
    }
  }
  const now = api.selected();
  if (alone ? !sameSet(now, target) : !want.every((id) => now.includes(id))) throw new Skip('the click picked something else');
}

/**
 * Pick in the parts pane when it is open: a shape's thumbnail for one shape; for the rest the outermost object it is in (or
 * the shape), Shift-pressed for each after the first. False when the pane cannot (a phone, a piece of a joined shape).
 */
async function pickInPane(api: HandApi, want: string[], alone: boolean): Promise<boolean> {
  if (!parts()) return false;
  const doc = api.doc();
  const cards = want.map((id) => {
    const b = bodyIn(api, id);
    const top = alone ? undefined : groupChain(doc.groups, b.groupId)[0];
    return top ? { kind: (top.joined ? 'shape' : 'object') as PartKind, id: top.id, words: 'Picking the object in the parts pane' } : { kind: 'shape' as PartKind, id, words: 'Picking the shape in the parts pane' };
  });
  for (let i = 0; i < cards.length; i++) {
    if (i > 0 && cards[i].id === cards[i - 1].id) continue;
    if (!(await panePick(api, cards[i].kind, cards[i].id, i === 0 ? cards[i].words : 'Adding it to the pick', i > 0))) {
      if (i === 0) return false;
      throw new Skip('the parts pane does not list the shape that was picked');
    }
  }
  await paneClearSearch();
  return true;
}

/** Pick a group: a click on one of its shapes, again until the pick is the group. */
const pickGroup = (api: HandApi, groupId: string) => again(() => pickGroupOnce(api, groupId));
async function pickGroupOnce(api: HandApi, groupId: string): Promise<void> {
  const g = api.doc().groups.find((x) => x.id === groupId);
  if (!g?.bodyIds.length) throw new Skip(`there is no group ${groupId} in the window`);
  if (!g.joined && (await panePick(api, 'object', groupId, 'Picking the object in the parts pane'))) {
    await paneClearSearch();
    if (!sameSet(api.selected(), g.bodyIds)) throw new Skip('the click picked something else');
    return;
  }
  const b = bodyIn(api, g.bodyIds[0]);
  const depth = groupChain(api.doc().groups, b.groupId).length;
  for (let i = 0; i <= depth && !sameSet(api.selected(), g.bodyIds); i++) {
    await tap(await spot(api, () => shapePoints(b), onShape(b.id), i === 0), i === 0 ? 'Picking the group' : 'Picking the group inside');
  }
  if (!sameSet(api.selected(), g.bodyIds)) throw new Skip('the click picked something else');
}

const sameFace = (a: FaceSel | null, id: string, f: { kind: string; index?: number }) => !!a && a.bodyId === id && a.kind === f.kind && (f.kind !== 'wall' || a.index === f.index);

/** Pick a face of a shape: a click on it. */
const pickFace = (api: HandApi, id: string, face: { kind: FaceSel['kind']; index?: number }) => again(() => pickFaceOnce(api, id, face));
async function pickFaceOnce(api: HandApi, id: string, face: { kind: FaceSel['kind']; index?: number }): Promise<void> {
  if (sameFace(api.face(), id, face)) return;
  const b = bodyIn(api, id);
  const ok = (h: ViewerHit) => h.type === 'body' && h.bodyId === id && h.face.kind === face.kind && (face.kind !== 'wall' || h.face.index === face.index);
  await tap(await spot(api, () => facePoints(b, face), ok), `Picking the ${face.kind === 'wall' ? 'wall' : `${face.kind} face`}`);
  if (!(await waitFor(() => sameFace(api.face(), id, face), 1500))) throw new Skip('the click picked another face');
}

/** Pick edges of one shape: a click on the first, Shift-click on the rest. */
const pickEdges = (api: HandApi, id: string, sels: Array<{ kind: EdgeSel['kind']; index: number }>) => again(() => pickEdgesOnce(api, id, sels));
async function pickEdgesOnce(api: HandApi, id: string, sels: Array<{ kind: EdgeSel['kind']; index: number }>): Promise<void> {
  const b = bodyIn(api, id);
  const key = (s: { kind: string; index: number }) => `${id}:${s.kind}:${s.index}`;
  const want = sels.map(key);
  const now = () => api.edges().map(edgeKey);
  if (sameSet(now(), want)) return;
  for (let i = 0; i < sels.length; i++) {
    if (i > 0 && now().includes(want[i])) continue;
    // A click on the one edge picked already would widen it to its whole rim.
    if (i === 0 && sameSet(now(), [want[0]])) continue;
    const s = sels[i];
    const ok = (h: ViewerHit) => h.type === 'edge' && h.bodyId === id && h.kind === s.kind && h.index === s.index;
    await tap(await spot(api, () => edgePoints(b, s), ok), i === 0 ? 'Picking the edge' : 'Adding the edge', i > 0);
  }
  if (!sameSet(now(), want)) throw new Skip('the clicks picked other edges');
}

// ---- Fields -----------------------------------------------------------------------------------------------------------

const sizeField = (label: string) => document.querySelector<HTMLInputElement>(`section[aria-label="Size & position options"] input[aria-label="${label} in mm"]`);
const valueOf = (label: string) => Number(sizeField(label)?.value ?? NaN);

/** Type sizes and the place into Size & position, each only when it is not that already. */
async function typeSizes(want: Record<string, number | null | undefined>, did: string[]): Promise<void> {
  const todo = Object.entries(want).filter(([, v]) => v !== null && v !== undefined) as Array<[string, number]>;
  if (!todo.length) return;
  await card('Size & position');
  for (const [label, v] of todo) {
    if (!sizeField(label) || Math.abs(valueOf(label) - v) < 0.01) continue;
    await typeInto(sizeField(label), mm(v), `Typing the ${label.toLowerCase()}`);
    did.push(`typed ${label} ${mm(v)} in Size & position`);
  }
}

/** The sizes and place a shape should end up with, as Size & position shows them. */
function sizesOf(bodies: Body3D[]) {
  const b = selectionBounds(bodies);
  if (!b) return {};
  const one = bodies.length === 1 ? bodies[0] : null;
  const wall = !!one?.frame;
  return {
    ...(one ? { [wall ? 'Across' : 'Width']: b.maxX - b.minX, [wall ? 'Up' : 'Depth']: b.maxY - b.minY, [wall ? 'Out' : 'Height']: one.extrusionHeight } : {}),
    ...(bodies.some((x) => x.frame) ? {} : { X: b.centerX, Y: b.centerY, Z: b.minElevation }),
  };
}

/** Name, colour and finish of the shape picked now, in Properties and Material. */
async function setLook(api: HandApi, id: string, look: { name?: string | null; color?: string | null; material?: string | null }, did: string[]): Promise<void> {
  const body = () => api.doc().bodies.find((b) => b.id === id);
  if (look.name !== null && look.name !== undefined && body()?.name !== look.name) {
    if (!(await paneRename(api, 'shape', id, look.name, did))) {
      const props = await card('Properties');
      await typeInto(props.querySelector<HTMLInputElement>('input[type="text"]'), look.name, 'Typing the name', false);
      did.push(`typed the name "${look.name}" in Properties`);
    }
  }
  if (look.material && body()?.materialType !== look.material) {
    const preset = MATERIAL_PRESETS.find((m) => m.id === look.material);
    if (preset) {
      const mat = await card('Material');
      await press(byText(mat, preset.name, true), `Choosing ${preset.name}`);
      did.push(`chose ${preset.name} in Material`);
    }
  }
  if (look.color && body()?.color.toLowerCase() !== look.color.toLowerCase()) {
    const mat = await card('Material');
    const swatch = SWATCHES.find((w) => w.value.toLowerCase() === look.color!.toLowerCase());
    if (swatch) {
      await press(mat.querySelector<HTMLElement>(`button[aria-label="${swatch.name}"]`), `Choosing ${swatch.name}`);
      did.push(`chose ${swatch.name} in Material`);
    } else {
      // Not one of the swatches: the custom colour's own field, set to it.
      const input = mat.querySelector<HTMLInputElement>('input[aria-label="Custom color"]');
      if (!input) throw new Skip('the custom colour was not there');
      await handGo(centre(input), true, input.parentElement, 'Mixing the colour');
      setValue(input, look.color.toLowerCase());
      input.dispatchEvent(new Event('input', { bubbles: true }));
      input.dispatchEvent(new Event('change', { bubbles: true }));
      did.push(`set the custom colour ${look.color} in Material`);
    }
  }
}

/** The number a picked face shows by itself: tap it and type. */
async function typeFaceNumber(api: HandApi, id: string, face: FaceSel, value: number, did: string[]): Promise<void> {
  const body = bodyIn(api, id);
  const label = faceMeasure(body, face)?.label;
  if (!label) throw new Skip('that face has no number');
  for (let i = 0; i < 2; i++) {
    const button = document.querySelector<HTMLElement>(`button[aria-label^="${label}: "]`);
    if (button) {
      await press(button, `Tapping the ${label.toLowerCase()}`);
      const input = await waitFor(() => document.querySelector<HTMLInputElement>(`input[aria-label="${label} in millimetres"]`));
      await typeInto(input, mm(value), `Typing the ${label.toLowerCase()}`);
      did.push(`typed ${label} ${mm(value)} on the face`);
      return;
    }
    // The number shows for a few seconds after the face is picked: picked again, it shows again.
    await tap(await spot(api, () => facePoints(body, face), (h) => h.type === 'body' && h.bodyId === id && h.face.kind === face.kind), 'Picking the face again');
  }
  throw new Skip("the face's number did not show");
}

// ---- Drawing ----------------------------------------------------------------------------------------------------------

/** Where a point of a sketch is on the page: on the level at height `z`, or in a wall. */
const sketchAt = (api: HandApi, p: Point2D, z: number, frame?: Frame) => {
  const s = view(api).project({ x: p.x, y: p.y, z: frame ? 0 : z }, frame);
  if (!s || !canvasAt(s)) throw new Skip('the sketch would be out of view');
  return s;
};

/** Make room to work on these points: a card over them closed, and the view scrolled out until all of them show. */
async function bringIntoView(api: HandApi, pts: Cand[]): Promise<void> {
  const shows = () => pts.every((c) => {
    const s = view(api).project(c.p, c.frame);
    return !!s && !!canvasAt(s);
  });
  if (shows()) return;
  const close = document.querySelector<HTMLElement>('button[aria-label="Close options"]');
  if (close) await press(close, 'Closing the card');
  for (let n = 0; n < 10 && !shows(); n++) {
    const c = document.querySelector('canvas');
    if (!c) break;
    const mid = centre(c);
    await handGo(mid, false, null, 'Zooming out');
    c.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: mid.x, clientY: mid.y, deltaY: 300, deltaMode: 0 }));
    await sleep(rand(260, 360));
  }
  if (!shows()) throw new Skip('the sketch would be out of view');
}

/** Draw's own chip: corners, a rectangle or a circle; adding a shape or cutting a hole. */
async function drawForm(form: 'Corners' | 'Rectangle' | 'Circle', cut?: boolean): Promise<void> {
  const chip = await waitFor(() => document.querySelector('[role="group"][aria-label="What to draw"]'));
  if (!chip) throw new Skip('Draw did not open');
  const b = byText(chip, form);
  if (b && b.getAttribute('aria-pressed') !== 'true') await press(b, `Drawing a ${form === 'Corners' ? 'shape by its corners' : form.toLowerCase()}`);
  if (cut !== undefined) {
    const mode = document.querySelector('[role="group"][aria-label="Add a shape or cut a hole"]');
    const want = byText(mode, cut ? 'Cut' : 'Add');
    if (!want) throw new Skip('there is no Cut here: draw on the top of the shape');
    if (want.getAttribute('aria-pressed') !== 'true') await press(want, cut ? 'Cutting a hole' : 'Adding a shape');
  }
}

type Sketch = { form: 'rectangle'; from: Point2D; to: Point2D } | { form: 'circle'; center: Point2D; radius: number } | { form: 'polygon'; points: Point2D[]; bends: (Point2D | null)[] };

function sketchOf(args: Record<string, unknown>): Sketch {
  const pt = (v: unknown): Point2D | null => (v && typeof v === 'object' && num((v as Point2D).x) !== null && num((v as Point2D).y) !== null ? { x: (v as Point2D).x, y: (v as Point2D).y } : null);
  if (args.form === 'rectangle') {
    const from = pt(args.from);
    const to = pt(args.to);
    if (from && to) return { form: 'rectangle', from, to };
  } else if (args.form === 'circle') {
    const center = pt(args.center);
    if (center && num(args.radius) !== null) return { form: 'circle', center, radius: num(args.radius)! };
  } else if (args.form === 'polygon' && Array.isArray(args.points)) {
    const points = args.points.map(pt).filter((p): p is Point2D => !!p);
    const bends = Array.isArray(args.bends) ? args.bends.map((b) => pt(b)) : [];
    if (points.length >= 3) return { form: 'polygon', points, bends };
  }
  throw new Skip('the sketch was not one Draw can make');
}

/** Draw the sketch with Draw, open already: dragged out, or tapped corner by corner and its sides curved. Says what was not by hand. */
async function drawSketch(api: HandApi, sk: Sketch, z: number, frame: Frame | undefined, cut: boolean | undefined, did: string[]): Promise<string | null> {
  const canvas = () => document.querySelector('canvas');
  const corners: Point2D[] = sk.form === 'rectangle' ? [sk.from, sk.to, { x: sk.from.x, y: sk.to.y }, { x: sk.to.x, y: sk.from.y }]
    : sk.form === 'circle' ? [-1, 1].flatMap((k) => [{ x: sk.center.x + k * sk.radius, y: sk.center.y }, { x: sk.center.x, y: sk.center.y + k * sk.radius }])
      : [...sk.points, ...sk.bends.filter((b): b is Point2D => !!b)];
  await bringIntoView(api, corners.map((p) => ({ p: { x: p.x, y: p.y, z: frame ? 0 : z }, frame })));
  if (sk.form === 'rectangle' || sk.form === 'circle') {
    await drawForm(sk.form === 'rectangle' ? 'Rectangle' : 'Circle', cut);
    const a = sk.form === 'rectangle' ? sk.from : sk.center;
    const b = sk.form === 'rectangle' ? sk.to : { x: sk.center.x + sk.radius, y: sk.center.y };
    await drag(canvas()!, sketchAt(api, a, z, frame), sketchAt(api, b, z, frame), sk.form === 'rectangle' ? 'Dragging out the rectangle' : 'Dragging out the circle');
    did.push(sk.form === 'rectangle' ? 'dragged out a rectangle with Draw' : 'dragged out a circle with Draw');
    return null;
  }
  await drawForm('Corners', cut);
  for (const [i, p] of sk.points.entries()) {
    await tap(sketchAt(api, p, z, frame), i === 0 ? 'Placing the first corner' : 'Placing a corner');
  }
  did.push(`tapped ${sk.points.length} corners with Draw`);
  let missed: string | null = null;
  for (let i = 0; i < sk.points.length; i++) {
    const via = sk.bends[i];
    if (!via) continue;
    // The side that closes the shape is only there once it is finished: that curve goes in with the finished model.
    if (i === sk.points.length - 1) { missed = 'the curve of the closing side'; continue; }
    const a = sk.points[i];
    const b = sk.points[i + 1];
    await drag(canvas()!, sketchAt(api, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, z, frame), sketchAt(api, via, z, frame), 'Curving the side');
    did.push('dragged a side into a curve');
  }
  await press(await waitFor(() => document.querySelector<HTMLElement>('button[aria-label="Finish the shape"]')), 'Finishing the shape');
  did.push('pressed Finish');
  return missed;
}

// ---- Turning ----------------------------------------------------------------------------------------------------------

/** Turn what is picked by dragging the ring round it, in steps of at most 150° (a drag reads the turn within a half turn). */
async function turnByRing(api: HandApi, degrees: number, did: string[]): Promise<void> {
  let left = degrees;
  while (Math.abs(left) > 0.5) {
    const step = Math.max(-150, Math.min(150, left));
    const v = view(api);
    const ring = await waitFor(() => v.handles().find((h) => h.gizmo === 'rotate'));
    if (!ring) throw new Skip('the ring to turn it by was not there');
    const c = ring.at;
    const r = ring.spread;
    let a0 = 0;
    let start: Point | null = null;
    for (let k = 0; k < 18 && !start; k++) {
      const a = ((-90 + k * 20) * Math.PI) / 180;
      const s = v.project({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a), z: c.z });
      const h = s && canvasAt(s) ? v.hitAt(s.x, s.y) : null;
      if (s && h?.type === 'gizmo' && h.gizmo === 'rotate') { start = s; a0 = a; }
    }
    if (!start) throw new Skip('the ring could not be reached');
    const via: Point[] = [];
    const n = Math.max(2, Math.ceil(Math.abs(step) / 10));
    for (let i = 1; i < n; i++) {
      const a = a0 + ((step * Math.PI) / 180) * (i / n);
      const s = v.project({ x: c.x + r * Math.cos(a), y: c.y + r * Math.sin(a), z: c.z });
      if (s) via.push(s);
    }
    const end = v.project({ x: c.x + r * Math.cos(a0 + (step * Math.PI) / 180), y: c.y + r * Math.sin(a0 + (step * Math.PI) / 180), z: c.z });
    if (!end) throw new Skip('the turn would go out of view');
    await drag(canvasAt(start)!, start, end, 'Turning it', { via });
    did.push(`dragged the ring round ${Math.round(step)}°`);
    left -= step;
  }
}

// ---- The calls --------------------------------------------------------------------------------------------------------

/** What a call made: the shapes in `after` that were not in `before`. */
const madeIn = (after: Doc | null, before: Set<string>) => (after ? after.bodies.filter((b) => !before.has(b.id) && !b.repeatOf) : []);
const idsNow = (api: HandApi) => new Set(api.doc().bodies.map((b) => b.id));
const newShape = (api: HandApi, before: Set<string>) => waitFor(() => api.doc().bodies.find((b) => !before.has(b.id) && !b.repeatOf), 4000);

async function confirmDelete(api: HandApi, gone: string[], did: string[]): Promise<void> {
  await tool('Delete', 'Deleting');
  // It asks first, as it asks a person: Delete in that box is what removes them.
  const sure = await waitFor(() => byText(document.querySelector('[role="alertdialog"]'), 'Delete'));
  if (sure) await press(sure, 'Yes, delete');
  if (!(await waitFor(() => !api.doc().bodies.some((b) => gone.includes(b.id))))) throw new Skip('the shapes were still there');
  did.push(sure ? 'pressed Delete and said yes' : 'pressed Delete');
}

/** Name a group: in the parts pane when it lists it, else in the top bar. */
async function renameGroup(api: HandApi, groupId: string, name: string, did: string[]): Promise<void> {
  if (await paneRename(api, 'object', groupId, name, did)) return;
  await renameGroupInTopBar(name, did);
}

async function renameGroupInTopBar(name: string, did: string[]): Promise<void> {
  const title = await waitFor(() => document.querySelector<HTMLElement>('button[title="Tap to rename"]'));
  await press(title, 'Naming the group');
  const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Group name"]'));
  await typeInto(input, name, 'Typing the name');
  did.push(`named it "${name}" in the top bar`);
}

const faceOf = (id: string, spec: unknown): FaceSel => {
  if (spec === 'top' || spec === 'bottom') return { bodyId: id, kind: spec };
  if (typeof spec === 'string') {
    const m = /^wall[:\s#-]*(\d+)$/i.exec(spec);
    if (m) return { bodyId: id, kind: 'wall', index: Number(m[1]) };
  }
  const o = spec as { kind?: string; index?: number } | null;
  if (o && (o.kind === 'top' || o.kind === 'bottom')) return { bodyId: id, kind: o.kind };
  if (o && o.kind === 'wall' && num(o.index) !== null) return { bodyId: id, kind: 'wall', index: o.index };
  throw new Skip('that face is not one the window knows');
};

/**
 * Where an object of the library is, by hand: in the parts pane on a desktop (its Library tab, a card whose button says
 * "Add a copy of ..."), else in the Library card of a phone's bar. `place` is the button that adds a copy; `row`
 * is what holds the remove and globe buttons.
 */
async function libraryEntry(id: string, name: string): Promise<{ place: HTMLElement | null; scope: HTMLElement } | null> {
  if (parts()) {
    const scope = await paneFind('item', id, name);
    return scope ? { place: scope.querySelector<HTMLElement>('button[aria-pressed]'), scope } : null;
  }
  const lib = await card('Library');
  const row = libraryRow(lib, name);
  return row ? { place: row.querySelector<HTMLElement>('button'), scope: row } : null;
}

/** Library rows: the place button carries the object's name. */
const libraryRow = (cardEl: HTMLElement, name: string) =>
  Array.from(cardEl.querySelectorAll<HTMLElement>('div.flex.items-center.gap-1')).find((row) => row.querySelector('button span.truncate')?.textContent?.trim() === name) ?? null;

/** One tool call, by hand. `goal` is the model as the call leaves it, from Autora; `need`, what of the model it names. */
export async function runHand(name: string, args: Record<string, unknown>, api: HandApi, goal: Doc | null = null, need: string[] = []): Promise<HandResult> {
  const did: string[] = [];
  const skip: string[] = [];
  const goalBody = (id: string) => goal?.bodies.find((b) => b.id === id) ?? null;
  try {
    // A shape the agent made a moment ago may still be on its way into the window: wait for the ones this call names.
    await waitFor(() => need.every((id) => api.doc().bodies.some((b) => b.id === id) || api.doc().groups.some((g) => g.id === id)), 6000);
    switch (name) {
      case 'shape_add': {
        const kind = String(args.kind ?? '') as ShapeKind;
        const label = SHAPE_LABELS[kind];
        if (!label) throw new Skip('no such shape');
        const before = idsNow(api);
        const host = str(args.onTopOf);
        if (host) {
          await pickFace(api, host, { kind: 'top' });
          did.push('picked the top face to add it on');
        } else if (api.face()) {
          await press(document.querySelector<HTMLElement>('button[aria-label="Deselect (Esc)"]'), 'Letting go of the face');
        }
        const tray = await card('Shape');
        await press(byText(tray, label), `Adding a ${label.toLowerCase()}`);
        const made = await newShape(api, before);
        if (!made) throw new Skip('no shape came');
        did.push(`added a ${label.toLowerCase()} from the Shape tray`);
        const target = madeIn(goal, before)[0];
        if (target) await typeSizes(sizesOf([target]), did);
        else await typeSizes({ Width: num(args.width), Depth: num(args.depth), Height: num(args.height), X: num(args.x), Y: num(args.y), Z: num(args.elevation) }, did);
        await setLook(api, made.id, { name: str(args.name), color: str(args.color), material: str(args.material) }, did);
        break;
      }
      case 'shape_draw': {
        const before = idsNow(api);
        const target = madeIn(goal, before)[0];
        const surface = (args.surface ?? 'ground') as Record<string, unknown> | string;
        let z = 0;
        let frame: Frame | undefined;
        const level = typeof surface === 'object' ? num(surface.z) : null;
        if (typeof surface === 'object' && str(surface.topOf)) {
          const host = bodyIn(api, String(surface.topOf));
          await pickFace(api, host.id, { kind: 'top' });
          did.push('picked the top face to draw on');
          z = (host.elevation ?? 0) + host.extrusionHeight;
        } else if (typeof surface === 'object' && str(surface.wallOf)) {
          if (!target?.frame) throw new Skip('the wall to draw on was not worked out');
          await pickFace(api, String(surface.wallOf), { kind: 'wall', index: num(surface.wall) ?? 0 });
          did.push('picked the wall to draw on');
          frame = target.frame;
        } else if (api.face()) {
          await press(document.querySelector<HTMLElement>('button[aria-label="Deselect (Esc)"]'), 'Letting go of the face');
        }
        if (!api.draw()) await tool('Draw', 'Opening Draw');
        if (!(await waitFor(() => api.draw()))) throw new Skip('Draw did not open');
        const missed = await drawSketch(api, sketchOf(args), z, frame, undefined, did);
        if (missed) skip.push(missed);
        const made = await newShape(api, before);
        if (!made) throw new Skip('no shape came of the sketch');
        if (target) {
          await typeSizes({ [frame ? 'Out' : 'Height']: target.extrusionHeight, ...(level !== null ? { Z: level } : {}) }, did);
          await setLook(api, made.id, { name: str(args.name) ?? null, color: str(args.color), material: str(args.material) }, did);
        }
        break;
      }
      case 'shape_cut': {
        const id = String(args.target ?? '');
        const host = bodyIn(api, id);
        const surface = args.surface;
        if (surface !== undefined && !(surface && typeof surface === 'object' && (surface as { topOf?: unknown }).topOf === id)) throw new Skip('a cut from anywhere but the top of the shape');
        const before = JSON.stringify(api.doc().bodies);
        await pickFace(api, id, { kind: 'top' });
        did.push('picked the top face to cut into');
        if (!api.draw()) await tool('Draw', 'Opening Draw');
        if (!(await waitFor(() => api.draw()))) throw new Skip('Draw did not open');
        const missed = await drawSketch(api, sketchOf(args), (host.elevation ?? 0) + host.extrusionHeight, undefined, true, did);
        if (missed) skip.push(missed);
        if (!(await waitFor(() => JSON.stringify(api.doc().bodies) !== before, 4000))) throw new Skip('the cut did not reach the shape');
        const depth = num(args.depth);
        if (depth !== null && depth < host.extrusionHeight) skip.push(`a pocket ${mm(depth)} mm deep: Draw's Cut goes all the way through`);
        break;
      }
      case 'shape_set': {
        const id = String(args.id ?? '');
        if (args.visible === true) {
          await tool('Show hidden', 'Showing the hidden shapes', true);
          did.push('pressed Show hidden');
          if (Object.keys(args).length === 2) break;
        }
        await pick(api, [id], true);
        did.push('picked the shape in the view');
        const target = goalBody(id);
        if (num(args.height) !== null || num(args.elevation) !== null) {
          await typeSizes({ Height: target?.extrusionHeight ?? num(args.height), Z: num(args.elevation) !== null ? target?.elevation ?? num(args.elevation) : null }, did);
        }
        if (num(args.cornerRadius) !== null) {
          const props = await card('Properties');
          await typeInto(props.querySelector<HTMLInputElement>('input[aria-label="All corners"]'), mm(num(args.cornerRadius)!), 'Typing the corner radius', false);
          did.push(`typed All corners ${mm(num(args.cornerRadius)!)} in Properties`);
        }
        await setLook(api, id, { name: str(args.name), color: str(args.color), material: str(args.material) }, did);
        if (args.outline !== undefined) skip.push('a new outline: the window has no control to type corner points (its corners and walls are dragged)');
        if (args.visible === false) {
          await tool('Hide', 'Hiding it');
          did.push('pressed Hide');
        }
        break;
      }
      case 'shape_move': {
        const moving = ids(args.ids);
        await pick(api, moving);
        did.push('picked the shapes in the view');
        const doc = api.doc();
        const all = [...new Set(moving.flatMap((id) => withGroupMates(doc.groups, doc.bodies, id)))];
        const after = goal ? goal.bodies.filter((b) => all.includes(b.id)) : [];
        if (!after.length) throw new Skip('where it goes was not worked out');
        const { X, Y, Z } = sizesOf(after) as Record<string, number>;
        await typeSizes({ X, Y, Z }, did);
        break;
      }
      case 'shape_turn': {
        const turning = ids(args.ids);
        const degrees = num(args.degrees);
        if (degrees === null) throw new Skip('no turn was given');
        await pick(api, turning);
        did.push('picked the shapes in the view');
        await turnByRing(api, degrees, did);
        // About another point: a turn about its middle and then a move, the same as one turn about that point.
        if (args.about !== undefined && goal) {
          const doc = api.doc();
          const all = [...new Set(turning.flatMap((id) => withGroupMates(doc.groups, doc.bodies, id)))];
          const { X, Y } = sizesOf(goal.bodies.filter((b) => all.includes(b.id))) as Record<string, number>;
          await typeSizes({ X, Y }, did);
        }
        break;
      }
      case 'shape_resize': {
        const id = String(args.id ?? '');
        await pick(api, [id], true);
        did.push('picked the shape in the view');
        const target = goalBody(id);
        const s = target ? (sizesOf([target]) as Record<string, number>) : { Width: num(args.width), Depth: num(args.depth), Height: num(args.height) };
        await typeSizes({ Width: s.Width ?? s.Across, Depth: s.Depth ?? s.Up, Height: s.Height ?? s.Out }, did);
        break;
      }
      case 'face_set':
      case 'face_push': {
        const id = String(args.id ?? '');
        const face = faceOf(id, args.face);
        const target = goalBody(id);
        if (!target) throw new Skip('the face was not worked out');
        if (face.kind === 'bottom') {
          // The underside cannot be pressed from above: its height and place, typed into Size & position, are the same.
          await pick(api, [id], true);
          did.push('picked the shape in the view');
          await typeSizes({ Height: target.extrusionHeight, Z: target.elevation ?? 0 }, did);
          break;
        }
        const value = faceMeasure(target, face)?.value;
        if (value === undefined) throw new Skip('that face has no number');
        await pickFace(api, id, face);
        did.push(`picked the ${face.kind === 'wall' ? 'wall' : 'top face'} in the view`);
        await typeFaceNumber(api, id, face, value, did);
        break;
      }
      case 'edge_bevel': {
        const id = String(args.id ?? '');
        const body = bodyIn(api, id);
        const size = num(args.size);
        if (size === null) throw new Skip('no size was given');
        // Which edges, picked as a person picks them: one by one, a whole set from Pick edges, or the edges around a face.
        let want: EdgeSel[];
        if (Array.isArray(args.edges)) {
          want = (args.edges as Array<{ kind: EdgeSel['kind']; index: number }>).map((e) => ({ bodyId: id, kind: e.kind, index: e.index }));
          await pickEdges(api, id, want);
          did.push(want.length === 1 ? 'picked the edge in the view' : `picked ${want.length} edges in the view`);
        } else if (typeof args.group === 'string' || args.aroundFace === 'top' || args.aroundFace === 'bottom') {
          const group = (typeof args.group === 'string' ? args.group : args.aroundFace) as 'top' | 'bottom' | 'corner' | 'all';
          want = edgesOfKind(body, group);
          const first = listEdges(body).find((e) => e.kind !== 'corner') ?? listEdges(body)[0];
          if (!first) throw new Skip('the shape has no edges to bevel');
          if (!sameSet(api.edges().map(edgeKey), want.map(edgeKey))) {
            await pickEdges(api, id, [{ kind: first.kind, index: first.index }]);
            const panel = await card('Pick edges');
            const text = { top: 'Top', bottom: 'Bottom', corner: 'Corners', all: 'All' }[group];
            await press(byText(panel, text), `Picking all the ${text.toLowerCase()} edges`);
          }
          did.push(`picked the ${group === 'corner' ? 'corners' : `${group} edges`} with Pick edges`);
        } else if (args.aroundFace !== undefined) {
          const face = faceOf(id, args.aroundFace);
          want = edgesAroundFace(body, face);
          await pickFace(api, id, face);
          await press(await waitFor(() => document.querySelector<HTMLElement>('button[aria-label="Select the edges around this face"]')), 'Picking the edges around it');
          did.push('picked the face and pressed Edges');
        } else throw new Skip('no edges were named');
        if (!(await waitFor(() => sameSet(api.edges().map(edgeKey), want.map(edgeKey)), 1500))) throw new Skip('other edges were picked');
        if (size <= 0) {
          const panel = await card('Pick edges');
          await press(byText(panel, 'Remove bevel'), 'Taking the bevel off');
          did.push('pressed Remove bevel');
          break;
        }
        // The edge's yellow handle: tap it for the two profiles, then press one and drag up or down for the size.
        const v = view(api);
        const handle = await waitFor(() => v.handles().find((h) => h.gizmo === 'edge-size' && !!canvasAt(h) && v.hitAt(h.x, h.y)?.type === 'gizmo'));
        if (!handle) throw new Skip("the bevel's handle could not be reached");
        await tap(handle, 'Tapping the bevel handle');
        const now = bodyIn(api, id);
        const style = args.style === 'chamfer' ? 'chamfer' : args.style === 'round' ? 'round' : edgeStyle(now, primaryEdge(want)) ?? 'round';
        const button = await waitFor(() => document.querySelector<HTMLElement>(`button[aria-label="${style === 'round' ? 'Curved edge' : 'Flat bevel'}"]`));
        if (!button) throw new Skip("the bevel's profiles did not show");
        await sleep(350);
        const limit = maxBevelSize(now, want);
        const current = edgeSize(now, primaryEdge(want));
        const start = Math.min(limit, current > 0 ? current : defaultBevelSize(now));
        const goalSize = Math.min(limit, size);
        const from = centre(button);
        const dy = (goalSize - start) / (v.mmPerPixel() * 0.35);
        await drag(button, from, { x: from.x, y: from.y - dy }, `Sizing the bevel to ${mm(goalSize)} mm`);
        did.push(`pressed ${style === 'round' ? 'Curved edge' : 'Flat bevel'} and dragged it to ${mm(goalSize)} mm`);
        break;
      }
      case 'shape_delete': {
        const gone = ids(args.ids);
        await pick(api, gone);
        did.push('picked the shapes in the view');
        await confirmDelete(api, gone, did);
        break;
      }
      case 'doc_clear': {
        const doc = api.doc();
        const tops = [...new Set(doc.bodies.filter((b) => !b.repeatOf).map((b) => withGroupMates(doc.groups, doc.bodies, b.id)[0]))];
        if (!tops.length) break;
        await pick(api, tops);
        did.push('picked every shape in the view');
        await confirmDelete(api, doc.bodies.map((b) => b.id), did);
        break;
      }
      case 'shape_duplicate': {
        const from = ids(args.ids);
        const before = idsNow(api);
        const targets = madeIn(goal, before);
        for (const [i, id] of from.entries()) {
          await pick(api, [id], true);
          const known = idsNow(api);
          const props = await card('Properties');
          await press(byText(props, 'Duplicate'), 'Duplicating it');
          const made = await newShape(api, known);
          if (!made) throw new Skip('no copy came');
          did.push('picked the shape and pressed Duplicate in Properties');
          if (targets[i]) {
            const { X, Y } = sizesOf([targets[i]]) as Record<string, number>;
            await typeSizes({ X, Y }, did);
          }
        }
        break;
      }
      case 'group_create': {
        const members = ids(args.ids);
        await pick(api, members);
        did.push('picked the shapes in the view');
        await tool('Group', 'Grouping them');
        if (!(await waitFor(() => api.doc().groups.some((g) => members.every((id) => g.bodyIds.includes(id)))))) throw new Skip('Group did nothing');
        did.push('pressed Group');
        const label = str(args.name)?.trim();
        if (label) {
          const made = api.doc().groups.find((g) => sameSet(g.bodyIds, api.selected()));
          if (!made) throw new Skip('the new group was not picked');
          await renameGroup(api, made.id, label, did);
        }
        break;
      }
      case 'group_rename': {
        const gid = String(args.group ?? '');
        await pickGroup(api, gid);
        did.push(parts() ? 'picked the object in the parts pane' : 'picked the group in the view');
        await renameGroup(api, gid, String(args.name ?? ''), did);
        break;
      }
      case 'group_enter': {
        const gid = String(args.group ?? '');
        if (!(await panePick(api, 'object', gid, 'Opening the object to edit inside')) && !parts()) throw new Skip('the window has no parts pane here (a phone): editing inside is only shown on a desktop');
        const group = api.doc().groups.find((g) => g.id === gid);
        if (!group) throw new Skip(`there is no group ${gid} in the window`);
        const card = partCard('object', gid);
        await press(card?.querySelector<HTMLElement>('button[aria-label^="Edit inside"]') ?? null, `Editing inside ${group.name}`);
        if (!(await waitFor(() => Array.from(document.querySelectorAll('strong')).some((x) => x.parentElement?.textContent?.startsWith('Editing inside')), 3000))) throw new Skip('the group did not open');
        await paneClearSearch();
        did.push(`pressed Edit inside ${group.name}`);
        break;
      }
      case 'group_exit': {
        const exit = Array.from(document.querySelectorAll<HTMLElement>('button')).find((b) => b.textContent?.trim() === 'Exit group');
        if (!exit) throw new Skip('no group was open for editing inside');
        await press(exit, 'Leaving the group');
        did.push('pressed Exit group');
        break;
      }
      case 'group_remove': {
        const gid = String(args.group ?? '');
        await pickGroup(api, gid);
        did.push('picked the group in the view');
        await tool('Ungroup', 'Ungrouping it');
        if (!(await waitFor(() => !api.doc().groups.some((g) => g.id === gid)))) throw new Skip('Ungroup did nothing');
        did.push('pressed Ungroup');
        break;
      }
      case 'shapes_join': {
        const joined = ids(args.ids);
        await pick(api, joined);
        did.push('picked the shapes in the view');
        await tool('Join', 'Joining them');
        if (!(await waitFor(() => joined.some((id) => !api.doc().bodies.some((b) => b.id === id))))) throw new Skip('Join did nothing');
        did.push('pressed Join');
        break;
      }
      case 'shapes_subtract': {
        const from = ids(args.from);
        const cutters = ids(args.cutters);
        if (!from.length || !cutters.length) throw new Skip('nothing to cut, or nothing to cut with');
        // The shape picked last is the one cut out: the others, then a cutter; with more cutters, again with the next.
        let targets = from;
        for (const [i, cutter] of cutters.entries()) {
          await pick(api, [...targets, cutter]);
          did.push(i === 0 ? 'picked the shapes, the cutter last' : 'picked what was left and the next cutter');
          const known = idsNow(api);
          await tool('Subtract', 'Cutting it out');
          if (!(await waitFor(() => !api.doc().bodies.some((b) => b.id === cutter)))) throw new Skip('Subtract did nothing');
          did.push('pressed Subtract');
          const doc = api.doc();
          const fresh = doc.bodies.filter((b) => !known.has(b.id) && !b.repeatOf).map((b) => b.id);
          targets = [...targets.filter((id) => doc.bodies.some((b) => b.id === id)), ...fresh];
          if (!targets.length) break;
        }
        break;
      }
      case 'repeat_set': {
        const id = String(args.id ?? '');
        const link = goal?.repeats.find((l) => l.bodyId === id);
        if (!link) throw new Skip('the repeat was not worked out');
        await pick(api, [id], true);
        did.push('picked the shape in the view');
        if (!api.repeat()) await tool('Repeat', 'Repeating it');
        if (!(await waitFor(() => api.repeat()))) throw new Skip('Repeat did not open');
        const pill = (text: string) => byText(document.body, text);
        if (api.repeat()!.kind !== link.kind) {
          await press(pill('Around'), link.kind === 'around' ? 'Going round a circle' : 'Back to a line');
          did.push(`pressed Around ${link.kind === 'around' ? 'on' : 'off'}`);
        }
        for (let n = 0; n < 70 && api.repeat()!.count !== link.count; n++) {
          const more = api.repeat()!.count < link.count;
          await press(document.querySelector<HTMLElement>(`button[aria-label="${more ? 'More copies' : 'Fewer copies'}"]`), more ? 'One more' : 'One fewer');
        }
        did.push(`stepped the count to ${link.count}`);
        const source = bodyIn(api, id);
        const plane = (source.frame ? 0 : source.elevation ?? 0) + source.extrusionHeight;
        const dot = async (which: 'repeat-end' | 'repeat-bend', to: Point2D, words: string) => {
          const v = view(api);
          const h = await waitFor(() => v.handles().find((x) => x.gizmo === which && !!canvasAt(x)));
          if (!h) throw new Skip("the repeat's dots could not be reached");
          const end = v.project({ x: to.x, y: to.y, z: plane }, source.frame);
          if (!end) throw new Skip('where the copies go is out of view');
          await drag(canvasAt(h)!, h, end, words);
        };
        await dot('repeat-end', link.end, link.kind === 'around' ? 'Dragging the centre of the circle' : 'Dragging where the copies end');
        did.push(link.kind === 'around' ? "dragged the circle's centre into place" : 'dragged the end of the row into place');
        if (link.bend) {
          await dot('repeat-bend', bendHandle(link), 'Bending the path');
          did.push('dragged the path into a curve');
        }
        const turn = pill('Turn');
        if (turn && (turn.getAttribute('aria-pressed') === 'true') !== link.follow) {
          await press(turn, 'Turning the copies along');
          did.push('pressed Turn');
        }
        await press(document.querySelector<HTMLElement>('button[aria-label="Keep the copies"]'), 'Keeping the copies');
        did.push('kept the copies');
        break;
      }
      case 'repeat_remove': {
        await pick(api, [String(args.id ?? '')], true);
        did.push('picked the shape in the view');
        await tool('Make copies separate', 'Letting the copies go');
        did.push('pressed Make copies separate');
        break;
      }
      case 'library_save': {
        if (args.linked === true) throw new Skip('a linked copy is made by the model; the window keeps an independent copy');
        const gid = str(args.group);
        const label = str(args.name);
        const target = gid ? { kind: 'object' as PartKind, id: gid } : { kind: 'shape' as PartKind, id: String(args.id ?? '') };
        const keptBefore = api.doc().library.length;
        if (parts() && listedInPane(api, target)) {
          // The bookmark under its thumbnail in the parts pane.
          if (label && label !== nameOfPart(api, target.kind, target.id)) await paneRename(api, target.kind, target.id, label, did);
          const card = await paneFind(target.kind, target.id, nameOfPart(api, target.kind, target.id));
          await press(card?.querySelector<HTMLElement>('button[aria-label^="Save "]') ?? null, 'Saving it to the library');
          await waitFor(() => api.doc().library.length !== keptBefore || api.doc().library.some((i) => i.rev && Date.now() - i.rev < 3000));
          await paneClearSearch();
          did.push('pressed Save to the library under its thumbnail');
          break;
        }
        if (gid) {
          await pickGroup(api, gid);
          did.push('picked the group in the view');
          const g = api.doc().groups.find((x) => x.id === gid)!;
          if (label && label !== g.name) await renameGroupInTopBar(label, did);
        } else {
          await pick(api, [String(args.id ?? '')], true);
          did.push('picked the shape in the view');
          if (label) await setLook(api, String(args.id), { name: label }, did);
        }
        const items = api.doc().library.length;
        await tool('Save to', 'Saving it to the library', true);
        await waitFor(() => api.doc().library.length !== items || api.doc().library.some((i) => i.rev && Date.now() - i.rev < 3000));
        did.push('pressed Save to library');
        break;
      }
      case 'library_place': {
        const item = goal?.library.find((i) => i.id === args.item) ?? api.doc().library.find((i) => i.id === args.item);
        if (!item) throw new Skip('there is no such library object');
        const host = str(args.onTopOf);
        if (host) {
          await pickFace(api, host, { kind: 'top' });
          did.push('picked the top face to place it on');
        }
        if (args.linked === true) throw new Skip('a linked copy is made by the model; the window places independent copies');
        const knownGroups = new Set(api.doc().groups.map((g) => g.id));
        const knownBodies = new Set(api.doc().bodies.map((b) => b.id));
        const entry = await libraryEntry(item.id, item.name);
        await press(entry?.place ?? null, `Adding a copy of ${item.name}`);
        await paneClearSearch();
        const placed = await waitFor(() => api.doc().bodies.find((b) => !knownBodies.has(b.id)) ?? api.doc().groups.find((g) => !knownGroups.has(g.id)), 4000);
        if (!placed) throw new Skip('the object was not placed');
        did.push(`placed ${item.name} from the Library`);
        break;
      }
      case 'object_unlink': {
        await pickGroup(api, String(args.group ?? ''));
        did.push('picked the object in the view');
        const forget = args.forget === true;
        await tool(forget ? 'Separate' : 'Edit object', forget ? 'Making it separate' : 'Opening it for editing');
        did.push(`pressed ${forget ? 'Separate' : 'Edit object'}`);
        break;
      }
      case 'library_rename': {
        const item = api.doc().library.find((i) => i.id === args.item);
        if (!item) throw new Skip('there is no such library object');
        if (!parts()) throw new Skip('a phone has no control that renames a library object');
        if (!(await paneRename(api, 'item', item.id, String(args.name ?? ''), did))) throw new Skip('the object was not in the Library');
        break;
      }
      case 'library_share':
      case 'library_remove': {
        const item = api.doc().library.find((i) => i.id === args.item);
        if (!item) throw new Skip('there is no such library object');
        const entry = await libraryEntry(item.id, item.name);
        const row = entry?.scope ?? null;
        if (!row) throw new Skip('the object was not in the Library');
        if (name === 'library_remove') {
          await press(row.querySelector<HTMLElement>(`button[aria-label^="Remove ${item.name}"]`), `Removing ${item.name}`);
          did.push(`pressed remove beside ${item.name} in the Library`);
        } else {
          const globe = row.querySelector<HTMLElement>('button[aria-label*="every project"]');
          const want = args.shared !== false;
          if (globe && (globe.getAttribute('aria-pressed') === 'true') !== want) {
            await press(globe, want ? 'Keeping it in every project' : 'Keeping it only here');
            did.push(`pressed the globe beside ${item.name} in the Library`);
          }
        }
        break;
      }
      case 'history_undo':
      case 'history_redo': {
        // The window keeps each step a person makes; the model keeps each of the agent's calls as one. Pressed until the
        // window is where the model's own history leads.
        const undo = name === 'history_undo';
        const content = (d: Doc) => JSON.stringify([d.bodies, d.groups, d.repeats]);
        const there = goal ? content(goal) : null;
        const button = () => document.querySelector<HTMLElement>(`header button[aria-label="${undo ? 'Undo (⌘Z)' : 'Redo (⇧⌘Z)'}"]`);
        let presses = 0;
        for (; presses < 25 && (there === null ? presses < 1 : content(api.doc()) !== there); presses++) {
          const before = content(api.doc());
          await press(button(), undo ? 'Undoing' : 'Redoing');
          if (!(await waitFor(() => content(api.doc()) !== before, 1500))) break;
        }
        if (!presses || (there !== null && content(api.doc()) !== there)) {
          if (!presses) throw new Skip(`the window had nothing to ${undo ? 'undo' : 'redo'}`);
          skip.push(`the window's own history ran out before the model's step: the window is put where the model is`);
        }
        did.push(`pressed ${undo ? 'Undo' : 'Redo'} in the top bar${presses > 1 ? ` ${presses} times` : ''}`);
        break;
      }
      default:
        throw new Skip('the window has no control for this');
    }
    return { did, ...(skip.length ? { skipped: skip.join('; ') } : {}) };
  } catch (err) {
    return { did, skipped: [...skip, err instanceof Error ? err.message : String(err)].join('; ') };
  } finally {
    handRest();
  }
}
