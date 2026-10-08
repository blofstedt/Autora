/**
 * The agent's change to an Office document, in steps the editor can be shown one after another.
 *
 * The agent's tool writes the finished file at once. The person is meant to watch the agent work in the document, with
 * the typing being the change itself rather than a picture of it laid over a document that already says it. So the
 * window keeps showing the document as it was, and is handed a run of in-between files -- the same document with the
 * first words of a paragraph, then more of them, then the whole thing; a workbook with its new cells filled in one by
 * one; a deck with its new words typed into their boxes -- each a real, openable file, the last of them exactly the
 * file the tool made. Whatever the editor draws at any step is the document as it stood at that moment.
 *
 * Nothing here touches the document the agent and the server hold. A step only ever exists to be shown.
 */
import { strFromU8, strToU8, unzipSync, zipSync } from "fflate";

type StageKind = "docx" | "pptx" | "xlsx";

/** One thing typed. `step` is the first in-between file it produces, `steps` how many (one per run of words). */
export type StageCue = {
  act: "type";
  text: string;
  cell?: string;
  sheet?: string;
  step: number;
  steps: number;
  /** The words of the first step, which the editor can be searched for once that step is in. */
  lead?: string;
  /** The paragraph before, already in the document when the typing starts: where the cursor goes first. */
  near?: string;
};

export type StagePlan = {
  cues: StageCue[];
  /** Files in all: 0 is the document as it was, the last is the finished one. */
  count: number;
  /** The document at one step, as a file. Built when asked for. */
  frame(i: number): Buffer;
};

const MAX_CUES = 6;
/** Most steps one paragraph is typed in, and most in all, by app: each step is the editor drawing the document again. */
const MAX_STEPS = { docx: 14, pptx: 8, xlsx: 1 } as const;
const MAX_TOTAL = { docx: 24, pptx: 16 } as const;

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" };
const unescapeXml = (text: string) => text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, e: string) => {
  if (e[0] === "#") {
    const code = e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10);
    return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
  }
  return ENTITIES[e.toLowerCase()] ?? whole;
});
const escapeXml = (text: string) => text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
const clip = (t: string) => t.replace(/\s+/g, " ").trim().slice(0, 160);

/** The same pattern the readers in officedesk.ts use, so a paragraph here is the paragraph they count. */
const runs = (tag: "w:t" | "a:t") => new RegExp(`<${tag}(?:\\s[^>]*)?>([\\s\\S]*?)</${tag}>|<${tag.slice(0, 2)}:tab\\s*/>|<${tag.slice(0, 2)}:br\\s*/>`, "g");

/** The visible text of one paragraph's XML, as officedesk.ts reads it. */
function textOf(xml: string, tag: "w:t" | "a:t"): string {
  let text = "";
  for (const m of xml.matchAll(runs(tag))) {
    text += m[1] === undefined ? (m[0].includes(":tab") ? "\t" : "\n") : unescapeXml(m[1]);
  }
  return text;
}

/** One paragraph's XML with only its first `keep` characters of text left; the markup stays, so the shape and its styling do. */
function truncate(xml: string, tag: "w:t" | "a:t", keep: number): string {
  let left = keep;
  return xml.replace(runs(tag), (whole, inner: string | undefined) => {
    if (inner === undefined) {
      if (left <= 0) return "";
      left -= 1;
      return whole;
    }
    const text = unescapeXml(inner);
    const used = Math.max(0, Math.min(text.length, left));
    left -= used;
    return whole.replace(inner, escapeXml(text.slice(0, used)));
  });
}

/** Where, in characters, each step of typing a paragraph ends: a run of words at a time, the last at the end. */
function cuts(text: string, most: number): number[] {
  const ends: number[] = [];
  for (const m of text.matchAll(/\S+\s*/g)) ends.push((m.index ?? 0) + m[0].length);
  if (ends.length === 0) return [text.length];
  const n = Math.max(1, Math.min(most, ends.length));
  const out: number[] = [];
  for (let k = 1; k <= n; k++) out.push(ends[Math.ceil((ends.length * k) / n) - 1]);
  out[out.length - 1] = text.length;
  return out;
}

type Files = Record<string, Uint8Array>;

function open(data: Buffer): Files | null {
  try {
    return unzipSync(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
  } catch {
    return null;
  }
}

/** A file from the original's entries with some of them replaced. Pictures and fonts are stored, not squeezed again. */
function pack(files: Files, changed: Record<string, string>): Buffer {
  const input: Record<string, [Uint8Array, { level: 0 | 1 }]> = {};
  for (const [name, bytes] of Object.entries(files)) {
    input[name] = name in changed ? [strToU8(changed[name]), { level: 1 }] : [bytes, { level: /\.(xml|rels|vml)$/i.test(name) ? 1 : 0 }];
  }
  return Buffer.from(zipSync(input));
}

/** The paragraphs that differ: from the first that changed to just before the last run that did not. */
function changedRange(before: string[], after: string[]): { head: number; end: number } {
  let head = 0;
  while (head < before.length && head < after.length && before[head] === after[head]) head += 1;
  let tail = 0;
  while (tail < before.length - head && tail < after.length - head && before[before.length - 1 - tail] === after[after.length - 1 - tail]) tail += 1;
  return { head, end: after.length - tail };
}

// ------------------------------------------------------------- Pages --

function docxPlan(before: Buffer, after: Buffer): StagePlan | null {
  const files = open(after);
  const xml = files?.["word/document.xml"] ? strFromU8(files["word/document.xml"]) : null;
  const was = open(before)?.["word/document.xml"];
  if (!files || !xml || !was) return null;
  const paras = [...xml.matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => ({ at: m.index ?? 0, xml: m[0], text: textOf(m[0], "w:t") }));
  const old = [...strFromU8(was).matchAll(/<w:p[ >][\s\S]*?<\/w:p>/g)].map((m) => textOf(m[0], "w:t"));
  const { head, end } = changedRange(old, paras.map((p) => p.text));
  if (end <= head) return null;
  const span = xml.slice(paras[head].at, paras[end - 1].at + paras[end - 1].xml.length);
  // Tables, content controls and text boxes nest paragraphs inside other markup: cutting between them would leave it unbalanced.
  const inside = (tag: string) => {
    const before = xml.slice(0, paras[head].at);
    return (before.match(new RegExp(`<${tag}[ >]`, "g"))?.length ?? 0) > (before.match(new RegExp(`</${tag}>`, "g"))?.length ?? 0);
  };
  if (/<w:tbl[ >]|<\/w:tc>|<w:sdt[ >]|<w:txbxContent|<mc:AlternateContent/.test(span)) return null;
  if (["w:tc", "w:sdtContent", "w:txbxContent", "mc:Choice", "mc:Fallback"].some(inside)) return null;

  const typed: number[] = [];
  for (let i = head; i < end && typed.length < MAX_CUES; i++) if (clip(paras[i].text)) typed.push(i);
  if (typed.length === 0) return null;

  const frames: { para: number; chars: number }[] = [];
  const cues: StageCue[] = [];
  for (const i of typed) {
    const ends = cuts(paras[i].text, Math.min(MAX_STEPS.docx, Math.max(1, Math.floor(MAX_TOTAL.docx / typed.length))));
    let near = "";
    for (let b = i - 1; b >= Math.max(0, i - 4) && !near; b--) near = clip(paras[b].text);
    const lead = clip(paras[i].text.slice(0, Math.max(ends[0], Math.min(paras[i].text.length, 12))));
    cues.push({ act: "type", text: clip(paras[i].text), step: 1 + frames.length, steps: ends.length, lead, near: near || undefined });
    for (const chars of ends) frames.push({ para: i, chars });
  }
  const stop = paras[end - 1].at + paras[end - 1].xml.length;
  return {
    cues,
    count: frames.length + 2,
    frame(n) {
      if (n <= 0) return before;
      if (n > frames.length) return after;
      const { para, chars } = frames[n - 1];
      const typedXml = truncate(paras[para].xml, "w:t", chars);
      return pack(files, { "word/document.xml": xml.slice(0, paras[para].at) + typedXml + xml.slice(stop) });
    },
  };
}

// ------------------------------------------------------------ Slides --

function slideNames(files: Files): string[] {
  return Object.keys(files)
    .map((n) => /^ppt\/slides\/slide(\d+)\.xml$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[0]);
}

function pptxPlan(before: Buffer, after: Buffer): StagePlan | null {
  const files = open(after);
  const was = open(before);
  if (!files || !was) return null;
  type Para = { file: string; at: number; xml: string; text: string; seen: number };
  const gather = (f: Files) => {
    const out: Para[] = [];
    let seen = 0;
    for (const file of slideNames(f)) {
      const xml = strFromU8(f[file]);
      for (const m of xml.matchAll(/<a:p[ >][\s\S]*?<\/a:p>/g)) {
        const text = textOf(m[0], "a:t");
        out.push({ file, at: m.index ?? 0, xml: m[0], text, seen: text.trim() ? seen++ : -1 });
      }
    }
    return out;
  };
  const now = gather(files);
  const then = gather(was);
  const said = now.filter((p) => p.seen >= 0).map((p) => p.text);
  const { head, end } = changedRange(then.filter((p) => p.seen >= 0).map((p) => p.text), said);
  if (end <= head) return null;
  const typed: number[] = [];
  for (let i = head; i < end && typed.length < MAX_CUES; i++) if (clip(said[i])) typed.push(i);
  if (typed.length === 0) return null;

  const frames: { index: number; chars: number }[] = [];
  const cues: StageCue[] = [];
  for (const i of typed) {
    const ends = cuts(said[i], Math.min(MAX_STEPS.pptx, Math.max(1, Math.floor(MAX_TOTAL.pptx / typed.length))));
    cues.push({ act: "type", text: clip(said[i]), step: 1 + frames.length, steps: ends.length });
    for (const chars of ends) frames.push({ index: i, chars });
  }
  return {
    cues,
    count: frames.length + 2,
    frame(n) {
      if (n <= 0) return before;
      if (n > frames.length) return after;
      const { index, chars } = frames[n - 1];
      const changed: Record<string, string> = {};
      const byFile = new Map<string, Para[]>();
      for (const p of now) if (p.seen >= head && p.seen < end) byFile.set(p.file, [...(byFile.get(p.file) ?? []), p]);
      for (const [file, list] of byFile) {
        // From the end, so each paragraph's place in the file is still where it was found.
        let xml = strFromU8(files[file]);
        for (const p of [...list].sort((a, b) => b.at - a.at)) {
          const keep = p.seen < index ? p.text.length : p.seen === index ? chars : 0;
          if (keep >= p.text.length) continue;
          xml = xml.slice(0, p.at) + truncate(p.xml, "a:t", keep) + xml.slice(p.at + p.xml.length);
        }
        changed[file] = xml;
      }
      return pack(files, changed);
    },
  };
}

// ------------------------------------------------------------ Sheets --

const cellRef = /<c\b([^>]*?)(?:\/>|>([\s\S]*?)<\/c>)/g;

function sheetFiles(f: Files): string[] {
  return Object.keys(f)
    .map((n) => /^xl\/worksheets\/sheet(\d+)\.xml$/.exec(n))
    .filter((m): m is RegExpExecArray => m !== null)
    .sort((a, b) => Number(a[1]) - Number(b[1]))
    .map((m) => m[0]);
}

function xlsxPlan(before: Buffer, after: Buffer, then: Map<string, string>, now: Map<string, string>): StagePlan | null {
  const files = open(after);
  const book = files?.["xl/workbook.xml"] ? strFromU8(files["xl/workbook.xml"]) : null;
  if (!files || !book) return null;
  const names = [...book.matchAll(/<sheet\b[^>]*\bname="([^"]*)"/g)].map((m) => unescapeXml(m[1]));
  const sheets = sheetFiles(files);
  const changed: { key: string; sheet: string; ref: string; text: string }[] = [];
  for (const [key, value] of now) {
    if (then.get(key) === value) continue;
    const bang = key.lastIndexOf("!");
    const typed = value.startsWith("=") ? value.replace(/ \([^)]*\)$/, "") : value;
    if (!typed.trim() || bang < 1) continue;
    changed.push({ key, sheet: key.slice(0, bang), ref: key.slice(bang + 1), text: typed });
  }
  const typed = changed.slice(0, MAX_CUES);
  if (typed.length === 0) return null;
  const cues: StageCue[] = typed.map((c, i) => ({ act: "type", text: clip(c.text), cell: c.ref, sheet: c.sheet, step: 1 + i, steps: 1 }));
  return {
    cues,
    count: typed.length + 2,
    frame(n) {
      if (n <= 0) return before;
      if (n > typed.length) return after;
      // Cells not typed yet are put back as they were: their old value, or nothing.
      const pending = new Set(changed.slice(n).map((c) => c.key));
      const out: Record<string, string> = {};
      sheets.forEach((file, index) => {
        const sheet = names[index] ?? `Sheet${index + 1}`;
        let touchedAny = false;
        const xml = strFromU8(files[file]).replace(cellRef, (whole, attrs: string) => {
          const ref = /\br="([A-Z]+\d+)"/.exec(attrs)?.[1];
          if (!ref || !pending.has(`${sheet}!${ref}`)) return whole;
          touchedAny = true;
          const was = then.get(`${sheet}!${ref}`);
          const style = /\bs="(\d+)"/.exec(attrs)?.[1];
          const s = style ? ` s="${style}"` : "";
          if (was === undefined || was.startsWith("=")) return "";
          if (/^-?\d+(\.\d+)?$/.test(was)) return `<c r="${ref}"${s}><v>${was}</v></c>`;
          return `<c r="${ref}"${s} t="inlineStr"><is><t xml:space="preserve">${escapeXml(was)}</t></is></c>`;
        });
        if (touchedAny) out[file] = xml;
      });
      return pack(files, out);
    },
  };
}

/**
 * The steps from `before` to `after`, or null when this change cannot be shown in steps safely (nothing typed, a part
 * of the file this does not know how to cut, a file that does not open): the document then simply changes, as it
 * did before steps existed.
 */
export function stagePlan(
  kind: StageKind,
  before: Buffer,
  after: Buffer,
  cells?: { then: Map<string, string>; now: Map<string, string> },
): StagePlan | null {
  try {
    if (kind === "docx") return docxPlan(before, after);
    if (kind === "pptx") return pptxPlan(before, after);
    return cells ? xlsxPlan(before, after, cells.then, cells.now) : null;
  } catch {
    return null;
  }
}

/**
 * A document of this kind with nothing in it yet: what a window shows while the agent is making a new one, before its
 * first words go in. The structure (styles, slides' shapes, sheets) stays; only the words and values are taken out.
 */
export function blankOf(kind: StageKind, finished: Buffer): Buffer | null {
  try {
    const files = open(finished);
    if (!files) return null;
    if (kind === "docx") {
      const xml = files["word/document.xml"] ? strFromU8(files["word/document.xml"]) : null;
      const body = xml ? /<w:body>/.exec(xml) : null;
      if (!xml || !body) return null;
      const last = xml.lastIndexOf("<w:sectPr");
      const stop = xml.lastIndexOf("</w:body>");
      if (stop < 0) return null;
      const start = body.index + body[0].length;
      return pack(files, { "word/document.xml": `${xml.slice(0, start)}<w:p></w:p>${last >= start && last < stop ? xml.slice(last, stop) : ""}${xml.slice(stop)}` });
    }
    if (kind === "pptx") {
      const changed: Record<string, string> = {};
      for (const file of slideNames(files)) {
        changed[file] = strFromU8(files[file]).replace(/<a:p[ >][\s\S]*?<\/a:p>/g, (p) => truncate(p, "a:t", 0));
      }
      return pack(files, changed);
    }
    const changed: Record<string, string> = {};
    for (const file of sheetFiles(files)) {
      changed[file] = strFromU8(files[file]).replace(cellRef, (whole, attrs: string, inner: string | undefined) => (inner ? "" : whole));
    }
    return pack(files, changed);
  } catch {
    return null;
  }
}
