import { memo, useEffect, useState } from "react";
import type { AgentLook } from "../lib/agentlook";
import { AutoraMark } from "./AutoraMark";
import { Markdown } from "./Markdown";

/** Quiet this long and the line says so: the agent is probably inside one long step, or stuck. */
const QUIET_MS = 60_000;

const span = (ms: number): string => {
  const s = Math.max(0, Math.round(ms / 1000));
  return s < 60 ? `${s}s` : `${Math.floor(s / 60)}m ${String(s % 60).padStart(2, "0")}s`;
};

/**
 * An agent of the Organization speaking up as it is called: its own mark (shape
 * and colour), moving the way Autora's does -- building while it works, then the
 * settle bloom as it reports back -- and a line saying what it has taken on.
 * While it works, a second line says what it is doing now and how many steps it
 * has taken, and when it has said nothing new for a minute, how long it has been
 * quiet: the person can tell a long step from a stall.
 */
export const ChimeCell = memo(function ChimeCell({ name, role, look, text, report, ok, working, progress }: {
  name: string;
  role: string;
  look: AgentLook | null;
  text: string;
  /** What it said when it finished: its own words, shown under the line that announced it. */
  report: string;
  ok: boolean;
  working: boolean;
  /** Its latest word on what it is doing; `at` in ms. */
  progress: { text: string; steps: number; at: number } | null;
}) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!working || !progress) return;
    setNow(Date.now());
    const id = window.setInterval(() => setNow(Date.now()), 5000);
    return () => window.clearInterval(id);
  }, [working, progress]);
  const quiet = working && progress ? now - progress.at : 0;
  return (
    <div className="cell-chime" role="status">
      <span className="chime-mark"><AutoraMark size={26} look={look} state={working ? "building" : "rest"} /></span>
      <div className="chime-body">
        <div className="chime-who">{name}{role ? <span> · {role}</span> : null}</div>
        <div className="chime-text">{text}</div>
        {working && progress && (
          <div className={`chime-progress${quiet >= QUIET_MS ? " is-quiet" : ""}`} aria-live="off">
            <span className="chime-now">{progress.text}</span>
            <span className="chime-meta">
              {progress.steps > 1 ? `${progress.steps} steps` : ""}
              {quiet >= QUIET_MS ? `${progress.steps > 1 ? " · " : ""}nothing new for ${span(quiet)}` : ""}
            </span>
          </div>
        )}
        {report && (
          <div className={`chime-report${ok ? "" : " is-bad"}`}>
            <Markdown text={report} />
          </div>
        )}
      </div>
    </div>
  );
});
