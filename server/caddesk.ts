/**
 * Autora 3D: the 3D modelling window, and the agent's hands on the same model.
 *
 * Autora 3D (autora-3d/, a copy of github.com/blofstedt/3D-Modeling built by `npm run build`) is a sketch-and-extrude CAD
 * modeller. Here it is a window beside the conversation, and one model per chat that the agent and the person both work
 * on. The model lives on this server, in the same headless engine the app is built on (dist/autora-3d-engine/):
 *
 *   - the agent's `cad_*` tools run on it (`runCadTool`), and every change is pushed to the window, which shows it;
 *   - the person works in the window as in the app on its own, and what they change goes back here
 *     (`PUT /api/cad/:session/doc`), so the agent's next call sees it.
 *
 * Who made a change travels with it (`by`): the window reloads the model for the agent's changes and never for its
 * own person's, so a drag in progress is not interrupted by an echo of itself.
 *
 * The engine is loaded from its bundle at run time rather than imported: it is the app's own code (three.js, a WebAssembly
 * geometry kernel), built by the autora-3d sub-project, and the server is typechecked without it. Without the build the
 * tools are simply not offered (`cadAvailable`).
 */
import express, { type Express, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { saveArtifact } from "./artifacts";
import { stateDir } from "./state";
import { readDoc, saveDoc } from "./store";
import { staticDir } from "./staticfiles";
import { cadSPECS } from "./specs/cad";

/** What the bundle's `Engine` offers the server (the rest of its API is the tools). */
interface CadEngine {
  execute(name: string, args?: unknown, options?: { ifRevision?: number }): Promise<CadResponse>;
  getDoc(): CadDoc;
  setDoc(doc: CadDoc): void;
  subscribe(fn: (doc: CadDoc, revision: number) => void): () => void;
  toJSON(): CadDoc;
}

interface CadResponse {
  ok: boolean;
  result?: unknown;
  error?: string;
  hint?: string;
  shapes?: unknown[];
  changed: boolean;
  revision: number;
}

/** A model, as the app saves it: shapes, groups, repeats and the project library. */
interface CadDoc {
  bodies: Array<{ repeatOf?: unknown }>;
  groups: unknown[];
  repeats: unknown[];
  library: unknown[];
}

interface CadCore {
  Engine: new (doc?: CadDoc) => CadEngine;
  parseDoc(raw: unknown): CadDoc | null;
  emptyDoc(): CadDoc;
  starterDoc(): CadDoc;
  initManifold(): Promise<void>;
}

/** What the page knows about the window. */
interface CadState {
  open: boolean;
  /** When it was opened, which orders it among the other windows. */
  since?: number;
  /** Goes up on every change to the model, by anyone. */
  rev?: number;
  /** Who made the latest change. */
  by?: "agent" | "person";
  /** Shapes in the model (the copies a repeat makes are not counted). */
  shapes?: number;
}

interface Entry {
  engine: CadEngine | null;
  open: boolean;
  since: number;
  rev: number;
  by: "agent" | "person";
  shapes: number;
  /** What the agent is doing, for the window to show the cursor doing it: the tool, and a number that goes up per call. */
  cue: { seq: number; tool: string } | null;
}

const entries = new Map<string, Entry>();
const listeners = new Set<(session: string) => void>();

const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

/** The engine's bundle, or null when this server was built without Autora 3D. */
function engineFile(): string | null {
  const dirs = [process.env.AUTORA_3D_ENGINE_DIR, path.join(process.cwd(), "dist", "autora-3d-engine")].filter((d): d is string => Boolean(d));
  for (const dir of dirs) {
    const file = path.join(dir, "engine.mjs");
    if (fs.existsSync(file) && fs.existsSync(path.join(dir, "manifold.wasm"))) return file;
  }
  return null;
}

/** Whether the modeller was built into this server. */
export const cadAvailable = (): boolean => engineFile() !== null;

let core: Promise<CadCore> | null = null;

/** The engine's code, loaded once. */
function loadCore(): Promise<CadCore> {
  if (!core) {
    const file = engineFile();
    if (!file) return Promise.reject(new Error("Autora 3D is not built into this server."));
    core = import(pathToFileURL(file).href)
      .then(async (m: CadCore) => {
        // The exact geometry kernel (WebAssembly) wants a moment to start; the engine falls back to a rougher one without it.
        await m.initManifold().catch(() => undefined);
        return m;
      })
      .catch((err) => {
        core = null;
        throw err;
      });
  }
  return core;
}

/** What is kept on disk for a chat: its model, and whether its window was open. */
interface Saved {
  doc: CadDoc;
  open: boolean;
  since: number;
}

const savedName = (session: string) => `cad-${session}`;

const countShapes = (doc: CadDoc | null | undefined) => (doc ? doc.bodies.filter((b) => !b.repeatOf).length : 0);

function entryFor(session: string): Entry {
  let entry = entries.get(session);
  if (!entry) {
    const saved = validSession(session) ? readDoc<Saved>(savedName(session)) : null;
    entry = {
      engine: null,
      open: Boolean(saved?.open),
      since: saved?.since ?? 0,
      rev: 0,
      by: "agent",
      shapes: countShapes(saved?.doc),
      cue: null,
    };
    entries.set(session, entry);
  }
  return entry;
}

function changed(session: string) {
  for (const fn of listeners) fn(session);
}

/** The model of a chat, made from what was kept or empty. Changes to it are saved and announced. */
async function engineOf(session: string): Promise<CadEngine> {
  const entry = entryFor(session);
  if (entry.engine) return entry.engine;
  const c = await loadCore();
  // Another call may have made it while the engine's code was loading.
  if (entry.engine) return entry.engine;
  const saved = readDoc<Saved>(savedName(session));
  const doc = (saved && c.parseDoc(saved.doc)) || c.emptyDoc();
  const engine = new c.Engine(doc);
  entry.engine = engine;
  entry.shapes = countShapes(engine.getDoc());
  engine.subscribe((next) => {
    entry.rev++;
    entry.shapes = countShapes(next);
    saveDoc(savedName(session), () => ({ doc: engine.toJSON(), open: entry.open, since: entry.since }) satisfies Saved);
    changed(session);
  });
  return engine;
}

/** Remember the window being opened or put away. */
function setOpen(session: string, open: boolean) {
  const entry = entryFor(session);
  if (entry.open === open) return;
  entry.open = open;
  entry.since = open ? Date.now() : entry.since;
  const engine = entry.engine;
  if (engine) saveDoc(savedName(session), () => ({ doc: engine.toJSON(), open: entry.open, since: entry.since }) satisfies Saved);
  else {
    const saved = readDoc<Saved>(savedName(session));
    if (saved) saveDoc(savedName(session), () => ({ ...saved, open: entry.open, since: entry.since }));
  }
  changed(session);
}

export function cadState(session: string): CadState {
  if (!validSession(session)) return { open: false };
  const entry = entryFor(session);
  if (!entry.open) return { open: false };
  return { open: true, since: entry.since, rev: entry.rev, by: entry.by, shapes: entry.shapes };
}

/** Told after every change to a chat's window or model, so the page can be told. */
export function onCadChange(fn: (session: string) => void) {
  listeners.add(fn);
}

/** The chat is gone: let go of its model, and of the file it was kept in. */
export function dropCad(session: string) {
  entries.delete(session);
  if (!validSession(session)) return;
  fs.rmSync(path.join(stateDir(), `${savedName(session)}.json`), { force: true });
}

// ------------------------------------------------------------------- tools --

/** The tool names the engine knows, as the agent sees them: cad_scene_get and so on. */
const CAD_NAMES = new Set(cadSPECS.map((s) => s.name));
const BARE = cadSPECS.map((s) => s.name.slice(4)).filter((n) => n.includes("_"));
const BARE_PATTERN = new RegExp(`(?<![\\w])(${BARE.join("|")})(?![\\w])`, "g");

/** The engine's messages name its tools without the prefix ("call scene_get"); the agent knows them with it. */
const asAgentSees = (text: string) => text.replace(BARE_PATTERN, "cad_$1");

/** A name for an exported file, with the extension its format needs. */
function exportName(wanted: unknown, format: string, fallback: string): string {
  const base = (typeof wanted === "string" && wanted.trim() ? wanted.trim() : fallback)
    .replace(/[\\/:*?"<>|\u0000-\u001f]+/g, "-")
    .replace(/\.(stl|glb|obj|json)$/i, "")
    .slice(0, 80);
  return `${base || fallback}.${format}`;
}

const EXPORT_MIME: Record<string, string> = {
  stl: "model/stl",
  glb: "model/gltf-binary",
  obj: "text/plain",
  json: "application/json",
};

/** The most a tool result may say, in characters: a whole scene can be large and the agent can ask for less. */
const MOST = 24_000;

interface CadToolHooks {
  /** Show a saved file in the thread. */
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
}

/**
 * Runs one `cad_*` tool on the chat's model and opens the window, so the person watches it happen.
 * Never throws: a bad call comes back as { ok: false, summary } saying what was wrong and what to try.
 */
export async function runCadTool(
  session: string,
  toolName: string,
  args: Record<string, any>,
  hooks: CadToolHooks = {},
): Promise<{ ok: boolean; summary: string; preview?: string }> {
  if (!CAD_NAMES.has(toolName)) return { ok: false, summary: `Unknown tool "${toolName}".` };
  if (!validSession(session)) return { ok: false, summary: "Autora 3D needs a chat to work in." };
  try {
    const engine = await engineOf(session);
    const name = toolName.slice(4);
    const given = { ...args };
    // Commands inside a batch name their tool either way.
    if (name === "batch" && Array.isArray(given.commands)) {
      given.commands = given.commands.map((c: any) =>
        c && typeof c.tool === "string" ? { ...c, tool: c.tool.replace(/^cad_/, "") } : c);
    }
    const exportArgs = name === "export" ? { name: given.name } : null;
    if (exportArgs) delete given.name;
    const mine = entryFor(session);
    mine.by = "agent";
    // Said before the change lands: the window is told the model moved a moment later, and asks for this with it.
    mine.cue = { seq: (mine.cue?.seq ?? 0) + 1, tool: name };
    setOpen(session, true);
    const res = await engine.execute(name, given);
    if (!res.ok) {
      const hint = res.hint ? ` ${asAgentSees(res.hint)}` : "";
      return { ok: false, summary: `${asAgentSees(res.error ?? "That did not work.")}${hint}`, preview: name };
    }
    if (exportArgs) {
      const r = res.result as { format?: string; filename?: string; encoding?: string; data?: string; text?: string };
      const format = String(r.format ?? "stl");
      const data = r.encoding === "base64" ? Buffer.from(r.data ?? "", "base64") : Buffer.from(r.text ?? "", "utf8");
      const art = saveArtifact({
        origin: "agent",
        name: exportName(exportArgs.name, format, "model"),
        data,
        mime: EXPORT_MIME[format] ?? "application/octet-stream",
        session,
        note: `Exported from Autora 3D as ${format.toUpperCase()}`,
      });
      hooks.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
      return { ok: true, summary: `Exported the model as ${art.name} (${data.length} bytes), saved as artifact ${art.id}. The person can download it from the thread.`, preview: art.name };
    }
    let summary = asAgentSees(JSON.stringify({ result: res.result, shapes: res.shapes, changed: res.changed, revision: res.revision }));
    if (summary.length > MOST) {
      summary = `${summary.slice(0, MOST)}\n[cut: the answer was ${summary.length} characters. Ask for less (cad_scene_get lists shapes; cad_shape_get takes one id).]`;
    }
    return { ok: true, summary, preview: name };
  } catch (err) {
    return { ok: false, summary: `Autora 3D could not do that: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/** Which of the model's tools exist, for the capability briefing. */
export function cadBriefing(on: boolean): string {
  if (!on) {
    return "- Autora 3D (the 3D modelling window): switched off on the Tools page. Do not try to model in 3D, and if asked, say it is off.";
  }
  return (
    "- Autora 3D (the 3D modelling window): available. Tools: the cad_* family -- start with cad_scene_get; cad_export gives " +
    "STL to print or GLB for games. " +
    "Shapes are flat outlines pushed up to a height, in millimetres, x right, y away, z up. Model what the person asks to " +
    "make, print or design with these, not code. The window opens beside the chat on first use and the person can work " +
    "in it too: call cad_scene_get again before relying on what you saw earlier. Check a part with cad_shape_measure " +
    "(watertight) before exporting. Design choices are theirs: suggest, and ask when it matters."
  );
}

// ------------------------------------------------------------------ routes --

const bigJson = express.json({ limit: "64mb" });

/** The window's side of the wire: its state, its model, and opening and putting it away. */
export function cadRoutes(app: Express, opts: { exists: (session: string) => boolean; incognito: (session: string) => boolean; off: () => boolean }) {
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!validSession(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    if (!cadAvailable()) {
      res.status(503).json({ error: "Autora 3D is not built into this server." });
      return null;
    }
    return id;
  };

  app.get("/api/cad/:session", (req, res) => {
    const id = known(req, res);
    if (id) res.json(cadState(id));
  });

  app.get("/api/cad/:session/doc", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    try {
      const engine = await engineOf(id);
      res.setHeader("Cache-Control", "no-store");
      const entry = entryFor(id);
      res.json({ doc: engine.getDoc(), rev: entry.rev, ...(entry.by === "agent" && entry.cue ? { cue: entry.cue } : {}) });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* What the person did in the window. Taken as it is (the engine parses and settles it), so a stale or malformed
     document is refused rather than saved. */
  app.put("/api/cad/:session/doc", bigJson, async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora 3D is switched off on the Tools page." });
    try {
      const c = await loadCore();
      const doc = c.parseDoc(req.body?.doc);
      if (!doc) return res.status(400).json({ error: "That is not an Autora 3D model." });
      const engine = await engineOf(id);
      const entry = entryFor(id);
      // Stays "person" until the agent's next tool call says otherwise: that is who made the latest change.
      entry.by = "person";
      engine.setDoc(doc);
      res.json({ rev: entry.rev });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  /* The person opens it from the toolbox: a block to start from, so there is something to hold. */
  app.post("/api/cad/:session/open", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (opts.off()) return res.status(403).json({ error: "Autora 3D is switched off on the Tools page." });
    if (opts.incognito(id)) return res.status(409).json({ error: "An incognito chat keeps nothing, so it has no 3D window." });
    try {
      const c = await loadCore();
      const engine = await engineOf(id);
      if (countShapes(engine.getDoc()) === 0) {
        entryFor(id).by = "agent";
        engine.setDoc(c.starterDoc());
      }
      setOpen(id, true);
      res.json({ ...cadState(id), name: "Your model" });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : String(err) });
    }
  });

  app.post("/api/cad/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    setOpen(id, false);
    res.json(cadState(id));
  });
}

/**
 * The window's page, served to the frame that holds it. It is Autora's own code, in a frame of this origin
 * (the window talks to it by postMessage only), so it may be framed by this app and by nothing else.
 */
export function serveCad(app: Express, dist: string): void {
  app.use(
    "/autora-3d",
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
          "connect-src 'self'",
          "frame-ancestors 'self'",
        ].join("; "),
      );
      res.setHeader("X-Content-Type-Options", "nosniff");
      next();
    },
    ...staticDir(path.join(dist, "autora-3d"), { fallthrough: false }),
  );
}
