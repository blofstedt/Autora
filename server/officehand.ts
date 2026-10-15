/**
 * The agent's hand in the Pages, Sheets and Slides windows (Visible work: docs/VISIBLE-WORK.md).
 *
 * With Visible work on and the document open in its window, the agent's `office_edit` is typed into the editor as it
 * is made, live, the way a person types it: what the operations change in the words -- a paragraph's text, a new or
 * removed paragraph, a cell's value or formula, the text in a slide's box -- is handed to the window, and the hand in
 * the editor (office/shim/hand.js) does it there with the editor's own selection and typing: the words that change are
 * selected and typed over, a cell is gone to with the name box and typed into and confirmed with the formula bar's
 * tick, a slide's box is opened and typed into. The tool call waits for all of it.
 *
 * The finished file is still the one GenOffice's command line made from the operations: once the hand is done it is
 * put in the window (`showInWindow` in office.ts), so the document is exactly what the operations made -- what was not
 * typing (styles, tables, pictures, charts, a new slide) appears then, and the result says what was typed by hand.
 *
 * No window claims it within a few seconds (none open, or nobody has the page) -> nobody is watching, and the edit
 * simply appears, as with Visible work off.
 */
import crypto from "node:crypto";
import express, { type Express, type Request, type Response } from "express";
import { unzipSync, strFromU8 } from "fflate";
import { docxParagraphs, handing, officeState } from "./officedesk";

type Kind = "docx" | "xlsx" | "pptx";

/** One thing the hand types. Indices and ids are the document's as it was before the edit. */
export type HandStep =
  | { kind: "para"; at: number; was: string; now: string }
  | { kind: "insert"; after: number; anchor: string; text: string }
  | { kind: "remove"; at: number; was: string }
  | { kind: "cell"; sheet: string; ref: string; input: string; was: string }
  | { kind: "box"; slide: number; id: string; name: string; box: [number, number, number, number]; size: [number, number]; was: string; now: string };

export type HandResult = { i: number; ok: boolean; error?: string };
export type HandReply = { results: HandResult[]; error?: string };

/** The most the hand types in one call: past this, the rest of the change simply appears. */
const MAX_STEPS = 40;

// ------------------------------------------------------------------ steps --

/** Paragraph changes as a person would make them: the longest run kept, the rest edited, added or removed. */
function docxSteps(before: Buffer, after: Buffer): HandStep[] {
  const a = docxParagraphs(before);
  const b = docxParagraphs(after);
  if (!a || !b || a.length > 3000 || b.length > 3000) return [];
  // Longest common subsequence of identical paragraphs.
  const n = a.length, m = b.length;
  const lcs: Uint16Array[] = Array.from({ length: n + 1 }, () => new Uint16Array(m + 1));
  for (let i = n - 1; i >= 0; i--) for (let j = m - 1; j >= 0; j--) lcs[i][j] = a[i] === b[j] ? lcs[i + 1][j + 1] + 1 : Math.max(lcs[i + 1][j], lcs[i][j + 1]);
  const steps: HandStep[] = [];
  let i = 0, j = 0;
  /** The last paragraph of the old document that is still in place: what a new one is typed after. */
  let anchor = -1;
  while (i < n || j < m) {
    if (i < n && j < m && a[i] === b[j]) { anchor = i; i++; j++; continue; }
    // A changed paragraph: one gone and one come in the same place, both with words.
    if (i < n && j < m && lcs[i + 1][j + 1] === lcs[i][j] && a[i].trim() && b[j].trim()) {
      steps.push({ kind: "para", at: i, was: a[i], now: b[j] });
      anchor = i; i++; j++;
      continue;
    }
    if (j < m && (i >= n || lcs[i][j + 1] >= lcs[i + 1][j])) {
      steps.push({ kind: "insert", after: anchor, anchor: anchor >= 0 ? a[anchor] : "", text: b[j] });
      j++;
      continue;
    }
    steps.push({ kind: "remove", at: i, was: a[i] });
    i++;
  }
  // An empty paragraph added or taken away is layout, not typing.
  return steps.filter((s) => (s.kind === "insert" ? s.text.trim() !== "" : s.kind === "remove" ? s.was.trim() !== "" : true));
}

const ENT: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unxml = (t: string) => t.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (w, e: string) =>
  e[0] === "#" ? String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10)) : ENT[e.toLowerCase()] ?? w);

/** Each filled cell: what a person types to get it (its formula, or its value). */
function cellsOf(data: Buffer): Map<string, { sheet: string; ref: string; input: string }> | null {
  try {
    const zip = unzipSync(new Uint8Array(data), { filter: (f) => /^xl\/(workbook|sharedStrings)\.xml$|^xl\/worksheets\/sheet\d+\.xml$/.test(f.name) });
    const book = zip["xl/workbook.xml"] ? strFromU8(zip["xl/workbook.xml"]) : "";
    const names = [...book.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unxml(m[1]));
    const shared: string[] = [];
    const sst = zip["xl/sharedStrings.xml"] ? strFromU8(zip["xl/sharedStrings.xml"]) : "";
    for (const si of sst.matchAll(/<si>([\s\S]*?)<\/si>/g)) shared.push(unxml([...si[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join("")));
    const out = new Map<string, { sheet: string; ref: string; input: string }>();
    const sheets = Object.keys(zip).map((k) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(k)).filter((m): m is RegExpExecArray => !!m).sort((x, y) => Number(x[1]) - Number(y[1]));
    sheets.forEach((s, index) => {
      const xml = strFromU8(zip[s[0]]);
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
        else if (type === "inlineStr" && inline) value = unxml([...inline[1].matchAll(/<t(?:\s[^>]*)?>([\s\S]*?)<\/t>/g)].map((t) => t[1]).join(""));
        else if (type === "b" && v !== undefined) value = v === "1" ? "TRUE" : "FALSE";
        else if (v !== undefined) value = unxml(v);
        const input = f ? `=${unxml(f)}` : value;
        if (input === "") continue;
        out.set(`${sheet}!${ref}`, { sheet, ref, input });
      }
    });
    return out;
  } catch {
    return null;
  }
}

function xlsxSteps(before: Buffer, after: Buffer): HandStep[] {
  const a = cellsOf(before);
  const b = cellsOf(after);
  if (!a || !b) return [];
  const steps: HandStep[] = [];
  for (const [key, cell] of b) {
    const was = a.get(key)?.input ?? "";
    if (was !== cell.input) steps.push({ kind: "cell", sheet: cell.sheet, ref: cell.ref, input: cell.input, was });
  }
  for (const [key, cell] of a) if (!b.has(key)) steps.push({ kind: "cell", sheet: cell.sheet, ref: cell.ref, input: "", was: cell.input });
  // In reading order on each sheet, as a person fills a sheet in.
  const order = (ref: string) => { const m = /^([A-Z]+)(\d+)$/.exec(ref)!; let col = 0; for (const ch of m[1]) col = col * 26 + ch.charCodeAt(0) - 64; return Number(m[2]) * 20000 + col; };
  return steps.sort((x, y) => (x.kind === "cell" && y.kind === "cell" ? (x.sheet === y.sheet ? order(x.ref) - order(y.ref) : 0) : 0));
}

function slideSize(data: Buffer): [number, number] {
  try {
    const zip = unzipSync(new Uint8Array(data), { filter: (f) => f.name === "ppt/presentation.xml" });
    const xml = zip["ppt/presentation.xml"] ? strFromU8(zip["ppt/presentation.xml"]) : "";
    const m = /<p:sldSz\b[^>]*\bcx="(\d+)"[^>]*\bcy="(\d+)"/.exec(xml);
    if (m) return [Number(m[1]) / 12700, Number(m[2]) / 12700];
  } catch { /* the default size */ }
  return [960, 540];
}

async function pptxSteps(before: Buffer, after: Buffer): Promise<HandStep[]> {
  const { slideElements } = await import("./office");
  const [a, b] = await Promise.all([slideElements(before), slideElements(after)]);
  const was = new Map(a.map((e) => [`${e.page}:${e.id}`, e]));
  const size = slideSize(before);
  const steps: HandStep[] = [];
  for (const e of b) {
    const old = was.get(`${e.page}:${e.id}`);
    // Only words in a box that was already there: a new box is a shape to draw, not typing.
    if (!old || old.text === e.text || !old.text.trim() && !e.text.trim()) continue;
    steps.push({ kind: "box", slide: e.page, id: e.id, name: e.name, box: old.box, size, was: old.text, now: e.text });
  }
  return steps;
}

/** What of a change the hand can type, in the order a person would type it. */
export async function handSteps(kind: Kind, before: Buffer, after: Buffer): Promise<HandStep[]> {
  const steps = kind === "docx" ? docxSteps(before, after) : kind === "xlsx" ? xlsxSteps(before, after) : await pptxSteps(before, after);
  return steps.slice(0, MAX_STEPS);
}

/** One step in a few words, for the result. */
export function stepWords(step: HandStep): string {
  const short = (t: string) => (t.length > 40 ? `${t.slice(0, 40)}…` : t);
  switch (step.kind) {
    case "para": return `paragraph ${step.at + 1} retyped`;
    case "insert": return `"${short(step.text)}" typed in a new paragraph`;
    case "remove": return `paragraph ${step.at + 1} deleted`;
    case "cell": return step.input ? `${step.sheet}!${step.ref} = ${short(step.input)}` : `${step.sheet}!${step.ref} cleared`;
    case "box": return `slide ${step.slide} ${step.name || step.id} retyped`;
  }
}

// --------------------------------------------------------------- the wire --

let pushed: (session: string, message: Record<string, unknown>) => void = () => undefined;
let visible: () => boolean = () => false;

type Pending = { session: string; kind: Kind; claimed: boolean; resolve: (r: HandReply) => void };
const pending = new Map<string, Pending>();

const CLAIM_MS = 4_000;
/** A person's pace: time to find each place and type it, and for the editor to start if it is starting. */
const handTime = (steps: number) => 60_000 + steps * 25_000;
const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** The steps, typed in the window by the agent's hand; null when no window took them (nobody is watching). */
export async function handToWindow(session: string, kind: Kind, steps: HandStep[]): Promise<HandReply | null> {
  if (!visible() || steps.length === 0) return null;
  const open = (officeState(session).windows as Array<{ kind: string; open?: boolean }>).some((w) => w.kind === kind && w.open);
  if (!open) return null;
  const id = crypto.randomBytes(6).toString("hex");
  let settle: (r: HandReply) => void = () => undefined;
  const answered = new Promise<HandReply>((resolve) => { settle = resolve; });
  const entry: Pending = { session, kind, claimed: false, resolve: (r) => settle(r) };
  pending.set(id, entry);
  const message = { type: "officedesk.hand", session, id, kind, steps };
  // While the hand types, what the editor saves is its typing, not the person's work: the desk does not take it.
  const quiet = handing(session, kind);
  try {
    for (let waited = 0; !entry.claimed && waited < CLAIM_MS; waited += 1_000) {
      pushed(session, message);
      await sleep(1_000);
    }
    if (!entry.claimed) return null;
    return await Promise.race([
      answered,
      sleep(handTime(steps.length)).then((): HandReply => ({ results: [], error: "the window took too long" })),
    ]);
  } finally {
    quiet.end();
    pending.delete(id);
  }
}

export function officeHandRoutes(app: Express, opts: {
  exists: (session: string) => boolean;
  push: (session: string, message: Record<string, unknown>) => void;
  visible: () => boolean;
}): void {
  pushed = opts.push;
  visible = opts.visible;
  const known = (req: Request, res: Response): string | null => {
    const id = String(req.params.session);
    if (!/^[A-Za-z0-9_-]{1,80}$/.test(id) || !opts.exists(id)) {
      res.status(404).json({ error: "No such session." });
      return null;
    }
    return id;
  };

  app.post("/api/officedesk/:session/hand/claim", (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const p = pending.get(String(req.query.id ?? ""));
    const won = Boolean(p && p.session === id && !p.claimed);
    if (won && p) p.claimed = true;
    res.json({ won });
  });

  app.post("/api/officedesk/:session/hand/reply", express.json({ limit: "256kb" }), (req, res) => {
    const id = known(req, res);
    if (!id) return;
    const p = pending.get(String(req.query.id ?? ""));
    if (!p || p.session !== id || !p.claimed) return res.status(404).json({ error: "No such edit." });
    const body = (req.body ?? {}) as { results?: unknown; error?: unknown };
    const results = (Array.isArray(body.results) ? body.results : []).slice(0, 200).map((r: any): HandResult => ({
      i: Number(r?.i) || 0,
      ok: r?.ok === true,
      ...(typeof r?.error === "string" ? { error: r.error.slice(0, 300) } : {}),
    }));
    p.resolve({ results, ...(typeof body.error === "string" ? { error: body.error.slice(0, 300) } : {}) });
    res.json({ ok: true });
  });
}
