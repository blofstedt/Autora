import { useEffect, useRef, useState } from "react";

/**
 * Where the agent just worked on a page, played back: a labelled cursor
 * arrives, the old words are struck through, the new ones are typed, and it
 * fades. The file is already changed when this runs -- it is a replay laid over
 * the page, never the edit itself, and it takes no pointer events.
 *
 * Positions are points from the page's top-left, scaled the way every other
 * object in the editor's layer is.
 */
export interface Cue {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  from: string;
  to: string;
}

type Phase = "arrive" | "strike" | "type" | "hold";

const ARRIVE_MS = 550;
const STRIKE_MS = 650;
const HOLD_MS = 550;
/** All of a cue's typing takes about this long, however long the words are. */
const TYPE_TOTAL_MS = 1400;

export function AgentCues({
  cues, seq, page, scale, onDone,
}: { cues: Cue[]; seq: number; page: number; scale: number; onDone: () => void }) {
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState<Phase>("arrive");
  const [typed, setTyped] = useState(0);
  const [landed, setLanded] = useState(false);
  const cue = cues[i];
  // Held in a ref: the caller passes a fresh function each render, and a timer
  // restarted by every render would never finish.
  const done = useRef(onDone);
  done.current = onDone;

  // A new run starts again from the first place.
  useEffect(() => {
    setI(0);
    setPhase("arrive");
    setTyped(0);
    setLanded(false);
  }, [seq]);

  useEffect(() => {
    if (!cue) {
      done.current();
      return;
    }
    const next = () => {
      setI((n) => n + 1);
      setPhase("arrive");
      setTyped(0);
      setLanded(false);
    };
    // Another page's change is not shown here.
    if (cue.page !== page) {
      const t = setTimeout(next, 30);
      return () => clearTimeout(t);
    }
    if (phase === "arrive") {
      const move = requestAnimationFrame(() => setLanded(true));
      const t = setTimeout(() => setPhase(cue.from ? "strike" : "type"), ARRIVE_MS);
      return () => { cancelAnimationFrame(move); clearTimeout(t); };
    }
    if (phase === "strike") {
      const t = setTimeout(() => setPhase("type"), STRIKE_MS);
      return () => clearTimeout(t);
    }
    if (phase === "type") {
      if (typed >= cue.to.length) {
        setPhase("hold");
        return;
      }
      const t = setTimeout(() => setTyped((n) => n + 1), Math.max(14, Math.min(40, TYPE_TOTAL_MS / Math.max(1, cue.to.length))));
      return () => clearTimeout(t);
    }
    const t = setTimeout(next, HOLD_MS);
    return () => clearTimeout(t);
  }, [cue, phase, typed, page]);

  if (!cue || cue.page !== page) return null;

  const size = Math.max(6, (cue.h / 1.15) * scale);
  const left = cue.x * scale;
  const top = cue.y * scale;
  const showing = phase === "arrive" ? "" : phase === "strike" ? cue.from : cue.to.slice(0, typed);
  return (
    <div
      aria-hidden="true"
      data-agent-cue={`${phase}`}
      style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none", zIndex: 60 }}
    >
      {phase !== "arrive" && (
        <div
          data-agent-cue-text
          style={{
            position: "absolute", left: left - 3, top: top - 2, minWidth: cue.w * scale + 6, minHeight: cue.h * scale + 4,
            padding: "1px 3px", background: "#fff", borderRadius: 3, whiteSpace: "nowrap", color: "#111",
            fontFamily: "Helvetica, Arial, sans-serif", fontSize: size, lineHeight: `${cue.h * scale}px`,
            boxShadow: "0 0 0 2px rgba(124, 92, 255, 0.6)",
            textDecoration: phase === "strike" ? "line-through" : "none",
            textDecorationColor: "#d33", opacity: phase === "hold" ? 0.92 : 1,
          }}
        >
          {showing}
          {phase === "type" && <span style={{ borderRight: "2px solid #7c5cff", marginLeft: 1 }} />}
        </div>
      )}
      <div
        style={{
          position: "absolute", left: 0, top: 0, willChange: "transform",
          transform: landed || phase !== "arrive"
            ? `translate(${left + Math.min(cue.w * scale, 24)}px, ${top + cue.h * scale * 0.7}px)`
            : `translate(${left - 70}px, ${top - 55}px)`,
          transition: `transform ${ARRIVE_MS}ms cubic-bezier(.2,.8,.2,1)`,
        }}
      >
        <svg width="16" height="20" viewBox="0 0 16 20" style={{ display: "block", filter: "drop-shadow(0 1px 2px rgba(0,0,0,.35))" }}>
          <path d="M1 1 L1 15 L5 11.5 L8 18 L10.5 17 L7.5 10.5 L13 10.5 Z" fill="#7c5cff" stroke="#fff" strokeWidth="1.2" strokeLinejoin="round" />
        </svg>
        <span
          style={{
            position: "absolute", left: 14, top: 14, padding: "1px 6px", borderRadius: 8, background: "#7c5cff", color: "#fff",
            font: "600 10px/14px Inter, system-ui, sans-serif", whiteSpace: "nowrap",
          }}
        >
          Autora
        </span>
      </div>
    </div>
  );
}
