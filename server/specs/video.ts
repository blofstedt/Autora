/**
 * Autora Video: OpenCut's editor in a window beside the chat. The agent opens
 * a project, brings media in, and cuts, arranges and titles it through the
 * editor itself (server/opencut.ts), so the person watches the timeline change
 * and can take over at any moment.
 */

import type { ToolSpec } from "../tools";

export const videoSPECS: ToolSpec[] = [
  {
    name: "video_open",
    group: "files",
    description:
      "Open Autora Video (the video editor) beside the chat, on a project. With no arguments it opens the " +
      "window on the project it last had (a new, empty one the first time). Pass `project` (an id, or the " +
      "project's name) to open an existing project, or `new` (a name) to start a fresh one. Returns the " +
      "timeline. Use this before the other video tools; they open it themselves if you forget.",
    parameters: {
      type: "object",
      properties: {
        project: { type: "string", description: "An existing project: its id or (part of) its name." },
        new: { type: "string", description: "A name for a new project to start." },
      },
    },
  },
  {
    name: "video_look",
    group: "files",
    description:
      "Read the open video project: its size and frame rate, the media imported into it, and every track and " +
      "clip with its id and times. Read it before you change anything, and again after, to check the cut is " +
      "what you meant. Changes nothing.",
    parameters: { type: "object", properties: {} },
  },
  {
    name: "video_import",
    group: "files",
    description:
      "Bring a video, audio or image file into the open project's media. `file` is an artifact id (file_...) " +
      "or a path on this host. Returns the media id; put it on the timeline with video_edit add_clip. " +
      "The file is copied into the project, so the original stays where it is.",
    parameters: {
      type: "object",
      properties: {
        file: { type: "string", description: "An artifact id (file_...) or a path on this host." },
        name: { type: "string", description: "A name for it in the project, with its extension. Default: the file's own." },
      },
      required: ["file"],
    },
  },
  {
    name: "video_edit",
    group: "files",
    risky: true,
    description:
      "Change what is on the open project's timeline, one step at a time, the way a person would; each step can be " +
      "undone with Ctrl+Z, and every step returns the timeline as it now is. `action`:\n" +
      "- add_clip: put imported media on the timeline. mediaId; start (default: after the last clip); " +
      "duration (default: the media's own; pictures default to 5s).\n" +
      "- add_text: a title or subtitle. text; start (default: the playhead); duration (default 3); optional " +
      "color (#rrggbb), fontFamily, fontSize, fontWeight, textAlign. fontSize is in editor units, not points or pixels: " +
      "90 is the whole height of the picture, the default is 15 (a sixth of it) and a big title is about 20; 45 is the most.\n" +
      "- add_sticker: stickerId (provider:value; video_catalog stickers with a query finds them); start; duration.\n" +
      "- add_graphic: a shape. definitionId (video_catalog graphics); params; start; duration.\n" +
      "- add_effect_layer: an effect over everything under it for a while. effectType (video_catalog effects); start; duration.\n" +
      "- add_subtitles: a whole track of subtitles at once. srt (the text of an .srt file) or cues ([{text, start, duration}]).\n" +
      "- split: cut a clip in two. elementId; time (a moment inside the clip).\n" +
      "- trim: keep only part of a clip. elementId; from and to (positions in the source clip, in seconds).\n" +
      "- move: elementId; start (new start time); trackId to change track.\n" +
      "- delete: elementId (or elementIds).  duplicate: elementId (or elementIds).\n" +
      "- set: change a clip's own properties. elementId; params (e.g. {\"content\": \"New title\", \"opacity\": 0.5, " +
      "\"transform.positionX\": 200}); video_catalog properties with the elementId lists the names a clip has.\n" +
      "- select (elementIds, or all / none), copy, paste (time).  toggle_visibility / toggle_mute: elementId.\n" +
      "- seek / play / pause: the playhead (time).  undo / redo.  rename: the project (name).\n" +
      "Clip and track ids are in video_look. Times are in seconds on the timeline.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add_clip", "add_text", "add_sticker", "add_graphic", "add_effect_layer", "add_subtitles", "split", "trim", "move", "delete", "duplicate", "set", "select", "copy", "paste", "toggle_visibility", "toggle_mute", "seek", "play", "pause", "undo", "redo", "rename"] },
        mediaId: { type: "string", description: "add_clip: the media to place (from video_import or video_look)." },
        elementId: { type: "string", description: "The clip to act on (from video_look)." },
        elementIds: { type: "array", items: { type: "string" }, description: "delete / duplicate / select: several clips at once." },
        all: { type: "boolean", description: "select: everything." },
        none: { type: "boolean", description: "select: nothing." },
        trackId: { type: "string", description: "move: the track to move it to." },
        text: { type: "string", description: "add_text: the words." },
        stickerId: { type: "string", description: "add_sticker: provider:value." },
        definitionId: { type: "string", description: "add_graphic: which shape." },
        effectType: { type: "string", description: "add_effect_layer: which effect." },
        srt: { type: "string", description: "add_subtitles: the text of an .srt file." },
        cues: { type: "array", items: { type: "object" }, description: "add_subtitles: [{text, start, duration}] in seconds." },
        start: { type: "number", description: "Start time on the timeline, in seconds." },
        duration: { type: "number", description: "How long it shows, in seconds." },
        time: { type: "number", description: "split / seek / paste: a time in seconds." },
        from: { type: "number", description: "trim: where in the source to start, in seconds." },
        to: { type: "number", description: "trim: where in the source to stop, in seconds." },
        params: { type: "object", description: "set / add_graphic: the properties to change." },
        color: { type: "string" },
        fontFamily: { type: "string" },
        fontSize: { type: "number", description: "Editor units: 90 is the picture's whole height. Default 15; 4 to 30 is the useful range." },
        fontWeight: { type: "string" },
        textAlign: { type: "string", enum: ["left", "center", "right"] },
        name: { type: "string", description: "rename: the new project name." },
      },
      required: ["action"],
    },
  },
  {
    name: "video_style",
    group: "files",
    risky: true,
    description:
      "How a clip looks, sounds and moves: its effects, mask, keyframes and speed. Every step is the editor's own " +
      "and can be undone, and the clip is picked in the editor as it is done. `action` (all take elementId from video_look):\n" +
      "- effect_add: effectType (video_catalog effects), optional params. Returns the effectId. effect_set: effectId, params. " +
      "effect_toggle / effect_remove: effectId. effect_reorder: from, to (positions).\n" +
      "- mask_add: maskType (video_catalog masks), optional params. mask_set: params (e.g. feather, width). mask_invert. mask_remove.\n" +
      "- keyframe_set: animate a property. property (transform.positionX, transform.positionY, transform.scaleX, transform.scaleY, " +
      "transform.rotate, opacity, volume, color...) or effectId + param for an effect's parameter; at (seconds from the clip's start); " +
      "value; interpolation (linear, hold, bezier). Two keyframes make a movement. keyframe_remove: property (or effectId + param), keyframeId. " +
      "keyframe_move: property, keyframeId, at. keyframes: read a clip's keyframes and their ids.\n" +
      "- retime: speed. rate (0.5 half speed, 2 double; 0.01 to 5), maintainPitch. rate 1 puts it back.\n" +
      "- separate_audio: take a video clip's sound onto its own audio track, or put it back.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["effect_add", "effect_set", "effect_toggle", "effect_remove", "effect_reorder", "mask_add", "mask_set", "mask_invert", "mask_remove", "keyframe_set", "keyframe_remove", "keyframe_move", "keyframes", "retime", "separate_audio"] },
        elementId: { type: "string", description: "The clip (from video_look)." },
        effectType: { type: "string" },
        effectId: { type: "string" },
        maskType: { type: "string" },
        params: { type: "object", description: "Parameter values by key (video_catalog lists the keys)." },
        property: { type: "string", description: "keyframes: the property path." },
        param: { type: "string", description: "keyframes on an effect: the effect parameter key." },
        keyframeId: { type: "string" },
        at: { type: "number", description: "keyframes: seconds from the clip's start." },
        value: { description: "keyframe_set: the value (a number, a #color or a word)." },
        interpolation: { type: "string", enum: ["linear", "hold", "bezier"] },
        from: { type: "number", description: "effect_reorder: the position it is at." },
        to: { type: "number", description: "effect_reorder: where it goes." },
        rate: { type: "number", description: "retime: the speed multiplier." },
        maintainPitch: { type: "boolean" },
      },
      required: ["action"],
    },
  },
  {
    name: "video_project",
    group: "files",
    risky: true,
    description:
      "The project around the clips: tracks, scenes, bookmarks, its size and frame rate, its media, and the editor's own panels " +
      "and keyboard actions. `action`:\n" +
      "- track_add (type video, text, audio, graphic or effect; index), track_remove / track_mute / track_hide (trackId).\n" +
      "- scene_list, scene_create (name), scene_rename (sceneId, name), scene_switch (sceneId), scene_delete (sceneId).\n" +
      "- bookmark_toggle (time), bookmark_set (time, note, color, duration), bookmark_move (from, to), bookmark_remove (time).\n" +
      "- settings: fps (24, 25, 30, 60...), width and/or height (1920x1080 is 16:9, 1080x1920 is 9:16, 1080x1080 is square), " +
      "background ({type: color, color} or {type: blur, blurIntensity}).\n" +
      "- media_remove (mediaId).  project_list, project_delete (projectId), project_duplicate (projectId).\n" +
      "- action: any of the editor's own actions by name, with args if it takes them (video_catalog actions lists them: " +
      "split-left, split-right, toggle-snapping, toggle-ripple-editing, goto-start, frame-step-forward...).\n" +
      "- panel: show a tab of the assets panel (media, sounds, text, stickers, effects, transitions, captions, adjustment, settings).",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["track_add", "track_remove", "track_mute", "track_hide", "scene_list", "scene_create", "scene_rename", "scene_switch", "scene_delete", "bookmark_toggle", "bookmark_set", "bookmark_move", "bookmark_remove", "settings", "media_remove", "project_list", "project_delete", "project_duplicate", "action", "panel"] },
        type: { type: "string", enum: ["video", "text", "audio", "graphic", "effect"], description: "track_add." },
        index: { type: "number" },
        trackId: { type: "string" },
        sceneId: { type: "string" },
        name: { type: "string", description: "scene name, or the editor action's name for action." },
        args: { type: "object", description: "action: its arguments." },
        time: { type: "number", description: "bookmark time in seconds." },
        from: { type: "number" },
        to: { type: "number" },
        note: { type: "string" },
        color: { type: "string" },
        duration: { type: "number" },
        fps: { type: "number" },
        width: { type: "number" },
        height: { type: "number" },
        background: { type: "object" },
        mediaId: { type: "string" },
        projectId: { type: "string" },
        tab: { type: "string", enum: ["media", "sounds", "text", "stickers", "effects", "transitions", "captions", "adjustment", "settings"] },
      },
      required: ["action"],
    },
  },
  {
    name: "video_ui",
    group: "files",
    risky: true,
    description:
      "Use the editor's screen itself, the way a person does, for anything the other video tools do not cover: every button, " +
      "menu, field, slider and panel in OpenCut's interface. `read` lists what is on screen, each control with a [ref] number, " +
      "its label and its value (an open menu or dialog is all it lists, because it holds the screen). Then `click` (ref or label; " +
      "double, right), `type` (ref or label; text; replace defaults to true; enter or blur to commit it), `press` (key such as " +
      "s, Enter, Escape, ArrowRight, with ctrl/shift/alt), `drag` (from and to as {x, y} in the editor's own pixels; for clips " +
      "and the playhead), `scroll` (dx, dy; optionally over a ref). Clips and tracks can also be named by elementId and trackId. " +
      "Read again after anything that changes the screen: refs belong to what was read. The agent's cursor goes to each control " +
      "and the words are typed as keystrokes, so the person sees it. Prefer video_edit, video_style and video_project when they " +
      "do the job; they are exact. This is for the rest.",
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["read", "click", "type", "commit", "press", "drag", "scroll"] },
        ref: { type: "number", description: "A control's number from `read`." },
        label: { type: "string", description: "A control's label, when no ref." },
        elementId: { type: "string", description: "A clip on the timeline." },
        trackId: { type: "string", description: "A track on the timeline." },
        selector: { type: "string", description: "A CSS selector, for what has no label." },
        text: { type: "string", description: "type: the words." },
        replace: { type: "boolean", description: "type: clear the field first (default true)." },
        enter: { type: "boolean", description: "type: press Enter after." },
        blur: { type: "boolean", description: "type: leave the field after." },
        how: { type: "string", enum: ["enter", "blur"], description: "commit." },
        key: { type: "string", description: "press: the key." },
        ctrl: { type: "boolean" },
        shift: { type: "boolean" },
        alt: { type: "boolean" },
        double: { type: "boolean" },
        right: { type: "boolean" },
        from: { type: "object", description: "drag: {x, y} to press at." },
        to: { type: "object", description: "drag: {x, y} to let go at." },
        dx: { type: "number" },
        dy: { type: "number" },
      },
      required: ["action"],
    },
  },
  {
    name: "video_catalog",
    group: "files",
    description:
      "What there is to choose from in the editor, so nothing is guessed at: `topic` effects, masks, graphics, stickers (with a " +
      "query to search), elements (the properties each kind of clip has), properties (with elementId: this clip's properties and " +
      "values), settings, actions, panels, keyframes, retime. Changes nothing.",
    parameters: {
      type: "object",
      properties: {
        topic: { type: "string", enum: ["effects", "masks", "graphics", "stickers", "elements", "properties", "settings", "actions", "panels", "keyframes", "retime"] },
        query: { type: "string", description: "stickers: what to search for." },
        elementId: { type: "string", description: "properties: the clip." },
      },
      required: ["topic"],
    },
  },
  {
    name: "video_frame",
    group: "files",
    description:
      "See the project: the picture of one moment as the editor draws it (title, clips, effects and masks as they will export), " +
      "so you can check a cut, a title's size or an effect instead of trusting the numbers. `time` in seconds (default: the " +
      "playhead). Changes nothing.",
    parameters: {
      type: "object",
      properties: {
        time: { type: "number", description: "Seconds on the timeline." },
        width: { type: "number", description: "Picture width in pixels (default 640)." },
      },
    },
  },
  {
    name: "video_export",
    group: "files",
    description:
      "Render the open project to a video file (in the editor itself, so it can take a while for a long cut) " +
      "and keep it as an artifact the person can open and download. Saved files are capped at 50 MB; lower " +
      "`quality` for a longer video. Look at the timeline with video_look first.",
    parameters: {
      type: "object",
      properties: {
        format: { type: "string", enum: ["mp4", "webm"], description: "Default mp4." },
        quality: { type: "string", enum: ["low", "medium", "high", "very_high"], description: "Default high." },
        audio: { type: "boolean", description: "Include the sound. Default true." },
      },
    },
  },
];
