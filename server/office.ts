/**
 * Word, Excel and PowerPoint documents: read, edit, check, make and convert.
 *
 * The agent's half of GenOffice (https://github.com/genspark-ai/genoffice,
 * Apache-2.0), without its windows: the same document engines, run as its
 * command line in a child process (scripts/build-office.mjs builds it into
 * dist/office/). Real .docx, .xlsx and .pptx files are changed -- only what is
 * edited is rewritten, the rest of the file survives byte for byte -- and every
 * result is saved as a new artifact the person can open from the thread, the
 * same as the PDF tools (./pdf.ts). Nothing overwrites what the person gave:
 * an edit works on a copy, and the agent's own earlier result is updated in
 * place.
 *
 * The engines do not draw a page: laying it out is the app's editor's job.
 * That is run too (./officerender.ts), headless, for pictures of pages and for
 * PDF. The check each format has (`office_check`) -- overflow, overlap and
 * off-slide on a deck, broken references on a workbook, stale fields and
 * placeholder text in a document -- finds what looking would not.
 *
 * Nothing here is required to run Autora. Without the build the tools are not
 * offered (see officeDir), and without the spreadsheet engine only the Excel
 * ones say so.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_ARTIFACT_BYTES, cleanName, formatSize, getArtifact, listArtifacts, saveArtifact } from "./artifacts";
import type { ChatImage } from "./llm";
import { FileRefError, readFileRef, type FileInput } from "./fileref";
import { lookAtPdf, type DeskHooks } from "./pdf";
import type { OfficeHooks } from "./officedesk";
import { APP_OF, OfficeRenderError, editorBuilt, renderToPdf } from "./officerender";
import { PdfRenderError } from "./pdfrender";

// ----------------------------------------------------------- the build --

/** Where the built command line is, or null when it was not built. */
export function officeDir(): string | null {
  const candidates = [
    process.env.AUTORA_OFFICE_DIR,
    path.join(process.cwd(), "dist", "office"),
  ].filter((d): d is string => Boolean(d));
  return candidates.find((d) => fs.existsSync(path.join(d, "cli", "genoffice.cjs"))) ?? null;
}

/** The spreadsheet engine for this CPU, or null. */
export function sidecarPath(dir = officeDir()): string | null {
  if (!dir) return null;
  if (process.env.XLSX_SIDECAR_PATH && fs.existsSync(process.env.XLSX_SIDECAR_PATH)) return process.env.XLSX_SIDECAR_PATH;
  const arch = process.arch === "arm64" ? "arm64" : "x64";
  return [`xlsx-sidecar-${arch}`, "xlsx-sidecar"].map((n) => path.join(dir, "native", n)).find((p) => fs.existsSync(p)) ?? null;
}

// ------------------------------------------------------------- context --

export interface OfficeContext {
  session: string;
  /** Where a relative path starts: the terminal's working directory. */
  cwd: string;
  /** How many characters of text a result may carry. */
  room: number;
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
  putBlob: (data: Buffer, mime: string) => string;
  showImage: (blob: string, alt: string, caption: string | null, size?: { w: number; h: number }) => void;
  /** The PDF window: a PDF made here is opened in it. Absent in an incognito chat. */
  desk?: DeskHooks;
  /** The Pages / Sheets / Slides window: a document made or changed here is shown in it. Absent in an incognito chat. */
  win?: OfficeHooks;
  /** Why something may not be changed right now (the person is working on it), or null. */
  held?: (surface: "office", subject: string) => string | null;
  /** Kinds of document the person has switched off on the Tools page (Autora Pages, Sheets or Slides). */
  off?: Kind[];
  cancelled: () => boolean;
  onCancel: (stop: () => void) => void;
}

export interface OfficeOutcome {
  ok: boolean;
  summary: string;
  preview?: string;
  images?: ChatImage[];
}

/** A failure the agent is told in so many words. */
class Problem extends Error {}

export type Kind = "docx" | "xlsx" | "pptx";
const KINDS: Record<string, Kind> = { ".docx": "docx", ".xlsx": "xlsx", ".pptx": "pptx" };
const MIME: Record<Kind, string> = {
  docx: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  xlsx: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
  pptx: "application/vnd.openxmlformats-officedocument.presentationml.presentation",
};
const DOMAIN: Record<Kind, "docs" | "sheet" | "slides"> = { docx: "docs", xlsx: "sheet", pptx: "slides" };

export const kindOf = (name: string): Kind | null => KINDS[path.extname(name).toLowerCase()] ?? null;

/** What each kind of document is called, as an app. */
export const APP_NAME: Record<Kind, string> = { docx: "Autora Pages", xlsx: "Autora Sheets", pptx: "Autora Slides" };

/** Refuse work on a kind of document the person switched off, saying where it is switched on. */
function allowed(ctx: OfficeContext, kind: Kind) {
  if (ctx.off?.includes(kind)) {
    throw new Problem(`${APP_NAME[kind]} (.${kind} files) is switched off on the Tools page, so it is not yours this turn. If the task needs it, say so and that it is switched on there.`);
  }
}

export async function runOfficeTool(name: string, args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  try {
    if (!officeDir()) {
      return { ok: false, summary: "The Office tools are not installed on this server (they are built into dist/office by `node scripts/build-office.mjs`)." };
    }
    // What the person has just done in the editor has reached the file before any tool reads it.
    await ctx.win?.settle();
    switch (name) {
      case "office_guide": return await guideTool(args, ctx);
      case "office_read": return await readTool(args, ctx);
      case "office_edit": return await editTool(args, ctx);
      case "office_check": return await checkTool(args, ctx);
      case "office_look": return await lookTool(args, ctx);
      case "office_pdf": return await pdfTool(args, ctx);
      case "office_open": return await openTool(args, ctx);
      case "office_create": return await createTool(args, ctx);
      case "office_convert": return await convertTool(args, ctx);
      default: return { ok: false, summary: `There is no Office tool called ${name}.` };
    }
  } catch (err) {
    if (err instanceof Problem || err instanceof FileRefError || err instanceof OfficeRenderError || err instanceof PdfRenderError) {
      return { ok: false, summary: err.message };
    }
    return { ok: false, summary: `${name} failed: ${String((err as Error)?.message ?? err).split("\n")[0]}` };
  }
}

// ------------------------------------------------------------- running --

/** What the command line printed: its one JSON envelope. */
interface Envelope {
  status?: "ok" | "partial" | "error";
  command?: string;
  summary?: string;
  message?: string;
  error?: string;
  code?: number;
  output_path?: string;
  warnings?: { code?: string; message?: string }[];
  detail?: Record<string, any>;
}

interface Run {
  env: Envelope | null;
  text: string;
  code: number | null;
}

const RUN_MS = 180_000;
const MAX_OUTPUT = 12 * 1024 * 1024;

/** A scratch folder, gone afterwards whatever happens. */
async function withWork<T>(fn: (dir: string) => Promise<T>): Promise<T> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-office-"));
  try {
    return await fn(dir);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

/**
 * A brand new, empty document: one blank page, a workbook with one empty
 * sheet, or a deck with one blank slide.
 *
 * The agent starts a document by asking for one; this is how the person starts
 * one themselves, from the toolbox beside the message box, without a turn. The
 * file is made by the same engine the tools use, so it opens in Autora Pages,
 * Sheets or Slides exactly as one the agent made would. A blank of each kind is
 * kept once it has been made, so the second tap is instant.
 */
const BLANKS = new Map<Kind, Buffer>();

export async function blankOffice(kind: Kind, ctx: Runner = { cancelled: () => false, onCancel: () => undefined }): Promise<Buffer> {
  const held = BLANKS.get(kind);
  if (held) return Buffer.from(held);
  if (!officeDir()) throw new Error(`The Office tools are not installed on this server, so a new ${APP_NAME[kind]} file cannot be made (they are built into dist/office by \`node scripts/build-office.mjs\`).`);
  return await withWork(async (work) => {
    // An empty source of each kind: the engine is what decides what "blank" is.
    const src = path.join(work, kind === "docx" ? "content.md" : kind === "xlsx" ? "rows.json" : "ops.json");
    fs.writeFileSync(src, kind === "docx" ? "" : "[]");
    const out = path.join(work, `blank.${kind}`);
    const args = kind === "docx" ? ["create", "--type", "docx", "--from", src]
      : kind === "xlsx" ? ["create", "--type", "xlsx", "--from", src]
      : ["create", "--type", "pptx", "--ops", src];
    const run = await cli([...args, "--out", out], work, ctx);
    if (run.env?.status !== "ok" || !fs.existsSync(out)) throw new Error(failure(run, `Making a new blank ${APP_NAME[kind]} file`));
    const bytes = fs.readFileSync(out);
    BLANKS.set(kind, bytes);
    return Buffer.from(bytes);
  });
}

function parseEnvelope(text: string): Envelope | null {
  const t = text.trim();
  if (!t) return null;
  for (const candidate of [t, t.split("\n").filter((l) => l.trim().startsWith("{")).pop() ?? ""]) {
    try {
      const v = JSON.parse(candidate);
      if (v && typeof v === "object") return v as Envelope;
    } catch {
      // Not JSON: try the last JSON-looking line, then give up.
    }
  }
  return null;
}

/** What running the command line needs of whoever asked for it. */
export interface Runner {
  cancelled: () => boolean;
  onCancel: (stop: () => void) => void;
}

/** Run the command line with these arguments. */
async function cli(args: string[], work: string, ctx: Runner, json = true): Promise<Run> {
  const dir = officeDir()!;
  const sidecar = sidecarPath(dir);
  const env: NodeJS.ProcessEnv = {
    PATH: process.env.PATH,
    LANG: process.env.LANG ?? "C.UTF-8",
    HOME: work,
    TMPDIR: work,
    NODE_ENV: "production",
    ...(sidecar ? { XLSX_SIDECAR_PATH: sidecar } : {}),
  };
  return await new Promise<Run>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(dir, "cli", "genoffice.cjs"), ...args, ...(json ? ["--json"] : [])], {
      cwd: work, env, stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    let err = "";
    let over = false;
    const stop = () => child.kill("SIGKILL");
    ctx.onCancel(stop);
    const timer = setTimeout(() => { stop(); reject(new Problem(`That took longer than ${RUN_MS / 1000} seconds and was stopped.`)); }, RUN_MS);
    child.stdout.on("data", (d) => { if (out.length < MAX_OUTPUT) out += d; else over = true; });
    child.stderr.on("data", (d) => { if (err.length < 64 * 1024) err += d; });
    child.on("error", (e) => { clearTimeout(timer); reject(new Problem(`The Office engine could not start (${e.message}).`)); });
    child.on("close", (code) => {
      clearTimeout(timer);
      if (ctx.cancelled()) return reject(new Problem("Stopped."));
      if (over) return reject(new Problem("The result was too large to read; ask for a narrower part of the document."));
      resolve({ env: json ? parseEnvelope(out) : null, text: json ? err : out, code });
    });
  });
}

/** An error envelope, said plainly. */
function failure(run: Run, doing: string): string {
  const e = run.env;
  const detail = e?.detail ?? {};
  if (e?.error === "conversion_failed" && /xlsx engine/.test(e.message ?? "")) {
    return "The spreadsheet engine is not installed on this server, so spreadsheets (.xlsx, Autora Sheets) cannot be read or changed here (documents and presentations can).";
  }
  if (/GenOffice app not found/.test(e?.message ?? "")) {
    return `${doing} needs the page layout engine, which belongs to GenOffice's windows and is not part of these tools. A check (office_check) is what stands in for looking.`;
  }
  const hint = typeof detail.hint === "string" ? ` (${detail.hint})` : "";
  const text = e?.message ?? e?.summary ?? run.text.trim().split("\n").slice(-2).join(" ") ?? "";
  return `${doing} failed: ${text || `exit ${run.code}`}${hint}`;
}

const clip = (text: string, room: number, how: string): string =>
  text.length <= room ? text : `${text.slice(0, Math.max(0, room - 120)).trimEnd()}\n... (${(text.length - room + 120).toLocaleString("en-US")} more characters; ${how})`;

// ---------------------------------------------------------------- input --

function input(args: Record<string, any>, ctx: OfficeContext, wanted?: Kind): { file: FileInput; kind: Kind; inWindow: boolean } {
  let file = readFileRef(args.file, ctx.cwd, "document", "the Office tools");
  const kind = kindOf(file.name);
  if (!kind) throw new Problem(`${file.name} is not a document, spreadsheet or presentation file (.docx, .xlsx, .pptx). Convert it first (office_convert) if it is another format.`);
  if (wanted && kind !== wanted) throw new Problem(`${file.name} is a ${kind} file, not ${wanted}.`);
  allowed(ctx, kind);
  /* The document open in the window is the document, as the person has it now: asked for by its
     artifact, the file it came from, or its name, it is read from the window, not from an older copy. */
  const here = ctx.win?.current();
  if (here && here.kind === kind && (file.artifact?.id === here.working || file.artifact?.id === here.source || file.name === here.outName || file.name === here.name)) {
    const working = here.working ? getArtifact(here.working) : null;
    file = { data: here.data, name: here.name, artifact: working ?? file.artifact };
    return { file, kind, inWindow: true };
  }
  return { file, kind, inWindow: false };
}

/** What the person did in the window since the agent last heard, to say with a result. */
const meanwhile = (ctx: OfficeContext, _kind?: Kind): string => {
  const news = ctx.win?.news() ?? "";
  return news ? ` ${news}` : "";
};

/** Show a document in the window the agent and the person share. */
function showInWindow(ctx: OfficeContext, name: string, data: Buffer, saved: { id: string; name: string } | null, from: FileInput | null, label?: string) {
  if (!ctx.win) return;
  const here = ctx.win.current();
  ctx.win.open({
    name: here && saved && here.working === saved.id ? here.name : name,
    data,
    working: saved?.id ?? (from?.artifact?.origin === "agent" ? from.artifact.id : null),
    source: here?.source ?? (from?.artifact?.origin === "user" ? from.artifact.id : null),
    outName: saved?.name ?? name,
    ...(label ? { label } : {}),
  });
}

function sheetNeeds(kind: Kind) {
  if (kind === "xlsx" && !sidecarPath()) {
    throw new Problem("The spreadsheet engine is not installed on this server, so spreadsheets (.xlsx, Autora Sheets) cannot be read or changed here (documents and presentations can).");
  }
}

/** Write the document into a scratch folder to run the command line on. */
function stage(file: FileInput, kind: Kind, work: string): string {
  // Under its own name, so what the engine says about it reads naturally.
  const base = cleanName(file.name, `document.${kind}`);
  const p = path.join(work, new RegExp(`\\.${kind}$`, "i").test(base) ? base : `${base}.${kind}`);
  fs.writeFileSync(p, file.data);
  return p;
}

// ------------------------------------------------------------- output --

/** The name a result is saved under. The agent's own file is updated in place;
    the person's never is -- theirs gets a new name beside it. */
function outputName(file: FileInput | null, kind: Kind, output: unknown, suffix: string): string {
  const asked = String(output ?? "").trim();
  if (asked) {
    const name = cleanName(asked, `document-${suffix}.${kind}`);
    return new RegExp(`\\.${kind}$`, "i").test(name) ? name : `${name}.${kind}`;
  }
  if (file?.artifact?.origin === "agent" && kindOf(file.artifact.name) === kind) return file.artifact.name;
  const base = (file?.name ?? "document").replace(/\.(docx|xlsx|pptx)$/i, "").trim() || "document";
  return cleanName(`${base}-${suffix}.${kind}`);
}

function deliver(ctx: OfficeContext, name: string, data: Buffer, mime: string, note: string): { id: string; name: string; replaced: boolean; size: number } {
  if (data.byteLength > MAX_ARTIFACT_BYTES) {
    throw new Problem(`The result is ${formatSize(data.byteLength)}, over the ${formatSize(MAX_ARTIFACT_BYTES)} an artifact may be. Nothing was saved.`);
  }
  const replaced = listArtifacts().some((a) => a.origin === "agent" && a.name === name);
  const art = saveArtifact({ origin: "agent", name, data, mime, session: ctx.session, note });
  ctx.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
  return { id: art.id, name: art.name, replaced, size: art.size };
}

const savedLine = (s: { id: string; name: string; replaced: boolean; size: number }) =>
  `${s.replaced ? "Updated" : "Saved as"} artifact ${s.id} (${s.name}, ${formatSize(s.size)}).`;

const warningsOf = (e: Envelope | null): string =>
  (e?.warnings ?? []).map((w) => w.message).filter(Boolean).slice(0, 5).join(" ");

// ---------------------------------------------------------------- guide --

async function guideTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const domain = String(args.domain ?? "").trim().toLowerCase();
  const map: Record<string, string> = { docs: "docs", word: "docs", docx: "docs", sheets: "sheets", sheet: "sheets", excel: "sheets", xlsx: "sheets", slides: "slides", powerpoint: "slides", pptx: "slides" };
  const d = map[domain];
  if (!d) throw new Problem("domain is docs (Autora Pages), sheets (Autora Sheets) or slides (Autora Slides).");
  const topic = String(args.topic ?? "").trim();
  if (topic && !/^[\w.-]+$/.test(topic)) throw new Problem("topic is one word: an op group or an op name.");
  return await withWork(async (work) => {
    const run = await cli(["guide", d, ...(topic ? [topic] : [])], work, ctx, false);
    if (run.code !== 0 || !run.text.trim()) return { ok: false, summary: `No guide for ${d}${topic ? ` ${topic}` : ""}. ${run.text.trim().split("\n")[0] ?? ""}`.trim() };
    return {
      ok: true,
      summary: clip(run.text.trim(), ctx.room, "ask for one op group or one op by name"),
      preview: `guide ${d}${topic ? ` ${topic}` : ""}`,
    };
  });
}

// ----------------------------------------------------------------- read --

const blockLine = (b: any) => `[${b.index}] ${b.type}${b.level ? ` h${b.level}` : ""}${b.style ? ` (${b.style})` : ""}: ${b.text ?? ""}`;

function colToIndex(col: string): number {
  return [...col.toUpperCase()].reduce((n, c) => n * 26 + (c.charCodeAt(0) - 64), 0);
}
function indexToCol(i: number): string {
  let s = "";
  for (let n = i; n > 0; n = Math.floor((n - 1) / 26)) s = String.fromCharCode(65 + ((n - 1) % 26)) + s;
  return s;
}

function renderDocx(d: Record<string, any>): string {
  const out: string[] = [];
  if (Array.isArray(d.items)) out.push(...d.items.map(blockLine));
  const { items: _items, units: _units, blocks, range, ...rest } = d;
  void _items; void _units;
  if (typeof blocks === "number") out.unshift(`${blocks} blocks${range ? ` (showing ${range})` : ""}; ops target a block by its [index].`);
  for (const [k, v] of Object.entries(rest)) if (v !== undefined && v !== null && !(Array.isArray(v) && v.length === 0)) out.push(`${k}: ${JSON.stringify(v)}`);
  return out.join("\n");
}

function renderSheet(d: Record<string, any>): string {
  if (!Array.isArray(d.rows)) return JSON.stringify(d);
  const m = /^([A-Za-z]+)(\d+)/.exec(String(d.range ?? "").split("!").pop() ?? "A1");
  const col0 = m ? colToIndex(m[1]) : 1;
  const row0 = m ? Number(m[2]) : 1;
  const head = `${d.sheet ? `Sheet "${d.sheet}" ` : ""}${d.range ?? ""}${d.truncated ? " (truncated: narrow the range)" : ""}`.trim();
  const lines = d.rows.map((row: unknown[], i: number) =>
    `${row0 + i}: ` + row.map((v, j) => `${indexToCol(col0 + j)}=${v === null ? "" : typeof v === "string" ? JSON.stringify(v) : String(v)}`).filter((c) => !c.endsWith("=")).join(" | "));
  const out = [head, ...lines.filter((l: string) => !/^\d+: $/.test(l))];
  const formulas = d.formulas && Object.keys(d.formulas).length ? `formulas: ${Object.entries(d.formulas).map(([a, f]) => `${a}${f}`).join("  ")}` : "";
  if (formulas) out.push(formulas);
  const f = d.features ?? {};
  const feats = Object.entries(f).filter(([, v]) => v && !(Array.isArray(v) && v.length === 0) && v !== 0);
  if (feats.length) out.push(`features: ${JSON.stringify(Object.fromEntries(feats))}`);
  if (d.formats) out.push(`formats: ${JSON.stringify(d.formats)}`);
  return out.join("\n");
}

function renderSlides(d: Record<string, any>): string {
  const out: string[] = [];
  if (d.size) out.push(`Slide size ${d.size.inches?.width}in x ${d.size.inches?.height}in (EMU ${d.size.cx} x ${d.size.cy}).`);
  for (const page of d.pages ?? []) {
    out.push(`Slide ${page.index} (${page.id})${page.layout ? ` layout ${page.layout}` : ""}:`);
    for (const e of page.elements ?? []) {
      const b = e.box ? ` @${e.box.x},${e.box.y} ${e.box.cx}x${e.box.cy}` : "";
      const fx = e.effective ? ` ${e.effective.fontSizePt ?? ""}pt ${e.effective.fontFamily ?? ""} ${e.effective.color ?? ""}`.replace(/\s+/g, " ") : "";
      const text = e.text ? ` ${JSON.stringify(e.text)}` : "";
      out.push(`  ${e.id} ${e.type}${e.name ? ` "${e.name}"` : ""}${b}${text}${fx ? ` [${fx.trim()}]` : ""}`);
    }
    if (page.notes) out.push(`  notes: ${JSON.stringify(page.notes)}`);
  }
  if (Array.isArray(d.layouts)) out.push("Layouts:", ...d.layouts.map((l: any) => `  ${l.index} ${l.name}`));
  return out.join("\n");
}

/**
 * Where each element of a deck sits, in points from the slide's top-left, for pointing at one from a picture of the
 * slide (server/officepages.ts). The ids are the ones office_read shows and office_edit takes.
 */
export async function slideElements(data: Buffer): Promise<{ page: number; id: string; type: string; name: string; box: [number, number, number, number]; text: string }[]> {
  if (!officeDir()) return [];
  const idle = { cancelled: () => false, onCancel: () => undefined } as unknown as OfficeContext;
  return await withWork(async (work) => {
    const p = path.join(work, "in.pptx");
    fs.writeFileSync(p, data);
    const run = await cli(["slides", "read", p, "--full"], work, idle);
    if (run.env?.status !== "ok") return [];
    const out: { page: number; id: string; type: string; name: string; box: [number, number, number, number]; text: string }[] = [];
    for (const page of run.env.detail?.pages ?? []) {
      for (const e of page.elements ?? []) {
        if (!e.box || typeof e.id !== "string") continue;
        const x = Number(e.box.x) / 12700, y = Number(e.box.y) / 12700;
        out.push({
          page: Number(page.index) + 1, id: e.id, type: String(e.type ?? "element"), name: String(e.name ?? ""),
          box: [x, y, x + Number(e.box.cx) / 12700, y + Number(e.box.cy) / 12700], text: typeof e.text === "string" ? e.text : "",
        });
      }
    }
    return out;
  });
}

async function readTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const { file, kind, inWindow } = input(args, ctx);
  sheetNeeds(kind);
  if (inWindow) ctx.win?.show();
  return await withWork(async (work) => {
    const p = stage(file, kind, work);
    const a: string[] = [DOMAIN[kind], "read", p];
    if (kind === "docx") {
      if (args.range) a.push("--range", String(args.range));
      if (args.full) a.push("--full");
      for (const x of Array.isArray(args.include) ? args.include : []) {
        if (["comments", "revisions", "styles", "header-footer", "sections", "fields", "notes"].includes(String(x))) a.push(`--${x}`);
      }
    } else if (kind === "xlsx") {
      if (args.sheet) a.push("--sheet", String(args.sheet));
      if (args.range) a.push("--range", String(args.range));
      if (args.formats) a.push("--formats");
      if (args.stats) a.push("--stats");
      if (args.where) a.push("--where", String(args.where));
    } else {
      if (args.slide !== undefined && args.slide !== "") a.push("--slide", String(args.slide));
      if (args.full) a.push("--full");
      if (args.layouts) a.push("--layouts");
    }
    const run = await cli(a, work, ctx);
    if (run.env?.status !== "ok") return { ok: false, summary: failure(run, "Reading it") };
    const d = run.env.detail ?? {};
    const body = kind === "docx" ? renderDocx(d) : kind === "xlsx" ? renderSheet(d) : renderSlides(d);
    return {
      ok: true,
      summary: `${run.env.summary ?? file.name}\n${clip(body, ctx.room, "ask for a narrower range, sheet or slide")}${meanwhile(ctx, kind)}`,
      preview: `${file.name} · ${run.env.summary ?? kind}`,
    };
  });
}

// ----------------------------------------------------------------- edit --

/** More formula cells than this are left to Excel to recalculate when it opens the file. */
const REFRESH_CAP = 5000;

/**
 * Bring every formula's stored result up to date after an edit.
 *
 * The engine writes the new value of a cell it changed and the result of a
 * formula it wrote, and asks Excel to recalculate everything when the file is
 * opened -- but the formulas that depend on what changed keep their old stored
 * result until then. a spreadsheet app shows the right numbers; a viewer that does not
 * recalculate (a phone preview, a library) and this agent's own next read show
 * the old ones. Writing each formula back through the same path recalculates it
 * against the edited workbook. Best effort: a workbook it cannot do this for is
 * still a correct file.
 */
async function refreshFormulas(p: string, work: string, ctx: OfficeContext): Promise<string> {
  try {
    const first = await cli(["sheet", "read", p, "--stats"], work, ctx);
    const names: string[] = (first.env?.detail?.stats?.sheets ?? []).map((x: any) => String(x.name)).slice(0, 20);
    const cells: { cell: string; sheet: string; formula: string }[] = [];
    for (const name of names) {
      const stats = await cli(["sheet", "read", p, "--sheet", name, "--stats"], work, ctx);
      const range = String(stats.env?.detail?.stats?.usedRange ?? "");
      if (!range || !(stats.env?.detail?.stats?.formulas > 0)) continue;
      const found = await cli(["sheet", "read", p, "--sheet", name, "--where", "formula", "--range", range], work, ctx);
      for (const c of found.env?.detail?.cells ?? []) {
        if (typeof c.formula === "string" && c.formula.startsWith("=") && typeof c.ref === "string") cells.push({ cell: c.ref, sheet: name, formula: c.formula });
      }
      if (cells.length > REFRESH_CAP) return " The workbook has a lot of formulas: a spreadsheet app recalculates them when it opens the file, but until then the stored results of the ones that depend on your change may be out of date.";
    }
    if (cells.length === 0) return "";
    const file = path.join(work, "refresh.json");
    fs.writeFileSync(file, JSON.stringify(cells));
    const done = await cli(["sheet", "apply", p, "--cells", file, "--best-effort"], work, ctx);
    if (done.env?.status === "ok") return ` Recalculated ${cells.length} formula cell${cells.length === 1 ? "" : "s"}.`;
    return " The formulas that depend on your change could not be recalculated here; a spreadsheet app does it when the file is opened.";
  } catch (err) {
    if (err instanceof Problem) throw err;
    return "";
  }
}

function jsonArg(value: unknown, what: string): string {
  const v = typeof value === "string" ? (() => { try { return JSON.parse(value); } catch { throw new Problem(`${what} is not valid JSON.`); } })() : value;
  if (!Array.isArray(v) || v.length === 0) throw new Problem(`${what} is a non-empty array.`);
  return JSON.stringify(v);
}

async function editTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const { file, kind, inWindow } = input(args, ctx);
  sheetNeeds(kind);
  const dry = args.dry_run === true;
  /* The person is typing in the document: not now. Not an error -- the agent is told to work on something else. */
  if (inWindow && !dry) {
    const why = ctx.held?.("office", "document");
    if (why) return { ok: false, summary: why };
  }
  if (kind === "xlsx" && args.cells === undefined && args.ops === undefined) throw new Problem("Give cells ([{cell, value|formula, style?}]) or ops (the workbook operations office_guide describes).");
  if (kind !== "xlsx" && args.ops === undefined) throw new Problem("Give ops: the edit operations office_guide describes for this format.");
  return await withWork(async (work) => {
    const p = stage(file, kind, work);
    const opsFile = path.join(work, "ops.json");
    const a: string[] = [DOMAIN[kind], "apply", p];
    if (kind === "xlsx" && args.cells !== undefined) {
      fs.writeFileSync(opsFile, jsonArg(args.cells, "cells"));
      a.push("--cells", opsFile);
    } else {
      fs.writeFileSync(opsFile, jsonArg(args.ops, "ops"));
      a.push("--ops", opsFile);
    }
    if (dry && !(kind === "xlsx" && args.cells !== undefined)) a.push("--dry-run");
    if (args.best_effort === true) a.push("--best-effort");
    /* A document the person has open is changed as tracked changes, which they accept or reject in the
       editor's Review tab, unless the agent says otherwise. */
    const track = kind === "docx" && (args.track === true || ((inWindow || ctx.win) && args.track !== false));
    if (track) {
      a.push("--track");
      if (args.author) a.push("--author", String(args.author).slice(0, 60));
    }
    const run = await cli(a, work, ctx);
    const status = run.env?.status;
    if (status !== "ok" && status !== "partial") return { ok: false, summary: failure(run, "The edit") };
    const d = run.env?.detail ?? {};
    const failures = Array.isArray(d.failures) && d.failures.length ? `\nNot applied: ${clip(JSON.stringify(d.failures), 1500, "fix those and send only them")}` : "";
    const plan = dry && d.steps ? `\n${clip(JSON.stringify(d.steps), ctx.room - 400, "fewer ops at a time")}` : "";
    const warn = warningsOf(run.env);
    if (dry) return { ok: true, summary: `Dry run, nothing written. ${run.env?.summary ?? ""}${plan}${failures}`.trim(), preview: "dry run" };
    const refreshed = kind === "xlsx" ? await refreshFormulas(p, work, ctx) : "";
    const data = fs.readFileSync(p);
    const name = outputName(file, kind, args.output, "edited");
    const saved = deliver(ctx, name, data, MIME[kind], `${file.name} edited`);
    showInWindow(ctx, file.name, data, saved, file, "Changed by the agent");
    const there = ctx.win
      ? ` It is open in the ${WINDOW[kind]} window${track ? ", and the changes are tracked for the person to accept or reject" : kind === "docx" ? "" : " (the window reloads with the change)"}.`
      : "";
    return {
      ok: true,
      summary: `${run.env?.summary ?? "Edited."}${refreshed} ${savedLine(saved)}${there}${warn ? ` ${warn}` : ""}${failures}${meanwhile(ctx, kind)}`.trim(),
      preview: `${saved.name} edited`,
    };
  });
}

// ---------------------------------------------------------------- check --

async function checkTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const { file, kind, inWindow } = input(args, ctx);
  sheetNeeds(kind);
  if (inWindow) ctx.win?.show();
  return await withWork(async (work) => {
    const p = stage(file, kind, work);
    const a = kind === "pptx" ? ["slides", "audit", p] : [DOMAIN[kind], "check", p];
    if (kind === "pptx" && args.slide !== undefined && args.slide !== "") a.push("--slide", String(args.slide));
    const run = await cli(a, work, ctx);
    if (run.env?.status !== "ok") return { ok: false, summary: failure(run, "The check") };
    const d = run.env.detail ?? {};
    const { units: _u, metrics: _m, ids: _i, ...rest } = d;
    void _u; void _m; void _i;
    return {
      ok: true,
      summary: `${run.env.summary ?? `${file.name}: checked`}\n${clip(JSON.stringify(rest), ctx.room, "check one slide or sheet at a time")}${meanwhile(ctx, kind)}`,
      preview: `${file.name} · ${run.env.summary ?? "checked"}`,
    };
  });
}

// ----------------------------------------------------- pages and PDF --

/** The document laid out as its editor lays it out: its PDF. */
async function layOut(file: FileInput, kind: Kind, ctx: OfficeContext): Promise<Buffer> {
  const app = APP_OF[kind];
  if (!editorBuilt(app)) {
    const name = { docs: "Autora Pages", slides: "Autora Slides", sheets: "Autora Sheets" }[app];
    throw new Problem(
      `${name} is not built on this server, so pages cannot be drawn (node scripts/build-office.mjs).` +
        (kind === "pptx" ? " office_check finds overflowing or overlapping text and off-slide elements, which stands in for looking." : kind === "xlsx" ? " office_check finds broken formulas and columns too narrow for their numbers, and office_read shows the cells." : ""),
    );
  }
  return await renderToPdf(kind, file.data, file.name, ctx);
}

/** What each kind of document is called as a window. */
const WINDOW = { docx: "Autora Pages", pptx: "Autora Slides", xlsx: "Autora Sheets" } as const;

/** Pictures of the pages of a document, as its editor lays them out. */
async function lookTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const { file, kind, inWindow } = input(args, ctx);
  const pdf = await layOut(file, kind, ctx);
  // What the agent looks at, the person sees too -- unless another document is already in the window.
  if (inWindow) ctx.win?.show();
  else if (ctx.win && !ctx.win.current()) showInWindow(ctx, file.name, file.data, null, file);
  const done = await lookAtPdf(pdf, file.name, undefined, { pages: args.pages, area: args.area && typeof args.area === "object" ? args.area : null, grid: args.grid }, ctx);
  return { ok: done.ok, summary: `${done.summary}${meanwhile(ctx, kind)}`, preview: done.preview, images: done.images };
}

/** Bring a document into the window beside the conversation. */
async function openTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const { file, kind } = input(args, ctx);
  if (!ctx.win) throw new Problem("There is no window to open it in here (an incognito chat keeps none).");
  showInWindow(ctx, file.name, file.data, null, file, "Opened");
  return {
    ok: true,
    summary: `${file.name} is open in the ${WINDOW[kind]} window beside the conversation. The person can read it and ${kind === "docx" ? "type in it" : "change it"} as you work; what they change is saved as they go, and you are told what they changed.`,
    preview: `${file.name} opened`,
  };
}

/** A document as a PDF artifact, opened in the PDF editor. */
async function pdfTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const { file, kind } = input(args, ctx);
  const pdf = await layOut(file, kind, ctx);
  const asked = String(args.output ?? "").trim();
  const base = file.name.replace(/\.(docx|xlsx|pptx)$/i, "").trim() || "document";
  const name = cleanName(asked ? (/\.pdf$/i.test(asked) ? asked : `${asked}.pdf`) : `${base}.pdf`);
  const saved = deliver(ctx, name, pdf, "application/pdf", `${file.name} as a PDF`);
  // The PDF is the PDF editor's: it opens there to mark up, sign, redact or send on.
  ctx.desk?.open({ name: saved.name, base: pdf, items: [], working: saved.id, source: null, outName: saved.name });
  return {
    ok: true,
    summary: `${savedLine(saved)}${ctx.desk ? " It is open in Autora PDF." : ""}`,
    preview: saved.name,
  };
}

// --------------------------------------------------------------- create --

async function createTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const kind = String(args.type ?? "").trim().toLowerCase() as Kind;
  if (!(kind in MIME)) throw new Problem("type is docx, xlsx or pptx.");
  allowed(ctx, kind);
  if (kind === "xlsx" && !sidecarPath()) {
    // Creating works without the engine, but formulas would have no stored results.
  }
  return await withWork(async (work) => {
    const out = path.join(work, `new.${kind}`);
    const a: string[] = ["create", "--type", kind];
    if (kind === "docx") {
      const md = typeof args.markdown === "string" ? args.markdown : "";
      const html = typeof args.html === "string" ? args.html : "";
      if (!md.trim() && !html.trim()) throw new Problem("Give markdown (or restricted html) for the document's content.");
      const src = path.join(work, md.trim() ? "content.md" : "content.html");
      fs.writeFileSync(src, md.trim() ? md : html);
      a.push("--from", src);
    } else if (kind === "xlsx") {
      if (args.rows === undefined && typeof args.csv !== "string") throw new Problem("Give rows (a 2-D array, or {sheets:[{name, rows}]}; a string starting with = is a formula) or csv.");
      if (typeof args.csv === "string" && args.csv.trim()) {
        const src = path.join(work, "data.csv");
        fs.writeFileSync(src, args.csv);
        a.push("--from", src);
        if (args.header === true) a.push("--header");
      } else {
        const src = path.join(work, "data.json");
        fs.writeFileSync(src, typeof args.rows === "string" ? args.rows : JSON.stringify(args.rows));
        a.push("--from", src);
      }
    } else {
      const spec = args.spec ?? args.pages;
      if (spec === undefined && args.ops === undefined) throw new Problem("Give spec (the deck: {pages:[...]}) -- office_guide slides spec describes it -- or ops.");
      const src = path.join(work, "deck.json");
      fs.writeFileSync(src, typeof (spec ?? args.ops) === "string" ? String(spec ?? args.ops) : JSON.stringify(spec ?? args.ops));
      a.push(spec !== undefined ? "--spec" : "--ops", src);
    }
    a.push("--out", out);
    const run = await cli(a, work, ctx);
    if (run.env?.status !== "ok" || !fs.existsSync(out)) return { ok: false, summary: failure(run, "Creating it") };
    const name = outputName(null, kind, args.name, "new").replace(/-new\.(docx|xlsx|pptx)$/i, ".$1");
    const bytes = fs.readFileSync(out);
    const saved = deliver(ctx, name, bytes, MIME[kind], `Made with office_create`);
    showInWindow(ctx, saved.name, bytes, saved, null, "Created by the agent");
    const warn = warningsOf(run.env);
    const issues = Array.isArray(run.env.detail?.issues) && run.env.detail.issues.length ? ` Issues: ${clip(JSON.stringify(run.env.detail.issues), 1200, "office_check shows the rest")}` : "";
    const there = ctx.win ? ` It is open in the ${WINDOW[kind]} window.` : "";
    return { ok: true, summary: `${run.env.summary ?? "Created."} ${savedLine(saved)}${there}${warn ? ` ${warn}` : ""}${issues}`.trim(), preview: saved.name };
  });
}

// -------------------------------------------------------------- convert --

/** What can be converted without the app's page layout. */
const CONVERSIONS: Record<string, string[]> = {
  docx: ["md", "html"],
  md: ["docx", "html"],
  markdown: ["docx", "html"],
  html: ["docx"],
  htm: ["docx"],
  csv: ["xlsx"],
  xlsx: ["csv"],
};
const TO_MIME: Record<string, string> = {
  docx: MIME.docx, xlsx: MIME.xlsx, html: "text/html", md: "text/markdown", csv: "text/csv",
};

async function convertTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const file = readFileRef(args.file, ctx.cwd, "document", "the Office tools");
  if (String(args.to ?? "").trim().toLowerCase().replace(/^\./, "") === "pdf" && kindOf(file.name)) return await pdfTool(args, ctx);
  const from = path.extname(file.name).slice(1).toLowerCase();
  const to = String(args.to ?? "").trim().toLowerCase().replace(/^\./, "");
  for (const k of [from, to]) if (k in MIME && (k === "docx" || k === "xlsx" || k === "pptx")) allowed(ctx, k);
  const can = CONVERSIONS[from];
  if (!can) throw new Problem(`${file.name}: converting from .${from || "?"} is not available. From .docx: ${CONVERSIONS.docx.join(", ")}; .md: ${CONVERSIONS.md.join(", ")}; .html: docx; .csv: xlsx; .xlsx: csv. (Word to PDF is office_pdf.)`);
  if (!can.includes(to)) throw new Problem(`.${from} converts to ${can.join(" or ")}, not ${to || "(nothing named)"}.`);
  if ((from === "xlsx" || to === "xlsx") && !sidecarPath()) sheetNeeds("xlsx");
  return await withWork(async (work) => {
    const src = path.join(work, `source.${from}`);
    fs.writeFileSync(src, file.data);
    const out = path.join(work, `result.${to}`);
    const a = ["convert", src, "--to", to, "--out", out];
    if (args.sheet) a.push("--sheet", String(args.sheet));
    const run = await cli(a, work, ctx);
    if (run.env?.status !== "ok" || !fs.existsSync(out)) return { ok: false, summary: failure(run, "The conversion") };
    const base = file.name.replace(/\.[^.]+$/, "") || "document";
    const name = cleanName(String(args.output ?? "").trim() || `${base}.${to}`);
    const saved = deliver(ctx, name, fs.readFileSync(out), TO_MIME[to] ?? "application/octet-stream", `${file.name} as ${to}`);
    return { ok: true, summary: `${run.env.summary ?? "Converted."} ${savedLine(saved)}`.trim(), preview: saved.name };
  });
}
