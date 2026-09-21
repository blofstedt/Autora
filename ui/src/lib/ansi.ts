/**
 * PTY bytes → styled lines.
 *
 * The terminal used to live in one docked pane with a real emulator behind it.
 * Now each command shows its own output where it was run, in the conversation,
 * and a page carrying thirty live emulators is a page that stutters -- so the
 * stream is folded here instead, once, into lines the browser can paint like
 * any other text.
 *
 * It is a small terminal rather than a filter: `\r` overwrites, erase-in-line
 * clears, and colour is carried through, because that is what the difference
 * between a progress bar and four hundred lines of soup comes down to. What it
 * does not do is full cursor addressing -- a log that grows downward has no
 * screen to address -- so a full-screen program (vim, top) renders as its
 * successive states rather than as one repainting window.
 */

export type AnsiSpan = { text: string; color?: string; bold?: boolean; dim?: boolean;
                         underline?: boolean; bg?: string };
export type AnsiLine = AnsiSpan[];

/** The same palette the docked terminal used, so recordings look unchanged. */
const BASE = [
  "#0e1016", "#fb7185", "#34d399", "#fbbf24", "#818cf8", "#c084fc", "#22d3ee", "#c8cedd",
  "#626a7e", "#fda4af", "#6ee7b7", "#fcd34d", "#a5b4fc", "#d8b4fe", "#67e8f9", "#edeff5",
];

function xterm256(n: number): string {
  if (n < 16) return BASE[n];
  if (n < 232) {
    const i = n - 16;
    const steps = [0, 95, 135, 175, 215, 255];
    const r = steps[Math.floor(i / 36) % 6];
    const g = steps[Math.floor(i / 6) % 6];
    const b = steps[i % 6];
    return `rgb(${r},${g},${b})`;
  }
  const v = 8 + (n - 232) * 10;
  return `rgb(${v},${v},${v})`;
}

type Style = { color?: string; bg?: string; bold?: boolean; dim?: boolean; underline?: boolean };
type Cell = { ch: string; style: Style };

const EMPTY: Style = {};

function sameStyle(a: Style, b: Style): boolean {
  return a.color === b.color && a.bg === b.bg && a.bold === b.bold
    && a.dim === b.dim && a.underline === b.underline;
}

function applySgr(style: Style, params: number[]): Style {
  let next: Style = { ...style };
  for (let i = 0; i < params.length; i++) {
    const p = params[i];
    if (p === 0) next = {};
    else if (p === 1) next.bold = true;
    else if (p === 2) next.dim = true;
    else if (p === 4) next.underline = true;
    else if (p === 22) { next.bold = false; next.dim = false; }
    else if (p === 24) next.underline = false;
    else if (p >= 30 && p <= 37) next.color = BASE[p - 30];
    else if (p >= 90 && p <= 97) next.color = BASE[p - 90 + 8];
    else if (p >= 40 && p <= 47) next.bg = BASE[p - 40];
    else if (p >= 100 && p <= 107) next.bg = BASE[p - 100 + 8];
    else if (p === 39) next.color = undefined;
    else if (p === 49) next.bg = undefined;
    else if (p === 38 || p === 48) {
      // 5;n = 256 colour, 2;r;g;b = truecolour.
      const mode = params[i + 1];
      if (mode === 5) {
        const value = xterm256(params[i + 2] ?? 7);
        if (p === 38) next.color = value; else next.bg = value;
        i += 2;
      } else if (mode === 2) {
        const value = `rgb(${params[i + 2] ?? 0},${params[i + 3] ?? 0},${params[i + 4] ?? 0})`;
        if (p === 38) next.color = value; else next.bg = value;
        i += 4;
      }
    }
  }
  return next;
}

export function ansiToLines(data: string, maxLines = 1200): AnsiLine[] {
  const lines: Cell[][] = [[]];
  let row = 0;
  let col = 0;
  let style: Style = EMPTY;

  const line = () => {
    while (lines.length <= row) lines.push([]);
    return lines[row];
  };
  const put = (ch: string) => {
    const current = line();
    while (current.length < col) current.push({ ch: " ", style: EMPTY });
    current[col] = { ch, style };
    col++;
  };

  for (let i = 0; i < data.length; i++) {
    const ch = data[i];

    if (ch === "\x1b") {
      const next = data[i + 1];
      if (next === "[") {
        // CSI: parameters, then one final byte.
        let j = i + 2;
        let raw = "";
        while (j < data.length && !/[@-~]/.test(data[j])) raw += data[j++];
        const final = data[j];
        const params = raw.replace(/^\?/, "").split(";").map((p) => parseInt(p, 10) || 0);
        const n = params[0] ?? 0;
        if (final === "m") style = applySgr(style, raw.startsWith("?") ? [0] : params);
        else if (final === "K") {
          const current = line();
          if (n === 0) current.length = Math.min(current.length, col);
          else if (n === 1) for (let k = 0; k < col && k < current.length; k++) current[k] = { ch: " ", style: EMPTY };
          else current.length = 0;
        } else if (final === "J") {
          // A clear-screen starts a fresh block rather than erasing what has
          // already scrolled past -- in a transcript, history is the point.
          if (n === 2 || n === 3) { lines.length = 0; lines.push([]); row = 0; col = 0; }
          else lines.length = row + 1;
        } else if (final === "A") row = Math.max(0, row - Math.max(1, n));
        else if (final === "B") row = row + Math.max(1, n);
        else if (final === "C") col = col + Math.max(1, n);
        else if (final === "D") col = Math.max(0, col - Math.max(1, n));
        else if (final === "G") col = Math.max(0, n - 1);
        else if (final === "H" || final === "f") col = Math.max(0, (params[1] ?? 1) - 1);
        i = j === undefined ? data.length : j;
        continue;
      }
      if (next === "]") {
        // OSC: runs to BEL or ST.
        let j = i + 2;
        while (j < data.length && data[j] !== "\x07"
               && !(data[j] === "\x1b" && data[j + 1] === "\\")) j++;
        i = data[j] === "\x1b" ? j + 1 : j;
        continue;
      }
      i += 1; // two-character escapes: charset selection, keypad mode, …
      continue;
    }

    if (ch === "\n") { row++; col = 0; line(); continue; }
    if (ch === "\r") { col = 0; continue; }
    if (ch === "\b") { col = Math.max(0, col - 1); continue; }
    if (ch === "\t") { const stop = col + (8 - (col % 8)); while (col < stop) put(" "); continue; }
    if (ch < " " || ch === "\x7f") continue;
    put(ch);
  }

  // A runaway build must not be able to make the page unscrollable; the tail is
  // where the error is, so that is the end that is kept.
  const kept = lines.length > maxLines ? lines.slice(lines.length - maxLines) : lines;

  return kept.map((cells) => {
    const spans: AnsiLine = [];
    for (const cell of cells) {
      const last = spans[spans.length - 1];
      if (last && sameStyle(last as Style, cell.style)) last.text += cell.ch;
      else spans.push({ text: cell.ch, ...cell.style });
    }
    return spans;
  });
}

/** Plain text, for copying and for measuring how much there is. */
export const ansiToText = (data: string): string =>
  ansiToLines(data, 100000).map((line) => line.map((s) => s.text).join("")).join("\n");
