/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The agent's hand, inside Autora's frame (Visible work): one of the agent's tool calls done with this app's own controls,
 * the way a person does it, while the person watches -- the Shape tray and a shape's tile, a shape picked by a click on it
 * in the view (Shift-click for more), its size and place typed into Size & position, Delete, Join, Subtract and Group
 * pressed on the tool bar, a group's name typed into the top bar. Every act is a real pointer, mouse or key event into the
 * element the app drew, so the app's own handlers make the change and it goes up to Autora the way a person's does.
 *
 * Autora works out the finished model itself and puts it in after (server/caddesk.ts), so what the hand cannot do (a shape
 * inside a group, a colour, a turn) is not lost: it says what it did, and Autora says what it did not.
 */
import type { Doc } from './core/doc';
import { SHAPE_LABELS, type ShapeKind } from './utils/primitives';
import { handGo, handRest } from './agentCursor';

type Point = { x: number; y: number };

/** What the hand needs from the app: the model, what is picked, and where a shape is drawn. */
export interface HandApi {
  doc: () => Doc;
  selected: () => string[];
  screenOf: (ids: string[]) => (Point & { clear?: boolean }) | null;
  emptySpot: () => Point | null;
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

const pointer = (type: string, p: Point, shift = false): PointerEvent =>
  new PointerEvent(type, {
    bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0,
    buttons: type === 'pointerdown' ? 1 : 0, pointerId: 1, pointerType: 'mouse', isPrimary: true, shiftKey: shift,
  });
const mouse = (type: string, p: Point): MouseEvent =>
  new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, buttons: type === 'mousedown' ? 1 : 0 });

/** Go to a control and press it, with the events a mouse makes. */
async function press(el: HTMLElement | null, words?: string): Promise<void> {
  if (!el) throw new Skip('a control was not on the screen');
  if ((el as HTMLButtonElement).disabled) throw new Skip(`${el.getAttribute('aria-label') ?? 'a control'} was not available`);
  const p = centre(el);
  await handGo(p, true, el, words);
  el.dispatchEvent(pointer('pointerdown', p));
  el.dispatchEvent(mouse('mousedown', p));
  el.dispatchEvent(pointer('pointerup', p));
  el.dispatchEvent(mouse('mouseup', p));
  el.dispatchEvent(mouse('click', p));
  await sleep(rand(160, 260));
}

/** A tool of the bar by its name: on the bar, or in its All tools grid. */
async function tool(label: string, words?: string): Promise<void> {
  const onBar = document.querySelector<HTMLElement>(`nav[aria-label="Tools"] button[aria-label="${label}"]`);
  if (onBar) return press(onBar, words);
  await press(document.querySelector<HTMLElement>('nav[aria-label="Tools"] button[aria-label="All tools"]'), words);
  const tile = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>('[role="dialog"][aria-label="All tools"] button'))
    .find((b) => b.textContent?.trim() === label) ?? null);
  await press(tile, words);
}

const setValue = (input: HTMLInputElement, value: string) => {
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value')!.set!.call(input, value);
};

/** Click into a field, and type a number into it a key at a time; Enter puts it in. */
async function typeInto(input: HTMLInputElement | null, text: string, words?: string): Promise<void> {
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
  input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
  await sleep(rand(180, 260));
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null);
const ids = (v: unknown): string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string') : []);
const mm = (v: number) => String(Math.round(v * 100) / 100);

/** A click on the view itself, with Shift held when adding to the pick. */
async function tap(p: Point, words: string, shift = false): Promise<void> {
  const hit = document.elementFromPoint(p.x, p.y);
  if (!(hit instanceof HTMLCanvasElement)) throw new Skip('something was in front of a shape');
  await handGo(p, true, null, words);
  hit.dispatchEvent(pointer('pointerdown', p, shift));
  await sleep(40);
  hit.dispatchEvent(pointer('pointerup', p, shift));
  // The arrows of what is picked now spring in over a moment: where the next click is safe is known after.
  await sleep(rand(600, 700));
}

/**
 * Pick these shapes in the view: a click on the first, Shift-click on the rest. A shape inside a group, or one not on the
 * screen, is not one a click can pick alone: then nothing is picked and the hand says so.
 */
async function pick(api: HandApi, want: string[]): Promise<void> {
  const doc = api.doc();
  if (!want.length) throw new Skip('no shape was named');
  if (want.some((id) => doc.groups.some((g) => g.bodyIds.includes(id)))) throw new Skip('a shape in a group is picked with its group');
  let fitted = false;
  for (let i = 0; i < want.length; i++) {
    let p = api.screenOf([want[i]]);
    // Under the arrows of the shape picked now: a person clicks on nothing to let go of it first. Out of view: they fit
    // the model in the view.
    if (p && !p.clear && i === 0 && api.selected().length) {
      const empty = api.emptySpot();
      if (empty) await tap(empty, 'Letting go of the pick');
      p = api.screenOf([want[i]]);
    }
    if (!p && !fitted) {
      fitted = true;
      await press(document.querySelector<HTMLElement>('button[aria-label="Fit model in view"]'), 'Fitting the model in view');
      await sleep(700);
      p = api.screenOf([want[i]]);
    }
    // Small on the screen, so the arrows of the shape picked now cover it: a person scrolls in on it.
    for (let n = 0; p && !p.clear && n < 10; n++) {
      const canvas = document.elementFromPoint(p.x, p.y);
      if (!(canvas instanceof HTMLCanvasElement)) break;
      await handGo(p, false, null, 'Zooming in');
      canvas.dispatchEvent(new WheelEvent('wheel', { bubbles: true, cancelable: true, clientX: p.x, clientY: p.y, deltaY: -300, deltaMode: 0 }));
      await sleep(rand(260, 360));
      p = api.screenOf([want[i]]);
    }
    if (!p) throw new Skip('a shape was out of view');
    if (!p.clear) throw new Skip('something was in front of a shape');
    await tap(p, i === 0 ? 'Picking the shape' : 'Adding it to the pick', i > 0);
  }
  const now = api.selected();
  if (want.some((id) => !now.includes(id)) || now.length !== want.length) throw new Skip('the click picked something else');
}

/** The Size & position card, open. */
async function sizeCard(): Promise<void> {
  const open = () => document.querySelector('section[aria-label="Size & position options"]');
  if (open()) return;
  await tool('Size & position', 'Opening Size & position');
  if (!(await waitFor(open))) throw new Skip('Size & position did not open');
}
const field = (label: string) => document.querySelector<HTMLInputElement>(`section[aria-label="Size & position options"] input[aria-label="${label} in mm"]`);
const valueOf = (label: string) => Number(field(label)?.value ?? NaN);

/** Type the given sizes and place into Size & position, each only when it is not already that. */
async function typeSizes(want: { Width?: number | null; Depth?: number | null; Height?: number | null; X?: number | null; Y?: number | null; Z?: number | null }, did: string[]): Promise<void> {
  const todo = Object.entries(want).filter(([, v]) => v !== null && v !== undefined) as Array<[string, number]>;
  if (!todo.length) return;
  await sizeCard();
  for (const [label, v] of todo) {
    if (Math.abs(valueOf(label) - v) < 0.01) continue;
    await typeInto(field(label), mm(v), `Typing the ${label.toLowerCase()}`);
    did.push(`typed ${label} ${mm(v)} in Size & position`);
  }
}

/** One tool call, by hand. */
export async function runHand(name: string, args: Record<string, unknown>, api: HandApi): Promise<HandResult> {
  const did: string[] = [];
  try {
    switch (name) {
      case 'shape_add': {
        if (args.onTopOf !== undefined) throw new Skip('placing on top of a shape is done directly');
        const kind = String(args.kind ?? '') as ShapeKind;
        const label = SHAPE_LABELS[kind];
        if (!label) throw new Skip('no such shape');
        const before = new Set(api.doc().bodies.map((b) => b.id));
        await tool('Shape', 'Opening the shapes');
        const tile = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>('section[aria-label="Shape options"] button'))
          .find((b) => b.textContent?.trim() === label) ?? null);
        await press(tile, `Adding a ${label.toLowerCase()}`);
        const made = await waitFor(() => api.doc().bodies.find((b) => !before.has(b.id) && !b.repeatOf));
        if (!made) throw new Skip('no shape came');
        did.push(`added a ${label.toLowerCase()} from the Shape tray`);
        await typeSizes({ Width: num(args.width), Depth: num(args.depth), Height: num(args.height), X: num(args.x), Y: num(args.y), Z: num(args.elevation) }, did);
        break;
      }
      case 'shape_move': {
        await pick(api, ids(args.ids));
        did.push('picked the shapes in the view');
        const by = (args.by ?? {}) as Record<string, unknown>;
        const to = (args.to ?? {}) as Record<string, unknown>;
        await sizeCard();
        const at = { X: valueOf('X'), Y: valueOf('Y'), Z: valueOf('Z') };
        const goal = (k: 'x' | 'y' | 'z', now: number) => num(to[k]) ?? (num(by[k]) !== null ? now + num(by[k])! : null);
        await typeSizes({ X: goal('x', at.X), Y: goal('y', at.Y), Z: goal('z', at.Z) }, did);
        break;
      }
      case 'shape_resize': {
        await pick(api, ids([args.id]));
        did.push('picked the shape in the view');
        await typeSizes({ Width: num(args.width), Depth: num(args.depth), Height: num(args.height) }, did);
        break;
      }
      case 'shape_set': {
        if (num(args.height) === null && num(args.elevation) === null) throw new Skip('nothing here is a field of Size & position');
        await pick(api, ids([args.id]));
        did.push('picked the shape in the view');
        await typeSizes({ Height: num(args.height), Z: num(args.elevation) }, did);
        break;
      }
      case 'shape_delete': {
        const gone = ids(args.ids);
        await pick(api, gone);
        await tool('Delete', 'Deleting it');
        // It asks first, as it asks a person: Delete in that box is what removes them.
        const sure = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>('[role="alertdialog"] button'))
          .find((b) => b.textContent?.trim() === 'Delete') ?? null);
        if (sure) await press(sure, 'Yes, delete');
        if (!(await waitFor(() => !api.doc().bodies.some((b) => gone.includes(b.id))))) throw new Skip('the shapes were still there');
        did.push(sure ? 'picked the shapes, pressed Delete and said yes' : 'picked the shapes and pressed Delete');
        break;
      }
      case 'shapes_join': {
        const joined = ids(args.ids);
        await pick(api, joined);
        await tool('Join', 'Joining them');
        if (!(await waitFor(() => joined.some((id) => !api.doc().bodies.some((b) => b.id === id))))) throw new Skip('Join did nothing');
        did.push('picked the shapes and pressed Join');
        break;
      }
      case 'shapes_subtract': {
        const from = ids(args.from);
        const cutters = ids(args.cutters);
        // The shape picked last is the one cut out: a person picks the others, then the cutter.
        if (cutters.length !== 1) throw new Skip('more than one cutter is done directly');
        await pick(api, [...from, ...cutters]);
        await tool('Subtract', 'Cutting it out');
        if (!(await waitFor(() => !api.doc().bodies.some((b) => b.id === cutters[0])))) throw new Skip('Subtract did nothing');
        did.push('picked the shapes, the cutter last, and pressed Subtract');
        break;
      }
      case 'group_create': {
        const members = ids(args.ids);
        await pick(api, members);
        await tool('Group', 'Grouping them');
        if (!(await waitFor(() => api.doc().groups.some((g) => members.every((id) => g.bodyIds.includes(id)))))) throw new Skip('Group did nothing');
        did.push('picked the shapes and pressed Group');
        const name = typeof args.name === 'string' ? args.name.trim() : '';
        if (name) {
          const title = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>('button[title="Tap to rename"]'))[0] ?? null);
          await press(title, 'Naming the group');
          const input = await waitFor(() => document.querySelector<HTMLInputElement>('input[aria-label="Group name"]'));
          if (input) {
            input.select();
            let typed = '';
            for (const ch of name) {
              typed += ch;
              setValue(input, typed);
              input.dispatchEvent(new InputEvent('input', { bubbles: true, data: ch, inputType: 'insertText' }));
              await sleep(rand(55, 130));
            }
            input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true, cancelable: true }));
            did.push(`named it "${name}" in the top bar`);
          }
        }
        break;
      }
      default:
        throw new Skip('this one is done directly');
    }
    return { did };
  } catch (err) {
    return { did, skipped: err instanceof Error ? err.message : String(err) };
  } finally {
    handRest();
  }
}
