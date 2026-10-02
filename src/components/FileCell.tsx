import { useCallback, useEffect, useRef, useState } from "react";
import type { FileChange } from "../lib/derive";
import { useAgentCursor } from "../lib/agentCursor";
import { IconChevron, IconFile, IconRotateCcw } from "./Icons";

/** Hunks shown before the diff folds itself away. */
const FOLD_AT = 40;
/** A card that arrived this recently is written out as it is watched. */
const FRESH_MS = 8_000;
/** The whole of it takes about this long, however much there is. */
const WRITE_MS = 1_600;
const TICK_MS = 16;

const reducedMotion = () => typeof window !== "undefined" && !!window.matchMedia?.("(prefers-reduced-motion: reduce)").matches;

/**
 * One edit, as a reviewable diff, where the agent made it.
 *
 * A card that has just arrived is written out as you watch: added lines are
 * typed, removed and unchanged ones appear as the cursor passes them. It is a
 * replay -- the code is already in the file -- so it can be played again from
 * the card, and is skipped when the agent cursor is switched off.
 */
export function FileCell({ file }: { file: FileChange }) {
  const [open, setOpen] = useState(true);
  const lines = file.diff ? file.diff.split("\n") : [];
  const [expanded, setExpanded] = useState(false);
  const folded = !expanded && lines.length > FOLD_AT;
  const shown = folded ? lines.slice(0, FOLD_AT) : lines;
  const [cursorOn] = useAgentCursor();

  /* How far the writing has got, in characters of the lines being typed; null
     once it is done (or was never played). */
  const total = shown.reduce((n, l) => n + (isAdded(l) ? l.length : 1), 0);
  const fresh = useRef(file.ts !== undefined && Date.now() - file.ts * 1000 < FRESH_MS);
  const [at, setAt] = useState<number | null>(() => (fresh.current && cursorOn && !reducedMotion() && lines.length > 0 ? 0 : null));
  const code = useRef<HTMLPreElement>(null);

  useEffect(() => {
    if (at === null) return;
    if (at >= total) {
      setAt(null);
      return;
    }
    const step = Math.max(1, Math.ceil(total / (WRITE_MS / TICK_MS)));
    const t = setTimeout(() => setAt((n) => (n === null ? null : n + step)), TICK_MS);
    return () => clearTimeout(t);
  }, [at, total]);

  // Keep the line being written in view.
  useEffect(() => {
    if (at !== null && code.current) code.current.scrollTop = code.current.scrollHeight;
  }, [at]);

  const replay = useCallback(() => {
    setOpen(true);
    setAt(0);
  }, []);

  // What is on show at this point: whole lines up to the one being typed.
  let rows: { text: string; typing: boolean }[] = shown.map((text) => ({ text, typing: false }));
  if (at !== null) {
    rows = [];
    let left = at;
    for (const text of shown) {
      const cost = isAdded(text) ? text.length : 1;
      if (left >= cost) {
        rows.push({ text, typing: false });
        left -= cost;
        continue;
      }
      rows.push({ text: isAdded(text) ? text.slice(0, Math.max(1, left)) : text, typing: true });
      break;
    }
  }
  const writing = at !== null;

  return (
    <section className="cell diff" data-writing={writing ? "true" : undefined}>
      <header className="cell-top">
        <button
          className={`diff-name ${open ? "on" : ""}`}
          onClick={() => setOpen((v) => !v)}
          aria-expanded={open}
        >
          <IconChevron size={11} />
          <IconFile size={13} />
          <span className="dir">{dirOf(file.path)}</span>
          <b>{baseOf(file.path)}</b>
        </button>
        <div className="spacer" />
        {writing && <span className="diff-writing" aria-live="polite">Autora is writing…</span>}
        {lines.length > 0 && !writing && (
          <button className="diff-replay" onClick={replay} title="Watch it being written again" aria-label="Replay this change">
            <IconRotateCcw size={12} />
          </button>
        )}
        <span className="stats">
          {file.created && <em className="tag">new</em>}
          {file.note && <em className="tag">{file.note}</em>}
          <span className="plus">+{file.added}</span>
          <span className="minus">−{file.removed}</span>
        </span>
      </header>

      {open && lines.length > 0 && (
        <>
          <pre className="diff-code" ref={code}>
            {rows.map((row, i) => (
              <div key={i} className={lineClass(row.text)}>
                {row.text || " "}
                {row.typing && <span className="diff-caret" data-typing aria-hidden="true"><i>Autora</i></span>}
              </div>
            ))}
          </pre>
          {folded && !writing && (
            <button className="term-more" onClick={() => setExpanded(true)}>
              <IconChevron size={11} />
              {lines.length - FOLD_AT} more lines
            </button>
          )}
        </>
      )}
    </section>
  );
}

const isAdded = (line: string) => line.startsWith("+") && !line.startsWith("+++");

const baseOf = (path: string) => path.split("/").filter(Boolean).pop() ?? path;

function dirOf(path: string): string {
  const parts = path.split("/").filter(Boolean);
  parts.pop();
  if (parts.length === 0) return "";
  // Keep the last two directories: deep absolute paths are mostly noise, and
  // the immediate parent is what actually disambiguates two same-named files.
  const tail = parts.slice(-2).join("/");
  return (parts.length > 2 ? "…/" : path.startsWith("/") ? "/" : "") + tail + "/";
}

function lineClass(line: string): string {
  if (line.startsWith("+++") || line.startsWith("---")) return "l-meta";
  if (line.startsWith("@@")) return "l-hunk";
  if (line.startsWith("+")) return "l-add";
  if (line.startsWith("-")) return "l-del";
  return "";
}
