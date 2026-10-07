/**
 * Changing the words a PDF already has.
 *
 * Drawing over text hides it and leaves it in the file, and redacting turns
 * the whole page into a picture. Neither changes a word. This does: it reads
 * the page's content stream the way a viewer does -- which font is selected,
 * which bytes are shown, what each byte means in that font -- finds the
 * words, and rewrites the bytes.
 *
 *  - in place, when the font can write what the new words need: the codes are
 *    swapped inside the same string, so the page stays vector, selectable and
 *    searchable, in its own typeface. A font is trusted to have a letter only
 *    where the file shows it: a subset font carries the letters its text used,
 *    so a new letter it never drew is not assumed.
 *  - otherwise by taking the old glyphs out of the stream (still vector, the
 *    rest of the page untouched) and handing back where to draw the new words
 *    in a built-in font, which the caller draws. The old words are gone from
 *    the bytes either way.
 *
 * Positions come from pdf.js (the caller's `locate`), so nothing here tracks
 * the text matrix. What cannot be done is said: text that is an invisible
 * layer over a scan, a font whose codes cannot be read, a letter split by a
 * ligature.
 */

import { similarText } from "./hints";
import {
  decodePDFRawStream, PDFArray, PDFDict, PDFDocument, PDFName, PDFNumber, PDFRawStream, PDFRef,
  PDFStream, type PDFPage,
} from "@cantoo/pdf-lib";

// ------------------------------------------------------------ tokenizer --

type Tok =
  | { k: "num"; v: number }
  | { k: "name"; v: string }
  | { k: "str"; b: number[] }
  | { k: "arr"; items: Tok[] }
  | { k: "x" };

interface Op {
  name: string;
  args: Tok[];
  /** Where the operator and its operands sit in the source. */
  s: number;
  e: number;
}

const WS = new Set([0, 9, 10, 12, 13, 32]);
const DELIM = new Set("()<>[]{}/%".split("").map((c) => c.charCodeAt(0)));

/** A content stream as its operators. `src` is the stream's bytes as Latin-1. */
export function tokenize(src: string): Op[] {
  const ops: Op[] = [];
  let pos = 0;
  const n = src.length;
  const code = (i: number) => src.charCodeAt(i);

  const skipSpace = () => {
    while (pos < n) {
      const c = code(pos);
      if (WS.has(c)) pos += 1;
      else if (c === 37) {
        while (pos < n && code(pos) !== 10 && code(pos) !== 13) pos += 1;
      } else break;
    }
  };

  const literal = (): number[] => {
    const out: number[] = [];
    pos += 1;
    let depth = 1;
    while (pos < n && depth > 0) {
      const c = code(pos);
      if (c === 92) {
        const d = src[pos + 1];
        pos += 2;
        if (d === "n") out.push(10);
        else if (d === "r") out.push(13);
        else if (d === "t") out.push(9);
        else if (d === "b") out.push(8);
        else if (d === "f") out.push(12);
        else if (d !== undefined && d >= "0" && d <= "7") {
          let v = d.charCodeAt(0) - 48;
          for (let i = 0; i < 2 && src[pos] >= "0" && src[pos] <= "7"; i += 1) {
            v = v * 8 + (code(pos) - 48);
            pos += 1;
          }
          out.push(v & 255);
        } else if (d === "\r") {
          if (src[pos] === "\n") pos += 1;
        } else if (d === "\n") {
          // line continuation
        } else if (d !== undefined) out.push(d.charCodeAt(0));
        continue;
      }
      if (c === 40) depth += 1;
      else if (c === 41) {
        depth -= 1;
        if (depth === 0) {
          pos += 1;
          break;
        }
      }
      out.push(c);
      pos += 1;
    }
    return out;
  };

  const hex = (): number[] => {
    pos += 1;
    let digits = "";
    while (pos < n && src[pos] !== ">") {
      if (/[0-9a-fA-F]/.test(src[pos])) digits += src[pos];
      pos += 1;
    }
    pos += 1;
    if (digits.length % 2) digits += "0";
    const out: number[] = [];
    for (let i = 0; i < digits.length; i += 2) out.push(parseInt(digits.slice(i, i + 2), 16));
    return out;
  };

  const word = (): string => {
    const from = pos;
    while (pos < n && !WS.has(code(pos)) && !DELIM.has(code(pos))) pos += 1;
    return src.slice(from, pos);
  };

  const value = (): Tok | { op: string } => {
    const c = src[pos];
    if (c === "(") return { k: "str", b: literal() };
    if (c === "<") {
      if (src[pos + 1] === "<") {
        let depth = 0;
        while (pos < n) {
          if (src[pos] === "<" && src[pos + 1] === "<") { depth += 1; pos += 2; }
          else if (src[pos] === ">" && src[pos + 1] === ">") {
            depth -= 1;
            pos += 2;
            if (depth === 0) break;
          } else pos += 1;
        }
        return { k: "x" };
      }
      return { k: "str", b: hex() };
    }
    if (c === "[") {
      pos += 1;
      const items: Tok[] = [];
      for (;;) {
        skipSpace();
        if (pos >= n) break;
        if (src[pos] === "]") { pos += 1; break; }
        const v = value();
        if ("op" in v) continue;
        items.push(v);
      }
      return { k: "arr", items };
    }
    if (c === "/") {
      pos += 1;
      const raw = word();
      return { k: "name", v: raw.replace(/#([0-9a-fA-F]{2})/g, (_, h) => String.fromCharCode(parseInt(h, 16))) };
    }
    if (c === ")" || c === ">" || c === "]" || c === "{" || c === "}") {
      pos += 1;
      return { k: "x" };
    }
    const w = word();
    if (w === "") {
      pos += 1;
      return { k: "x" };
    }
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(w)) return { k: "num", v: parseFloat(w) };
    if (w === "true" || w === "false" || w === "null") return { k: "x" };
    return { op: w };
  };

  let args: Tok[] = [];
  let start = -1;
  while (pos < n) {
    skipSpace();
    if (pos >= n) break;
    const at = pos;
    const v = value();
    if (!("op" in v)) {
      if (start < 0) start = at;
      args.push(v);
      continue;
    }
    if (start < 0) start = at;
    if (v.op === "BI") {
      // An inline image: its data is not operators. Skip to the EI after it.
      const id = src.indexOf("ID", pos);
      const from = id < 0 ? n : id + 2;
      let stop = n;
      const re = /[\s\S]EI(?=[\s]|$)/g;
      re.lastIndex = from;
      const m = re.exec(src);
      if (m) stop = m.index + m[0].length;
      pos = stop;
      ops.push({ name: "BI", args: [], s: start, e: pos });
    } else {
      ops.push({ name: v.op, args, s: start, e: pos });
    }
    args = [];
    start = -1;
  }
  return ops;
}

// ---------------------------------------------------------------- fonts --

const GLYPHS: Record<string, string> = {
  space: " ", exclam: "!", quotedbl: "\"", numbersign: "#", dollar: "$", percent: "%", ampersand: "&",
  quotesingle: "'", parenleft: "(", parenright: ")", asterisk: "*", plus: "+", comma: ",", hyphen: "-",
  minus: "−", period: ".", slash: "/", zero: "0", one: "1", two: "2", three: "3", four: "4",
  five: "5", six: "6", seven: "7", eight: "8", nine: "9", colon: ":", semicolon: ";", less: "<",
  equal: "=", greater: ">", question: "?", at: "@", bracketleft: "[", backslash: "\\",
  bracketright: "]", asciicircum: "^", underscore: "_", grave: "`", braceleft: "{", bar: "|",
  braceright: "}", asciitilde: "~", bullet: "•", endash: "–", emdash: "—",
  quoteleft: "‘", quoteright: "’", quotedblleft: "“", quotedblright: "”",
  ellipsis: "…", fi: "fi", fl: "fl", Euro: "€", copyright: "©", registered: "®",
  trademark: "™", degree: "°", section: "§", nbspace: " ", sterling: "£",
  yen: "¥", cent: "¢", multiply: "×", divide: "÷", eacute: "é",
  egrave: "è", agrave: "à", aacute: "á", ntilde: "ñ", udieresis: "ü",
  odieresis: "ö", adieresis: "ä", germandbls: "ß", ccedilla: "ç",
};

function glyphChar(name: string): string | null {
  if (GLYPHS[name]) return GLYPHS[name];
  if (/^[A-Za-z]$/.test(name)) return name;
  const u = /^uni([0-9A-Fa-f]{4})$/.exec(name);
  if (u) return String.fromCharCode(parseInt(u[1], 16));
  return null;
}

/** What a byte is in a base encoding. */
function baseTable(encoding: string | null): (code: number) => string {
  const dec = (label: string) => {
    try {
      const d = new TextDecoder(label);
      return (code: number) => d.decode(new Uint8Array([code]));
    } catch {
      return (code: number) => String.fromCharCode(code);
    }
  };
  if (encoding === "MacRomanEncoding") return dec("macintosh");
  if (encoding === "WinAnsiEncoding") return dec("windows-1252");
  // Standard and unnamed encodings agree with ASCII where text is ordinary.
  return (code: number) => (code >= 32 && code < 127 ? String.fromCharCode(code) : "�");
}

class FontInfo {
  base = "";
  /** Bytes per code: 1 for simple fonts, 2 for Identity-H composites. */
  len = 1;
  /** Code -> what it shows. Missing means unknown. */
  chars = new Map<number, string>();
  /** The letters the font is known to hold, with a code to write each. */
  codes = new Map<string, number>();
  /** Codes can be read as text. */
  readable = true;
  /** The font file is in the PDF, possibly cut down to what was used. */
  embedded = false;
  widthOf: (code: number) => number | null = () => null;

  width(code: number): number | null {
    return this.widthOf(code);
  }

  get family(): "helvetica" | "times" | "courier" {
    if (/courier|mono|consolas/i.test(this.base)) return "courier";
    if (/times|serif|georgia|garamond|palatino|minion|cambria/i.test(this.base) && !/sans/i.test(this.base)) return "times";
    return "helvetica";
  }
  get bold(): boolean { return /bold|black|heavy/i.test(this.base); }
  get italic(): boolean { return /italic|oblique/i.test(this.base); }
}

function bytesOf(stream: unknown): Uint8Array | null {
  try {
    if (stream instanceof PDFRawStream) return decodePDFRawStream(stream).decode();
    // The stream pdf-lib builds itself (the q and Q it wraps a page's own
    // contents in): its encoded bytes are deflated, so ask for the plain ones.
    const own = stream as { getUnencodedContents?: () => Uint8Array };
    if (stream instanceof PDFStream && typeof own.getUnencodedContents === "function") return own.getUnencodedContents();
  } catch {
    return null;
  }
  return null;
}

const latin1 = (b: Uint8Array) => Buffer.from(b).toString("latin1");

function utf16(hex: string): string {
  let out = "";
  for (let i = 0; i + 3 < hex.length + 1; i += 4) out += String.fromCharCode(parseInt(hex.slice(i, i + 4), 16));
  return out;
}

/** A ToUnicode CMap's bfchar and bfrange entries. */
function parseToUnicode(text: string, into: Map<number, string>): void {
  for (const block of text.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
      into.set(parseInt(m[1], 16), utf16(m[2]));
    }
  }
  for (const block of text.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
    for (const m of block[1].matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
      const lo = parseInt(m[1], 16), hi = parseInt(m[2], 16);
      if (hi - lo > 0xffff) continue;
      if (m[5] !== undefined) {
        const list = [...m[5].matchAll(/<([0-9a-fA-F]+)>/g)].map((x) => utf16(x[1]));
        for (let c = lo; c <= hi; c += 1) if (list[c - lo] !== undefined) into.set(c, list[c - lo]);
      } else {
        const start = utf16(m[4]);
        const last = start.charCodeAt(start.length - 1);
        for (let c = lo; c <= hi; c += 1) into.set(c, start.slice(0, -1) + String.fromCharCode(last + (c - lo)));
      }
    }
  }
}

function num(v: unknown): number | null {
  return v instanceof PDFNumber ? v.asNumber() : null;
}

function readFont(doc: PDFDocument, dict: PDFDict): FontInfo {
  const f = new FontInfo();
  const ctx = doc.context;
  const name = (key: string) => dict.lookupMaybe(PDFName.of(key), PDFName)?.decodeText() ?? "";
  f.base = name("BaseFont").replace(/^[A-Z]{6}\+/, "");
  const subtype = name("Subtype");
  const toUni = new Map<number, string>();
  const tu = bytesOf(dict.lookup(PDFName.of("ToUnicode")));
  if (tu) parseToUnicode(latin1(tu), toUni);

  let descriptor: PDFDict | undefined;
  if (subtype === "Type0") {
    const enc = dict.lookup(PDFName.of("Encoding"));
    const encName = enc instanceof PDFName ? enc.decodeText() : "";
    f.len = 2;
    f.readable = /^Identity-[HV]$/.test(encName) && toUni.size > 0;
    const desc = dict.lookupMaybe(PDFName.of("DescendantFonts"), PDFArray)?.lookupMaybe(0, PDFDict);
    descriptor = desc?.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
    const dw = desc ? num(desc.lookup(PDFName.of("DW"))) ?? 1000 : 1000;
    const widths = new Map<number, number>();
    const w = desc?.lookupMaybe(PDFName.of("W"), PDFArray);
    if (w) {
      for (let i = 0; i < w.size();) {
        const first = num(w.lookup(i));
        const second = w.lookup(i + 1);
        if (first === null) break;
        if (second instanceof PDFArray) {
          for (let j = 0; j < second.size(); j += 1) widths.set(first + j, num(second.lookup(j)) ?? dw);
          i += 2;
        } else {
          const last = num(second);
          const wd = num(w.lookup(i + 2));
          if (last !== null && wd !== null && last - first < 0x10000) for (let c = first; c <= last; c += 1) widths.set(c, wd);
          i += 3;
        }
      }
    }
    f.widthOf = (code) => widths.get(code) ?? dw;
    for (const [c, s] of toUni) f.chars.set(c, s);
  } else {
    descriptor = dict.lookupMaybe(PDFName.of("FontDescriptor"), PDFDict);
    const enc = dict.lookup(PDFName.of("Encoding"));
    let baseName: string | null = null;
    const diffs = new Map<number, string>();
    if (enc instanceof PDFName) baseName = enc.decodeText();
    else if (enc instanceof PDFDict) {
      const b = enc.lookup(PDFName.of("BaseEncoding"));
      if (b instanceof PDFName) baseName = b.decodeText();
      const d = enc.lookupMaybe(PDFName.of("Differences"), PDFArray);
      if (d) {
        let at = 0;
        for (let i = 0; i < d.size(); i += 1) {
          const item = d.lookup(i);
          if (item instanceof PDFNumber) at = item.asNumber();
          else if (item instanceof PDFName) {
            const ch = glyphChar(item.decodeText());
            if (ch !== null) diffs.set(at, ch);
            at += 1;
          }
        }
      }
    }
    const table = baseTable(baseName);
    const hasEncoding = baseName !== null || diffs.size > 0;
    const embedded = Boolean(descriptor && (descriptor.has(PDFName.of("FontFile")) || descriptor.has(PDFName.of("FontFile2")) || descriptor.has(PDFName.of("FontFile3"))));
    f.readable = toUni.size > 0 || hasEncoding || !embedded;
    for (let c = 0; c < 256; c += 1) {
      const s = toUni.get(c) ?? diffs.get(c) ?? (toUni.size > 0 ? undefined : table(c));
      if (s !== undefined && s !== "�") f.chars.set(c, s);
    }
    const first = num(dict.lookup(PDFName.of("FirstChar"))) ?? 0;
    const arr = dict.lookupMaybe(PDFName.of("Widths"), PDFArray);
    const missing = descriptor ? num(descriptor.lookup(PDFName.of("MissingWidth"))) : null;
    f.widthOf = (code) => {
      if (arr && code >= first && code - first < arr.size()) return num(arr.lookup(code - first));
      return missing;
    };
  }
  f.embedded = Boolean(
    descriptor && (descriptor.has(PDFName.of("FontFile")) || descriptor.has(PDFName.of("FontFile2")) || descriptor.has(PDFName.of("FontFile3"))),
  );
  for (const [code, s] of f.chars) if (s.length === 1 && !f.codes.has(s)) f.codes.set(s, code);
  void ctx;
  return f;
}

// ---------------------------------------------------------------- cells --

interface Cell {
  text: string;
  op: number;
  /** Index into a TJ array, or 0 for a single string. */
  item: number;
  /** Which code in that string. */
  at: number;
  font: FontInfo;
  color: string;
  invisible: boolean;
  line: number;
  code: number;
}

type Piece = { s: number[] } | { n: number };

interface Unit {
  src: string;
  ops: Op[];
  fonts: Map<string, FontInfo>;
  cells: Cell[];
  /** What each string operator shows, by op index. */
  strings: Map<number, Piece[]>;
}

function hexColor(r: number, g: number, b: number): string {
  const h = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255).toString(16).padStart(2, "0");
  return `#${h(r)}${h(g)}${h(b)}`;
}

function nums(args: Tok[]): number[] {
  return args.filter((a): a is { k: "num"; v: number } => a.k === "num").map((a) => a.v);
}

/** Turn a unit's operators into cells: one per code shown. */
function readCells(unit: Unit): void {
  type State = { font: FontInfo | null; color: string; mode: number };
  let st: State = { font: null, color: "#000000", mode: 0 };
  const stack: State[] = [];
  let line = 0;
  let lastTmF: number | null = null;

  unit.ops.forEach((op, i) => {
    const a = op.args;
    const show = (pieces: Piece[]) => {
      unit.strings.set(i, pieces);
      const font = st.font;
      let item = 0;
      for (const p of pieces) {
        if ("s" in p) {
          if (font) {
            const len = font.len;
            for (let at = 0; at * len + len <= p.s.length; at += 1) {
              let code = 0;
              for (let k = 0; k < len; k += 1) code = code * 256 + p.s[at * len + k];
              unit.cells.push({
                text: font.readable ? font.chars.get(code) ?? "�" : "�",
                op: i, item, at, font, color: st.color, invisible: st.mode === 3, line, code,
              });
            }
          }
        }
        item += 1;
      }
    };
    const strTok = (t: Tok | undefined): Piece[] => (t && t.k === "str" ? [{ s: t.b }] : []);
    switch (op.name) {
      case "q": stack.push({ ...st }); break;
      case "Q": st = stack.pop() ?? st; break;
      case "BT": case "ET": line += 1; break;
      case "Tf": {
        const n = a[0];
        st = { ...st, font: n && n.k === "name" ? unit.fonts.get(n.v) ?? null : null };
        break;
      }
      case "Tr": st = { ...st, mode: nums(a)[0] ?? 0 }; break;
      case "g": st = { ...st, color: hexColor(nums(a)[0] ?? 0, nums(a)[0] ?? 0, nums(a)[0] ?? 0) }; break;
      case "rg": { const [r = 0, g = 0, b = 0] = nums(a); st = { ...st, color: hexColor(r, g, b) }; break; }
      case "k": {
        const [c = 0, m = 0, y = 0, k = 0] = nums(a);
        st = { ...st, color: hexColor((1 - c) * (1 - k), (1 - m) * (1 - k), (1 - y) * (1 - k)) };
        break;
      }
      case "sc": case "scn": {
        const v = nums(a);
        if (v.length === 3) st = { ...st, color: hexColor(v[0], v[1], v[2]) };
        else if (v.length === 1) st = { ...st, color: hexColor(v[0], v[0], v[0]) };
        break;
      }
      case "Td": case "TD": if ((nums(a)[1] ?? 0) !== 0) line += 1; break;
      case "T*": line += 1; break;
      case "Tm": {
        const f = nums(a)[5] ?? 0;
        if (lastTmF !== null && Math.abs(f - lastTmF) > 0.01) line += 1;
        lastTmF = f;
        break;
      }
      case "Tj": show(strTok(a[0])); break;
      case "'": line += 1; show(strTok(a[0])); break;
      case "\"": line += 1; show(strTok(a[2])); break;
      case "TJ": {
        const arr = a[0];
        if (arr && arr.k === "arr") {
          show(arr.items.flatMap((t): Piece[] => (t.k === "str" ? [{ s: t.b }] : t.k === "num" ? [{ n: t.v }] : [])));
        }
        break;
      }
      default: break;
    }
  });
}

// ----------------------------------------------------------- the stream --

interface Source {
  /** The page whose Contents this is, or the form's stream. */
  page?: PDFPage;
  ref?: PDFRef;
  resources: PDFDict | undefined;
}

function streamUnits(doc: PDFDocument, page: PDFPage): Source[] {
  const out: Source[] = [{ page, resources: page.node.normalizedEntries().Resources }];
  const seen = new Set<string>();
  const visit = (res: PDFDict | undefined, depth: number) => {
    const xo = res?.lookupMaybe(PDFName.of("XObject"), PDFDict);
    if (!xo || depth > 4) return;
    for (const [, v] of xo.entries()) {
      if (!(v instanceof PDFRef) || seen.has(v.tag)) continue;
      seen.add(v.tag);
      const s = doc.context.lookup(v);
      if (!(s instanceof PDFRawStream)) continue;
      if (s.dict.lookup(PDFName.of("Subtype")) !== PDFName.of("Form")) continue;
      const own = s.dict.lookupMaybe(PDFName.of("Resources"), PDFDict) ?? res;
      out.push({ ref: v, resources: own });
      visit(own, depth + 1);
    }
  };
  visit(out[0].resources, 0);
  return out;
}

function sourceOf(doc: PDFDocument, s: Source): string | null {
  if (s.page) {
    const contents = s.page.node.normalizedEntries().Contents;
    if (!contents) return "";
    const parts: string[] = [];
    for (let i = 0; i < contents.size(); i += 1) {
      const b = bytesOf(contents.lookup(i));
      if (!b) return null;
      parts.push(latin1(b));
    }
    return parts.join("\n");
  }
  const b = bytesOf(doc.context.lookup(s.ref!));
  return b ? latin1(b) : null;
}

function writeSource(doc: PDFDocument, s: Source, src: string): void {
  const stream = doc.context.flateStream(Buffer.from(src, "latin1"));
  if (s.page) {
    // An array, as the drawing code that may follow expects.
    s.page.node.set(PDFName.of("Contents"), doc.context.obj([doc.context.register(stream)]));
    return;
  }
  const old = doc.context.lookup(s.ref!) as PDFRawStream;
  for (const [k, v] of old.dict.entries()) {
    const key = k.decodeText();
    if (["Length", "Filter", "DecodeParms", "DL"].includes(key)) continue;
    stream.dict.set(k, v);
  }
  doc.context.assign(s.ref!, stream);
}

function fontsOf(doc: PDFDocument, resources: PDFDict | undefined, cache: Map<string, FontInfo>): Map<string, FontInfo> {
  const out = new Map<string, FontInfo>();
  const fd = resources?.lookupMaybe(PDFName.of("Font"), PDFDict);
  if (!fd) return out;
  for (const [k, v] of fd.entries()) {
    const d = fd.lookupMaybe(k, PDFDict);
    if (!d) continue;
    const tag = v instanceof PDFRef ? v.tag : `${k.decodeText()}@${out.size}`;
    let info = cache.get(tag);
    if (!info) {
      info = readFont(doc, d);
      cache.set(tag, info);
    }
    out.set(k.decodeText(), info);
  }
  return out;
}

// -------------------------------------------------------------- editing --

export interface TextEdit {
  find: string;
  with: string;
  ignoreCase?: boolean;
}

interface Draw {
  x: number;
  y: number;
  size: number;
  text: string;
  color: string;
  font: "helvetica" | "times" | "courier";
  bold: boolean;
  italic: boolean;
}

interface EditReport {
  find: string;
  with: string;
  /** Matches changed on this page. */
  matches: number;
  how: "in place" | "redrawn";
}

interface PageResult {
  changed: EditReport[];
  draws: Draw[];
  /** Said to the agent: what could not be done and why. */
  notes: string[];
}

interface Match {
  cells: Cell[];
  unit: Unit;
}

const hexOf = (b: number[]) => `<${b.map((x) => x.toString(16).padStart(2, "0")).join("")}>`;

function numText(n: number): string {
  return String(Math.round(n * 1000) / 1000);
}

/** The operator text for a string operator with new pieces. */
function render(op: Op, pieces: Piece[]): string {
  const merged: Piece[] = [];
  for (const p of pieces) {
    const last = merged[merged.length - 1];
    if ("s" in p && last && "s" in last) last.s = [...last.s, ...p.s];
    else merged.push("s" in p ? { s: [...p.s] } : p);
  }
  const clean = merged.filter((p) => !("s" in p && p.s.length === 0));
  const onlyOne = clean.length === 1 && "s" in clean[0];
  if (op.name === "TJ" || !onlyOne) {
    if (op.name === "'" || op.name === "\"") {
      // Moving the line is part of these; keep the string, drop the nudges.
      const strs = clean.filter((p): p is { s: number[] } => "s" in p);
      const all = strs.flatMap((p) => p.s);
      const lead = op.name === "\"" ? `${op.args.slice(0, 2).map((t) => (t.k === "num" ? numText(t.v) : "0")).join(" ")} ` : "";
      return `${lead}${hexOf(all)} ${op.name}`;
    }
    return `[${clean.map((p) => ("s" in p ? hexOf(p.s) : numText(p.n))).join(" ")}] TJ`;
  }
  const s = (clean[0] as { s: number[] }).s;
  if (op.name === "Tj") return `${hexOf(s)} Tj`;
  if (op.name === "'") return `${hexOf(s)} '`;
  const lead = op.args.slice(0, 2).map((t) => (t.k === "num" ? numText(t.v) : "0")).join(" ");
  return `${lead} ${hexOf(s)} "`;
}

/** Find a needle among a unit's cells, line by line, ignoring spaces. */
function findIn(unit: Unit, edit: TextEdit): { found: Match[]; hidden: number; split: number } {
  const norm = (s: string) => (edit.ignoreCase ? s.toLowerCase() : s).replace(/\s+/g, "");
  const needle = norm(edit.find);
  const found: Match[] = [];
  let hidden = 0;
  let split = 0;
  if (!needle) return { found, hidden, split };
  const lines = new Map<number, Cell[]>();
  for (const c of unit.cells) lines.set(c.line, [...(lines.get(c.line) ?? []), c]);
  for (const cells of lines.values()) {
    let hay = "";
    const owner: number[] = [];
    cells.forEach((c, idx) => {
      for (const ch of norm(c.text)) {
        hay += ch;
        owner.push(idx);
      }
    });
    for (let from = hay.indexOf(needle); from >= 0; from = hay.indexOf(needle, from + needle.length)) {
      const first = owner[from], last = owner[from + needle.length - 1];
      const run = cells.slice(first, last + 1);
      const whole = norm(run.map((c) => c.text).join("")) === needle;
      if (!whole) {
        split += 1;
        continue;
      }
      if (run.some((c) => c.invisible)) {
        hidden += 1;
        continue;
      }
      found.push({ cells: run, unit });
    }
  }
  return { found, hidden, split };
}

/**
 * Change `edits` on one page. The document is changed in place; `locate`
 * says where the text sits on the page as shown (top-left points), for the
 * words that have to be drawn.
 *
 * Each change is made on the stream as the one before left it, read again
 * from its bytes, so nothing is ever worked out against a position that has
 * since moved; and within one change the matches are taken last first, so an
 * edit never moves one still to come.
 */
export async function replaceOnPage(
  doc: PDFDocument,
  page: PDFPage,
  edits: TextEdit[],
  locate: (find: string, ignoreCase: boolean) => Promise<{ x: number; y: number; w: number; h: number }[]>,
): Promise<PageResult> {
  const result: PageResult = { changed: [], draws: [], notes: [] };
  const fontCache = new Map<string, FontInfo>();
  const build = (source: Source, src: string): Unit => {
    const unit: Unit = { src, ops: tokenize(src), fonts: fontsOf(doc, source.resources, fontCache), cells: [], strings: new Map() };
    readCells(unit);
    return unit;
  };
  const units: { source: Source; unit: Unit; original: string }[] = [];
  for (const source of streamUnits(doc, page)) {
    const src = sourceOf(doc, source);
    if (src === null) continue;
    units.push({ source, unit: build(source, src), original: src });
  }
  /** What each font shows on this page: all a cut-down font is known to hold. */
  const shown = new Map<FontInfo, Set<string>>();
  for (const { unit } of units) {
    for (const c of unit.cells) {
      const set = shown.get(c.font) ?? new Set<string>();
      if (c.text !== "\uFFFD") for (const ch of c.text) set.add(ch);
      shown.set(c.font, set);
    }
  }
  const editable = (font: FontInfo, ch: string): number | null => {
    const code = font.codes.get(ch);
    if (code === undefined) return null;
    if (font.embedded && !shown.get(font)?.has(ch)) return null;
    return code;
  };
  const before = (a: Cell, b: Cell) => a.op - b.op || a.item - b.item || a.at - b.at;

  for (const edit of edits) {
    if (!edit.find.trim()) {
      result.notes.push("An empty find was skipped.");
      continue;
    }
    const matches: Match[] = [];
    let hidden = 0, split = 0;
    for (const entry of units) {
      const r = findIn(entry.unit, edit);
      matches.push(...r.found);
      hidden += r.hidden;
      split += r.split;
    }
    if (hidden) {
      result.notes.push(
        `${JSON.stringify(edit.find)}: ${hidden} match${hidden === 1 ? " is" : "es are"} invisible text (an OCR layer over a scanned picture); ` +
        "changing it would change nothing you can see. To change what the page shows, cover the area with a pdf_redact area and add the words with pdf_edit.",
      );
    }
    if (split) {
      result.notes.push(`${JSON.stringify(edit.find)}: ${split} match${split === 1 ? "" : "es"} began or ended inside a ligature (such as fi), which this does not split; left as it was.`);
    }
    if (matches.length === 0) {
      /* Said, with what the page does read near it: a wrong guess at wording is
         the usual reason, and the nearest real text saves a round trip. */
      if (!hidden && !split) {
        const lines = units.flatMap(({ unit }) => {
          const byLine = new Map<number, string>();
          for (const c of unit.cells) if (!c.invisible) byLine.set(c.line, (byLine.get(c.line) ?? "") + c.text);
          return [...byLine.values()];
        });
        const near = similarText(lines, edit.find);
        result.notes.push(
          `${JSON.stringify(edit.find)} is not on this page.` +
          (near.length ? ` The page reads, nearby: ${near.map((n) => JSON.stringify(n)).join("; ")}.` : " Use pdf_read for the page's text."),
        );
      }
      continue;
    }

    const chars = [...edit.with];
    const sameFont = (m: Match) => m.cells.every((c) => c.font === m.cells[0].font);
    const inPlace = matches.every((m) => sameFont(m) && m.cells[0].font.readable &&
      chars.every((ch) => editable(m.cells[0].font, ch) !== null));

    let positions: { x: number; y: number; w: number; h: number }[] = [];
    if (!inPlace && edit.with) {
      positions = await locate(edit.find, Boolean(edit.ignoreCase));
      if (positions.length !== matches.length) {
        result.notes.push(
          `${JSON.stringify(edit.find)}: the page's text reads ${matches.length} time(s) in the file but ${positions.length} where it is drawn, ` +
          "so the new words could not be placed with confidence; nothing was changed for it. Use pdf_look to see the page and pdf_redact with an area, then pdf_edit to add text.",
        );
        continue;
      }
    }

    const pending = new Map<Unit, Map<number, Piece[]>>();
    const piecesOf = (unit: Unit, op: number): Piece[] => {
      let ops = pending.get(unit);
      if (!ops) pending.set(unit, (ops = new Map()));
      let p = ops.get(op);
      if (!p) {
        p = (unit.strings.get(op) ?? []).map((x) => ("s" in x ? { s: [...x.s] } : { ...x }));
        ops.set(op, p);
      }
      return p;
    };

    // Last first, so a change never moves the position of one still to come.
    const order = matches.map((m, i) => i).sort((i, j) => (matches[i].unit === matches[j].unit ? before(matches[j].cells[0], matches[i].cells[0]) : 0));
    for (const mi of order) {
      const m = matches[mi];
      const groups: { op: number; item: number; from: number; to: number; font: FontInfo }[] = [];
      for (const c of m.cells) {
        const g = groups[groups.length - 1];
        if (g && g.op === c.op && g.item === c.item && g.to === c.at) g.to = c.at + 1;
        else groups.push({ op: c.op, item: c.item, from: c.at, to: c.at + 1, font: c.font });
      }
      for (let gi = groups.length - 1; gi >= 0; gi -= 1) {
        const g = groups[gi];
        const pieces = piecesOf(m.unit, g.op);
        const piece = pieces[g.item];
        if (!piece || !("s" in piece)) continue;
        const len = g.font.len;
        const head = piece.s.slice(0, g.from * len);
        const tail = piece.s.slice(g.to * len);
        const put: number[] = [];
        let adjust: number | null = null;
        if (gi === 0 && inPlace) {
          for (const ch of chars) {
            const code = editable(g.font, ch)!;
            for (let k = len - 1; k >= 0; k -= 1) put.push(Math.floor(code / 256 ** k) % 256);
          }
        } else if (tail.length > 0) {
          // The words after stay where they were: move on by what was taken out.
          let total = 0;
          let known = true;
          for (let at = g.from; at < g.to; at += 1) {
            let code = 0;
            for (let k = 0; k < len; k += 1) code = code * 256 + piece.s[at * len + k];
            const w = g.font.width(code);
            if (w === null) known = false;
            else total += w;
          }
          if (known) adjust = total;
          else result.notes.push(`${JSON.stringify(edit.find)}: the font does not give its letter widths, so text after it on the same line may sit a little to the left.`);
        }
        const replacement: Piece[] = [{ s: [...head, ...put] }];
        if (adjust !== null && adjust !== 0) replacement.push({ n: -adjust });
        replacement.push({ s: tail });
        pieces.splice(g.item, 1, ...replacement);
      }
      if (!inPlace && edit.with) {
        const box = positions[mi];
        const first = m.cells[0];
        result.draws.push({
          x: box.x + 0.5, y: box.y + 0.5, size: Math.max(4, Math.round(((box.h - 1) / 1.15) * 10) / 10), text: edit.with,
          color: first.color, font: first.font.family, bold: first.font.bold, italic: first.font.italic,
        });
      }
    }
    result.changed.push({ find: edit.find, with: edit.with, matches: matches.length, how: inPlace ? "in place" : "redrawn" });

    // Put the changed strings into their streams and read them again.
    for (const entry of units) {
      const ops = pending.get(entry.unit);
      if (!ops || ops.size === 0) continue;
      let out = "";
      let at = 0;
      entry.unit.ops.forEach((op, i) => {
        const p = ops.get(i);
        if (!p) return;
        out += entry.unit.src.slice(at, op.s) + render(op, p);
        at = op.e;
      });
      out += entry.unit.src.slice(at);
      entry.unit = build(entry.source, out);
    }
  }

  for (const entry of units) if (entry.unit.src !== entry.original) writeSource(doc, entry.source, entry.unit.src);
  return result;
}
