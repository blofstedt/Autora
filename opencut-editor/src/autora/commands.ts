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

export function installCommands(): void {
  onCommand(run);
}
