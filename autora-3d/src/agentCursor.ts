/**
 * @license
 * SPDX-License-Identifier: Apache-2.0
 */

/**
 * The agent's cursor, in Autora's frame: when the agent changes the model, a purple pointer goes to the tool it is
 * using the way a hand does (an arc, easing in and out, a tremor that fades, now and then an overshoot), rests,
 * presses it, and then goes to the shape it worked on. The model changes in between, so the cursor is never ahead
 * of the work and never points at a place that is not there: it goes only where the page says something is (a real
 * button, a shape's projected position) and, when it cannot find a place, it simply does not appear.
 *
 * Plain DOM rather than React state: it is a layer over the page, painted a frame at a time, and nothing in the app
 * depends on it.
 */

type Point = { x: number; y: number };

/** What the agent is doing, as the server says it (server/caddesk.ts). */
export interface Cue {
  seq: number;
  tool: string;
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (min: number, max: number) => min + Math.random() * (max - min);
const gauss = (spread: number) => ((Math.random() + Math.random() + Math.random()) / 1.5 - 1) * spread;
/** Minimum-jerk easing: the velocity profile of a reaching arm. */
const ease = (t: number) => t * t * t * (10 + t * (-15 + 6 * t));

function bezier(p0: Point, p1: Point, p2: Point, p3: Point, t: number): Point {
  const u = 1 - t;
  return {
    x: u * u * u * p0.x + 3 * u * u * t * p1.x + 3 * u * t * t * p2.x + t * t * t * p3.x,
    y: u * u * u * p0.y + 3 * u * u * t * p1.y + 3 * u * t * t * p2.y + t * t * t * p3.y,
  };
}

/** The curve a hand takes: an arc to one side, a tremor that settles as it arrives. */
function arc(from: Point, to: Point): (t: number) => Point {
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const dist = Math.hypot(dx, dy) || 1;
  const nx = -dy / dist;
  const ny = dx / dist;
  const bend = Math.min(dist * 0.3, 140) * (Math.random() < 0.5 ? -1 : 1);
  const c1 = { x: from.x + dx * rand(0.15, 0.4) + nx * bend * rand(0.3, 1), y: from.y + dy * rand(0.15, 0.4) + ny * bend * rand(0.3, 1) };
  const c2 = { x: from.x + dx * rand(0.6, 0.85) + nx * bend * rand(0, 0.6), y: from.y + dy * rand(0.6, 0.85) + ny * bend * rand(0, 0.6) };
  return (t) => {
    const p = bezier(from, c1, c2, to, ease(t));
    const shake = (1 - t) * 1.2;
    return t >= 1 ? to : { x: p.x + gauss(shake), y: p.y + gauss(shake) };
  };
}

/** How long a reach takes: a person is not faster over a short distance than a long one by much. */
const reachMs = (dist: number) => Math.round(Math.min(950, 260 + Math.sqrt(dist) * 28 + rand(0, 90)));

/** The tool button each of the agent's tools is a press of. Others (a face, an edge, a name) have no button. */
const BUTTON: Array<[RegExp, string]> = [
  [/^shape_add$|^shape_draw$|^library_place$/, 'Shape'],
  [/^shape_move$|^shape_turn$/, 'Move'],
  [/^group_create$|^group_remove$/, 'Group'],
  [/^repeat_/, 'Repeat'],
  [/^shape_delete$/, 'Delete'],
  [/^shapes_join$/, 'Join'],
  [/^shapes_subtract$|^shape_cut$/, 'Subtract'],
];

/** The visible control for a tool, or null. */
function buttonFor(tool: string): HTMLElement | null {
  const label = BUTTON.find(([re]) => re.test(tool))?.[1];
  if (!label) return null;
  const all = Array.from(document.querySelectorAll<HTMLElement>('nav[aria-label="Tools"] button, [role="menu"] button'));
  const found = all.find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === label)
    // Join and Subtract live in the Organize menu: that is the button there is to point at when the menu is shut.
    ?? (label === 'Join' || label === 'Subtract' ? all.find((b) => (b.getAttribute('aria-label') ?? b.textContent ?? '').trim() === 'Organize') : undefined);
  if (!found) return null;
  const r = found.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? found : null;
}

const centre = (el: HTMLElement): Point => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2, y: r.top + r.height / 2 };
};

let layer: HTMLDivElement | null = null;
let arrow: HTMLDivElement | null = null;
let at: Point | null = null;
let hideTimer = 0;
let busy: Promise<void> = Promise.resolve();

function ensureLayer(): HTMLDivElement {
  if (layer && layer.isConnected) return layer;
  layer = document.createElement('div');
  layer.setAttribute('aria-hidden', 'true');
  layer.style.cssText = 'position:fixed;inset:0;pointer-events:none;z-index:2147483000;overflow:hidden';
  arrow = document.createElement('div');
  arrow.style.cssText = 'position:absolute;left:0;top:0;opacity:0;transition:opacity .25s ease;will-change:transform';
  arrow.innerHTML =
    '<svg width="16" height="20" viewBox="0 0 16 20" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.4))">' +
    '<path d="M1 1 L1 15 L5 11.5 L8 18 L10.5 17 L7.5 10.5 L13 10.5 Z" fill="#7c5cff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>' +
    '<span style="position:absolute;left:14px;top:14px;padding:1px 7px;border-radius:999px;background:#7c5cff;color:#fff;font:600 10.5px/1.5 system-ui,sans-serif;white-space:nowrap">Autora</span>';
  layer.appendChild(arrow);
  document.body.appendChild(layer);
  return layer;
}

function place(p: Point) {
  at = p;
  if (arrow) arrow.style.transform = `translate(${p.x}px, ${p.y}px)`;
}

/** The ring that spreads where a press lands, and a pulse on the control that was pressed. */
function press(p: Point, control?: HTMLElement | null) {
  const host = ensureLayer();
  const ring = document.createElement('span');
  ring.style.cssText = `position:absolute;left:${p.x - 14}px;top:${p.y - 14}px;width:28px;height:28px;border-radius:50%;border:2px solid #7c5cff;opacity:.9;transform:scale(.4);transition:transform .45s ease-out,opacity .45s ease-out`;
  host.appendChild(ring);
  requestAnimationFrame(() => requestAnimationFrame(() => { ring.style.transform = 'scale(1.5)'; ring.style.opacity = '0'; }));
  window.setTimeout(() => ring.remove(), 600);
  if (control) {
    const before = control.style.boxShadow;
    control.style.transition = 'box-shadow .2s ease';
    control.style.boxShadow = '0 0 0 3px rgba(124,92,255,.7)';
    window.setTimeout(() => { control.style.boxShadow = before; }, 380);
  }
}

async function goTo(to: Point, pressed: boolean, control?: HTMLElement | null) {
  ensureLayer();
  window.clearTimeout(hideTimer);
  if (arrow) arrow.style.opacity = '1';
  // Its first appearance is off to the side of where it is going, as a hand coming in from rest.
  const from = at ?? { x: Math.min(innerWidth - 12, Math.max(12, to.x + 90)), y: Math.max(12, to.y - 60) };
  place(from);
  const path = arc(from, to);
  const ms = reachMs(Math.hypot(to.x - from.x, to.y - from.y));
  const started = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      const t = Math.min(1, (performance.now() - started) / ms);
      place(path(t));
      if (t < 1) requestAnimationFrame(tick);
      else resolve();
    };
    requestAnimationFrame(tick);
  });
  if (pressed) {
    await sleep(rand(120, 260));
    press(to, control);
    await sleep(220);
  }
}

/** After a while with nothing to do, the cursor fades away rather than sitting on the model. */
function rest() {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    if (arrow) arrow.style.opacity = '0';
    at = null;
  }, 2200);
}

export interface Showing {
  /** The tool button the agent's tool is a press of, if the page has one to point at. */
  tool: string;
  /** Apply the change: the model the agent made takes the place of the one on screen. */
  apply: () => void;
  /** Where on screen the shapes the change touched are now (called after `apply`), or null when it cannot say. */
  where: () => Point | null;
}

/**
 * Plays one change: to the tool and press it, the model changes, then to what changed. Changes queue, so two in quick
 * succession are shown one after the other and never overlap.
 */
export function show(cue: Showing): Promise<void> {
  const run = async () => {
    let applied = false;
    try {
      const control = buttonFor(cue.tool);
      if (control) await goTo(centre(control), true, control);
      cue.apply();
      applied = true;
      // The viewer takes a frame to draw what it was given.
      await sleep(180);
      const spot = cue.where();
      if (spot) {
        await goTo(spot, true);
        await sleep(240);
      }
    } finally {
      if (!applied) cue.apply();
      rest();
    }
  };
  busy = busy.then(run, run);
  return busy;
}
