/**
 * The agent's hand in the PDF editor (Visible work: docs/VISIBLE-WORK.md).
 *
 * With Visible work on, the agent's `pdf_edit` is not drawn onto the file on the server and then shown: the window hands
 * it to this frame, and the agent does it here, live, with the editor's own tools, the way a person at the computer
 * would. Its cursor (its colour, its name) travels to the tool on the bar (or through All tools), picks a colour in the
 * tool's card, scrolls to the page, and drags, clicks and types on the page itself. Every press is a pointer event on the
 * element that is really under that point (`elementFromPoint`), every word is typed into the editor's own text box or
 * form field a key at a time, so the editor answers it exactly as it answers a mouse and a keyboard. At the end it goes
 * back to Select and presses Ctrl+S, the editor's own Save, which is what hands the file back to Autora.
 *
 * What it cannot do by hand (a picture, a signature, a stamp the editor has no button for, an item over several pages)
 * it does not pretend to: the step comes back `skipped`, and the server does it on the file afterwards.
 *
 * The frame has no origin of its own: everything comes and goes by `postMessage` with the window that holds it
 * (components/SpectraWindow.tsx).
 */

type Who = { name?: string; color?: string };
type Item = Record<string, unknown> & { type?: string; i: number };
export type HandJob = { fields?: Record<string, unknown>; add?: Item[] };
type Result = { kind: "field" | "add"; key: string | number; ok: boolean; skipped?: boolean; error?: string; what: string };

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (lo: number, hi: number) => lo + Math.random() * (hi - lo);
const frame = () => new Promise<void>((r) => requestAnimationFrame(() => r()));

/** Not done by hand: the server does it on the file instead. */
class Skip extends Error {}

// ------------------------------------------------------------------ the cursor --

let cursor: HTMLDivElement | null = null;
let at = { x: innerWidth * 0.6, y: innerHeight * 0.4 };
let told = 0;

function showCursor(who: Who): void {
  cursor?.remove();
  const color = /^#[0-9a-f]{6}$/i.test(who.color ?? "") ? who.color! : "#6e5bff";
  const el = document.createElement("div");
  el.setAttribute("aria-hidden", "true");
  el.dataset.autoraHand = "";
  el.style.cssText = "position:fixed;left:0;top:0;z-index:2147483647;pointer-events:none;will-change:transform";
  el.innerHTML =
    `<svg width="20" height="22" viewBox="0 0 20 22" style="display:block;filter:drop-shadow(0 1px 2px rgba(0,0,0,.45))">` +
    `<path d="M1 1 L1 18 L5.6 14.2 L8.6 21 L11.2 19.9 L8.3 13.4 L13.6 13.4 Z" fill="${color}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>` +
    `<span style="position:absolute;left:15px;top:19px;padding:2px 7px;border-radius:7px;background:${color};color:#fff;font:600 11px/1.3 system-ui,sans-serif;white-space:nowrap"></span>`;
  (el.querySelector("span") as HTMLSpanElement).textContent = (who.name || "Autora").slice(0, 24);
  document.body.appendChild(el);
  cursor = el;
  place(at.x, at.y);
}

function hideCursor(): void {
  const el = cursor;
  cursor = null;
  if (el) setTimeout(() => el.remove(), 1200);
}

function place(x: number, y: number): void {
  at = { x, y };
  if (cursor) cursor.style.transform = `translate(${x}px, ${y}px)`;
  const now = performance.now();
  if (now - told > 70 && window.parent !== window) {
    told = now;
    window.parent.postMessage({ type: "autora:spectra:cursor", x, y }, "*");
  }
}

// ------------------------------------------------------------------ the hand --

const POINTER = 7;

function fire(target: Element, type: string, x: number, y: number, down: boolean, extra: Partial<PointerEventInit> = {}): void {
  const init = {
    bubbles: true, cancelable: true, composed: true, clientX: x, clientY: y, screenX: x, screenY: y,
    button: 0, buttons: down ? 1 : 0, view: window, ...extra,
  };
  if (type.startsWith("pointer")) {
    target.dispatchEvent(new PointerEvent(type, { ...init, pointerId: POINTER, pointerType: "mouse", isPrimary: true, width: 1, height: 1, pressure: down ? 0.5 : 0 }));
  } else {
    target.dispatchEvent(new MouseEvent(type, init));
  }
}

/** What is really under a point: the cursor itself is not (it takes no pointer events). */
const under = (x: number, y: number): Element => document.elementFromPoint(x, y) ?? document.body;

/** Move there as a hand does: an arc, faster in the middle, a little tremor; the page sees every step of it. */
async function glide(x: number, y: number, held: Element | null = null): Promise<void> {
  const from = { ...at };
  const dx = x - from.x, dy = y - from.y;
  const dist = Math.hypot(dx, dy);
  if (dist < 1) return;
  const ms = 260 + 115 * Math.log2(1 + dist / 24);
  const side = Math.random() < 0.5 ? -1 : 1;
  const bend = { x: from.x + dx / 2 - (dy / (dist || 1)) * dist * 0.12 * side, y: from.y + dy / 2 + (dx / (dist || 1)) * dist * 0.12 * side };
  const start = performance.now();
  for (;;) {
    await frame();
    const t = Math.min(1, (performance.now() - start) / ms);
    const e = t < 0.5 ? 4 * t * t * t : 1 - (-2 * t + 2) ** 3 / 2;
    const ax = from.x + (bend.x - from.x) * e, ay = from.y + (bend.y - from.y) * e;
    const bx = bend.x + (x - bend.x) * e, by = bend.y + (y - bend.y) * e;
    const px = ax + (bx - ax) * e + (t < 1 ? Math.sin(performance.now() / 37) * 0.4 : 0);
    const py = ay + (by - ay) * e + (t < 1 ? Math.cos(performance.now() / 53) * 0.4 : 0);
    place(px, py);
    const target = held ?? under(px, py);
    fire(target, "pointermove", px, py, held !== null);
    fire(target, "mousemove", px, py, held !== null);
    if (t >= 1) return;
  }
}

/** A click on whatever is there: press, release, click, with a person's pause between. */
async function click(x: number, y: number): Promise<Element> {
  await glide(x, y);
  await sleep(rand(60, 140));
  const target = under(x, y);
  fire(target, "pointerdown", x, y, true);
  fire(target, "mousedown", x, y, true);
  if (target instanceof HTMLElement && target.tabIndex >= 0 && /^(INPUT|TEXTAREA|SELECT)$/.test(target.tagName)) target.focus();
  await sleep(rand(70, 120));
  fire(target, "pointerup", x, y, false);
  fire(target, "mouseup", x, y, false);
  fire(target, "click", x, y, false, { detail: 1 } as Partial<PointerEventInit>);
  await sleep(rand(120, 200));
  return target;
}

/** Press at the first point, move through the rest with the button held, and let go. */
async function drag(points: Array<{ x: number; y: number }>, ms = 520): Promise<void> {
  const [first, ...rest] = points;
  await glide(first.x, first.y);
  await sleep(rand(80, 140));
  const target = under(first.x, first.y);
  fire(target, "pointerdown", first.x, first.y, true);
  fire(target, "mousedown", first.x, first.y, true);
  const step = ms / Math.max(1, rest.length);
  for (const p of rest) {
    const from = { ...at };
    const steps = Math.max(1, Math.round(step / 16));
    for (let s = 1; s <= steps; s++) {
      await frame();
      const px = from.x + ((p.x - from.x) * s) / steps, py = from.y + ((p.y - from.y) * s) / steps;
      place(px, py);
      fire(target, "pointermove", px, py, true);
      fire(target, "mousemove", px, py, true);
    }
  }
  await sleep(rand(60, 110));
  fire(target, "pointerup", at.x, at.y, false);
  fire(target, "mouseup", at.x, at.y, false);
  await sleep(rand(120, 200));
}

const centre = (el: Element) => {
  const r = el.getBoundingClientRect();
  return { x: r.left + r.width / 2 + rand(-0.15, 0.15) * r.width, y: r.top + r.height / 2 + rand(-0.15, 0.15) * r.height };
};
const shown = (el: Element | null | undefined): el is HTMLElement => !!el && el instanceof HTMLElement && el.getClientRects().length > 0 && getComputedStyle(el).visibility !== "hidden";

async function waitFor<T>(find: () => T | null | undefined, ms = 2500): Promise<T | null> {
  const end = performance.now() + ms;
  for (;;) {
    const got = find();
    if (got) return got;
    if (performance.now() > end) return null;
    await sleep(60);
  }
}

/** Typed into a text box or field a key at a time, as React's own input events: the editor sees each character arrive. */
async function type(el: HTMLInputElement | HTMLTextAreaElement, text: string, replace = true): Promise<void> {
  el.focus();
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
  const set = Object.getOwnPropertyDescriptor(proto, "value")!.set!;
  let value = replace ? "" : el.value;
  if (replace && el.value) {
    el.select();
    await sleep(rand(120, 220));
    set.call(el, "");
    el.dispatchEvent(new Event("input", { bubbles: true }));
  }
  for (const ch of Array.from(text)) {
    value += ch;
    el.dispatchEvent(new KeyboardEvent("keydown", { key: ch, bubbles: true, cancelable: true }));
    set.call(el, value);
    el.dispatchEvent(new InputEvent("input", { bubbles: true, data: ch, inputType: "insertText" }));
    el.dispatchEvent(new KeyboardEvent("keyup", { key: ch, bubbles: true }));
    await sleep(rand(45, 110));
  }
}

function key(target: Element, k: string, mods: { ctrl?: boolean; shift?: boolean } = {}): void {
  const init = { key: k, code: k.length === 1 ? `Key${k.toUpperCase()}` : k, bubbles: true, cancelable: true, ctrlKey: !!mods.ctrl, metaKey: false, shiftKey: !!mods.shift };
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

// -------------------------------------------------------------- the editor --

const pageCell = (n: number): HTMLElement | null => document.querySelectorAll<HTMLElement>(".docview-row > .page[data-page-id]")[n - 1] ?? null;

function scrollerOf(el: HTMLElement): HTMLElement | null {
  let s: HTMLElement | null = el.parentElement;
  while (s && !(s.scrollHeight > s.clientHeight + 4 && /auto|scroll/.test(getComputedStyle(s).overflowY))) s = s.parentElement;
  return s;
}

/** Bring a place into view by scrolling, smoothly, the way a wheel does: never a jump. */
async function scrollTo(el: HTMLElement, fy = 0.5): Promise<void> {
  const scroller = scrollerOf(el);
  const r = el.getBoundingClientRect();
  const want = r.top + fy * r.height;
  const top = scroller ? scroller.getBoundingClientRect().top : 0;
  const height = scroller ? scroller.clientHeight : innerHeight;
  if (want > top + height * 0.15 && want < top + height * 0.8) return;
  const by = want - (top + height * 0.4);
  if (!scroller) { el.scrollIntoView({ block: "center", behavior: "smooth" }); await sleep(450); return; }
  const from = scroller.scrollTop;
  const ms = Math.min(900, 250 + Math.abs(by) * 0.4);
  const start = performance.now();
  for (;;) {
    await frame();
    const t = Math.min(1, (performance.now() - start) / ms);
    scroller.scrollTop = from + by * (1 - (1 - t) ** 3);
    if (t >= 1) break;
  }
  await sleep(120);
}

/** A place on a page, from the agent's points (top-left of the page as shown) to this screen. */
async function onPage(page: number, x: number, y: number, h = 0): Promise<(px: number, py: number) => { x: number; y: number }> {
  const cell = await waitFor(() => pageCell(page), 4000);
  if (!cell) throw new Skip(`page ${page} is not in the editor`);
  const nw = Number(cell.dataset.naturalW) || 612;
  const nh = Number(cell.dataset.naturalH) || 792;
  await scrollTo(cell, Math.min(1, Math.max(0, (y + h / 2) / nh)));
  return (px, py) => {
    const r = cell.getBoundingClientRect();
    return { x: r.left + (px / nw) * r.width, y: r.top + (py / nh) * r.height };
  };
}

/** The tool, picked as a person picks it: its button on the bar, or All tools and its tile. */
async function pickTool(id: string): Promise<void> {
  const onBar = document.querySelector(`.autora-rail [data-phone="${id}"]`);
  if (shown(onBar)) {
    if (onBar.getAttribute("aria-pressed") === "true") return;
    const p = centre(onBar);
    await click(p.x, p.y);
    return;
  }
  const grid = document.querySelector('.autora-rail [data-phone="grid"]');
  if (!shown(grid)) throw new Skip(`the ${id} tool is not on screen`);
  const g = centre(grid);
  await click(g.x, g.y);
  const tile = await waitFor(() => { const t = document.querySelector(`[data-tile="${id}"]`); return shown(t) ? t : null; });
  if (!tile) throw new Skip(`the ${id} tool is not in All tools`);
  tile.scrollIntoView({ block: "nearest" });
  await sleep(150);
  const p = centre(tile);
  await click(p.x, p.y);
}

const NAMED: Record<string, string> = {
  black: "#16161a", ink: "#16161a", red: "#e0393e", blue: "#2f6fed", green: "#2fbf71", yellow: "#ffd54a", orange: "#f59e0b",
  purple: "#9333ea", gray: "#8a8a93", grey: "#8a8a93", white: "#ffffff", pink: "#ec4899",
};
const hex = (c: unknown): string | null => {
  if (typeof c !== "string") return null;
  const s = c.trim().toLowerCase();
  if (/^#[0-9a-f]{6}$/.test(s)) return s;
  if (/^#[0-9a-f]{3}$/.test(s)) return `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  return NAMED[s] ?? null;
};

/** The tool's colour, in its card: a swatch when it is one of them, else the colour wheel. */
async function pickColour(c: unknown): Promise<void> {
  const want = hex(c);
  if (!want) return;
  const tray = await waitFor(() => { const t = document.querySelector('[data-testid="phone-tray"]'); return shown(t) ? t : null; }, 1200);
  if (!tray) return;
  const swatch = [...tray.querySelectorAll<HTMLElement>(".autora-swatch")].find((s) => (s.getAttribute("aria-label") ?? "").toLowerCase().endsWith(want));
  if (shown(swatch)) {
    if (swatch.getAttribute("aria-pressed") === "true") return;
    const p = centre(swatch);
    await click(p.x, p.y);
    return;
  }
  const wheel = tray.querySelector<HTMLInputElement>('[data-testid="phone-wheel"]');
  if (!shown(wheel)) return;
  const p = centre(wheel);
  await glide(p.x, p.y);
  await sleep(rand(200, 320));
  Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!.call(wheel, want);
  wheel.dispatchEvent(new Event("input", { bubbles: true }));
  wheel.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(150);
}

const SHAPE_NAME: Record<string, string> = { rect: "Box", ellipse: "Circle", line: "Line", arrow: "Arrow" };

async function pickShape(shape: string): Promise<void> {
  const button = document.querySelector(`[data-testid="phone-tray"] [data-shape="${shape}"]`);
  if (shown(button)) {
    if (button.getAttribute("aria-pressed") !== "true") { const p = centre(button); await click(p.x, p.y); }
    return;
  }
  // A phone's card steps through the figures with one button.
  for (let i = 0; i < 8; i++) {
    const cyc = document.querySelector('[data-testid="phone-shape"]');
    if (!shown(cyc)) throw new Skip("the shape picker is not on screen");
    if ((cyc.getAttribute("aria-label") ?? "").includes(`Shape: ${SHAPE_NAME[shape]}.`)) return;
    const p = centre(cyc);
    await click(p.x, p.y);
  }
  throw new Skip(`the ${shape} shape could not be picked`);
}

/** The text box the editor has just opened for what was placed, once it has the keyboard. */
const openEditor = () => waitFor(() => {
  const el = document.activeElement;
  return el instanceof HTMLTextAreaElement && el.classList.contains("page-annot-editor") ? el : null;
}, 2000);

/** Where some words are on a page, from the page's own text layer. */
function wordsBox(cell: HTMLElement, words: string): DOMRect | null {
  const layer = cell.querySelector('[data-testid="text-layer"]');
  if (!layer) return null;
  const walker = document.createTreeWalker(layer, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  let all = "";
  const starts: number[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) { starts.push(all.length); nodes.push(n as Text); all += (n as Text).data; }
  const norm = (s: string) => s.replace(/\s+/g, " ").toLowerCase();
  const at = norm(all).indexOf(norm(words.trim()));
  if (at < 0) return null;
  // Map back (spaces were squeezed): walk the original text counting squeezed characters.
  let squeezed = 0, from = -1, to = -1;
  for (let i = 0, prevSpace = false; i < all.length; i++) {
    const space = /\s/.test(all[i]);
    if (space && prevSpace) continue;
    prevSpace = space;
    if (squeezed === at && from < 0) from = i;
    squeezed++;
    if (squeezed === at + norm(words.trim()).length) { to = i + 1; break; }
  }
  if (from < 0 || to < 0) return null;
  const locate = (i: number): [Text, number] => {
    let k = starts.length - 1;
    while (k > 0 && starts[k] > i) k--;
    return [nodes[k], Math.min(nodes[k].data.length, i - starts[k])];
  };
  const range = document.createRange();
  range.setStart(...locate(from));
  range.setEnd(...locate(to));
  const r = range.getBoundingClientRect();
  return r.width > 0 ? r : null;
}

/** The points of an SVG path, as strokes (one per pen-lift), in the path's own units. */
function pathStrokes(d: string): Array<Array<{ x: number; y: number }>> {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
  const path = document.createElementNS("http://www.w3.org/2000/svg", "path");
  path.setAttribute("d", d);
  svg.appendChild(path);
  document.body.appendChild(svg);
  try {
    const len = path.getTotalLength();
    const n = Math.max(8, Math.min(80, Math.round(len / 4)));
    const pts = Array.from({ length: n + 1 }, (_, i) => path.getPointAtLength((len * i) / n));
    const step = len / n;
    const strokes: Array<Array<{ x: number; y: number }>> = [[]];
    for (let i = 0; i < pts.length; i++) {
      if (i > 0 && Math.hypot(pts[i].x - pts[i - 1].x, pts[i].y - pts[i - 1].y) > step * 2.5) strokes.push([]);
      strokes[strokes.length - 1].push({ x: pts[i].x, y: pts[i].y });
    }
    return strokes.filter((s) => s.length > 1);
  } finally {
    svg.remove();
  }
}

const num = (v: unknown, d: number) => (typeof v === "number" && Number.isFinite(v) ? v : d);
const STAMPS: Record<string, string> = { APPROVED: "approved", REJECTED: "rejected", DRAFT: "draft", CONFIDENTIAL: "confidential", REVIEWED: "reviewed" };

/** One item of pdf_edit's `add`, done with the editor's tools. */
async function addItem(item: Item): Promise<void> {
  const kind = String(item.type ?? "");
  const page = Number(item.page ?? 1);
  if (!Number.isInteger(page) || page < 1) throw new Skip("it goes on more than one page");
  const x = num(item.x, 72), y = num(item.y, 72);
  const size = num(item.size, 12);
  const text = typeof item.text === "string" ? item.text : "";

  switch (kind) {
    case "text": {
      if (!text) throw new Skip("it has no words");
      const lines = text.split("\n");
      const w = num(item.width, Math.max(60, Math.max(...lines.map((l) => l.length)) * size * 0.55));
      const h = num(item.height, lines.length * size * 1.5 + 6);
      await pickTool("text");
      await pickColour(item.color);
      const to = await onPage(page, x, y, h);
      const a = to(x, y), b = to(x + w, y + h);
      await drag([a, { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }, b], 420);
      const box = await openEditor();
      if (!box) throw new Error("the text box did not open");
      await type(box, text, false);
      await sleep(rand(200, 320));
      key(box, "Enter", { ctrl: true });
      return;
    }
    case "note": {
      await pickTool("note");
      await pickColour(item.color);
      const to = await onPage(page, x, y);
      const p = to(x + 9, y + 9);
      await click(p.x, p.y);
      const box = await openEditor();
      if (!box) throw new Error("the note did not open");
      await type(box, text || "Note", false);
      await sleep(rand(200, 320));
      key(box, "Enter", { ctrl: true });
      return;
    }
    case "highlight": {
      await pickTool("highlight");
      await pickColour(item.color);
      if (text && item.width === undefined) {
        await onPage(page, x, y);
        const cell = pageCell(page)!;
        const r = wordsBox(cell, text);
        if (!r) throw new Skip(`"${text}" was not found on page ${page}`);
        await drag([{ x: r.left - 1, y: r.top - 1 }, { x: r.right + 1, y: r.bottom + 1 }], 480);
        return;
      }
      const w = num(item.width, 120), h = num(item.height, 16);
      const to = await onPage(page, x, y, h);
      await drag([to(x, y), to(x + w, y + h)], 480);
      return;
    }
    case "rect":
    case "ellipse":
    case "line":
    case "arrow": {
      await pickTool("shape");
      await pickShape(kind);
      await pickColour(item.color);
      if (kind === "line" || kind === "arrow") {
        const x2 = num(item.x2, x + num(item.width, 120)), y2 = num(item.y2, y + num(item.height, 0));
        const to = await onPage(page, x, Math.min(y, y2), Math.abs(y2 - y));
        await drag([to(x, y), to(x2, y2)], 520);
        return;
      }
      const w = num(item.width, 120), h = num(item.height, 80);
      const to = await onPage(page, x, y, h);
      await drag([to(x, y), to(x + w, y + h)], 520);
      return;
    }
    case "stamp": {
      const label = String(item.stamp ?? item.text ?? "").toUpperCase();
      const preset = STAMPS[label];
      if (!preset) throw new Skip(`the editor has no ${label || "such"} stamp button`);
      await pickTool("stamp");
      const button = await waitFor(() => { const b = document.querySelector(`[data-testid="stamp-preset-${preset}"]`); return shown(b) ? b : null; });
      if (!button) throw new Skip("the stamp buttons are not on screen");
      if (button.getAttribute("aria-pressed") !== "true") { const p = centre(button); await click(p.x, p.y); }
      const to = await onPage(page, x, y);
      const cell = pageCell(page)!;
      const nw = Number(cell.dataset.naturalW) || 612, nh = Number(cell.dataset.naturalH) || 792;
      // The editor centres its stamp on the click; the agent's x and y are its top-left corner.
      const p = to(x + num(item.width, nw * 0.32) / 2, y + num(item.height, nh * 0.09) / 2);
      await click(p.x, p.y);
      return;
    }
    case "check":
    case "cross":
    case "curve":
    case "path": {
      let strokes: Array<Array<{ x: number; y: number }>>;
      if (kind === "check") {
        const s = num(item.size, 14);
        strokes = [[{ x: x + 0.1 * s, y: y + 0.55 * s }, { x: x + 0.4 * s, y: y + 0.85 * s }, { x: x + 0.92 * s, y: y + 0.12 * s }]];
      } else if (kind === "cross") {
        const s = num(item.size, 14);
        strokes = [[{ x, y }, { x: x + s, y: y + s }], [{ x: x + s, y }, { x, y: y + s }]];
      } else if (kind === "curve") {
        const x2 = num(item.x2, x + 120), y2 = num(item.y2, y);
        const c1 = { x: num(item.cx, (x + x2) / 2), y: num(item.cy, y - 40) };
        const c2 = item.cx2 !== undefined ? { x: num(item.cx2, c1.x), y: num(item.cy2, c1.y) } : null;
        const pts: Array<{ x: number; y: number }> = [];
        for (let i = 0; i <= 24; i++) {
          const t = i / 24, u = 1 - t;
          pts.push(c2
            ? { x: u ** 3 * x + 3 * u * u * t * c1.x + 3 * u * t * t * c2.x + t ** 3 * x2, y: u ** 3 * y + 3 * u * u * t * c1.y + 3 * u * t * t * c2.y + t ** 3 * y2 }
            : { x: u * u * x + 2 * u * t * c1.x + t * t * x2, y: u * u * y + 2 * u * t * c1.y + t * t * y2 });
        }
        strokes = [pts];
      } else {
        if (typeof item.d !== "string" || !item.d.trim()) throw new Skip("it has no path");
        strokes = pathStrokes(item.d).map((s) => s.map((p) => ({ x: x + p.x, y: y + p.y })));
        if (strokes.length === 0) throw new Skip("its path draws nothing");
      }
      await pickTool("draw");
      await pickColour(item.color);
      const ys = strokes.flat().map((p) => p.y);
      const to = await onPage(page, x, Math.min(...ys), Math.max(...ys) - Math.min(...ys));
      for (const stroke of strokes) await drag(stroke.map((p) => to(p.x, p.y)), Math.min(1400, 180 + stroke.length * 30));
      return;
    }
    default:
      throw new Skip(`a ${kind || "nameless"} item is not one the editor's tools make`);
  }
}

/** One form field filled, as a person fills it: found on its page, clicked, typed into or ticked. */
async function fillField(name: string, value: unknown): Promise<void> {
  const selector = `[data-testid="form-widget-${CSS.escape(name)}"]`;
  // Fill fields shows the form's fields once it has read them from the file: a moment after the tool is picked.
  await waitFor(() => document.querySelector(selector) ?? document.querySelector('[data-testid^="form-widget-"]'), 5000);
  let widgets = [...document.querySelectorAll<HTMLElement>(selector)];
  // Pages are drawn as they come into view: go looking down the document, as a person scrolls to find a field.
  for (let page = 1; widgets.length === 0; page++) {
    const cell = pageCell(page);
    if (!cell) break;
    await scrollTo(cell, 0.3);
    widgets = (await waitFor(() => { const w = [...document.querySelectorAll<HTMLElement>(selector)]; return w.length ? w : null; }, 1200)) ?? [];
  }
  if (widgets.length === 0) throw new Skip(`the field "${name}" is not on any page`);
  const first = widgets[0];
  await scrollTo(first, 0.5);
  const input = first.matches("input, textarea, select") ? first : first.querySelector<HTMLElement>("input, textarea, select");
  if (input instanceof HTMLInputElement && input.type === "checkbox") {
    const want = value === true || value === "true" || value === "Yes" || value === "on";
    if (input.checked !== want) { const p = centre(input); await click(p.x, p.y); }
    return;
  }
  if (first.classList.contains("page-form-radio")) {
    const option = String(value);
    const pick = widgets.find((w) => (w.getAttribute("title") ?? "").includes(option));
    if (!pick) throw new Skip(`"${option}" is not one of the choices of "${name}"`);
    await scrollTo(pick, 0.5);
    const p = centre(pick);
    await click(p.x, p.y);
    return;
  }
  if (input instanceof HTMLSelectElement) {
    const p = centre(input);
    await click(p.x, p.y);
    const option = [...input.options].find((o) => o.value === String(value) || o.text === String(value));
    if (!option) throw new Skip(`"${String(value)}" is not one of the choices of "${name}"`);
    await sleep(rand(250, 400));
    Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype, "value")!.set!.call(input, option.value);
    input.dispatchEvent(new Event("change", { bubbles: true }));
    return;
  }
  if (input instanceof HTMLInputElement || input instanceof HTMLTextAreaElement) {
    const p = centre(input);
    await click(p.x, p.y);
    await type(input, Array.isArray(value) ? value.join(", ") : String(value ?? ""));
    await sleep(rand(150, 250));
    key(input, "Enter");
    input.blur();
    return;
  }
  throw new Skip(`the field "${name}" is not one that is typed or ticked`);
}

let busy = false;

/** The whole edit: the fields, then the items, then Select and Save. Says what each step did. */
export async function runHand(id: string, job: HandJob, who: Who): Promise<void> {
  const reply = (results: Result[], extra: Record<string, unknown> = {}) =>
    window.parent.postMessage({ type: "autora:spectra:handed", id, results, ...extra }, "*");
  if (busy) { reply([], { error: "the editor is already doing an edit" }); return; }
  busy = true;
  const results: Result[] = [];
  showCursor(who);
  try {
    const fields = Object.entries(job.fields ?? {});
    if (fields.length > 0) {
      try { await pickTool("forms"); } catch { /* each field says so below */ }
      for (const [name, value] of fields) {
        try {
          await fillField(name, value);
          results.push({ kind: "field", key: name, ok: true, what: `field ${name}` });
        } catch (err) {
          results.push({ kind: "field", key: name, ok: false, skipped: err instanceof Skip, error: String((err as Error)?.message ?? err), what: `field ${name}` });
        }
      }
      // Typed values wait in the editor until "Fill N fields" puts them into the document, as they do for a person.
      if (results.some((r) => r.kind === "field" && r.ok)) {
        const fill = await waitFor(() => { const b = document.querySelector('[data-testid="forms-fill-btn"]'); return shown(b) ? b : null; }, 3000);
        if (fill) {
          const p = centre(fill);
          await click(p.x, p.y);
          await waitFor(() => !shown(document.querySelector('[data-testid="forms-fill-btn"]')), 30_000);
        }
      }
    }
    for (const item of job.add ?? []) {
      try {
        await addItem(item);
        results.push({ kind: "add", key: item.i, ok: true, what: String(item.type) });
      } catch (err) {
        results.push({ kind: "add", key: item.i, ok: false, skipped: err instanceof Skip, error: String((err as Error)?.message ?? err), what: String(item.type) });
      }
    }
    const did = results.some((r) => r.ok);
    // Done: back to Select, as a person puts the tool down, and the editor's own Save.
    try { await pickTool("select"); } catch { /* no Select on screen: Save still works */ }
    if (did) {
      // Ctrl+S, the editor's own Save; then watch its Save button go grey, as a person does, and press again if it has
      // not (a commit still running when the first press came lets the save go by).
      const unsaved = () => { const b = document.querySelector('[data-file="save"]'); return !!b && !b.hasAttribute("disabled"); };
      for (let tries = 0; tries < 3; tries++) {
        await sleep(rand(250, 400));
        key(document.body, "s", { ctrl: true });
        if (await waitFor(() => !unsaved(), 8000)) break;
      }
    }
    reply(results, { saved: did });
  } catch (err) {
    reply(results, { error: String((err as Error)?.message ?? err) });
  } finally {
    busy = false;
    hideCursor();
  }
}
