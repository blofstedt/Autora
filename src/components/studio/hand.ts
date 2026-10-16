/**
 * The agent's hand in the Music window (Visible work): the steps the server worked out (src/lib/studio/handsteps.ts) done
 * with the window's own controls, as a person would, while the person watches and the tool call waits. Its pointer goes to
 * each control at a person's pace and presses it there: the Song tray's fields, Add track and the instrument, a track's
 * menu, M and S, the Mixer's sliders, a clip drawn across its lane and dragged into place, the piano roll's grid and drum
 * steps, the roll's own buttons. Each act is a real pointer, mouse or key event into the element the window drew, so the
 * window's own handlers make the change, and it is saved the way a person's is.
 *
 * What it cannot do (a control that is not on screen, a step with no control) it leaves: the finished song goes in after,
 * so nothing is lost. Each step says whether it was done.
 */
import { instrumentOf, pitchName, DRUMS, type Project } from "../../lib/studio/model";
import type { StudioStep } from "../../lib/studio/handsteps";
import { centreOf, pointerGo, pointerPlace, pointerRest, pointerTyping } from "../../lib/pointer";
import { typingDelays, type Point } from "../../lib/humanPath";

type HandEnv = {
  root: HTMLElement;
  live: () => Project;
  saveNow: () => Promise<void>;
};

type HandResult = { i: number; ok: boolean; error?: string };

class Skip extends Error {}
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));
const rand = (a: number, b: number) => a + Math.random() * (b - a);

async function waitFor<T>(fn: () => T | null | undefined | false, ms = 3000): Promise<T | null> {
  const end = Date.now() + ms;
  for (;;) {
    const v = fn();
    if (v) return v;
    if (Date.now() > end) return null;
    await sleep(60);
  }
}

// ------------------------------------------------------------- input events --

const ptr = (type: string, p: Point, extra: PointerEventInit = {}) =>
  new PointerEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, pointerId: 1, pointerType: "mouse", isPrimary: true, button: 0, buttons: type === "pointerup" ? 0 : 1, ...extra });
const mouse = (type: string, p: Point, detail = 1) =>
  new MouseEvent(type, { bubbles: true, cancelable: true, composed: true, clientX: p.x, clientY: p.y, button: 0, buttons: type === "mouseup" || type === "click" || type === "dblclick" ? 0 : 1, detail });

/** Where on screen an element's middle is, scrolled into view first (as a person scrolls to it). */
async function into(el: Element): Promise<Point> {
  let p = centreOf(el);
  const r = el.getBoundingClientRect();
  if (!p || r.bottom < 0 || r.top > innerHeight || r.right < 0 || r.left > innerWidth) {
    el.scrollIntoView({ block: "nearest", inline: "nearest", behavior: "smooth" });
    await sleep(350);
    p = centreOf(el);
  }
  if (!p) throw new Skip("not on screen");
  return p;
}

/** Go to the element and press it: the events a mouse click makes, on that element. */
async function click(el: Element | null, count = 1): Promise<void> {
  if (!el) throw new Skip("not on screen");
  if ((el as HTMLButtonElement).disabled) throw new Skip("not available");
  const p = await into(el);
  await pointerGo(p, true, el);
  for (let n = 1; n <= count; n++) {
    el.dispatchEvent(ptr("pointerdown", p));
    el.dispatchEvent(mouse("mousedown", p, n));
    if (el instanceof HTMLElement && el.tabIndex >= 0) el.focus({ preventScroll: true });
    el.dispatchEvent(ptr("pointerup", p));
    el.dispatchEvent(mouse("mouseup", p, n));
    el.dispatchEvent(mouse("click", p, n));
    if (n < count) await sleep(90);
  }
  if (count === 2) el.dispatchEvent(mouse("dblclick", p, 2));
  await sleep(rand(120, 220));
}

/** Press at `from`, move to `to` a frame at a time, let go: on the element under `from` (which keeps the pointer). */
async function drag(from: Point, to: Point, target?: Element | null): Promise<void> {
  const el = target ?? document.elementFromPoint(from.x, from.y);
  if (!el) throw new Skip("not on screen");
  await pointerGo(from, false);
  await sleep(rand(80, 160));
  el.dispatchEvent(ptr("pointerdown", from));
  el.dispatchEvent(mouse("mousedown", from));
  const dist = Math.hypot(to.x - from.x, to.y - from.y);
  const frames = Math.max(8, Math.min(40, Math.round(dist / 8)));
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    const e = t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2;
    const p = { x: from.x + (to.x - from.x) * e, y: from.y + (to.y - from.y) * e };
    pointerPlace(p);
    el.dispatchEvent(ptr("pointermove", p));
    await sleep(16);
  }
  await sleep(rand(60, 120));
  el.dispatchEvent(ptr("pointerup", to));
  el.dispatchEvent(mouse("mouseup", to));
  await sleep(rand(150, 250));
}

const setValue = (el: HTMLInputElement | HTMLSelectElement, value: string) => {
  const proto = el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, "value")!.set!.call(el, value);
};

/** Click into a field, take what is in it, and type the new words a key at a time. */
async function typeInto(input: HTMLInputElement | null, text: string): Promise<void> {
  if (!input) throw new Skip("the field is not on screen");
  await click(input);
  input.focus({ preventScroll: true });
  input.select();
  pointerTyping(true);
  try {
    const gaps = typingDelays(text, Math.min(2400, 140 * text.length + 200));
    let typed = "";
    for (let i = 0; i < text.length; i++) {
      const key = text[i]!;
      input.dispatchEvent(new KeyboardEvent("keydown", { key, bubbles: true }));
      typed += key;
      setValue(input, typed);
      input.dispatchEvent(new InputEvent("input", { bubbles: true, data: key, inputType: "insertText" }));
      input.dispatchEvent(new KeyboardEvent("keyup", { key, bubbles: true }));
      await sleep(Math.max(35, gaps[i] ?? 70));
    }
  } finally {
    pointerTyping(false);
  }
  await sleep(rand(120, 200));
}

const enter = (el: Element) => {
  el.dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", code: "Enter", bubbles: true, cancelable: true }));
  el.dispatchEvent(new KeyboardEvent("keyup", { key: "Enter", code: "Enter", bubbles: true }));
};

/** Open a drop-down and pick in it. */
async function choose(select: HTMLSelectElement | null, value: string): Promise<void> {
  if (!select) throw new Skip("the list is not on screen");
  if (select.value === value) return;
  await click(select);
  await sleep(rand(250, 400));
  setValue(select, value);
  select.dispatchEvent(new Event("input", { bubbles: true }));
  select.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(rand(150, 250));
}

/** Take a slider's thumb and drag it along to `value`, the value following the hand. */
async function slide(input: HTMLInputElement | null, value: number): Promise<void> {
  if (!input) throw new Skip("the slider is not on screen");
  const min = Number(input.min || 0);
  const max = Number(input.max || 100);
  const target = Math.round(Math.max(min, Math.min(max, value)));
  const from = Number(input.value);
  if (from === target) return;
  await into(input);
  const r = input.getBoundingClientRect();
  const vertical = r.height > r.width * 1.5;
  const at = (v: number): Point => {
    const f = (v - min) / (max - min || 1);
    return vertical ? { x: r.left + r.width / 2, y: r.bottom - f * r.height } : { x: r.left + f * r.width, y: r.top + r.height / 2 };
  };
  await pointerGo(at(from), true, input);
  input.dispatchEvent(ptr("pointerdown", at(from)));
  const frames = Math.max(6, Math.min(30, Math.abs(target - from)));
  for (let i = 1; i <= frames; i++) {
    const t = i / frames;
    const v = Math.round(from + (target - from) * (t < 0.5 ? 2 * t * t : 1 - (-2 * t + 2) ** 2 / 2));
    pointerPlace(at(v));
    setValue(input, String(v));
    input.dispatchEvent(new Event("input", { bubbles: true }));
    await sleep(22);
  }
  input.dispatchEvent(ptr("pointerup", at(target)));
  input.dispatchEvent(new Event("change", { bubbles: true }));
  await sleep(rand(150, 250));
}

// ------------------------------------------------------------- the window --

/** Run one step. `ids` maps the finished song's ids to the window's, for what the hand itself made. */
export async function runStudioHand(steps: StudioStep[], env: HandEnv): Promise<{ results: HandResult[]; ids: Record<string, string> }> {
  const { root } = env;
  const ids = new Map<string, string>();
  const id = (x: string) => ids.get(x) ?? x;
  const q = <T extends Element = HTMLElement>(sel: string) => root.querySelector<T>(sel);
  const qa = <T extends Element = HTMLElement>(sel: string) => Array.from(root.querySelectorAll<T>(sel));
  const live = env.live;
  const trackOf = (tid: string) => live().tracks.find((t) => t.id === id(tid)) ?? null;
  const clipOf = (cid: string) => {
    for (const t of live().tracks) { const c = t.clips.find((x) => x.id === id(cid)); if (c) return { track: t, clip: c }; }
    return null;
  };
  const row = (tid: string) => q(`.st-row[data-track="${id(tid)}"]`);
  const clipEl = (cid: string) => q(`.st-clip[data-clip="${id(cid)}"]`);
  let trayOpen: string | null = null;

  /** A tool of the bar by its name: on the bar, or in All tools. */
  const rail = async (label: string) => {
    const on = q(`.rail-bar button[aria-label="${label}"]`);
    if (on) return click(on);
    await click(q('.rail-bar button[aria-label="All tools"]'));
    const tile = await waitFor(() => Array.from(document.querySelectorAll<HTMLElement>(".rail-grid .rail-tile")).find((b) => b.textContent?.trim() === label));
    await click(tile ?? null);
  };
  const tray = async (label: "Song" | "Add track", has: () => Element | null) => {
    if (has()) return;
    await rail(label);
    trayOpen = label;
    if (!(await waitFor(has, 2000))) throw new Skip(`the ${label} options did not open`);
  };
  const mixer = async () => {
    if (q(".st-mixer")) return;
    await rail("Mixer");
    if (!(await waitFor(() => q(".st-mixer"), 2000))) throw new Skip("the Mixer did not open");
  };
  const newIn = (before: Set<string>, list: () => string[]) => list().find((x) => !before.has(x)) ?? null;
  const trackIds = () => live().tracks.map((t) => t.id);
  const clipIds = () => live().tracks.flatMap((t) => t.clips.map((c) => c.id));
  const laneGeom = (tid: string) => {
    const lane = row(tid)?.querySelector<HTMLElement>(".st-lane");
    if (!lane) throw new Skip("the track is not on screen");
    const bw = parseFloat(lane.style.getPropertyValue("--beat")) || 24;
    return { lane, bw };
  };
  /** The arrangement scrolled so beats `a`..`b` of a lane are in view. */
  const showBeats = async (lane: HTMLElement, bw: number, a: number, b: number) => {
    const sc = lane.closest<HTMLElement>(".st-arr-scroll");
    if (!sc) return;
    const view = sc.getBoundingClientRect();
    const r = lane.getBoundingClientRect();
    const x0 = r.left + a * bw;
    const x1 = r.left + b * bw;
    const head = r.left - (sc.getBoundingClientRect().left - sc.scrollLeft) - sc.scrollLeft;
    if (x0 < view.left + Math.max(0, head) + 8 || x1 > view.right - 8) {
      sc.scrollTo({ left: Math.max(0, sc.scrollLeft + x0 - (view.left + Math.max(0, head)) - 40), behavior: "smooth" });
      await sleep(400);
    }
    row(lane.closest<HTMLElement>(".st-row")?.dataset.track ?? "")?.scrollIntoView({ block: "nearest", behavior: "smooth" });
  };
  const pickClip = async (cid: string) => {
    const el = clipEl(cid);
    if (!el) throw new Skip("the clip is not on screen");
    const r = el.getBoundingClientRect();
    if (r.right < 0 || r.left > innerWidth) el.scrollIntoView({ inline: "nearest", block: "nearest", behavior: "smooth" });
    await sleep(200);
    const rr = el.getBoundingClientRect();
    const p = { x: rr.left + Math.min(rr.width * 0.4, 30), y: rr.top + rr.height / 2 };
    await pointerGo(p, true, el);
    el.dispatchEvent(ptr("pointerdown", p));
    el.dispatchEvent(ptr("pointerup", p));
    await sleep(rand(150, 250));
  };
  const editor = async () => {
    if (q(".st-mixer")) await rail("Mixer");
    if (!(await waitFor(() => q(".st-roll"), 800))) await rail("Piano roll");
    if (!(await waitFor(() => q(".st-roll"), 2000))) throw new Skip("the piano roll did not open");
  };
  const rollButton = (text: string) =>
    qa<HTMLButtonElement>(".st-roll-tools button").find((b) => b.textContent?.trim().replace(/\s+/g, " ") === text || b.textContent?.trim().endsWith(text)) ?? null;

  const one = async (s: StudioStep) => {
    switch (s.k) {
      case "name": {
        const input = q<HTMLInputElement>(".st-song-name");
        if (input?.value === s.name) return;
        await typeInto(input, s.name);
        input?.blur();
        return;
      }
      case "tempo": {
        await tray("Song", () => q('[aria-label="Tempo in beats per minute"]'));
        const input = q<HTMLInputElement>('[aria-label="Tempo in beats per minute"]');
        if (Number(input?.value) === Math.round(s.bpm)) return;
        await typeInto(input, String(Math.round(s.bpm)));
        return;
      }
      case "key": {
        await tray("Song", () => q('[aria-label="Key note"]'));
        await choose(q<HTMLSelectElement>('[aria-label="Key note"]'), String(s.root));
        await choose(q<HTMLSelectElement>('[aria-label="Scale"]'), s.scale);
        return;
      }
      case "bars": {
        await tray("Song", () => q('input[aria-label="Bars"]'));
        await typeInto(q<HTMLInputElement>('input[aria-label="Bars"]'), String(s.bars));
        return;
      }
      case "loop":
        if (live().loop !== s.on) await rail("Loop");
        return;
      case "master":
        await mixer();
        await slide(q<HTMLInputElement>('input[aria-label="Master volume"]'), s.v * 100);
        return;
      case "addTrack": {
        const name = instrumentOf(s.instrument as Parameters<typeof instrumentOf>[0]).name;
        await tray("Add track", () => q(".st-add-chip"));
        const before = new Set(trackIds());
        await click(qa<HTMLButtonElement>(".st-add-chip").find((b) => b.textContent?.trim() === name) ?? null);
        const made = await waitFor(() => newIn(before, trackIds), 2000);
        if (!made) throw new Skip("no track came");
        ids.set(s.track, made);
        trayOpen = null; // picking an instrument puts the tray away
        return;
      }
      case "renameTrack": {
        const t = trackOf(s.track);
        if (!t) throw new Skip("no such track");
        if (t.name === s.name) return;
        await click(row(s.track)?.querySelector(".st-name") ?? null, 2);
        const input = await waitFor(() => row(s.track)?.querySelector<HTMLInputElement>(".st-name-input"), 1500);
        await typeInto(input, s.name);
        if (input) enter(input);
        return;
      }
      case "flag": {
        const t = trackOf(s.track);
        if (!t || t[s.which] === s.on) return;
        const btn = Array.from(row(s.track)?.querySelectorAll<HTMLButtonElement>(".st-ms") ?? []).find((b) => b.textContent?.trim() === (s.which === "mute" ? "M" : "S"));
        await click(btn ?? null);
        return;
      }
      case "mix": {
        const t = trackOf(s.track);
        if (!t || Math.round(t[s.which] * 100) === Math.round(s.v * 100)) return;
        await mixer();
        const strip = q(`.st-strip[data-track="${id(s.track)}"]`);
        await slide(strip?.querySelector<HTMLInputElement>(`input[aria-label$=" ${s.which}"]`) ?? null, s.v * 100);
        return;
      }
      case "trackMenu": {
        const r = row(s.track);
        await click(r?.querySelector(".st-more") ?? null);
        const before = new Set(trackIds());
        const item = await waitFor(() => Array.from(r?.querySelectorAll<HTMLButtonElement>('.st-menu [role="menuitem"]') ?? []).find((b) => b.textContent?.trim() === s.item), 1500);
        await click(item ?? null);
        if (s.made) {
          const made = await waitFor(() => newIn(before, trackIds), 2000);
          if (made) ids.set(s.made, made);
        }
        return;
      }
      case "drawClip": {
        const t = trackOf(s.track);
        if (!t) throw new Skip("no such track");
        const bpb = live().beatsPerBar;
        const a = Math.floor(s.start / bpb) * bpb;
        const b = Math.max(a + bpb, Math.ceil((s.start + s.length) / bpb - 1e-6) * bpb);
        const { lane, bw } = laneGeom(s.track);
        await showBeats(lane, bw, a, b);
        const r = lane.getBoundingClientRect();
        const from = { x: r.left + a * bw + Math.min(6, bw * 0.3), y: r.top + r.height / 2 };
        const to = { x: r.left + b * bw - Math.min(6, bw * 0.3), y: from.y };
        if (document.elementFromPoint(from.x, from.y) !== lane) throw new Skip("something is already there");
        const before = new Set(clipIds());
        await drag(from, to, lane);
        const made = await waitFor(() => newIn(before, clipIds), 2000);
        if (!made) throw new Skip("no clip came");
        ids.set(s.clip, made);
        const c = clipOf(s.clip)!;
        if (Math.abs(c.clip.start - s.start) > 1e-6) await one({ k: "moveClip", clip: s.clip, start: s.start });
        if (Math.abs(c.clip.length - s.length) > 1e-6) await one({ k: "resizeClip", clip: s.clip, length: s.length });
        if (c.clip.name !== s.name) await one({ k: "renameClip", clip: s.clip, name: s.name });
        return;
      }
      case "moveClip": {
        const c = clipOf(s.clip);
        const el = clipEl(s.clip);
        if (!c || !el) throw new Skip("the clip is not on screen");
        const { lane, bw } = laneGeom(c.track.id);
        await showBeats(lane, bw, Math.min(c.clip.start, s.start), Math.max(c.clip.start, s.start) + 1);
        const r = el.getBoundingClientRect();
        const from = { x: r.left + Math.min(r.width * 0.35, 24), y: r.top + r.height / 2 };
        let y = from.y;
        if (s.track) {
          const to = row(s.track)?.querySelector(".st-lane")?.getBoundingClientRect();
          if (to) y = to.top + to.height / 2;
        }
        await drag(from, { x: from.x + (s.start - c.clip.start) * bw, y }, el);
        return;
      }
      case "resizeClip": {
        const c = clipOf(s.clip);
        const edge = clipEl(s.clip)?.querySelector<HTMLElement>(".st-clip-size");
        if (!c || !edge) throw new Skip("the clip is not on screen");
        const { lane, bw } = laneGeom(c.track.id);
        await showBeats(lane, bw, c.clip.start, Math.max(c.clip.start + c.clip.length, c.clip.start + s.length));
        const r = edge.getBoundingClientRect();
        const from = { x: r.left + r.width / 2, y: r.top + r.height / 2 };
        await drag(from, { x: from.x + (s.length - c.clip.length) * bw, y: from.y }, edge);
        return;
      }
      case "renameClip": {
        const c = clipOf(s.clip);
        if (!c || c.clip.name === s.name) return;
        await pickClip(s.clip);
        await editor();
        const input = q<HTMLInputElement>(".st-clip-name-input");
        await typeInto(input, s.name);
        input?.blur();
        return;
      }
      case "clipTool": {
        await pickClip(s.clip);
        const before = new Set(clipIds());
        if (s.tool === "Split" && s.at !== undefined) {
          const ruler = q(".st-ruler");
          const c = clipOf(s.clip);
          if (!ruler || !c) throw new Skip("the ruler is not on screen");
          const { bw } = laneGeom(c.track.id);
          const r = ruler.getBoundingClientRect();
          const p = { x: r.left + s.at * bw, y: r.top + r.height / 2 };
          await pointerGo(p, true, ruler);
          ruler.dispatchEvent(ptr("pointerdown", p));
          ruler.dispatchEvent(ptr("pointerup", p));
          await sleep(200);
        }
        await rail(s.tool);
        if (s.made) {
          const made = await waitFor(() => newIn(before, clipIds), 2000);
          if (made) ids.set(s.made, made);
        }
        return;
      }
      case "rollTool": {
        await pickClip(s.clip);
        await editor();
        if (s.snap) await choose(q<HTMLSelectElement>(".st-roll-tools select"), String(s.snap));
        await click(rollButton(s.tool));
        return;
      }
      case "notes": {
        await pickClip(s.clip);
        await editor();
        const snapSel = q<HTMLSelectElement>(".st-roll-tools select");
        if (snapSel && Number(snapSel.value) > s.snap) await choose(snapSel, String(s.snap));
        await sleep(150);
        if (s.drum) {
          const snap = Number(q<HTMLSelectElement>(".st-roll-tools select")?.value) || s.snap;
          const step = (pitch: number, start: number) => {
            const name = DRUMS.find((d) => d.pitch === pitch)?.name;
            return name ? q<HTMLButtonElement>(`.st-step[aria-label="${name}, step ${Math.round(start / snap) + 1}"]`) : null;
          };
          let missed = 0;
          for (const n of s.remove) { const b = step(n.pitch, n.start); if (b?.getAttribute("aria-pressed") === "true") await click(b); else if (!b) missed++; }
          for (const n of s.add) { const b = step(n.pitch, n.start); if (!b) missed++; else if (b.getAttribute("aria-pressed") !== "true") await click(b); }
          if (missed) throw new Skip(`${missed} of the hits had no step on screen`);
          return;
        }
        const scroller = q(".st-roll-scroll");
        const grid = q(".st-grid");
        const c = clipOf(s.clip);
        if (!scroller || !grid || !c) throw new Skip("the piano roll is not on screen");
        /** The grid point for a beat and pitch, scrolled into view. */
        const point = async (beat: number, pitch: number): Promise<Point | null> => {
          const key = q(`.st-keys button[aria-label="${pitchName(pitch)}"]`);
          if (!key) return null;
          const view = scroller.getBoundingClientRect();
          let kr = key.getBoundingClientRect();
          let gr = grid.getBoundingClientRect();
          const bw = gr.width / c.clip.length;
          let x = gr.left + beat * bw;
          if (kr.top < view.top + 4 || kr.bottom > view.bottom - 4 || x < view.left + 56 || x > view.right - 12) {
            scroller.scrollTo({
              top: scroller.scrollTop + (kr.top - view.top) - view.height / 2,
              left: Math.max(0, scroller.scrollLeft + (x - view.left) - view.width / 2),
              behavior: "smooth",
            });
            await sleep(380);
            kr = key.getBoundingClientRect();
            gr = grid.getBoundingClientRect();
            x = gr.left + beat * bw;
          }
          return { x, y: kr.top + kr.height / 2 };
        };
        const bwNow = () => grid.getBoundingClientRect().width / c.clip.length;
        let missed = 0;
        for (const n of s.remove) {
          const p = await point(n.start, n.pitch);
          if (!p) { missed++; continue; }
          const at = { x: p.x + Math.min(4, bwNow() * 0.1), y: p.y };
          const note = document.elementFromPoint(at.x, at.y)?.closest("[data-note]");
          if (!note) { missed++; continue; }
          await pointerGo(at, true, note);
          note.dispatchEvent(ptr("pointerdown", at));
          grid.dispatchEvent(ptr("pointerup", at));
          await sleep(150);
          await click(rollButton("Delete"));
        }
        for (const n of s.add) {
          const p = await point(n.start, n.pitch);
          if (!p) { missed++; continue; }
          const bw = bwNow();
          const from = { x: p.x + Math.min(3, bw * 0.08), y: p.y };
          const to = { x: p.x + n.length * bw - Math.min(3, bw * 0.08), y: p.y };
          if (document.elementFromPoint(from.x, from.y)?.closest("[data-note]")) { missed++; continue; }
          await drag(from, to, grid);
        }
        if (missed) throw new Skip(`${missed} of the notes were not on the roll`);
        return;
      }
    }
  };

  const results: HandResult[] = [];
  try {
    for (let i = 0; i < steps.length; i++) {
      try {
        await one(steps[i]!);
        results.push({ i, ok: true });
      } catch (err) {
        results.push({ i, ok: false, error: err instanceof Error ? err.message : String(err) });
      }
    }
    // Put away what the hand opened, as a person closes a tray when done with it.
    if (trayOpen) await click(q('.rail-tray button[aria-label="Close options"]')).catch(() => undefined);
  } finally {
    await env.saveNow().catch(() => undefined);
    pointerRest();
  }
  // What the hand made has the window's ids: the finished song takes them, so nothing open in the window changes under it.
  return { results, ids: Object.fromEntries(ids) };
}
