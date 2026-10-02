/**
 * The Office window: the document the agent is working on (Word, PowerPoint or
 * Excel), open beside the conversation in GenOffice's own editor for it, for
 * the person to watch and to work on too.
 *
 * One per session, the sibling of the PDF window (./pdfdesk.ts). It holds the
 * document as bytes. The editor (built into dist/office/web/<docs|slides|sheets>,
 * shown in a sandboxed frame by src/components/OfficeWindow.tsx) saves, and each
 * save lands here: the file everyone else sees -- the Office tools, the
 * thread's file card, a download -- is an artifact kept current from it, so
 * there is no save button to forget. When the agent changes the document, the
 * new bytes replace these and the window loads them.
 *
 * Word keeps its document in the page: the page sends the bytes. PowerPoint and
 * Excel keep it in an engine (GenOffice's main-process code, run by
 * ./officehost.ts as a child process, one per window): the page reaches it
 * through /ipc, the engine saves to a file of its own, and that file is watched.
 *
 * What the person did is told to the agent once, in a sentence made by
 * comparing the text before and after (paragraphs, slide text, cells): with
 * the next Office tool result, or at the start of its next turn.
 *
 * The editor runs in a frame with no origin of its own and talks to the page by
 * messages only; it never calls this server (see office/shim/common.js).
 */

import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import express, { type Express, type Request, type Response } from "express";
import { MAX_ARTIFACT_BYTES, getArtifact, saveArtifact } from "./artifacts";
import { OfficeHost, hostBuilt, wire } from "./officehost";
import { slideElements } from "./office";
import { dropPages, latestPages, pageFile, pagesFor, type Locator } from "./officepages";
import { stateDir } from "./state";

export const DOCX_MIME = "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
export type OfficeKind = "docx" | "pptx" | "xlsx";
const MIME: Record<OfficeKind, string> = {
  docx: DOCX_MIME,
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
};
const kindOfName = (name: string): OfficeKind => (/\.pptx$/i.test(name) ? "pptx" : /\.xlsx$/i.test(name) ? "xlsx" : "docx");
/** What the person calls the document, and the surface they hold with Take control. */
const THING: Record<OfficeKind, string> = { docx: "Word", pptx: "PowerPoint", xlsx: "Excel" };

export type WordVersion = { n: number; label: string; at: number; by: "agent" | "person"; name: string };

type Desk = {
  open: boolean;
  kind: OfficeKind;
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
const extOf = (kind: OfficeKind) => kind;
const validSession = (id: string) => /^[A-Za-z0-9_-]{1,80}$/.test(id);

/** Every Office file is a zip. */
const isZip = (data: Buffer) => data.length > 100 && data[0] === 0x50 && data[1] === 0x4b && data[2] === 0x03 && data[3] === 0x04;
export const isDocx = isZip;
const MAIN_PART: Record<OfficeKind, string> = { docx: "word/document.xml", pptx: "ppt/presentation.xml", xlsx: "xl/workbook.xml" };
/** A zip that holds the part which makes it this kind of document. */
export const isOffice = (data: Buffer, kind: OfficeKind) => isZip(data) && zipEntry(data, MAIN_PART[kind]) !== null;

/** What the person does to the document, for whoever shares it with them (server/presence.ts). */
let touched: (session: string, subject: string, kind: string, detail: string, opts?: { tell?: boolean }) => void = () => undefined;
export function onOfficeTouch(fn: typeof touched) {
  touched = fn;
}

let changed: (session: string) => void = () => undefined;
/** Who to tell when a window changes: server.ts sends it to the session's sockets. */
export function onOfficeChange(fn: (session: string) => void) {
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

// ------------------------------- reading a deck and a workbook --

/** The names of a zip's entries. */
function zipNames(zip: Buffer): string[] {
  let end = -1;
  for (let i = zip.length - 22; i >= Math.max(0, zip.length - 22 - 0xffff); i -= 1) {
    if (zip.readUInt32LE(i) === 0x06054b50) { end = i; break; }
  }
  if (end < 0) return [];
  const count = zip.readUInt16LE(end + 10);
  let at = zip.readUInt32LE(end + 16);
  const names: string[] = [];
  for (let n = 0; n < count && at + 46 <= zip.length; n += 1) {
    if (zip.readUInt32LE(at) !== 0x02014b50) break;
    const nameLen = zip.readUInt16LE(at + 28);
    names.push(zip.toString("utf8", at + 46, at + 46 + nameLen));
    at += 46 + nameLen + zip.readUInt16LE(at + 30) + zip.readUInt16LE(at + 32);
  }
  return names;
}

const unescapeXml = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
  if (e[0] === "#") {
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
  }
  return ENTITIES[e.toLowerCase()] ?? whole;
});

/** The text of each paragraph on each slide, in order, each tagged with its slide ("Slide 2: Agenda"). */
export function pptxParagraphs(data: Buffer): string[] | null {
  try {
    const slides = zipNames(data)
      .map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    if (slides.length === 0 && zipEntry(data, "ppt/presentation.xml") === null) return null;
    const out: string[] = [];
    slides.forEach((m, index) => {
      const xml = zipEntry(data, m[0])?.toString("utf8") ?? "";
      for (const p of xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)) {
        let text = "";
        for (const t of p[0].matchAll(/<a:t(?:\s[^>]*)?>([\s\S]*?)<\/a:t>|<a:br\s*\/>/g)) text += t[1] === undefined ? "\n" : t[1];
        text = unescapeXml(text);
        if (text.trim()) out.push(`Slide ${index + 1}: ${text}`);
      }
      if (out.length > 20000) return;
    });
    return out;
  } catch {
    return null;
  }
}

/** Each filled cell as "Sheet1!B2" -> its value (and formula), or null when the file cannot be read this way. */
export function xlsxCells(data: Buffer): Map<string, string> | null {
  try {
    const book = zipEntry(data, "xl/workbook.xml")?.toString("utf8");
    if (!book) return null;
    const names = [...book.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescapeXml(m[1]));
    const shared: string[] = [];
    const sst = zipEntry(data, "xl/sharedStrings.xml")?.toString("utf8");
    if (sst) for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unescapeXml([...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
    const cells = new Map<string, string>();
    const sheets = zipNames(data)
      .map((n) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(n))
      .filter((m): m is RegExpExecArray => m !== null)
      .sort((a, b) => Number(a[1]) - Number(b[1]));
    sheets.forEach((m, index) => {
      const xml = zipEntry(data, m[0])?.toString("utf8") ?? "";
      const sheet = names[index] ?? `Sheet${index + 1}`;
      for (const c of xml.matchAll(/<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = /\br="([A-Z]+\d+)"/.exec(c[1])?.[1];
        if (!ref || !c[2]) continue;
        const type = /\bt="(\w+)"/.exec(c[1])?.[1];
        const f = /<f(?:\s[^>]*)?>([\s\S]*?)<\/f>/.exec(c[2])?.[1];
        const v = /<v>([\s\S]*?)<\/v>/.exec(c[2])?.[1];
        const inline = /<is>([\s\S]*?)<\/is>/.exec(c[2]);
        let value = "";
        if (type === "s" && v !== undefined) value = shared[Number(v)] ?? "";
        else if (type === "inlineStr" && inline) value = unescapeXml([...inline[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
        else if (v !== undefined) value = unescapeXml(v);
        const formula = f ? `=${unescapeXml(f)}` : "";
        if (value === "" && !formula) continue;
        cells.set(`${sheet}!${ref}`, formula ? `${formula}${value !== "" ? ` (${value})` : ""}` : value);
        if (cells.size > 200000) return;
      }
    });
    return cells;
  } catch {
    return null;
  }
}

const clipCell = (t: string) => (t.length > 40 ? `${t.slice(0, 40)}…` : t);

/** What differs between two versions of a workbook, as a colleague would say it. */
export function describeCells(before: Map<string, string>, after: Map<string, string>): string[] {
  const changed: string[] = [], added: string[] = [], cleared: string[] = [];
  for (const [ref, now] of after) {
    const was = before.get(ref);
    if (was === undefined) added.push(`${ref} (${JSON.stringify(clipCell(now))})`);
    else if (was !== now) changed.push(`${ref} from ${JSON.stringify(clipCell(was))} to ${JSON.stringify(clipCell(now))}`);
  }
  for (const [ref, was] of before) if (!after.has(ref)) cleared.push(`${ref} (was ${JSON.stringify(clipCell(was))})`);
  const list = (verb: string, items: string[]) => (items.length ? `${verb} ${items.slice(0, 5).join(", ")}${items.length > 5 ? ` and ${items.length - 5} more` : ""}` : "");
  const out = [list("changed", changed), list("filled in", added), list("cleared", cleared)].filter(Boolean);
  return out.length ? out : ["changed the formatting or the structure"];
}

/**
 * What a tap on a page of pictures can be told about the document it came from: a deck's elements (by the ids
 * office_edit takes), a workbook's cells (when the tapped value is in only one).
 */
async function locatorFor(kind: OfficeKind, data: Buffer): Promise<Locator | null> {
  if (kind === "pptx") {
    const elements = await slideElements(data);
    if (elements.length === 0) return null;
    return {
      page(n, words) {
        const here = elements.filter((e) => e.page === n);
        const area = (x: number, y: number) => here
          .filter((e) => x >= e.box[0] && x <= e.box[2] && y >= e.box[1] && y <= e.box[3])
          .sort((a, b) => (a.box[2] - a.box[0]) * (a.box[3] - a.box[1]) - (b.box[2] - b.box[0]) * (b.box[3] - b.box[1]))[0];
        return {
          words: words.map((w) => {
            const e = area((w.box[0] + w.box[2]) / 2, (w.box[1] + w.box[3]) / 2);
            return e ? { ...w, ref: `${e.id}` } : w;
          }),
          areas: here.map((e) => ({ box: e.box, ref: e.id, label: e.text ? `${e.type} “${e.text.slice(0, 40)}”` : `${e.type}${e.name ? ` “${e.name}”` : ""}` })),
        };
      },
    };
  }
  if (kind === "xlsx") {
    const cells = xlsxCells(data);
    if (!cells) return null;
    // A value shown on the page is a cell's value; named only when it is in just one cell.
    const byValue = new Map<string, string[]>();
    for (const [ref, text] of cells) {
      const shown = text.startsWith("=") ? /\(([^)]*)\)$/.exec(text)?.[1] ?? "" : text;
      if (!shown) continue;
      const list = byValue.get(shown.trim()) ?? [];
      list.push(ref);
      byValue.set(shown.trim(), list);
    }
    return {
      page(_n, words) {
        return { words: words.map((w) => { const refs = byValue.get(w.s.trim()); return refs && refs.length === 1 ? { ...w, ref: refs[0] } : w; }), areas: [] };
      },
    };
  }
  return null;
}

/** What the person did between two versions of the file, whatever the kind. */
function describeFiles(kind: OfficeKind, before: Buffer, after: Buffer): string[] {
  if (kind === "xlsx") {
    const a = xlsxCells(before), b = xlsxCells(after);
    return a && b ? describeCells(a, b) : ["edited the workbook"];
  }
  const a = kind === "pptx" ? pptxParagraphs(before) : docxParagraphs(before);
  const b = kind === "pptx" ? pptxParagraphs(after) : docxParagraphs(after);
  return a && b ? describeChange(a, b) : [kind === "pptx" ? "edited the deck" : "edited the document"];
}

// ---------------------------------------------------------- on disk --

function load(session: string): Desk | null {
  if (desks.has(session)) return desks.get(session) ?? null;
  if (!validSession(session)) return null;
  try {
    const meta = JSON.parse(fs.readFileSync(path.join(DIR, `${session}.json`), "utf8"));
    const name = String(meta.name || "document.docx");
    const kind: OfficeKind = meta.kind === "pptx" || meta.kind === "xlsx" || meta.kind === "docx" ? meta.kind : kindOfName(name);
    const desk: Desk = {
      open: meta.open === true, kind, name, data: fs.readFileSync(path.join(DIR, `${session}.${extOf(kind)}`)),
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
      fs.writeFileSync(path.join(DIR, `${session}.${extOf(desk.kind)}`), desk.data, { mode: 0o600 });
      const { data: _data, problem: _problem, ...meta } = desk;
      fs.writeFileSync(path.join(DIR, `${session}.json`), JSON.stringify(meta), { mode: 0o600 });
    } catch (err: any) {
      console.warn(`[worddesk] ${session}: could not save the window: ${err?.message ?? err}`);
    }
  }, 300));
}

/** A session that is deleted takes its window with it. */
export function dropOfficeDesk(session: string) {
  stopEngine(session);
  dropPages(session);
  desks.delete(session);
  try {
    for (const f of fs.readdirSync(DIR)) if (f === `${session}.json` || f.startsWith(`${session}.`)) fs.rmSync(path.join(DIR, f), { recursive: true, force: true });
  } catch {
    // Nothing was kept.
  }
}

// ------------------------------------------------------------ versions --

const versionFile = (session: string, n: number, kind: OfficeKind) => path.join(DIR, `${session}.v${n}.${extOf(kind)}`);

/** Keep the document as it is now as a version the person can go back to. */
function snapshot(session: string, desk: Desk, label: string, by: "agent" | "person") {
  const n = ++desk.vseq;
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    fs.writeFileSync(versionFile(session, n, desk.kind), desk.data, { mode: 0o600 });
  } catch (err: any) {
    console.warn(`[worddesk] ${session}: could not keep a version: ${err?.message ?? err}`);
  }
  desk.versions.push({ n, label: label.slice(0, 140), at: Date.now(), by, name: desk.name });
  desk.dirty = false;
  while (desk.versions.length > MAX_VERSIONS) {
    const old = desk.versions.shift();
    if (old) fs.rmSync(versionFile(session, old.n, desk.kind), { force: true });
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
      origin: "agent", name: keep?.name ?? desk.outName, data: desk.data, mime: MIME[desk.kind], session,
      note: `Edited in the ${THING[desk.kind]} window`,
    });
    desk.working = art.id;
    desk.problem = null;
  } catch (err: any) {
    desk.problem = `The file could not be updated: ${String(err?.message ?? err).split("\n")[0]}`;
  }
  persist(session);
  changed(session);
}

// ------------------------------ PowerPoint and Excel: the engine --

type Engine = {
  host: OfficeHost;
  kind: Exclude<OfficeKind, "docx">;
  /** The file the engine has open and saves to; the person's changes arrive by it. */
  file: string;
  /** The page (window load) that owns `wc`. */
  rev: number;
  wc: number | null;
  mtime: number;
  size: number;
  timer: NodeJS.Timeout;
  lastIpc: number;
  /** The width the deck's page asked its slides to be laid out for. */
  fit: number;
  /** Pages are made one at a time. */
  lock: Promise<unknown>;
};
const engines = new Map<string, Engine>();
const ENGINE_IDLE_MS = 15 * 60_000;

const workFile = (session: string, kind: OfficeKind) => path.join(DIR, `${session}.work.${extOf(kind)}`);

let pushed: (session: string, rev: number, channel: string, args: unknown) => void = () => undefined;
/** Who to tell when the engine sends its editor page something (server.ts forwards it to the window). */
export function onOfficePush(fn: typeof pushed) {
  pushed = fn;
}

/** The document the agent changed (or an earlier version came back): the engine's file becomes it. */
function engineFileChanged(session: string, desk: Desk) {
  if (desk.kind === "docx") return;
  try {
    fs.mkdirSync(DIR, { recursive: true, mode: 0o700 });
    const file = workFile(session, desk.kind);
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, desk.data, { mode: 0o600 });
    fs.renameSync(tmp, file);
    const engine = engines.get(session);
    if (engine) {
      const st = fs.statSync(file);
      engine.mtime = st.mtimeMs;
      engine.size = st.size;
    }
  } catch (err: any) {
    console.warn(`[officedesk] ${session}: could not write the document for the editor: ${err?.message ?? err}`);
  }
}

/**
 * The agent changed the file while the person has the editor open: the editor takes the new one where it is, so the slide
 * or sheet they were on stays. A deck is read again by the engine and handed to the page as the page expects a changed
 * deck (the editor keeps the slide it was on); a workbook is queued again and the page nudged to open it. False when
 * there is no page to do it in, and the window loads the document again instead.
 */
async function reloadLive(session: string): Promise<boolean> {
  const engine = engines.get(session);
  if (!engine || engine.wc === null) return false;
  try {
    if (engine.kind === "pptx") {
      const opened = await engine.host.invoke(engine.wc, "slides:open-path", [engine.file, engine.fit]);
      if (!opened || !Array.isArray(opened.slides)) return false;
      pushed(session, engine.rev, "slides:deck-changed", wire.enc([{ slides: opened.slides, size: opened.size }]));
      return true;
    }
    return Boolean(await engine.host.invoke(0, "autora:requeue", [engine.wc, engine.file]));
  } catch {
    return false;
  }
}

/** The person saved in the editor: the file changed under the engine. */
function checkEngineFile(session: string) {
  const engine = engines.get(session);
  const desk = load(session);
  if (!engine || !desk || desk.kind !== engine.kind) return;
  try {
    const st = fs.statSync(engine.file);
    if (st.mtimeMs === engine.mtime && st.size === engine.size) return;
    engine.mtime = st.mtimeMs;
    engine.size = st.size;
    const data = fs.readFileSync(engine.file);
    if (!data.equals(desk.data)) {
      const problem = personSaved(session, data);
      if (problem) {
        desk.problem = `That change was not kept: ${problem}`;
        changed(session);
      }
    }
  } catch {
    // Mid-write, or gone: the next look sees it.
  }
}

async function ensureEngine(session: string): Promise<Engine> {
  const desk = load(session);
  if (!desk || desk.kind === "docx") throw new Error("There is no PowerPoint or Excel document in the window.");
  const have = engines.get(session);
  if (have && have.kind === desk.kind) return have;
  if (have) stopEngine(session);
  if (!hostBuilt(desk.kind === "pptx" ? "slides" : "sheets")) throw new Error(`The ${THING[desk.kind]} editor's engine is not built on this server.`);
  const file = workFile(session, desk.kind);
  if (!fs.existsSync(file)) engineFileChanged(session, desk);
  const home = path.join(DIR, `${session}.engine`);
  fs.mkdirSync(home, { recursive: true, mode: 0o700 });
  const host = await OfficeHost.start(desk.kind === "pptx" ? "slides" : "sheets", null, { AUTORA_OFFICE_HOME: home });
  // Someone else may have started one while this waited.
  const raced = engines.get(session);
  if (raced) { host.stop(); return raced; }
  const st = fs.statSync(file);
  const engine: Engine = {
    host, kind: desk.kind, file, rev: 0, wc: null, mtime: st.mtimeMs, size: st.size, lastIpc: Date.now(), fit: 1200, lock: Promise.resolve(),
    timer: setInterval(() => {
      checkEngineFile(session);
      if (Date.now() - engine.lastIpc > ENGINE_IDLE_MS) stopEngine(session);
    }, 800),
  };
  engine.timer.unref?.();
  engines.set(session, engine);
  host.onPush((wc, channel, args) => {
    if (wc === engine.wc) pushed(session, engine.rev, channel, wire.enc(args));
  });
  void host.exited.then(() => {
    if (engines.get(session) !== engine) return;
    clearInterval(engine.timer);
    engines.delete(session);
    const now = load(session);
    if (now) {
      now.problem = `The ${THING[now.kind]} editor's engine stopped. Close the window and open the document again.`;
      changed(session);
    }
  });
  return engine;
}

function stopEngine(session: string) {
  const engine = engines.get(session);
  if (!engine) return;
  engines.delete(session);
  clearInterval(engine.timer);
  engine.host.stop();
}

/** The engine's id for the page that is asking: a new page (the window loaded again) gets a new one. */
async function pageFor(session: string, rev: number): Promise<{ engine: Engine; wc: number }> {
  const engine = await ensureEngine(session);
  const run = engine.lock.then(async () => {
    if (rev < engine.rev) throw new Error("That page is out of date: the window has loaded the document again.");
    if (rev > engine.rev || engine.wc === null) {
      if (engine.wc !== null) engine.host.closed(engine.wc);
      engine.wc = null;
      engine.rev = rev;
      // A deck's sessions are made when the page opens its file; a workbook's editor window is made by the engine.
      engine.wc = engine.kind === "pptx" ? rev : Number(await engine.host.invoke(0, "autora:view", [engine.file]));
    }
    return engine.wc;
  });
  engine.lock = run.catch(() => undefined);
  return { engine, wc: await run };
}

/** Wait for what the person has just done in the editor to reach the file, then read it. */
async function settleEngine(session: string) {
  const engine = engines.get(session);
  if (!engine || engine.wc === null) return;
  const until = Date.now() + 8000;
  if (engine.kind === "pptx") {
    // Its save is the editor's own, a moment after the change: ask whether anything is waiting.
    while (Date.now() < until) {
      const dirty = await engine.host.invoke(engine.wc, "slides:is-dirty", []).catch(() => false);
      if (!dirty) break;
      await new Promise((r) => setTimeout(r, 300));
    }
  } else {
    while (Date.now() < until && Date.now() - engine.lastIpc < 1200) await new Promise((r) => setTimeout(r, 200));
  }
  checkEngineFile(session);
}

// --------------------------------------------------- what is shown --

/** The window as the page needs it: everything but the document itself. */
export function officeState(session: string) {
  const desk = load(session);
  if (!desk) return { open: false };
  return {
    open: desk.open, kind: desk.kind, name: desk.name, working: desk.working, rev: desk.rev, loadRev: desk.loadRev,
    since: desk.since, problem: desk.problem, versions: desk.versions,
  };
}

export function officeData(session: string): Buffer | null {
  return load(session)?.data ?? null;
}

// ------------------------------------------------- the agent's side --

export interface OfficeHooks {
  current(): { kind: OfficeKind; name: string; data: Buffer; working: string | null; source: string | null; outName: string } | null;
  /** PowerPoint and Excel: wait for what the person has just done in the editor to reach the file, so `current()` has it. */
  settle(): Promise<void>;
  /** Show this document in the window, or carry on with it after the agent changed it. */
  open(next: { name: string; data: Buffer; working: string | null; source: string | null; outName: string; label?: string }): void;
  /** Bring the window back if the person put it away: the agent is working on its document. */
  show(): void;
  /** What the person did in the window since the agent was last told, said once; "" when nothing. */
  news(): string;
}

export function officeHooks(session: string): OfficeHooks {
  return {
    async settle() {
      await settleEngine(session);
    },
    current() {
      const desk = load(session);
      return desk ? { kind: desk.kind, name: desk.name, data: desk.data, working: desk.working, source: desk.source, outName: desk.outName } : null;
    },
    open(next) {
      const was = load(session);
      const kind = kindOfName(next.name);
      const carried = Boolean(was && was.kind === kind && ((was.working !== null && was.working === next.working) || was.name === next.name || (was.source !== null && was.source === next.source)));
      if (was && !carried) {
        for (const v of was.versions) fs.rmSync(versionFile(session, v.n, was.kind), { force: true });
        if (was.kind !== kind) stopEngine(session);
      }
      // A deck or workbook the person has open is changed in place; only if that fails does the window load it again.
      const live = Boolean(was && carried && kind !== "docx" && was.open && engines.get(session)?.wc != null);
      const desk: Desk = {
        open: true, kind,
        name: next.name, data: next.data, working: next.working, source: next.source, outName: next.outName,
        rev: (was?.rev ?? 0) + 1, loadRev: (was?.loadRev ?? 0) + (live ? 0 : 1),
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
      if (kind !== "docx") engineFileChanged(session, desk);
      persist(session);
      changed(session);
      if (!desk.working) rewrite(session);
      if (live) {
        void reloadLive(session).then((ok) => {
          if (ok) return;
          const now = desks.get(session);
          if (!now) return;
          now.loadRev++;
          persist(session);
          changed(session);
        });
      }
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
    `Meanwhile, in the ${THING[desk.kind]} window, the person ${list.join("; then ")}${more > 0 ? `; and ${more} earlier change${more === 1 ? "" : "s"}` : ""}. ` +
    `${desk.working ? `The file (${desk.working}) has these changes in it` : "These are in the window"}: ` +
    "work with them, and do not undo what they did unless they ask."
  );
}

/**
 * For the start of a turn: that a document is open in the window, and what the
 * person did there since the agent last heard. Null when there is no window.
 */
export function officeBriefing(session: string): string | null {
  const desk = load(session);
  if (!desk || !desk.open) return null;
  const lines = [
    `${desk.name} is open in the ${THING[desk.kind]} window beside the conversation${desk.working ? ` (artifact ${desk.working})` : ""}. ` +
      (desk.kind === "docx"
        ? "The person can read it and type in it as you work, and what they type is saved as they go. office_edit on it is recorded as tracked changes " +
          "(unless you say track:false) that they accept or reject in the editor's Review tab; office_read, office_look and office_check read it as it is now."
        : "The person can look at it and edit it as you work, and what they change is saved as they go. office_edit on it replaces the window's copy (the window reloads, so what they were looking at moves); " +
          "office_read, office_look and office_check read it as it is now."),
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
  if (!isOffice(data, desk.kind)) return `That is not a ${THING[desk.kind]} document.`;
  if (data.byteLength > MAX_ARTIFACT_BYTES) return "That file is over 50 MB.";
  if (data.equals(desk.data)) return null;
  const before = desk.data;
  desk.data = data;
  const said = describeFiles(desk.kind, before, data);
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
export function restoreOfficeVersion(session: string, n: number): string | null {
  const desk = load(session);
  if (!desk) return "There is no document open in the window.";
  const v = desk.versions.find((x) => x.n === n);
  let data: Buffer | null = null;
  try {
    data = v ? fs.readFileSync(versionFile(session, v.n, desk.kind)) : null;
  } catch {
    data = null;
  }
  if (!v || !data) return "That version is not there any more.";
  if (desk.dirty) snapshot(session, desk, "Your changes", "person");
  desk.data = data;
  desk.rev++;
  desk.loadRev++;
  if (desk.kind !== "docx") engineFileChanged(session, desk);
  desk.news.push(`went back to version ${v.n} (${v.label})`);
  snapshot(session, desk, `Went back to version ${v.n}`, "person");
  persist(session);
  changed(session);
  rewrite(session);
  return null;
}

export function officeVersionFile(session: string, n: number): { name: string; data: Buffer } | null {
  const desk = load(session);
  const v = desk?.versions.find((x) => x.n === n);
  if (!v) return null;
  try {
    return { name: v.name.replace(/\.(docx|pptx|xlsx)$/i, "") + `-v${v.n}.${extOf(desk!.kind)}`, data: fs.readFileSync(versionFile(session, v.n, desk!.kind)) };
  } catch {
    return null;
  }
}

/** Put the window away; it comes back the next time the agent works on a document. */
export function closeOffice(session: string) {
  const desk = load(session);
  if (!desk || !desk.open) return;
  desk.open = false;
  stopEngine(session);
  persist(session);
  changed(session);
}

// ----------------------------------------------------------- routes --

const rawBody = express.raw({ type: () => true, limit: MAX_ARTIFACT_BYTES + 1024 });

export function officeRoutes(app: Express, opts: { exists: (session: string) => boolean }) {
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
    if (id) res.json(officeState(id));
  });

  app.get("/api/officedesk/:session/data", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const data = officeData(id);
    if (!data) return res.status(404).json({ error: "There is no document open in the window." });
    res.setHeader("Content-Type", MIME[load(id)?.kind ?? "docx"]);
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
    res.json({ ok: true, rev: officeState(id).rev });
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
    const problem = restoreOfficeVersion(id, Number(req.body?.n));
    if (problem) return res.status(400).json({ error: problem });
    res.json({ ok: true });
  });

  app.get("/api/officedesk/:session/version/:n", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const f = officeVersionFile(id, Number(req.params.n));
    if (!f) return res.status(404).json({ error: "That version is not there any more." });
    res.setHeader("Content-Type", MIME[load(id)?.kind ?? "docx"]);
    res.setHeader("Content-Disposition", `attachment; filename="${f.name.replace(/[^\w. -]/g, "_")}"`);
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.send(f.data);
  });

  /* The editor page's ipc, for the engines behind PowerPoint and Excel. `rev` says which load of the window
     the page is, so a page that has been replaced cannot reach the engine's new one. */
  const channelOk = (c: unknown): c is string => typeof c === "string" && /^[\w:.-]{1,80}$/.test(c) && !c.startsWith("autora:");
  /* A PowerPoint or Excel editor page has loaded: the file its engine has open (a deck's page opens it itself). */
  app.post("/api/officedesk/:session/page", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    try {
      const { engine } = await pageFor(id, Number(req.query.rev) || 0);
      res.json({ path: engine.file, name: load(id)?.name ?? "document" });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  app.post("/api/officedesk/:session/ipc", express.json({ limit: "80mb" }), async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const { channel, args } = req.body ?? {};
    if (!channelOk(channel)) return res.status(400).json({ error: "Not a channel." });
    try {
      const { engine, wc } = await pageFor(id, Number(req.query.rev) || 0);
      engine.lastIpc = Date.now();
      if (channel === "slides:open-path" || channel === "slides:consume-pending-open") {
        const fit = Number((Array.isArray(args) ? args : [])[channel === "slides:open-path" ? 1 : 0]);
        if (Number.isFinite(fit) && fit > 100) engine.fit = fit;
      }
      const value = await engine.host.invoke(wc, channel, wire.dec(Array.isArray(args) ? args : []));
      engine.lastIpc = Date.now();
      res.json({ value: wire.enc(value) });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  app.post("/api/officedesk/:session/ipc-send", express.json({ limit: "80mb" }), async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const { channel, args } = req.body ?? {};
    if (!channelOk(channel)) return res.status(400).json({ error: "Not a channel." });
    try {
      const { engine, wc } = await pageFor(id, Number(req.query.rev) || 0);
      engine.lastIpc = Date.now();
      engine.host.send(wc, channel, wire.dec(Array.isArray(args) ? args : []));
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: String(err?.message ?? err) });
    }
  });

  /* The document as pictures of its pages, for a phone: drawn once and kept by what the file holds (./officepages.ts).
     Asked again until it says ready; what was drawn before is offered meanwhile, marked out of date. */
  app.post("/api/officedesk/:session/pages", async (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const desk = load(id);
    if (!desk) return res.status(404).json({ error: "There is no document open in the window." });
    await settleEngine(id);
    const now = load(id) ?? desk;
    const got = pagesFor(id, now.kind, now.name, now.data, () => locatorFor(now.kind, now.data));
    const stale = got.status === "ready" ? null : latestPages(id);
    res.json({
      kind: now.kind, name: now.name, status: got.status,
      ...(got.status === "ready" ? { hash: got.manifest.hash, pages: got.manifest.pages, total: got.manifest.total } : {}),
      ...(got.status === "failed" ? { error: got.error } : {}),
      ...(stale ? { stale: { hash: stale.hash, pages: stale.pages, total: stale.total } } : {}),
    });
  });

  app.get("/api/officedesk/:session/pages/:hash/:file", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const m = /^(\d{1,3})\.(jpg|json)$/.exec(String(req.params.file));
    const data = m ? pageFile(id, String(req.params.hash), Number(m[1]), m[2] as "jpg" | "json") : null;
    if (!m || !data) return res.status(404).json({ error: "That page is not there." });
    res.setHeader("Content-Type", m[2] === "jpg" ? "image/jpeg" : "application/json");
    res.setHeader("Cache-Control", "private, max-age=31536000, immutable");
    res.setHeader("X-Content-Type-Options", "nosniff");
    res.setHeader("Content-Security-Policy", "sandbox");
    res.send(data);
  });

  app.post("/api/officedesk/:session/close", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    closeOffice(id);
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
/** A page or font, compressed once and kept: the Excel editor is 14 MB as it is and under 3 MB sent compressed. */
const squeezed = new Map<string, { stamp: string; br: Buffer; gz: Buffer }>();
const SQUEEZE = /\.(html|js|css|ttf|otf|json|svg)$/i;

export function serveOfficeEditors(app: Express, webDir: string) {
  app.use("/office-app", (_req, res, next) => {
    res.setHeader("Content-Security-Policy", "sandbox allow-scripts allow-downloads allow-modals allow-popups");
    res.setHeader("Access-Control-Allow-Origin", "*");
    res.setHeader("X-Content-Type-Options", "nosniff");
    next();
  }, (req, res, next) => {
    if (req.method !== "GET" || !SQUEEZE.test(req.path)) return next();
    const accepts = String(req.headers["accept-encoding"] ?? "");
    const want = /\bbr\b/.test(accepts) ? "br" : /\bgzip\b/.test(accepts) ? "gz" : null;
    if (!want) return next();
    try {
      const file = path.resolve(webDir, "." + path.posix.normalize("/" + decodeURIComponent(req.path)));
      if (!file.startsWith(path.resolve(webDir) + path.sep)) return next();
      const st = fs.statSync(file);
      if (!st.isFile()) return next();
      const stamp = `${st.mtimeMs}-${st.size}`;
      let kept = squeezed.get(file);
      if (!kept || kept.stamp !== stamp) {
        const raw = fs.readFileSync(file);
        kept = {
          stamp,
          // Quality 5: most of the size for a fraction of the time, and it is done once.
          br: zlib.brotliCompressSync(raw, { params: { [zlib.constants.BROTLI_PARAM_QUALITY]: 5, [zlib.constants.BROTLI_PARAM_SIZE_HINT]: raw.length } }),
          gz: zlib.gzipSync(raw, { level: 6 }),
        };
        squeezed.set(file, kept);
      }
      const etag = `"${stamp}-${want}"`;
      res.setHeader("Vary", "Accept-Encoding");
      res.setHeader("ETag", etag);
      res.setHeader("Cache-Control", "private, no-cache");
      if (req.headers["if-none-match"] === etag) return void res.status(304).end();
      const type = { ".html": "text/html; charset=utf-8", ".js": "text/javascript", ".css": "text/css", ".json": "application/json", ".svg": "image/svg+xml" }[path.extname(file).toLowerCase()] ?? "application/octet-stream";
      res.setHeader("Content-Type", type);
      res.setHeader("Content-Encoding", want === "br" ? "br" : "gzip");
      res.send(want === "br" ? kept.br : kept.gz);
    } catch {
      next();
    }
  }, express.static(webDir, { fallthrough: false }));
}
