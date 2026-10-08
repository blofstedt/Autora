import type { EditorCore } from "@/core";
import type { SceneTracks, TimelineElement } from "@/timeline";
import { mediaTimeFromSeconds, mediaTimeToSeconds } from "@/wasm";

/** Shared by the typed commands: seconds in and out, argument checks, and the project as the agent reads it. */

export const sec = (s: number) => mediaTimeFromSeconds({ seconds: s });
export const toSec = (t: number) => Math.round(mediaTimeToSeconds({ time: t as never }) * 1000) / 1000;

export function num(args: Record<string, unknown>, key: string): number | undefined {
  const v = args[key];
  return typeof v === "number" && Number.isFinite(v) ? v : undefined;
}
export function str(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  return typeof v === "string" && v ? v : undefined;
}
export function need<T>(v: T | undefined, what: string): T {
  if (v === undefined) throw new Error(`${what} is required`);
  return v;
}

export function allTracks(tracks: SceneTracks) {
  return [...tracks.overlay, tracks.main, ...tracks.audio];
}

export function findElement(editor: EditorCore, elementId: string) {
  const tracks = editor.scenes.getActiveScene().tracks;
  for (const track of allTracks(tracks)) {
    const element = (track.elements as TimelineElement[]).find((e) => e.id === elementId);
    if (element) return { track, element };
  }
  throw new Error(`No clip with id ${elementId}. Ask for the project state to see the ids.`);
}

export function describe(element: TimelineElement) {
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
  if ("effects" in element && element.effects?.length) extra.effects = element.effects.map((e) => ({ id: e.id, type: e.type, enabled: e.enabled }));
  if ("masks" in element && element.masks?.length) extra.mask = { id: element.masks[0].id, type: element.masks[0].type };
  if (element.animations) {
    const keyed = Object.entries(element.animations as Record<string, { keys?: Array<{ id: string; time: number }> } | undefined>)
      .filter(([, channel]) => channel?.keys?.length)
      .map(([property, channel]) => ({ property, keys: (channel?.keys ?? []).map((k) => ({ id: k.id, at: toSec(k.time) })) }));
    if (keyed.length) extra.keyframes = keyed;
  }
  if ("retime" in element && element.retime) extra.speed = element.retime.rate;
  if ("hidden" in element && element.hidden) extra.hidden = true;
  return { ...base, ...extra };
}

export function state(editor: EditorCore) {
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

