/**
 * Composing a PDF from a description of the document.
 *
 * The other PDF tools change a file that exists, with items placed at
 * coordinates. This one makes the file: the agent writes headings,
 * paragraphs, lists, tables and pictures, and the layout (wrapping, page
 * breaks, numbering, a list of sources) is done here. Because the document is
 * kept as that description, new findings mean changing one section and laying
 * the whole thing out again, not working out where every line now sits.
 *
 * Pure: it knows nothing of artifacts, the PDF window or the session. The
 * caller says how to load a picture and gets back a document to save, an
 * outline (which block starts on which page) and what had to be changed to
 * fit the built-in fonts.
 */

import {
  PDFDocument, PDFString, rgb, StandardFonts, type PDFFont, type PDFPage, type RGB,
} from "@cantoo/pdf-lib";

/** A fault in what was asked; the message is said to the agent as it stands. */
export class ComposeError extends Error {}

// ----------------------------------------------------------------- types --

export type Block = {
  /** Names the block for later changes; one is made up when it is left out. */
  id?: string;
  type: string;
  text?: string;
  level?: number;
  items?: Array<string | { text: string; source?: string | string[] }>;
  ordered?: boolean;
  header?: string[];
  rows?: string[][];
  widths?: number[];
  align?: string[];
  image?: string;
  width?: number;
  caption?: string;
  /** Where this came from: a URL or a note. Cited as [n] and listed at the end. */
  source?: string | string[];
};

export type ComposeSource = {
  title?: string;
  subtitle?: string;
  author?: string;
  date?: string;
  paper?: "a4" | "letter";
  landscape?: boolean;
  font?: "helvetica" | "times";
  /** Body text size in points. */
  size?: number;
  /** Page margin in points. */
  margin?: number;
  /** Format with {n} and {total}, or false for none. */
  page_numbers?: string | false;
  /** The title of the list of sources at the end, or false to leave it out. */
  sources_heading?: string | false;
  blocks: Block[];
};

export type OutlineEntry = {
  id: string;
  type: string;
  /** The heading, or the first words of the block. */
  label: string;
  level?: number;
  page: number;
  endPage: number;
};

export type Composed = {
  doc: PDFDocument;
  source: ComposeSource;
  pages: number;
  outline: OutlineEntry[];
  /** What was changed or left out to fit, for the agent to know. */
  notes: string[];
};

export type ImageLoader = (ref: string) => Promise<{ data: Buffer; kind: "png" | "jpg" }>;

export const BLOCK_TYPES = ["heading", "paragraph", "bullets", "table", "quote", "code", "image", "rule", "page_break"];
const MAX_BLOCKS = 600;
const MAX_PAGES = 200;

// --------------------------------------------------------------- changes --

const DOC_KEYS = ["title", "subtitle", "author", "date", "paper", "landscape", "font", "size", "margin", "page_numbers", "sources_heading"] as const;

const isObject = (v: unknown): v is Record<string, any> => Boolean(v) && typeof v === "object" && !Array.isArray(v);

/** A block as given, with the fields it may carry and an id. */
function cleanBlock(raw: unknown, where: string): Block {
  if (!isObject(raw)) throw new ComposeError(`${where} is not a block: give an object with a type (${BLOCK_TYPES.join(", ")}).`);
  const type = String(raw.type ?? "").trim().toLowerCase();
  if (!BLOCK_TYPES.includes(type)) {
    throw new ComposeError(`${where} has type ${JSON.stringify(raw.type ?? null)}: the types are ${BLOCK_TYPES.join(", ")}.`);
  }
  const block: Block = { ...(raw as Block), type };
  if (block.id !== undefined) {
    block.id = String(block.id).trim();
    if (!/^[\w.-]{1,40}$/.test(block.id)) throw new ComposeError(`${where}: an id is letters, digits, "_", "-" or "." up to 40 long.`);
  }
  return block;
}

/** Ids for blocks that came without, never one already used. */
function withIds(blocks: Block[]): Block[] {
  const used = new Set(blocks.map((b) => b.id).filter(Boolean) as string[]);
  const seen = new Set<string>();
  let n = 0;
  return blocks.map((b) => {
    let id = b.id;
    if (id && seen.has(id)) throw new ComposeError(`Two blocks are called ${JSON.stringify(id)}: ids are one to a block.`);
    if (!id) {
      do id = `b${++n}`; while (used.has(id));
      used.add(id);
    }
    seen.add(id);
    return { ...b, id };
  });
}

function asList<T>(value: T | T[] | undefined | null): T[] {
  return value === undefined || value === null ? [] : Array.isArray(value) ? value : [value];
}

/**
 * The document after what the agent asked for: all of it again (blocks), or
 * changes to the one it already has (update, remove, insert), with the
 * document-level settings applied over either.
 */
export function applyChanges(previous: ComposeSource | null, args: Record<string, any>): ComposeSource {
  const full = Array.isArray(args.blocks);
  const edits = ["update", "remove", "insert"].some((k) => args[k] !== undefined);
  let doc: ComposeSource;
  if (full) {
    doc = { ...(previous ? { ...previous } : {}), blocks: args.blocks.map((b: unknown, i: number) => cleanBlock(b, `Block ${i + 1}`)) };
  } else {
    if (!previous) {
      throw new ComposeError("There is no composed document yet to change: give blocks (the whole document) first. update, insert and remove change the one pdf_compose made last.");
    }
    doc = { ...previous, blocks: previous.blocks.map((b) => ({ ...b })) };
  }

  if (!full) {
    const find = (id: unknown, what: string) => {
      const at = doc.blocks.findIndex((b) => b.id === String(id));
      if (at < 0) {
        const have = doc.blocks.map((b) => b.id).slice(0, 40).join(", ");
        throw new ComposeError(`${what}: there is no block ${JSON.stringify(String(id))}. The ids are ${have}.`);
      }
      return at;
    };
    for (const u of asList<unknown>(args.update)) {
      if (!isObject(u) || u.id === undefined) throw new ComposeError("update takes objects with the id of the block and the fields to change.");
      const at = find(u.id, "update");
      const { id: _id, ...rest } = u;
      doc.blocks[at] = cleanBlock({ ...doc.blocks[at], ...rest, id: doc.blocks[at].id }, `Block ${JSON.stringify(String(u.id))}`);
    }
    const drop = new Set(asList<unknown>(args.remove).map(String));
    for (const id of drop) find(id, "remove");
    doc.blocks = doc.blocks.filter((b) => !drop.has(b.id as string));
    for (const ins of asList<unknown>(args.insert)) {
      if (!isObject(ins)) throw new ComposeError('insert takes objects like {"after": "<block id>", "blocks": [...]}; after may also be "start" or "end".');
      const added = asList<unknown>(ins.blocks ?? ins.block).map((b, i) => cleanBlock(b, `Inserted block ${i + 1}`));
      if (!added.length) throw new ComposeError("insert needs blocks to put in.");
      const after = String(ins.after ?? "end");
      const at = after === "end" ? doc.blocks.length : after === "start" ? 0 : find(after, "insert") + 1;
      doc.blocks.splice(at, 0, ...added);
    }
  } else if (edits) {
    throw new ComposeError("Give blocks (the whole document) or update / insert / remove (changes to it), not both.");
  }

  for (const key of DOC_KEYS) {
    if (args[key] !== undefined) (doc as Record<string, unknown>)[key] = args[key];
  }
  if (doc.blocks.length > MAX_BLOCKS) throw new ComposeError(`That is ${doc.blocks.length} blocks; a document may have up to ${MAX_BLOCKS}.`);
  doc.blocks = withIds(doc.blocks);
  if (!doc.blocks.length && !doc.title) throw new ComposeError("The document is empty: give it blocks or a title.");
  return doc;
}

// ---------------------------------------------------------------- text --

/** Characters people write that the built-in fonts lack, and what to write instead. */
const SUBSTITUTES: Record<string, string> = {
  "→": "->", "←": "<-", "⇒": "=>", "↔": "<->", "≥": ">=", "≤": "<=", "≈": "~", "≠": "!=",
  "−": "-", "‑": "-", "‐": "-", " ": " ", " ": " ", " ": " ", " ": " ", " ": " ",
  " ": " ", "​": "", "‍": "", "﻿": "", "✓": "v", "✔": "v", "✗": "x", "✘": "x",
  "★": "*", "●": "•", "▪": "•", "◦": "o", "‣": "•", "·": "·", "′": "'",
  "″": "\"", "μ": "u", "≤️": "<=", "×": "×", "✓️": "v", "✅": "v", "❌": "x",
};

class Cleaner {
  readonly replaced = new Map<string, number>();
  private readonly known: Set<number>;
  constructor(font: PDFFont) {
    this.known = new Set(font.getCharacterSet());
  }
  text(input: string): string {
    let out = "";
    for (const ch of input.replace(/\t/g, "    ").replace(/\r\n?/g, "\n")) {
      const code = ch.codePointAt(0) ?? 0;
      if (ch === "\n" || this.known.has(code)) {
        out += ch;
        continue;
      }
      const sub = SUBSTITUTES[ch];
      if (sub !== undefined && [...sub].every((c) => this.known.has(c.codePointAt(0) ?? 0))) {
        out += sub;
        continue;
      }
      if (code >= 0x300 && code <= 0x36f) continue; // a combining mark: keep the letter
      if (code === 0xfe0f) continue;
      this.replaced.set(ch, (this.replaced.get(ch) ?? 0) + 1);
      out += "?";
    }
    return out;
  }
}

// ---------------------------------------------------------------- inline --

type Face = { bold?: boolean; italic?: boolean; code?: boolean };
type Span = Face & { text: string; link?: string; color?: RGB; scale?: number };

const INLINE = /(\*\*[^*\n]+?\*\*|\*[^*\s][^*\n]*?\*|`[^`\n]+`|\[[^\]\n]+\]\(https?:\/\/[^\s)]+\))/g;

/** **bold**, *italic*, `code` and [text](https://link) within a run of text. */
function parseInline(text: string, base: Face): Span[] {
  const out: Span[] = [];
  let last = 0;
  for (const m of text.matchAll(INLINE)) {
    const at = m.index ?? 0;
    if (at > last) out.push({ ...base, text: text.slice(last, at) });
    const token = m[0];
    if (token.startsWith("**")) out.push({ ...base, bold: true, text: token.slice(2, -2) });
    else if (token.startsWith("`")) out.push({ ...base, code: true, text: token.slice(1, -1) });
    else if (token.startsWith("[")) {
      const split = token.lastIndexOf("](");
      out.push({ ...base, text: token.slice(1, split), link: token.slice(split + 2, -1), color: LINK });
    } else out.push({ ...base, italic: true, text: token.slice(1, -1) });
    last = at + token.length;
  }
  if (last < text.length) out.push({ ...base, text: text.slice(last) });
  return out;
}

const INK = rgb(0.1, 0.1, 0.12);
const MUTED = rgb(0.4, 0.42, 0.46);
const LINK = rgb(0.1, 0.3, 0.7);
const FAINT = rgb(0.82, 0.84, 0.88);
const SHADE = rgb(0.965, 0.97, 0.98);
const HEAD = rgb(0.92, 0.94, 0.97);

type Atom = { text: string; font: PDFFont; size: number; width: number; color: RGB; link?: string; space?: boolean; br?: boolean };
type Line = { atoms: Atom[]; width: number; size: number };

// ---------------------------------------------------------------- layout --

const PAPER = { a4: [595.28, 841.89], letter: [612, 792] } as const;
const LEADING = 1.38;

type Fonts = {
  at(face: Face, family: "helvetica" | "times"): PDFFont;
};

class Layout {
  readonly pages: PDFPage[] = [];
  readonly sources: string[] = [];
  readonly outline: OutlineEntry[] = [];
  readonly width: number;
  readonly height: number;
  readonly left: number;
  readonly right: number;
  readonly top: number;
  readonly bottom: number;
  readonly size: number;
  readonly family: "helvetica" | "times";
  y = 0;
  private current: OutlineEntry | null = null;
  private readonly fontCache = new Map<string, PDFFont>();
  readonly clean: Cleaner;

  constructor(readonly doc: PDFDocument, readonly src: ComposeSource, private readonly fonts: Fonts, clean: Cleaner) {
    const [w, h] = PAPER[src.paper === "letter" ? "letter" : "a4"];
    this.width = src.landscape ? h : w;
    this.height = src.landscape ? w : h;
    const margin = clampNum(src.margin, 28, 120, 56);
    this.left = margin;
    this.right = this.width - margin;
    this.top = this.height - margin;
    this.bottom = margin + (src.page_numbers === false ? 0 : 6);
    this.size = clampNum(src.size, 8, 16, 11);
    this.family = src.font === "times" ? "times" : "helvetica";
    this.clean = clean;
  }

  get content(): number {
    return this.right - this.left;
  }

  get atTop(): boolean {
    return this.pages.length === 0 || this.y >= this.top - 0.5;
  }

  font(face: Face): PDFFont {
    const key = `${face.code ? "c" : this.family}${face.bold ? "b" : ""}${face.italic ? "i" : ""}`;
    let font = this.fontCache.get(key);
    if (!font) {
      font = face.code
        ? this.doc.embedStandardFont(face.bold ? StandardFonts.CourierBold : face.italic ? StandardFonts.CourierOblique : StandardFonts.Courier)
        : this.fonts.at(face, this.family);
      this.fontCache.set(key, font);
    }
    return font;
  }

  newPage() {
    if (this.pages.length >= MAX_PAGES) throw new ComposeError(`The document is over ${MAX_PAGES} pages; shorten it or split it in two.`);
    this.pages.push(this.doc.addPage([this.width, this.height]));
    this.y = this.top;
  }

  /** Start a new page unless `h` more points fit on this one. */
  need(h: number) {
    if (this.pages.length === 0) this.newPage();
    if (this.y - h < this.bottom && !this.atTop) this.newPage();
  }

  get page(): PDFPage {
    if (this.pages.length === 0) this.newPage();
    return this.pages[this.pages.length - 1];
  }

  /** What the block being laid out has put on which page. */
  begin(entry: Omit<OutlineEntry, "page" | "endPage">) {
    this.current = { ...entry, page: 0, endPage: 0 };
    this.outline.push(this.current);
  }

  touch() {
    if (!this.current) return;
    const p = Math.max(1, this.pages.length);
    if (this.current.page === 0) this.current.page = p;
    this.current.endPage = p;
  }

  cite(source: string | string[] | undefined): string {
    const marks: number[] = [];
    for (const s of asList(source)) {
      const text = String(s ?? "").trim();
      if (!text) continue;
      let at = this.sources.indexOf(text);
      if (at < 0) at = this.sources.push(text) - 1;
      if (!marks.includes(at + 1)) marks.push(at + 1);
    }
    return marks.length ? `[${marks.join(", ")}]` : "";
  }

  // -- text --

  atoms(spans: Span[], size: number, color: RGB): Atom[] {
    const out: Atom[] = [];
    for (const span of spans) {
      const font = this.font(span);
      const s = size * (span.scale ?? (span.code ? 0.9 : 1));
      const text = this.clean.text(span.text);
      for (const piece of text.split(/(\n|[ ]+)/)) {
        if (piece === "") continue;
        if (piece === "\n") out.push({ text: "", font, size: s, width: 0, color, br: true });
        else if (/^ +$/.test(piece)) out.push({ text: " ", font, size: s, width: font.widthOfTextAtSize(" ", s), color, space: true });
        else {
          for (const part of splitLong(piece, font, s, this.content)) {
            out.push({ text: part, font, size: s, width: font.widthOfTextAtSize(part, s), color: span.color ?? color, link: span.link });
          }
        }
      }
    }
    return out;
  }

  flow(atoms: Atom[], width: number, size: number): Line[] {
    const lines: Line[] = [];
    let cur: Atom[] = [];
    let w = 0;
    const push = () => {
      while (cur.length && cur[cur.length - 1].space) w -= cur.pop()!.width;
      lines.push({ atoms: cur, width: Math.max(0, w), size: Math.max(size, ...cur.map((a) => a.size)) });
      cur = [];
      w = 0;
    };
    for (const a of atoms) {
      if (a.br) {
        push();
        continue;
      }
      if (a.space && cur.length === 0) continue;
      if (!a.space && w + a.width > width + 0.01 && cur.some((x) => !x.space)) push();
      cur.push(a);
      w += a.width;
    }
    if (cur.length || lines.length === 0) push();
    return lines;
  }

  drawLine(line: Line, x: number, top: number, boxWidth: number, align: string, lead: number) {
    const page = this.page;
    const base = top - (lead - line.size) / 2 - line.size * 0.8;
    let cx = x + (align === "right" ? boxWidth - line.width : align === "center" ? (boxWidth - line.width) / 2 : 0);
    for (const a of line.atoms) {
      if (!a.space) {
        page.drawText(a.text, { x: cx, y: base, size: a.size, font: a.font, color: a.color });
        if (a.link) {
          page.drawLine({ start: { x: cx, y: base - 1.5 }, end: { x: cx + a.width, y: base - 1.5 }, thickness: 0.5, color: a.color });
          const link = this.doc.context.register(this.doc.context.obj({
            Type: "Annot", Subtype: "Link", Rect: [cx, base - 3, cx + a.width, base + a.size], Border: [0, 0, 0],
            A: { Type: "Action", S: "URI", URI: PDFString.of(a.link) },
          }));
          page.node.addAnnot(link);
        }
      }
      cx += a.width;
    }
    this.touch();
  }

  /** Lines flowed down the page from `x`, breaking onto new pages: no single line left alone at either end. */
  paragraph(lines: Line[], x: number, boxWidth: number, opts: { align?: string; before?: (top: number, h: number) => void } = {}) {
    lines.forEach((line, i) => {
      const lead = line.size * LEADING;
      const left = lines.length - i;
      const want = i === 0 && lines.length > 1 ? lead * 2 : left === 2 && i > 0 ? lead * 2 : lead;
      this.need(want);
      opts.before?.(this.y, lead);
      this.drawLine(line, x, this.y, boxWidth, opts.align ?? "left", lead);
      this.y -= lead;
    });
  }

  space(h: number) {
    if (this.atTop) return;
    this.y -= h;
  }

  rule(thickness = 0.6, color: RGB = FAINT) {
    this.page.drawLine({ start: { x: this.left, y: this.y }, end: { x: this.right, y: this.y }, thickness, color });
    this.touch();
  }
}

function clampNum(v: unknown, lo: number, hi: number, fallback: number): number {
  const n = Number(v);
  return Number.isFinite(n) && v !== null && v !== "" ? Math.min(hi, Math.max(lo, n)) : fallback;
}

/** A word too wide for the line, broken where it must be (a long URL). */
function splitLong(word: string, font: PDFFont, size: number, width: number): string[] {
  if (font.widthOfTextAtSize(word, size) <= width) return [word];
  const parts: string[] = [];
  let cur = "";
  for (const ch of word) {
    if (cur && font.widthOfTextAtSize(cur + ch, size) > width) {
      parts.push(cur);
      cur = "";
    }
    cur += ch;
  }
  if (cur) parts.push(cur);
  return parts;
}

const firstWords = (text: string, n = 9) => {
  const plain = text.replace(/\*\*|`|\[([^\]]*)\]\([^)]*\)/g, "$1").replace(/\s+/g, " ").trim();
  const words = plain.split(" ");
  return words.length > n ? `${words.slice(0, n).join(" ")}...` : plain;
};

function blockText(b: Block): string {
  switch (b.type) {
    case "bullets": return asList(b.items).map((i) => (typeof i === "string" ? i : i?.text ?? "")).join(" ");
    case "table": return [...(b.header ?? []), ...(b.rows ?? []).flat()].join(" ");
    case "image": return b.caption ?? b.image ?? "";
    case "rule": return "---";
    case "page_break": return "(page break)";
    default: return b.text ?? "";
  }
}

// ---------------------------------------------------------------- blocks --

const HEADING_SCALE = [0, 1.75, 1.4, 1.15];

function heading(L: Layout, b: Block) {
  const level = Math.min(3, Math.max(1, Math.round(Number(b.level) || 1)));
  const text = String(b.text ?? "").trim();
  if (!text) throw new ComposeError(`Block ${JSON.stringify(b.id)} is a heading without text.`);
  const size = L.size * HEADING_SCALE[level];
  const lines = L.flow(L.atoms(parseInline(text, { bold: true }), size, INK), L.content, size);
  const lead = size * 1.25;
  L.need(lead * lines.length + (level === 1 ? 14 : 8) + L.size * LEADING * 2 + size * 0.7);
  L.space(size * (level === 1 ? 0.9 : 0.8));
  L.begin({ id: b.id as string, type: "heading", label: firstWords(text, 12), level });
  for (const line of lines) {
    L.drawLine(line, L.left, L.y, L.content, "left", lead);
    L.y -= lead;
  }
  if (level === 1) {
    L.y -= 3;
    L.rule();
    L.y -= 8;
  } else L.y -= size * 0.25;
}

function body(L: Layout, text: string, face: Face, opts: { x?: number; width?: number; source?: string | string[]; size?: number; color?: RGB; align?: string; bar?: boolean } = {}) {
  const size = opts.size ?? L.size;
  const x = opts.x ?? L.left;
  const width = opts.width ?? L.content;
  const spans = parseInline(text, face);
  const mark = L.cite(opts.source);
  if (mark) spans.push({ text: ` ${mark}`, color: MUTED, scale: 0.8 });
  const lines = L.flow(L.atoms(spans, size, opts.color ?? INK), width, size);
  L.paragraph(lines, x, width, {
    align: opts.align,
    before: opts.bar ? (top, h) => {
      L.page.drawRectangle({ x: L.left, y: top - h, width: 2.5, height: h, color: rgb(0.72, 0.76, 0.82) });
    } : undefined,
  });
}

function paragraph(L: Layout, b: Block) {
  const text = String(b.text ?? "").trim();
  if (!text) throw new ComposeError(`Block ${JSON.stringify(b.id)} is a paragraph without text.`);
  L.need(L.size * LEADING * 2);
  L.begin({ id: b.id as string, type: "paragraph", label: firstWords(text) });
  // A blank line starts another paragraph within the block.
  text.split(/\n\s*\n/).forEach((para, i) => {
    if (i) L.y -= L.size * 0.6;
    body(L, para.trim(), {}, { source: i === text.split(/\n\s*\n/).length - 1 ? b.source : undefined });
  });
  L.y -= L.size * 0.6;
}

function quote(L: Layout, b: Block) {
  const text = String(b.text ?? "").trim();
  if (!text) throw new ComposeError(`Block ${JSON.stringify(b.id)} is a quote without text.`);
  L.need(L.size * LEADING * 2);
  L.begin({ id: b.id as string, type: "quote", label: firstWords(text) });
  body(L, text, { italic: true }, { x: L.left + 14, width: L.content - 14, source: b.source, color: rgb(0.25, 0.27, 0.31), bar: true });
  L.y -= L.size * 0.6;
}

function bullets(L: Layout, b: Block) {
  const items = asList(b.items);
  if (!items.length) throw new ComposeError(`Block ${JSON.stringify(b.id)} is a list without items.`);
  L.need(L.size * LEADING * 2);
  L.begin({ id: b.id as string, type: "bullets", label: firstWords(blockText(b)) });
  const indent = b.ordered ? 22 : 16;
  items.forEach((item, i) => {
    const text = typeof item === "string" ? item : String(item?.text ?? "");
    const source = typeof item === "string" ? undefined : item?.source;
    const marker = L.clean.text(b.ordered ? `${i + 1}.` : "•");
    L.need(L.size * LEADING);
    const font = L.font({});
    L.page.drawText(marker, { x: L.left + (b.ordered ? 0 : 4), y: L.y - (L.size * LEADING - L.size) / 2 - L.size * 0.8, size: L.size, font, color: MUTED });
    body(L, text.trim(), {}, { x: L.left + indent, width: L.content - indent, source });
    L.y -= L.size * 0.3;
  });
  L.y -= L.size * 0.3;
}

function code(L: Layout, b: Block) {
  const text = String(b.text ?? "");
  if (!text.trim()) throw new ComposeError(`Block ${JSON.stringify(b.id)} is code without text.`);
  L.need(L.size * LEADING * 2);
  L.begin({ id: b.id as string, type: "code", label: firstWords(text, 6) });
  const size = L.size * 0.85;
  const font = L.font({ code: true });
  const lead = size * 1.35;
  const pad = 6;
  const lines: Line[] = [];
  for (const raw of L.clean.text(text.replace(/\n+$/, "")).split("\n")) {
    const pieces = splitLong(raw, font, size, L.content - pad * 2);
    for (const piece of pieces.length ? pieces : [""]) {
      lines.push({ atoms: [{ text: piece, font, size, width: font.widthOfTextAtSize(piece, size), color: INK }], width: 0, size });
    }
  }
  lines.forEach((line, i) => {
    L.need(lead * Math.min(2, lines.length - i));
    L.page.drawRectangle({ x: L.left, y: L.y - lead, width: L.content, height: lead, color: SHADE });
    L.drawLine(line, L.left + pad, L.y, L.content - pad * 2, "left", lead);
    L.y -= lead;
  });
  L.y -= L.size * 0.7;
}

/** Column widths: as given (relative), or fitted to what the cells hold. */
function columnWidths(L: Layout, cols: number, rows: string[][], given: number[] | undefined, size: number, pad: number): number[] {
  const total = L.content;
  if (given && given.length === cols && given.every((g) => Number.isFinite(g) && g > 0)) {
    const sum = given.reduce((a, g) => a + g, 0);
    return given.map((g) => (g / sum) * total);
  }
  const bold = L.font({ bold: true });
  const reg = L.font({});
  const min: number[] = new Array(cols).fill(pad * 2 + 12);
  const want: number[] = new Array(cols).fill(pad * 2 + 12);
  rows.forEach((row, r) => {
    for (let c = 0; c < cols; c++) {
      const text = L.clean.text(String(row[c] ?? "")).replace(/\*\*|`/g, "");
      const font = r === 0 ? bold : reg;
      const longest = Math.max(0, ...text.split(/\s+/).map((w) => font.widthOfTextAtSize(w, size)));
      min[c] = Math.max(min[c], Math.min(longest + pad * 2, total * 0.5));
      want[c] = Math.max(want[c], font.widthOfTextAtSize(text.split("\n").sort((a, z) => z.length - a.length)[0] ?? "", size) + pad * 2);
    }
  });
  const wantSum = want.reduce((a, w) => a + w, 0);
  if (wantSum <= total) {
    const spare = total - wantSum;
    return want.map((w) => w + (spare * w) / wantSum);
  }
  const minSum = min.reduce((a, w) => a + w, 0);
  if (minSum >= total) return min.map((w) => (w / minSum) * total);
  const grow = want.map((w, c) => Math.max(0, w - min[c]));
  const growSum = grow.reduce((a, g) => a + g, 0) || 1;
  return min.map((m, c) => m + ((total - minSum) * grow[c]) / growSum);
}

function table(L: Layout, b: Block) {
  const header = b.header && b.header.length ? b.header.map(String) : null;
  const rows = asList(b.rows).map((r) => (Array.isArray(r) ? r.map((c) => String(c ?? "")) : [String(r ?? "")]));
  if (!rows.length && !header) throw new ComposeError(`Block ${JSON.stringify(b.id)} is a table without rows.`);
  const cols = Math.max(header?.length ?? 0, ...rows.map((r) => r.length));
  const size = L.size * 0.92;
  const pad = 5;
  const all = header ? [header, ...rows] : rows;
  const widths = columnWidths(L, cols, header ? all : [[...new Array(cols).fill("")], ...all], b.widths, size, pad);
  const aligns = (b.align ?? []).map((a) => String(a).toLowerCase());
  const lead = size * LEADING;

  type Cell = { lines: Line[]; h: number };
  const layout = (row: string[], bold: boolean): Cell[] => Array.from({ length: cols }, (_v, c) => {
    const spans = parseInline(String(row[c] ?? ""), { bold });
    const lines = L.flow(L.atoms(spans, size, INK), widths[c] - pad * 2, size);
    return { lines, h: lines.length * lead };
  });
  const headCells = header ? layout(header, true) : null;
  const headH = headCells ? Math.max(...headCells.map((c) => c.h)) + pad * 2 : 0;
  const pageRoom = L.top - L.bottom;

  const drawRow = (cells: Cell[], h: number, fill: RGB | null) => {
    const top = L.y;
    if (fill) L.page.drawRectangle({ x: L.left, y: top - h, width: L.content, height: h, color: fill });
    let x = L.left;
    cells.forEach((cell, c) => {
      cell.lines.forEach((line, i) => L.drawLine(line, x + pad, top - pad - i * lead, widths[c] - pad * 2, aligns[c] ?? "left", lead));
      x += widths[c];
    });
    L.page.drawLine({ start: { x: L.left, y: top - h }, end: { x: L.right, y: top - h }, thickness: 0.5, color: FAINT });
    L.y -= h;
  };

  L.need(headH + (lead + pad * 2) * 2);
  L.begin({ id: b.id as string, type: "table", label: firstWords(header?.join(" | ") ?? rows[0]?.join(" | ") ?? "table", 8) });
  const head = () => {
    if (headCells) drawRow(headCells, headH, HEAD);
  };
  head();
  rows.forEach((row, r) => {
    const cells = layout(row, false);
    const h = Math.max(...cells.map((c) => c.h)) + pad * 2;
    if (h + headH > pageRoom) throw new ComposeError(`Row ${r + 1} of table ${JSON.stringify(b.id)} is taller than a page: shorten its cells or split the table.`);
    if (L.y - h < L.bottom) {
      L.newPage();
      head();
    }
    drawRow(cells, h, r % 2 === 1 ? SHADE : null);
  });
  L.y -= L.size * 0.5;
  const mark = L.cite(b.source);
  if (b.caption || mark) {
    body(L, b.caption ?? "Source:", { italic: true }, { size: L.size * 0.85, color: MUTED, source: b.source });
    L.y -= L.size * 0.4;
  }
  L.y -= L.size * 0.4;
}

async function image(L: Layout, b: Block, load: ImageLoader) {
  if (!b.image) throw new ComposeError(`Block ${JSON.stringify(b.id)} is an image without image: give an artifact id (file_...) or a path.`);
  if (/^data:/i.test(String(b.image))) throw new ComposeError("An image is an artifact id (file_...) or a path on this host, not inline data: save it first.");
  const file = await load(String(b.image));
  const img = file.kind === "png" ? await L.doc.embedPng(file.data) : await L.doc.embedJpg(file.data);
  const maxW = L.content;
  const maxH = (L.top - L.bottom) * 0.75;
  let w = Math.min(maxW, Number(b.width) > 0 ? Number(b.width) : Math.min(img.width, maxW));
  let h = (w * img.height) / img.width;
  if (h > maxH) {
    h = maxH;
    w = (h * img.width) / img.height;
  }
  const mark = L.cite(b.source);
  const captionNeeded = Boolean(b.caption || mark);
  L.need(h + (captionNeeded ? L.size * 2.4 : 0));
  L.begin({ id: b.id as string, type: "image", label: firstWords(b.caption ?? String(b.image), 8) });
  L.page.drawImage(img, { x: L.left + (maxW - w) / 2, y: L.y - h, width: w, height: h });
  L.touch();
  L.y -= h + L.size * 0.4;
  if (captionNeeded) {
    body(L, b.caption ?? "", { italic: true }, { size: L.size * 0.85, color: MUTED, source: b.source, align: "center" });
  }
  L.y -= L.size * 0.8;
}

function titleBlock(L: Layout, src: ComposeSource) {
  if (!src.title) return;
  L.newPage();
  L.begin({ id: "title", type: "title", label: firstWords(String(src.title), 12) });
  const size = L.size * 2.2;
  const lines = L.flow(L.atoms(parseInline(String(src.title), { bold: true }), size, INK), L.content, size);
  for (const line of lines) {
    L.drawLine(line, L.left, L.y, L.content, "left", size * 1.2);
    L.y -= size * 1.2;
  }
  if (src.subtitle) {
    const s = L.size * 1.3;
    for (const line of L.flow(L.atoms(parseInline(String(src.subtitle), {}), s, MUTED), L.content, s)) {
      L.drawLine(line, L.left, L.y, L.content, "left", s * 1.35);
      L.y -= s * 1.35;
    }
  }
  const by = [src.author, src.date].filter(Boolean).map(String).join("  ·  ");
  if (by) {
    const s = L.size * 0.95;
    L.y -= 2;
    for (const line of L.flow(L.atoms(parseInline(by, {}), s, MUTED), L.content, s)) {
      L.drawLine(line, L.left, L.y, L.content, "left", s * 1.4);
      L.y -= s * 1.4;
    }
  }
  L.y -= 6;
  L.rule(1, rgb(0.55, 0.6, 0.68));
  L.y -= L.size * 1.2;
}

function sourcesList(L: Layout, heading_: string) {
  if (!L.sources.length) return;
  const text = heading_.trim() || "Sources";
  const size = L.size * HEADING_SCALE[2];
  L.need(size * 1.25 + L.size * LEADING * 3 + 8);
  L.space(size * 0.8);
  L.begin({ id: "sources", type: "heading", label: text, level: 2 });
  for (const line of L.flow(L.atoms([{ text, bold: true }], size, INK), L.content, size)) {
    L.drawLine(line, L.left, L.y, L.content, "left", size * 1.25);
    L.y -= size * 1.25;
  }
  L.y -= size * 0.25;
  const small = L.size * 0.9;
  L.sources.forEach((source, i) => {
    const linked = /\]\(https?:\/\//.test(source) ? source : source.replace(/(https?:\/\/[^\s)\]>]+)/g, "[$1]($1)");
    const spans: Span[] = [{ text: `[${i + 1}]  `, color: MUTED }, ...parseInline(linked, {})];
    const lines = L.flow(L.atoms(spans, small, INK), L.content, small);
    L.paragraph(lines, L.left, L.content);
    L.y -= small * 0.3;
  });
}

function numberPages(L: Layout, format: string) {
  const font = L.font({});
  const size = L.size * 0.8;
  const total = L.pages.length;
  L.pages.forEach((page, i) => {
    const label = L.clean.text(format.replace(/\{n\}/g, String(i + 1)).replace(/\{total\}/g, String(total)));
    const w = font.widthOfTextAtSize(label, size);
    page.drawText(label, { x: (L.width - w) / 2, y: L.left * 0.5 - size / 2, size, font, color: MUTED });
  });
}

// ---------------------------------------------------------------- compose --

/** Lay the document out as a new PDF. */
export async function compose(src: ComposeSource, load: ImageLoader): Promise<Composed> {
  const doc = await PDFDocument.create();
  const cache = new Map<string, PDFFont>();
  const fonts: Fonts = {
    at(face, family) {
      const set = family === "times"
        ? [StandardFonts.TimesRoman, StandardFonts.TimesRomanBold, StandardFonts.TimesRomanItalic, StandardFonts.TimesRomanBoldItalic]
        : [StandardFonts.Helvetica, StandardFonts.HelveticaBold, StandardFonts.HelveticaOblique, StandardFonts.HelveticaBoldOblique];
      const name = set[(face.bold ? 1 : 0) + (face.italic ? 2 : 0)];
      let font = cache.get(name);
      if (!font) {
        font = doc.embedStandardFont(name);
        cache.set(name, font);
      }
      return font;
    },
  };
  const L = new Layout(doc, src, fonts, new Cleaner(fonts.at({}, "helvetica")));
  const notes: string[] = [];

  titleBlock(L, src);
  for (const b of src.blocks) {
    switch (b.type) {
      case "heading": heading(L, b); break;
      case "paragraph": paragraph(L, b); break;
      case "bullets": bullets(L, b); break;
      case "quote": quote(L, b); break;
      case "code": code(L, b); break;
      case "table": table(L, b); break;
      case "image": await image(L, b, load); break;
      case "rule":
        L.need(L.size * 2);
        L.begin({ id: b.id as string, type: "rule", label: "---" });
        L.y -= L.size * 0.4;
        L.rule();
        L.y -= L.size * 0.8;
        break;
      case "page_break":
        L.begin({ id: b.id as string, type: "page_break", label: "(page break)" });
        if (!L.atTop) L.newPage();
        L.touch();
        break;
    }
  }
  if (src.sources_heading !== false) sourcesList(L, typeof src.sources_heading === "string" ? src.sources_heading : "Sources");
  if (L.pages.length === 0) L.newPage();
  if (src.page_numbers !== false) {
    const format = typeof src.page_numbers === "string" && src.page_numbers.trim() ? src.page_numbers : "Page {n} of {total}";
    numberPages(L, format);
  }
  if (src.title) doc.setTitle(String(src.title));
  if (src.author) doc.setAuthor(String(src.author));
  doc.setCreator("Autora");
  doc.setProducer("Autora");

  if (L.clean.replaced.size) {
    const list = [...L.clean.replaced.keys()].slice(0, 8).map((c) => JSON.stringify(c)).join(" ");
    notes.push(`The built-in fonts could not write ${list}; each was replaced with "?". Write them another way, or leave them out.`);
  }
  if (L.sources.length && src.sources_heading === false) {
    notes.push(`${L.sources.length} source${L.sources.length === 1 ? " is" : "s are"} cited as [n] but the list of them is turned off.`);
  }
  return { doc, source: src, pages: L.pages.length, outline: L.outline.filter((o) => o.page > 0), notes };
}

/** The outline as lines for the agent: where each part is, and how it starts. */
export function outlineLines(outline: OutlineEntry[], limit = 40): string[] {
  const out: string[] = [];
  const list = outline.filter((o) => o.type !== "page_break");
  // Headings give the shape; the block after one gives its first words.
  for (const [i, o] of list.entries()) {
    if (o.type === "heading" || o.type === "title") {
      const next = list[i + 1];
      const lead = next && next.type !== "heading" ? ` -- ${next.type}: ${next.label}` : "";
      const span = o.endPage > o.page ? `${o.page}-${o.endPage}` : `${o.page}`;
      out.push(`p${span} ${"#".repeat(o.level ?? 1)} ${o.label} [${o.id}]${lead}`);
    }
  }
  if (out.length === 0) {
    for (const o of list.slice(0, limit)) out.push(`p${o.page} ${o.type}: ${o.label} [${o.id}]`);
  }
  if (out.length > limit) return [...out.slice(0, limit), `... and ${out.length - limit} more headings`];
  return out;
}

/** Which blocks sit on which pages, for the briefing: "p2 s3, s4". */
export function pagesOfBlocks(outline: OutlineEntry[]): string {
  const byPage = new Map<number, string[]>();
  for (const o of outline) {
    for (let p = o.page; p <= o.endPage; p++) byPage.set(p, [...(byPage.get(p) ?? []), o.id]);
  }
  return [...byPage.entries()].map(([p, ids]) => `p${p}: ${ids.join(" ")}`).join("; ");
}
