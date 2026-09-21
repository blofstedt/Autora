import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { ansiToLines, ansiToText } from "../lib/ansi";
import { IconCheck, IconChevron, IconTerminal, IconX } from "./Icons";

/** Lines shown before the card folds the middle away. Long enough to read a
    test run's tail without a build's ten thousand lines owning the screen. */
const FOLD_AT = 24;

/**
 * One command, where it was run.
 *
 * The terminal used to be a single pane showing the newest thing only, so the
 * command that mattered had scrolled away by the time you looked. Each call
 * now keeps its own output, in place, for as long as the conversation exists.
 */
export function TerminalCell({
  command, output, status, exitCode, durationMs, live,
}: {
  command: string;
  output: string;
  status: "running" | "ok" | "error" | "denied";
  exitCode: number | null;
  durationMs: number | null;
  live: boolean;
}) {
  const [expanded, setExpanded] = useState(false);
  const [copied, setCopied] = useState(false);
  const bodyRef = useRef<HTMLPreElement>(null);

  const lines = useMemo(() => ansiToLines(output), [output]);
  const folded = !expanded && lines.length > FOLD_AT;
  const shown = folded ? lines.slice(lines.length - FOLD_AT) : lines;

  // While it runs, the end is the interesting part.
  useLayoutEffect(() => {
    if (!live || expanded) return;
    const el = bodyRef.current;
    if (el) el.scrollTop = el.scrollHeight;
  }, [output, live, expanded]);

  useEffect(() => {
    if (!copied) return;
    const timer = window.setTimeout(() => setCopied(false), 1400);
    return () => window.clearTimeout(timer);
  }, [copied]);

  const failed = status === "error" || (exitCode !== null && exitCode !== 0);

  return (
    <section className={`cell term ${failed ? "is-bad" : ""}`}>
      <header className="cell-top">
        <IconTerminal size={13} />
        <code className="term-cmd" title={command}>{command || "terminal"}</code>
        <div className="spacer" />
        {status === "running" ? (
          <em className="cell-chip is-running">running</em>
        ) : failed ? (
          <em className="cell-chip is-bad">
            <IconX size={11} />
            {exitCode !== null ? `exit ${exitCode}` : "failed"}
          </em>
        ) : (
          <em className="cell-chip"><IconCheck size={11} /> done</em>
        )}
        {durationMs !== null && <em className="cell-at">{ms(durationMs)}</em>}
        <button
          className="cell-act"
          onClick={() => {
            void navigator.clipboard?.writeText(ansiToText(output)).then(
              () => setCopied(true), () => undefined);
          }}
          title="Copy output"
        >
          {copied ? "copied" : "copy"}
        </button>
      </header>

      {lines.length > 0 && (
        <>
          {folded && (
            <button className="term-more" onClick={() => setExpanded(true)}>
              <IconChevron size={11} />
              {lines.length - FOLD_AT} earlier lines
            </button>
          )}
          <pre className={`term-body ${expanded ? "is-open" : ""}`} ref={bodyRef}>
            {shown.map((spans, i) => (
              <div key={i} className="term-line">
                {spans.length === 0 ? " " : spans.map((s, j) => (
                  <span
                    key={j}
                    style={{
                      color: s.color,
                      background: s.bg,
                      fontWeight: s.bold ? 650 : undefined,
                      opacity: s.dim ? 0.65 : undefined,
                      textDecoration: s.underline ? "underline" : undefined,
                    }}
                  >
                    {s.text}
                  </span>
                ))}
              </div>
            ))}
          </pre>
        </>
      )}
      {lines.length === 0 && status !== "running" && (
        <p className="cell-quiet">no output</p>
      )}
    </section>
  );
}

const ms = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}s` : `${Math.round(value)}ms`;
