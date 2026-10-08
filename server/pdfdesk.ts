/**
 * The PDF window: the file the agent is working on, open beside the
 * conversation in Spectra-PDF's editor (spectra-editor/, served by server/spectra.ts), for the person to watch
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
 * the page by messages only (see server/spectra.ts for how it is served).
 */

import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import express, { type Express, type Request, type Response } from "express";
import { getArtifact, saveArtifact, MAX_ARTIFACT_BYTES } from "./artifacts";
import { outlineLines } from "./compose";
import { cueForItem, flattenDesk, type Cue, type DeskHooks, type DeskItem, type DeskSnapshot } from "./pdf";
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
  /** What the agent changed that the person has not yet accepted or declined. */
  marks: Mark[];
  /** Earlier states of the file, oldest first. */
  versions: Version[];
  vseq: number;
  /** The person changed something since the last version was kept. */
  dirty: boolean;
  /** Where the agent last worked, for the window to play; not kept on disk. */
  cues?: Cue[];
  /** Goes up each time there are cues to play, so each plays once. */
  cueSeq?: number;
};

/** One change by the agent, up for review in the window. */
type Mark = {
  id: string;
  kind: "add" | "edit" | "remove" | "page";
  /** The object it is about (not for "page"). */
  itemId?: string;
  page: number;
  label: string;
  /** The object as it was, to put back when the change is declined. */
  before?: DeskItem;
  /** For "page": the pages as they were, kept as a base file. */
  beforeBaseRev?: number;
};

type Version = {
  n: number;
  label: string;
  at: number;
  by: "agent" | "person";
  name: string;
  baseRev: number;
  items: DeskItem[];
};

const MAX_VERSIONS = 40;
/** At most this many places are shown being worked on in one go; the rest simply arrive. */
const MAX_SHOWN = 8;

const desks = new Map<string, Desk>();
const DIR = path.join(stateDir(), "desks");
const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);
const isPdf = (data: Buffer) => data.subarray(0, 1024).includes("%PDF-");

/** What the person does to the file, for whoever shares it with them
    (server/presence.ts): an object they touched is theirs for a moment. */
let touched: (session: string, subject: string, kind: string, detail: string, opts?: { tell?: boolean }) => void = () => undefined;
export function onDeskTouch(fn: typeof touched) {
  touched = fn;
}

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
      compose: meta.compose && typeof meta.compose === "object" && Array.isArray(meta.compose.blocks) ? meta.compose : null,
      outline: Array.isArray(meta.outline) ? meta.outline : null,
      open: meta.open === true, outName: String(meta.outName || meta.name || "document.pdf"),
      baseRev: Number(meta.baseRev) || 1, rev: Number(meta.rev) || 1,
      news: Array.isArray(meta.news) ? meta.news.map(String) : [], since: Number(meta.since) || Date.now(), problem: null,
      marks: Array.isArray(meta.marks) ? meta.marks : [], versions: Array.isArray(meta.versions) ? meta.versions : [],
      vseq: Number(meta.vseq) || 0, dirty: meta.dirty === true,
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
  try {
    for (const f of fs.readdirSync(DIR)) if (f === `${session}.json` || f === `${session}.pdf` || f.startsWith(`${session}.b`)) fs.rmSync(path.join(DIR, f), { force: true });
  } catch {}
}

// ------------------------------------------------------------ versions --

const baseFile = (session: string, baseRev: number) => path.join(DIR, `${session}.b${baseRev}.pdf`);

/** Keep the pages as they are now, under their revision, once. */
function keepBase(session: string, desk: Desk) {
  const file = baseFile(session, desk.baseRev);
  try {
    if (fs.existsSync(file)) return;
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(file, desk.base, { mode: 0o600 });
  } catch (err: any) {
    console.warn(`[pdfdesk] ${session}: could not keep a version: ${err?.message ?? err}`);
  }
}

/** Keep the file as it is now as a version the person can go back to. */
function snapshot(session: string, desk: Desk, label: string, by: "agent" | "person") {
  keepBase(session, desk);
  desk.versions.push({
    n: ++desk.vseq, label: label.slice(0, 140), at: Date.now(), by, name: desk.name, baseRev: desk.baseRev,
    items: JSON.parse(JSON.stringify(desk.items)),
  });
  desk.dirty = false;
  while (desk.versions.length > MAX_VERSIONS) desk.versions.shift();
  const used = new Set<number>([desk.baseRev, ...desk.versions.map((v) => v.baseRev), ...desk.marks.flatMap((m) => (m.beforeBaseRev ? [m.beforeBaseRev] : []))]);
  try {
    for (const f of fs.readdirSync(DIR)) {
      const m = f.startsWith(`${session}.b`) ? /\.b(\d+)\.pdf$/.exec(f) : null;
      if (m && !used.has(Number(m[1]))) fs.rmSync(path.join(DIR, f), { force: true });
    }
  } catch {}
}

function versionBase(session: string, v: Version): Buffer | null {
  try {
    return fs.readFileSync(baseFile(session, v.baseRev));
  } catch {
    return null;
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
    cues: desk.cues, cueSeq: desk.cueSeq,
    marks: desk.marks.map(({ before: _before, ...m }) => m),
    versions: desk.versions.map(({ items: _items, ...v }) => v),
  };
}

export function deskBase(session: string): Buffer | null {
  return load(session)?.base ?? null;
}

/**
 * The document as the PDF editor should open it: the pages with what the agent placed on them drawn in. The editor
 * knows nothing of the desk's objects (they are Autora's, kept apart from the pages so the person can accept or decline
 * each one), so handed only the pages it showed the agent's work as nothing at all: the cursor typed a name onto a
 * blank page. What it saves comes back as the pages (see personBase), with those marks part of them.
 */
export async function deskDocument(session: string, cwd: string): Promise<Buffer | null> {
  const desk = load(session);
  if (!desk) return null;
  if (!desk.items.length) return desk.base;
  try {
    return (await flattenDesk(desk.base, desk.items, cwd)).data;
  } catch {
    return desk.base;
  }
}

// ------------------------------------------------- the agent's side --

const markId = () => `mk_${crypto.randomBytes(4).toString("hex")}`;

function dropVersions(session: string) {
  try {
    for (const f of fs.readdirSync(DIR)) if (f.startsWith(`${session}.b`)) fs.rmSync(path.join(DIR, f), { force: true });
  } catch {}
}

const plain = (item: DeskItem) => {
  const rest: Record<string, any> = { ...item };
  delete rest.autora;
  return JSON.stringify(rest);
};

/** What the agent added, changed or removed among the objects. */
function diffItems(before: DeskItem[], after: DeskItem[]): Mark[] {
  const was = new Map(before.map((i) => [i.id, i]));
  const now = new Map(after.map((i) => [i.id, i]));
  const out: Mark[] = [];
  for (const item of after) {
    const old = was.get(item.id);
    if (!old) out.push({ id: markId(), kind: "add", itemId: item.id, page: item.pageNumber, label: `Added ${label(item, false)}` });
    else if (plain(old) !== plain(item)) out.push({ id: markId(), kind: "edit", itemId: item.id, page: item.pageNumber, label: `Changed ${label(item, false)}`, before: old });
  }
  for (const item of before) {
    if (!now.has(item.id)) out.push({ id: markId(), kind: "remove", itemId: item.id, page: item.pageNumber, label: `Removed ${label(item, false)}`, before: item });
  }
  return out;
}

/** The window as the PDF tools of one session see it. */
export function deskHooks(session: string): DeskHooks {
  return {
    current() {
      const desk = load(session);
      return desk ? { name: desk.name, base: desk.base, items: desk.items, working: desk.working, source: desk.source, compose: desk.compose ?? null, outline: desk.outline ?? null } : null;
    },
    open(next) {
      const was = load(session);
      const sameFile = was && was.working !== null && was.working === next.working;
      // The same document carried on, or another one that replaces it.
      const carried = Boolean(was && (sameFile || was.name === next.name || (was.source !== null && was.source === next.source)));
      const { review, cues, sizes, ...snap } = next;
      if (was && !carried) dropVersions(session);
      /* What the window shows the agent doing: the words it retyped, and each
         object it placed, in the order they were added. */
      const had = new Set((was?.items ?? []).map((i) => i.id));
      const placed = snap.items.filter((i) => !had.has(i.id)).map(cueForItem).filter((c): c is Cue => c !== null);
      const shown = [...(cues ?? []), ...placed].slice(0, MAX_SHOWN).map((c) => {
        const size = sizes?.[c.page - 1];
        return size ? { ...c, pw: size.w, ph: size.h } : c;
      });
      const desk: Desk = {
        ...snap,
        open: true,
        baseRev: (was?.baseRev ?? 0) + 1,
        rev: (was?.rev ?? 0) + 1,
        news: was?.news ?? [],
        since: sameFile && was ? was.since : Date.now(),
        problem: null,
        marks: carried && was ? was.marks : [],
        versions: carried && was ? was.versions : [],
        vseq: carried && was ? was.vseq : 0,
        dirty: false,
        cues: shown.length ? shown : undefined,
        cueSeq: (was?.cueSeq ?? 0) + (shown.length ? 1 : 0),
      };
      if (was && carried) {
        // What the person did so far is kept as a version before the agent's change goes on top.
        if (was.dirty || was.versions.length === 0) snapshot(session, was, was.versions.length === 0 ? "Opened" : "Your changes", was.versions.length === 0 ? "agent" : "person");
        if (review?.baseNote) {
          keepBase(session, was);
          desk.marks.push({ id: markId(), kind: "page", page: 1, label: review.baseNote, beforeBaseRev: was.baseRev });
        }
        if (review?.diff !== false) desk.marks.push(...diffItems(was.items, desk.items));
        desk.versions = was.versions;
        desk.vseq = was.vseq;
      }
      desks.set(session, desk);
      if (!was || !carried || review) snapshot(session, desk, review?.label ?? (was && carried ? "Changed by the agent" : "Opened"), "agent");
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
  if (desk.compose && desk.outline) {
    const pages = Math.max(0, ...desk.outline.map((o) => o.endPage));
    const outline = outlineLines(desk.outline);
    lines.push(
      `It was made with pdf_compose (${desk.compose.blocks.length} blocks, ${pages} page${pages === 1 ? "" : "s"}): to change its content send update / insert / remove with block ids -- ` +
        "it is laid out again whole, so nothing is repositioned. Where things are (page, heading [block id], how it starts):\n" +
        outline.join("\n"),
    );
  } else if (desk.working) {
    lines.push("It was not made with pdf_compose, so changing its words means pdf_edit (objects) or composing a new document.");
  }
  const mine = desk.items.filter((i) => i.autora).slice(-30);
  if (mine.length) lines.push(`Your objects on it (ids for pdf_edit's change and remove): ${mine.map((i) => `${i.id} = ${label(i, false)}`).join("; ")}.`);
  const others = desk.items.filter((i) => !i.autora);
  if (others.length) {
    const pages = [...new Set(others.map((i) => i.pageNumber))].sort((a, b) => a - b);
    lines.push(`The person has added ${others.length} object${others.length === 1 ? "" : "s"} of their own, on page${pages.length === 1 ? "" : "s"} ${pages.slice(0, 12).join(", ")}: leave them as they are.`);
  }
  if (desk.marks.length) {
    const shown = desk.marks.slice(0, 8).map((m) => m.label).join("; ");
    lines.push(`${desk.marks.length} of your change${desk.marks.length === 1 ? " is" : "s are"} still waiting for the person to accept or decline: ${shown}${desk.marks.length > 8 ? "; ..." : ""}.`);
  }
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

function label(item: DeskItem, owner = true): string {
  const whose = owner && item.autora ? "your " : "";
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
    if (!was) {
      desk.news.push(`added ${label(item)}`);
      touched(session, item.id, "add", `added ${label(item)}`);
    } else if (JSON.stringify({ ...was, x: 0, y: 0, drawingPoints: 0 }) === JSON.stringify({ ...item, x: 0, y: 0, drawingPoints: 0 })) {
      if (was.x !== item.x || was.y !== item.y) {
        desk.news.push(`moved ${label(item)}`);
        touched(session, item.id, "move", `moved ${label(item)}`);
      }
    } else {
      desk.news.push(`changed ${label(item)}`);
      touched(session, item.id, "edit", `changed ${label(item)}`);
    }
    byId.set(item.id, item);
  }
  for (const id of remove.slice(0, 500).map(String)) {
    const was = byId.get(id);
    if (!was) continue;
    desk.news.push(`removed ${label(was)}`);
    touched(session, id, "remove", `removed ${label(was)}`);
    byId.delete(id);
  }
  desk.news = squash(desk.news).slice(-40);
  desk.items = [...byId.values()];
  desk.dirty = true;
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
  touched(session, "*", "pages", "changed the pages themselves (deleting, turning, reordering or merging pages)");
  desk.compose = null;
  desk.outline = null;
  desk.baseRev++;
  desk.rev++;
  desk.dirty = true;
  persist(session);
  changed(session);
  rewrite(session, cwd);
  return null;
}

/** The person accepts one of the agent's changes, or all of them: it stays as it is. */
export function acceptMarks(session: string, id: string | "all"): boolean {
  const desk = load(session);
  if (!desk) return false;
  desk.marks = id === "all" ? [] : desk.marks.filter((m) => m.id !== id);
  persist(session);
  changed(session);
  return true;
}

/** The person declines one of the agent's changes, or all of them: it is undone, and the agent is told. */
export function denyMarks(session: string, id: string | "all", cwd: string): boolean {
  const desk = load(session);
  if (!desk) return false;
  const marks = id === "all" ? [...desk.marks].reverse() : desk.marks.filter((m) => m.id === id);
  if (!marks.length) return false;
  const byId = new Map(desk.items.map((i) => [i.id, i]));
  for (const m of marks) {
    if (m.kind === "add" && m.itemId) byId.delete(m.itemId);
    else if ((m.kind === "edit" || m.kind === "remove") && m.before) byId.set(m.before.id, m.before);
    else if (m.kind === "page" && m.beforeBaseRev) {
      try {
        desk.base = fs.readFileSync(baseFile(session, m.beforeBaseRev));
        // The pages are no longer what the description laid out.
        desk.compose = null;
        desk.outline = null;
        desk.baseRev++;
      } catch {
        continue;
      }
    }
    desk.news.push(`declined your change: ${m.label.charAt(0).toLowerCase()}${m.label.slice(1)}`);
  }
  const gone = new Set(marks.map((m) => m.id));
  desk.marks = desk.marks.filter((m) => !gone.has(m.id));
  desk.items = [...byId.values()];
  desk.rev++;
  snapshot(session, desk, marks.length === 1 ? `Declined: ${marks[0].label}` : `Declined ${marks.length} changes`, "person");
  persist(session);
  changed(session);
  rewrite(session, cwd);
  return true;
}

/** Go back to an earlier version of the file: the present one is kept too, so nothing is lost. */
export function restoreVersion(session: string, n: number, cwd: string): string | null {
  const desk = load(session);
  if (!desk) return "There is no PDF open in the window.";
  const v = desk.versions.find((x) => x.n === n);
  const base = v ? versionBase(session, v) : null;
  if (!v || !base) return "That version is not there any more.";
  if (desk.dirty) snapshot(session, desk, "Your changes", "person");
  desk.base = base;
  desk.compose = null;
  desk.outline = null;
  desk.items = JSON.parse(JSON.stringify(v.items));
  desk.baseRev++;
  desk.rev++;
  desk.marks = [];
  desk.news.push(`went back to version ${v.n} (${v.label})`);
  snapshot(session, desk, `Went back to version ${v.n}`, "person");
  persist(session);
  changed(session);
  rewrite(session, cwd);
  return null;
}

/** An earlier version as a PDF, flattened as it was. */
export async function versionFile(session: string, n: number, cwd: string): Promise<{ name: string; data: Buffer } | null> {
  const desk = load(session);
  const v = desk?.versions.find((x) => x.n === n);
  const base = v ? versionBase(session, v) : null;
  if (!v || !base) return null;
  const { data } = await flattenDesk(base, v.items, cwd);
  return { name: v.name.replace(/\.pdf$/i, "") + `-v${v.n}.pdf`, data };
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

  /* What the person has hold of in the editor right now: an object selected or
     being dragged. Nothing changes in the file; the agent is simply asked to
     leave it alone and work on something else. Sent every few seconds while it
     stays held. */
  app.post("/api/pdfdesk/:session/presence", express.json({ limit: "2kb" }), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const target = String(req.body?.id ?? "");
    const kind = String(req.body?.kind ?? "select");
    if (!/^[\w.-]{1,80}$/.test(target) || !["select", "drag", "edit"].includes(kind)) return res.status(400).json({ error: "Not an object." });
    const item = load(id)?.items.find((i) => i.id === target);
    if (!item) return res.json({ ok: true });
    touched(id, target, kind, `${kind === "drag" ? "is moving" : "has selected"} ${label(item)}`, { tell: false });
    res.json({ ok: true });
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

  app.post("/api/pdfdesk/:session/review", express.json({ limit: "10kb" }), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const action = String(req.body?.action ?? "");
    const mark = req.body?.all === true ? "all" : String(req.body?.id ?? "");
    const ok = action === "accept" ? acceptMarks(id, mark) : action === "deny" ? denyMarks(id, mark, opts.cwd()) : false;
    if (!ok) return res.status(400).json({ error: "Nothing to review there." });
    res.json({ ok: true });
  });

  app.post("/api/pdfdesk/:session/restore", express.json({ limit: "10kb" }), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const problem = restoreVersion(id, Number(req.body?.n), opts.cwd());
    if (problem) return res.status(400).json({ error: problem });
    res.json({ ok: true });
  });

  app.get("/api/pdfdesk/:session/version/:n", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    versionFile(id, Number(req.params.n), opts.cwd()).then((f) => {
      if (!f) return res.status(404).json({ error: "That version is not there any more." });
      res.setHeader("Content-Type", "application/pdf");
      res.setHeader("Content-Disposition", `attachment; filename="${f.name.replace(/[^\w. -]/g, "_")}"`);
      res.setHeader("X-Content-Type-Options", "nosniff");
      res.setHeader("Content-Security-Policy", "sandbox");
      res.send(f.data);
    }).catch(() => res.status(500).json({ error: "That version could not be made." }));
  });

  app.post("/api/pdfdesk/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    closeDesk(id);
    res.json({ ok: true });
  });
}
