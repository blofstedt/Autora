/**
 * Spectra-PDF's window, served by Autora.
 *
 * Spectra's own editor (spectra-editor/) is built into Autora, and behind it
 * sits Spectra's own Python engine: 221 PDF operations — OCR, redaction,
 * signatures, acroform, preflight, accessibility — answering JSON-RPC over
 * stdin. Nothing of either is rewritten. What this file is, then, is the two
 * ends of the pipe and the session they belong to:
 *
 *   - `POST /api/spectra/invoke`  one renderer command, answered here
 *     (server/spectra/commands.ts).
 *   - an event channel for the engine's replies and its progress, either
 *     through Autora's own socket (the app, where the window relays them into
 *     the frame) or over `/api/spectra/events` (the page opened on its own,
 *     for development).
 *
 * Everything the engine touches is per document session, as the PDF desk is:
 * its working folder, its two engine processes (interactive and health), and
 * the file the window is showing.
 */
import express, { type Express, type NextFunction, type Request, type Response } from "express";
import fs from "node:fs";
import path from "node:path";
import type { IncomingMessage } from "node:http";
import type { Duplex } from "node:stream";
import { WebSocketServer, type WebSocket } from "ws";
import { SpectraEngine, spectraAvailable } from "./spectra/engine";
import { runCommand, type SpectraContext } from "./spectra/commands";
import { closeDesk } from "./pdfdesk";

/** A document can be large and its bytes cross as base64, so the body limit is
 *  generous; the app-wide JSON parser's 5 MB would refuse an ordinary scan. */
const MAX_BODY = 512 * 1024 * 1024;

interface Session {
  interactive: SpectraEngine;
  health: SpectraEngine;
  /** The window's own folder: the document, and anything the editor writes. */
  dir: string;
  /** Standalone event sockets watching this session. */
  watchers: Set<WebSocket>;
  /** The document written to disk from the desk's bytes. Built once, awaited
   *  by every command: the engine is a file-based tool, so an operation that
   *  ran before the file existed would fail with "no such file". */
  ready: Promise<string | null> | null;
}

const sessions = new Map<string, Session>();

export interface SpectraOptions {
  /** Whether Autora knows that session. */
  exists(session: string): boolean;
  /** The folder the session works in (Autora's terminal directory). */
  cwd(): string;
  /** Autora's own version, reported to the editor. */
  version(): string;
  /** The PDF the window is showing: its name and bytes, or null. */
  document(session: string): Promise<{ name: string; bytes: Buffer } | null>;
  /** The document was written by the editor: hand it back to the PDF desk, so
   *  the agent's own tools see the person's work. */
  saved(session: string, file: string): void;
  /** Push one event towards the window (Autora's socket, in the app). */
  push(session: string, event: string, payload: unknown): void;
}

let options: SpectraOptions | null = null;

/** Everything the editor needs to know about a session's own folder. */
function folderFor(session: string): string {
  const base = path.join(options?.cwd() ?? process.cwd(), ".spectra", session);
  fs.mkdirSync(base, { recursive: true });
  return base;
}

function sessionFor(session: string): Session {
  let entry = sessions.get(session);
  if (!entry) {
    const emit = (event: string, payload: unknown) => send(session, event, payload);
    entry = {
      interactive: new SpectraEngine("interactive", emit),
      health: new SpectraEngine("health", emit),
      dir: folderFor(session),
      watchers: new Set(),
      ready: null,
    };
    sessions.set(session, entry);
  }
  return entry;
}

/** One event to every end of the session: the app's window, and any page
 *  opened on its own. */
function send(session: string, event: string, payload: unknown): void {
  const entry = sessions.get(session);
  if (entry) {
    const frame = JSON.stringify({ event, payload });
    for (const socket of entry.watchers) {
      try {
        if (socket.readyState === 1) socket.send(frame);
      } catch {
        // A socket that went away between the check and the write.
      }
    }
  }
  options?.push(session, event, payload);
}

/** Where the window's document lives on disk, written from the desk's bytes.
 *  The engine is a file-based tool: it is given paths, not buffers, so the
 *  document has to exist as a file for anything to touch it. */
async function materialise(session: string, force = false): Promise<string | null> {
  const entry = sessionFor(session);
  const doc = await options!.document(session);
  if (!doc) return null;
  const file = path.join(entry.dir, path.basename(doc.name) || "document.pdf");
  /* Written once, and only when the desk's copy is a different size: a reload
     must not throw away what the person has done in the editor since. `force`
     is the other case — the desk's copy changed under the editor (the agent
     edited the document), so the desk wins and the file is overwritten. */
  if (!force) {
    try {
      const existing = fs.statSync(file);
      if (existing.size === doc.bytes.length) return file;
    } catch {
      // Not there yet.
    }
  }
  fs.writeFileSync(file, doc.bytes);
  return file;
}

/** The document, written once per session however many commands arrive at
 *  once. */
function sessionReady(session: string): Promise<string | null> {
  const entry = sessionFor(session);
  if (!entry.ready) entry.ready = materialise(session);
  return entry.ready;
}

/** What the renderer's commands are given to work with. */
function context(session: string): SpectraContext {
  const entry = sessionFor(session);
  return {
    session,
    root: entry.dir,
    interactive: entry.interactive,
    health: entry.health,
    emit: (event, payload) => send(session, event, payload),
    documentPath: () => {
      const doc = path.join(entry.dir, "");
      try {
        const found = fs.readdirSync(doc).find((name) => name.toLowerCase().endsWith(".pdf"));
        return found ? path.join(doc, found) : null;
      } catch {
        return null;
      }
    },
    refreshDocument: async () => {
      const doc = await options!.document(session);
      if (!doc) return;
      const file = path.join(entry.dir, path.basename(doc.name) || "document.pdf");
      /* The editor writes the document back to the desk when the person saves,
         and that is a desk change like any other: telling the editor to open
         what it has just written would throw away everything it did after the
         save. Only a desk copy the file does not already hold is handed over. */
      try {
        if (fs.readFileSync(file).equals(doc.bytes)) return;
      } catch {
        // Not on disk yet: materialise writes it.
      }
      entry.ready = materialise(session, true);
      await entry.ready;
      /* Named for Autora rather than the renderer: the window it is sent to
         reloads the editor, because a hand-over of the same path only focuses
         the tab the editor already has and would show the person the document
         as it was before the agent's edit. */
      send(session, "autora:reload", { file });
    },
    appVersion: () => options?.version() ?? "",

    documentSaved: (file) => {
      if (file) options?.saved(session, file);
    },
  };
}

export function spectraRoutes(app: Express, opts: SpectraOptions): void {
  options = opts;

  /* Read here rather than by the app-wide parser: a command carries a
     document's bytes, and that parser stops at 5 MB. */
  const body = express.raw({ type: () => true, limit: MAX_BODY });

  /* The page opened on its own (see serveSpectra, and the development harness)
     has no origin at all: its commands come in cross-origin and a JSON body
     makes them preflighted. In the app the window relays commands instead and
     none of this is used. */
  app.use("/api/spectra", (req: Request, res: Response, next: NextFunction) => {
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("Access-Control-Allow-Headers", "content-type");
    res.setHeader("Access-Control-Allow-Methods", "POST, GET, OPTIONS");
    if (req.method === "OPTIONS") return res.sendStatus(204);
    next();
  });

  app.post("/api/spectra/invoke", body, (req: Request, res: Response) => {
    const session = String(req.query.session ?? "");
    if (!session || !opts.exists(session)) return res.status(404).json({ error: "No such session." });

    /* Two shapes arrive here. A body of `text/plain` (what the window sends,
       so that a command carrying a document's bytes is not stopped by the
       app-wide JSON parser's 5 MB) is read by this route's own parser as a
       Buffer. A body of `application/json` has already been parsed by the
       app-wide one, and comes through as an object -- a command read as
       `{}` is the bug this shape exists to end. */
    let payload: { command?: string; args?: Record<string, unknown> } | null = null;
    if (Buffer.isBuffer(req.body)) {
      try {
        payload = JSON.parse(req.body.toString("utf8"));
      } catch {
        return res.status(400).json({ error: "That request was not readable." });
      }
    } else if (req.body && typeof req.body === "object") {
      payload = req.body as { command?: string; args?: Record<string, unknown> };
    }
    const command = String(payload?.command ?? "");
    if (!command) return res.status(400).json({ error: "No command." });

    void (async () => {
      try {
        // The document first: a command that names a file would otherwise run
        // before that file exists.
        await sessionReady(session).catch(() => null);
        const result = await runCommand(context(session), command, payload?.args ?? {});
        // An engine operation answers later, as an event; undefined is a
        // complete answer for it (Tauri's own commands returned void).
        res.json({ result: result === undefined ? null : result });
      } catch (err) {
        const message = (err as Error)?.message ?? "That could not be done.";
        res.status(400).json({ error: { command, message } });
      }
    })();
  });

  app.get("/api/spectra/status", (_req, res) => {
    const health = spectraAvailable();
    res.json({
      available: health.ok,
      reason: health.reason ?? null,
      sessions: [...sessions.keys()].length,
      engines: [...sessions.entries()].map(([id, s]) => ({ id, interactive: s.interactive.alive, health: s.health.alive })),
    });
  });

  /** The launch handover: what this window should open. The renderer asks for
   *  it through a command; this is the same thing where a page wants it before
   *  the app is up. */
  app.get("/api/spectra/document", (req, res) => {
    const session = String(req.query.session ?? "");
    if (!session || !opts.exists(session)) return res.status(404).json({ error: "No such session." });
    void materialise(session).then((file) => res.json({ file }));
  });

  /* The window put away: the engines stop with it -- a PDF engine holds its
     document open, and one left running would sit on the file the person is
     about to edit -- and the desk closes, which is what takes the window down. */
  app.post("/api/spectra/close", (req, res) => {
    const session = String(req.query.session ?? "");
    if (!session || !opts.exists(session)) return res.status(404).json({ error: "No such session." });
    dropSpectra(session);
    closeDesk(session);
    res.json({ ok: true });
  });
}

/** The engine's replies, for a page opened on its own. In the app the window
 *  relays them through Autora's own socket instead, so this is the development
 *  and test path — the same events, the same session.
 *
 *  It answers an upgrade rather than listening for one: Autora has a single
 *  socket server fed by hand (server.ts), and a second listener here would
 *  have that one pick up this connection too. Returns true when it took it. */
let sockets: WebSocketServer | null = null;

export function spectraUpgrade(req: IncomingMessage, socket: Duplex, head: Buffer): boolean {
  const url = new URL(req.url ?? "/", "http://localhost");
  if (url.pathname !== "/api/spectra/events") return false;

  const session = url.searchParams.get("session") ?? "";
  if (!session || !options?.exists(session)) {
    socket.destroy();
    return true;
  }

  sockets ??= new WebSocketServer({ noServer: true });
  sockets.handleUpgrade(req, socket, head, (ws) => {
    const entry = sessionFor(session);
    entry.watchers.add(ws);
    ws.on("close", () => entry.watchers.delete(ws));
    ws.on("error", () => entry.watchers.delete(ws));
    // The document is ready as soon as the page is listening: the renderer
    // opens what it is given rather than asking a dialog.
    void sessionReady(session).catch(() => undefined);
  });
  return true;
}

/** The editor's own files, served to the frame that holds it.
 *
 * The frame is sandboxed by its `sandbox` attribute (see SpectraWindow): no
 * origin of its own, so it cannot reach this app or its API, and every command
 * it makes comes through the window that holds it. That is the policy; what is
 * set here is the policy's other half -- the page needs its own scripts, its
 * own fonts, inline styles (React sets them) and blob: workers, and a
 * `sandbox` directive in this header would turn everything else off
 * (`default-src 'none'`), which is a white page rather than a safer one. */
export function serveSpectra(app: Express, dist: string): void {
  app.use("/spectra-editor", (_req, res, next) => {
    /* The editor's own scripts and styles are module scripts, and a module
       script in a frame with no origin is fetched CORS-style: without this the
       page downloads and the app never mounts ("blocked by CORS policy",
       "origin null"). Nothing here is private -- it is the editor's own build,
       served to a frame that cannot reach Autora's API. */
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader(
      "Content-Security-Policy",
      [
        "default-src 'self'",
        // 'unsafe-inline' for the scripts: in development the editor's page is
        // served by Vite, whose client and React preamble are inline scripts,
        // and a frame that reaches nothing (no origin, no cookies, no network
        // but Autora's own) has nothing for an injected script to reach.
        "script-src 'self' 'unsafe-inline' 'wasm-unsafe-eval'",
        "style-src 'self' 'unsafe-inline'",
        "img-src 'self' data: blob:",
        "font-src 'self' data:",
        "worker-src 'self' blob:",
        "connect-src 'self'",
      ].join("; "),
    );
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  }, express.static(path.join(dist, "spectra-editor"), { fallthrough: false }));
}

/** The desk's copy of the document moved on under the editor -- the agent
 *  edited it -- so the file is written out again and handed back to the window.
 *  Nothing happens when no window has this document open. */
export function spectraDocumentChanged(session: string): void {
  if (!sessions.has(session)) return;
  void context(session).refreshDocument();
}

/** The window closed: stop its engines. A PDF engine holds a document open, so
 *  one left running would keep the file the person is about to edit. */
export function dropSpectra(session: string): void {
  const entry = sessions.get(session);
  if (!entry) return;
  entry.interactive.kill();
  entry.health.kill();
  for (const socket of entry.watchers) {
    try {
      socket.close();
    } catch {
      // Already gone.
    }
  }
  sessions.delete(session);
}

/** What the editor can do here, for the agent's own report. */
export function spectraReport(): { available: boolean; reason?: string; sessions: string[] } {
  const health = spectraAvailable();
  return { available: health.ok, reason: health.reason, sessions: [...sessions.keys()] };
}
