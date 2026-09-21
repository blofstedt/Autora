import { useState } from "react";
import type { FileChange } from "../lib/derive";
import { IconChevron, IconFile } from "./Icons";

/** Hunks shown before the diff folds itself away. */
const FOLD_AT = 40;

/** One edit, as a reviewable diff, where the agent made it. */
export function FileCell({ file }: { file: FileChange }) {
  const [open, setOpen] = useState(true);
  const lines = file.diff ? file.diff.split("\n") : [];
  const [expanded, setExpanded] = useState(false);
  const folded = !expanded && lines.length > FOLD_AT;
  const shown = folded ? lines.slice(0, FOLD_AT) : lines;

  return (
    <section className="cell diff">
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
        <span className="stats">
          {file.created && <em className="tag">new</em>}
          <span className="plus">+{file.added}</span>
          <span className="minus">−{file.removed}</span>
        </span>
      </header>

      {open && lines.length > 0 && (
        <>
          <pre className="diff-code">
            {shown.map((line, i) => (
              <div key={i} className={lineClass(line)}>{line || " "}</div>
            ))}
          </pre>
          {folded && (
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
