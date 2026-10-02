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
 * What it cannot do is show a page: laying a page out is the app's renderer's
 * job, not the engines', so there is no picture of a slide or a page here.
 * What stands in for looking is the check each format has (`office_check`):
 * overflow, overlap and off-slide on a deck, broken references on a workbook,
 * stale fields and placeholder text in a document.
 *
 * Nothing here is required to run Autora. Without the build the tools are not
 * offered (see officeDir), and without the spreadsheet engine only the Excel
 * ones say so.
 */

import { spawn } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_ARTIFACT_BYTES, cleanName, formatSize, listArtifacts, saveArtifact } from "./artifacts";
import type { ChatImage } from "./llm";
import { FileRefError, readFileRef, type FileInput } from "./fileref";
import { lookAtPdf, type DeskHooks } from "./pdf";
import { OfficeRenderError, editorBuilt, renderDocxToPdf } from "./officerender";
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

export async function runOfficeTool(name: string, args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  try {
    if (!officeDir()) {
      return { ok: false, summary: "The Office tools are not installed on this server (they are built into dist/office by `node scripts/build-office.mjs`)." };
    }
    switch (name) {
      case "office_guide": return await guideTool(args, ctx);
      case "office_read": return await readTool(args, ctx);
      case "office_edit": return await editTool(args, ctx);
      case "office_check": return await checkTool(args, ctx);
      case "office_look": return await lookTool(args, ctx);
      case "office_pdf": return await pdfTool(args, ctx);
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

/** Run the command line with these arguments. */
async function cli(args: string[], work: string, ctx: OfficeContext, json = true): Promise<Run> {
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
    return "The spreadsheet engine is not installed on this server, so Excel files cannot be read or changed here (Word and PowerPoint can).";
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

function input(args: Record<string, any>, ctx: OfficeContext, wanted?: Kind): { file: FileInput; kind: Kind } {
  const file = readFileRef(args.file, ctx.cwd, "document", "the Office tools");
  const kind = kindOf(file.name);
  if (!kind) throw new Problem(`${file.name} is not a Word, Excel or PowerPoint file (.docx, .xlsx, .pptx). Convert it first (office_convert) if it is another format.`);
  if (wanted && kind !== wanted) throw new Problem(`${file.name} is a ${kind} file, not ${wanted}.`);
  return { file, kind };
}

function sheetNeeds(kind: Kind) {
  if (kind === "xlsx" && !sidecarPath()) {
    throw new Problem("The spreadsheet engine is not installed on this server, so Excel files cannot be read or changed here (Word and PowerPoint can).");
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
  if (!d) throw new Problem("domain is docs (Word), sheets (Excel) or slides (PowerPoint).");
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

async function readTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const { file, kind } = input(args, ctx);
  sheetNeeds(kind);
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
      summary: `${run.env.summary ?? file.name}\n${clip(body, ctx.room, "ask for a narrower range, sheet or slide")}`,
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
 * result until then. Excel shows the right numbers; a viewer that does not
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
      if (cells.length > REFRESH_CAP) return " The workbook has a lot of formulas: Excel recalculates them when it opens the file, but until then the stored results of the ones that depend on your change may be out of date.";
    }
    if (cells.length === 0) return "";
    const file = path.join(work, "refresh.json");
    fs.writeFileSync(file, JSON.stringify(cells));
    const done = await cli(["sheet", "apply", p, "--cells", file, "--best-effort"], work, ctx);
    if (done.env?.status === "ok") return ` Recalculated ${cells.length} formula cell${cells.length === 1 ? "" : "s"}.`;
    return " The formulas that depend on your change could not be recalculated here; Excel does it when the file is opened.";
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
  const { file, kind } = input(args, ctx);
  sheetNeeds(kind);
  const dry = args.dry_run === true;
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
    if (kind === "docx" && args.track === true) {
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
    return {
      ok: true,
      summary: `${run.env?.summary ?? "Edited."}${refreshed} ${savedLine(saved)}${warn ? ` ${warn}` : ""}${failures}`.trim(),
      preview: `${saved.name} edited`,
    };
  });
}

// ---------------------------------------------------------------- check --

async function checkTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const { file, kind } = input(args, ctx);
  sheetNeeds(kind);
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
      summary: `${run.env.summary ?? `${file.name}: checked`}\n${clip(JSON.stringify(rest), ctx.room, "check one slide or sheet at a time")}`,
      preview: `${file.name} · ${run.env.summary ?? "checked"}`,
    };
  });
}

// ----------------------------------------------------- pages and PDF --

/** The document laid out as the editor lays it out: its PDF. Only Word so far. */
async function layOut(file: FileInput, kind: Kind, ctx: OfficeContext): Promise<Buffer> {
  if (kind !== "docx") {
    throw new Problem(
      kind === "pptx"
        ? "A deck cannot be drawn yet (only Word documents can). office_check finds overflowing or overlapping text and off-slide elements, which is what stands in for looking."
        : "A workbook cannot be drawn yet (only Word documents can). office_check finds broken formulas, missing references and columns too narrow for their numbers, and office_read shows the cells.",
    );
  }
  if (!editorBuilt("docs")) throw new Problem("The Word editor is not built on this server, so pages cannot be drawn (node scripts/build-office.mjs).");
  return await renderDocxToPdf(file.data, file.name, ctx);
}

/** Pictures of the pages of a Word document, as they lay out. */
async function lookTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const { file, kind } = input(args, ctx);
  const pdf = await layOut(file, kind, ctx);
  const done = await lookAtPdf(pdf, file.name, undefined, { pages: args.pages, area: args.area && typeof args.area === "object" ? args.area : null, grid: args.grid }, ctx);
  return { ok: done.ok, summary: done.summary, preview: done.preview, images: done.images };
}

/** A Word document as a PDF artifact, opened in the PDF editor. */
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
    summary: `${savedLine(saved)}${ctx.desk ? " It is open in the PDF editor." : ""}`,
    preview: saved.name,
  };
}

// --------------------------------------------------------------- create --

async function createTool(args: Record<string, any>, ctx: OfficeContext): Promise<OfficeOutcome> {
  const kind = String(args.type ?? "").trim().toLowerCase() as Kind;
  if (!(kind in MIME)) throw new Problem("type is docx, xlsx or pptx.");
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
    const saved = deliver(ctx, name, fs.readFileSync(out), MIME[kind], `Made with office_create`);
    const warn = warningsOf(run.env);
    const issues = Array.isArray(run.env.detail?.issues) && run.env.detail.issues.length ? ` Issues: ${clip(JSON.stringify(run.env.detail.issues), 1200, "office_check shows the rest")}` : "";
    return { ok: true, summary: `${run.env.summary ?? "Created."} ${savedLine(saved)}${warn ? ` ${warn}` : ""}${issues}`.trim(), preview: saved.name };
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
