import { EditorCore } from "@/core";
import { processMediaAssets } from "@/media/processing";
import { buildElementFromMedia, buildTextElement } from "@/timeline/element-utils";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";
import { deliver, onCommand } from "./bridge";
import { openProject } from "./shims/navigation";

/**
 * What the agent can do to the open project, written against OpenCut's own
 * editor API (EditorCore) rather than its stored data: every change goes
 * through the same commands a click does, so it is validated the same way,
 * shows on the timeline as it happens and can be undone with Ctrl+Z.
 *
 * Times are seconds on the way in and out; the editor counts ticks.
 */

const sec = (s: number) => mediaTimeFromSeconds({ seconds: s });
const toSec = (t: number) => Math.round(mediaTimeToSeconds({ time: t as never }) * 1000) / 1000;

function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v ? v : undefined;
}
function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} is required`);
  return v;
}

function allTracks(tracks: SceneTracks) {
  return [...tracks.overlay, tracks.main, ...tracks.audio];
}

function findElement(editor: EditorCore, elementId: string) {
  const tracks = editor.scenes.getActiveScene().tracks;
  for (const track of allTracks(tracks)) {
    const element = (track.elements as TimelineElement[]).find((e) => e.id === elementId);
    if (element) return { track, element };
  }
  throw new Error(`No clip with id ${elementId}. Ask for the project state to see the ids.`);
}

function describe(element: TimelineElement) {
  const base = {
    id: element.id,
    type: element.type,
    name: element.name,
    start: toSec(element.startTime),
    duration: toSec(element.duration),
    trimStart: toSec(element.trimStart),
    trimEnd: toSec(element.trimEnd),
  };
  const extra: Record<string, unknown> = {};
  if ("mediaId" in element) extra.mediaId = element.mediaId;
  if (element.type === "text") extra.text = element.params.content;
  return { ...base, ...extra };
}

function state(editor: EditorCore) {
  const project = editor.project.getActive();
  const scene = editor.scenes.getActiveScene();
  const tracks = allTracks(scene.tracks).map((track) => ({
    id: track.id,
    type: track.type,
    name: track.name,
    clips: (track.elements as TimelineElement[]).map(describe),
  }));
  return {
    project: { id: project.metadata.id, name: project.metadata.name },
    canvas: project.settings.canvasSize,
    fps: project.settings.fps,
    duration: toSec(editor.timeline.getTotalDuration()),
    playhead: toSec(editor.playback.getCurrentTime()),
    playing: editor.playback.getIsPlaying(),
    tracks,
    media: editor.media.getAssets().map((a) => ({
      id: a.id,
      name: a.name,
      type: a.type,
      duration: a.duration ?? null,
      width: a.width ?? null,
      height: a.height ?? null,
    })),
  };
}

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

    case "locate": {
      // Where the playhead is on screen, after moving it to `time`: the agent's cursor goes there.
      const time = num(args, "time");
      if (time !== undefined) editor.playback.seek({ time: sec(Math.max(0, time)) });
      await new Promise<void>((r) => requestAnimationFrame(() => requestAnimationFrame(() => r())));
      const head = document.querySelector('[aria-label="Timeline playhead"]');
      if (!head) return null;
      const r = head.getBoundingClientRect();
      const view = { w: window.innerWidth, h: window.innerHeight };
      return { x: Math.min(view.w - 12, Math.max(12, r.left + 1)), y: Math.min(view.h - 12, r.top + Math.min(r.height / 2, 70)), view };
    }

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

    default:
      throw new Error(`Unknown video command: ${name}`);
  }
}

export function installCommands(): void {
  onCommand(run);
}
