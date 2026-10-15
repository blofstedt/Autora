/**
 * The agent's purple pointer, for the windows that are part of this page (Music) and, through `offset`, for the ones
 * in a frame (PDF): it goes to a place the page says something is, the way a hand does -- an arc, easing in and out, a
 * tremor that settles, a rest, a press with a ring -- and fades away after a while with nothing to do.
 *
 * A layer of its own on the body, so no window needs to hold it. It never goes anywhere nothing is: callers give
 * it the rectangle of a real element, or a point a frame confirmed. (The Office windows have their own, which also
 * types; see components/OfficeCursor.tsx.)
 */
import { along, humanRoute, restMs, routeMs, typingDelays, type Point } from "./humanPath";
import { clearCursor, reportCursor } from "./cursorPos";
import { getCursorWho, glyphPoints, onCursorWho } from "./cursorWho";

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

let layer: HTMLDivElement | null = null;
let arrow: HTMLDivElement | null = null;
let at: Point | null = null;
let hideTimer = 0;
let token = 0;

function ensure(): HTMLDivElement {
  if (layer?.isConnected) return layer;
  layer = document.createElement("div");
  layer.setAttribute("aria-hidden", "true");
  layer.className = "agent-pointer-layer";
  arrow = document.createElement("div");
  arrow.className = "agent-pointer";
  // Wrapped, so it can pop in and dissolve out (.cursor-pop) while the arrow itself carries where it is.
  arrow.innerHTML =
    '<span class="cursor-pop"><svg width="16" height="20" viewBox="0 0 16 20"><path d="M1 1 L1 15 L5 11.5 L8 18 L10.5 17 L7.5 10.5 L13 10.5 Z" fill="#7c5cff" stroke="#fff" stroke-width="1.2" stroke-linejoin="round"/></svg>' +
    '<span class="agent-pointer-name"><svg class="cursor-glyph" viewBox="0 0 10 10"><polygon/></svg><b></b></span><span class="agent-pointer-typed"></span></span>';
  layer.appendChild(arrow);
  signed();
  document.body.appendChild(layer);
  return layer;
}

/** Whose pointer it is: the name and the shape of the agent working (lib/cursorWho.ts). The colour comes from the page's variables. */
function signed() {
  const who = getCursorWho();
  const tag = arrow?.querySelector(".agent-pointer-name");
  if (!tag) return;
  tag.querySelector("b")!.textContent = who.name;
  tag.querySelector("polygon")!.setAttribute("points", glyphPoints(who.look?.sides ?? 3));
}
onCursorWho(signed);

/** The pointer is typing (the tag shows a caret) while the agent's keys are being struck somewhere it cannot draw them. */
export function pointerTyping(on: boolean) {
  ensure();
  arrow?.classList.toggle("is-typing", on);
}

function place(p: Point) {
  at = p;
  if (arrow) arrow.style.transform = `translate(${p.x}px, ${p.y}px)`;
  reportCursor(p.x, p.y);
}

/** The centre of an element, in the page's pixels; null when it is not on screen. */
export function centreOf(el: Element | null | undefined): Point | null {
  if (!el) return null;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 ? { x: r.left + r.width / 2, y: r.top + r.height / 2 } : null;
}

function ring(p: Point, control?: Element | null) {
  const host = ensure();
  const dot = document.createElement("span");
  dot.className = "agent-pointer-ring";
  dot.style.left = `${p.x - 14}px`;
  dot.style.top = `${p.y - 14}px`;
  host.appendChild(dot);
  window.setTimeout(() => dot.remove(), 650);
  if (control instanceof HTMLElement) {
    control.classList.add("is-agent-pressed");
    window.setTimeout(() => control.classList.remove("is-agent-pressed"), 420);
  }
}

/** Go to `to` and, when `press`, press there. Resolves when it has arrived (and pressed); a newer call cancels this one. */
export async function pointerGo(to: Point, press = true, control?: Element | null): Promise<boolean> {
  const mine = ++token;
  const host = ensure();
  window.clearTimeout(hideTimer);
  const appearing = !host.classList.contains("is-on");
  host.classList.remove("is-off");
  host.classList.add("is-on");
  const from = at ?? { x: Math.min(innerWidth - 12, Math.max(12, to.x + 90)), y: Math.max(12, to.y - 60) };
  place(from);
  // Coming into being: a beat to pop in where it starts before it sets off.
  if (appearing) await sleep(160);
  if (mine !== token) return false;
  const route = humanRoute(from, to);
  const ms = routeMs(Math.hypot(to.x - from.x, to.y - from.y));
  const started = performance.now();
  await new Promise<void>((resolve) => {
    const tick = () => {
      if (mine !== token) { resolve(); return; }
      const p = Math.min(1, (performance.now() - started) / ms);
      place(along(route, p));
      if (p < 1) requestAnimationFrame(tick); else resolve();
    };
    requestAnimationFrame(tick);
  });
  if (mine !== token) return false;
  if (press) {
    await sleep(restMs());
    if (mine !== token) return false;
    ring(to, control);
    await sleep(240);
  }
  return mine === token;
}

/** Typed words beside the pointer, a few letters at a time with a person's uneven gaps: for places that take text. */
export async function pointerType(text: string): Promise<void> {
  const mine = token;
  ensure();
  const shown = arrow?.querySelector<HTMLElement>(".agent-pointer-typed");
  if (!shown) return;
  const chars = Array.from(text.slice(0, 80));
  const gaps = typingDelays(chars.join(""), 1800);
  shown.textContent = "";
  for (let i = 0; i < chars.length; i++) {
    if (mine !== token) break;
    shown.textContent += chars[i];
    await sleep(Math.max(25, gaps[i] ?? 60));
  }
  await sleep(300);
  shown.textContent = "";
}

/** Nothing more to do here: it fades after a moment, and the line the agent says beside it lets go of it. */
export function pointerRest(after = 2200) {
  window.clearTimeout(hideTimer);
  hideTimer = window.setTimeout(() => {
    // Dissolves rather than vanishing (.is-off plays cursorOut), then the next pointerGo pops it back in.
    if (layer?.classList.contains("is-on")) {
      layer.classList.remove("is-on");
      layer.classList.add("is-off");
    }
    at = null;
    clearCursor();
  }, after);
}
