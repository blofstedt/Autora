/**
 * Autora Video: OpenCut's editor in a window beside the chat. The agent opens
 * a project, brings media in, and cuts, arranges and titles it through the
 * editor itself (server/opencut.ts), so the person watches the timeline change
 * and can take over at any moment.
 */

import type { ToolSpec } from "../tools";

const TIME = "In seconds on the timeline.";

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
      "Change the open project, one step at a time, the way a person would at the timeline; each step can be " +
      "undone with Ctrl+Z, and every step returns the timeline as it now is. `action`:\n" +
      "- add_clip: put imported media on the timeline. mediaId; start (default: after the last clip); " +
      "duration (default: the media's own; pictures default to 5s).\n" +
      "- add_text: a title or subtitle. text; start (default: the playhead); duration (default 3); optional " +
      "color (#rrggbb), fontFamily, fontSize, fontWeight, textAlign.\n" +
      "- split: cut a clip in two. elementId; time (a moment inside the clip).\n" +
      "- trim: keep only part of a clip. elementId; from and to (positions in the source clip, in seconds).\n" +
      "- move: elementId; start (new start time); trackId to change track.\n" +
      "- delete: elementId (or elementIds).\n" +
      "- set: change a clip's properties. elementId; params (e.g. {\"content\": \"New title\", \"opacity\": 0.5}).\n" +
      "- seek / play / pause: the playhead (time).\n" +
      "- undo / redo.\n" +
      "- rename: the project (name).\n" +
      "Clip and track ids are in video_look. " + TIME,
    parameters: {
      type: "object",
      properties: {
        action: { type: "string", enum: ["add_clip", "add_text", "split", "trim", "move", "delete", "set", "seek", "play", "pause", "undo", "redo", "rename"] },
        mediaId: { type: "string", description: "add_clip: the media to place (from video_import or video_look)." },
        elementId: { type: "string", description: "The clip to act on (from video_look)." },
        elementIds: { type: "array", items: { type: "string" }, description: "delete: several clips at once." },
        trackId: { type: "string", description: "move: the track to move it to." },
        text: { type: "string", description: "add_text: the words." },
        start: { type: "number", description: "Start time on the timeline, in seconds." },
        duration: { type: "number", description: "How long it shows, in seconds." },
        time: { type: "number", description: "split / seek: a time in seconds." },
        from: { type: "number", description: "trim: where in the source to start, in seconds." },
        to: { type: "number", description: "trim: where in the source to stop, in seconds." },
        params: { type: "object", description: "set: the properties to change." },
        color: { type: "string" },
        fontFamily: { type: "string" },
        fontSize: { type: "number" },
        fontWeight: { type: "string" },
        textAlign: { type: "string", enum: ["left", "center", "right"] },
        name: { type: "string", description: "rename: the new project name." },
      },
      required: ["action"],
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
