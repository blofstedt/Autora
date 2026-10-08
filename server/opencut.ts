/**
 * The video window: OpenCut's editor (opencut-editor/, served from here)
 * beside the conversation, for the person to cut a video in and the agent to
 * cut one with.
 *
 * Three jobs, all small:
 *
 *  - the store. OpenCut keeps its projects in the browser's IndexedDB and its
 *    media in OPFS; the editor runs in a frame with no origin, which has
 *    neither, so what it keeps goes to the window and from there to files here
 *    (`stateDir()/opencut/`). The projects are the person's, not a chat's: any
 *    chat opens any of them.
 *  - the window's state, per chat: whether it is open and which project is in it.
 *  - commands. The agent does not edit the stored project behind the editor's
 *    back; it asks the open editor to (`command`), and the editor does it with
 *    its own timeline commands, so every change is validated the way a click
 *    is, shows as it happens and can be undone. The window relays the command
 *    to the frame and the answer back (components/OpenCutWindow.tsx).
 *
 * The editor is served with a CSP and no way to reach this API (see
 * serveOpencut); the window is its only door.
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import { artifactPath, getArtifact, MAX_ARTIFACT_BYTES, saveArtifact } from "./artifacts";
import type { ChatImage } from "./llm";
import { stateDir } from "./state";
import { staticDir } from "./staticfiles";

// ------------------------------------------------------------- the store --

const STORE = () => path.join(stateDir(), "opencut");
/** Projects and media are large; a video is larger. */
const MAX_FILE = 4 * 1024 * 1024 * 1024;
const MAX_JSON = 64 * 1024 * 1024;

const safeKey = (key: unknown): string | null =>
  typeof key === "string" && /^[A-Za-z0-9][A-Za-z0-9._-]{0,199}$/.test(key) ? key : null;
const safeNs = (ns: unknown): string | null =>
  typeof ns === "string" && /^[A-Za-z0-9][A-Za-z0-9._/*-]{0,199}$/.test(ns) && !ns.includes("..") && !ns.includes("//") ? ns : null;
/** A namespace is a folder: `video-editor-projects/projects` is `video-editor-projects__projects`. */
const nsDir = (ns: string) => path.join(STORE(), ns.replace(/\//g, "__"));

type FileMeta = { name: string; type: string; lastModified: number };

function readJson(file: string): unknown {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

function writeAtomic(file: string, data: Buffer | string) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.${crypto.randomBytes(4).toString("hex")}.tmp`;
  fs.writeFileSync(tmp, data, { mode: 0o600 });
  fs.renameSync(tmp, file);
}

function keysIn(dir: string, ext: string): string[] {
  try {
    return fs.readdirSync(dir).filter((f) => f.endsWith(ext) && !f.endsWith(".meta.json")).map((f) => f.slice(0, -ext.length));
  } catch {
    return [];
  }
}

/** What the editor's storage adapters ask for (`get`, `set`, `remove`, `list`, `all`, `clear`), answered from disk. */
function kv(req: { op?: unknown; ns?: unknown; key?: unknown; value?: unknown }): unknown {
  const ns = safeNs(req.ns);
  if (!ns) throw new Error("bad namespace");
  const op = String(req.op);
  // Dropping a whole database: every store whose name starts with `<db>/`.
  if (op === "clear" && ns.endsWith("/*")) {
    const prefix = `${ns.slice(0, -1).replace(/\//g, "__")}`;
    try {
      for (const d of fs.readdirSync(STORE())) if (d.startsWith(prefix)) fs.rmSync(path.join(STORE(), d), { recursive: true, force: true });
    } catch {
      // Nothing was ever kept.
    }
    return null;
  }
  if (ns.includes("*")) throw new Error("bad namespace");
  const dir = nsDir(ns);
  const files = ns.startsWith("files/");
  const ext = files ? ".bin" : ".json";
  const key = req.key === undefined ? null : safeKey(req.key);
  if (["get", "set", "remove"].includes(op) && !key) throw new Error("bad key");
  switch (op) {
    case "get":
      return files ? null : readJson(path.join(dir, `${key}.json`));
    case "set":
      if (files) throw new Error("files are put to /api/opencut/file");
      writeAtomic(path.join(dir, `${key}.json`), JSON.stringify(req.value ?? null));
      return null;
    case "remove":
      fs.rmSync(path.join(dir, `${key}${ext}`), { force: true });
      fs.rmSync(path.join(dir, `${key}.meta.json`), { force: true });
      return null;
    case "list":
      return keysIn(dir, ext);
    case "all":
      return files ? [] : keysIn(dir, ".json").map((k) => readJson(path.join(dir, `${k}.json`))).filter((v) => v !== null);
    case "clear":
      fs.rmSync(dir, { recursive: true, force: true });
      return null;
    default:
      throw new Error("bad operation");
  }
}

/** The projects there are, most recently touched first. */
export function listProjects(): Array<{ id: string; name: string; duration: number; updatedAt: string }> {
  const dir = nsDir("video-editor-projects/projects");
  return keysIn(dir, ".json")
    .map((k) => readJson(path.join(dir, `${k}.json`)) as { id?: string; metadata?: { name?: string; duration?: number; updatedAt?: string } } | null)
    .filter((p): p is NonNullable<typeof p> => !!p && typeof p.id === "string")
    .map((p) => ({
      id: String(p.id),
      name: String(p.metadata?.name ?? "Untitled project"),
      duration: Number(p.metadata?.duration ?? 0),
      updatedAt: String(p.metadata?.updatedAt ?? ""),
    }))
    .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
}

// ------------------------------------------------------- the window state --

type Win = {
  open: boolean;
  /** The frame has said it is up and can take commands. */
  ready: boolean;
  projectId: string | null;
  name: string | null;
  since: number;
};

const wins = new Map<string, Win>();

type OpencutState = { open: boolean; projectId?: string | null; name?: string | null; since?: number };

export function opencutState(session: string): OpencutState {
  const w = wins.get(session);
  return w?.open ? { open: true, projectId: w.projectId, name: w.name, since: w.since } : { open: false };
}

let changed: (session: string) => void = () => undefined;
/** Who to tell when a window changes: server.ts sends it to the chat's tabs. */
export function onOpencutChange(fn: (session: string) => void) {
  changed = fn;
}

let pushed: (session: string, message: Record<string, unknown>) => void = () => undefined;

function win(session: string): Win {
  let w = wins.get(session);
  if (!w) wins.set(session, (w = { open: false, ready: false, projectId: null, name: null, since: Date.now() }));
  return w;
}

function setOpen(session: string, on: boolean) {
  const w = win(session);
  if (w.open === on) return;
  w.open = on;
  w.ready = false;
  if (on) w.since = Date.now();
  else rejectAll(session, "The video window was closed.");
  changed(session);
}

// --------------------------------------------------------------- commands --

type Pending = { session: string; resolve: (v: unknown) => void; reject: (e: Error) => void; timer: NodeJS.Timeout; claimed: boolean };
const pending = new Map<string, Pending>();

function rejectAll(session: string, why: string) {
  for (const [id, p] of pending) {
    if (p.session !== session) continue;
    clearTimeout(p.timer);
    pending.delete(id);
    p.reject(new Error(why));
  }
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Ask the open editor to do something, and wait for what it says. */
export async function command(session: string, name: string, args: Record<string, unknown> = {}, timeoutMs = 60_000): Promise<unknown> {
  setOpen(session, true);
  const w = win(session);
  // The frame loads after the window opens: give it time to say it is up.
  for (let waited = 0; !w.ready && waited < 40_000; waited += 150) await sleep(150);
  if (!w.ready) {
    throw new Error("The video editor did not start. It opens in the browser tab for this chat; if no tab is open, open Autora there and try again.");
  }
  const id = crypto.randomBytes(6).toString("hex");
  return await new Promise<unknown>((resolve, reject) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      // Slow is not failed: the editor may still be loading (a cold start takes a while), or may have done it and been
      // slow to say so. Repeating a step that did land would do it twice, so the agent is told to look first.
      reject(new Error(`The video editor did not answer ${name} in ${Math.round(timeoutMs / 1000)} seconds. That means it was slow, not that it failed: the step may still be done. Read the timeline with video_look before you repeat it.`));
    }, timeoutMs);
    const entry: Pending = { session, resolve, reject, timer, claimed: false };
    pending.set(id, entry);
    const send = () => pushed(session, { type: "opencut.command", session, id, name, args });
    send();
    /* A window that has only just mounted hears the command before its editor is up and lets it go by; it is sent
       again until one takes it. (Taking is atomic, so a command is only ever done once.) */
    const again = setInterval(() => {
      if (entry.claimed || !pending.has(id)) clearInterval(again);
      else send();
    }, 1500);
    const settle = entry.resolve;
    entry.resolve = (v) => { clearInterval(again); settle(v); };
    const refuse = entry.reject;
    entry.reject = (e) => { clearInterval(again); refuse(e); };
  });
}

/** One-use links the window fetches a file to import from, so the bytes come through the app's own routes. */
const sources = new Map<string, { file: string; name: string; mime: string; session: string; until: number }>();

const MIME: Record<string, string> = {
  ".mp4": "video/mp4", ".m4v": "video/mp4", ".mov": "video/quicktime", ".webm": "video/webm", ".mkv": "video/x-matroska",
  ".mp3": "audio/mpeg", ".wav": "audio/wav", ".m4a": "audio/mp4", ".aac": "audio/aac", ".ogg": "audio/ogg", ".flac": "audio/flac",
  ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp",
};

// ----------------------------------------------------------------- routes --

type OpencutOptions = {
  exists: (session: string) => boolean;
  push: (session: string, message: Record<string, unknown>) => void;
};

export function opencutRoutes(app: Express, opts: OpencutOptions): void {
  pushed = opts.push;

  const text = express.text({ type: () => true, limit: MAX_JSON });
  const raw = express.raw({ type: () => true, limit: MAX_FILE });
  const known = (req: Request, res: Response): string | null => {
    const session = String(req.query.session ?? "");
    if (!session || !opts.exists(session)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    return session;
  };

  // What the editor keeps, by the window that holds it. Not under a session:
  // projects belong to the person, and any chat can open any of them.
  app.post("/api/opencut/kv", text, (req: Request, res: Response) => {
    try {
      const body = JSON.parse(typeof req.body === "string" ? req.body : "{}") as Record<string, unknown>;
      res.json({ value: kv(body) });
    } catch (err: any) {
      res.status(400).json({ error: { message: String(err?.message ?? err) } });
    }
  });

  app.put("/api/opencut/file", raw, (req: Request, res: Response) => {
    const ns = safeNs(req.query.ns);
    const key = safeKey(req.query.key);
    if (!ns || !key || !ns.startsWith("files/") || ns.includes("*") || !Buffer.isBuffer(req.body)) {
      return res.status(400).json({ error: { message: "bad file" } });
    }
    const meta: FileMeta = {
      name: String(req.query.name ?? key).slice(0, 255),
      type: String(req.query.type ?? "").slice(0, 100),
      lastModified: Number(req.query.modified) || Date.now(),
    };
    try {
      const dir = nsDir(ns);
      writeAtomic(path.join(dir, `${key}.bin`), req.body);
      writeAtomic(path.join(dir, `${key}.meta.json`), JSON.stringify(meta));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: { message: String(err?.message ?? err) } });
    }
  });

  app.get("/api/opencut/file", (req: Request, res: Response) => {
    const ns = safeNs(req.query.ns);
    const key = safeKey(req.query.key);
    if (!ns || !key || !ns.startsWith("files/") || ns.includes("*")) return res.status(400).json({ error: "bad file" });
    const dir = nsDir(ns);
    const file = path.join(dir, `${key}.bin`);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "none" });
    const meta = (readJson(path.join(dir, `${key}.meta.json`)) ?? {}) as Partial<FileMeta>;
    // The bytes are the person's own media; they are only ever read by the editor, never rendered as a page.
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("X-Opencut-Meta", encodeURIComponent(JSON.stringify({ name: meta.name ?? key, type: meta.type ?? "", lastModified: meta.lastModified ?? 0 })));
    res.setHeader("Access-Control-Expose-Headers", "X-Opencut-Meta");
    fs.createReadStream(file).pipe(res);
  });

  // The window's own state.
  app.post("/api/opencut/ready", (req: Request, res: Response) => {
    const session = known(req, res);
    if (!session) return;
    const w = win(session);
    // A window that has just mounted says false: its frame is not up, whatever an earlier one said.
    w.ready = req.body?.ready !== false;
    res.json({ ok: true });
  });

  app.post("/api/opencut/state", (req: Request, res: Response) => {
    const session = known(req, res);
    if (!session) return;
    const w = win(session);
    const id = typeof req.body?.projectId === "string" ? req.body.projectId : null;
    const name = typeof req.body?.name === "string" ? req.body.name.slice(0, 200) : null;
    if (w.projectId !== id || w.name !== name) {
      w.projectId = id;
      w.name = name;
      changed(session);
    }
    res.json({ ok: true });
  });

  // The person opens it themselves (the wrench): the editor starts on the project it last had, or a new one.
  app.post("/api/opencut/open", (req: Request, res: Response) => {
    const session = known(req, res);
    if (!session) return;
    setOpen(session, true);
    res.json({ ok: true });
  });

  app.post("/api/opencut/close", (req: Request, res: Response) => {
    const session = known(req, res);
    if (!session) return;
    setOpen(session, false);
    res.json({ ok: true });
  });

  /* The same chat can be open in two tabs and both get the command: the first to ask does it. */
  app.post("/api/opencut/claim", (req: Request, res: Response) => {
    const session = known(req, res);
    if (!session) return;
    const p = pending.get(String(req.query.id ?? ""));
    const won = !!p && p.session === session && !p.claimed;
    if (won && p) p.claimed = true;
    res.json({ won });
  });

  app.post("/api/opencut/reply", (req: Request, res: Response) => {
    const session = known(req, res);
    if (!session) return;
    const p = pending.get(String(req.body?.id ?? ""));
    if (p && p.session === session) {
      clearTimeout(p.timer);
      pending.delete(String(req.body.id));
      if (req.body.ok) p.resolve(req.body.value);
      else p.reject(new Error(String(req.body?.value?.message ?? "The editor could not do that.")));
    }
    res.json({ ok: true });
  });

  // A finished export, from the editor, kept as an artifact the person can open and download.
  app.post("/api/opencut/deliver", raw, (req: Request, res: Response) => {
    const session = known(req, res);
    if (!session) return;
    if (!Buffer.isBuffer(req.body) || req.body.byteLength === 0) return res.status(400).json({ error: { message: "empty" } });
    if (req.body.byteLength > MAX_ARTIFACT_BYTES) {
      return res.status(413).json({
        error: { message: `The export is ${Math.round(req.body.byteLength / 1024 / 1024)} MB; saved files are capped at ${MAX_ARTIFACT_BYTES / 1024 / 1024} MB. Export again at a lower quality, or use the editor's Export button to download it.` },
      });
    }
    const art = saveArtifact({
      origin: "agent", name: String(req.query.name ?? "video.mp4"), data: req.body,
      mime: String(req.query.mime ?? "video/mp4"), session, note: "Exported from Autora Video",
    });
    res.json({ artifact: art.id, name: art.name, size: art.size, mime: art.mime });
  });

  // A file for the editor to import, fetched by the window with the link `video_import` made.
  app.get("/api/opencut/source/:token", (req: Request, res: Response) => {
    const session = known(req, res);
    if (!session) return;
    const found = sources.get(String(req.params.token));
    if (!found || found.session !== session || found.until < Date.now()) return res.status(404).json({ error: "expired" });
    res.setHeader("Content-Type", found.mime || "application/octet-stream");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.setHeader("X-Content-Type-Options", "nosniff");
    fs.createReadStream(found.file).pipe(res);
  });

  app.get("/api/opencut/projects", (_req: Request, res: Response) => {
    res.json({ projects: listProjects() });
  });
}

/** The editor's own files, served to the frame that holds it.
 *
 * Like Spectra's (server/spectra.ts): the frame is sandboxed by its `sandbox`
 * attribute -- no origin of its own, so no way to Autora's API -- and what is
 * set here is the policy's other half. The editor needs its scripts, its
 * stylesheet, its WebAssembly, workers made from blobs, and images and video
 * from blobs and data; and `connect-src` stays on this host, so it can fetch
 * its own files and nothing else. */
export function serveOpencut(app: Express, dist: string): void {
  app.use("/opencut-editor", (_req: Request, res: Response, next: NextFunction) => {
    // Module scripts in a frame with no origin are fetched CORS-style.
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval' blob:",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "media-src 'self' blob: data:",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        "connect-src 'self' blob: data:",
      ].join("; "),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  }, ...staticDir(path.join(dist, "opencut-editor"), { fallthrough: false }));
}

/** The chat was deleted: nothing of the window is kept for it. */
export function dropOpencut(session: string): void {
  rejectAll(session, "The chat was closed.");
  wins.delete(session);
  for (const [token, s] of sources) if (s.session === session) sources.delete(token);
}

/** What the agent is told at the start of a turn when a video is open. */
export function videoBriefing(session: string): string | null {
  const w = wins.get(session);
  if (!w?.open) return null;
  return `The video window is open${w.name ? ` on the project "${w.name}"` : ""}. video_look shows the timeline; video_edit changes it.`;
}

// ------------------------------------------------------------------ tools --

type VideoContext = {
  session: string;
  cwd: string;
  /** Why the person's hold on the window stops this (server/presence.ts), or null. */
  held?: (subject: string) => string | null;
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
  putBlob?: (data: Buffer, mime: string) => string;
  showImage?: (blob: string, alt: string, caption: string | null, size?: { w: number; h: number }) => void;
  cancelled: () => boolean;
};

type VideoOutcome = { ok: boolean; summary: string; preview?: string; held?: boolean; images?: ChatImage[] };

type Clip = {
  id: string; type: string; name: string; start: number; duration: number; trimStart: number; trimEnd: number; mediaId?: string; text?: string;
  effects?: Array<{ id: string; type: string; enabled: boolean }>; mask?: { id: string; type: string };
  keyframes?: Array<{ property: string; keys: Array<{ id: string; at: number }> }>; speed?: number; hidden?: boolean;
};
type Snapshot = {
  project: { id: string; name: string };
  canvas: { width: number; height: number };
  fps: unknown;
  duration: number;
  playhead: number;
  playing: boolean;
  tracks: Array<{ id: string; type: string; name: string; clips: Clip[] }>;
  media: Array<{ id: string; name: string; type: string; duration: number | null; width: number | null; height: number | null }>;
};

const fmt = (s: number) => `${(Math.round(s * 100) / 100).toFixed(2)}s`;

function fpsText(fps: unknown): string {
  if (typeof fps === "number") return `${fps}`;
  if (fps && typeof fps === "object") {
    const f = fps as { numerator?: number; denominator?: number };
    if (f.numerator && f.denominator) return `${Math.round((f.numerator / f.denominator) * 100) / 100}`;
  }
  return "?";
}

/** The timeline, in words the agent can act on: every id it needs to name a clip. */
function describe(s: Snapshot): string {
  const lines = [
    `Project "${s.project.name}" (${s.project.id}): ${s.canvas.width}x${s.canvas.height} at ${fpsText(s.fps)} fps, ${fmt(s.duration)} long; playhead at ${fmt(s.playhead)}.`,
  ];
  if (s.media.length) {
    lines.push("Media in the project:");
    for (const m of s.media) {
      lines.push(`  ${m.id}  ${m.type} "${m.name}"${m.duration ? ` ${fmt(m.duration)}` : ""}${m.width ? ` ${m.width}x${m.height}` : ""}`);
    }
  } else {
    lines.push("No media imported yet (video_import).");
  }
  const used = s.tracks.filter((t) => t.clips.length);
  if (!used.length) lines.push("The timeline is empty.");
  for (const t of used) {
    lines.push(`Track ${t.id} (${t.type}${t.name ? `, "${t.name}"` : ""}):`);
    for (const c of t.clips) {
      const extra = c.type === "text" ? ` text "${String(c.text ?? "").slice(0, 80)}"` : c.mediaId ? ` of ${c.mediaId}` : "";
      lines.push(`  ${c.id}  ${c.type} "${c.name}"${extra}  ${fmt(c.start)} to ${fmt(c.start + c.duration)}${c.trimStart || c.trimEnd ? ` (source in ${fmt(c.trimStart)}, out-trim ${fmt(c.trimEnd)})` : ""}${c.hidden ? " [hidden]" : ""}${c.speed ? ` [speed ${c.speed}x]` : ""}`);
      for (const e of c.effects ?? []) lines.push(`      effect ${e.id} ${e.type}${e.enabled ? "" : " (off)"}`);
      if (c.mask) lines.push(`      mask ${c.mask.id} ${c.mask.type}`);
      for (const k of c.keyframes ?? []) lines.push(`      keyframes ${k.property}: ${k.keys.map((x) => `${x.id} at ${fmt(x.at)}`).join(", ")}`);
    }
  }
  return lines.join("\n");
}

const need = (args: Record<string, any>, key: string): string => {
  const v = args[key];
  if (typeof v !== "string" || !v.trim()) throw new Error(`${key} is required`);
  return v.trim();
};
/** Which project the person means by what the agent said: an id, or part of a name. */
function findProject(ref: string): { id: string; name: string } | null {
  const all = listProjects();
  return all.find((p) => p.id === ref) ?? all.find((p) => p.name.toLowerCase() === ref.toLowerCase()) ?? all.find((p) => p.name.toLowerCase().includes(ref.toLowerCase())) ?? null;
}

/** What each tool's `action` may be. A name here is also a command the editor understands (opencut-editor/src/autora/). */
const EDIT_ACTIONS = [
  "add_clip", "add_text", "add_sticker", "add_graphic", "add_effect_layer", "add_subtitles", "split", "trim", "move", "delete",
  "duplicate", "set", "select", "copy", "paste", "toggle_visibility", "toggle_mute", "seek", "play", "pause", "undo", "redo", "rename",
] as const;
const STYLE_ACTIONS = [
  "effect_add", "effect_set", "effect_toggle", "effect_remove", "effect_reorder", "mask_add", "mask_set", "mask_invert", "mask_remove",
  "keyframe_set", "keyframe_remove", "keyframe_move", "keyframes", "retime", "separate_audio",
] as const;
const PROJECT_ACTIONS = [
  "track_add", "track_remove", "track_mute", "track_hide", "scene_list", "scene_create", "scene_rename", "scene_switch", "scene_delete",
  "bookmark_toggle", "bookmark_set", "bookmark_move", "bookmark_remove", "settings", "media_remove", "project_list", "project_delete",
  "project_duplicate", "action", "panel",
] as const;
const UI_ACTIONS = ["read", "click", "type", "commit", "press", "drag", "scroll"] as const;

/** An answer from the editor, in words: the timeline when it sent one, otherwise what it sent. */
function said(result: unknown): string {
  if (result && typeof result === "object" && "tracks" in result && "project" in result) {
    // What else the editor said with the timeline (the id of the effect it just made, say) goes with it.
    const { tracks: _t, project: _p, canvas: _c, fps: _f, duration: _d, playhead: _h, playing: _g, media: _m, ...rest } = result as Record<string, unknown>;
    return describe(result as Snapshot) + (Object.keys(rest).length ? `\n${JSON.stringify(rest)}` : "");
  }
  const text = JSON.stringify(result, null, 1) ?? "";
  return text.length > 6000 ? `${text.slice(0, 6000)}\n[cut: ${text.length - 6000} more characters]` : text;
}

function controls(result: unknown): string {
  const r = result as { scope?: string; controls?: Array<{ ref: number; role: string; label: string; value?: string; state?: string }>; messages?: string[]; clicked?: boolean };
  if (!r || !Array.isArray(r.controls)) return said(result);
  const lines = [`On screen (${r.scope ?? "the editor"}), ${r.controls.length} controls. Name one by its ref or its label:`];
  for (const c of r.controls) lines.push(`  [${c.ref}] ${c.role} "${c.label}"${c.value !== undefined ? ` = ${JSON.stringify(c.value)}` : ""}${c.state ? ` (${c.state})` : ""}`);
  if (r.messages?.length) lines.push(`Messages on screen: ${r.messages.join(" | ")}`);
  return lines.join("\n");
}

export async function runVideoTool(name: string, args: Record<string, any>, ctx: VideoContext): Promise<VideoOutcome> {
  try {
    const blocked = name === "video_look" || name === "video_catalog" || name === "video_frame" || (name === "video_ui" && args.action === "read") ? null : ctx.held?.("*") ?? null;
    if (blocked) return { ok: false, held: true, summary: blocked };

    switch (name) {
      case "video_open": {
        if (typeof args.new === "string" && args.new.trim()) {
          await command(ctx.session, "new_project", { name: args.new.trim() });
        } else if (typeof args.project === "string" && args.project.trim()) {
          const found = findProject(args.project.trim());
          if (!found) {
            const have = listProjects();
            return { ok: false, summary: `There is no video project "${args.project}".${have.length ? ` There are: ${have.slice(0, 12).map((p) => `${p.name} (${p.id})`).join("; ")}.` : " There are none yet; pass new to make one."}` };
          }
          await command(ctx.session, "open_project", { projectId: found.id });
        } else {
          await command(ctx.session, "state"); // Just open the window on whatever it last had.
        }
        await sleep(400); // The editor swaps projects after the command answers.
        const snap = (await command(ctx.session, "state")) as Snapshot;
        return { ok: true, summary: describe(snap), preview: `opened "${snap.project.name}"` };
      }

      case "video_look": {
        const snap = (await command(ctx.session, "state")) as Snapshot;
        const others = listProjects().filter((p) => p.id !== snap.project.id).slice(0, 8);
        return {
          ok: true,
          summary: describe(snap) + (others.length ? `\nOther projects: ${others.map((p) => `${p.name} (${p.id})`).join("; ")}.` : ""),
          preview: `"${snap.project.name}", ${fmt(snap.duration)}`,
        };
      }

      case "video_import": {
        const given = need(args, "file");
        const art = /^file_[0-9a-f]{16}$/.test(given) ? getArtifact(given) : null;
        let file = art ? artifactPath(art.id) : path.resolve(ctx.cwd, given);
        if (!art && !fs.existsSync(file)) {
          const named = fs.existsSync(path.resolve(ctx.cwd, path.basename(given))) ? path.resolve(ctx.cwd, path.basename(given)) : null;
          if (!named) return { ok: false, summary: `There is no file "${given}": give an artifact id (file_...) or a path on this host.` };
          file = named;
        }
        const stat = fs.statSync(file);
        if (!stat.isFile()) return { ok: false, summary: `${file} is not a file.` };
        if (stat.size > MAX_FILE) return { ok: false, summary: `${file} is too large to import.` };
        const fileName = String(args.name ?? art?.name ?? path.basename(file)).slice(0, 200);
        const mime = MIME[path.extname(fileName).toLowerCase()] ?? art?.mime ?? "";
        if (!/^(video|audio|image)\//.test(mime)) {
          return { ok: false, summary: `${fileName} is not a video, audio or image file the editor can use (mp4, mov, webm, mp3, wav, m4a, png, jpg, gif, webp...).` };
        }
        const token = crypto.randomBytes(16).toString("hex");
        sources.set(token, { file, name: fileName, mime, session: ctx.session, until: Date.now() + 10 * 60_000 });
        try {
          const added = (await command(ctx.session, "import_media", { sourceToken: token, name: fileName, mime }, 10 * 60_000)) as { id: string; name: string; type: string; duration: number | null };
          return { ok: true, summary: `Imported ${added.type} "${added.name}" as ${added.id}${added.duration ? ` (${fmt(added.duration)})` : ""}. Put it on the timeline with video_edit add_clip (mediaId ${added.id}).`, preview: `imported ${added.name}` };
        } finally {
          sources.delete(token);
        }
      }

      case "video_edit":
      case "video_style":
      case "video_project": {
        const list: readonly string[] = name === "video_edit" ? EDIT_ACTIONS : name === "video_style" ? STYLE_ACTIONS : PROJECT_ACTIONS;
        const action = need(args, "action");
        if (!list.includes(action)) return { ok: false, summary: `action is one of: ${list.join(", ")}.` };
        const payload: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) if (k !== "action" && v !== undefined && v !== null) payload[k] = v;
        if (action === "delete" && typeof args.elementId === "string") payload.elementIds = [args.elementId];
        // `set` is a change to a clip's own properties; the editor calls it set_params.
        const result = await command(ctx.session, action === "set" ? "set_params" : action, payload, action === "paste" ? 30_000 : 60_000);
        return { ok: true, summary: `Done (${action}).\n${said(result)}`, preview: action };
      }

      case "video_ui": {
        const action = need(args, "action");
        if (!(UI_ACTIONS as readonly string[]).includes(action)) return { ok: false, summary: `action is one of: ${UI_ACTIONS.join(", ")}.` };
        const payload: Record<string, unknown> = {};
        for (const [k, v] of Object.entries(args)) if (k !== "action" && v !== undefined && v !== null) payload[k] = v;
        const result = await command(ctx.session, `ui_${action}`, payload, 60_000);
        return { ok: true, summary: action === "read" || action === "click" ? controls(result) : `Done (${action}).${result && typeof result === "object" && Object.keys(result).length ? `\n${said(result)}` : ""}`, preview: `${action}${args.label ? ` ${String(args.label).slice(0, 30)}` : args.ref !== undefined ? ` [${args.ref}]` : ""}` };
      }

      case "video_catalog": {
        const topic = need(args, "topic");
        const result = await command(ctx.session, "catalog", { topic, query: typeof args.query === "string" ? args.query : typeof args.elementId === "string" ? args.elementId : "" });
        return { ok: true, summary: said(result), preview: `catalog ${topic}` };
      }

      case "video_frame": {
        const got = (await command(ctx.session, "frame", { ...(args.time !== undefined ? { time: Number(args.time) } : {}), width: Number(args.width) || 640 }, 90_000)) as { png: string; width: number; height: number; time: number };
        const data = Buffer.from(got.png, "base64");
        if (data.byteLength === 0) return { ok: false, summary: "The editor could not draw that frame." };
        if (ctx.putBlob && ctx.showImage) ctx.showImage(ctx.putBlob(data, "image/png"), `Frame at ${fmt(got.time)}`, `Frame at ${fmt(got.time)}`, { w: got.width, h: got.height });
        return { ok: true, summary: `The frame at ${fmt(got.time)} (${got.width}x${got.height}) is in this result and shown in the conversation.`, preview: `frame at ${fmt(got.time)}`, images: [{ mime: "image/png", data: got.png }] };
      }

      case "video_export": {
        const format = args.format === "webm" ? "webm" : "mp4";
        const quality = ["low", "medium", "high", "very_high"].includes(String(args.quality)) ? String(args.quality) : "high";
        const out = (await command(ctx.session, "export", { format, quality, audio: args.audio !== false }, 30 * 60_000)) as { file: string; artifact: string; bytes: number };
        const art = getArtifact(out.artifact);
        if (art) ctx.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
        return { ok: true, summary: `Exported ${out.file} (${Math.round(out.bytes / 1024 / 1024 * 10) / 10} MB) as artifact ${out.artifact}; the person can open and download it from the thread.`, preview: `exported ${out.file}` };
      }

      default:
        return { ok: false, summary: `Unknown video tool: ${name}` };
    }
  } catch (err: any) {
    return { ok: false, summary: String(err?.message ?? err) };
  }
}
