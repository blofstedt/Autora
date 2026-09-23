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
  const split = rest.indexOf("\n\nText:\n");
  const elementPart = split >= 0 ? rest.slice(0, split) : rest;
  const textPart = split >= 0 ? rest.slice(split + "\n\nText:\n".length) : "";
  const lines = (part: string) =>
    part.split("\n").filter((l) => l.trim() !== "" && !APPENDED.test(l));
  return { title: head[1], url: head[2], elements: lines(elementPart), text: lines(textPart) };
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
      "Anything not listed here is exactly as it was there, element numbers included.",
    "",
  ];

  /* Elements are compared position by position, because the numbers are
     positions: an element whose line is the same at the same place keeps its
     number, and every one that differs is listed with the number it has now. */
  const changed: string[] = [];
  const shared = Math.min(base.elements.length, next.elements.length);
  for (let i = 0; i < shared; i += 1) {
    if (next.elements[i] !== base.elements[i]) changed.push(next.elements[i]);
  }
  changed.push(...next.elements.slice(shared));
  // A CAPTCHA line is always worth repeating: the model acts on it.
  for (const line of next.elements) {
    if (line.startsWith("CAPTCHA") && !changed.includes(line)) changed.push(line);
  }
  if (changed.length === 0 && next.elements.length === base.elements.length) {
    lines.push("Interactive elements: unchanged.");
  } else {
    lines.push("Interactive elements that differ (numbers as they are now):", ...changed);
    if (next.elements.length < base.elements.length) {
      lines.push(
        next.elements.length === 0
          ? "There are no interactive elements any more."
          : `The list now ends after ${next.elements.length} lines; everything after that in the earlier list is gone.`,
      );
    }
  }

  const gone = minus(base.text, next.text);
  const added = minus(next.text, base.text);
  lines.push("");
  if (gone.length === 0 && added.length === 0) {
    lines.push("Text: unchanged.");
  } else {
    if (gone.length) lines.push("Text no longer on the page:", ...gone.map((l) => `- ${l}`));
    if (added.length) lines.push("New text:", ...added.map((l) => `+ ${l}`));
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
