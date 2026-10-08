import { EditorCore } from "@/core";
import { ACTIONS } from "@/actions/definitions";
import { invokeAction } from "@/actions/registry";
import { buildDefaultEffectInstance, effectsRegistry } from "@/effects";
import { floatToFrameRate, frameRateToFloat } from "@/fps/utils";
import { buildDefaultMaskInstance, masksRegistry } from "@/masks";
import { graphicsRegistry, registerDefaultGraphics } from "@/graphics";
import { stickersRegistry } from "@/stickers/registry";
import { registerDefaultStickerProviders } from "@/stickers/providers";
import { TAB_KEYS, useAssetsPanelStore } from "@/components/editor/panels/assets/assets-panel-store";
import { getBuiltInElementParams } from "@/params/registry";
import type { ParamDefinition, ParamValue } from "@/params";
import { buildConstantRetime } from "@/retime";
import { insertCaptionChunksAsTextTrack } from "@/subtitles/insert";
import { parseSubtitleFile } from "@/subtitles/parse";
import { CanvasRenderer } from "@/services/renderer/canvas-renderer";
import { buildScene } from "@/services/renderer/scene-builder";
import { buildEffectElement, buildGraphicElement, buildStickerElement } from "@/timeline/element-utils";
import type { ElementType, MaskableElement, TimelineElement } from "@/timeline";
import { findElement, need, num, sec, state, str, toSec } from "./helpers";

/**
 * Every other thing the editor can do, written against its own API.
 *
 * `commands.ts` has the everyday cut. This is the rest: sticker, shape and
 * effect layers, subtitles, effects on a clip, masks, keyframes, speed, tracks,
 * scenes, bookmarks, the project's own settings, the editor's keyboard actions,
 * the panels, a picture of a frame, and the catalogs that say what there is to
 * choose from. Each goes through the editor's command history, like a click.
 * What cannot be reached by any of these is reached by the screen driver (ui.ts).
 *
 * Elements are named by id (video_look); times are seconds.
 */

const refOf = (editor: EditorCore, args: Record<string, unknown>) => {
  const { track, element } = findElement(editor, need(str(args, "elementId"), "elementId"));
  // What the person would do first: pick it, so its properties are what the editor shows.
  editor.selection.setSelectedElements({ elements: [{ trackId: track.id, elementId: element.id }] });
  return { track, element, trackId: track.id, elementId: element.id };
};

function params(args: Record<string, unknown>, key = "params"): Record<string, ParamValue> {
  const v = args[key];
  if (!v || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, ParamValue> = {};
  for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
    if (typeof val === "number" || typeof val === "string" || typeof val === "boolean") out[k] = val;
  }
  return out;
}

const defs = (list: readonly ParamDefinition[]) =>
  list.map((p) => ({
    key: p.key,
    label: p.label,
    type: p.type,
    default: p.default,
    ...(p.type === "number" ? { min: p.min, max: p.max, step: p.step } : {}),
    ...(p.type === "select" ? { options: p.options.map((o) => o.value) } : {}),
  }));

function ensureRegistries(): void {
  registerDefaultGraphics();
  registerDefaultStickerProviders();
}

/** What there is to choose from, so the agent does not guess at names. */
async function catalog(editor: EditorCore, topic: string, query: string): Promise<unknown> {
  ensureRegistries();
  switch (topic) {
    case "effects":
      return effectsRegistry.getAll().map((e) => ({ type: e.type, name: e.name, keywords: e.keywords, params: defs(e.params) }));
    case "masks":
      return masksRegistry.getAll().map((m) => ({ type: m.type, name: m.name, params: defs(m.params) }));
    case "graphics":
      return graphicsRegistry.getAll().map((g) => ({ id: g.id, name: g.name, params: defs(g.params) }));
    case "stickers": {
      const providers = stickersRegistry.getAll();
      if (!query) return { providers: providers.map((p) => p.id), note: "Pass a query to search a provider's stickers, e.g. 'sweden' for flags." };
      const found: unknown[] = [];
      for (const p of providers) {
        const result = await p.search({ query, options: { limit: 12 } }).catch(() => null);
        for (const item of result?.items ?? []) found.push({ stickerId: item.id, provider: item.provider, name: item.name });
      }
      return found.slice(0, 40);
    }
    case "elements": {
      const out: Record<string, unknown> = {};
      for (const type of ["video", "image", "audio", "text", "sticker", "graphic", "effect"] as ElementType[]) {
        out[type] = defs(getBuiltInElementParams({ type }));
      }
      return out;
    }
    case "properties": {
      const { element } = findElement(editor, query);
      return { type: element.type, current: element.params, definitions: defs(getBuiltInElementParams({ type: element.type })) };
    }
    case "settings": {
      const p = editor.project.getActive();
      return { fps: frameRateToFloat(p.settings.fps), canvas: p.settings.canvasSize, background: p.settings.background, fpsChoices: [24, 25, 30, 48, 50, 60, 120], tip: "canvas presets: 1920x1080 (16:9), 1080x1920 (9:16), 1080x1080 (1:1), 3840x2160 (4K)" };
    }
    case "actions":
      return Object.entries(ACTIONS).map(([name, a]) => ({ name, what: a.description, args: "args" in a ? a.args : undefined }));
    case "panels":
      return { assetsTabs: [...TAB_KEYS], note: "video_project panel opens one; video_ui reads what is in it." };
    case "keyframes":
      return { properties: ["transform.positionX", "transform.positionY", "transform.scaleX", "transform.scaleY", "transform.rotate", "opacity", "volume", "color", "background.color"], interpolation: ["linear", "hold", "bezier"], note: "video_style keyframe_set: property (or effectId + param for an effect's parameter), at (seconds from the clip's start), value." };
    case "retime":
      return { rate: { min: 0.01, max: 5 }, note: "video_style retime: rate 0.5 is half speed, 2 is double; maintainPitch keeps voices natural." };
    default:
      throw new Error("topic is one of: effects, masks, graphics, stickers, elements, properties, settings, actions, panels, keyframes, retime");
  }
}

/** A picture of the project at a moment, as the renderer draws it (not a screenshot of the window). */
async function capture(editor: EditorCore, time: number, maxWidth: number): Promise<{ png: string; width: number; height: number; time: number }> {
  const project = editor.project.getActive();
  const { canvasSize, background, fps } = project.settings;
  const scene = buildScene({
    tracks: editor.scenes.getActiveScene().tracks,
    mediaAssets: editor.media.getAssets(),
    duration: editor.timeline.getTotalDuration() || 1,
    canvasSize,
    background,
  });
  const renderer = new CanvasRenderer({ width: canvasSize.width, height: canvasSize.height, fps });
  const full = document.createElement("canvas");
  full.width = canvasSize.width;
  full.height = canvasSize.height;
  await renderer.renderToCanvas({ node: scene, time: sec(Math.max(0, time)), targetCanvas: full });
  const scale = Math.min(1, maxWidth / full.width);
  const small = document.createElement("canvas");
  small.width = Math.max(1, Math.round(full.width * scale));
  small.height = Math.max(1, Math.round(full.height * scale));
  small.getContext("2d")?.drawImage(full, 0, 0, small.width, small.height);
  return { png: small.toDataURL("image/png").split(",")[1] ?? "", width: small.width, height: small.height, time };
}

const maskOf = (element: TimelineElement) => ("masks" in element ? element.masks?.[0] : undefined);

/** A command by name; `undefined` when this file does not know it. */
export async function feature(name: string, args: Record<string, unknown>): Promise<unknown | undefined> {
  const editor = EditorCore.getInstance();
  ensureRegistries();

  switch (name) {
    // ------------------------------------------------------- more clips --
    case "add_sticker": {
      const start = num(args, "start") ?? toSec(editor.playback.getCurrentTime());
      const element = buildStickerElement({ stickerId: need(str(args, "stickerId"), "stickerId"), startTime: sec(start) });
      if (num(args, "duration")) element.duration = sec(num(args, "duration") as number);
      editor.timeline.insertElement({ element, placement: { mode: "auto" } });
      return state(editor);
    }
    case "add_graphic": {
      const start = num(args, "start") ?? toSec(editor.playback.getCurrentTime());
      const element = buildGraphicElement({ definitionId: need(str(args, "definitionId"), "definitionId"), startTime: sec(start), params: params(args) });
      if (num(args, "duration")) element.duration = sec(num(args, "duration") as number);
      editor.timeline.insertElement({ element, placement: { mode: "auto" } });
      return state(editor);
    }
    case "add_effect_layer": {
      const start = num(args, "start") ?? toSec(editor.playback.getCurrentTime());
      const element = buildEffectElement({ effectType: need(str(args, "effectType"), "effectType"), startTime: sec(start), duration: num(args, "duration") ? sec(num(args, "duration") as number) : undefined });
      editor.timeline.insertElement({ element, placement: { mode: "auto" } });
      return state(editor);
    }
    case "add_subtitles": {
      const text = str(args, "srt") ?? str(args, "ass");
      let captions;
      if (text) {
        captions = parseSubtitleFile({ fileName: args.ass ? "subtitles.ass" : "subtitles.srt", input: text }).captions;
      } else if (Array.isArray(args.cues)) {
        captions = (args.cues as Array<Record<string, unknown>>).map((c) => ({ text: String(c.text ?? ""), startTime: Number(c.start ?? 0), duration: Number(c.duration ?? 2) }));
      } else {
        throw new Error("srt (the text of an .srt file) or cues ([{text, start, duration}]) is required");
      }
      if (!captions.length) throw new Error("No subtitles were found in that");
      const cues = captions.map((c) => ({ ...c, startTime: Math.round(c.startTime * 1000) / 1000 }));
      insertCaptionChunksAsTextTrack({ editor, captions: cues });
      return state(editor);
    }
    case "duplicate": {
      const ids = Array.isArray(args.elementIds) ? args.elementIds.map(String) : [need(str(args, "elementId"), "elementId")];
      const elements = ids.map((id) => {
        const { track, element } = findElement(editor, id);
        return { trackId: track.id, elementId: element.id };
      });
      editor.timeline.duplicateElements({ elements });
      return state(editor);
    }
    case "select": {
      if (args.all === true) invokeAction("select-all");
      else if (args.none === true) editor.selection.clearSelection();
      else {
        const ids = Array.isArray(args.elementIds) ? args.elementIds.map(String) : [need(str(args, "elementId"), "elementId")];
        editor.selection.setSelectedElements({ elements: ids.map((id) => ({ trackId: findElement(editor, id).track.id, elementId: id })) });
      }
      return { selected: editor.selection.getSelectedElements().map((e) => e.elementId) };
    }
    case "copy":
    case "paste": {
      if (name === "copy") return { copied: editor.clipboard.copy() };
      const at = num(args, "time");
      const ok = editor.clipboard.paste(at === undefined ? {} : { time: sec(at) });
      return ok ? state(editor) : { pasted: false };
    }
    case "toggle_visibility":
    case "toggle_mute": {
      const { trackId, elementId } = refOf(editor, args);
      const elements = [{ trackId, elementId }];
      if (name === "toggle_visibility") editor.timeline.toggleElementsVisibility({ elements });
      else editor.timeline.toggleElementsMuted({ elements });
      return state(editor);
    }
    case "separate_audio": {
      const { trackId, elementId } = refOf(editor, args);
      editor.timeline.toggleSourceAudioSeparation({ trackId, elementId });
      return state(editor);
    }

    // ----------------------------------------------------------- effects --
    case "effect_add": {
      const { trackId, elementId } = refOf(editor, args);
      const effectType = need(str(args, "effectType"), "effectType");
      buildDefaultEffectInstance({ effectType }); // a name that does not exist fails here, saying so
      const effectId = editor.timeline.addClipEffect({ trackId, elementId, effectType });
      const p = params(args);
      if (effectId && Object.keys(p).length) editor.timeline.updateClipEffectParams({ trackId, elementId, effectId, params: p });
      return { effectId, ...(state(editor) as object) };
    }
    case "effect_set": {
      const { trackId, elementId } = refOf(editor, args);
      editor.timeline.updateClipEffectParams({ trackId, elementId, effectId: need(str(args, "effectId"), "effectId"), params: params(args), pushHistory: args.history !== false });
      return state(editor);
    }
    case "effect_toggle":
    case "effect_remove": {
      const { trackId, elementId } = refOf(editor, args);
      const effectId = need(str(args, "effectId"), "effectId");
      if (name === "effect_toggle") editor.timeline.toggleClipEffect({ trackId, elementId, effectId });
      else editor.timeline.removeClipEffect({ trackId, elementId, effectId });
      return state(editor);
    }
    case "effect_reorder": {
      const { trackId, elementId } = refOf(editor, args);
      editor.timeline.reorderClipEffects({ trackId, elementId, fromIndex: need(num(args, "from"), "from"), toIndex: need(num(args, "to"), "to") });
      return state(editor);
    }

    // ------------------------------------------------------------- masks --
    case "mask_add": {
      const { trackId, elementId } = refOf(editor, args);
      const maskType = need(str(args, "maskType"), "maskType") as Parameters<typeof buildDefaultMaskInstance>[0]["maskType"];
      if (!masksRegistry.has(maskType)) throw new Error(`Unknown mask ${maskType}: catalog masks lists them`);
      const mask = buildDefaultMaskInstance({ maskType });
      const p = params(args);
      const withParams = Object.keys(p).length ? { ...mask, params: { ...mask.params, ...p } } : mask;
      editor.timeline.updateElements({ updates: [{ trackId, elementId, patch: { masks: [withParams] } as Partial<MaskableElement> }] });
      return state(editor);
    }
    case "mask_set": {
      const { trackId, elementId, element } = refOf(editor, args);
      const mask = maskOf(element);
      if (!mask) throw new Error("That clip has no mask: mask_add first");
      editor.timeline.updateElements({
        updates: [{ trackId, elementId, patch: { masks: [{ ...mask, params: { ...mask.params, ...params(args) } }] } as Partial<MaskableElement> }],
        pushHistory: args.history !== false,
      });
      return state(editor);
    }
    case "mask_invert":
    case "mask_remove": {
      const { trackId, elementId, element } = refOf(editor, args);
      const mask = maskOf(element);
      if (!mask) throw new Error("That clip has no mask");
      if (name === "mask_invert") editor.timeline.toggleMaskInverted({ trackId, elementId, maskId: mask.id });
      else editor.timeline.removeMask({ trackId, elementId, maskId: mask.id });
      return state(editor);
    }

    // --------------------------------------------------------- keyframes --
    case "keyframe_set": {
      const { trackId, elementId } = refOf(editor, args);
      const at = need(num(args, "at"), "at");
      const value = args.value;
      if (typeof value !== "number" && typeof value !== "string" && typeof value !== "boolean") throw new Error("value is required");
      const interpolation = str(args, "interpolation") as "linear" | "hold" | "bezier" | undefined;
      const effectId = str(args, "effectId");
      if (effectId) {
        if (typeof value !== "number") throw new Error("An effect's parameter is keyframed with a number");
        editor.timeline.upsertEffectParamKeyframe({ trackId, elementId, effectId, paramKey: need(str(args, "param"), "param"), time: sec(at), value, interpolation: interpolation === "bezier" ? "linear" : interpolation });
      } else {
        editor.timeline.upsertKeyframes({ keyframes: [{ trackId, elementId, propertyPath: need(str(args, "property"), "property"), time: sec(at), value, interpolation }] });
      }
      return state(editor);
    }
    case "keyframe_remove": {
      const { trackId, elementId } = refOf(editor, args);
      const keyframeId = need(str(args, "keyframeId"), "keyframeId");
      const effectId = str(args, "effectId");
      if (effectId) editor.timeline.removeEffectParamKeyframe({ trackId, elementId, effectId, paramKey: need(str(args, "param"), "param"), keyframeId });
      else editor.timeline.removeKeyframes({ keyframes: [{ trackId, elementId, propertyPath: need(str(args, "property"), "property"), keyframeId }] });
      return state(editor);
    }
    case "keyframe_move": {
      const { trackId, elementId } = refOf(editor, args);
      editor.timeline.retimeKeyframe({ trackId, elementId, propertyPath: need(str(args, "property"), "property"), keyframeId: need(str(args, "keyframeId"), "keyframeId"), time: sec(need(num(args, "at"), "at")) });
      return state(editor);
    }
    case "keyframes": {
      const { element } = refOf(editor, args);
      return { animations: element.animations ?? {} };
    }

    // -------------------------------------------------------------- speed --
    case "retime": {
      const { trackId, elementId } = refOf(editor, args);
      const rate = need(num(args, "rate"), "rate");
      editor.timeline.updateElementRetime({ trackId, elementId, retime: rate === 1 ? undefined : buildConstantRetime({ rate, maintainPitch: args.maintainPitch === true }) });
      return state(editor);
    }

    // ------------------------------------------------------------- tracks --
    case "track_add": {
      const type = need(str(args, "type"), "type") as "video" | "text" | "audio" | "graphic" | "effect";
      const id = editor.timeline.addTrack({ type, ...(num(args, "index") !== undefined ? { index: num(args, "index") } : {}) });
      return { trackId: id };
    }
    case "track_remove":
      editor.timeline.removeTrack({ trackId: need(str(args, "trackId"), "trackId") });
      return state(editor);
    case "track_mute":
      editor.timeline.toggleTrackMute({ trackId: need(str(args, "trackId"), "trackId") });
      return state(editor);
    case "track_hide":
      editor.timeline.toggleTrackVisibility({ trackId: need(str(args, "trackId"), "trackId") });
      return state(editor);

    // ------------------------------------------------------------- scenes --
    case "scene_list":
      return editor.scenes.getScenes().map((s) => ({ id: s.id, name: s.name, main: s.isMain, active: s.id === editor.scenes.getActiveScene().id }));
    case "scene_create":
      return { sceneId: await editor.scenes.createScene({ name: need(str(args, "name"), "name"), isMain: false }) };
    case "scene_rename":
      await editor.scenes.renameScene({ sceneId: need(str(args, "sceneId"), "sceneId"), name: need(str(args, "name"), "name") });
      return { ok: true };
    case "scene_switch":
      await editor.scenes.switchToScene({ sceneId: need(str(args, "sceneId"), "sceneId") });
      return state(editor);
    case "scene_delete":
      await editor.scenes.deleteScene({ sceneId: need(str(args, "sceneId"), "sceneId") });
      return state(editor);

    // ---------------------------------------------------------- bookmarks --
    case "bookmark_toggle":
      await editor.scenes.toggleBookmark({ time: sec(num(args, "time") ?? toSec(editor.playback.getCurrentTime())) });
      return { bookmarks: editor.scenes.getActiveScene().bookmarks.map((b) => ({ time: toSec(b.time), note: b.note, color: b.color })) };
    case "bookmark_set": {
      const updates: Record<string, unknown> = {};
      if (str(args, "note") !== undefined) updates.note = str(args, "note");
      if (str(args, "color") !== undefined) updates.color = str(args, "color");
      if (num(args, "duration") !== undefined) updates.duration = sec(num(args, "duration") as number);
      const time = sec(need(num(args, "time"), "time"));
      if (!editor.scenes.isBookmarked({ time })) await editor.scenes.toggleBookmark({ time });
      await editor.scenes.updateBookmark({ time, updates });
      return { bookmarks: editor.scenes.getActiveScene().bookmarks.map((b) => ({ time: toSec(b.time), note: b.note, color: b.color })) };
    }
    case "bookmark_move":
      await editor.scenes.moveBookmark({ fromTime: sec(need(num(args, "from"), "from")), toTime: sec(need(num(args, "to"), "to")) });
      return { ok: true };
    case "bookmark_remove":
      await editor.scenes.removeBookmark({ time: sec(need(num(args, "time"), "time")) });
      return { ok: true };

    // ---------------------------------------------------- project settings --
    case "settings": {
      const settings: Record<string, unknown> = {};
      const fps = num(args, "fps");
      if (fps !== undefined) settings.fps = floatToFrameRate(fps);
      const w = num(args, "width");
      const h = num(args, "height");
      if (w !== undefined || h !== undefined) {
        const now = editor.project.getActive().settings.canvasSize;
        settings.canvasSize = { width: Math.round(w ?? now.width), height: Math.round(h ?? now.height) };
        settings.canvasSizeMode = "custom";
      }
      const bg = args.background;
      if (bg && typeof bg === "object") {
        const b = bg as Record<string, unknown>;
        settings.background = b.type === "blur" ? { type: "blur", blurIntensity: Number(b.blurIntensity ?? 8) } : { type: "color", color: String(b.color ?? "#000000") };
      }
      if (!Object.keys(settings).length) throw new Error("Pass fps, width and/or height, or background ({type: 'color', color} or {type: 'blur', blurIntensity})");
      await editor.project.updateSettings({ settings });
      return catalog(editor, "settings", "");
    }
    case "media_remove": {
      const id = need(str(args, "mediaId"), "mediaId");
      editor.media.removeMediaAsset({ projectId: editor.project.getActive().metadata.id, id });
      return state(editor);
    }
    case "project_list":
      await editor.project.loadAllProjects();
      return editor.project.getSavedProjects().map((p) => ({ id: p.id, name: p.name, duration: toSec(p.duration) }));
    case "project_delete":
      await editor.project.deleteProjects({ ids: [need(str(args, "projectId"), "projectId")] });
      return { ok: true };
    case "project_duplicate":
      return { projectIds: await editor.project.duplicateProjects({ ids: [need(str(args, "projectId"), "projectId")] }) };

    // -------------------------------------------- the editor's own actions --
    case "action": {
      const action = need(str(args, "name"), "name");
      if (!(action in ACTIONS)) throw new Error(`Unknown action ${action}: catalog actions lists them`);
      const given = args.args;
      (invokeAction as (a: string, b?: unknown) => void)(action, given);
      return state(editor);
    }
    case "panel": {
      const tab = need(str(args, "tab"), "tab");
      if (!(TAB_KEYS as readonly string[]).includes(tab)) throw new Error(`tab is one of: ${TAB_KEYS.join(", ")}`);
      useAssetsPanelStore.getState().setActiveTab(tab as (typeof TAB_KEYS)[number]);
      return { tab };
    }

    // ------------------------------------------------------ looking at it --
    case "catalog":
      return catalog(editor, need(str(args, "topic"), "topic"), str(args, "query") ?? "");
    case "frame":
      return capture(editor, num(args, "time") ?? toSec(editor.playback.getCurrentTime()), num(args, "width") ?? 640);
    default:
      return undefined;
  }
}
