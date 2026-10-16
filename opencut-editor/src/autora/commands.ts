import { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia, buildTextElement } from "@/timeline/element-utils";
import type { TimelineElement } from "@/timeline";
import { allTracks, describe, findElement, need, num, sec, state, str, toSec } from "./helpers";
import { deliver, onCommand } from "./bridge";
import { feature } from "./features";
import * as screen from "./ui";
import { openProject } from "./shims/navigation";

/**
 * What the agent can do to the open project, written against OpenCut's own
 * editor API (EditorCore) rather than its stored data: every change goes
 * through the same commands a click does, so it is validated the same way,
 * shows on the timeline as it happens and can be undone with Ctrl+Z.
 *
 * Times are seconds on the way in and out; the editor counts ticks.
 */

/** Seconds to leave a clip on screen when its source has no length of its own (a picture). */
const STILL_SECONDS = 5;

/** A project is loading (opening one, or the editor just starting): give it a moment before saying there is none. */
async function projectOpen(editor: EditorCore): Promise<boolean> {
  for (let waited = 0; waited < 20_000; waited += 100) {
    if (editor.project.getActiveOrNull() && !editor.project.getIsLoading()) return true;
    await new Promise<void>((r) => setTimeout(r, 100));
  }
  return false;
}

async function run(name: string, args: Record<string, unknown>): Promise<unknown> {
  const editor = EditorCore.getInstance();
  if (name !== "new_project" && name !== "open_project" && !(await projectOpen(editor))) {
    throw new Error("No project is open in the editor yet");
  }

  switch (name) {
    case "state":
      return state(editor);

    case "import_media": {
      const blob = args.file;
      if (!(blob instanceof Blob)) throw new Error("file is required");
      const file = new File([blob], need(str(args, "name"), "name"), { type: str(args, "mime") ?? blob.type });
      const processed = await processMediaAssets({ files: [file] });
      const projectId = editor.project.getActive().metadata.id;
      const added = [];
      for (const asset of processed) {
        const saved = await editor.media.addMediaAsset({ projectId, asset });
        if (saved) added.push({ id: saved.id, name: saved.name, type: saved.type, duration: saved.duration ?? null });
      }
      if (!added.length) throw new Error("The editor could not import that file (unsupported type or no room left)");
      return added[0];
    }

    case "add_clip": {
      const mediaId = need(str(args, "mediaId"), "mediaId");
      const asset = editor.media.getAssets().find((a) => a.id === mediaId);
      if (!asset) throw new Error(`No media with id ${mediaId}. Import it first.`);
      const start = num(args, "start") ?? toSec(editor.timeline.getTotalDuration());
      const duration = num(args, "duration") ?? asset.duration ?? STILL_SECONDS;
      const element = buildElementFromMedia({
        mediaId: asset.id,
        mediaType: asset.type,
        name: asset.name,
        duration: sec(duration),
        startTime: sec(start),
      });
      editor.timeline.insertElement({ element, placement: { mode: "auto" } });
      return state(editor);
    }

    case "add_text": {
      const startSeconds = num(args, "start") ?? toSec(editor.playback.getCurrentTime());
      const duration = num(args, "duration") ?? 3;
      const params: Record<string, string | number | boolean> = { content: need(str(args, "text"), "text") };
      for (const key of ["color", "fontFamily", "fontSize", "fontWeight", "textAlign"]) {
        const v = args[key];
        if (typeof v === "string" || typeof v === "number") params[key] = v;
      }
      /* The editor's font size is not points or pixels: 90 is the whole height of the picture, so the default of 15
         is a sixth of it. A "72" (as a title is often sized) fills the frame many times over, and the frame then
         shows a few clipped letters. Said here, with what to use, rather than made. */
      const size = params.fontSize;
      if (size !== undefined && (typeof size !== "number" || !(size > 0) || size > 45)) {
        throw new Error(`fontSize ${JSON.stringify(size)} is in editor units, not points or pixels: 90 is the whole height of the picture and the default 15 is a sixth of it. Use 4 to 30 (a large title is 20); it would not fit the frame.`);
      }
      const element = buildTextElement({ raw: { name: "Text", duration: sec(duration), params }, startTime: sec(startSeconds) });
      editor.timeline.insertElement({ element, placement: { mode: "auto", trackType: "text" } });
      return state(editor);
    }

    case "split": {
      const { track, element } = findElement(editor, need(str(args, "elementId"), "elementId"));
      const at = need(num(args, "time"), "time");
      if (at <= toSec(element.startTime) || at >= toSec(element.startTime) + toSec(element.duration)) {
        throw new Error("time is outside that clip");
      }
      editor.timeline.splitElements({ elements: [{ trackId: track.id, elementId: element.id }], splitTime: sec(at) });
      return state(editor);
    }

    case "trim": {
      // `from` and `to` are positions in the source: what to keep of it.
      const { element } = findElement(editor, need(str(args, "elementId"), "elementId"));
      const source = element.sourceDuration !== undefined ? toSec(element.sourceDuration) : toSec(element.trimStart) + toSec(element.duration) + toSec(element.trimEnd);
      const from = Math.max(0, num(args, "from") ?? toSec(element.trimStart));
      const to = Math.min(source, num(args, "to") ?? source - toSec(element.trimEnd));
      if (to <= from) throw new Error("to must be after from");
      editor.timeline.updateElementTrim({
        elementId: element.id,
        trimStart: sec(from),
        trimEnd: sec(Math.max(0, source - to)),
        duration: sec(to - from),
      });
      return state(editor);
    }

    case "move": {
      const { track, element } = findElement(editor, need(str(args, "elementId"), "elementId"));
      const start = need(num(args, "start"), "start");
      const target = str(args, "trackId") ?? track.id;
      editor.timeline.moveElements({ moves: [{ sourceTrackId: track.id, targetTrackId: target, elementId: element.id, newStartTime: sec(Math.max(0, start)) }] });
      return state(editor);
    }

    case "delete": {
      const ids = Array.isArray(args.elementIds) ? args.elementIds.filter((v): v is string => typeof v === "string") : [];
      if (!ids.length) throw new Error("elementIds is required");
      const elements = ids.map((id) => {
        const { track, element } = findElement(editor, id);
        return { trackId: track.id, elementId: element.id };
      });
      editor.timeline.deleteElements({ elements });
      return state(editor);
    }

    case "set_params": {
      const { track, element } = findElement(editor, need(str(args, "elementId"), "elementId"));
      const params = args.params;
      if (!params || typeof params !== "object") throw new Error("params is required");
      editor.timeline.updateElements({
        updates: [{ trackId: track.id, elementId: element.id, patch: { params: { ...element.params, ...(params as Record<string, never>) } } }],
        // `history: false` is a title being typed: the letters before the last are not steps to undo.
        pushHistory: args.history !== false,
      });
      return state(editor);
    }

    case "locate":
      return locate(editor, args);

    case "hand_point":
      return handPoint(editor, args);

    case "hand_tap":
      return handTap(args);

    case "seek":
      editor.playback.seek({ time: sec(Math.max(0, need(num(args, "time"), "time"))) });
      return { playhead: toSec(editor.playback.getCurrentTime()) };

    case "play":
      editor.playback.play();
      return { playing: true };

    case "pause":
      editor.playback.pause();
      return { playing: false };

    case "undo":
      editor.command.undo();
      return state(editor);

    case "redo":
      editor.command.redo();
      return state(editor);

    case "rename": {
      const project = editor.project.getActive();
      await editor.project.renameProject({ id: project.metadata.id, name: need(str(args, "name"), "name") });
      return state(editor);
    }

    case "new_project": {
      const id = await editor.project.createNewProject({ name: str(args, "name") ?? "Untitled project" });
      openProject(id);
      return { projectId: id };
    }

    case "open_project":
      openProject(need(str(args, "projectId"), "projectId"));
      return { projectId: args.projectId };

    case "save":
      // The window's Save: the project written now, not when the editor next gets round to it.
      await editor.project.saveCurrentProject();
      return state(editor);

    case "export": {
      const format = args.format === "webm" ? "webm" : "mp4";
      const quality = args.quality === "low" || args.quality === "medium" || args.quality === "very_high" ? args.quality : "high";
      await editor.project.saveCurrentProject();
      const result = await editor.project.export({ options: { format, quality, includeAudio: args.audio !== false } });
      editor.project.clearExportState();
      if (!result.success || !result.buffer) throw new Error(result.error ?? "The export did not finish");
      const project = editor.project.getActive();
      const file = `${project.metadata.name.replace(/[^\w.-]+/g, "_") || "video"}.${format}`;
      const kept = await deliver(file, format === "webm" ? "video/webm" : "video/mp4", result.buffer);
      return { file, artifact: kept.artifact, bytes: result.buffer.byteLength };
    }

    default: {
      const done = name.startsWith("ui_") ? await ui(name, args) : await feature(name, args);
      if (done === undefined) throw new Error(`Unknown video command: ${name}`);
      return done;
    }
  }
}

const toTarget = (args: Record<string, unknown>): screen.Target => ({
  ref: num(args, "ref"),
  label: str(args, "label"),
  elementId: str(args, "elementId"),
  trackId: str(args, "trackId"),
  selector: str(args, "selector"),
});
const wait = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The screen driver (ui.ts): read, point, click, type, press, drag, scroll. */
async function ui(name: string, args: Record<string, unknown>): Promise<unknown> {
  switch (name) {
    case "ui_read":
      return { ...screen.read(), messages: screen.messages() };
    case "ui_click": {
      const el = screen.find(toTarget(args));
      await screen.click(el, { double: args.double === true, right: args.right === true });
      await wait(150);
      return { clicked: true, messages: screen.messages(), ...screen.read() };
    }
    case "ui_type": {
      const el = screen.find(toTarget(args));
      const typed = screen.type(el, need(str(args, "text") ?? (typeof args.text === "string" ? args.text : undefined), "text"), args.replace !== false);
      if (args.enter === true) screen.commit(el, "enter");
      if (args.blur === true) screen.commit(el, "blur");
      return typed;
    }
    case "ui_commit":
      screen.commit(screen.find(toTarget(args)), args.how === "blur" ? "blur" : "enter");
      return { ok: true };
    case "ui_press": {
      const target = args.ref !== undefined || args.label || args.selector ? screen.find(toTarget(args)) : undefined;
      screen.press(need(str(args, "key"), "key"), { ctrl: args.ctrl === true, shift: args.shift === true, alt: args.alt === true, meta: args.meta === true }, target);
      await wait(120);
      return { messages: screen.messages() };
    }
    case "ui_drag": {
      const from = args.from as { x: number; y: number } | undefined;
      const to = args.to as { x: number; y: number } | undefined;
      if (!from || !to) throw new Error("from and to ({x, y} in the frame's pixels) are required");
      await screen.drag(from, to, { steps: num(args, "steps") });
      await wait(150);
      return state(EditorCore.getInstance());
    }
    case "ui_scroll":
      screen.scroll(args.ref !== undefined || args.label || args.selector ? screen.find(toTarget(args)) : null, num(args, "dx") ?? 0, num(args, "dy") ?? 0);
      return { ok: true };
    default:
      return undefined;
  }
}

/** Where on the screen a command is about, for the agent's cursor to go to first. */
async function locate(editor: EditorCore, args: Record<string, unknown>): Promise<unknown> {
  const view = { w: window.innerWidth, h: window.innerHeight };
  const frame = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
  try {
    if (args.target && typeof args.target === "object") {
      return screen.spot(screen.find(args.target as screen.Target));
    }
    const elementId = str(args, "elementId");
    if (elementId) {
      const { element } = findElement(editor, elementId);
      // Bring the clip into view the way a person would: put the playhead on it.
      editor.playback.seek({ time: element.startTime });
      await frame();
      return screen.spot(screen.find({ elementId }));
    }
    const trackId = str(args, "trackId");
    if (trackId) return screen.spot(screen.find({ trackId }));
    const panel = str(args, "panel");
    if (panel) {
      const label = ({ media: "Media", sounds: "Sounds", text: "Text", stickers: "Stickers", effects: "Effects", transitions: "Transitions", captions: "Captions", adjustment: "Adjustment", settings: "Settings" } as Record<string, string>)[panel];
      if (label) return screen.spot(screen.find({ label }));
    }
    const time = num(args, "time");
    if (time !== undefined) editor.playback.seek({ time: sec(Math.max(0, time)) });
    await frame();
    const head = document.querySelector('[aria-label="Timeline playhead"]');
    if (!head) return null;
    const r = head.getBoundingClientRect();
    return { x: Math.min(view.w - 12, Math.max(12, r.left + 1)), y: Math.min(view.h - 12, r.top + Math.min(r.height / 2, 70)), w: 2, h: r.height, view };
  } catch {
    return null;
  }
}

// ---------------------------------------------------------------- the hand --

/**
 * Where the agent's hand presses for a step done as a person does it (Visible work; components/OpenCutWindow.tsx plans the
 * steps and moves the cursor, this says where things are on the screen and presses there): a time on the ruler, a clip's
 * body or one of its edges, a track's row, a media or text tile's "+". Out of view, it is scrolled into view first, as a
 * person scrolls. Null when it is not on the screen at all.
 */
type HandSpot = { x: number; y: number; view: { w: number; h: number }; pps?: number; start?: number; duration?: number };

const view = () => ({ w: window.innerWidth, h: window.innerHeight });
const frames = () => new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));

/** How many pixels a second is on the timeline now: from a clip on it, else from the ruler. */
function pixelsPerSecond(editor: EditorCore): number | null {
  for (const track of allTracks(editor.scenes.getActiveScene().tracks)) {
    for (const element of track.elements as TimelineElement[]) {
      const el = document.querySelector(`[data-element-id="${CSS.escape(element.id)}"]`);
      const d = toSec(element.duration);
      if (el && d > 0) return el.getBoundingClientRect().width / d;
    }
  }
  const ruler = document.querySelector('[aria-label="Timeline ruler"]');
  const inner = ruler?.firstElementChild as HTMLElement | null;
  const max = Number(ruler?.getAttribute("aria-valuemax"));
  return inner && max > 0 ? inner.getBoundingClientRect().width / max : null;
}

/** The timeline's own scrolling box, which the ruler follows. */
function timelineScroller(): HTMLElement | null {
  const root = document.querySelector('[aria-label="Timeline"]');
  if (!root) return null;
  for (const el of root.querySelectorAll<HTMLElement>("*")) {
    const s = getComputedStyle(el);
    if ((s.overflowX === "auto" || s.overflowX === "scroll") && el.scrollWidth > el.clientWidth + 4) return el;
  }
  return null;
}

/** Bring x (on the timeline) into the visible part of it, the way a person scrolls the timeline. */
async function intoTimelineView(x: number): Promise<number> {
  const scroller = timelineScroller();
  if (!scroller) return 0;
  const r = scroller.getBoundingClientRect();
  if (x >= r.left + 24 && x <= r.right - 24) return 0;
  const by = x - (r.left + r.width / 2);
  scroller.scrollBy({ left: by, behavior: "smooth" });
  await new Promise<void>((done) => setTimeout(done, 380));
  await frames();
  return by;
}

async function handPoint(editor: EditorCore, args: Record<string, unknown>): Promise<HandSpot | null> {
  const kind = str(args, "kind");
  if (kind === "time") {
    const ruler = document.querySelector('[aria-label="Timeline ruler"]');
    const inner = ruler?.firstElementChild as HTMLElement | null;
    const pps = pixelsPerSecond(editor);
    const time = Math.max(0, num(args, "time") ?? 0);
    if (!ruler || !inner || !pps) return null;
    let x = inner.getBoundingClientRect().left + time * pps;
    const moved = await intoTimelineView(x);
    if (moved) x = inner.getBoundingClientRect().left + time * pps;
    const r = ruler.getBoundingClientRect();
    return { x, y: r.top + r.height / 2, view: view(), pps };
  }
  if (kind === "clip") {
    const id = need(str(args, "elementId"), "elementId");
    const { element } = findElement(editor, id);
    let el = document.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(id)}"]`);
    if (!el) return null;
    let r = el.getBoundingClientRect();
    const part = str(args, "part") ?? "body";
    const edgeX = part === "left" ? r.left : part === "right" ? r.right : r.left + Math.min(r.width * 0.35, 40);
    if (await intoTimelineView(edgeX)) {
      el = document.querySelector<HTMLElement>(`[data-element-id="${CSS.escape(id)}"]`);
      if (!el) return null;
      r = el.getBoundingClientRect();
    }
    el.scrollIntoView({ block: "nearest", inline: "nearest" });
    r = el.getBoundingClientRect();
    const duration = toSec(element.duration);
    const base = { view: view(), pps: duration > 0 ? r.width / duration : undefined, start: toSec(element.startTime), duration };
    if (part === "left" || part === "right") {
      const handle = el.querySelector<HTMLElement>(`[aria-label="${part === "left" ? "Left" : "Right"} resize handle"]`);
      if (!handle) return null;
      const h = handle.getBoundingClientRect();
      return { ...base, x: h.left + h.width / 2, y: h.top + h.height / 2 };
    }
    return { ...base, x: r.left + Math.min(r.width * 0.35, 40), y: r.top + r.height / 2 };
  }
  if (kind === "track") {
    const row = document.querySelector<HTMLElement>(`[data-track-id="${CSS.escape(need(str(args, "trackId"), "trackId"))}"]`);
    if (!row) return null;
    row.scrollIntoView({ block: "nearest" });
    const r = row.getBoundingClientRect();
    return { x: r.left + r.width / 2, y: r.top + r.height / 2, view: view() };
  }
  if (kind === "tile") {
    // A media or text tile in the panel on the left: its "+", which adds it at the playhead.
    const name = need(str(args, "name"), "name");
    // Its name: a label's title, the screen reader's words, or (a text tile) the words drawn in it.
    const label = [...document.querySelectorAll<HTMLElement>("span[title], .sr-only, span")]
      .find((s) => (s.getAttribute("title") ?? s.textContent ?? "").trim() === name && s.closest(".group"));
    const tile = label?.closest<HTMLElement>(".group");
    const plus = tile?.querySelector<HTMLElement>("button:has(svg.lucide-plus), button[title*='timeline' i]") ?? tile?.querySelector<HTMLElement>("button");
    if (!tile || !plus) return null;
    tile.scrollIntoView({ block: "nearest" });
    // A person's pointer over the tile is what shows its "+".
    const t = tile.getBoundingClientRect();
    tile.dispatchEvent(new PointerEvent("pointerover", { bubbles: true, clientX: t.left + t.width / 2, clientY: t.top + t.height / 2 }));
    const p = plus.getBoundingClientRect();
    return { x: p.left + p.width / 2, y: p.top + p.height / 2, view: view() };
  }
  return null;
}

/** A press at a point, with the events a mouse makes, on whatever is drawn there. */
async function handTap(args: Record<string, unknown>): Promise<{ hit: string }> {
  const at = { x: need(num(args, "x"), "x"), y: need(num(args, "y"), "y") };
  const hit = document.elementFromPoint(at.x, at.y);
  if (!hit) throw new Error("Nothing is there on the screen");
  const shift = args.shift === true;
  const init = (type: string): PointerEventInit => ({
    bubbles: true, cancelable: true, composed: true, view: window, clientX: at.x, clientY: at.y, button: 0,
    buttons: type.endsWith("down") ? 1 : 0, shiftKey: shift, pointerId: 1, pointerType: "mouse", isPrimary: true,
  });
  for (const type of ["pointerover", "pointermove", "mousemove", "pointerdown", "mousedown"]) {
    hit.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, init(type)) : new MouseEvent(type, init(type)));
  }
  await new Promise<void>((r) => setTimeout(r, 60));
  for (const type of ["pointerup", "mouseup", "click"]) {
    hit.dispatchEvent(type.startsWith("pointer") ? new PointerEvent(type, init(type)) : new MouseEvent(type, init(type)));
  }
  // The ruler and the clips listen for the mouse coming up anywhere, as a person's would.
  window.dispatchEvent(new MouseEvent("mouseup", init("mouseup")));
  await frames();
  return { hit: (hit as HTMLElement).getAttribute?.("aria-label") ?? hit.tagName.toLowerCase() };
}

export function installCommands(): void {
  onCommand(run);
}
