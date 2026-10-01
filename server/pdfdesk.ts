/**
 * The PDF window: the file the agent is working on, open beside the
 * conversation in SecurePDF's editor (pdf-editor/), for the person to watch
 * and to work on too.
 *
 * One per session. It holds the pages without anything placed on them (the
 * base) and the objects on top -- what the agent placed with pdf_edit and
 * what the person added in the window -- as the editor's own objects, so
 * either of them can move, change or remove any of it. The file everyone
 * else sees (the PDF tools, the thread's file card, a download) is the two
 * flattened together into an artifact, rewritten whenever either changes:
 * there is no save button to forget.
 *
 * What the person does in the window is told to the agent, once: with the
 * next PDF tool result, or at the start of its next turn (briefing()).
 *
 * The editor runs in a sandboxed frame with no origin of its own and talks to
 * the page by messages only; it never calls this server. Its files are served
 * here under /pdf-editor/ (see serveEditor), with a sandboxing policy, since
 * it renders PDFs that came from anywhere.
 */

import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { getArtifact, saveArtifact, MAX_ARTIFACT_BYTES } from "./artifacts";
import { flattenDesk, type DeskHooks, type DeskItem, type DeskSnapshot } from "./pdf";
import { stateDir } from "./state";

type Desk = DeskSnapshot & {
  /** Shown beside the conversation; the person can put it away. */
  open: boolean;
  /** What the file is saved as, until it has been. */
  outName: string;
  /** Goes up when the pages change; the window reloads the file then. */
  baseRev: number;
  /** Goes up on every change. */
  rev: number;
  /** What the person did that the agent has not been told. */
  news: string[];
  since: number;
  /** Why the file could not be rewritten, while that is so. */
  problem: string | null;
};

const desks = new Map<string, Desk>();
const DIR = path.join(stateDir(), "desks");
const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);
const isPdf = (data: Buffer) => data.subarray(0, 1024).includes("%PDF-");

let changed: (session: string) => void = () => undefined;
/** Who to tell when a window changes: server.ts sends it to the session's sockets. */
export function onDeskChange(fn: (session: string) => void) {
  changed = fn;
}

// ---------------------------------------------------------- on disk --

function load(session: string): Desk | null {
  if (desks.has(session)) return desks.get(session) ?? null;
  if (!validSession(session)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, `${session}.json`), "utf8"));
    const base = fs.readFileSync(path.join(DIR, `${session}.pdf`));
    const desk: Desk = {
      name: String(meta.name || "document.pdf"), base, items: Array.isArray(meta.items) ? meta.items : [],
      working: typeof meta.working === "string" ? meta.working : null,
      source: typeof meta.source === "string" ? meta.source : null,
      open: meta.open === true, outName: String(meta.outName || meta.name || "document.pdf"),
      baseRev: Number(meta.baseRev) || 1, rev: Number(meta.rev) || 1,
      news: Array.isArray(meta.news) ? meta.news.map(String) : [], since: Number(meta.since) || Date.now(), problem: null,
    };
    desks.set(session, desk);
    return desk;
  } catch {
    return null;
  }
}

const writing = new Map<string, NodeJS.Timeout>();
const lastBase = new Map<string, number>();

function persist(session: string) {
  if (writing.has(session)) return;
  writing.set(session, setTimeout(() => {
    writing.delete(session);
    const desk = desks.get(session);
    if (!desk) return;
    try {
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      if (lastBase.get(session) !== desk.baseRev) {
        fs.writeFileSync(path.join(DIR, `${session}.pdf`), desk.base, { mode: 0o600 });
        lastBase.set(session, desk.baseRev);
      }
      const { base: _base, problem: _problem, ...meta } = desk;
      fs.writeFileSync(path.join(DIR, `${session}.json`), JSON.stringify(meta), { mode: 0o600 });
    } catch (err: any) {
      console.warn(`[pdfdesk] ${session}: could not save the window: ${err?.message ?? err}`);
    }
  }, 300));
}

/** A session that is deleted takes its window with it. */
export function dropDesk(session: string) {
  desks.delete(session);
  lastBase.delete(session);
  for (const ext of ["json", "pdf"]) {
    try {
      fs.rmSync(path.join(DIR, `${session}.${ext}`), { force: true });
    } catch {}
  }
}

// ------------------------------------------------- the flattened file --

const rewriting = new Map<string, NodeJS.Timeout>();

/** Write the window's file again, soon: a drag sends a few changes in a row. */
function rewrite(session: string, cwd: string) {
  const pending = rewriting.get(session);
  if (pending) clearTimeout(pending);
  rewriting.set(session, setTimeout(() => {
    rewriting.delete(session);
    void rewriteNow(session, cwd);
  }, 600));
}

async function rewriteNow(session: string, cwd: string) {
  const desk = desks.get(session);
  if (!desk) return;
  const rev = desk.rev;
  try {
    const { data, skipped } = await flattenDesk(desk.base, desk.items, cwd);
    if (desks.get(session) !== desk || desk.rev !== rev) return; // something newer is on its way
    if (data.byteLength > MAX_ARTIFACT_BYTES) throw new Error("the file has grown past the 50 MB an artifact may be");
    const keep = desk.working ? getArtifact(desk.working) : null;
    const art = saveArtifact({
      origin: "agent", name: keep?.name ?? desk.outName, data, mime: "application/pdf", session,
      note: "Edited in the PDF window",
    });
    desk.working = art.id;
    desk.problem = skipped.length ? `Left out of the file: ${skipped.slice(0, 3).join("; ")}` : null;
  } catch (err: any) {
    desk.problem = `The file could not be updated: ${String(err?.message ?? err).split("\n")[0]}`;
  }
  persist(session);
  changed(session);
}

// --------------------------------------------------- what is shown --

/** The window as the page needs it: everything but the pages themselves. */
export function deskState(session: string) {
  const desk = load(session);
  if (!desk) return { open: false };
  return {
    open: desk.open, name: desk.name, working: desk.working, baseRev: desk.baseRev, rev: desk.rev,
    items: desk.items, since: desk.since, problem: desk.problem,
  };
}

export function deskBase(session: string): Buffer | null {
  return load(session)?.base ?? null;
}

// ------------------------------------------------- the agent's side --

/** The window as the PDF tools of one session see it. */
export function deskHooks(session: string): DeskHooks {
  return {
    current() {
      const desk = load(session);
      return desk ? { name: desk.name, base: desk.base, items: desk.items, working: desk.working, source: desk.source } : null;
    },
    open(next) {
      const was = load(session);
      const sameFile = was && was.working !== null && was.working === next.working;
      const desk: Desk = {
        ...next,
        open: true,
        baseRev: (was?.baseRev ?? 0) + 1,
        rev: (was?.rev ?? 0) + 1,
        news: was?.news ?? [],
        since: sameFile && was ? was.since : Date.now(),
        problem: null,
      };
      desks.set(session, desk);
      persist(session);
      changed(session);
    },
    show() {
      const desk = load(session);
      if (!desk || desk.open) return;
      desk.open = true;
      // Newest, so it takes the place beside the chat from the app window.
      desk.since = Date.now();
      persist(session);
      changed(session);
    },
    news() {
      const desk = load(session);
      if (!desk || desk.news.length === 0) return "";
      const told = newsLine(desk);
      desk.news = [];
      persist(session);
      return told;
    },
  };
}

function newsLine(desk: Desk): string {
  const list = desk.news.slice(-12);
  const more = desk.news.length - list.length;
  return (
    `Meanwhile, in the PDF window, the person ${list.join("; ")}${more > 0 ? `; and ${more} more change${more === 1 ? "" : "s"}` : ""}. ` +
    `${desk.working ? `The file (${desk.working}) has these changes in it` : "These are in the window"}: ` +
    "work with them, and do not undo what they did unless they ask."
  );
}

/**
 * For the start of a turn: that a PDF is open in the window, and what the
 * person did there since the agent last heard. Null when there is no window.
 */
export function deskBriefing(session: string): string | null {
  const desk = load(session);
  if (!desk || !desk.open) return null;
  const lines = [
    `${desk.name} is open in the PDF window beside the conversation${desk.working ? ` (artifact ${desk.working})` : ""}. ` +
      "pdf_edit on it places movable objects the person sees and can change; the other PDF tools read it as it is now.",
  ];
  if (desk.news.length) {
    lines.push(newsLine(desk));
    desk.news = [];
    persist(session);
  }
  return lines.join(" ");
}

// ------------------------------------------------ the person's side --

const LABEL: Record<string, string> = {
  signature: "signature", image: "picture", stamp: "stamp", shape: "shape", drawing: "drawing",
  highlighter: "highlight", redact: "redaction box", note: "note", text: "text",
};

function label(item: DeskItem): string {
  const whose = item.autora ? "your " : "";
  const words = (t: unknown) => {
    const s = String(t ?? "").trim().replace(/\s+/g, " ");
    return s ? ` "${s.length > 40 ? `${s.slice(0, 40)}…` : s}"` : "";
  };
  const kind = item.type === "drawing" && item.isHighlighter ? "highlight" : LABEL[item.type] ?? item.type;
  const detail = item.type === "text" ? words(item.text)
    : item.type === "note" ? words(item.noteComment)
      : item.type === "stamp" && item.stampType ? ` ${String(item.stampType).replace(/_/g, " ")}` : "";
  return `${whose}${kind}${detail} on page ${item.pageNumber}`;
}

/** A sane object from the page, or null: it came from a frame running a file from anywhere. */
function cleanItem(raw: unknown): DeskItem | null {
  if (!raw || typeof raw !== "object") return null;
  const item = raw as Record<string, any>;
  const id = String(item.id ?? "");
  if (!/^[\w.-]{1,80}$/.test(id) || typeof item.type !== "string" || item.type.length > 30) return null;
  const n = (v: unknown) => (Number.isFinite(Number(v)) ? Number(v) : 0);
  return { ...item, id, pageNumber: Math.max(1, Math.round(n(item.pageNumber))), x: n(item.x), y: n(item.y), width: n(item.width), height: n(item.height) } as DeskItem;
}

/** Objects added, changed or removed in the window. */
export function personChanges(session: string, upsert: unknown[], remove: unknown[], cwd: string): boolean {
  const desk = load(session);
  if (!desk) return false;
  const byId = new Map(desk.items.map((i) => [i.id, i]));
  for (const raw of upsert.slice(0, 500)) {
    const item = cleanItem(raw);
    if (!item) continue;
    const was = byId.get(item.id);
    // An object the agent placed keeps what it came from, whatever the page sends.
    if (was?.autora) item.autora = was.autora;
    else delete item.autora;
    if (!was) desk.news.push(`added ${label(item)}`);
    else if (JSON.stringify({ ...was, x: 0, y: 0, drawingPoints: 0 }) === JSON.stringify({ ...item, x: 0, y: 0, drawingPoints: 0 })) {
      if (was.x !== item.x || was.y !== item.y) desk.news.push(`moved ${label(item)}`);
    } else {
      desk.news.push(`changed ${label(item)}`);
    }
    byId.set(item.id, item);
  }
  for (const id of remove.slice(0, 500).map(String)) {
    const was = byId.get(id);
    if (!was) continue;
    desk.news.push(`removed ${label(was)}`);
    byId.delete(id);
  }
  desk.news = squash(desk.news).slice(-40);
  desk.items = [...byId.values()];
  desk.rev++;
  persist(session);
  changed(session);
  rewrite(session, cwd);
  return true;
}

/** "moved your signature" three times in a drag is one move. */
function squash(news: string[]): string[] {
  const out: string[] = [];
  for (const line of news) if (out[out.length - 1] !== line) out.push(line);
  return out;
}

/** The pages changed in the window: deleted, turned, reordered, merged. */
export function personBase(session: string, data: Buffer, items: unknown[], cwd: string): string | null {
  const desk = load(session);
  if (!desk) return "There is no PDF open in the window.";
  if (!isPdf(data)) return "That is not a PDF.";
  if (data.byteLength > MAX_ARTIFACT_BYTES) return "That file is over 50 MB.";
  const kept = new Map(desk.items.map((i) => [i.id, i]));
  desk.base = data;
  desk.items = items.slice(0, 2000).map(cleanItem).filter((i): i is DeskItem => Boolean(i)).map((i) => {
    const was = kept.get(i.id);
    if (was?.autora) i.autora = was.autora;
    else delete i.autora;
    return i;
  });
  desk.news.push("changed the pages themselves (deleting, turning, reordering or merging pages)");
  desk.baseRev++;
  desk.rev++;
  persist(session);
  changed(session);
  rewrite(session, cwd);
  return null;
}

/** Put the window away; it comes back the next time the agent works on a PDF. */
export function closeDesk(session: string) {
  const desk = load(session);
  if (!desk || !desk.open) return;
  desk.open = false;
  persist(session);
  changed(session);
}

// ----------------------------------------------------------- routes --

/** A JSON body read here rather than by the app-wide parser, which stops at 5 MB:
    an object can carry a photograph. */
const bigJson = express.raw({ type: () => true, limit: MAX_ARTIFACT_BYTES * 2 });
function bodyOf(req: Request): any {
  try {
    return JSON.parse(Buffer.isBuffer(req.body) ? req.body.toString("utf8") : "null");
  } catch {
    return null;
  }
}

export function deskRoutes(app: Express, opts: { exists: (session: string) => boolean; cwd: () => string }) {
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!validSession(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    return id;
  };

  app.get("/api/pdfdesk/:session", (req, res) => {
    const id = known(req, res);
    if (id) res.json(deskState(id));
  });

  app.get("/api/pdfdesk/:session/base", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const base = deskBase(id);
    if (!base) return res.status(404).json({ error: "There is no PDF open in the window." });
    res.setHeader("Content-Type", "application/pdf");
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.send(base);
  });

  app.post("/api/pdfdesk/:session/changes", bigJson, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const body = bodyOf(req);
    const upsert = Array.isArray(body?.upsert) ? body.upsert : [];
    const remove = Array.isArray(body?.remove) ? body.remove : [];
    if (!personChanges(id, upsert, remove, opts.cwd())) return res.status(404).json({ error: "There is no PDF open in the window." });
    res.json({ ok: true, rev: deskState(id).rev });
  });

  app.post("/api/pdfdesk/:session/pages", bigJson, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const body = bodyOf(req);
    const data = typeof body?.bytes === "string" ? Buffer.from(body.bytes, "base64") : Buffer.alloc(0);
    const problem = personBase(id, data, Array.isArray(body?.items) ? body.items : [], opts.cwd());
    if (problem) return res.status(400).json({ error: problem });
    res.json({ ok: true });
  });

  app.post("/api/pdfdesk/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    closeDesk(id);
    res.json({ ok: true });
  });
}

/**
 * The editor's own files. It runs in a frame sandboxed without an origin of
 * its own (it renders PDFs from anywhere, and pdf.js has had holes), so this
 * policy repeats the frame's sandbox for anyone who opens the page directly,
 * and the files say any origin may read them: from inside the sandbox, the
 * editor's own scripts and pdf.js's fonts count as another site's.
 */
export function serveEditor(app: Express, dist: string) {
  app.use("/pdf-editor", (_req, res, next) => {
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-downloads allow-modals allow-popups");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  }, express.static(path.join(dist, "pdf-editor"), { fallthrough: false }));
}
