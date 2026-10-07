/**
 * PDFs: read, look at, fill in, sign, mark up, rearrange, redact and shrink.
 *
 * The agent's half of SecurePDF, without its editor: the same things done to
 * a file, asked for in words, with each result saved as a new artifact the
 * person can open from the thread. The file itself is changed here with
 * pdf-lib (the @cantoo fork, which opens password-protected files); anything
 * that needs the page as it looks -- pictures, where words sit, the pages a
 * redaction or compression redraws, a typed signature -- comes from pdf.js in
 * ./pdfrender.ts.
 *
 * One coordinate system throughout, the one a person reading the page would
 * use: points (1/72 inch) from the top-left corner of the page as it is
 * shown, y growing downwards, rotation and crop already applied. What
 * pdf_read reports, what pdf_look's grid labels and what pdf_edit takes are
 * therefore the same numbers, whatever the file does underneath.
 *
 * Nothing overwrites what the person gave: every result is a new artifact
 * (or the agent's own earlier result, updated in place). Removing something
 * removes it: pages that are dropped or redrawn are cut loose from the file
 * and everything no longer reachable is left out when it is written, so a
 * deleted page or a redacted line is not still in the bytes.
 */

import crypto from "node:crypto";
import {
  BlendMode, LineCapStyle, PDFArray, PDFBool, PDFButton, PDFCheckBox, PDFDict, PDFDocument, PDFDropdown,
  PDFHexString, PDFName, PDFNull, PDFNumber, PDFOptionList, PDFPage, PDFRadioGroup, PDFRawStream, PDFRef, PDFSignature,
  PDFStream, PDFString, PDFTextField, StandardFonts, concatTransformationMatrix, decodePDFRawStream, degrees,
  popGraphicsState, pushGraphicsState, rgb, type PDFField, type PDFFont, type PDFImage, type RGB,
} from "@cantoo/pdf-lib";
import type { ChatImage } from "./llm";
import {
  artifactPath, cleanName, formatSize, getArtifact, listArtifacts, mimeFor, readArtifact, saveArtifact,
  MAX_ARTIFACT_BYTES, type Artifact,
} from "./artifacts";
import { readFileRef as sharedFileRef, FileRefError, type FileInput } from "./fileref";
import { replaceOnPage, type TextEdit } from "./pdftext";
import { PdfRenderError, withPdf, type PageText, type PdfView, type Rect } from "./pdfrender";
import { applyChanges, compose, ComposeError, outlineLines, type ComposeSource, type ImageLoader, type OutlineEntry } from "./compose";

// ------------------------------------------------------------- context --

/** What a PDF tool needs from the turn it runs in. */
interface PdfContext {
  session: string;
  /** Where a relative path starts: the terminal's working directory. */
  cwd: string;
  /** How many characters of text a result may carry. */
  room: number;
  putBlob: (data: Buffer, mime: string) => string;
  showImage: (blob: string, alt: string, caption: string | null, size?: { w: number; h: number }) => void;
  /** Show a file the tool made in the conversation, to open or download. */
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
  cancelled: () => boolean;
  onCancel: (stop: () => void) => void;
  /** The session's PDF window, when there is one to show the work in. */
  desk?: DeskHooks;
  /** Why an object may not be changed right now (the person is working on
      it), or null. */
  held?: (objectId: string) => string | null;
}

interface PdfOutcome {
  ok: boolean;
  summary: string;
  preview?: string;
  images?: ChatImage[];
  /** Not done because the person is working on it: not an error. */
  held?: boolean;
}

/** A failure the agent is told in so many words. */
class Problem extends Error {}

function message(err: unknown): string {
  return String((err as Error)?.message ?? err).split("\n")[0];
}

export async function runPdfTool(name: string, args: Record<string, any>, ctx: PdfContext): Promise<PdfOutcome> {
  const outcome = await runOne(name, args, ctx);
  // What the person did in the PDF window meanwhile, said with the next result.
  const news = ctx.desk?.news() ?? "";
  return news ? { ...outcome, summary: `${outcome.summary} ${news}` } : outcome;
}

async function runOne(name: string, args: Record<string, any>, ctx: PdfContext): Promise<PdfOutcome> {
  try {
    switch (name) {
      case "pdf_read": return await readTool(args, ctx);
      case "pdf_look": return await lookTool(args, ctx);
      case "pdf_edit": return await editTool(args, ctx);
      case "pdf_compose": return await composeTool(args, ctx);
      case "pdf_pages": return await pagesTool(args, ctx);
      case "pdf_redact": return await redactTool(args, ctx);
      case "pdf_replace_text": return await replaceTextTool(args, ctx);
      case "pdf_compress": return await compressTool(args, ctx);
      default: return { ok: false, summary: `There is no PDF tool called ${name}.` };
    }
  } catch (err) {
    if (err instanceof Problem || err instanceof PdfRenderError || err instanceof ComposeError) return { ok: false, summary: err.message };
    return { ok: false, summary: `${name} failed: ${message(err)}` };
  }
}

// --------------------------------------------------------------- input --

type Input = FileInput;

const isPdf = (data: Buffer) => data.subarray(0, 1024).includes("%PDF-");

/** A file named the ways the agent names one: an artifact id, a path on this
    host, or an artifact's name. */
function readFileRef(given: unknown, cwd: string, what: string): Input {
  try {
    return sharedFileRef(given, cwd, what, "the PDF tools");
  } catch (err) {
    if (err instanceof FileRefError) throw new Problem(err.message);
    throw err;
  }
}

function readPdf(given: unknown, cwd: string): Input {
  const input = readFileRef(given, cwd, "PDF");
  if (!isPdf(input.data)) throw new Problem(`${input.name} is not a PDF.`);
  return input;
}

const password = (args: Record<string, any>) =>
  typeof args.password === "string" && args.password !== "" ? args.password : undefined;

type Opened = { doc: PDFDocument; encrypted: boolean };

/**
 * The document, decrypted if it has to be.
 *
 * A file protected only against changes (no password to open) opens with the
 * empty password, as it does in any viewer. The fork loses the trailer's Info
 * and ID when it decrypts a file with a cross-reference stream, so they are
 * read from an undecrypted parse and put back.
 */
async function openDoc(data: Buffer, pass?: string): Promise<Opened> {
  let raw: PDFDocument;
  try {
    raw = await PDFDocument.load(data, { ignoreEncryption: true, updateMetadata: false, preserveXFA: true });
  } catch (err) {
    throw new Problem(`It could not be read as a PDF (${message(err)}); the file may be damaged.`);
  }
  if (!raw.isEncrypted) return { doc: raw, encrypted: false };
  let doc: PDFDocument;
  try {
    doc = await PDFDocument.load(data, { password: pass ?? "", updateMetadata: false, preserveXFA: true });
  } catch (err) {
    const text = message(err);
    if (/needs password/i.test(text)) {
      throw new Problem("It is password-protected. Ask the person for the password, and pass it as password.");
    }
    if (/password incorrect/i.test(text)) throw new Problem("That password is not the right one for this PDF.");
    throw new Problem(`It is encrypted, and could not be opened (${text}).`);
  }
  const { Info, ID } = raw.context.trailerInfo;
  if (!doc.context.trailerInfo.Info && Info instanceof PDFRef && doc.context.lookup(Info) instanceof PDFDict) {
    doc.context.trailerInfo.Info = Info;
  }
  if (!doc.context.trailerInfo.ID && ID instanceof PDFArray) doc.context.trailerInfo.ID = ID;
  return { doc, encrypted: true };
}

// ------------------------------------------------------------- writing --

/**
 * Everything the file no longer uses, left out.
 *
 * pdf-lib writes every object it holds, used or not, so a removed page -- or
 * the page a redaction replaced, text and all -- would otherwise still be in
 * the bytes. Walks from the trailer and drops what it never reaches.
 */
function collectGarbage(doc: PDFDocument): number {
  const ctx = doc.context;
  const seen = new Set<string>();
  const stack: unknown[] = [ctx.trailerInfo.Root, ctx.trailerInfo.Info, ctx.trailerInfo.Encrypt];
  while (stack.length > 0) {
    const obj = stack.pop();
    if (obj instanceof PDFRef) {
      if (seen.has(obj.tag)) continue;
      seen.add(obj.tag);
      stack.push(ctx.lookup(obj));
    } else if (obj instanceof PDFDict) {
      for (const [, value] of obj.entries()) stack.push(value);
    } else if (obj instanceof PDFArray) {
      stack.push(...obj.asArray());
    } else if (obj instanceof PDFStream) {
      stack.push(obj.dict);
    }
  }
  let dropped = 0;
  for (const [ref] of ctx.enumerateIndirectObjects()) {
    if (seen.has(ref.tag)) continue;
    ctx.delete(ref);
    dropped++;
  }
  return dropped;
}

/**
 * Cut pages that left the document loose from it.
 *
 * What pointed at one -- a bookmark, a link, a form widget's page -- points
 * at its replacement, or at nothing. A form field loses the widgets that sat
 * on it, and goes if it has none left. The tagged structure goes too: it can
 * carry the text of what was removed, and no longer describes the pages.
 */
function forgetPages(doc: PDFDocument, gone: Map<PDFRef, PDFRef | null>) {
  if (gone.size === 0) return;
  const ctx = doc.context;
  const replace = new Map<string, PDFRef | null>();
  const annots = new Set<string>();
  for (const [from, to] of gone) {
    replace.set(from.tag, to);
    const leaf = ctx.lookup(from);
    const list = leaf instanceof PDFDict ? leaf.lookupMaybe(PDFName.of("Annots"), PDFArray) : undefined;
    for (const a of list?.asArray() ?? []) if (a instanceof PDFRef) annots.add(a.tag);
  }

  const fields = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict)?.lookupMaybe(PDFName.of("Fields"), PDFArray);
  const prune = (list: PDFArray, depth: number) => {
    for (let i = list.size() - 1; i >= 0; i--) {
      const entry = list.get(i);
      if (entry instanceof PDFRef && annots.has(entry.tag)) {
        list.remove(i);
        continue;
      }
      const node = entry instanceof PDFRef ? ctx.lookup(entry) : entry;
      const kids = node instanceof PDFDict ? node.lookupMaybe(PDFName.of("Kids"), PDFArray) : undefined;
      if (!kids || depth > 30) continue;
      prune(kids, depth + 1);
      if (kids.size() === 0) list.remove(i);
    }
  };
  if (fields && annots.size > 0) prune(fields, 0);

  const walk = (obj: unknown, depth: number) => {
    if (depth > 60) return;
    if (obj instanceof PDFDict) {
      for (const [key, value] of obj.entries()) {
        if (value instanceof PDFRef && replace.has(value.tag)) {
          const to = replace.get(value.tag);
          if (to) obj.set(key, to);
          else obj.delete(key);
        } else if (value instanceof PDFDict || value instanceof PDFArray) {
          walk(value, depth + 1);
        }
      }
    } else if (obj instanceof PDFArray) {
      for (let i = 0; i < obj.size(); i++) {
        const value = obj.get(i);
        if (value instanceof PDFRef && replace.has(value.tag)) obj.set(i, replace.get(value.tag) ?? PDFNull);
        else if (value instanceof PDFDict || value instanceof PDFArray) walk(value, depth + 1);
      }
    } else if (obj instanceof PDFStream) {
      walk(obj.dict, depth + 1);
    }
  };
  for (const [ref, obj] of ctx.enumerateIndirectObjects()) {
    if (!replace.has(ref.tag)) walk(obj, 0);
  }
  doc.catalog.delete(PDFName.of("StructTreeRoot"));
  doc.catalog.delete(PDFName.of("MarkInfo"));
}

async function saveDoc(doc: PDFDocument, objectStreams?: boolean): Promise<Buffer> {
  collectGarbage(doc);
  const bytes = await doc.save(objectStreams === undefined ? {} : { useObjectStreams: objectStreams });
  return Buffer.from(bytes);
}

/**
 * These pages, in this order, as the document's pages.
 *
 * Done on the page tree itself: the fork's removePage deletes the page's
 * object, so a page taken out cannot be put back. Every page then hangs
 * straight from the root, keeping what it inherited from the node it hung
 * under.
 */
function setPages(doc: PDFDocument, pages: PDFPage[]) {
  const rootRef = doc.catalog.get(PDFName.of("Pages"));
  if (!(rootRef instanceof PDFRef)) throw new Problem("Its page tree is damaged, so its pages cannot be rearranged.");
  for (const page of pages) {
    for (const key of ["Resources", "MediaBox", "CropBox", "Rotate"]) {
      const name = PDFName.of(key);
      if (page.node.get(name) !== undefined) continue;
      const inherited = page.node.getInheritableAttribute(name);
      if (inherited !== undefined) page.node.set(name, inherited);
    }
  }
  for (const page of pages) page.node.setParent(rootRef);
  const root = doc.catalog.Pages();
  root.set(PDFName.of("Kids"), doc.context.obj(pages.map((p) => p.ref)));
  root.set(PDFName.of("Count"), PDFNumber.of(pages.length));
  // pdf-lib keeps its own list and count of the pages.
  const cached = doc as unknown as { pageCache?: { invalidate(): void }; pageCount?: number };
  cached.pageCache?.invalidate();
  cached.pageCount = undefined;
  if (doc.getPageCount() !== pages.length) throw new Problem("The pages could not be put in order; nothing was saved.");
}

type Saved = { art: Artifact; replaced: boolean };

/** The name a result is saved under. The agent's own file is updated in
    place; the person's never is -- theirs gets a new name beside it. */
function outputName(input: Input, output: unknown, suffix: string): string {
  const asked = String(output ?? "").trim();
  if (asked) {
    const name = cleanName(asked, `document-${suffix}.pdf`);
    return /\.pdf$/i.test(name) ? name : `${name}.pdf`;
  }
  if (input.artifact?.origin === "agent" && /\.pdf$/i.test(input.artifact.name)) return input.artifact.name;
  const base = input.name.replace(/\.pdf$/i, "").trim() || "document";
  return cleanName(`${base}-${suffix}.pdf`);
}

function deliver(ctx: PdfContext, name: string, data: Buffer, note: string, input?: Input, cues?: Cue[]): Saved {
  if (data.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Problem(`The result is ${formatSize(data.byteLength)}, over the ${formatSize(MAX_ARTIFACT_BYTES)} an artifact may be. Nothing was saved.`);
  }
  const replaced = listArtifacts().some((a) => a.origin === "agent" && a.name === name);
  const art = saveArtifact({ origin: "agent", name, data, mime: "application/pdf", session: ctx.session, note });
  ctx.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
  // A file the agent made is the file it is working on: open it in the window.
  // Whatever was on the pages there is part of them now (the tools that call
  // this read the window's flattened file); pdf_edit opens it itself, with
  // its objects kept movable.
  // A reference file worked on in the background (cut, redacted, compressed)
  // is saved and shown in the thread, but never takes the window from the
  // file being worked on.
  if (input && ctx.desk && isDeskFile(input, ctx)) {
    const source = ctx.desk.current()?.source ?? (input.artifact?.origin === "user" ? input.artifact.id : null);
    ctx.desk.open({ name: art.name, base: data, items: [], working: art.id, source, outName: art.name, review: { label: note, diff: false }, ...(cues?.length ? { cues } : {}) });
  }
  return { art, replaced };
}

function savedLine(saved: Saved, pages: number, input: Input): string {
  const { art } = saved;
  return (
    `${saved.replaced ? "Updated" : "Saved as"} artifact ${art.id} (${art.name}, ${pages} page${pages === 1 ? "" : "s"}, ` +
    `${formatSize(art.size)})${saved.replaced ? ", replacing the earlier version of that file" : ""}. ` +
    (input.artifact?.origin === "user" || !input.artifact ? `${input.name} itself is unchanged. ` : "") +
    `It is shown in the conversation for the person to open, and is on this host at ${artifactPath(art.id)}.`
  );
}

// ------------------------------------------------------------ geometry --

type Matrix = [number, number, number, number, number, number];

/** A page as it is shown: its size once turned, and the way from there to
    the file's own coordinates. */
type View = {
  width: number;
  height: number;
  rotate: 0 | 90 | 180 | 270;
  box: { x: number; y: number; w: number; h: number };
  /** From "as shown, y up from the bottom-left" to the page's own space. */
  matrix: Matrix;
};

export function viewOf(page: PDFPage): View {
  const norm = (b: { x: number; y: number; width: number; height: number }) => ({
    x0: Math.min(b.x, b.x + b.width), y0: Math.min(b.y, b.y + b.height),
    x1: Math.max(b.x, b.x + b.width), y1: Math.max(b.y, b.y + b.height),
  });
  const media = norm(page.getMediaBox());
  const crop = norm(page.getCropBox());
  const x0 = Math.max(media.x0, crop.x0), y0 = Math.max(media.y0, crop.y0);
  const x1 = Math.min(media.x1, crop.x1), y1 = Math.min(media.y1, crop.y1);
  const box = x1 > x0 && y1 > y0
    ? { x: x0, y: y0, w: x1 - x0, h: y1 - y0 }
    : { x: media.x0, y: media.y0, w: media.x1 - media.x0, h: media.y1 - media.y0 };
  let angle = page.getRotation().angle % 360;
  if (angle < 0) angle += 360;
  const rotate = (angle % 90 === 0 ? angle : 0) as View["rotate"];
  const { x, y, w, h } = box;
  const matrix: Matrix = rotate === 90 ? [0, 1, -1, 0, x + w, y]
    : rotate === 180 ? [-1, 0, 0, -1, x + w, y + h]
      : rotate === 270 ? [0, -1, 1, 0, x, y + h]
        : [1, 0, 0, 1, x, y];
  const turned = rotate === 90 || rotate === 270;
  return { width: turned ? h : w, height: turned ? w : h, rotate, box, matrix };
}

/** A point in the page's own space, as shown: from the top-left, y down. */
export function toView(view: View, px: number, py: number): [number, number] {
  const { x, y, w, h } = view.box;
  switch (view.rotate) {
    case 90: return [py - y, px - x];
    case 180: return [x + w - px, py - y];
    case 270: return [y + h - py, x + w - px];
    default: return [px - x, y + h - py];
  }
}

/** A point as shown (from the top-left, y down), in the page's own space. */
export function fromView(view: View, vx: number, vy: number): [number, number] {
  const [a, b, c, d, e, f] = view.matrix;
  const u = vx, v = view.height - vy;
  return [a * u + c * v + e, b * u + d * v + f];
}

function rectToView(view: View, r: { x: number; y: number; width: number; height: number }): Rect {
  const [ax, ay] = toView(view, r.x, r.y);
  const [bx, by] = toView(view, r.x + r.width, r.y + r.height);
  return { x: Math.min(ax, bx), y: Math.min(ay, by), w: Math.abs(bx - ax), h: Math.abs(by - ay) };
}

const r1 = (n: number) => Math.round(n * 10) / 10;
const boxText = (r: Rect) => `x ${r1(r.x)}, y ${r1(r.y)}, ${r1(r.w)} × ${r1(r.h)}`;

const PAPER: [string, number, number][] = [
  ["Letter", 612, 792], ["Legal", 612, 1008], ["Tabloid", 792, 1224], ["Executive", 522, 756],
  ["A3", 842, 1191], ["A4", 595, 842], ["A5", 420, 595], ["B5", 499, 709],
];

export function paperName(width: number, height: number): string {
  const near = (a: number, b: number) => Math.abs(a - b) <= 2;
  for (const [name, w, h] of PAPER) {
    if (near(width, w) && near(height, h)) return name;
    if (near(width, h) && near(height, w)) return `${name}, landscape`;
  }
  return "";
}

const sizeText = (view: { width: number; height: number }) => {
  const paper = paperName(view.width, view.height);
  return `${r1(view.width)} × ${r1(view.height)} pt${paper ? ` (${paper})` : ""}`;
};

// --------------------------------------------------------------- pages --

/**
 * The pages a spec names, 0-based, in the order named: "3", "2-5", "7-",
 * "-4", "last", "odd", "even", "all", joined with commas. Repeats are kept
 * (pdf_pages repeats a page with them); "blank" is a blank page where the
 * caller allows one.
 */
export function parsePages(spec: unknown, count: number, allowBlank = false): Array<number | "blank"> {
  const text = String(spec ?? "").trim().toLowerCase();
  const all = () => Array.from({ length: count }, (_, i) => i);
  if (!text || text === "all") return all();
  const out: Array<number | "blank"> = [];
  for (const raw of text.split(/[,;]+/)) {
    const part = raw.replace(/\s+/g, "").replace(/[–—]/g, "-");
    if (!part) continue;
    if (part === "all") { out.push(...all()); continue; }
    if (part === "blank") {
      if (!allowBlank) throw new Problem(`"blank" is only a page in pdf_pages' pages.`);
      out.push("blank");
      continue;
    }
    if (part === "odd" || part === "even") {
      for (let n = part === "odd" ? 1 : 2; n <= count; n += 2) out.push(n - 1);
      continue;
    }
    const m = /^(\d+|last)?(-)?(\d+|last)?$/.exec(part);
    if (!m || (!m[1] && !m[2])) throw new Problem(`"${raw.trim()}" is not a page or a range of pages (like 3, 2-5, 7- or last).`);
    const num = (s: string) => (s === "last" ? count : Number(s));
    const from = m[1] ? num(m[1]) : 1;
    const to = m[2] ? (m[3] ? num(m[3]) : count) : from;
    for (const n of [from, to]) {
      if (n < 1 || n > count) throw new Problem(`There is no page ${n}: it has ${count} page${count === 1 ? "" : "s"}.`);
    }
    if (from <= to) for (let n = from; n <= to; n++) out.push(n - 1);
    else for (let n = from; n >= to; n--) out.push(n - 1);
  }
  if (out.length === 0) throw new Problem("No pages were named.");
  return out;
}

/** The pages a spec names, each once, in page order. */
function pageSet(spec: unknown, count: number): number[] {
  return [...new Set(parsePages(spec, count).filter((p): p is number => p !== "blank"))].sort((a, b) => a - b);
}

/** "1-3, 5" for [0, 1, 2, 4]. */
export function rangeText(indices: number[]): string {
  const sorted = [...new Set(indices)].sort((a, b) => a - b);
  const parts: string[] = [];
  for (let i = 0; i < sorted.length; i++) {
    let j = i;
    while (j + 1 < sorted.length && sorted[j + 1] === sorted[j] + 1) j++;
    parts.push(j > i ? `${sorted[i] + 1}-${sorted[j] + 1}` : String(sorted[i] + 1));
    i = j;
  }
  return parts.join(", ");
}

// -------------------------------------------------------------- colour --

const NAMED: Record<string, string> = {
  black: "#000000", white: "#ffffff", red: "#dc2626", green: "#16a34a", blue: "#2563eb",
  yellow: "#facc15", orange: "#f97316", purple: "#9333ea", pink: "#ec4899", gray: "#6b7280",
  grey: "#6b7280", navy: "#1e3a8a", teal: "#0d9488", brown: "#92400e", ink: "#1f2a6b",
};

/** A colour as the agent writes one; null for "none". */
export function parseColor(value: unknown, fallback: string): RGB | null {
  const text = String(value ?? "").trim().toLowerCase() || fallback;
  if (text === "none" || text === "transparent") return null;
  const hex = NAMED[text] ?? text;
  let m = /^#?([0-9a-f])([0-9a-f])([0-9a-f])$/.exec(hex);
  if (m) return rgb(parseInt(m[1] + m[1], 16) / 255, parseInt(m[2] + m[2], 16) / 255, parseInt(m[3] + m[3], 16) / 255);
  m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/.exec(hex);
  if (m) return rgb(parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255);
  m = /^rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/.exec(text);
  if (m) return rgb(Math.min(255, +m[1]) / 255, Math.min(255, +m[2]) / 255, Math.min(255, +m[3]) / 255);
  throw new Problem(`"${String(value)}" is not a colour: use a name (red, blue, ink...), #rrggbb, or none.`);
}

const cssColor = (c: RGB) =>
  `#${[c.red, c.green, c.blue].map((v) => Math.round(v * 255).toString(16).padStart(2, "0")).join("")}`;

/** Most of the way to white: the paper behind a stamp. */
const tint = (c: RGB, amount: number) =>
  rgb(c.red + (1 - c.red) * amount, c.green + (1 - c.green) * amount, c.blue + (1 - c.blue) * amount);

// --------------------------------------------------------------- fonts --

const FAMILIES: Record<string, [StandardFonts, StandardFonts, StandardFonts, StandardFonts]> = {
  helvetica: [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique],
  times: [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic],
  courier: [StandardFonts.Courier, StandardFonts.CourierBold, StandardFonts.CourierOblique, StandardFonts.CourierBoldOblique],
};

class Fonts {
  private readonly cache = new Map<string, PDFFont>();
  constructor(private readonly doc: PDFDocument) {}
  get(family: unknown = "helvetica", bold = false, italic = false): PDFFont {
    const key = String(family ?? "helvetica").toLowerCase();
    const faces = FAMILIES[/times|serif/.test(key) && !/sans/.test(key) ? "times" : /courier|mono/.test(key) ? "courier" : "helvetica"];
    const face = faces[(bold ? 1 : 0) + (italic ? 2 : 0)];
    let font = this.cache.get(face);
    if (!font) {
      font = this.doc.embedStandardFont(face);
      this.cache.set(face, font);
    }
    return font;
  }
}

/** The built-in fonts cover Western European text and no more, and the fork
    writes "?" for anything else rather than failing: say which characters
    they cannot write instead. */
const charsets = new WeakMap<PDFFont, Set<number>>();

function writable(font: PDFFont, text: string) {
  let known = charsets.get(font);
  if (!known) {
    known = new Set(font.getCharacterSet());
    charsets.set(font, known);
  }
  const set = known;
  const bad = [...new Set([...text].filter((ch) => !set.has(ch.codePointAt(0) ?? 0)))];
  if (bad.length === 0) return;
  throw new Problem(
    `The built-in PDF fonts only cover Western European letters, and cannot write ${bad.slice(0, 8).map((c) => JSON.stringify(c)).join(" ")}. ` +
    "Write it without those characters, or as a picture.",
  );
}

// ------------------------------------------------------------- finding --

/** Kinds of thing to find by name, as SecurePDF's find-and-redact offers. */
const PRESETS: Record<string, RegExp> = {
  email: /[a-z0-9._%+-]+@[a-z0-9.-]+\.[a-z]{2,}/gi,
  phone: /(?:\+\d{1,3}[\s.-]?)?(?:\(\d{2,5}\)|\b\d{2,5})[\s.-]?\d{3,4}[\s.-]?\d{3,4}\b/g,
  ssn: /\b\d{3}[-.\s]?\d{2}[-.\s]?\d{4}\b/g,
  credit_card: /\b(?:\d[ -]?){12,18}\d\b/g,
  date: /\b(?:\d{1,2}[/.-]\d{1,2}[/.-]\d{2,4}|\d{4}-\d{2}-\d{2})\b/g,
};

type Pattern = { label: string; re: RegExp };

/** Plain text (any case, any spacing), a /regular expression/, or a preset. */
export function patternsFor(find: unknown): Pattern[] {
  const list = (Array.isArray(find) ? find : [find]).map((f) => String(f ?? "").trim()).filter(Boolean);
  return list.map((text) => {
    const preset = PRESETS[text.toLowerCase().replace(/[\s-]+/g, "_").replace(/s$/, "")];
    if (preset) return { label: text.toLowerCase(), re: new RegExp(preset.source, preset.flags) };
    const m = /^\/([\s\S]+)\/([a-z]*)$/.exec(text);
    if (m) {
      try {
        const flags = [...new Set(`${m[2]}g`.replace(/[^gimsuy]/g, ""))].join("");
        return { label: text, re: new RegExp(m[1], flags) };
      } catch (err) {
        throw new Problem(`${text} is not a regular expression this can use: ${message(err)}`);
      }
    }
    const source = text.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
    return { label: `"${text}"`, re: new RegExp(source, "gi") };
  });
}

type Hit = { page: number; text: string; label: string; boxes: Rect[] };

/**
 * Where on the page each pattern matches, as boxes around the characters.
 *
 * The page's runs of text are joined into one string, so a match can span
 * several runs; each run it touches gives a box. Within a run, characters are
 * placed by the widths of their glyphs where the renderer measured them (by
 * their count where it did not), along whichever way the run reads -- and each
 * box is widened a little, since covering a sliver too much beats leaving one.
 */
export function findOnPage(page: PageText, patterns: Pattern[]): Hit[] {
  let text = "";
  const spans: { start: number; end: number; item: number }[] = [];
  page.items.forEach((item, i) => {
    const start = text.length;
    text += item.s;
    spans.push({ start, end: text.length, item: i });
    if (item.eol) text += "\n";
  });
  const hits: Hit[] = [];
  for (const { label, re } of patterns) {
    re.lastIndex = 0;
    for (const m of text.matchAll(re)) {
      if (!m[0] || m.index === undefined) continue;
      const s = m.index, e = s + m[0].length;
      const boxes: Rect[] = [];
      for (const span of spans) {
        if (span.end <= s || span.start >= e) continue;
        const item = page.items[span.item];
        if (!item.box) continue;
        const [x, y, w, h] = item.box;
        const len = Math.max(1, span.end - span.start);
        const a = Math.max(s, span.start) - span.start;
        const b = Math.min(e, span.end) - span.start;
        const cuts = item.o && item.o.length === len + 1 ? item.o : null;
        const f0 = cuts ? cuts[a] : a / len;
        const f1 = cuts ? cuts[b] : b / len;
        const along = item.dir === "d" || item.dir === "u" ? h : w;
        const pad = Math.min(3, (along / len) * 0.35);
        const from = Math.max(0, f0 * along - pad), to = Math.min(along, f1 * along + pad);
        switch (item.dir) {
          case "r": boxes.push({ x: x + from, y: y - 0.5, w: to - from, h: h + 1 }); break;
          case "l": boxes.push({ x: x + w - to, y: y - 0.5, w: to - from, h: h + 1 }); break;
          case "d": boxes.push({ x: x - 0.5, y: y + from, w: w + 1, h: to - from }); break;
          case "u": boxes.push({ x: x - 0.5, y: y + h - to, w: w + 1, h: to - from }); break;
          default: boxes.push({ x: x - 0.5, y: y - 0.5, w: w + 1, h: h + 1 });
        }
      }
      if (boxes.length > 0) hits.push({ page: page.page, text: m[0].replace(/\s+/g, " "), label, boxes });
    }
  }
  return hits;
}

function union(boxes: Rect[]): Rect {
  const x0 = Math.min(...boxes.map((b) => b.x)), y0 = Math.min(...boxes.map((b) => b.y));
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)), y1 = Math.max(...boxes.map((b) => b.y + b.h));
  return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
}

/** A page's text as lines, the way pdf.js strings them together. */
function pageText(page: PageText): string {
  return page.items.map((i) => i.s + (i.eol ? "\n" : "")).join("")
    .replace(/[ \t]+\n/g, "\n").replace(/\n{3,}/g, "\n\n").trim();
}

// ---------------------------------------------------------------- forms --

type FieldInfo = { field: PDFField; name: string; kind: string; page: number | null; box: Rect | null };

function hasForm(doc: PDFDocument): boolean {
  return Boolean(doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict));
}

/** "none", a static form that has XFA as well ("hybrid"), or a form that is
    XFA and nothing else ("dynamic"), whose pages exist only in the XFA. */
function xfaKind(doc: PDFDocument): "none" | "hybrid" | "dynamic" {
  const acro = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  if (!acro || !acro.has(PDFName.of("XFA"))) return "none";
  const needs = doc.catalog.lookup(PDFName.of("NeedsRendering"));
  if (needs instanceof PDFBool && needs.asBoolean()) return "dynamic";
  const fields = acro.lookupMaybe(PDFName.of("Fields"), PDFArray);
  return fields && fields.size() > 0 ? "hybrid" : "dynamic";
}

function fieldKind(field: PDFField): string {
  if (field instanceof PDFTextField) return "text";
  if (field instanceof PDFCheckBox) return "checkbox";
  if (field instanceof PDFRadioGroup) return "radio";
  if (field instanceof PDFDropdown) return "dropdown";
  if (field instanceof PDFOptionList) return "list";
  if (field instanceof PDFSignature) return "signature";
  if (field instanceof PDFButton) return "button";
  return "field";
}

function describeFields(doc: PDFDocument): FieldInfo[] {
  if (!hasForm(doc)) return [];
  const pages = doc.getPages();
  const views = pages.map((p) => viewOf(p));
  const where = new Map<string, number>();
  pages.forEach((page, i) => {
    for (const a of page.node.Annots()?.asArray() ?? []) if (a instanceof PDFRef) where.set(a.tag, i);
  });
  const out: FieldInfo[] = [];
  for (const field of doc.getForm().getFields()) {
    let page: number | null = null;
    let box: Rect | null = null;
    const widget = field.acroField.getWidgets()[0];
    if (widget) {
      const ref = doc.context.getObjectRef(widget.dict);
      page = ref ? where.get(ref.tag) ?? null : null;
      if (page === null) {
        const p = widget.P();
        const at = p ? pages.findIndex((pg) => pg.ref === p) : -1;
        page = at >= 0 ? at : null;
      }
      if (page !== null) box = rectToView(views[page], widget.getRectangle());
    }
    out.push({ field, name: field.getName(), kind: fieldKind(field), page, box });
  }
  return out;
}

function fieldValue(field: PDFField): string {
  try {
    if (field instanceof PDFTextField) {
      const text = field.getText();
      return text ? JSON.stringify(text.length > 200 ? `${text.slice(0, 200)}…` : text) : "(empty)";
    }
    if (field instanceof PDFCheckBox) return field.isChecked() ? "checked" : "not checked";
    if (field instanceof PDFRadioGroup) return field.getSelected() ? JSON.stringify(field.getSelected()) : "(none chosen)";
    if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
      const picked = field.getSelected();
      return picked.length ? picked.map((p) => JSON.stringify(p)).join(", ") : "(none chosen)";
    }
    if (field instanceof PDFSignature) return "(signature field)";
  } catch {
    return "(unreadable)";
  }
  return "";
}

function fieldChoices(field: PDFField): string[] {
  try {
    if (field instanceof PDFRadioGroup || field instanceof PDFDropdown || field instanceof PDFOptionList) return field.getOptions();
  } catch {
    return [];
  }
  return [];
}

/** A field by the name the agent used: exactly, in any case, or by its last
    part ("name" for "form1[0].page1[0].name[0]") when only one fits. */
function findField(fields: PDFField[], wanted: string): PDFField | null {
  const exact = fields.find((f) => f.getName() === wanted);
  if (exact) return exact;
  const lower = wanted.toLowerCase();
  const loose = fields.filter((f) => f.getName().toLowerCase() === lower);
  if (loose.length === 1) return loose[0];
  const last = (name: string) => (name.split(".").pop() ?? name).replace(/\[\d+\]$/, "").toLowerCase();
  const tail = fields.filter((f) => last(f.getName()) === last(wanted));
  return tail.length === 1 ? tail[0] : null;
}

function pickOption(options: string[], value: unknown): string | null {
  const text = String(value ?? "").trim();
  return options.find((o) => o === text) ?? options.find((o) => o.trim().toLowerCase() === text.toLowerCase()) ?? null;
}

const YES = new Set(["true", "yes", "on", "checked", "check", "x", "1", "y", "ticked"]);
const NO = new Set(["false", "no", "off", "unchecked", "uncheck", "0", "n", "", "unticked"]);

function setField(field: PDFField, value: unknown, font: PDFFont) {
  if (field instanceof PDFTextField) {
    const text = value === null || value === undefined ? "" : String(value);
    for (const line of text.split(/\r?\n/)) writable(font, line);
    field.setText(text || undefined);
  } else if (field instanceof PDFCheckBox) {
    const said = String(value).trim().toLowerCase();
    if (value === true || YES.has(said)) field.check();
    else if (value === false || NO.has(said)) field.uncheck();
    else throw new Error("a checkbox takes true or false");
  } else if (field instanceof PDFRadioGroup) {
    const options = field.getOptions();
    const pick = pickOption(options, value);
    if (!pick) throw new Error(`choose one of ${options.map((o) => JSON.stringify(o)).join(", ")}`);
    field.select(pick);
  } else if (field instanceof PDFDropdown || field instanceof PDFOptionList) {
    const options = field.getOptions();
    const asked = Array.isArray(value) ? value : [value];
    const editable = field instanceof PDFDropdown && field.isEditable();
    const picks = asked.map((v) => pickOption(options, v) ?? (editable ? String(v ?? "") : null));
    if (picks.some((p) => p === null)) throw new Error(`choose from ${options.map((o) => JSON.stringify(o)).join(", ")}`);
    for (const p of picks) writable(font, p ?? "");
    field.select(picks.length === 1 ? picks[0] as string : picks as string[]);
  } else if (field instanceof PDFSignature) {
    throw new Error("is a signature field: sign it with an add item of type signature, with field set to its name");
  } else if (field instanceof PDFButton) {
    throw new Error("is a push button, which holds no value");
  } else {
    throw new Error("is a kind of field that cannot be filled here");
  }
}

// -------------------------------------------------------------- drawing --

/**
 * Drawing on one page in its own shown coordinates.
 *
 * The page's existing content is wrapped in a saved graphics state first
 * (pdf-lib's normalize does this), so a transform it leaves behind cannot
 * move what is drawn after it; then a matrix turns "as shown" into the page's
 * own space, whatever its rotation and crop.
 */
class Sheet {
  readonly view: View;
  constructor(readonly page: PDFPage) {
    page.node.normalize();
    this.view = viewOf(page);
  }
  get width() { return this.view.width; }
  get height() { return this.view.height; }
  /** y up from the bottom, for a box whose top is `top` and height is `h`. */
  up(top: number, h = 0) { return this.view.height - top - h; }
  draw(fn: () => void) {
    this.page.pushOperators(pushGraphicsState(), concatTransformationMatrix(...this.view.matrix));
    try {
      fn();
    } finally {
      this.page.pushOperators(popGraphicsState());
    }
  }
  /** An SVG path in shown coordinates (from the top-left, y down). */
  path(d: string, options: Parameters<PDFPage["drawSvgPath"]>[1] = {}) {
    this.page.drawSvgPath(d, { ...options, x: options.x ?? 0, y: options.y ?? this.view.height });
  }
}

const num = (value: unknown): number | null => {
  if (value === null || value === undefined || value === "") return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
};

function need(value: unknown, what: string): number {
  const n = num(value);
  if (n === null) throw new Problem(`${what} is missing or not a number.`);
  return n;
}

const STAMPS: Record<string, { label: string; color: string; arrow?: boolean }> = {
  approved: { label: "APPROVED", color: "#10b981" },
  rejected: { label: "REJECTED", color: "#f43f5e" },
  sign_here: { label: "SIGN HERE", color: "#f59e0b", arrow: true },
  initial_here: { label: "INITIAL HERE", color: "#a855f7", arrow: true },
  date: { label: "", color: "#0284c7" },
  confidential: { label: "CONFIDENTIAL", color: "#dc2626" },
  copy: { label: "COPY", color: "#64748b" },
};

const today = () => new Date().toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });

/** Break text into lines that fit `width`, keeping its own line breaks. */
function wrapText(text: string, font: PDFFont, size: number, width: number | null): string[] {
  const lines = text.replace(/\t/g, "    ").split(/\r?\n/);
  if (!width) return lines;
  const out: string[] = [];
  for (const line of lines) {
    let current = "";
    for (const word of line.split(/(\s+)/)) {
      const next = current + word;
      if (!current || font.widthOfTextAtSize(next.trimEnd(), size) <= width) {
        current = next;
        continue;
      }
      out.push(current.trimEnd());
      current = word.trimStart();
    }
    out.push(current.trimEnd());
  }
  return out;
}

/** Everything an item might need that is not in the document. */
type Tools = {
  fonts: Fonts;
  doc: PDFDocument;
  cwd: string;
  /** The renderer, when something needs it: typed signatures, pictures that
      are not PNG or JPEG, highlights found by their text. */
  view: PdfView | null;
  fields: FieldInfo[] | null;
  texts: Map<number, PageText>;
};

async function picture(tools: Tools, ref: unknown): Promise<PDFImage> {
  // A picture carried inline, as the PDF window's objects carry theirs.
  const inline = typeof ref === "string" ? /^data:image\/(png|jpe?g);base64,(.+)$/i.exec(ref) : null;
  if (inline) {
    const data = Buffer.from(inline[2], "base64");
    return /png/i.test(inline[1]) ? tools.doc.embedPng(data) : tools.doc.embedJpg(data);
  }
  const file = readFileRef(ref, tools.cwd, "picture");
  const data = file.data;
  if (data.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))) return tools.doc.embedPng(data);
  if (data[0] === 0xff && data[1] === 0xd8) return tools.doc.embedJpg(data);
  const mime = file.artifact?.mime ?? mimeFor(file.name);
  if (!mime.startsWith("image/")) throw new Problem(`${file.name} is not a picture.`);
  if (!tools.view) throw new Problem(`${file.name} is ${mime}; give a PNG or JPEG.`);
  const png = await tools.view.toPng(data, mime);
  return tools.doc.embedPng(png.data);
}

/** A typed name in the handwriting font, or a signature picture. */
async function signatureImage(tools: Tools, item: Record<string, any>): Promise<PDFImage> {
  if (item.image) return picture(tools, item.image);
  const text = String(item.text ?? "").trim();
  if (!text) throw new Problem("A signature needs text (the name, written in a handwriting font) or image (a picture of the signature).");
  if (!tools.view) throw new Problem("Writing a typed signature needs the renderer, which did not start.");
  const color = parseColor(item.color, "ink") ?? rgb(0.12, 0.16, 0.42);
  const png = await tools.view.signature(text.slice(0, 80), 160, cssColor(color));
  return tools.doc.embedPng(png.data);
}

/** Where an item anchored to a form field goes: that field's box. */
function fieldBox(tools: Tools, name: unknown): { page: number; box: Rect } {
  const fields = tools.fields ?? [];
  const field = findField(fields.map((f) => f.field), String(name ?? ""));
  const info = field ? fields.find((f) => f.field === field) : undefined;
  if (!info || info.page === null || !info.box) {
    throw new Problem(`There is no form field "${String(name)}" with a place on a page. pdf_read lists the fields.`);
  }
  return { page: info.page, box: info.box };
}

/** Fit a w×h picture into a box, keeping its shape: left, vertically centred. */
function fitInto(box: Rect, w: number, h: number): Rect {
  const scale = Math.min(box.w / w, box.h / h);
  const width = w * scale, height = h * scale;
  return { x: box.x, y: box.y + (box.h - height) / 2, w: width, h: height };
}

/** The size to draw a picture at: as asked, or keeping its shape from one side. */
function sized(img: PDFImage, item: Record<string, any>, defaultWidth: number): { w: number; h: number } {
  const w = num(item.width), h = num(item.height);
  const ratio = img.height / Math.max(1, img.width);
  if (w && h) return { w, h };
  if (w) return { w, h: w * ratio };
  if (h) return { w: h / ratio, h };
  return { w: defaultWidth, h: defaultWidth * ratio };
}

/**
 * Draw one item on one page. Returns what was drawn, in a few words.
 */
async function drawItem(tools: Tools, sheet: Sheet, pageIndex: number, given: Record<string, any>, anchor: Rect | null): Promise<string> {
  const item = asPath(given);
  const type = String(item.type ?? "").trim().toLowerCase();
  const opacity = Math.min(1, Math.max(0.05, num(item.opacity) ?? 1));
  const at = () => ({ x: anchor?.x ?? need(item.x, `${type}'s x`), y: anchor?.y ?? need(item.y, `${type}'s y`) });

  switch (type) {
    case "text": {
      const text = String(item.text ?? "");
      if (!text.trim()) throw new Problem("A text item needs text.");
      const { x, y } = at();
      const size = Math.min(200, Math.max(2, num(item.size) ?? 12));
      const font = tools.fonts.get(item.font, Boolean(item.bold), Boolean(item.italic));
      const color = parseColor(item.color, "black") ?? rgb(0, 0, 0);
      const width = num(item.width);
      const lines = wrapText(text, font, size, width);
      for (const line of lines) writable(font, line);
      const lineHeight = size * 1.2;
      const ascent = font.heightAtSize(size, { descender: false });
      const widest = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)));
      const box = width ?? widest;
      const align = String(item.align ?? "left").toLowerCase();
      const background = item.background ? parseColor(item.background, "white") : null;
      sheet.draw(() => {
        if (background) {
          sheet.page.drawRectangle({
            x: x - 2, y: sheet.up(y - 1, lines.length * lineHeight + 2),
            width: box + 4, height: lines.length * lineHeight + 2, color: background,
          });
        }
        lines.forEach((line, i) => {
          const w = font.widthOfTextAtSize(line, size);
          const left = align === "center" ? x + (box - w) / 2 : align === "right" ? x + box - w : x;
          sheet.page.drawText(line, {
            x: left, y: sheet.up(y) - ascent - i * lineHeight, size, font, color,
            ...(opacity < 1 ? { opacity } : {}),
          });
        });
      });
      return `text "${text.length > 30 ? `${text.slice(0, 30)}…` : text}"`;
    }

    case "stamp": {
      const key = String(item.stamp ?? item.text ?? "approved").trim().toLowerCase().replace(/[\s-]+/g, "_");
      const preset = STAMPS[key];
      const label = String(item.text ?? "").trim()
        ? String(item.text).trim().toUpperCase()
        : preset ? (preset.label || today().toUpperCase()) : key.replace(/_/g, " ").toUpperCase();
      const color = parseColor(item.color, preset?.color ?? "#2563eb") ?? rgb(0.15, 0.39, 0.92);
      const font = tools.fonts.get("helvetica", true);
      writable(font, label);
      const h = num(item.height) ?? (num(item.size) ? (num(item.size) as number) * 2.4 : 30);
      const fontSize = h * 0.42;
      const arrow = preset?.arrow ? h * 0.6 : 0;
      const w = num(item.width) ?? font.widthOfTextAtSize(label, fontSize) + h * 0.9 + arrow;
      const { x, y } = at();
      const inset = Math.max(2, h * 0.1);
      sheet.draw(() => {
        const bottom = sheet.up(y, h);
        sheet.page.drawRectangle({
          x, y: bottom, width: w, height: h, rx: h * 0.12, ry: h * 0.12,
          color: tint(color, 0.92), borderColor: color, borderWidth: Math.max(1.2, h * 0.06), opacity: 0.94,
        });
        sheet.page.drawRectangle({
          x: x + inset, y: bottom + inset, width: w - inset * 2, height: h - inset * 2,
          borderColor: color, borderWidth: 0.75,
        });
        const tw = font.widthOfTextAtSize(label, fontSize);
        sheet.page.drawText(label, {
          x: x + (w - arrow - tw) / 2, y: bottom + h / 2 - fontSize * 0.36, size: fontSize, font, color,
        });
        if (arrow) {
          const cy = y + h / 2, ax = x + w - inset - arrow * 0.75;
          sheet.path(`M ${ax} ${cy - h * 0.16} L ${ax + arrow * 0.45} ${cy} L ${ax} ${cy + h * 0.16} Z`, { color });
        }
      });
      return `stamp ${label}`;
    }

    case "signature":
    case "image": {
      const img = type === "signature" ? await signatureImage(tools, item) : await picture(tools, item.image);
      let place: Rect;
      if (anchor && item.field) {
        place = fitInto(anchor, img.width, img.height);
      } else {
        const { x, y } = at();
        const { w, h } = sized(img, item, type === "signature" ? (item.image ? 150 : 170) : Math.min(200, img.width * 0.75));
        place = { x, y, w, h };
      }
      sheet.draw(() => {
        sheet.page.drawImage(img, {
          x: place.x, y: sheet.up(place.y, place.h), width: place.w, height: place.h,
          ...(opacity < 1 ? { opacity } : {}),
        });
      });
      return type === "signature" ? (item.image ? "signature picture" : `signature "${String(item.text).trim()}"`) : "picture";
    }

    case "check":
    case "cross": {
      const s = Math.max(4, num(item.size) ?? 14);
      const { x, y } = at();
      const color = parseColor(item.color, "black") ?? rgb(0, 0, 0);
      const d = type === "check"
        ? `M ${x + s * 0.12} ${y + s * 0.55} L ${x + s * 0.4} ${y + s * 0.85} L ${x + s * 0.9} ${y + s * 0.12}`
        : `M ${x + s * 0.15} ${y + s * 0.15} L ${x + s * 0.85} ${y + s * 0.85} M ${x + s * 0.85} ${y + s * 0.15} L ${x + s * 0.15} ${y + s * 0.85}`;
      sheet.draw(() => sheet.path(d, { borderColor: color, borderWidth: Math.max(1, s * 0.13), borderLineCap: LineCapStyle.Round }));
      return type === "check" ? "tick" : "cross";
    }

    case "rect":
    case "rectangle":
    case "box":
    case "ellipse":
    case "circle": {
      const { x, y } = at();
      const w = need(item.width, `${type}'s width`), h = need(item.height, `${type}'s height`);
      const border = parseColor(item.color, item.fill ? "none" : "red");
      const fill = item.fill ? parseColor(item.fill, "none") : null;
      const thickness = num(item.thickness) ?? 2;
      sheet.draw(() => {
        const style = {
          ...(fill ? { color: fill } : {}),
          ...(border && thickness > 0 ? { borderColor: border, borderWidth: thickness } : {}),
          ...(opacity < 1 ? { opacity, borderOpacity: opacity } : {}),
        };
        if (type === "ellipse" || type === "circle") {
          sheet.page.drawEllipse({ x: x + w / 2, y: sheet.up(y + h / 2), xScale: w / 2, yScale: h / 2, ...style });
        } else {
          sheet.page.drawRectangle({ x, y: sheet.up(y, h), width: w, height: h, ...style });
        }
      });
      return type === "ellipse" || type === "circle" ? "ellipse" : fill && !border ? "filled box" : "box";
    }

    case "line":
    case "arrow": {
      const { x, y } = at();
      const x2 = need(item.x2, `${type}'s x2`), y2 = need(item.y2, `${type}'s y2`);
      const color = parseColor(item.color, "red") ?? rgb(0.86, 0.15, 0.15);
      const thickness = Math.max(0.3, num(item.thickness) ?? 2);
      sheet.draw(() => {
        sheet.page.drawLine({
          start: { x, y: sheet.up(y) }, end: { x: x2, y: sheet.up(y2) }, thickness, color,
          lineCap: LineCapStyle.Round, ...(opacity < 1 ? { opacity } : {}),
        });
        if (type === "arrow") {
          const len = Math.hypot(x2 - x, y2 - y) || 1;
          const ux = (x2 - x) / len, uy = (y2 - y) / len;
          const head = Math.max(6, thickness * 4);
          const bx = x2 - ux * head, by = y2 - uy * head;
          const px = -uy * head * 0.5, py = ux * head * 0.5;
          sheet.path(`M ${x2} ${y2} L ${bx + px} ${by + py} L ${bx - px} ${by - py} Z`, { color, ...(opacity < 1 ? { opacity } : {}) });
        }
      });
      return type;
    }

    case "path": {
      const d = String(item.d ?? "").trim();
      if (!d) throw new Problem("A path item needs d, an SVG path.");
      const { x, y } = at();
      const border = parseColor(item.color, "red");
      const fill = item.fill ? parseColor(item.fill, "none") : null;
      sheet.draw(() => sheet.path(d, {
        x, y: sheet.up(y), ...(fill ? { color: fill } : {}),
        ...(border ? { borderColor: border, borderWidth: num(item.thickness) ?? 2, borderLineCap: LineCapStyle.Round } : {}),
        ...(opacity < 1 ? { opacity, borderOpacity: opacity } : {}),
      }));
      return "drawing";
    }

    case "highlight": {
      const color = parseColor(item.color, "yellow") ?? rgb(0.98, 0.8, 0.08);
      const alpha = num(item.opacity) ?? 0.4;
      let boxes: Rect[];
      if (item.text) {
        const page = tools.texts.get(pageIndex + 1);
        boxes = page ? findOnPage(page, patternsFor(item.text)).flatMap((h) => h.boxes) : [];
        if (boxes.length === 0) return "";
      } else {
        const { x, y } = at();
        boxes = [{ x, y, w: need(item.width, "highlight's width"), h: need(item.height, "highlight's height") }];
      }
      sheet.draw(() => {
        for (const b of boxes) {
          sheet.page.drawRectangle({ x: b.x, y: sheet.up(b.y, b.h), width: b.w, height: b.h, color, opacity: alpha, blendMode: BlendMode.Multiply });
        }
      });
      return item.text ? `${boxes.length} highlight${boxes.length === 1 ? "" : "s"} of ${String(item.text)}` : "highlight";
    }

    case "note": {
      const text = String(item.text ?? "").trim();
      if (!text) throw new Problem("A note needs text.");
      const { x, y } = at();
      addNote(tools.doc, sheet, x, y, text, parseColor(item.color, "#fbbf24") ?? rgb(0.98, 0.75, 0.14));
      return `note "${text.length > 30 ? `${text.slice(0, 30)}…` : text}"`;
    }

    default:
      throw new Problem(
        `"${String(item.type ?? "")}" is not a kind of item. Use text, stamp, signature, image, check, cross, ` +
        "rect, ellipse, line, arrow, curve, path, highlight or note.",
      );
  }
}

/**
 * A sticky note: a real PDF comment, which any viewer opens, with a drawn
 * icon so it shows even where comments are not opened.
 */
function addNote(doc: PDFDocument, sheet: Sheet, x: number, y: number, text: string, color: RGB) {
  const size = 20;
  const [ax, ay] = fromView(sheet.view, x, y + size);
  const [bx, by] = fromView(sheet.view, x + size, y);
  const rect = [Math.min(ax, bx), Math.min(ay, by), Math.max(ax, bx), Math.max(ay, by)];
  const ops = [
    `${color.red} ${color.green} ${color.blue} rg 0.35 0.3 0.1 RG 0.8 w`,
    "1 1 18 18 re B",
    "0.35 0.3 0.1 RG 1.2 w 4.5 13.5 m 15.5 13.5 l 4.5 10 m 15.5 10 l 4.5 6.5 m 11.5 6.5 l S",
  ].join("\n");
  const icon = doc.context.register(doc.context.stream(ops, { Type: "XObject", Subtype: "Form", BBox: [0, 0, size, size] }));
  const note = doc.context.register(doc.context.obj({
    Type: "Annot", Subtype: "Text", Rect: rect, Contents: PDFHexString.fromText(text), Name: "Comment",
    C: [color.red, color.green, color.blue], F: 28, Open: false, M: PDFString.fromDate(new Date()),
    AP: { N: icon },
  }));
  sheet.page.node.addAnnot(note);
}

function watermark(sheet: Sheet, fonts: Fonts, wm: Record<string, any>) {
  const text = String(wm.text ?? "").trim();
  const font = fonts.get(wm.font ?? "helvetica", wm.bold !== false);
  writable(font, text);
  const angle = num(wm.rotation) ?? 45;
  const color = parseColor(wm.color, "#64748b") ?? rgb(0.39, 0.45, 0.55);
  const opacity = Math.min(1, Math.max(0.03, num(wm.opacity) ?? 0.2));
  const { width: W, height: H } = sheet;
  const rad = (angle * Math.PI) / 180;
  const room = Math.abs(Math.cos(rad)) * W + Math.abs(Math.sin(rad)) * H;
  const size = num(wm.size) ?? Math.min(110, (room * 0.7) / Math.max(1, font.widthOfTextAtSize(text, 1)));
  const tw = font.widthOfTextAtSize(text, size);
  const th = size * 0.7;
  const cx = W / 2, cy = H / 2;
  const ox = cx - (tw / 2) * Math.cos(rad) + (th / 2) * Math.sin(rad);
  const oy = cy - (tw / 2) * Math.sin(rad) - (th / 2) * Math.cos(rad);
  sheet.draw(() => sheet.page.drawText(text, { x: ox, y: oy, size, font, color, opacity, rotate: degrees(angle) }));
}

function pageNumber(sheet: Sheet, fonts: Fonts, label: string, pn: Record<string, any>) {
  const font = fonts.get(pn.font ?? "helvetica", Boolean(pn.bold));
  const size = Math.min(40, Math.max(5, num(pn.size) ?? 10));
  const margin = num(pn.margin) ?? 28;
  const color = parseColor(pn.color, "#333333") ?? rgb(0.2, 0.2, 0.2);
  const where = String(pn.position ?? "bottom-center").toLowerCase();
  const tw = font.widthOfTextAtSize(label, size);
  const x = /left/.test(where) ? margin : /right/.test(where) ? sheet.width - margin - tw : (sheet.width - tw) / 2;
  const baseline = /top/.test(where) ? sheet.height - margin - font.heightAtSize(size, { descender: false }) : margin;
  sheet.draw(() => sheet.page.drawText(label, { x, y: baseline, size, font, color }));
}

// ----------------------------------------------------------------- desk --
//
// The PDF window (server/pdfdesk.ts): the file the agent is working on, open
// in SecurePDF's editor beside the conversation, where what the agent places
// on a page arrives as the editor's own objects -- text, stamps, signatures,
// shapes, notes -- that the person can move, change or remove, and add to.
// The window keeps the pages without them (the base) and the objects; the
// file the tools and the person download is the two flattened together,
// rewritten whenever either changes.
//
// An object the agent placed keeps the pdf_edit item it came from, so until
// the person changes it the file shows exactly what pdf_edit would have drawn
// (bold, alignment, a background, a diagonal arrow, which the editor's own
// objects cannot say). Moved, it is drawn the same way somewhere else; edited
// in any other way, it is drawn from what the editor now says it is.

/** One of the editor's objects (SecurePDF's AnnotationItem): points from the
    top-left of the page as shown, the same as everywhere here. */
export type DeskItem = {
  id: string;
  type: string;
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
  [key: string]: any;
  /** For one the agent placed: the pdf_edit item, and the object as first shown. */
  autora?: { draw: Record<string, any>; shown: string };
};

export type DeskSnapshot = {
  /** The file's name as the window shows it. */
  name: string;
  /** The pages without the objects. Never encrypted. */
  base: Buffer;
  items: DeskItem[];
  /** The artifact the flattened file is written to, once there is one. */
  working: string | null;
  /** The file it was opened from, when that was an artifact. */
  source: string | null;
  /** When pdf_compose made the pages: the document they were laid out from,
      and which block is on which page. Gone as soon as the pages change any
      other way, since the description would no longer be what the file is. */
  compose?: ComposeSource | null;
  outline?: OutlineEntry[] | null;
};

/**
 * Where the agent just worked on a page, for the window to show it: a cursor
 * arriving, the old words struck, the new ones typed. Positions are points
 * from the page's top-left, as everywhere else. Purely presentation: the file
 * is already changed when this is sent.
 */
export interface Cue {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The words struck, for a retype; empty otherwise. */
  from: string;
  /** The words typed, for a retype or a new text box. */
  to: string;
  /** What the cursor does: retypes words, types a new box, clicks to place
      something, drags out a box, or traces a stroke. */
  act: "retype" | "type" | "place" | "drag" | "draw";
  /** The editor tool it would have picked up, lit on the toolbar. */
  tool: "text" | "highlighter" | "draw" | "shape" | "note" | "stamp" | "signature" | "image" | "redact";
  /** An object the window holds back until this cue lands it. */
  itemId?: string;
  /** For a stroke: where it passes, in points. */
  points?: { x: number; y: number }[];
}

/**
 * What the cursor does for an object the agent just placed: where, how, and
 * with which tool. The object itself is the server's and already exists; this
 * only says how to show it arriving. Null for something with nowhere to show.
 */
export function cueForItem(item: DeskItem): Cue | null {
  const page = Math.round(Number(item.pageNumber));
  const x = Number(item.x), y = Number(item.y), w = Number(item.width), h = Number(item.height);
  if (!(page >= 1) || ![x, y, w, h].every(Number.isFinite)) return null;
  const base = { page, x, y, w: Math.max(0, w), h: Math.max(0, h), from: "", to: "", itemId: String(item.id) };
  switch (item.type) {
    case "text": return { ...base, act: "type", tool: "text", to: String(item.text ?? "").slice(0, 200) };
    case "stamp": return { ...base, act: "place", tool: "stamp" };
    case "signature": return { ...base, act: "place", tool: "signature" };
    case "image": return { ...base, act: "place", tool: "image" };
    case "note": return { ...base, act: "place", tool: "note" };
    case "shape": return { ...base, act: "drag", tool: "shape" };
    case "redact": return { ...base, act: "drag", tool: "redact" };
    case "drawing":
    case "highlighter": {
      const raw: { x: number; y: number }[] = Array.isArray(item.drawingPoints) ? item.drawingPoints : [];
      const every = Math.max(1, Math.ceil(raw.length / 60));
      const points = raw.filter((_, i) => i % every === 0 || i === raw.length - 1)
        .map((p) => ({ x: Number(p.x), y: Number(p.y) }))
        .filter((p) => Number.isFinite(p.x) && Number.isFinite(p.y));
      if (points.length < 2) return { ...base, act: "drag", tool: item.type === "drawing" ? "draw" : "highlighter" };
      const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
      return {
        ...base, act: "draw", tool: item.type === "drawing" ? "draw" : "highlighter", points,
        x: Math.min(...xs), y: Math.min(...ys), w: Math.max(...xs) - Math.min(...xs), h: Math.max(...ys) - Math.min(...ys),
      };
    }
    default: return null;
  }
}

/** What the PDF tools may do with the window of the session they run in. */
export interface DeskHooks {
  current(): DeskSnapshot | null;
  /** Show this file in the window (or carry on with it), with these objects on it. */
  open(next: DeskSnapshot & {
    outName: string;
    /** From the agent changing the file: what to call this version, and what to put up for review. */
    review?: { label: string; baseNote?: string | null; diff?: boolean };
    /** Where the agent worked, played in the window as the new file loads. */
    cues?: Cue[];
  }): void;
  /** Bring the window back if the person put it away: the agent is working on its file. */
  show(): void;
  /** What the person did in the window since the agent was last told, said once; "" when nothing. */
  news(): string;
}

const deskId = () => `agent_${crypto.randomBytes(5).toString("hex")}`;

/** The object as the editor shows it, without the parts only Autora reads. */
function shownOf(item: DeskItem): string {
  const rest: Record<string, any> = { ...item };
  delete rest.autora;
  delete rest.id;
  return JSON.stringify(rest);
}

const EDITOR_FONT = (f: unknown) => {
  const name = String(f ?? "").toLowerCase();
  if (/times|serif/.test(name) && !/sans/.test(name)) return "Times-Roman";
  if (/courier|mono/.test(name)) return "Courier";
  return "Helvetica";
};

/** The padding inside the editor's text boxes, in points at a typical zoom. */
const EDITOR_PAD = 5;

/** The editor's own stamps; any other word is shown as text. */
const EDITOR_STAMPS = new Set(["APPROVED", "REJECTED", "SIGN_HERE", "INITIAL_HERE", "DATE", "CONFIDENTIAL", "COPY"]);

/** A picture as a data URL, with its size: what the editor's objects carry. */
async function pictureData(tools: Tools, item: Record<string, any>, signature: boolean): Promise<{ url: string; w: number; h: number }> {
  let data: Buffer;
  if (signature && !item.image) {
    const text = String(item.text ?? "").trim();
    if (!text) throw new Problem("A signature needs text (the name, written in a handwriting font) or image (a picture of the signature).");
    if (!tools.view) throw new Problem("Writing a typed signature needs the renderer, which did not start.");
    const color = parseColor(item.color, "ink") ?? rgb(0.12, 0.16, 0.42);
    data = (await tools.view.signature(text.slice(0, 80), 160, cssColor(color))).data;
  } else {
    const file = readFileRef(item.image, tools.cwd, "picture");
    data = file.data;
    const png = data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const jpg = data[0] === 0xff && data[1] === 0xd8;
    if (!png && !jpg) {
      const mime = file.artifact?.mime ?? mimeFor(file.name);
      if (!mime.startsWith("image/")) throw new Problem(`${file.name} is not a picture.`);
      if (!tools.view) throw new Problem(`${file.name} is ${mime}; give a PNG or JPEG.`);
      data = (await tools.view.toPng(data, mime)).data;
    }
  }
  const png = data.subarray(0, 4).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  const img = png ? await tools.doc.embedPng(data) : await tools.doc.embedJpg(data);
  return { url: `data:image/${png ? "png" : "jpeg"};base64,${data.toString("base64")}`, w: img.width, h: img.height };
}

/**
 * A `curve` item (a line that bends: x,y to x2,y2 through the control point
 * cx,cy, or cx,cy and cx2,cy2 for an S-bend) as the `path` it is drawn as.
 */
export function asPath(item: Record<string, any>): Record<string, any> {
  if (String(item.type ?? "").trim().toLowerCase() !== "curve") return item;
  const x = need(item.x, "curve's x"), y = need(item.y, "curve's y");
  const x2 = need(item.x2, "curve's x2"), y2 = need(item.y2, "curve's y2");
  const cx = need(item.cx, "curve's cx"), cy = need(item.cy, "curve's cy");
  const two = num(item.cx2) !== null && num(item.cy2) !== null;
  const rel = (a: number, b: number) => `${a - x} ${b - y}`;
  const d = two
    ? `M 0 0 C ${rel(cx, cy)} ${rel(num(item.cx2) as number, num(item.cy2) as number)} ${rel(x2, y2)}`
    : `M 0 0 Q ${rel(cx, cy)} ${rel(x2, y2)}`;
  const rest: Record<string, any> = { ...item };
  for (const k of ["x2", "y2", "cx", "cy", "cx2", "cy2"]) delete rest[k];
  return { ...rest, type: "path", d };
}

/**
 * An SVG path as the points the editor's drawing object holds: lines as they
 * are, curves (cubic, quadratic and arcs) sampled finely enough to look smooth.
 */
export function pathPoints(d: string, x: number, y: number): { x: number; y: number }[] {
  const tokens = d.match(/[a-zA-Z]|-?(?:\d+\.?\d*|\.\d+)(?:e[-+]?\d+)?/g) ?? [];
  const out: { x: number; y: number }[] = [];
  let cx = 0, cy = 0, sx = 0, sy = 0;
  let last: { kind: "c" | "q"; x: number; y: number } | null = null;
  let cmd = "";
  let i = 0;
  const arity: Record<string, number> = { m: 2, l: 2, h: 1, v: 1, c: 6, s: 4, q: 4, t: 2, a: 7, z: 0 };
  const push = (px: number, py: number) => { out.push({ x: x + px, y: y + py }); };
  const sample = (f: (t: number) => [number, number], steps: number) => {
    for (let k = 1; k <= steps; k++) { const [px, py] = f(k / steps); push(px, py); }
  };
  while (i < tokens.length && out.length < 2000) {
    if (/^[a-zA-Z]$/.test(tokens[i])) { cmd = tokens[i++]; if (cmd === "z" || cmd === "Z") { cx = sx; cy = sy; push(cx, cy); last = null; continue; } }
    const lower = cmd.toLowerCase();
    const n = arity[lower];
    if (!n) break;
    const a = tokens.slice(i, i + n).map(Number);
    if (a.length < n || a.some((v) => !Number.isFinite(v))) break;
    i += n;
    const rel = cmd === lower;
    const ox = rel ? cx : 0, oy = rel ? cy : 0;
    if (lower === "m") {
      cx = ox + a[0]; cy = oy + a[1]; sx = cx; sy = cy; push(cx, cy); last = null;
      cmd = rel ? "l" : "L"; // further pairs after a move are lines
    } else if (lower === "l") {
      cx = ox + a[0]; cy = oy + a[1]; push(cx, cy); last = null;
    } else if (lower === "h") {
      cx = ox + a[0]; push(cx, cy); last = null;
    } else if (lower === "v") {
      cy = oy + a[0]; push(cx, cy); last = null;
    } else if (lower === "c" || lower === "s") {
      const x1 = lower === "c" ? ox + a[0] : last?.kind === "c" ? 2 * cx - last.x : cx;
      const y1 = lower === "c" ? oy + a[1] : last?.kind === "c" ? 2 * cy - last.y : cy;
      const k = lower === "c" ? 2 : 0;
      const x2 = ox + a[k], y2 = oy + a[k + 1], x3 = ox + a[k + 2], y3 = oy + a[k + 3];
      const [x0, y0] = [cx, cy];
      sample((t) => {
        const u = 1 - t;
        return [u * u * u * x0 + 3 * u * u * t * x1 + 3 * u * t * t * x2 + t * t * t * x3, u * u * u * y0 + 3 * u * u * t * y1 + 3 * u * t * t * y2 + t * t * t * y3];
      }, 24);
      cx = x3; cy = y3; last = { kind: "c", x: x2, y: y2 };
    } else if (lower === "q" || lower === "t") {
      const x1: number = lower === "q" ? ox + a[0] : last?.kind === "q" ? 2 * cx - last.x : cx;
      const y1: number = lower === "q" ? oy + a[1] : last?.kind === "q" ? 2 * cy - last.y : cy;
      const k = lower === "q" ? 2 : 0;
      const x2 = ox + a[k], y2 = oy + a[k + 1];
      const [x0, y0] = [cx, cy];
      sample((t) => {
        const u = 1 - t;
        return [u * u * x0 + 2 * u * t * x1 + t * t * x2, u * u * y0 + 2 * u * t * y1 + t * t * y2];
      }, 20);
      cx = x2; cy = y2; last = { kind: "q", x: x1, y: y1 };
    } else if (lower === "a") {
      const ex = ox + a[5], ey = oy + a[6];
      for (const p of arcPoints(cx, cy, a[0], a[1], a[2], a[3] !== 0, a[4] !== 0, ex, ey)) push(p[0], p[1]);
      cx = ex; cy = ey; last = null;
    }
  }
  return out.slice(0, 2000);
}

/** The points along an SVG elliptical arc (endpoint form, as the A command gives it). */
function arcPoints(x1: number, y1: number, rxIn: number, ryIn: number, rotation: number, large: boolean, sweep: boolean, x2: number, y2: number): [number, number][] {
  let rx = Math.abs(rxIn), ry = Math.abs(ryIn);
  if (!rx || !ry || (x1 === x2 && y1 === y2)) return [[x2, y2]];
  const phi = (rotation * Math.PI) / 180, cos = Math.cos(phi), sin = Math.sin(phi);
  const dx = (x1 - x2) / 2, dy = (y1 - y2) / 2;
  const xp = cos * dx + sin * dy, yp = -sin * dx + cos * dy;
  const scale = (xp * xp) / (rx * rx) + (yp * yp) / (ry * ry);
  if (scale > 1) { rx *= Math.sqrt(scale); ry *= Math.sqrt(scale); }
  const num2 = rx * rx * ry * ry - rx * rx * yp * yp - ry * ry * xp * xp;
  const den = rx * rx * yp * yp + ry * ry * xp * xp;
  const k = (large === sweep ? -1 : 1) * Math.sqrt(Math.max(0, num2 / den));
  const cxp = (k * rx * yp) / ry, cyp = (-k * ry * xp) / rx;
  const cxx = cos * cxp - sin * cyp + (x1 + x2) / 2, cyy = sin * cxp + cos * cyp + (y1 + y2) / 2;
  const angle = (ux: number, uy: number, vx: number, vy: number) => Math.atan2(ux * vy - uy * vx, ux * vx + uy * vy);
  const theta = angle(1, 0, (xp - cxp) / rx, (yp - cyp) / ry);
  let delta = angle((xp - cxp) / rx, (yp - cyp) / ry, (-xp - cxp) / rx, (-yp - cyp) / ry);
  if (!sweep && delta > 0) delta -= 2 * Math.PI;
  if (sweep && delta < 0) delta += 2 * Math.PI;
  const steps = Math.max(8, Math.ceil(Math.abs(delta) / (Math.PI / 24)));
  const out: [number, number][] = [];
  for (let s = 1; s <= steps; s++) {
    const t = theta + (delta * s) / steps;
    out.push([cos * rx * Math.cos(t) - sin * ry * Math.sin(t) + cxx, sin * rx * Math.cos(t) + cos * ry * Math.sin(t) + cyy]);
  }
  out[out.length - 1] = [x2, y2];
  return out;
}

function boundsOf(points: { x: number; y: number }[], pad: number) {
  const xs = points.map((p) => p.x), ys = points.map((p) => p.y);
  const x0 = Math.min(...xs) - pad, y0 = Math.min(...ys) - pad;
  return { x: x0, y: y0, width: Math.max(10, Math.max(...xs) + pad - x0), height: Math.max(10, Math.max(...ys) + pad - y0) };
}

/**
 * A pdf_edit item as the editor's objects on one page: usually one, one per
 * box for a highlight found by its words, none for words not on the page.
 */
async function deskItemsFor(tools: Tools, sheet: Sheet, pageIndex: number, given: Record<string, any>, anchor: Rect | null): Promise<DeskItem[]> {
  const item = asPath(given);
  const type = String(item.type ?? "").trim().toLowerCase();
  const page = pageIndex + 1;
  const at = () => ({ x: anchor?.x ?? need(item.x, `${type}'s x`), y: anchor?.y ?? need(item.y, `${type}'s y`) });
  const make = (shown: Record<string, any>, draw: Record<string, any>): DeskItem => {
    const made = { id: deskId(), pageNumber: page, ...shown } as DeskItem;
    const clean: Record<string, any> = { ...draw, page: String(page) };
    delete clean.pages;
    delete clean.field;
    made.autora = { draw: clean, shown: shownOf(made) };
    return made;
  };

  switch (type) {
    case "text": {
      const text = String(item.text ?? "");
      if (!text.trim()) throw new Problem("A text item needs text.");
      const { x, y } = at();
      const size = Math.min(200, Math.max(2, num(item.size) ?? 12));
      const font = tools.fonts.get(item.font, Boolean(item.bold), Boolean(item.italic));
      const color = parseColor(item.color, "black") ?? rgb(0, 0, 0);
      const width = num(item.width);
      const lines = wrapText(text, font, size, width);
      for (const line of lines) writable(font, line);
      const widest = Math.max(...lines.map((l) => font.widthOfTextAtSize(l, size)));
      // The editor shows text in a box with 6 px of padding each side and a
      // looser line height, in the browser's font rather than this one: the
      // box starts that padding to the left, so the words sit where they are
      // drawn, and leaves room for a wider face.
      return [make({
        type: "text", x: x - EDITOR_PAD, y, width: Math.ceil((width ?? widest * 1.1) + EDITOR_PAD * 2 + 2),
        height: Math.ceil(lines.length * size * 1.3 + 4),
        text, fontSize: size, fontColor: cssColor(color), fontFamily: EDITOR_FONT(item.font), userResized: Boolean(width),
      }, { ...item, x, y })];
    }

    case "stamp": {
      const key = String(item.stamp ?? item.text ?? "approved").trim().toLowerCase().replace(/[\s-]+/g, "_");
      const preset = STAMPS[key];
      const label = String(item.text ?? "").trim()
        ? String(item.text).trim().toUpperCase()
        : preset ? (preset.label || today().toUpperCase()) : key.replace(/_/g, " ").toUpperCase();
      const color = parseColor(item.color, preset?.color ?? "#2563eb") ?? rgb(0.15, 0.39, 0.92);
      const font = tools.fonts.get("helvetica", true);
      writable(font, label);
      const h = num(item.height) ?? (num(item.size) ? (num(item.size) as number) * 2.4 : 30);
      const arrow = preset?.arrow ? h * 0.6 : 0;
      const w = num(item.width) ?? font.widthOfTextAtSize(label, h * 0.42) + h * 0.9 + arrow;
      const { x, y } = at();
      const stampType = key.toUpperCase();
      const shown = EDITOR_STAMPS.has(stampType) && !String(item.text ?? "").trim()
        ? { type: "stamp", x, y, width: w, height: h, stampType }
        : { type: "text", x, y, width: w, height: h, text: label, fontSize: Math.round(h * 0.42), fontColor: cssColor(color), fontFamily: "Helvetica" };
      return [make(shown, { ...item, x, y, width: w, height: h })];
    }

    case "signature":
    case "image": {
      const pic = await pictureData(tools, item, type === "signature");
      let place: Rect;
      if (anchor && item.field) {
        place = fitInto(anchor, pic.w, pic.h);
      } else {
        const { x, y } = at();
        const fake = { width: pic.w, height: pic.h } as PDFImage;
        const { w, h } = sized(fake, item, type === "signature" ? (item.image ? 150 : 170) : Math.min(200, pic.w * 0.75));
        place = { x, y, w, h };
      }
      const box = { x: place.x, y: place.y, width: place.w, height: place.h };
      return [make(
        type === "signature" ? { type, ...box, signatureDataUrl: pic.url } : { type, ...box, imageDataUrl: pic.url, signatureDataUrl: pic.url },
        { type: "image", image: pic.url, ...box, ...(item.opacity !== undefined ? { opacity: item.opacity } : {}) },
      )];
    }

    case "check":
    case "cross": {
      const s = Math.max(4, num(item.size) ?? 14);
      const { x, y } = at();
      return [make({ type: "stamp", x, y, width: s, height: s, stampType: type === "check" ? "CHECKMARK" : "CROSS" }, { ...item, x, y })];
    }

    case "rect":
    case "rectangle":
    case "box":
    case "ellipse":
    case "circle": {
      const { x, y } = at();
      const w = need(item.width, `${type}'s width`), h = need(item.height, `${type}'s height`);
      const border = parseColor(item.color, item.fill ? "none" : "red");
      const fill = item.fill ? parseColor(item.fill, "none") : null;
      const thickness = num(item.thickness) ?? 2;
      return [make({
        type: "shape", x, y, width: w, height: h, shapeType: type === "ellipse" || type === "circle" ? "circle" : "rectangle",
        hasFill: Boolean(fill), shapeFillColor: fill ? cssColor(fill) : "transparent",
        hasStroke: Boolean(border) && thickness > 0, shapeStrokeColor: border ? cssColor(border) : "#000000", shapeStrokeWidth: thickness,
      }, { ...item, x, y })];
    }

    case "line":
    case "arrow":
    case "path": {
      const { x, y } = at();
      const points = type === "path"
        ? pathPoints(String(item.d ?? ""), x, y)
        : [{ x, y }, { x: need(item.x2, `${type}'s x2`), y: need(item.y2, `${type}'s y2`) }];
      if (points.length < 2) throw new Problem("A path item needs d, an SVG path.");
      const color = parseColor(item.color, "red") ?? rgb(0.86, 0.15, 0.15);
      const thickness = Math.max(0.3, num(item.thickness) ?? 2);
      return [make({
        type: "drawing", ...boundsOf(points, thickness), drawingPoints: points,
        drawingColor: cssColor(color), drawingWidth: thickness, isHighlighter: false,
      }, { ...item, x, y })];
    }

    case "highlight": {
      const color = parseColor(item.color, "yellow") ?? rgb(0.98, 0.8, 0.08);
      let boxes: Rect[];
      if (item.text) {
        const text = tools.texts.get(page);
        boxes = text ? findOnPage(text, patternsFor(item.text)).flatMap((h) => h.boxes) : [];
      } else {
        const { x, y } = at();
        boxes = [{ x, y, w: need(item.width, "highlight's width"), h: need(item.height, "highlight's height") }];
      }
      return boxes.map((b) => make({
        type: "drawing", x: b.x, y: b.y, width: b.w, height: b.h,
        drawingPoints: [{ x: b.x, y: b.y + b.h / 2 }, { x: b.x + b.w, y: b.y + b.h / 2 }],
        drawingColor: cssColor(color), drawingWidth: b.h, isHighlighter: true,
      }, { type: "highlight", x: b.x, y: b.y, width: b.w, height: b.h, color: item.color, opacity: item.opacity }));
    }

    case "note": {
      const text = String(item.text ?? "").trim();
      if (!text) throw new Problem("A note needs text.");
      const { x, y } = at();
      const color = parseColor(item.color, "#fbbf24") ?? rgb(0.98, 0.75, 0.14);
      return [make({
        type: "note", x, y, width: 20, height: 20, noteComment: text, noteAuthor: "Autora",
        noteColor: cssColor(color), noteDate: new Date().toLocaleDateString(),
      }, { ...item, x, y })];
    }

    default:
      void sheet;
      throw new Problem(
        `"${String(item.type ?? "")}" is not a kind of item. Use text, stamp, signature, image, check, cross, ` +
        "rect, ellipse, line, arrow, curve, path, highlight or note.",
      );
  }
}

/** A pdf_edit item moved by (dx, dy). */
function shifted(draw: Record<string, any>, dx: number, dy: number): Record<string, any> {
  const out = { ...draw };
  for (const k of ["x", "x2", "cx", "cx2"]) if (num(out[k]) !== null) out[k] = (num(out[k]) as number) + dx;
  for (const k of ["y", "y2", "cy", "cy2"]) if (num(out[k]) !== null) out[k] = (num(out[k]) as number) + dy;
  return out;
}

/** The parts of an object other than where it is. */
function withoutPlace(json: string): string {
  const o = JSON.parse(json);
  delete o.x;
  delete o.y;
  delete o.drawingPoints;
  return JSON.stringify(o);
}

/**
 * What to draw for one of the editor's objects: a pdf_edit item, a box to
 * redact, or nothing (an empty text box, a note with no words).
 */
export function drawFor(item: DeskItem): Record<string, any> | { redact: Rect } | null {
  const x = Number(item.x) || 0, y = Number(item.y) || 0;
  const w = Math.max(0, Number(item.width) || 0), h = Math.max(0, Number(item.height) || 0);
  if (item.autora?.draw) {
    const now = shownOf(item);
    if (now === item.autora.shown) return item.autora.draw;
    const was = JSON.parse(item.autora.shown);
    if (withoutPlace(now) === withoutPlace(item.autora.shown)) return shifted(item.autora.draw, x - (Number(was.x) || 0), y - (Number(was.y) || 0));
  }
  switch (item.type) {
    case "text":
      if (!String(item.text ?? "").trim()) return null;
      return {
        // Inside the box's padding, where the editor shows the words.
        type: "text", x: x + EDITOR_PAD, y: y + 1, text: String(item.text), size: Number(item.fontSize) || 12, color: item.fontColor || "#0e1118",
        font: /times/i.test(String(item.fontFamily)) ? "times" : /courier/i.test(String(item.fontFamily)) ? "courier" : "helvetica",
        ...(w > EDITOR_PAD * 2 ? { width: w - EDITOR_PAD * 2 } : {}),
      };
    case "stamp":
      if (item.stampType === "CHECKMARK" || item.stampType === "CROSS") {
        return { type: item.stampType === "CHECKMARK" ? "check" : "cross", x, y, size: Math.max(4, Math.min(w, h) || 14), color: item.stampType === "CHECKMARK" ? "#10b981" : "#f43f5e" };
      }
      return { type: "stamp", stamp: String(item.stampType || "APPROVED"), x, y, width: w || undefined, height: h || undefined };
    case "signature":
    case "image": {
      const url = item.signatureDataUrl || item.imageDataUrl;
      if (!url) return null;
      return { type: "image", image: url, x, y, width: w, height: h };
    }
    case "shape": {
      const fill = item.hasFill !== false && item.shapeFillColor && !/^(transparent|none)$/i.test(item.shapeFillColor) ? item.shapeFillColor : null;
      const stroke = item.hasStroke !== false && (Number(item.shapeStrokeWidth ?? 2) > 0) ? (item.shapeStrokeColor || "#000000") : "none";
      const thickness = Number(item.shapeStrokeWidth ?? 2) || 2;
      if (item.shapeType === "line" || item.shapeType === "arrow") {
        return { type: item.shapeType, x, y: y + h / 2, x2: x + w, y2: y + h / 2, color: stroke === "none" ? (fill ?? "#000000") : stroke, thickness };
      }
      return { type: item.shapeType === "circle" ? "ellipse" : "rect", x, y, width: w, height: h, color: stroke, ...(fill ? { fill } : {}), thickness };
    }
    case "drawing":
    case "highlighter": {
      const points: { x: number; y: number }[] = Array.isArray(item.drawingPoints) ? item.drawingPoints : [];
      if (points.length < 2) return null;
      const highlight = item.isHighlighter || item.type === "highlighter";
      const d = points.map((p, i) => `${i ? "L" : "M"} ${Number(p.x) || 0} ${Number(p.y) || 0}`).join(" ");
      return {
        type: "path", x: 0, y: 0, d, color: item.drawingColor || (highlight ? "#fde047" : "#b22222"),
        thickness: Number(item.drawingWidth) || (highlight ? 20 : 3), ...(highlight ? { opacity: 0.35 } : {}),
      };
    }
    case "note":
      if (!String(item.noteComment ?? "").trim()) return null;
      return { type: "note", x, y, text: String(item.noteComment), color: item.noteColor || "#fef08a" };
    case "redact":
      return w > 0 && h > 0 ? { redact: { x, y, w, h } } : null;
    default:
      return null;
  }
}

/**
 * The window's file: the base with its objects drawn on, and redactions
 * taken out of it. Whatever could not be drawn is left off and said.
 */
export async function flattenDesk(base: Buffer, items: DeskItem[], cwd: string): Promise<{ data: Buffer; skipped: string[] }> {
  const { doc } = await openDoc(base);
  const tools: Tools = { fonts: new Fonts(doc), doc, cwd, view: null, fields: null, texts: new Map() };
  const count = doc.getPageCount();
  const sheets = new Map<number, Sheet>();
  const redact = new Map<number, Rect[]>();
  const skipped: string[] = [];
  for (const item of items) {
    const p = Math.round(Number(item.pageNumber)) - 1;
    if (!(p >= 0 && p < count)) continue;
    const draw = drawFor(item);
    if (!draw) continue;
    if ("redact" in draw) {
      redact.set(p, [...(redact.get(p) ?? []), draw.redact as Rect]);
      continue;
    }
    let sheet = sheets.get(p);
    if (!sheet) {
      sheet = new Sheet(doc.getPage(p));
      sheets.set(p, sheet);
    }
    try {
      await drawItem(tools, sheet, p, draw, null);
    } catch (err) {
      skipped.push(`${item.type} on page ${p + 1}: ${message(err)}`);
    }
  }
  if (redact.size === 0) return { data: await saveDoc(doc), skipped };
  const drawn = await saveDoc(doc);
  const out = await withPdf(drawn, undefined, async (view) => {
    const { doc: again } = await openDoc(drawn);
    return redrawWithBoxes(again, view, redact, REDACT_DPI, () => false);
  });
  return { data: await saveDoc(out), skipped };
}

/**
 * The file a tool was given, as the window has it now: once a file is open
 * in the window, its current version -- with what the person added -- is
 * what every tool reads.
 */
function isDeskFile(input: Input, ctx: PdfContext): boolean {
  const desk = ctx.desk?.current() ?? null;
  if (!desk) return true; // nothing is open: the file becomes the window's
  const id = input.artifact?.id;
  return Boolean(id && (id === desk.working || id === desk.source));
}

function onDesk(input: Input, ctx: PdfContext): { input: Input; desk: DeskSnapshot | null } {
  const desk = ctx.desk?.current() ?? null;
  const id = input.artifact?.id;
  if (!desk || !id || (id !== desk.working && id !== desk.source)) return { input, desk: null };
  const art = desk.working ? getArtifact(desk.working) : null;
  const data = art ? readArtifact(art.id) : null;
  return { input: art && data ? { data, name: art.name, artifact: art } : input, desk };
}

// ---------------------------------------------------------------- tools --

const PREVIEW = (name: string, pages: number, size: number) =>
  `${name} · ${pages} page${pages === 1 ? "" : "s"} · ${formatSize(size)}`;

// -- pdf_read --

async function readTool(args: Record<string, any>, ctx: PdfContext): Promise<PdfOutcome> {
  const { input } = onDesk(readPdf(args.file, ctx.cwd), ctx);
  const pass = password(args);
  const { doc, encrypted } = await openDoc(input.data, pass);
  const count = doc.getPageCount();
  const pages = doc.getPages();
  const views = pages.map((p) => viewOf(p));
  const xfa = xfaKind(doc);
  const lines: string[] = [];

  lines.push(
    `${input.name}: ${count} page${count === 1 ? "" : "s"}, PDF ${doc.context.header.getVersionString()}, ${formatSize(input.data.byteLength)}` +
    (encrypted ? (pass ? ", password-protected (opened with the password given)" : ", protected against changes (opens without a password)") : "") + ".",
  );
  const props: [string, string | undefined][] = [
    ["Title", doc.getTitle()], ["Author", doc.getAuthor()], ["Subject", doc.getSubject()],
    ["Keywords", doc.getKeywords()], ["Creator", doc.getCreator()], ["Producer", doc.getProducer()],
    ["Created", doc.getCreationDate()?.toISOString().slice(0, 16).replace("T", " ")],
    ["Modified", doc.getModificationDate()?.toISOString().slice(0, 16).replace("T", " ")],
  ];
  const known = props.filter(([, v]) => v && String(v).trim());
  if (known.length) lines.push(known.map(([k, v]) => `${k}: ${String(v).trim()}`).join(" · "));

  // Page sizes, a run of pages the same size said once.
  const runs: string[] = [];
  for (let i = 0; i < count; i++) {
    let j = i;
    const same = (a: View, b: View) => Math.abs(a.width - b.width) < 0.5 && Math.abs(a.height - b.height) < 0.5 && a.rotate === b.rotate;
    while (j + 1 < count && same(views[j + 1], views[i])) j++;
    runs.push(`${j > i ? `pages ${i + 1}-${j + 1}` : `page ${i + 1}`}: ${sizeText(views[i])}${views[i].rotate ? `, turned ${views[i].rotate}°` : ""}`);
    i = j;
  }
  lines.push(`Page size${runs.length > 1 ? "s" : ""}: ${runs.slice(0, 12).join("; ")}${runs.length > 12 ? `; and ${runs.length - 12} more runs` : ""}.`);

  const attachments = listAttachments(doc);
  if (attachments.length) {
    lines.push(`Attachments: ${attachments.map((a) => `${a.name} (${a.mime}, ${formatSize(a.data.byteLength)})`).join("; ")} -- extract saves them as artifacts.`);
  }
  if (xfa === "dynamic") {
    lines.push(
      "XFA: this is a dynamic XFA form -- its pages and fields live in XML inside the file, so most viewers only " +
      "show a \"please wait\" page. pdf_look draws it and its text is read below; extract \"xfa\" saves the XML. " +
      "Its fields cannot be filled here; pdf_compress with mode images turns it into an ordinary PDF of what it looks like.",
    );
    const data = xfaPackets(doc)?.datasets;
    const values = data ? xfaValues(data) : [];
    if (values.length) {
      lines.push("", `Its filled-in data (${values.length}${values.length > 200 ? ", the first 200" : ""}):`,
        ...values.slice(0, 200).map((v) => `- ${v.path} = ${JSON.stringify(v.value.length > 200 ? `${v.value.slice(0, 200)}…` : v.value)}`));
    }
  } else if (xfa === "hybrid") {
    lines.push(
      "XFA: the form carries XFA as well as ordinary fields. Filling it with pdf_edit removes the XFA, so every " +
      "viewer shows the values filled in (Acrobat would otherwise show the XFA's own, older data).",
    );
  }

  // Extracting.
  const extract = Array.isArray(args.extract) ? args.extract.map(String) : args.extract ? [String(args.extract)] : [];
  if (extract.length) {
    const saved: string[] = [];
    const missing: string[] = [];
    for (const wanted of extract) {
      if (wanted.toLowerCase() === "xfa") {
        const packets = xfaPackets(doc);
        if (!packets) { missing.push("xfa (it has no XFA)"); continue; }
        const base = input.name.replace(/\.pdf$/i, "");
        const whole = saveArtifact({
          origin: "agent", name: `${base}-xfa.xml`, data: Buffer.from(packets.whole, "utf8"),
          mime: "application/xml", session: ctx.session, note: `The XFA form inside ${input.name}`,
        });
        ctx.showFile?.({ id: whole.id, name: whole.name, mime: whole.mime, size: whole.size });
        saved.push(`${whole.id} (${whole.name}, the whole XFA)`);
        if (packets.datasets) {
          const data = saveArtifact({
            origin: "agent", name: `${base}-xfa-data.xml`, data: Buffer.from(packets.datasets, "utf8"),
            mime: "application/xml", session: ctx.session, note: `The data filled into the XFA form in ${input.name}`,
          });
          ctx.showFile?.({ id: data.id, name: data.name, mime: data.mime, size: data.size });
          saved.push(`${data.id} (${data.name}, its data)`);
        }
        continue;
      }
      const picked = wanted === "all" ? attachments : attachments.filter((a) => a.name.toLowerCase() === wanted.toLowerCase());
      if (!picked.length) { missing.push(wanted); continue; }
      for (const a of picked) {
        const art = saveArtifact({
          origin: "agent", name: a.name, data: a.data, mime: a.mime, session: ctx.session,
          note: `Attached inside ${input.name}`,
        });
        ctx.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
        saved.push(`${art.id} (${art.name})`);
      }
    }
    if (saved.length) lines.push(`Extracted as artifacts, to read with artifact_read: ${saved.join(", ")}.`);
    if (missing.length) lines.push(`Not found: ${missing.join(", ")}.`);
  }

  // Fields.
  const fields = xfa === "dynamic" ? [] : describeFields(doc);
  if (fields.length) {
    const shown = fields.slice(0, 150).map((f) => {
      const choices = fieldChoices(f.field);
      const flags = [f.field.isRequired() ? "required" : "", f.field.isReadOnly() ? "read-only" : ""].filter(Boolean);
      return `- ${f.name} (${f.kind}${choices.length ? `: ${choices.slice(0, 12).map((c) => JSON.stringify(c)).join(", ")}${choices.length > 12 ? ", ..." : ""}` : ""})` +
        `${f.kind === "button" ? "" : ` = ${fieldValue(f.field)}`}${flags.length ? ` [${flags.join(", ")}]` : ""}` +
        `${f.page !== null && f.box ? ` -- page ${f.page + 1}, ${boxText(f.box)}` : ""}`;
    });
    lines.push("", `Form fields (${fields.length}${fields.length > 150 ? ", the first 150" : ""}), filled with pdf_edit's fields:`, ...shown);
  } else if (xfa !== "dynamic") {
    lines.push("No form fields: to fill it in, write on it with pdf_edit's add items (text, check...).");
  }

  const room = Math.max(2000, ctx.room - lines.join("\n").length);
  const texts = await textOf(input, pass, args, count, room, ctx);
  lines.push("", texts);
  return { ok: true, summary: lines.join("\n"), preview: PREVIEW(input.name, count, input.data.byteLength) };
}

/** The text part of pdf_read: the pages' text as far as it fits, or what `find` found. */
async function textOf(input: Input, pass: string | undefined, args: Record<string, any>, count: number, room: number, ctx: PdfContext): Promise<string> {
  const patterns = patternsFor(args.find);
  const wanted = pageSet(args.pages, count);
  try {
    return await withPdf(input.data, pass, async (view) => {
      const total = view.pages || count;
      const scope = view.pages && view.pages !== count ? pageSet(args.pages, total) : wanted;
      if (patterns.length) {
        const hits: Hit[] = [];
        for (const n of scope) {
          if (ctx.cancelled()) break;
          const [page] = await view.text(n + 1, n + 1, true);
          hits.push(...findOnPage(page, patterns));
          if (hits.length >= 500) break;
        }
        if (!hits.length) {
          return `Nothing matched ${patterns.map((p) => p.label).join(", ")} on ${scope.length === total ? "any page" : `pages ${rangeText(scope)}`}.` +
            (view.xfa ? "" : " If it is a scan, it may have no text at all -- look with pdf_look.");
        }
        return [
          `${hits.length}${hits.length >= 500 ? "+" : ""} match${hits.length === 1 ? "" : "es"} (boxes are points from the page's top-left):`,
          ...hits.slice(0, 300).map((h) => `- page ${h.page}: ${JSON.stringify(h.text.slice(0, 120))} at ${boxText(union(h.boxes))}${patterns.length > 1 ? ` (${h.label})` : ""}`),
        ].join("\n");
      }
      const parts: string[] = [];
      let used = 0;
      let shownUpTo = -1;
      let empty = 0;
      for (let k = 0; k < scope.length; k++) {
        if (ctx.cancelled()) break;
        const n = scope[k];
        const [page] = await view.text(n + 1, n + 1);
        // XFA text comes as one piece per caption and value, with no line ends.
        const text = view.xfa ? page.items.map((i) => i.s.trim()).filter(Boolean).join("\n") : pageText(page);
        if (!text) empty++;
        const block = `--- page ${n + 1} ---\n${text || "(no text on this page)"}`;
        if (used + block.length > room && parts.length > 0) break;
        parts.push(block.length > room ? `${block.slice(0, room)}…` : block);
        used += block.length;
        shownUpTo = k;
      }
      const rest = scope.slice(shownUpTo + 1);
      if (rest.length) parts.push(`[Pages ${rangeText(rest)} not shown: read them with pages "${rangeText(rest).replace(/ /g, "")}".]`);
      if (empty === shownUpTo + 1 && shownUpTo >= 0) {
        parts.push("[No text at all: it is probably scanned pictures of pages. Look at it with pdf_look to read it.]");
      }
      return `Text${view.xfa ? " (from its XFA form)" : ""}:\n${parts.join("\n\n")}`;
    }, ctx);
  } catch (err) {
    // What pdf-lib read above still stands when pdf.js cannot draw the file.
    if (err instanceof PdfRenderError && err.code !== "cancelled") return `Its text could not be read: ${err.message}`;
    throw err;
  }
}

type Attachment = { name: string; data: Buffer; mime: string };

function listAttachments(doc: PDFDocument): Attachment[] {
  try {
    return doc.getAttachments().map((a, i) => {
      const name = cleanName(a.name || "", `attachment-${i + 1}`);
      return { name, data: Buffer.from(a.data), mime: a.mimeType && /^[\w.+-]+\/[\w.+-]+$/.test(a.mimeType) ? a.mimeType : mimeFor(name) };
    });
  } catch {
    return [];
  }
}

/** The XFA packets as one XML document, and the filled-in data on its own. */
function xfaPackets(doc: PDFDocument): { whole: string; datasets: string | null } | null {
  const acro = doc.catalog.lookupMaybe(PDFName.of("AcroForm"), PDFDict);
  const xfa = acro?.lookup(PDFName.of("XFA"));
  const decode = (s: unknown) => (s instanceof PDFRawStream ? Buffer.from(decodePDFRawStream(s).decode()).toString("utf8") : "");
  if (xfa instanceof PDFRawStream) {
    const whole = decode(xfa);
    const data = /<xfa:datasets[\s\S]*?<\/xfa:datasets>/.exec(whole);
    return { whole, datasets: data ? data[0] : null };
  }
  if (xfa instanceof PDFArray) {
    let whole = "";
    let datasets: string | null = null;
    for (let i = 0; i + 1 < xfa.size(); i += 2) {
      const name = xfa.lookup(i);
      const part = decode(xfa.lookup(i + 1));
      whole += part;
      const label = name instanceof PDFString || name instanceof PDFHexString ? name.decodeText() : "";
      if (label === "datasets") datasets = part;
    }
    return { whole, datasets };
  }
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'" };

/**
 * What was filled into an XFA form: every element of its data that holds
 * text and nothing else, by its path (form1.page1.name). Read with a small
 * scanner rather than a parser, since only the leaves are wanted.
 */
export function xfaValues(xml: string): { path: string; value: string }[] {
  const body = (/<xfa:data\b[^>]*>([\s\S]*?)<\/xfa:data>/.exec(xml)?.[1] ?? xml)
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<\?[\s\S]*?\?>/g, "")
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, (_, text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;"));
  const decode = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code: string) => {
    if (code[0] !== "#") return ENTITIES[code] ?? all;
    const n = code[1] === "x" || code[1] === "X" ? parseInt(code.slice(2), 16) : parseInt(code.slice(1), 10);
    return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : all;
  });
  const out: { path: string; value: string }[] = [];
  const stack: { name: string; text: string; kids: number }[] = [];
  for (const m of body.matchAll(/<(\/)?([A-Za-z_][\w:.-]*)[^>]*?(\/)?>|([^<]+)/g)) {
    const [, close, name, self, text] = m;
    const top = stack[stack.length - 1];
    if (text !== undefined) {
      if (top) top.text += text;
    } else if (close) {
      const node = stack.pop();
      const value = node && node.kids === 0 ? decode(node.text).trim() : "";
      if (node && value) out.push({ path: [...stack.map((s) => s.name), node.name].join("."), value });
    } else {
      if (top) top.kids++;
      if (!self) stack.push({ name, text: "", kids: 0 });
    }
  }
  return out;
}

// -- pdf_look --

const LOOK_PX = 1100;
const MAX_LOOK = 4;

async function lookTool(args: Record<string, any>, ctx: PdfContext): Promise<PdfOutcome> {
  const { input, desk } = onDesk(readPdf(args.file, ctx.cwd), ctx);
  const pass = password(args);
  // What the agent looks at, the person sees too: open it in the PDF window
  // -- unless another file is already there. Then this is a reference, looked
  // at in the background (its pictures are in the thread); the window keeps
  // the file being worked on.
  if (ctx.desk && desk) ctx.desk.show();
  else if (ctx.desk && !ctx.desk.current()) await showInWindow(input, pass, ctx);
  return lookAtPdf(input.data, input.name, pass, args, ctx);
}

/**
 * Pictures of a PDF's pages, shown in the conversation and handed to the model.
 * The PDF look tool's body, shared with the Office tools (which look at a
 * document by laying it out as a PDF first): `name` is what the captions call it.
 */
export async function lookAtPdf(
  data: Buffer, name: string, pass: string | undefined,
  args: { pages?: unknown; area?: Record<string, any> | null; grid?: unknown },
  ctx: Pick<PdfContext, "putBlob" | "showImage" | "cancelled" | "onCancel">,
): Promise<PdfOutcome> {
  const input = { name };
  return withPdf(data, pass, async (view) => {
    const count = view.pages;
    const asked = [...new Set(parsePages(args.pages ?? "1", count).filter((p): p is number => p !== "blank"))];
    const area: Record<string, any> | null = args.area && typeof args.area === "object" ? args.area : null;
    const pages = area ? asked.slice(0, 1) : asked.slice(0, MAX_LOOK);
    const images: ChatImage[] = [];
    const said: string[] = [];
    for (const index of pages) {
      if (ctx.cancelled()) break;
      const n = index + 1;
      const size = await view.size(n);
      let crop: Rect | undefined;
      if (area) {
        const x = Math.max(0, need(area.x, "area's x")), y = Math.max(0, need(area.y, "area's y"));
        const w = Math.min(size.width - x, need(area.width, "area's width"));
        const h = Math.min(size.height - y, need(area.height, "area's height"));
        if (w <= 0 || h <= 0) throw new Problem(`That area is off the page, which is ${sizeText(size)}.`);
        crop = { x, y, w, h };
      }
      const span = crop ? Math.max(crop.w, crop.h) : Math.max(size.width, size.height);
      const scale = Math.min(crop ? 8 : 3, Math.max(0.2, LOOK_PX / span));
      const grid = args.grid ? gridStep(crop ? Math.max(crop.w, crop.h) : Math.max(size.width, size.height)) : undefined;
      const pic = await view.render(n, { scale, crop, grid, type: "image/jpeg", quality: 0.85 });
      const blob = ctx.putBlob(pic.data, pic.mime);
      const caption = `${input.name} · page ${n} of ${count}${crop ? ` · ${boxText(crop)}` : ""}`;
      ctx.showImage(blob, `Page ${n} of ${input.name}`, caption, { w: pic.width, h: pic.height });
      if (pic.data.byteLength <= 3_500_000) images.push({ mime: pic.mime, data: pic.data.toString("base64") });
      said.push(`page ${n}, ${sizeText(size)}${crop ? `, the area ${boxText(crop)}` : ""}${grid ? `, ruled every ${grid} pt` : ""}`);
    }
    const skipped = asked.length - pages.length;
    return {
      ok: true,
      summary:
        `${input.name}, ${said.join("; ")}: ${images.length === 1 ? "the picture is" : "the pictures are"} in this result and shown in the conversation.` +
        (view.xfa ? " Drawn from its XFA form." : "") +
        (args.grid ? " Grid labels are points from the page's top-left corner -- the coordinates pdf_edit takes." : "") +
        (skipped > 0 ? ` ${skipped} more page${skipped === 1 ? " was" : "s were"} asked for; look at ${MAX_LOOK} at a time.` : ""),
      preview: `${input.name} · page${pages.length === 1 ? "" : "s"} ${rangeText(pages)}`,
      images,
    };
  }, ctx);
}

/** Open a file in the PDF window as it is, with nothing on it yet. A file
    that needs a password nobody gave stays out of it. */
async function showInWindow(input: Input, pass: string | undefined, ctx: PdfContext) {
  if (!ctx.desk) return;
  let base = input.data;
  try {
    const { doc, encrypted } = await openDoc(input.data, pass);
    if (encrypted) base = await saveDoc(doc);
  } catch {
    return;
  }
  ctx.desk.open({
    name: input.name, base, items: [],
    working: input.artifact?.origin === "agent" ? input.artifact.id : null,
    source: input.artifact?.origin === "user" ? input.artifact.id : null,
    outName: outputName(input, undefined, "edited"),
  });
}

/** A round step giving about ten grid lines across. */
function gridStep(span: number): number {
  const steps = [5, 10, 20, 25, 50, 100, 200];
  return steps.find((s) => span / s <= 16) ?? 200;
}

// -- pdf_edit --

async function editTool(args: Record<string, any>, ctx: PdfContext): Promise<PdfOutcome> {
  const given = readPdf(args.file, ctx.cwd);
  // Carrying on with the file open in the PDF window: start from its pages
  // without the objects, so what is already on them stays movable.
  const desk = ctx.desk?.current() ?? null;
  const carryOn = Boolean(desk && given.artifact && (given.artifact.id === desk.working || given.artifact.id === desk.source));
  const working = carryOn && desk?.working ? getArtifact(desk.working) : null;
  const input: Input = carryOn && desk ? { data: desk.base, name: working?.name ?? given.name, artifact: working ?? given.artifact } : given;
  const placed: DeskItem[] = [];
  const replaced = new Map<string, DeskItem>();
  const pass = password(args);
  const { doc, encrypted } = await openDoc(input.data, pass);
  const count = doc.getPageCount();
  const xfa = xfaKind(doc);

  const values = args.fields && typeof args.fields === "object" && !Array.isArray(args.fields) ? args.fields as Record<string, unknown> : null;
  const items: Record<string, any>[] = (Array.isArray(args.add) ? args.add : args.add ? [args.add] : [])
    .filter((i: unknown) => i && typeof i === "object");
  const wm = typeof args.watermark === "string" ? { text: args.watermark }
    : args.watermark && typeof args.watermark === "object" ? args.watermark : null;
  const numbers = args.page_numbers === true ? {}
    : typeof args.page_numbers === "string" ? { format: args.page_numbers }
      : args.page_numbers && typeof args.page_numbers === "object" ? args.page_numbers : null;
  const props = args.metadata && typeof args.metadata === "object" ? args.metadata as Record<string, unknown> : null;
  const strip = args.strip_metadata === true;
  const flatten = args.flatten === true;
  const dropIds = new Set<string>((Array.isArray(args.remove) ? args.remove : args.remove ? [args.remove] : []).map(String));
  const changes: Record<string, any>[] = (Array.isArray(args.change) ? args.change : args.change ? [args.change] : [])
    .filter((c: unknown) => c && typeof c === "object" && (c as any).id);

  if (!values && !items.length && !wm && !numbers && !props && !strip && !flatten && !dropIds.size && !changes.length) {
    throw new Problem("Nothing to change: give fields, flatten, add, change, remove, watermark, page_numbers, metadata or strip_metadata.");
  }
  if ((dropIds.size || changes.length) && !(carryOn && desk)) {
    throw new Problem("change and remove work on the objects in the PDF window: give the file open there (the one you have been editing).");
  }
  const unknown = [...dropIds, ...changes.map((c) => String(c.id))].filter((id) => !desk?.items.some((i) => i.id === id));
  if (unknown.length) throw new Problem(`There is no object ${unknown.map((u) => JSON.stringify(u)).join(", ")} in the window. The ids are in the results of earlier pdf_edit calls and the start of the turn.`);
  /* What the person is working on stays theirs: those objects are left as
     they are, said so, and everything else in the call goes ahead. */
  const leftAlone: string[] = [];
  if (ctx.held && desk) {
    const name = (id: string) => {
      const it = desk.items.find((i) => i.id === id);
      return `${id}${it ? ` (${String(it.type)} on page ${it.pageNumber})` : ""}`;
    };
    for (const c of [...changes]) {
      if (!ctx.held(String(c.id))) continue;
      changes.splice(changes.indexOf(c), 1);
      leftAlone.push(`change of ${name(String(c.id))}`);
    }
    for (const id of [...dropIds]) {
      if (!ctx.held(id)) continue;
      dropIds.delete(id);
      leftAlone.push(`removal of ${name(id)}`);
    }
    if (leftAlone.length && !values && !items.length && !wm && !numbers && !props && !strip && !flatten && !dropIds.size && !changes.length) {
      return {
        ok: false, held: true,
        summary:
          `Not done: the person is working on ${leftAlone.length === 1 ? "that object" : "those objects"} right now (${leftAlone.join("; ")}). ` +
          "Leave it and go on to something else; come back in a little while.",
      };
    }
  }
  if (xfa === "dynamic" && (values || flatten)) {
    throw new Problem(
      "This is a dynamic XFA form: its fields live in XML the PDF tools cannot fill. Write on it with add items " +
      "after turning it into an ordinary PDF (pdf_compress, mode images), or tell the person it needs Adobe Acrobat or Reader.",
    );
  }
  if (xfa === "dynamic" && (items.length || wm || numbers)) {
    throw new Problem(
      "This is a dynamic XFA form, drawn from XML rather than from its pages, so anything drawn on the pages would not " +
      "show in Acrobat. Turn it into an ordinary PDF first with pdf_compress (mode images), then edit that.",
    );
  }

  const done: string[] = [];
  const notes: string[] = [];
  if (leftAlone.length) {
    notes.push(
      `Left alone, because the person is working on ${leftAlone.length === 1 ? "it" : "them"} right now: ${leftAlone.join("; ")}. ` +
      "Everything else was done. Come back to those in a little while.",
    );
  }
  const fonts = new Fonts(doc);
  /* A box with a background laid over words is the way to cover them, and the
     way to loop: the words stay in the file, and the next look still finds
     them. Say what changes them for real. */
  if (items.some((i) => String(i.type).toLowerCase() === "text" && i.background)) {
    notes.push(
      "A text item with a background hides the words under it but leaves them in the file, selectable and searchable. " +
      "To change words the file already has, use pdf_replace_text (it rewrites them); to take them out, pdf_redact.",
    );
  }

  // 1. Fill.
  if (values) {
    if (!hasForm(doc)) throw new Problem("It has no form fields. Write on it with add items (text, check...) instead.");
    const form = doc.getForm();
    const all = form.getFields();
    const font = fonts.get("helvetica");
    const problems: string[] = [];
    const filled: string[] = [];
    for (const [name, value] of Object.entries(values)) {
      const field = findField(all, name);
      if (!field) {
        const near = all.map((f) => f.getName()).filter((n) => n.toLowerCase().includes(name.toLowerCase().split(/[.[\]]/).filter(Boolean).pop() ?? name.toLowerCase())).slice(0, 5);
        problems.push(`there is no field "${name}"${near.length ? ` (perhaps ${near.map((n) => JSON.stringify(n)).join(", ")})` : ""}`);
        continue;
      }
      try {
        setField(field, value, font);
        filled.push(field.getName());
      } catch (err) {
        problems.push(`${field.getName()}: ${message(err)}`);
      }
    }
    if (problems.length) {
      throw new Problem(`Nothing was saved, because:\n- ${problems.join("\n- ")}\npdf_read lists the fields, their kinds and their choices.`);
    }
    if (form.hasXFA()) {
      form.deleteXFA();
      notes.push("Its XFA was removed, so every viewer shows the values filled in.");
    }
    done.push(`filled ${filled.length} field${filled.length === 1 ? "" : "s"} (${filled.slice(0, 8).join(", ")}${filled.length > 8 ? ", ..." : ""})`);
  }

  // What needs the renderer: a typed signature, a picture that is not PNG or
  // JPEG, a highlight found by its words.
  const byText = items.some((i) => String(i.type).toLowerCase() === "highlight" && i.text);
  const needsView = byText || items.some((i) =>
    (String(i.type).toLowerCase() === "signature" && !i.image) ||
    (i.image && !/\.(png|jpe?g)$/i.test(String(i.image)) && !pngOrJpeg(i.image, ctx.cwd)));

  const apply = async (view: PdfView | null) => {
    const tools: Tools = {
      fonts, doc, cwd: ctx.cwd, view, texts: new Map(),
      fields: items.some((i) => i.field) ? describeFields(doc) : null,
    };
    const sheets = new Map<number, Sheet>();
    const sheet = (i: number) => {
      let s = sheets.get(i);
      if (!s) {
        s = new Sheet(doc.getPage(i));
        sheets.set(i, s);
      }
      return s;
    };

    // 2. Flatten, before anything is drawn over the fields.
    if (flatten) {
      if (!hasForm(doc) || doc.getForm().getFields().length === 0) {
        notes.push("There was no form to flatten.");
      } else {
        for (let i = 0; i < count; i++) sheet(i);
        const form = doc.getForm();
        if (form.hasXFA()) form.deleteXFA();
        try {
          form.flatten();
        } catch (err) {
          throw new Problem(`The form could not be flattened: ${message(err)}`);
        }
        done.push("flattened the form");
      }
    }

    // 2b. Change objects already on the pages: drawn again from what they were plus what is given.
    for (const ch of changes) {
      const old = desk!.items.find((i) => i.id === String(ch.id))!;
      const { id: _id, ...rest } = ch;
      const was: Record<string, any> = old.autora?.draw
        ?? { type: old.type, page: String(old.pageNumber), x: old.x, y: old.y, width: old.width, height: old.height };
      const merged = { ...was, ...rest, page: String(rest.page ?? was.page ?? old.pageNumber) };
      const t = pageSet(merged.page, count)[0];
      let made: DeskItem[];
      try {
        made = await deskItemsFor(tools, sheet(t), t, merged, null);
      } catch (err) {
        if (err instanceof Problem) throw new Problem(`Change of ${old.id}: ${err.message} Nothing was saved.`);
        throw err;
      }
      if (!made.length) throw new Problem(`Change of ${old.id} found nothing to draw. Nothing was saved.`);
      made[0].id = old.id;
      replaced.set(old.id, made[0]);
    }
    if (changes.length) done.push(`changed ${changes.length} object${changes.length === 1 ? "" : "s"}`);
    if (dropIds.size) done.push(`removed ${dropIds.size} object${dropIds.size === 1 ? "" : "s"}`);

    // 3. Items.
    const drawn: string[] = [];
    for (const [k, item] of items.entries()) {
      let anchor: Rect | null = null;
      let targets: number[];
      if (item.field) {
        const at = fieldBox(tools, item.field);
        anchor = at.box;
        targets = [at.page];
      } else {
        targets = pageSet(item.page ?? item.pages ?? 1, count);
      }
      if (String(item.type).toLowerCase() === "highlight" && item.text && view) {
        for (const t of targets) {
          if (!tools.texts.has(t + 1)) tools.texts.set(t + 1, (await view.text(t + 1, t + 1, true))[0]);
        }
      }
      for (const t of targets) {
        if (ctx.cancelled()) throw new Problem("Stopped before it was finished; nothing was saved.");
        const s = sheet(t);
        let what: string;
        try {
          if (ctx.desk) {
            // In the window: the editor's own objects, drawn onto the file below.
            const made = await deskItemsFor(tools, s, t, item, anchor);
            placed.push(...made);
            const kind = String(item.type ?? "item").toLowerCase();
            what = made.length === 0 ? "" : made.length > 1 ? `${made.length} ${kind}s` : kind;
          } else {
            what = await drawItem(tools, s, t, item, anchor);
          }
        } catch (err) {
          if (err instanceof Problem) throw new Problem(`Item ${k + 1} (${String(item.type ?? "?")}): ${err.message} Nothing was saved.`);
          throw err;
        }
        if (!what) {
          notes.push(`Item ${k + 1}: ${JSON.stringify(String(item.text))} was not found on page ${t + 1}.`);
          continue;
        }
        drawn.push(`${what} on page ${t + 1}`);
        const x = num(item.x), y = num(item.y);
        if (!anchor && x !== null && y !== null && (x > s.width || y > s.height || x < -50 || y < -50)) {
          notes.push(`Item ${k + 1} starts off page ${t + 1}, which is ${sizeText(s)}.`);
        }
      }
    }
    if (drawn.length) done.push(`drew ${drawn.length > 6 ? `${drawn.length} items (${drawn.slice(0, 6).join("; ")}; ...)` : drawn.join("; ")}`);

    // 4. Watermark.
    if (wm) {
      if (!String(wm.text ?? "").trim()) throw new Problem("A watermark needs text.");
      const on = pageSet(wm.pages ?? "all", count);
      for (const i of on) watermark(sheet(i), fonts, wm);
      done.push(`watermarked ${on.length === count ? "every page" : `pages ${rangeText(on)}`} "${String(wm.text).trim()}"`);
    }

    // 5. Page numbers.
    if (numbers) {
      const format = String(numbers.format ?? "Page {n} of {total}");
      if (!/\{n\}/.test(format)) throw new Problem("page_numbers' format needs {n} where the number goes, e.g. \"Page {n} of {total}\".");
      const on = pageSet(numbers.pages ?? "all", count);
      const start = Math.round(num(numbers.start) ?? 1);
      const total = on.length + start - 1;
      on.forEach((i, k) => {
        const label = format.replace(/\{n\}/g, String(start + k)).replace(/\{total\}/g, String(total));
        writable(fonts.get(numbers.font ?? "helvetica", Boolean(numbers.bold)), label);
        pageNumber(sheet(i), fonts, label, numbers);
      });
      done.push(`numbered ${on.length === count ? "every page" : `pages ${rangeText(on)}`}`);
    }
  };

  if (items.length || wm || numbers || flatten || changes.length || dropIds.size) {
    if (needsView) await withPdf(byText ? input.data : null, pass, apply, ctx);
    else await apply(null);
  }

  // 6. Properties.
  if (strip) {
    doc.context.trailerInfo.Info = undefined;
    doc.catalog.delete(PDFName.of("Metadata"));
    doc.catalog.delete(PDFName.of("PieceInfo"));
    done.push("removed its document properties (title, author, dates, producer and the XMP metadata)");
  }
  if (props) {
    const set: string[] = [];
    const text = (v: unknown) => String(v ?? "").trim();
    if (props.title !== undefined) { doc.setTitle(text(props.title)); set.push("title"); }
    if (props.author !== undefined) { doc.setAuthor(text(props.author)); set.push("author"); }
    if (props.subject !== undefined) { doc.setSubject(text(props.subject)); set.push("subject"); }
    if (props.keywords !== undefined) {
      doc.setKeywords(Array.isArray(props.keywords) ? props.keywords.map(text) : text(props.keywords).split(/\s*,\s*/));
      set.push("keywords");
    }
    if (props.creator !== undefined) { doc.setCreator(text(props.creator)); set.push("creator"); }
    if (props.producer !== undefined) { doc.setProducer(text(props.producer)); set.push("producer"); }
    if (set.length) done.push(`set its ${set.join(", ")}`);
  }
  if (!strip) doc.setModificationDate(new Date());
  if (encrypted && pass) notes.push("The original is password-protected; this copy is not (the PDF tools cannot add a password).");

  let bytes: Buffer;
  try {
    bytes = await saveDoc(doc);
  } catch (err) {
    throw new Problem(`It could not be saved: ${message(err)}`);
  }
  if (ctx.desk) {
    const all = [...(carryOn && desk ? desk.items.filter((i) => !dropIds.has(i.id)).map((i) => replaced.get(i.id) ?? i) : []), ...placed];
    let flat: { data: Buffer; skipped: string[] };
    try {
      flat = await flattenDesk(bytes, all, ctx.cwd);
    } catch (err) {
      throw new Problem(`It could not be saved: ${message(err)}`);
    }
    const name = working && !args.output ? working.name : outputName(input, args.output, values && !items.length ? "filled" : "edited");
    const saved = deliver(ctx, name, flat.data, `Edited from ${given.name}`);
    // Pages-level work (form fields, watermark, numbers, properties) is one change to review.
    const baseNote = done.filter((d) => !/^(drew|changed \d+ object|removed \d+ object)/.test(d)).join("; ") || null;
    // Objects alone leave the pages as pdf_compose laid them out.
    const keep = carryOn && desk && !baseNote ? desk : null;
    ctx.desk.open({
      name: saved.art.name, base: bytes, items: all, working: saved.art.id,
      source: carryOn && desk ? desk.source : given.artifact?.origin === "user" ? given.artifact.id : null,
      outName: saved.art.name,
      compose: keep?.compose ?? null, outline: keep?.outline ?? null,
      review: { label: cap(done.join("; ")) || "Edited", baseNote },
    });
    const summary = [
      done.length ? `${cap(done.join("; "))}.` : "",
      savedLine(saved, count, given),
      (placed.length ? `The objects: ${placed.slice(0, 12).map((i) => `${i.id} (${i.type}, page ${i.pageNumber})`).join(", ")}${placed.length > 12 ? ", ..." : ""}; pass an id to change or remove to alter it later. ` : "") +
      "Each change is marked in the window for the person to accept or decline, one by one, and every state of the file is kept as a version they can go back to. " +
      "It is open in the PDF window beside the conversation, where the person watches it change: " +
        (placed.length
          ? "what you placed is there as objects they can move, resize, edit or remove, and they can add their own. "
          : "they can add their own marks to it. ") +
        "The file is kept up to date with both; what they change is told to you.",
      ...notes,
      ...flat.skipped.map((s) => `Not drawn into the file: ${s}.`),
      "Look at the pages you changed with pdf_look before saying it is done.",
    ].filter(Boolean).join(" ");
    return { ok: true, summary, preview: PREVIEW(saved.art.name, count, saved.art.size) };
  }

  const saved = deliver(ctx, outputName(input, args.output, values && !items.length ? "filled" : "edited"), bytes, `Edited from ${input.name}`);
  const summary = [
    `${cap(done.join("; "))}.`,
    savedLine(saved, count, input),
    ...notes,
    "Look at the pages you changed with pdf_look before saying it is done.",
  ].join(" ");
  return { ok: true, summary, preview: PREVIEW(saved.art.name, count, saved.art.size) };
}

// -- pdf_compose --

/** A picture for a composed document: PNG or JPEG, by id or path. */
function composeImages(ctx: PdfContext): ImageLoader {
  return async (ref) => {
    const file = readFileRef(ref, ctx.cwd, "picture");
    const d = file.data;
    if (d[0] === 0x89 && d[1] === 0x50) return { data: d, kind: "png" };
    if (d[0] === 0xff && d[1] === 0xd8) return { data: d, kind: "jpg" };
    throw new Problem(`${file.name} is not a PNG or JPEG: a picture in a composed document is one of those.`);
  };
}

async function composeTool(args: Record<string, any>, ctx: PdfContext): Promise<PdfOutcome> {
  const desk = ctx.desk?.current() ?? null;
  const previous = desk?.compose ?? null;
  const next = applyChanges(previous, args);
  const made = await compose(next, composeImages(ctx));
  let bytes: Buffer;
  try {
    bytes = await saveDoc(made.doc);
  } catch (err) {
    throw new Problem(`It could not be saved: ${message(err)}`);
  }

  const working = previous && desk?.working ? getArtifact(desk.working) : null;
  const asked = String(args.output ?? "").trim();
  const name = asked
    ? outputName({ data: bytes, name: "document.pdf", artifact: null }, asked, "document")
    : working?.name ?? cleanName(`${String(next.title ?? "document").replace(/[^\p{L}\p{N}]+/gu, "-").replace(/^-+|-+$/g, "").slice(0, 60) || "document"}.pdf`);
  const kept = previous && desk ? desk.items : [];
  const orphans = kept.filter((i) => i.pageNumber > made.pages);
  const label = previous
    ? `Updated the document (${made.pages} page${made.pages === 1 ? "" : "s"})`
    : `Composed a document (${made.pages} page${made.pages === 1 ? "" : "s"})`;

  let flat: { data: Buffer; skipped: string[] };
  try {
    flat = await flattenDesk(bytes, kept, ctx.cwd);
  } catch (err) {
    throw new Problem(`It could not be saved: ${message(err)}`);
  }
  const replacing = !previous && desk && desk.working ? getArtifact(desk.working)?.name ?? desk.name : null;
  const saved = deliver(ctx, name, flat.data, previous ? "Updated by pdf_compose" : "Composed by pdf_compose");
  ctx.desk?.open({
    name: saved.art.name, base: bytes, items: kept, working: saved.art.id, source: null, outName: saved.art.name,
    compose: made.source, outline: made.outline,
    review: { label, baseNote: previous ? label : null, diff: false },
  });

  const lines = outlineLines(made.outline);
  const summary = [
    `${label}.`,
    savedLine(saved, made.pages, { data: bytes, name, artifact: null }),
    lines.length ? `Where things are (page, heading [block id], how it starts):\n${lines.join("\n")}` : "",
    made.source.blocks.length ? `${made.source.blocks.length} blocks in all.` : "",
    "To change it, send update / insert / remove with block ids (or blocks again for the whole document): the whole thing is laid out again, so nothing has to be repositioned.",
    ctx.desk
      ? "It is open in the PDF window beside the conversation; pdf_edit adds stamps, notes, signatures and highlights on top, as objects the person can move."
      : "",
    orphans.length ? `${orphans.length} object${orphans.length === 1 ? "" : "s"} placed on it earlier now sit on page${orphans.length === 1 ? "" : "s"} beyond its end and are not drawn.` : "",
    kept.length && !orphans.length ? `The ${kept.length} object${kept.length === 1 ? "" : "s"} placed on it earlier stayed where they were; look at the pages to see they still fit.` : "",
    replacing ? `It replaced ${replacing} in the window; that file itself is unchanged.` : "",
    ...made.notes,
    ...flat.skipped.map((s) => `Not drawn into the file: ${s}.`),
    "Look at the pages with pdf_look before saying it is done.",
  ].filter(Boolean).join(" ");
  return { ok: true, summary, preview: PREVIEW(saved.art.name, made.pages, saved.art.size) };
}

function pngOrJpeg(ref: unknown, cwd: string): boolean {
  try {
    const data = readFileRef(ref, cwd, "picture").data;
    return (data[0] === 0x89 && data[1] === 0x50) || (data[0] === 0xff && data[1] === 0xd8);
  } catch {
    return true;
  }
}

const cap = (text: string) => (text ? text[0].toUpperCase() + text.slice(1) : text);

// -- pdf_pages --

async function pagesTool(args: Record<string, any>, ctx: PdfContext): Promise<PdfOutcome> {
  const { input } = onDesk(readPdf(args.file, ctx.cwd), ctx);
  const pass = password(args);
  const { doc } = await openDoc(input.data, pass);
  if (xfaKind(doc) === "dynamic") {
    throw new Problem("This is a dynamic XFA form, whose pages are drawn from XML: rearranging the file's pages would not change them. Turn it into an ordinary PDF first with pdf_compress (mode images).");
  }
  const count = doc.getPageCount();
  const original = doc.getPages();
  const plan = parsePages(args.pages ?? "all", count, true);
  const turns = Array.isArray(args.rotate) ? args.rotate : args.rotate ? [args.rotate] : [];
  const merges = Array.isArray(args.merge) ? args.merge : args.merge ? [args.merge] : [];
  const each = args.split === "each" || (Array.isArray(args.split) && args.split[0] === "each");
  if (!turns.length && !merges.length && !args.split && plan.length === count && plan.every((p, i) => p === i)) {
    throw new Problem("Nothing to change: give pages (a new order, or which to keep), rotate, merge or split.");
  }
  const done: string[] = [];

  // Turn pages, by their number in this file.
  for (const turn of turns) {
    const by = Math.round(need(turn?.degrees, "rotate's degrees"));
    if (by % 90 !== 0) throw new Problem("Pages turn by 90, 180 or 270 degrees.");
    const which = pageSet(turn?.pages ?? "all", count);
    for (const i of which) {
      const page = original[i];
      page.setRotation(degrees((((page.getRotation().angle + by) % 360) + 360) % 360));
    }
    done.push(`turned ${which.length === count ? "every page" : `page${which.length === 1 ? "" : "s"} ${rangeText(which)}`} ${((by % 360) + 360) % 360}°`);
  }

  // The new order: each page once as itself, again as a copy; blanks sized like their neighbour.
  const used = new Set<number>();
  const next: PDFPage[] = [];
  let copies = 0;
  let blanks = 0;
  for (const [k, entry] of plan.entries()) {
    if (entry === "blank") {
      const near = plan.slice(0, k).reverse().find((p) => p !== "blank") ?? plan.find((p) => p !== "blank");
      const like = viewOf(original[typeof near === "number" ? near : 0]);
      const blank = PDFPage.create(doc);
      blank.setSize(like.width, like.height);
      next.push(blank);
      blanks++;
    } else if (!used.has(entry)) {
      used.add(entry);
      next.push(original[entry]);
    } else {
      const [copy] = await doc.copyPages(doc, [entry]);
      next.push(copy);
      copies++;
    }
  }

  // Other files, after.
  const merged: string[] = [];
  for (const m of merges) {
    const spec = typeof m === "object" && m ? m : { file: m };
    const other = readPdf(spec.file, ctx.cwd);
    const { doc: src } = await openDoc(other.data, typeof spec.password === "string" ? spec.password : undefined);
    if (xfaKind(src) === "dynamic") throw new Problem(`${other.name} is a dynamic XFA form; turn it into an ordinary PDF first with pdf_compress (mode images).`);
    const which = pageSet(spec.pages ?? "all", src.getPageCount());
    next.push(...await doc.copyPages(src, which));
    merged.push(`${other.name}${which.length === src.getPageCount() ? "" : ` (pages ${rangeText(which)})`}`);
  }

  const dropped = original.map((_, i) => i).filter((i) => !used.has(i));
  forgetPages(doc, new Map(dropped.map((i) => [original[i].ref, null])));
  setPages(doc, next);

  const kept = plan.filter((p): p is number => p !== "blank");
  if (dropped.length) done.push(`removed page${dropped.length === 1 ? "" : "s"} ${rangeText(dropped)}`);
  if (kept.some((p, i) => i > 0 && p < kept[i - 1])) done.push("put the pages in the order asked");
  if (copies) done.push(`repeated ${copies} page${copies === 1 ? "" : "s"}`);
  if (blanks) done.push(`added ${blanks} blank page${blanks === 1 ? "" : "s"}`);
  if (merged.length) done.push(`added the pages of ${merged.join(", ")}`);

  const total = doc.getPageCount();
  const base = merged.length ? "merged" : "pages";

  // Split: several files, each from the result.
  if (args.split) {
    const parts: number[][] = each
      ? Array.from({ length: total }, (_, i) => [i])
      : (Array.isArray(args.split) ? args.split : [args.split]).map((spec: unknown) => pageSet(spec, total));
    if (parts.length > 60) throw new Problem(`That would make ${parts.length} files; split into at most 60 at a time.`);
    const title = doc.getTitle();
    const made: string[] = [];
    const stem = outputName(input, args.output, "part").replace(/\.pdf$/i, "").replace(/-part$/, "");
    for (const [k, indices] of parts.entries()) {
      const part = await PDFDocument.create({ updateMetadata: false });
      for (const page of await part.copyPages(doc, indices)) part.addPage(page);
      if (title) part.setTitle(title);
      const name = cleanName(`${stem}-${each ? `page-${indices[0] + 1}` : `part-${k + 1}`}.pdf`);
      const saved = deliver(ctx, name, await saveDoc(part), `Pages ${rangeText(indices)} of ${input.name}`);
      made.push(`${saved.art.id} (${saved.art.name}: page${indices.length === 1 ? "" : "s"} ${rangeText(indices)})`);
    }
    return {
      ok: true,
      summary:
        `${done.length ? `${cap(done.join("; "))}, then s` : "S"}plit it into ${made.length} files, saved as artifacts and shown in the conversation: ${made.join(", ")}. ` +
        `${input.artifact?.origin === "agent" ? "" : `${input.name} itself is unchanged.`}`,
      preview: `${made.length} files from ${input.name}`,
    };
  }

  const saved = deliver(ctx, outputName(input, args.output, base), await saveDoc(doc), `Pages of ${input.name}, rearranged`, input);
  return {
    ok: true,
    summary: `${cap(done.join("; "))}: ${total} page${total === 1 ? "" : "s"} now. ${savedLine(saved, total, input)}`,
    preview: PREVIEW(saved.art.name, total, saved.art.size),
  };
}

// -- pdf_redact --

const REDACT_DPI = 150;

async function redactTool(args: Record<string, any>, ctx: PdfContext): Promise<PdfOutcome> {
  const { input } = onDesk(readPdf(args.file, ctx.cwd), ctx);
  const pass = password(args);
  const patterns = patternsFor(args.find);
  const areas: Record<string, any>[] = (Array.isArray(args.areas) ? args.areas : args.areas ? [args.areas] : [])
    .filter((a: unknown) => a && typeof a === "object");
  if (!patterns.length && !areas.length) {
    throw new Problem("Say what to redact: find (text, /regular expressions/, or email, phone, ssn, credit_card, date) and/or areas.");
  }
  const { doc, encrypted } = await openDoc(input.data, pass);
  const dpi = Math.min(300, Math.max(72, num(args.dpi) ?? REDACT_DPI));

  return withPdf(input.data, pass, async (view) => {
    const count = view.pages;
    const scope = pageSet(args.pages ?? "all", count);
    const boxes = new Map<number, Rect[]>();
    const add = (page: number, r: Rect) => boxes.set(page, [...(boxes.get(page) ?? []), r]);
    const found: Hit[] = [];
    if (patterns.length) {
      for (const i of scope) {
        if (ctx.cancelled()) throw new Problem("Stopped before it was finished; nothing was saved.");
        const [page] = await view.text(i + 1, i + 1, true);
        for (const hit of findOnPage(page, patterns)) {
          found.push(hit);
          for (const b of hit.boxes) add(i, b);
        }
      }
    }
    for (const a of areas) {
      const pages = pageSet(a.page ?? a.pages ?? 1, count);
      const r = { x: need(a.x, "area's x"), y: need(a.y, "area's y"), w: need(a.width, "area's width"), h: need(a.height, "area's height") };
      if (r.w <= 0 || r.h <= 0) throw new Problem("An area needs a width and a height above 0.");
      for (const p of pages) add(p, r);
    }
    if (boxes.size === 0) {
      return {
        ok: true,
        summary:
          `Nothing matched ${patterns.map((p) => p.label).join(", ")}${scope.length < count ? ` on pages ${rangeText(scope)}` : ""}, so nothing was redacted and no file was made.` +
          (view.xfa ? " Its text comes from an XFA form and has no places on the page: give areas instead." : " If it is a scan it has no text to search: look with pdf_look and give areas."),
        preview: "nothing matched",
      };
    }

    const redrawn = [...boxes.keys()].sort((a, b) => a - b);
    const out = await redrawWithBoxes(doc, view, boxes, dpi, ctx.cancelled);

    const bytes = await saveDoc(out);
    const saved = deliver(ctx, outputName(input, args.output, "redacted"), bytes, `Redacted from ${input.name}`, input);
    const list = found.slice(0, 60).map((h) => `page ${h.page}: ${JSON.stringify(h.text.slice(0, 60))}`);
    return {
      ok: true,
      summary: [
        `Redacted ${found.length ? `${found.length} match${found.length === 1 ? "" : "es"}` : ""}${found.length && areas.length ? " and " : ""}${areas.length ? `${areas.length} area${areas.length === 1 ? "" : "s"}` : ""} ` +
        `on page${redrawn.length === 1 ? "" : "s"} ${rangeText(redrawn)}.`,
        list.length ? `Found: ${list.join("; ")}${found.length > 60 ? "; ..." : ""}.` : "",
        `Those pages were redrawn as pictures at ${dpi} dpi with black boxes, so what was under them is gone from the file, ` +
        "not just covered; their text can no longer be selected or searched. Other pages are as they were.",
        savedLine(saved, out.getPageCount(), input),
        "Document properties (title, author...) are untouched: strip them with pdf_edit strip_metadata if they may hold what was redacted.",
        encrypted && pass ? "The original is password-protected; this copy is not." : "",
        "Check the result with pdf_look.",
      ].filter(Boolean).join(" "),
      preview: PREVIEW(saved.art.name, out.getPageCount(), saved.art.size),
    };
  }, ctx);
}

// -- pdf_replace_text --

/** At most this many places are shown being edited in one go. */
const MAX_CUES = 6;

/** Where some words are drawn on a page: the first box of each place they appear. */
async function locateText(view: PdfView, pageIndex: number, find: string, ignoreCase: boolean): Promise<Rect[]> {
  const [page] = await view.text(pageIndex + 1, pageIndex + 1, true);
  const source = find.split(/\s+/).map((w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*");
  const re = new RegExp(source, ignoreCase ? "gi" : "g");
  return findOnPage(page, [{ label: find, re }]).map((h) => h.boxes[0]);
}

/** Change the words a PDF already has. See ./pdftext.ts for how. */
async function replaceTextTool(args: Record<string, any>, ctx: PdfContext): Promise<PdfOutcome> {
  const { input } = onDesk(readPdf(args.file, ctx.cwd), ctx);
  const pass = password(args);
  const list: Record<string, any>[] = (Array.isArray(args.replace) ? args.replace : args.replace ? [args.replace] : [])
    .filter((r: unknown) => r && typeof r === "object");
  const edits: TextEdit[] = list.map((r) => ({
    find: String(r.find ?? ""),
    with: String(r.with ?? ""),
    ignoreCase: r.ignore_case === true,
  })).filter((e) => e.find.trim());
  if (edits.length === 0) {
    throw new Problem("Say what to change: replace is a list of {find, with}. find is the words as they are now; with is what they become (empty to delete them).");
  }
  const { doc, encrypted } = await openDoc(input.data, pass);
  if (hasForm(doc) && doc.getForm().hasXFA()) {
    throw new Problem("Its text comes from an XFA form, which has no words in the pages to change. Fill it with pdf_edit fields instead.");
  }

  /* What the saved file should read, checked by reading it back (below). */
  let proof: { bytes: Uint8Array; checks: { find: string; with: string; ignoreCase: boolean; pages: number[] }[] } | null = null;
  const outcome = await withPdf(input.data, pass, async (view) => {
    const count = view.pages;
    const scope = pageSet(args.pages ?? "all", count);
    const tools: Tools = { fonts: new Fonts(doc), doc, cwd: ctx.cwd, view, fields: null, texts: new Map() };
    const totals = new Map<string, { with: string; matches: number; how: Set<string>; pages: number[] }>();
    const notes = new Set<string>();
    const touched: number[] = [];
    const cues: Cue[] = [];
    for (const i of scope) {
      if (ctx.cancelled()) throw new Problem("Stopped before it was finished; nothing was saved.");
      const locate = (find: string, ignoreCase: boolean) => locateText(view, i, find, ignoreCase);
      const done = await replaceOnPage(doc, doc.getPage(i), edits, locate);
      done.notes.forEach((n) => notes.add(`Page ${i + 1}: ${n}`));
      if (done.changed.length === 0) continue;
      touched.push(i);
      // Where each change was, for the window to show it being made. The
      // positions are of the old words, which are where the new ones now are.
      for (const c of done.changed) {
        if (cues.length >= MAX_CUES) break;
        for (const box of (await locateText(view, i, c.find, edits.find((e) => e.find === c.find)?.ignoreCase === true)).slice(0, 3)) {
          if (cues.length < MAX_CUES) cues.push({ page: i + 1, x: box.x, y: box.y, w: box.w, h: box.h, from: c.find, to: c.with, act: "retype", tool: "text" });
        }
      }
      for (const c of done.changed) {
        const t = totals.get(c.find) ?? { with: c.with, matches: 0, how: new Set<string>(), pages: [] };
        t.matches += c.matches;
        t.how.add(c.how);
        t.pages.push(i + 1);
        totals.set(c.find, t);
      }
      if (done.draws.length) {
        const sheet = new Sheet(doc.getPage(i));
        for (const d of done.draws) {
          try {
            await drawItem(tools, sheet, i, { type: "text", x: d.x, y: d.y, text: d.text, size: d.size, color: d.color, font: d.font, bold: d.bold, italic: d.italic }, null);
          } catch (err) {
            throw new Problem(`Page ${i + 1}: the new words ${JSON.stringify(d.text)} could not be written: ${message(err)} Nothing was saved.`);
          }
        }
      }
    }

    const absent = edits.filter((e) => !totals.has(e.find)).map((e) => JSON.stringify(e.find));
    if (totals.size === 0) {
      return {
        ok: true,
        summary:
          `Nothing was changed, and no file was made. ${absent.length ? `Not found as text in the file: ${absent.join(", ")}. ` : ""}` +
          [...notes].join(" ") +
          " Check the wording with pdf_read find (it must be the words as the file holds them); if the page is a scan it has no text to change: look with pdf_look, cover the area with pdf_redact areas and add the words with pdf_edit.",
        preview: "nothing matched",
      };
    }

    const bytes = await saveDoc(doc);
    proof = {
      bytes,
      checks: [...totals.entries()].map(([find, t]) => ({
        find, with: t.with, ignoreCase: edits.find((e) => e.find === find)?.ignoreCase === true, pages: [...new Set(t.pages)],
      })),
    };
    const saved = deliver(ctx, outputName(input, args.output, "edited"), bytes, `Changed text in ${input.name}`, input, cues);
    const lines = [...totals.entries()].map(([find, t]) =>
      `${JSON.stringify(find)} -> ${JSON.stringify(t.with)}: ${t.matches} change${t.matches === 1 ? "" : "s"} on page${t.pages.length === 1 ? "" : "s"} ${rangeText([...new Set(t.pages)].map((p) => p - 1))}` +
      ` (${[...t.how].join(" and ")})`);
    return {
      ok: true,
      summary: [
        `Changed the text of ${input.name}: ${lines.join("; ")}.`,
        "In place means the words were rewritten inside the file in the page's own font, so they stay selectable and searchable; " +
        "redrawn means that font could not write them, so the old words were taken out of the file and the new ones drawn in a built-in font of the same kind, colour and size.",
        absent.length ? `Not found: ${absent.join(", ")}.` : "",
        [...notes].join(" "),
        "Words are not reflowed: where the new ones are longer or shorter than the old, anything the file places separately on that line (the next column, a word it drew on its own) stays where it was, so look at the line before saying it is right.",
        savedLine(saved, doc.getPageCount(), input),
        encrypted && pass ? "The original is password-protected; this copy is not." : "",
        "Check the pages with pdf_look.",
      ].filter(Boolean).join(" "),
      preview: PREVIEW(saved.art.name, doc.getPageCount(), saved.art.size),
    };
  }, ctx);

  /* Not the edit's own word for it: the saved file, read back the way a viewer
     reads it. The new words must be there and the old ones gone. */
  if (proof) {
    const { bytes, checks } = proof as { bytes: Uint8Array; checks: { find: string; with: string; ignoreCase: boolean; pages: number[] }[] };
    try {
      const wrong = await withPdf(Buffer.from(bytes), undefined, async (view) => {
        const out: string[] = [];
        for (const c of checks) {
          for (const p of c.pages) {
            if (c.with && (await locateText(view, p - 1, c.with, c.ignoreCase)).length === 0) {
              out.push(`${JSON.stringify(c.with)} does not read on page ${p}`);
            }
            if (!c.with.toLowerCase().includes(c.find.toLowerCase()) && (await locateText(view, p - 1, c.find, c.ignoreCase)).length > 0) {
              out.push(`${JSON.stringify(c.find)} still reads on page ${p}`);
            }
          }
        }
        return out;
      }, ctx);
      outcome.summary += wrong.length === 0
        ? " Read back from the saved file: the new words are there and the old ones are gone."
        : ` CHECK FAILED when the saved file was read back: ${wrong.slice(0, 4).join("; ")}. Look at the page with pdf_look before saying it is done.`;
    } catch {
      // The read-back is a check, not the edit: if it cannot run, the edit still stands.
    }
  }
  return outcome;
}

/**
 * The pages with boxes on them redrawn as pictures with the boxes blacked
 * out, so what was under them is gone from the file rather than covered.
 * An XFA form, drawn from XML rather than from its pages, has every page
 * redrawn. `doc` is changed in place unless it is XFA.
 */
async function redrawWithBoxes(
  doc: PDFDocument, view: PdfView, boxes: Map<number, Rect[]>, dpi: number, cancelled: () => boolean,
): Promise<PDFDocument> {
  const scale = dpi / 72;
  const count = view.pages;
  if (view.xfa || count !== doc.getPageCount()) {
    const out = await PDFDocument.create({ updateMetadata: false });
    for (let i = 0; i < count; i++) {
      if (cancelled()) throw new Problem("Stopped before it was finished; nothing was saved.");
      const pic = await view.render(i + 1, { scale, boxes: boxes.get(i), type: "image/jpeg", quality: 0.9 });
      const img = await out.embedJpg(pic.data);
      const page = out.addPage([pic.width / scale, pic.height / scale]);
      page.drawImage(img, { x: 0, y: 0, width: pic.width / scale, height: pic.height / scale });
    }
    return out;
  }
  const list = doc.getPages().slice();
  const gone = new Map<PDFRef, PDFRef | null>();
  for (const i of [...boxes.keys()].sort((a, b) => a - b)) {
    if (cancelled()) throw new Problem("Stopped before it was finished; nothing was saved.");
    const pic = await view.render(i + 1, { scale, boxes: boxes.get(i), type: "image/jpeg", quality: 0.9 });
    const old = list[i];
    const { width, height } = viewOf(old);
    const img = await doc.embedJpg(pic.data);
    const fresh = PDFPage.create(doc);
    fresh.setSize(width, height);
    fresh.drawImage(img, { x: 0, y: 0, width, height });
    list[i] = fresh;
    gone.set(old.ref, fresh.ref);
  }
  forgetPages(doc, gone);
  setPages(doc, list);
  return doc;
}

// -- pdf_compress --

async function compressTool(args: Record<string, any>, ctx: PdfContext): Promise<PdfOutcome> {
  const { input } = onDesk(readPdf(args.file, ctx.cwd), ctx);
  const pass = password(args);
  const mode = String(args.mode ?? "lossless").toLowerCase() === "images" ? "images" : "lossless";
  const before = input.data.byteLength;
  let bytes: Buffer;
  let pages: number;
  let how: string;
  let locked = false;
  let converted = false;

  if (mode === "lossless") {
    const { doc, encrypted } = await openDoc(input.data, pass);
    locked = encrypted && Boolean(pass);
    pages = doc.getPageCount();
    bytes = await saveDoc(doc, true);
    how = "rewritten compactly (object streams, nothing unused kept); nothing you can see changed";
  } else {
    const { doc: src, encrypted } = await openDoc(input.data, pass);
    locked = encrypted && Boolean(pass);
    // An XFA form is being turned into pages to keep, not squeezed: sharper by default.
    converted = xfaKind(src) === "dynamic";
    const dpi = Math.min(300, Math.max(50, num(args.dpi) ?? (converted ? 150 : 110)));
    const quality = Math.min(0.95, Math.max(0.1, num(args.quality) ?? (converted ? 0.85 : 0.7)));
    const out = await PDFDocument.create({ updateMetadata: false });
    for (const [key, value] of [["Title", src.getTitle()], ["Author", src.getAuthor()], ["Subject", src.getSubject()]] as const) {
      if (!value) continue;
      if (key === "Title") out.setTitle(value);
      else if (key === "Author") out.setAuthor(value);
      else out.setSubject(value);
    }
    pages = await withPdf(input.data, pass, async (view) => {
      const scale = dpi / 72;
      for (let i = 0; i < view.pages; i++) {
        if (ctx.cancelled()) throw new Problem("Stopped before it was finished; nothing was saved.");
        const pic = await view.render(i + 1, { scale, type: "image/jpeg", quality });
        const img = await out.embedJpg(pic.data);
        const w = pic.width / scale, h = pic.height / scale;
        out.addPage([w, h]).drawImage(img, { x: 0, y: 0, width: w, height: h });
      }
      return view.pages;
    }, ctx);
    bytes = await saveDoc(out, true);
    how = `every page redrawn as a JPEG at ${dpi} dpi, quality ${Math.round(quality * 100)} -- its text can no longer be selected or searched, and links and form fields are gone`;
  }

  const after = bytes.byteLength;
  if (converted) {
    const saved = deliver(ctx, outputName(input, args.output, "flattened"), bytes, `${input.name}'s XFA form, as pages`, input);
    return {
      ok: true,
      summary:
        `Turned its XFA form into an ordinary PDF of how it looks (${formatSize(before)} → ${formatSize(after)}): ${how}. ` +
        `${savedLine(saved, pages, input)} It opens in any viewer, and pdf_edit can write on it.`,
      preview: PREVIEW(saved.art.name, pages, saved.art.size),
    };
  }
  if (after >= before * 0.98) {
    return {
      ok: true,
      summary:
        `It did not get smaller (${formatSize(before)} → ${formatSize(after)}), so nothing was saved.` +
        (mode === "lossless" ? " mode images, at a lower dpi or quality, shrinks scans and picture-heavy files much further." : " It is already compact; a lower dpi or quality would shrink it further, at the cost of sharpness."),
      preview: "no smaller",
    };
  }
  const saved = deliver(ctx, outputName(input, args.output, "compressed"), bytes, `Compressed from ${input.name}`, input);
  return {
    ok: true,
    summary: `${formatSize(before)} → ${formatSize(after)} (${Math.round((1 - after / before) * 100)}% smaller): ${how}. ${savedLine(saved, pages, input)}` +
      (locked ? " The original is password-protected; this copy is not." : ""),
    preview: PREVIEW(saved.art.name, pages, saved.art.size),
  };
}
