/**
 * Saying less about a page the model has already seen.
 *
 * Every browser action answers with the whole page: title, URL, the numbered
 * elements and up to six thousand characters of text. After a click on a page
 * the model read a moment ago, most of that is the same as last time. Here a
 * snapshot is compared with the last full one the model still has, and when
 * the difference is small only the difference is sent -- every element whose
 * line changed, with its current number, and the text that came or went.
 * Nothing is guessed or summarised: what is left out is exactly what is
 * unchanged from a snapshot that is still in front of the model.
 *
 * Also here: taking the whitespace out of pretty-printed JSON, which is
 * lossless and a large share of any API response.
 */

/** A full snapshot: "Page: ...\nURL: ...\n[Snapshot: #n\n]\nInteractive elements:". */
const FULL = /(^|\n)Page: [^\n]*\nURL: [^\n]*\n(?:Snapshot: (#\d+)\n)?\nInteractive elements:/;
/** A difference: "Page: ...\nURL: ...\nChanges since page snapshot #n above". */
const DIFF = /(^|\n)Page: [^\n]*\nURL: [^\n]*\nChanges since page snapshot (#\d+) above/;

export interface Snapshot {
  title: string;
  url: string;
  /** The numbered element lines, and any CAPTCHA lines under them. */
  elements: string[];
  /** The line introducing the text, which says which part it is. */
  textHead: string;
  text: string[];
}

export type Found =
  | { kind: "full"; at: number; id: string | null }
  | { kind: "diff"; at: number; base: string };

/** Where a page snapshot or difference starts in a tool result, if anywhere. */
export function findPage(result: string): Found | null {
  const full = FULL.exec(result);
  if (full) return { kind: "full", at: full.index + full[1].length, id: full[2] ?? null };
  const diff = DIFF.exec(result);
  if (diff) return { kind: "diff", at: diff.index + diff[1].length, base: diff[2] };
  return null;
}

/** Notes the console appends to results; not part of the page. */
const APPENDED = /^\[(Loop check|Checkpoint)\]/;

/** Read a full snapshot back into its parts. */
export function parseSnapshot(snapshot: string): Snapshot | null {
  const head = /^Page: ([^\n]*)\nURL: ([^\n]*)\n(?:Snapshot: #\d+\n)?\nInteractive elements:\n/.exec(snapshot);
  if (!head) return null;
  const rest = snapshot.slice(head[0].length);
  const split = /\n\n(Text(?: \([^\n]*\))?:)\n/.exec(rest);
  const elementPart = split ? rest.slice(0, split.index) : rest;
  const textPart = split ? rest.slice(split.index + split[0].length) : "";
  const lines = (part: string) =>
    part.split("\n").filter((l) => l.trim() !== "" && !APPENDED.test(l));
  return {
    title: head[1], url: head[2], elements: lines(elementPart),
    textHead: split ? split[1] : "Text:", text: lines(textPart),
  };
}

/** Tag a full snapshot with its id, so a later difference can point at it. */
export function tagSnapshot(snapshot: string, id: string): string {
  return snapshot.replace(/^(Page: [^\n]*\nURL: [^\n]*\n)/, `$1Snapshot: ${id}\n`);
}

function origin(url: string): string | null {
  try {
    return new URL(url).origin;
  } catch {
    return null;
  }
}

/** Lines in `a` that are not in `b`, counting repeats, in `a`'s order. */
function minus(a: string[], b: string[]): string[] {
  const left = new Map<string, number>();
  for (const line of b) left.set(line, (left.get(line) ?? 0) + 1);
  const out: string[] = [];
  for (const line of a) {
    const n = left.get(line) ?? 0;
    if (n > 0) left.set(line, n - 1);
    else out.push(line);
  }
  return out;
}

/**
 * The difference between two snapshots, written for the model, or null when
 * sending the whole page is the better deal: a different site, or a change so
 * large the difference would be most of the page anyway.
 */
export function diffSnapshots(base: Snapshot, baseId: string, next: Snapshot, full: string): string | null {
  const from = origin(base.url);
  if (!from || from !== origin(next.url)) return null;

  const lines = [
    `Page: ${next.title || "(untitled)"}`,
    `URL: ${next.url}`,
    `Changes since page snapshot ${baseId} above${next.url === base.url ? "" : ` (${base.url})`}. ` +
      "Anything not listed here is exactly as it was there.",
    "",
  ];

  /* Element numbers stay put wherever the page is scrolled, so a line is
     the same element at both reads exactly when the line itself is the same.
     Lines that are new are listed whole; those that went are named by number. */
  const added = minus(next.elements, base.elements);
  const numberOf = (line: string) => /^\[(\d+)\]/.exec(line)?.[1] ?? null;
  const addedNumbers = new Set(added.map(numberOf).filter(Boolean));
  const went = minus(base.elements, next.elements)
    .map(numberOf)
    .filter((n): n is string => n !== null && !addedNumbers.has(n));
  // A CAPTCHA line is always worth repeating: the model acts on it.
  for (const line of next.elements) {
    if (line.startsWith("CAPTCHA") && !added.includes(line)) added.push(line);
  }
  if (added.length === 0 && went.length === 0) {
    lines.push("Interactive elements on screen: unchanged.");
  } else {
    if (added.length) lines.push("Interactive elements on screen that are new or changed:", ...added);
    if (went.length) lines.push(`No longer on screen, or gone: ${went.map((n) => `[${n}]`).join(", ")}.`);
  }

  // A different part of the text is a different text, not a change to it.
  if (next.textHead !== base.textHead) return null;
  const gone = minus(base.text, next.text);
  const arrived = minus(next.text, base.text);
  lines.push("");
  if (gone.length === 0 && arrived.length === 0) {
    lines.push("Text: unchanged.");
  } else {
    if (gone.length) lines.push("Text no longer on the page:", ...gone.map((l) => `- ${l}`));
    if (arrived.length) lines.push("New text:", ...arrived.map((l) => `+ ${l}`));
  }

  const diff = lines.join("\n");
  return diff.length < full.length * 0.5 ? diff : null;
}

/**
 * Pretty-printed JSON with the whitespace between tokens taken out. Only
 * when the whole output is valid JSON, and only whitespace outside strings is
 * touched, so every value comes through byte for byte.
 */
export function compactJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.length < 200 || !/^[[{]/.test(trimmed) || !/\n\s/.test(trimmed)) return text;
  try {
    JSON.parse(trimmed);
  } catch {
    return text;
  }
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of trimmed) {
    if (inString) {
      out += ch;
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === "\"") inString = false;
    } else if (ch === "\"") {
      inString = true;
      out += ch;
    } else if (ch !== " " && ch !== "\n" && ch !== "\r" && ch !== "\t") {
      out += ch;
    }
  }
  return out;
}

/** Characters of page text the model is given at a time: about 1,500 tokens. */
export const TEXT_PART_CHARS = 6000;

/**
 * Page text cut into parts the model can ask for one at a time, each ending
 * at a line break where there is one near the limit, so no part ends
 * mid-sentence when it need not.
 */
export function textParts(text: string, size = TEXT_PART_CHARS): string[] {
  const parts: string[] = [];
  let rest = text.trim();
  while (rest.length > size) {
    let cut = rest.lastIndexOf("\n", size);
    if (cut < size * 0.6) cut = rest.lastIndexOf(" ", size);
    if (cut < size * 0.6) cut = size;
    parts.push(rest.slice(0, cut).trim());
    rest = rest.slice(cut).trim();
  }
  if (rest || parts.length === 0) parts.push(rest);
  return parts;
}

/** An element found in HTML, by offsets into it. */
interface Element {
  name: string;
  attrs: string;
  start: number;
  innerStart: number;
  innerEnd: number;
  end: number;
}

const VOID = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"]);

/**
 * Every element in some HTML, opening tags matched to closing ones. Not a
 * full parser -- it trusts the markup to be roughly balanced, which pages
 * served to browsers are -- but it knows which </div> closes which <div>,
 * which is what cutting a section out whole needs.
 */
function elementsOf(html: string): Element[] {
  const out: Element[] = [];
  const open: Element[] = [];
  const tag = /<(\/?)([a-zA-Z][\w-]*)\b([^>]*)>/g;
  let m: RegExpExecArray | null;
  while ((m = tag.exec(html))) {
    const name = m[2].toLowerCase();
    if (!m[1]) {
      const el: Element = { name, attrs: m[3], start: m.index, innerStart: m.index + m[0].length, innerEnd: -1, end: -1 };
      if (VOID.has(name) || m[3].trim().endsWith("/")) {
        el.innerEnd = el.innerStart;
        el.end = el.innerStart;
        out.push(el);
      } else {
        open.push(el);
      }
      continue;
    }
    // A closing tag closes the nearest open element of its name, and any
    // left unclosed inside it with it.
    const at = open.map((e) => e.name).lastIndexOf(name);
    if (at < 0) continue;
    while (open.length > at) {
      const el = open.pop()!;
      el.innerEnd = m.index;
      el.end = m.index + m[0].length;
      out.push(el);
    }
  }
  for (const el of open) {
    el.innerEnd = html.length;
    el.end = html.length;
    out.push(el);
  }
  return out.sort((a, b) => a.start - b.start);
}

const attr = (attrs: string, name: string) =>
  new RegExp(`\\b${name}\\s*=\\s*["']([^"']*)["']`, "i").exec(attrs)?.[1] ?? "";

const MENU_ROLES = new Set(["navigation", "banner", "contentinfo", "complementary", "search"]);
/** Class or id words that mark a menu, a table of contents, a language list
    or a cookie notice -- the furniture repeated around a site's content. */
const MENU_WORDS = /(^|[\s_-])(nav|navbar|navigation|menu|sidebar|breadcrumbs?|toc|lang|languages|footer|cookie|cookies|skip)([\s_-]|$)/i;

const textLength = (chunk: string) => chunk.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim().length;

/**
 * The part of a page worth reading: its <main>, [role=main] or <article>
 * when that holds a fair share of the text, with navigation, asides, menus
 * and the like cut out of whatever is kept.
 */
function mainContent(html: string): string {
  const elements = elementsOf(html);
  const total = textLength(html);
  const main =
    elements.find((e) => e.name === "main" || attr(e.attrs, "role").toLowerCase() === "main") ??
    elements.find((e) => e.name === "article");
  let from = 0;
  let to = html.length;
  if (main && textLength(html.slice(main.innerStart, main.innerEnd)) >= Math.min(400, total * 0.3)) {
    from = main.innerStart;
    to = main.innerEnd;
  }
  const inside = from > 0 || to < html.length;

  const cut: Array<[number, number]> = [];
  for (const el of elements) {
    if (el.start < from || el.end > to) continue;
    if (cut.length && el.start < cut[cut.length - 1][1]) continue;
    const menu =
      el.name === "nav" || el.name === "aside" || el.name === "footer" ||
      // A header outside the main content is the site's; inside, the article's own.
      (el.name === "header" && !inside) ||
      MENU_ROLES.has(attr(el.attrs, "role").toLowerCase()) ||
      MENU_WORDS.test(`${attr(el.attrs, "class")} ${attr(el.attrs, "id")}`);
    if (menu) cut.push([el.start, el.end]);
  }

  let kept = "";
  let at = from;
  for (const [a, b] of cut) {
    kept += html.slice(at, a);
    at = b;
  }
  kept += html.slice(at, to);
  // Cutting that leaves almost nothing cut too much; the page as it was.
  return textLength(kept) >= 200 ? kept : html.slice(from, to);
}

const ENTITIES: Record<string, string> = {
  amp: "&", lt: "<", gt: ">", quot: "\"", apos: "'", nbsp: " ", "#39": "'",
  mdash: "\u2014", ndash: "\u2013", hellip: "\u2026", rsquo: "\u2019", lsquo: "\u2018",
  rdquo: "\u201d", ldquo: "\u201c", copy: "\u00a9", reg: "\u00ae", middot: "\u00b7",
};

function decode(text: string): string {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (whole, name: string) => {
    if (name[0] === "#") {
      const code = name[1] === "x" || name[1] === "X" ? parseInt(name.slice(2), 16) : Number(name.slice(1));
      return Number.isFinite(code) && code > 0 && code < 0x110000 ? String.fromCodePoint(code) : whole;
    }
    return ENTITIES[name.toLowerCase()] ?? whole;
  });
}

/**
 * A web page's HTML as the readable text a person would get from it: the
 * main content, headings marked, list items bulleted, links kept with where
 * they go. Scripts, styles and the site's own menus are left out -- on a
 * typical article they are nine tenths of the file and none of the meaning.
 */
export function htmlToText(html: string, baseUrl = ""): string {
  let doc = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript|svg|template|head|iframe|canvas)\b[\s\S]*?<\/\1\s*>/gi, "");

  doc = mainContent(doc);

  // Preformatted text keeps its spacing: it is usually code.
  const kept: string[] = [];
  doc = doc.replace(/<pre\b[^>]*>([\s\S]*?)<\/pre\s*>/gi, (_, inner: string) => {
    kept.push(decode(inner.replace(/<[^>]+>/g, "")));
    return `\n\u0000${kept.length - 1}\u0000\n`;
  });

  const absolute = (href: string) => {
    try {
      return baseUrl ? new URL(href, baseUrl).href : href;
    } catch {
      return href;
    }
  };

  doc = doc
    .replace(/<a\b[^>]*?href\s*=\s*["']([^"']*)["'][^>]*>([\s\S]*?)<\/a\s*>/gi, (whole, href: string, inner: string) => {
      const label = inner.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
      if (!label) return "";
      if (!href || href.startsWith("#") || /^javascript:/i.test(href)) return label;
      return `${label} (${absolute(decode(href))})`;
    })
    .replace(/<h([1-6])\b[^>]*>/gi, (_, level: string) => `\n\n${"#".repeat(Number(level))} `)
    .replace(/<\/h[1-6]\s*>/gi, "\n")
    .replace(/<li\b[^>]*>/gi, "\n- ")
    .replace(/<(td|th)\b[^>]*>/gi, " | ")
    .replace(/<br\s*\/?>/gi, "\n")
    .replace(/<\/?(p|div|section|tr|table|ul|ol|dl|dt|dd|blockquote|figure|figcaption|form|fieldset)\b[^>]*>/gi, "\n")
    .replace(/<[^>]+>/g, "");

  const text = decode(doc)
    .split("\n")
    .map((line) => line.replace(/[ \t\u00a0]+/g, " ").trim())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  return text.replace(/\u0000(\d+)\u0000/g, (_, i: string) => kept[Number(i)] ?? "");
}
