/**
 * Autora Photo: the photo editing window, and the agent's hands on the same picture.
 *
 * Autora Photo is PhotoCraft (github.com/storytold/photocraft, MIT or Apache-2.0), an image editor written in Rust, built by
 * scripts/build-photo.mjs from the commit in photo/PIN.json into dist/photo/. It is two programs:
 *
 *   - its editor, WebAssembly in a frame beside the conversation (components/PhotoWindow.tsx), which the person works in:
 *     layers, masks, adjustment layers, type, brushes, filters, real PSD files;
 *   - its headless command line (`photocraft-cli serve`), which the agent's `photo_*` tools run: the same command
 *     registry the editor's menus call, so anything a person can click the agent can do.
 *
 * They share one file per chat, `work.pcraft` (PhotoCraft's own layered format), kept on this server:
 *
 *   - the agent's tools open it, change it and save it (`runPhotoTool`), and the window is told, and reloads it;
 *   - the person works in the window as in the app on its own, and a moment after they stop the editor sends the file
 *     back (`PUT /api/photo/:session/doc`), so the agent's next call sees what they did.
 *
 * Who made a change travels with it (`by`): the window reloads the picture for the agent's changes and never for its own
 * person's, so a brush stroke in progress is not interrupted by an echo of itself.
 *
 * The editor is a page of this origin in a frame (served below with a CSP); the window talks to it by postMessage only.
 * The command line gets a folder of its own per chat as its only file access.
 */
import { execFile } from "node:child_process";
import crypto from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { saveArtifact } from "./artifacts";
import { readFileRef, FileRefError } from "./fileref";
import type { ChatImage } from "./llm";
import { stateDir } from "./state";
import { staticDir } from "./staticfiles";

const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

/** The folder of a chat's picture: the working file, and whatever the command line is handed to read. */
const folder = (session: string) => path.join(stateDir(), "photo", session);
const WORK = "work.pcraft";
const workFile = (session: string) => path.join(folder(session), WORK);

/** Large enough for a photograph in layers; the editor itself holds the picture in memory too. */
const MAX_DOC = 512 * 1024 * 1024;

// ---------------------------------------------------------------- the build --

/** Where the build is: AUTORA_PHOTO_DIR, or dist/photo beside the server. */
function photoDir(): string | null {
  const dirs = [process.env.AUTORA_PHOTO_DIR, path.join(process.cwd(), "dist", "photo")].filter((d): d is string => Boolean(d));
  return dirs.find((d) => fs.existsSync(path.join(d, "web", "index.html")) || fs.existsSync(path.join(d, "native"))) ?? null;
}

/** The editor, built. */
const hasEditor = (): boolean => {
  const dir = photoDir();
  return Boolean(dir && fs.existsSync(path.join(dir, "web", "index.html")));
};

/** PhotoCraft's command line, built for this CPU (or for this machine). */
function cliFile(): string | null {
  const dir = photoDir();
  if (!dir) return null;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return [`photocraft-cli-${arch}`, "photocraft-cli"].map((n) => path.join(dir, "native", n)).find((p) => fs.existsSync(p)) ?? null;
}

/** Whether the photo tools can work: the editor and the command line are both built into this server. */
export const photoAvailable = (): boolean => hasEditor() && cliFile() !== null;

// -------------------------------------------------------------------- state --

/** What the page knows about the window. */
interface PhotoState {
  open: boolean;
  /** When it was opened, which orders it among the other windows. */
  since?: number;
  /** Goes up on every change to the picture, by anyone. */
  rev?: number;
  /** Who made the latest change. */
  by?: "agent" | "person";
  /** The picture's size and layer count, once there is one. */
  size?: { w: number; h: number };
  layers?: number;
}

interface Entry {
  open: boolean;
  since: number;
  rev: number;
  by: "agent" | "person";
  size?: { w: number; h: number };
  layers?: number;
  /** What the agent is doing, for the window to show: the tool, and a number that goes up per call. */
  cue: { seq: number; tool: string } | null;
  /** Calls to the command line for this chat, one at a time. */
  line: Promise<unknown>;
}

const entries = new Map<string, Entry>();
const listeners = new Set<(session: string) => void>();

const stateFile = (session: string) => path.join(folder(session), "state.json");

function entryFor(session: string): Entry {
  let entry = entries.get(session);
  if (!entry) {
    let saved: { open?: boolean; since?: number; size?: { w: number; h: number }; layers?: number } = {};
    if (validSession(session)) {
      try {
        saved = JSON.parse(fs.readFileSync(stateFile(session), "utf8"));
      } catch {
        // no state yet
      }
    }
    entry = { open: Boolean(saved.open), since: saved.since ?? 0, rev: 0, by: "agent", size: saved.size, layers: saved.layers, cue: null, line: Promise.resolve() };
    entries.set(session, entry);
  }
  return entry;
}

function remember(session: string) {
  const e = entryFor(session);
  try {
    fs.mkdirSync(folder(session), { recursive: true, mode: 0o700 });
    fs.writeFileSync(stateFile(session), JSON.stringify({ open: e.open, since: e.since, size: e.size, layers: e.layers }), { mode: 0o600 });
  } catch {
    // The window works without it; it only forgets that it was open.
  }
}

function changed(session: string) {
  for (const fn of listeners) fn(session);
}

function setOpen(session: string, open: boolean) {
  const e = entryFor(session);
  if (e.open === open) return;
  e.open = open;
  e.since = open ? Date.now() : e.since;
  remember(session);
  changed(session);
}

export function photoState(session: string): PhotoState {
  if (!validSession(session)) return { open: false };
  const e = entryFor(session);
  if (!e.open) return { open: false };
  return { open: true, since: e.since, rev: e.rev, by: e.by, ...(e.size ? { size: e.size } : {}), ...(e.layers !== undefined ? { layers: e.layers } : {}) };
}

/** Told after every change to a chat's window or picture, so the page can be told. */
export function onPhotoChange(fn: (session: string) => void) {
  listeners.add(fn);
}

/** The chat is gone: let go of its picture. */
export function dropPhoto(session: string) {
  entries.delete(session);
  if (!validSession(session)) return;
  fs.rmSync(folder(session), { recursive: true, force: true });
}

// ------------------------------------------------------------ the command line --

interface Reply {
  id: number;
  ok: boolean;
  result?: any;
  error?: string;
}

/**
 * One batch of requests to a fresh `photocraft-cli serve`, whose only file access is the chat's folder: the requests go
 * in as lines, and the answers come back by id. The process lives for the call. Resolves with the answers in order;
 * a request that failed has `ok: false`, and later ones still ran.
 */
function serve(session: string, requests: Array<{ method: string; params?: unknown }>, opts: { timeoutMs?: number } = {}): Promise<Reply[]> {
  const exe = cliFile();
  if (!exe) return Promise.reject(new Error("Autora Photo's command line is not built into this server."));
  const dir = folder(session);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const input = requests.map((r, i) => JSON.stringify({ id: i + 1, method: r.method, params: r.params ?? {} })).join("\n") + "\n";
  return new Promise((resolve, reject) => {
    const child = execFile(
      exe,
      ["serve", "--automation-read-root", dir, "--automation-write-root", dir],
      { cwd: dir, timeout: opts.timeoutMs ?? 180_000, maxBuffer: 256 * 1024 * 1024, env: { ...process.env, HOME: dir } },
      (err, stdout, stderr) => {
        const replies: Reply[] = [];
        for (const line of String(stdout).split("\n")) {
          const text = line.trim();
          if (!text.startsWith("{")) continue;
          try {
            replies.push(JSON.parse(text) as Reply);
          } catch {
            // not a reply
          }
        }
        if (replies.length === 0 && err) return reject(new Error(String(stderr).trim().slice(-600) || err.message));
        replies.sort((a, b) => a.id - b.id);
        resolve(replies);
      },
    );
    child.stdin?.end(input);
  });
}

/** The command line's calls for one chat run one after another, so two never open the same file at once. */
function inLine<T>(session: string, work: () => Promise<T>): Promise<T> {
  const e = entryFor(session);
  const next = e.line.then(work, work);
  e.line = next.catch(() => undefined);
  return next;
}

const first = (replies: Reply[], what: string): any => {
  const r = replies[0];
  if (!r) throw new Error(`${what}: the command line gave no answer.`);
  if (!r.ok) throw new Error(`${what}: ${r.error ?? "it did not work."}`);
  return r.result;
};

/** What the picture is, from `doc.inspect`: its size, mode and the layers as a tree of one line each. */
interface Inspected {
  name?: string;
  size?: { width: number; height: number };
  width?: number;
  height?: number;
  layers?: unknown[];
  [k: string]: unknown;
}

function sizeOf(doc: Inspected): { w: number; h: number } | undefined {
  const w = doc.size?.width ?? doc.width;
  const h = doc.size?.height ?? doc.height;
  return typeof w === "number" && typeof h === "number" ? { w, h } : undefined;
}

function countLayers(layers: unknown): number {
  if (!Array.isArray(layers)) return 0;
  let n = 0;
  for (const l of layers) {
    n += 1;
    if (l && typeof l === "object") n += countLayers((l as { children?: unknown }).children);
  }
  return n;
}

/** Note a new state of the picture: from the agent's tools, or from the person's window. */
function noteChange(session: string, by: "agent" | "person", doc?: Inspected) {
  const e = entryFor(session);
  e.rev += 1;
  e.by = by;
  if (doc) {
    e.size = sizeOf(doc) ?? e.size;
    e.layers = countLayers(doc.layers);
  }
  remember(session);
  changed(session);
}

// -------------------------------------------------------------------- tools --

/** The most a tool result may say, in characters: a layer tree or the command list can be large. */
const MOST = 20_000;

const cut = (text: string, hint: string) => (text.length > MOST ? `${text.slice(0, MOST)}\n[cut: ${text.length} characters. ${hint}]` : text);

const FORMATS: Record<string, { mime: string; ext: string }> = {
  png: { mime: "image/png", ext: "png" },
  jpg: { mime: "image/jpeg", ext: "jpg" },
  jpeg: { mime: "image/jpeg", ext: "jpg" },
  webp: { mime: "image/webp", ext: "webp" },
  tif: { mime: "image/tiff", ext: "tif" },
  tiff: { mime: "image/tiff", ext: "tif" },
  psd: { mime: "image/vnd.adobe.photoshop", ext: "psd" },
  pcraft: { mime: "application/octet-stream", ext: "pcraft" },
};

interface PhotoHooks {
  /** Show a saved file in the thread. */
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
  /** Show a picture in the thread. */
  showImage?: (data: Buffer, alt: string, size?: { w: number; h: number }) => void;
  /** A folder to read relative file names in. */
  cwd: string;
}

type PhotoOutcome = { ok: boolean; summary: string; preview?: string; images?: ChatImage[] };

const hasPicture = (session: string) => fs.existsSync(workFile(session));

/** The name a file is saved under: safe, with the extension its format needs. */
function exportName(wanted: unknown, ext: string, fallback: string): string {
  const base = (typeof wanted === "string" && wanted.trim() ? wanted.trim() : fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\.(png|jpe?g|webp|tiff?|psd|pcraft)$/i, "")
    .slice(0, 80);
  return `${base || fallback}.${ext}`;
}

/**
 * Runs one `photo_*` tool on the chat's picture and opens the window, so the person watches it happen.
 * Never throws: a bad call comes back as { ok: false, summary } saying what was wrong and what to try.
 */
export async function runPhotoTool(session: string, tool: string, args: Record<string, any>, hooks: PhotoHooks): Promise<PhotoOutcome> {
  if (!validSession(session)) return { ok: false, summary: "Autora Photo needs a chat to work in." };
  if (!photoAvailable()) return { ok: false, summary: "Autora Photo is not built into this server." };
  try {
    return await inLine(session, async () => {
      const mine = entryFor(session);
      mine.cue = { seq: (mine.cue?.seq ?? 0) + 1, tool: tool.slice(6) };
      const none = "There is no picture yet. Open one with photo_open (a file, or `new` for a blank canvas).";

      switch (tool) {
        case "photo_open": {
          fs.mkdirSync(folder(session), { recursive: true, mode: 0o700 });
          if (args.file !== undefined && args.new !== undefined) return { ok: false, summary: "Give either `file` or `new`, not both." };
          if (args.file !== undefined) {
            const given = readFileRef(args.file, hooks.cwd, "the picture", "photo_open");
            if (given.data.length > MAX_DOC) return { ok: false, summary: "That file is too large for Autora Photo." };
            const ext = (path.extname(given.name).slice(1) || "png").toLowerCase().replace(/[^a-z0-9]/g, "").slice(0, 8) || "png";
            const input = `in-${crypto.randomBytes(4).toString("hex")}.${ext}`;
            fs.writeFileSync(path.join(folder(session), input), given.data, { mode: 0o600 });
            try {
              const r = await serve(session, [
                { method: "doc.open", params: { path: input } },
                { method: "doc.save", params: { path: WORK } },
                { method: "doc.inspect" },
              ]);
              first(r, `Could not open ${given.name}`);
              first(r.slice(1), "Could not keep the picture");
              const doc = first(r.slice(2), "Could not read the picture") as Inspected;
              mine.by = "agent";
              setOpen(session, true);
              noteChange(session, "agent", doc);
              return { ok: true, summary: `Opened ${given.name} in Autora Photo.\n${cut(JSON.stringify(doc), "photo_info lists the layers.")}`, preview: given.name };
            } finally {
              fs.rmSync(path.join(folder(session), input), { force: true });
            }
          }
          if (args.new !== undefined) {
            const n = (args.new && typeof args.new === "object" ? args.new : {}) as Record<string, unknown>;
            const params = {
              width: Math.min(Math.max(Math.round(Number(n.width) || 1920), 1), 16384),
              height: Math.min(Math.max(Math.round(Number(n.height) || 1080), 1), 16384),
              mode: "rgb",
              depth: 8,
              background: typeof n.background === "string" ? n.background : "white",
            };
            const r = await serve(session, [{ method: "doc.new", params }, { method: "doc.save", params: { path: WORK } }, { method: "doc.inspect" }]);
            first(r, "Could not make a canvas");
            first(r.slice(1), "Could not keep the picture");
            const doc = first(r.slice(2), "Could not read the picture") as Inspected;
            mine.by = "agent";
            setOpen(session, true);
            noteChange(session, "agent", doc);
            return { ok: true, summary: `A new ${params.width}x${params.height} canvas is open in Autora Photo.`, preview: `${params.width}x${params.height}` };
          }
          // Just the window, on whatever is there.
          mine.by = "agent";
          setOpen(session, true);
          changed(session);
          if (!hasPicture(session)) return { ok: true, summary: `Autora Photo is open, with no picture in it yet. ${none}`, preview: "opened" };
          const r = await serve(session, [{ method: "doc.open", params: { path: WORK } }, { method: "doc.inspect" }]);
          first(r, "Could not open the picture");
          const doc = first(r.slice(1), "Could not read the picture") as Inspected;
          return { ok: true, summary: cut(JSON.stringify(doc), "photo_info lists the layers."), preview: "opened" };
        }

        case "photo_info": {
          if (!hasPicture(session)) return { ok: false, summary: none };
          const r = await serve(session, [{ method: "doc.open", params: { path: WORK } }, { method: "doc.inspect" }]);
          first(r, "Could not open the picture");
          const doc = first(r.slice(1), "Could not read the picture") as Inspected;
          return { ok: true, summary: cut(JSON.stringify(doc), "Ask for less: the layer tree is what is long."), preview: "info" };
        }

        case "photo_look": {
          if (!hasPicture(session)) return { ok: false, summary: none };
          const side = Math.min(Math.max(Math.round(Number(args.max_side) || 1024), 64), 2048);
          const r = await serve(session, [{ method: "doc.open", params: { path: WORK } }, { method: "doc.render", params: { maxSide: side } }, { method: "doc.inspect" }]);
          first(r, "Could not open the picture");
          const shot = first(r.slice(1), "Could not draw the picture") as { base64?: string };
          const doc = first(r.slice(2), "Could not read the picture") as Inspected;
          if (!shot.base64) return { ok: false, summary: "The command line drew nothing." };
          const png = Buffer.from(shot.base64, "base64");
          const size = sizeOf(doc);
          hooks.showImage?.(png, "The picture in Autora Photo", size);
          return {
            ok: true,
            summary: `The picture${size ? ` (${size.w}x${size.h})` : ""} is in this result and shown in the conversation.`,
            preview: "looked",
            images: [{ mime: "image/png", data: shot.base64 }],
          };
        }

        case "photo_commands": {
          const filter = typeof args.filter === "string" ? args.filter.trim() : "";
          const r = await serve(session, [{ method: "engine.commands", params: filter ? { filter } : {} }]);
          const list = first(r, "Could not list the commands");
          const rows: unknown[] = Array.isArray(list) ? list : Array.isArray(list?.commands) ? list.commands : [];
          const lines = rows.map((c: any) => {
            const params = c?.params && typeof c.params === "object" ? JSON.stringify(c.params) : c?.params ? String(c.params) : "";
            return `${c?.id ?? "?"}${c?.label ? ` -- ${c.label}` : ""}${params && params !== "{}" ? ` ${params}` : ""}${c?.enabled === false ? " [not available now]" : ""}`;
          });
          if (lines.length === 0) return { ok: true, summary: filter ? `No command matches "${filter}".` : "No commands.", preview: filter || "commands" };
          return { ok: true, summary: cut(lines.join("\n"), "Narrow it with a longer `filter`."), preview: `${lines.length} commands` };
        }

        case "photo_edit": {
          if (!hasPicture(session)) return { ok: false, summary: none };
          const steps = Array.isArray(args.commands) ? args.commands : [];
          if (steps.length === 0) return { ok: false, summary: "photo_edit needs `commands`: a list of { id, params } (photo_commands lists the ids)." };
          if (steps.length > 200) return { ok: false, summary: "At most 200 commands in one call." };
          const batch = steps.map((s: any) => {
            const id = typeof s === "string" ? s : s?.id;
            if (typeof id !== "string" || !id) throw new Error("every command needs an `id`");
            return { command: id, ...(s && typeof s === "object" && s.params && typeof s.params === "object" ? { params: s.params } : {}) };
          });
          const r = await serve(session, [
            { method: "doc.open", params: { path: WORK } },
            { method: "batch", params: { steps: batch, stopOnError: true } },
            { method: "doc.save", params: { path: WORK } },
            { method: "doc.inspect" },
          ]);
          first(r, "Could not open the picture");
          const done = first(r.slice(1), "The edit did not run") as { completed?: number; failed?: number; results?: any[] };
          const results = Array.isArray(done?.results) ? done.results : [];
          const bad = results.findIndex((x: any) => x && (x.ok === false || x.error));
          const said = results.map((x: any, i: number) => `${i + 1}. ${batch[i]?.command ?? "?"}: ${x?.error ? `FAILED -- ${x.error}` : x?.result !== undefined ? JSON.stringify(x.result).slice(0, 300) : "done"}`).join("\n");
          // Whatever ran is kept (the engine stops at the first failure), so the window shows it and the agent can go on from there.
          const saved = r[2]?.ok === true;
          if (saved) {
            const doc = r[3]?.ok ? (r[3].result as Inspected) : undefined;
            mine.by = "agent";
            setOpen(session, true);
            noteChange(session, "agent", doc);
          }
          if (bad >= 0) {
            return { ok: false, summary: `Stopped at command ${bad + 1} (${batch[bad]?.command}).\n${cut(said, "")}\nThe ones before it were applied.`, preview: `stopped at ${batch[bad]?.command}` };
          }
          return { ok: true, summary: `Applied ${batch.length} command${batch.length === 1 ? "" : "s"}.\n${cut(said, "")}\nCall photo_look to see the result.`, preview: batch.length === 1 ? batch[0].command : `${batch.length} commands` };
        }

        case "photo_export": {
          if (!hasPicture(session)) return { ok: false, summary: none };
          const format = String(args.format ?? "png").toLowerCase().replace(/^\./, "");
          const kind = FORMATS[format];
          if (!kind) return { ok: false, summary: `Formats: ${[...new Set(Object.values(FORMATS).map((f) => f.ext))].join(", ")}.` };
          const out = `out-${crypto.randomBytes(4).toString("hex")}.${kind.ext}`;
          const quality = Number(args.quality);
          try {
            const r = await serve(session, [
              { method: "doc.open", params: { path: WORK } },
              { method: "doc.save", params: { path: out, ...(Number.isFinite(quality) && quality >= 1 && quality <= 100 ? { quality: Math.round(quality) } : {}) } },
            ]);
            first(r, "Could not open the picture");
            first(r.slice(1), "Could not export");
            const data = fs.readFileSync(path.join(folder(session), out));
            const art = saveArtifact({
              origin: "agent",
              name: exportName(args.name, kind.ext, "photo"),
              data,
              mime: kind.mime,
              session,
              note: `Exported from Autora Photo as ${kind.ext.toUpperCase()}`,
            });
            hooks.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
            return { ok: true, summary: `Exported the picture as ${art.name} (${data.length} bytes), saved as artifact ${art.id}. The person can download it from the thread.`, preview: art.name };
          } finally {
            fs.rmSync(path.join(folder(session), out), { force: true });
          }
        }

        default:
          return { ok: false, summary: `Unknown tool "${tool}".` };
      }
    });
  } catch (err) {
    const message = err instanceof FileRefError || err instanceof Error ? err.message : String(err);
    return { ok: false, summary: `Autora Photo could not do that: ${message}`, preview: tool.slice(6) };
  }
}

/** The picture for the capability briefing. */
export function photoBriefing(on: boolean): string {
  if (!on) {
    return "- Autora Photo (the photo editing window): switched off on the Tools page. Do not try to edit photos with it, and if asked, say it is off.";
  }
  return (
    "- Autora Photo (the photo editing window, PhotoCraft): available. Tools: photo_open (a file, or `new` for a canvas), photo_look, photo_info, " +
    "photo_edit (a list of commands), photo_commands (find a command id), photo_export. It has layers, masks, adjustment layers, filters, type, " +
    "brushes and real PSD files. Look with photo_look after a change, before you say it is done. The person edits the same picture by hand: " +
    "photo_info again before relying on what you saw. Choices of look, colour and composition are theirs: suggest, ask, and do the technical work."
  );
}

// ------------------------------------------------------------------ routes --

const rawDoc = express.raw({ type: "*/*", limit: MAX_DOC });

/** The window's side of the wire: its state, its picture, and opening and putting it away. */
export function photoRoutes(app: Express, opts: { exists: (session: string) => boolean; incognito: (session: string) => boolean; off: () => boolean }) {
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!validSession(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    if (!hasEditor()) {
      res.status(503).json({ error: "Autora Photo is not built into this server." });
      return null;
    }
    return id;
  };

  app.get("/api/photo/:session", (req, res) => {
    const id = known(req, res);
    if (id) res.json(photoState(id));
  });

  /* The picture, as the editor opens it. */
  app.get("/api/photo/:session/doc", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const file = workFile(id);
    if (!fs.existsSync(file)) return res.status(404).json({ error: "There is no picture yet." });
    const e = entryFor(id);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("Content-Type", "application/octet-stream");
    res.setHeader("X-Photo-Rev", String(e.rev));
    if (e.by === "agent" && e.cue) res.setHeader("X-Photo-Cue", JSON.stringify(e.cue));
    res.send(fs.readFileSync(file));
  });

  /* What the person did in the editor. It must be a PhotoCraft file (the command line opens it, so a malformed one is
     refused here rather than kept), and it replaces the picture. */
  app.put("/api/photo/:session/doc", rawDoc, async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Photo is switched off on the Tools page." });
    const body = req.body as Buffer;
    if (!Buffer.isBuffer(body) || body.length === 0) return res.status(400).json({ error: "That is not a picture." });
    if (!cliFile()) {
      // No command line to check it with: keep it as the editor made it.
      fs.mkdirSync(folder(id), { recursive: true, mode: 0o700 });
      fs.writeFileSync(workFile(id), body, { mode: 0o600 });
      noteChange(id, "person");
      return res.json({ rev: entryFor(id).rev });
    }
    try {
      await inLine(id, async () => {
        fs.mkdirSync(folder(id), { recursive: true, mode: 0o700 });
        const incoming = `put-${crypto.randomBytes(4).toString("hex")}.pcraft`;
        fs.writeFileSync(path.join(folder(id), incoming), body, { mode: 0o600 });
        try {
          const r = await serve(id, [{ method: "doc.open", params: { path: incoming } }, { method: "doc.inspect" }], { timeoutMs: 60_000 });
          first(r, "That is not a PhotoCraft picture");
          const doc = first(r.slice(1), "Could not read the picture") as Inspected;
          fs.renameSync(path.join(folder(id), incoming), workFile(id));
          // Stays "person" until the agent's next tool call says otherwise: that is who made the latest change.
          noteChange(id, "person", doc);
        } finally {
          fs.rmSync(path.join(folder(id), incoming), { force: true });
        }
      });
      res.json({ rev: entryFor(id).rev });
    } catch (err) {
      res.status(400).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* The person opens it from the toolbox: the editor, with whatever picture the chat has. */
  app.post("/api/photo/:session/open", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora Photo is switched off on the Tools page." });
    if (opts.incognito(id)) return res.status(409).json({ error: "An incognito chat keeps nothing, so it has no photo window." });
    setOpen(id, true);
    res.json({ ...photoState(id), name: "Your picture" });
  });

  app.post("/api/photo/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    setOpen(id, false);
    res.json(photoState(id));
  });
}

/**
 * The editor's page, served to the frame that holds it. It is PhotoCraft's own code with Autora's overlay, in a frame of
 * this origin (the window talks to it by postMessage only), so it may be framed by this app and by nothing else, and it
 * may start WebAssembly but reach nothing outside this origin.
 */
export function servePhoto(app: Express, dist: string): void {
  app.use(
    "/autora-photo",
    (_req, res, next) => {
      res.setHeader(
        "Content-Security-Policy",
        [
          "default-src 'self'",
          "script-src 'self' 'wasm-unsafe-eval'",
          "style-src 'self' 'unsafe-inline'",
          "img-src 'self' data: blob:",
          "font-src 'self' data:",
          "worker-src 'self' blob:",
          "connect-src 'self' data: blob:",
          "frame-ancestors 'self'",
        ].join("; "),
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      next();
    },
    ...staticDir(path.join(dist, "photo", "web"), { fallthrough: false }),
  );
}
