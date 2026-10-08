/**
 * The editor's own screen, driven the way a hand does it: read what is on it,
 * click it, type into it, press keys, drag.
 *
 * The typed commands (commands.ts) cover what OpenCut's editor can do through
 * its own API. This is the rest of it, and the way to do any of it that the
 * person would watch: every part of OpenCut's interface is a control on the
 * page, and a control can be found, pointed at, clicked and typed into. It
 * sends real pointer, mouse, keyboard and input events -- not calls into the
 * editor's state -- so menus, selects, dialogs, sliders and the timeline answer
 * as they do to a person, and the editor's own history records what they do.
 */

export type Target = {
  /** A number from `read`. */
  ref?: number;
  /** What the control says: its label, its text, its placeholder. */
  label?: string;
  /** A clip on the timeline. */
  elementId?: string;
  /** A track on the timeline. */
  trackId?: string;
  /** A CSS selector, for what has no label. */
  selector?: string;
};

export type Spot = { x: number; y: number; w: number; h: number; view: { w: number; h: number } };
type Point = { x: number; y: number };

const INTERACTIVE = [
  "button", "a[href]", "input", "textarea", "select", "summary",
  "[role=button]", "[role=tab]", "[role=menuitem]", "[role=menuitemradio]", "[role=menuitemcheckbox]", "[role=option]",
  "[role=switch]", "[role=checkbox]", "[role=radio]", "[role=slider]", "[role=combobox]", "[role=treeitem]",
  "[contenteditable=true]", "[data-element-id]", "[data-track-id]",
].join(",");

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

function visible(el: Element): boolean {
  const r = el.getBoundingClientRect();
  if (r.width < 2 || r.height < 2) return false;
  if (r.bottom < 0 || r.right < 0 || r.top > window.innerHeight || r.left > window.innerWidth) return false;
  const style = getComputedStyle(el);
  if (style.visibility === "hidden" || style.display === "none" || Number(style.opacity) === 0) return false;
  return !el.closest("[aria-hidden=true]:not([data-state])");
}

/** The control's name, as a person would say it. */
function labelOf(el: Element): string {
  const text = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const aria = text(el.getAttribute("aria-label"));
  if (aria) return aria;
  const by = el.getAttribute("aria-labelledby");
  if (by) {
    const t = text(by.split(/\s+/).map((id) => document.getElementById(id)?.textContent).join(" "));
    if (t) return t;
  }
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el instanceof HTMLSelectElement) {
    const own = el.id ? text(document.querySelector(`label[for="${CSS.escape(el.id)}"]`)?.textContent) : "";
    if (own) return own;
    const wrap = text(el.closest("label")?.textContent);
    if (wrap) return wrap;
    const placeholder = text(el.getAttribute("placeholder"));
    if (placeholder) return placeholder;
    // OpenCut puts the field's name in the row before it.
    const row = el.closest("[class*=field], [class*=Field], div");
    const near = text(row?.parentElement?.querySelector("label, [class*=label], span")?.textContent);
    if (near) return near.slice(0, 60);
    return text(el.getAttribute("name"));
  }
  const title = text(el.getAttribute("title"));
  const inner = text((el as HTMLElement).innerText ?? el.textContent);
  return (inner || title).slice(0, 80);
}

/** An open dialog, menu or list holds the page: what is behind it cannot be reached. */
function scope(): Element | Document {
  const open = [...document.querySelectorAll("[role=dialog], [role=alertdialog], [role=menu], [role=listbox], [data-radix-popper-content-wrapper]")].filter(visible);
  return open[open.length - 1] ?? document;
}

function candidates(): HTMLElement[] {
  const root = scope();
  return [...root.querySelectorAll<HTMLElement>(INTERACTIVE)].filter(visible);
}

export type Control = { ref: number; role: string; label: string; value?: string; state?: string };

let nextRef = 1;

function roleOf(el: HTMLElement): string {
  const role = el.getAttribute("role");
  if (role) return role;
  if (el.dataset.elementId) return "clip";
  if (el.dataset.trackId) return "track";
  if (el instanceof HTMLInputElement) return el.type === "checkbox" ? "checkbox" : el.type === "range" ? "slider" : `input:${el.type}`;
  return el.tagName.toLowerCase();
}

/** What is on the screen to use, each with a number to name it by. */
export function read(): { scope: string; controls: Control[] } {
  const inScope = scope();
  const out: Control[] = [];
  for (const el of candidates()) {
    if (out.length >= 160) break;
    let ref = Number(el.dataset.autoraRef);
    if (!ref) {
      ref = nextRef++;
      el.dataset.autoraRef = String(ref);
    }
    const label = el.dataset.elementId ? `clip ${el.dataset.elementId}: ${labelOf(el)}` : el.dataset.trackId ? `track ${el.dataset.trackId}: ${el.getAttribute("aria-label") ?? ""}` : labelOf(el);
    const control: Control = { ref, role: roleOf(el), label };
    if (el instanceof HTMLInputElement && (el.type === "checkbox" || el.type === "radio")) {
      control.state = el.checked ? "checked" : "unchecked";
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      control.value = el.value.slice(0, 80);
    } else if (el instanceof HTMLSelectElement) control.value = el.value;
    const aria = ["aria-checked", "aria-selected", "aria-expanded", "aria-pressed", "data-state", "aria-valuenow"].map((a) => {
      const v = el.getAttribute(a);
      return v === null ? "" : `${a.replace("aria-", "").replace("data-", "")}=${v}`;
    }).filter(Boolean);
    if (aria.length) control.state = [control.state, ...aria].filter(Boolean).join(" ");
    if ((el as HTMLButtonElement).disabled || el.getAttribute("aria-disabled") === "true") control.state = `${control.state ?? ""} disabled`.trim();
    out.push(control);
  }
  const name = inScope instanceof Document ? "the editor" : (inScope.getAttribute("role") ?? "an open panel");
  return { scope: name, controls: out };
}

/** The control a target names; an error that says what to do when it names none or several. */
export function find(target: Target): HTMLElement {
  if (target.selector) {
    const el = document.querySelector<HTMLElement>(target.selector);
    if (!el) throw new Error(`Nothing matches ${target.selector}`);
    return el;
  }
  if (target.elementId) {
    const el = document.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(target.elementId)}"]`);
    if (!el) throw new Error(`Clip ${target.elementId} is not on the timeline screen (it may be scrolled out of view: seek to it, or zoom the timeline)`);
    return el;
  }
  if (target.trackId) {
    const el = document.querySelector<HTMLElement>(`[data-track-id="${CSS.escape(target.trackId)}"]`);
    if (!el) throw new Error(`Track ${target.trackId} is not on screen`);
    return el;
  }
  if (typeof target.ref === "number") {
    const el = document.querySelector<HTMLElement>(`[data-autora-ref="${target.ref}"]`);
    if (!el || !visible(el)) throw new Error(`Control ${target.ref} is no longer on screen: read the screen again`);
    return el;
  }
  const want = (target.label ?? "").trim().toLowerCase();
  if (!want) throw new Error("Say which control: a ref from reading the screen, or its label");
  const all = candidates().map((el) => ({ el, label: labelOf(el).toLowerCase() }));
  const exact = all.filter((c) => c.label === want);
  const part = exact.length ? exact : all.filter((c) => c.label.includes(want));
  if (part.length === 0) throw new Error(`No control labelled "${target.label}" is on screen: read the screen to see what is`);
  if (part.length > 1 && exact.length !== 1) {
    throw new Error(`"${target.label}" matches ${part.length} controls (${part.slice(0, 5).map((c) => `"${c.label.slice(0, 30)}"`).join(", ")}): use a ref from reading the screen`);
  }
  return part[0].el;
}

/** Where a control is, centred and in view. */
export function spot(el: HTMLElement): Spot {
  el.scrollIntoView({ block: "nearest", inline: "nearest" });
  const r = el.getBoundingClientRect();
  const view = { w: window.innerWidth, h: window.innerHeight };
  const x = Math.min(view.w - 10, Math.max(10, r.left + Math.min(r.width / 2, 120)));
  const y = Math.min(view.h - 10, Math.max(10, r.top + r.height / 2));
  return { x, y, w: r.width, h: r.height, view };
}

function mouse(target: Element, type: string, at: Point, extra: MouseEventInit = {}): void {
  const down = type === "pointerdown" || type === "mousedown";
  const init: PointerEventInit = {
    bubbles: true, cancelable: true, composed: true, view: window, clientX: at.x, clientY: at.y,
    button: 0, buttons: down || type.endsWith("move") ? extra.buttons ?? 0 : 0,
    pointerId: 1, pointerType: "mouse", isPrimary: true, ...extra,
  };
  target.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, init) : new MouseEvent(type, init));
}

/** What a click at a point lands on: the control, or a child of it that is under the point. */
function under(el: HTMLElement, at: Point): Element {
  const hit = document.elementFromPoint(at.x, at.y);
  return hit && (el === hit || el.contains(hit)) ? hit : el;
}

export async function click(el: HTMLElement, opts: { double?: boolean; right?: boolean } = {}): Promise<void> {
  const at = spot(el);
  const p = { x: at.x, y: at.y };
  const hit = under(el, p);
  const button = opts.right ? 2 : 0;
  mouse(hit, "pointerover", p);
  mouse(hit, "mouseover", p);
  mouse(hit, "pointermove", p);
  mouse(hit, "mousemove", p);
  for (let n = 0; n < (opts.double ? 2 : 1); n++) {
    mouse(hit, "pointerdown", p, { button, buttons: opts.right ? 2 : 1 });
    mouse(hit, "mousedown", p, { button, buttons: opts.right ? 2 : 1 });
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) el.focus();
    else (el.closest("button, [tabindex]") as HTMLElement | null)?.focus?.({ preventScroll: true });
    await sleep(40);
    mouse(hit, "pointerup", p, { button });
    mouse(hit, "mouseup", p, { button });
    if (opts.right) mouse(hit, "contextmenu", p, { button: 2 });
    else mouse(hit, "click", p, { detail: n + 1 });
    if (opts.double) await sleep(60);
  }
  if (opts.double) mouse(hit, "dblclick", p, { detail: 2 });
}

/** The field a person types into: the control itself, or the one inside it. */
function field(el: HTMLElement): HTMLInputElement | HTMLTextAreaElement | HTMLElement {
  if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement || el.isContentEditable) return el;
  const inner = el.querySelector<HTMLInputElement | HTMLTextAreaElement | HTMLElement>("input, textarea, [contenteditable=true]");
  if (!inner) throw new Error("That control takes no typing");
  return inner;
}

/** Type into a field. `replace` clears what is there first; otherwise it goes on after it. */
export function type(el: HTMLElement, text: string, replace: boolean): { value: string } {
  const f = field(el);
  f.focus({ preventScroll: true });
  if (f instanceof HTMLInputElement || f instanceof HTMLTextAreaElement) {
    const proto = f instanceof HTMLInputElement ? HTMLInputElement.prototype : HTMLTextAreaElement.prototype;
    const set = Object.getOwnPropertyDescriptor(proto, "value")?.set;
    const next = (replace ? "" : f.value) + text;
    // React watches the element's own value setter; the prototype's is the one that gets past it.
    set?.call(f, next);
    f.setSelectionRange?.(next.length, next.length);
    f.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: text }));
    return { value: f.value };
  }
  if (replace) document.execCommand("selectAll", false);
  document.execCommand("insertText", false, text);
  return { value: f.textContent ?? "" };
}

/** Commit a field the way Enter or leaving it does. */
export function commit(el: HTMLElement, how: "enter" | "blur"): void {
  const f = field(el);
  if (how === "enter") press("Enter", {}, f);
  else {
    f.dispatchEvent(new Event("change", { bubbles: true }));
    f.blur();
  }
}

const NAMED: Record<string, { key: string; code: string }> = {
  enter: { key: "Enter", code: "Enter" }, escape: { key: "Escape", code: "Escape" }, esc: { key: "Escape", code: "Escape" },
  tab: { key: "Tab", code: "Tab" }, space: { key: " ", code: "Space" }, backspace: { key: "Backspace", code: "Backspace" },
  delete: { key: "Delete", code: "Delete" }, home: { key: "Home", code: "Home" }, end: { key: "End", code: "End" },
  up: { key: "ArrowUp", code: "ArrowUp" }, down: { key: "ArrowDown", code: "ArrowDown" },
  left: { key: "ArrowLeft", code: "ArrowLeft" }, right: { key: "ArrowRight", code: "ArrowRight" },
  pageup: { key: "PageUp", code: "PageUp" }, pagedown: { key: "PageDown", code: "PageDown" },
};

/** One key, or a chord ("ctrl+shift+z", "s", "ArrowRight"), to whatever has focus. */
export function press(chord: string, mods: { ctrl?: boolean; shift?: boolean; alt?: boolean; meta?: boolean } = {}, to?: Element): void {
  const parts = chord.split("+").map((p) => p.trim()).filter(Boolean);
  const name = parts.pop() ?? "";
  const m = { ctrl: !!mods.ctrl, shift: !!mods.shift, alt: !!mods.alt, meta: !!mods.meta };
  for (const p of parts.map((x) => x.toLowerCase())) {
    if (p === "ctrl" || p === "control") m.ctrl = true;
    else if (p === "shift") m.shift = true;
    else if (p === "alt" || p === "option") m.alt = true;
    else if (p === "meta" || p === "cmd" || p === "command") m.meta = true;
  }
  const named = NAMED[name.toLowerCase()];
  const key = named?.key ?? (name.length === 1 ? (m.shift ? name.toUpperCase() : name.toLowerCase()) : name);
  const code = named?.code ?? (/^[a-z]$/i.test(name) ? `Key${name.toUpperCase()}` : /^\d$/.test(name) ? `Digit${name}` : name);
  const init: KeyboardEventInit = { key, code, ctrlKey: m.ctrl, shiftKey: m.shift, altKey: m.alt, metaKey: m.meta, bubbles: true, cancelable: true, composed: true };
  const target = to ?? document.activeElement ?? document.body;
  target.dispatchEvent(new KeyboardEvent("keydown", init));
  target.dispatchEvent(new KeyboardEvent("keyup", init));
}

/** Press on one point and let go on another, moving between, the way the timeline's clips and the playhead are dragged. */
export async function drag(from: Point, to: Point, opts: { steps?: number } = {}): Promise<void> {
  const grabbed = document.elementFromPoint(from.x, from.y) ?? document.body;
  const steps = Math.max(4, Math.min(40, opts.steps ?? 16));
  mouse(grabbed, "pointerdown", from, { buttons: 1 });
  mouse(grabbed, "mousedown", from, { buttons: 1 });
  await sleep(50);
  for (let i = 1; i <= steps; i++) {
    const p = { x: from.x + ((to.x - from.x) * i) / steps, y: from.y + ((to.y - from.y) * i) / steps };
    const at = document.elementFromPoint(p.x, p.y) ?? document.body;
    mouse(at, "pointermove", p, { buttons: 1 });
    mouse(at, "mousemove", p, { buttons: 1 });
    await sleep(16);
  }
  const dropped = document.elementFromPoint(to.x, to.y) ?? document.body;
  mouse(dropped, "pointerup", to, {});
  mouse(dropped, "mouseup", to, {});
}

export function scroll(el: HTMLElement | null, dx: number, dy: number): void {
  let node: HTMLElement | null = el ?? (document.scrollingElement as HTMLElement | null);
  while (node && node !== document.body) {
    const s = getComputedStyle(node);
    const can = (s.overflowY === "auto" || s.overflowY === "scroll" || s.overflowX === "auto" || s.overflowX === "scroll") && (node.scrollHeight > node.clientHeight || node.scrollWidth > node.clientWidth);
    if (can) break;
    node = node.parentElement;
  }
  (node ?? document.scrollingElement)?.scrollBy({ left: dx, top: dy });
}

/** The text on the screen that is not a control: dialogs' messages, toasts, errors. */
export function messages(): string[] {
  const roots = [...document.querySelectorAll("[role=dialog], [role=alertdialog], [role=alert], [role=status], [data-sonner-toast], [data-sonner-toaster]")].filter(visible);
  return roots.map((r) => (r as HTMLElement).innerText.replace(/\s+/g, " ").trim()).filter(Boolean).map((t) => t.slice(0, 300));
}
