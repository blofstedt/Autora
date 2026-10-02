/**
 * The Word window: the document the agent is working on, open beside the
 * conversation in GenOffice's Word editor, for the person to watch and to work
 * on too.
 *
 * One per session, the sibling of the PDF window (./pdfdesk.ts). It holds the
 * document as bytes. The editor (built into dist/office/web/docs, shown in a
 * sandboxed frame by src/components/OfficeWindow.tsx) saves as the person
 * types, and each save lands here: the file everyone else sees -- the Office
 * tools, the thread's file card, a download -- is an artifact kept current from
 * it, so there is no save button to forget. When the agent changes the
 * document, the new bytes replace these and the window loads them.
 *
 * What the person did is told to the agent once, in a sentence made by
 * comparing the paragraphs before and after: with the next Office tool result,
 * or at the start of its next turn.
 *
 * The editor runs in a frame with no origin of its own and talks to the page by
 * messages only; it never calls this server (see office/shim/common.js).
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import express, { type Express, type Request, type Response } from "express";
import { MAX_ARTIFACT_BYTES, getArtifact, saveArtifact } from "./artifacts";
import { stateDir } from "./state";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";

export type WordVersion = { n: number; label: string; at: number; by: "agent" | "person"; name: string };

type Desk = {
  open: boolean;
  name: string;
  /** The document as it is now. */
  data: Buffer;
  /** The artifact kept current from it, once there is one (never the person's own file). */
  working: string | null;
  /** The file it was opened from, when that was an artifact. */
  source: string | null;
  /** What the artifact is called, until it has been made. */
  outName: string;
  /** Goes up on every change, by anyone. */
  rev: number;
  /** Goes up when the agent changed the bytes: the window loads them again. */
  loadRev: number;
  since: number;
  /** What the person did that the agent has not been told. */
  news: string[];
  problem: string | null;
  versions: WordVersion[];
  vseq: number;
  /** The person changed something since the last version was kept. */
  dirty: boolean;
};

const MAX_VERSIONS = 30;
const desks = new Map<string, Desk>();
const DIR = path.join(stateDir(), "worddesks");
const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

/** A .docx is a zip. */
export const isDocx = (data: Buffer) => data.length > 100 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;

/** What the person does to the document, for whoever shares it with them (server/presence.ts). */
let touched: (session: string, subject: string, kind: string, detail: string, opts?: { tell?: boolean }) => void = () => undefined;
export function onWordTouch(fn: typeof touched) {
  touched = fn;
}

let changed: (session: string) => void = () => undefined;
/** Who to tell when a window changes: server.ts sends it to the session's sockets. */
export function onWordChange(fn: (session: string) => void) {
  changed = fn;
}

// ------------------------------------------- reading a Word file --

/** One entry of a zip, inflated; null when it is not there or is too big to be a document part. */
function zipEntry(zip: Buffer, wanted: string): Buffer | null {
  // The end-of-central-directory record is within the last 64 KB + 22 bytes.
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return null;
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  for (let n = 0; n < count && at + 46 <= zip.length; n += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) return null;
    const method = zip.readUInt16LE(at + 10);
    const csize = zip.readUInt32LE(at + 20);
    const nameLen = zip.readUInt16LE(at + 28);
    const extraLen = zip.readUInt16LE(at + 30);
    const commentLen = zip.readUInt16LE(at + 32);
    const local = zip.readUInt32LE(at + 42);
    const name = zip.toString("utf8", at + 46, at + 46 + nameLen);
    if (name === wanted) {
      if (local + 30 > zip.length) return null;
      const start = local + 30 + zip.readUInt16LE(local + 26) + zip.readUInt16LE(local + 28);
      const body = zip.subarray(start, start + csize);
      try {
        if (method === 0) return body;
        if (method === 8) return zlib.inflateRawSync(body, { maxOutputLength: 64 * 1024 * 1024 });
      } catch {
        return null;
      }
      return null;
    }
    at += 46 + nameLen + extraLen + commentLen;
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };

/** The text of each paragraph of the body, in order; null when the file cannot be read this way. */
export function docxParagraphs(data: Buffer): string[] | null {
  try {
    const xml = zipEntry(data, "word/document.xml")?.toString("utf8");
    if (!xml) return null;
    const out: string[] = [];
    for (const p of xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)) {
      let text = "";
      for (const m of p[0].matchAll(/<w:t(?:\s[^>]*)?>([\s\S]*?)<\/w:t>|<w:tab\s*\/>|<w:br\s*\/>/g)) {
        text += m[1] === undefined ? (m[0].startsWith("<w:tab") ? "\t" : "\n") : m[1];
      }
      out.push(text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
        if (e[0] === "#") {
          const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
          return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
        }
        return ENTITIES[e.toLowerCase()] ?? whole;
      }));
      if (out.length > 20000) break;
    }
    return out;
  } catch {
    return null;
  }
}

const quote = (t: string) => {
  const s = t.replace(/\s+/g, " ").trim();
  return `"${s.length > 40 ? `${s.slice(0, 40)}…` : s}"`;
};

/** What differs between two versions of one paragraph: the middle, once the same start and end are set aside. */
export function fragment(was: string, now: string): string {
  let head = 0;
  while (head < was.length && head < now.length && was[head] === now[head]) head += 1;
  let tail = 0;
  while (tail < was.length - head && tail < now.length - head && was[was.length - 1 - tail] === now[now.length - 1 - tail]) tail += 1;
  // A pure insertion or deletion is quoted as it is; a rewording is quoted by whole words ("Friday", not "Fri").
  if (was.slice(head, was.length - tail) !== "" && now.slice(head, now.length - tail) !== "") {
    while (head > 0 && !/\s/.test(was[head - 1])) head -= 1;
    while (tail > 0 && !/\s/.test(was[was.length - tail])) tail -= 1;
  }
  const cut = (t: string, len: number) => t.slice(head, t.length - len);
  const a = cut(was, tail), b = cut(now, tail);
  const show = (t: string) => `"${t.length > 80 ? `${t.slice(0, 80)}…` : t}"`;
  const where = was.replace(/\s+/g, " ").trim().slice(0, 30);
  const near = where ? ` in the paragraph starting "${where}${was.length > 30 ? "…" : ""}"` : "";
  if (!a.trim() && b.trim()) return `added ${show(b)}${near}`;
  if (a.trim() && !b.trim()) return `deleted ${show(a)}${near}`;
  return `changed ${show(a)} to ${show(b)}${near}`;
}

/** What changed between two versions of a document, as phrases a colleague would say. */
export function describeChange(before: string[], after: string[]): string[] {
  // The same paragraphs at either end are not what changed.
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  const was = before.slice(head, before.length - tail);
  const now = after.slice(head, after.length - tail);
  if (was.length === 0 && now.length === 0) return [];
  // Paragraphs that moved are not edits: only what is in one side and not the other counts.
  const count = (list: string[]) => list.reduce((m, t) => m.set(t, (m.get(t) ?? 0) + 1), new Map<string, number>());
  const wasCount = count(was), nowCount = count(now);
  const gone = was.filter((t) => { const n = nowCount.get(t) ?? 0; if (n > 0) { nowCount.set(t, n - 1); return false; } return true; });
  const fresh = now.filter((t) => { const n = wasCount.get(t) ?? 0; if (n > 0) { wasCount.set(t, n - 1); return false; } return true; });
  const blank = (t: string) => t.trim() === "";
  const g = gone.filter((t) => !blank(t)), f = fresh.filter((t) => !blank(t));
  const out: string[] = [];
  const edited = Math.min(g.length, f.length);
  if (edited > 0) {
    // What is different inside each reworded paragraph, not the paragraph: what the agent needs to know.
    const parts = g.slice(0, Math.min(edited, 3)).map((was, i) => fragment(was, f[i]));
    const rest = edited - parts.length;
    out.push(parts.join("; ") + (rest > 0 ? `; and ${rest} more paragraph${rest === 1 ? "" : "s"} reworded` : ""));
  }
  if (f.length > edited) {
    const extra = f.slice(edited);
    out.push(extra.length === 1 ? `added a paragraph, ${quote(extra[0])}` : `added ${extra.length} paragraphs (starting ${quote(extra[0])})`);
  }
  if (g.length > edited) {
    const extra = g.slice(edited);
    out.push(extra.length === 1 ? `removed a paragraph, ${quote(extra[0])}` : `removed ${extra.length} paragraphs (starting ${quote(extra[0])})`);
  }
  if (out.length === 0) out.push("changed the formatting or the structure");
  return out;
}

// ---------------------------------------------------------- on disk --

function load(session: string): Desk | null {
  if (desks.has(session)) return desks.get(session) ?? null;
  if (!validSession(session)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, `${session}.json`), "utf8"));
    const desk: Desk = {
      open: meta.open === true, name: String(meta.name || "document.docx"), data: fs.readFileSync(path.join(DIR, `${session}.docx`)),
      working: typeof meta.working === "string" ? meta.working : null,
      source: typeof meta.source === "string" ? meta.source : null,
      outName: String(meta.outName || meta.name || "document.docx"),
      rev: Number(meta.rev) || 1, loadRev: Number(meta.loadRev) || 1, since: Number(meta.since) || Date.now(),
      news: Array.isArray(meta.news) ? meta.news.map(String) : [], problem: null,
      versions: Array.isArray(meta.versions) ? meta.versions : [], vseq: Number(meta.vseq) || 0, dirty: meta.dirty === true,
    };
    desks.set(session, desk);
    return desk;
  } catch {
    return null;
  }
}

const writing = new Map<string, NodeJS.Timeout>();

function persist(session: string) {
  if (writing.has(session)) return;
  writing.set(session, setTimeout(() => {
    writing.delete(session);
    const desk = desks.get(session);
    if (!desk) return;
    try {
      fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
      fs.writeFileSync(path.join(DIR, `${session}.docx`), desk.data, { mode: 0o600 });
      const { data: _data, problem: _problem, ...meta } = desk;
      fs.writeFileSync(path.join(DIR, `${session}.json`), JSON.stringify(meta), { mode: 0o600 });
    } catch (err: any) {
      console.warn(`[worddesk] ${session}: could not save the window: ${err?.message ?? err}`);
    }
  }, 300));
}

/** A session that is deleted takes its window with it. */
export function dropWordDesk(session: string) {
  desks.delete(session);
  try {
    for (const f of fs.readdirSync(DIR)) if (f === `${session}.json` || f === `${session}.docx` || f.startsWith(`${session}.v`)) fs.rmSync(path.join(DIR, f), { force: true });
  } catch {
    // Nothing was kept.
  }
}

// ------------------------------------------------------------ versions --

const versionFile = (session: string, n: number) => path.join(DIR, `${session}.v${n}.docx`);

/** Keep the document as it is now as a version the person can go back to. */
function snapshot(session: string, desk: Desk, label: string, by: "agent" | "person") {
  const n = ++desk.vseq;
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(versionFile(session, n), desk.data, { mode: 0o600 });
  } catch (err: any) {
    console.warn(`[worddesk] ${session}: could not keep a version: ${err?.message ?? err}`);
  }
  desk.versions.push({ n, label: label.slice(0, 140), at: Date.now(), by, name: desk.name });
  desk.dirty = false;
  while (desk.versions.length > MAX_VERSIONS) {
    const old = desk.versions.shift();
    if (old) fs.rmSync(versionFile(session, old.n), { force: true });
  }
}

// ----------------------------------------- the file everyone else sees --

const rewriting = new Map<string, NodeJS.Timeout>();

/** Write the artifact again, soon: typing sends a few saves in a row. */
function rewrite(session: string) {
  const pending = rewriting.get(session);
  if (pending) clearTimeout(pending);
  rewriting.set(session, setTimeout(() => {
    rewriting.delete(session);
    writeArtifact(session);
  }, 600));
}

function writeArtifact(session: string) {
  const desk = desks.get(session);
  if (!desk) return;
  try {
    if (desk.data.byteLength > MAX_ARTIFACT_BYTES) throw new Error("the document has grown past the 50 MB an artifact may be");
    const keep = desk.working ? getArtifact(desk.working) : null;
    const art = saveArtifact({
      origin: "agent", name: keep?.name ?? desk.outName, data: desk.data, mime: DOCX_MIME, session,
      note: "Edited in the Word window",
    });
    desk.working = art.id;
    desk.problem = null;
  } catch (err: any) {
    desk.problem = `The file could not be updated: ${String(err?.message ?? err).split("\n")[0]}`;
  }
  persist(session);
  changed(session);
}

// --------------------------------------------------- what is shown --

/** The window as the page needs it: everything but the document itself. */
export function wordState(session: string) {
  const desk = load(session);
  if (!desk) return { open: false };
  return {
    open: desk.open, name: desk.name, working: desk.working, rev: desk.rev, loadRev: desk.loadRev,
    since: desk.since, problem: desk.problem, versions: desk.versions,
  };
}

export function wordData(session: string): Buffer | null {
  return load(session)?.data ?? null;
}

// ------------------------------------------------- the agent's side --

export interface WordHooks {
  current(): { name: string; data: Buffer; working: string | null; source: string | null; outName: string } | null;
  /** Show this document in the window, or carry on with it after the agent changed it. */
  open(next: { name: string; data: Buffer; working: string | null; source: string | null; outName: string; label?: string }): void;
  /** Bring the window back if the person put it away: the agent is working on its document. */
  show(): void;
  /** What the person did in the window since the agent was last told, said once; "" when nothing. */
  news(): string;
}

export function wordHooks(session: string): WordHooks {
  return {
    current() {
      const desk = load(session);
      return desk ? { name: desk.name, data: desk.data, working: desk.working, source: desk.source, outName: desk.outName } : null;
    },
    open(next) {
      const was = load(session);
      const carried = Boolean(was && ((was.working !== null && was.working === next.working) || was.name === next.name || (was.source !== null && was.source === next.source)));
      if (was && !carried) {
        for (const v of was.versions) fs.rmSync(versionFile(session, v.n), { force: true });
      }
      const desk: Desk = {
        open: true,
        name: next.name, data: next.data, working: next.working, source: next.source, outName: next.outName,
        rev: (was?.rev ?? 0) + 1, loadRev: (was?.loadRev ?? 0) + 1,
        since: carried && was ? was.since : Date.now(),
        news: was?.news ?? [], problem: null,
        versions: carried && was ? was.versions : [], vseq: carried && was ? was.vseq : 0, dirty: false,
      };
      if (was && carried) {
        // What the person did so far is kept as a version before the agent's change goes on top.
        if (was.dirty || was.versions.length === 0) snapshot(session, was, was.versions.length === 0 ? "Opened" : "Your changes", was.versions.length === 0 ? "agent" : "person");
        desk.versions = was.versions;
        desk.vseq = was.vseq;
      }
      desks.set(session, desk);
      snapshot(session, desk, next.label ?? (was && carried ? "Changed by the agent" : "Opened"), "agent");
      persist(session);
      changed(session);
      if (!desk.working) rewrite(session);
    },
    show() {
      const desk = load(session);
      if (!desk || desk.open) return;
      desk.open = true;
      // Newest, so it takes the place beside the chat.
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
  const list = desk.news.slice(-6);
  const more = desk.news.length - list.length;
  return (
    `Meanwhile, in the Word window, the person ${list.join("; then ")}${more > 0 ? `; and ${more} earlier change${more === 1 ? "" : "s"}` : ""}. ` +
    `${desk.working ? `The file (${desk.working}) has these changes in it` : "These are in the window"}: ` +
    "work with them, and do not undo what they did unless they ask."
  );
}

/**
 * For the start of a turn: that a document is open in the window, and what the
 * person did there since the agent last heard. Null when there is no window.
 */
export function wordBriefing(session: string): string | null {
  const desk = load(session);
  if (!desk || !desk.open) return null;
  const lines = [
    `${desk.name} is open in the Word window beside the conversation${desk.working ? ` (artifact ${desk.working})` : ""}. ` +
      "The person can read it and type in it as you work, and what they type is saved as they go. office_edit on it is recorded as tracked changes " +
      "(unless you say track:false) that they accept or reject in the editor's Review tab; office_read, office_look and office_check read it as it is now.",
  ];
  if (desk.news.length) {
    lines.push(newsLine(desk));
    desk.news = [];
    persist(session);
  }
  return lines.join(" ");
}

// ------------------------------------------------ the person's side --

/** The editor saved: the document is what it sent. */
export function personSaved(session: string, data: Buffer): string | null {
  const desk = load(session);
  if (!desk) return "There is no document open in the window.";
  if (!isDocx(data)) return "That is not a Word document.";
  if (data.byteLength > MAX_ARTIFACT_BYTES) return "That file is over 50 MB.";
  if (data.equals(desk.data)) return null;
  const before = desk.data;
  desk.data = data;
  const a = docxParagraphs(before), b = docxParagraphs(data);
  const said = a && b ? describeChange(a, b) : ["edited the document"];
  if (said.length) {
    const line = said.join(" and ");
    desk.news.push(line);
    desk.news = desk.news.slice(-40);
    touched(session, "document", "edit", line);
  }
  desk.dirty = true;
  desk.rev++;
  persist(session);
  changed(session);
  rewrite(session);
  return null;
}

/** Go back to an earlier version of the document: the present one is kept too, so nothing is lost. */
export function restoreWordVersion(session: string, n: number): string | null {
  const desk = load(session);
  if (!desk) return "There is no document open in the window.";
  const v = desk.versions.find((x) => x.n === n);
  let data: Buffer | null = null;
  try {
    data = v ? fs.readFileSync(versionFile(session, v.n)) : null;
  } catch {
    data = null;
  }
  if (!v || !data) return "That version is not there any more.";
  if (desk.dirty) snapshot(session, desk, "Your changes", "person");
  desk.data = data;
  desk.rev++;
  desk.loadRev++;
  desk.news.push(`went back to version ${v.n} (${v.label})`);
  snapshot(session, desk, `Went back to version ${v.n}`, "person");
  persist(session);
  changed(session);
  rewrite(session);
  return null;
}

export function wordVersionFile(session: string, n: number): { name: string; data: Buffer } | null {
  const desk = load(session);
  const v = desk?.versions.find((x) => x.n === n);
  if (!v) return null;
  try {
    return { name: v.name.replace(/\.docx$/i, "") + `-v${v.n}.docx`, data: fs.readFileSync(versionFile(session, v.n)) };
  } catch {
    return null;
  }
}

/** Put the window away; it comes back the next time the agent works on a document. */
export function closeWord(session: string) {
  const desk = load(session);
  if (!desk || !desk.open) return;
  desk.open = false;
  persist(session);
  changed(session);
}

// ----------------------------------------------------------- routes --

const rawBody = express.raw({ type: () => true, limit: MAX_ARTIFACT_BYTES + 1024 });

export function wordRoutes(app: Express, opts: { exists: (session: string) => boolean }) {
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!validSession(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    return id;
  };

  app.get("/api/officedesk/:session", (req, res) => {
    const id = known(req, res);
    if (id) res.json(wordState(id));
  });

  app.get("/api/officedesk/:session/data", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const data = wordData(id);
    if (!data) return res.status(404).json({ error: "There is no document open in the window." });
    res.setHeader("Content-Type", DOCX_MIME);
    res.setHeader("Cache-Control", "no-store");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.send(data);
  });

  app.post("/api/officedesk/:session/save", rawBody, (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const problem = personSaved(id, Buffer.isBuffer(req.body) ? req.body : Buffer.alloc(0));
    if (problem) return res.status(400).json({ error: problem });
    res.json({ ok: true, rev: wordState(id).rev });
  });

  /* The person is in the editor right now. Nothing changes in the file; the
     agent is simply asked to leave the document alone and work on something
     else. Sent every few seconds while they keep at it. */
  app.post("/api/officedesk/:session/presence", express.json({ limit: "2kb" }), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    if (!load(id)) return res.json({ ok: true });
    touched(id, "document", "edit", "is working in the document", { tell: false });
    res.json({ ok: true });
  });

  app.post("/api/officedesk/:session/restore", express.json({ limit: "10kb" }), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const problem = restoreWordVersion(id, Number(req.body?.n));
    if (problem) return res.status(400).json({ error: problem });
    res.json({ ok: true });
  });

  app.get("/api/officedesk/:session/version/:n", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const f = wordVersionFile(id, Number(req.params.n));
    if (!f) return res.status(404).json({ error: "That version is not there any more." });
    res.setHeader("Content-Type", DOCX_MIME);
    res.setHeader("Content-Disposition", `attachment; filename="${f.name.replace(/[^\w. -]/g, "_")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.send(f.data);
  });

  app.post("/api/officedesk/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    closeWord(id);
    res.json({ ok: true });
  });
}

/**
 * The Office editors' own files. They run in a frame sandboxed without an
 * origin of its own (they open documents from anywhere), so this policy
 * repeats the frame's sandbox for anyone who opens the page directly, and the
 * files say any origin may read them: from inside the sandbox, they count as
 * another site's. Each editor is built as one page and asks the app for its
 * fonts, because requests from the frame carry no cookies and a login proxy in
 * front (Umbrel's) turns them away (office/vite/editor.mjs).
 */
export function serveOfficeEditors(app: Express, webDir: string) {
  app.use("/office-app", (_req, res, next) => {
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-downloads allow-modals allow-popups");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  }, express.static(webDir, { fallthrough: false }));
}
