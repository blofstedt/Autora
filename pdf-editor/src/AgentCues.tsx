import { useEffect, useRef, useState } from "react";

/**
 * The agent working on a page, played over it: a labelled cursor arrives and
 * does what the agent did -- retypes some words, types a new text box, clicks
 * to place a stamp or a signature, drags out a box, traces a stroke -- with
 * the toolbar showing the tool it would have picked up. The objects it placed
 * are held back until the moment its cursor "lands" them, so they appear as
 * the editor's own objects, in the editor's own rendering, at the end of the
 * motion.
 *
 * It is a presentation of an edit that has already been made: the file and the
 * objects are the server's, authorship stays with the agent (so the changes
 * are still marked for the person to accept or decline), and nothing here takes
 * a pointer event. Positions are points from the page's top-left, scaled as
 * every other object in this layer is.
 */

export type CueTool = "text" | "highlighter" | "draw" | "shape" | "note" | "stamp" | "signature" | "image" | "redact";
export type CueAct = "retype" | "type" | "place" | "drag" | "draw";

export interface Cue {
  page: number;
  x: number;
  y: number;
  w: number;
  h: number;
  from: string;
  to: string;
  act: CueAct;
  tool: CueTool;
  /** An object held back until this cue lands it. */
  itemId?: string;
  /** For a stroke: where it passes, in points. */
  points?: { x: number; y: number }[];
}

type Phase = "arrive" | "strike" | "type" | "click" | "move" | "hold";

const ARRIVE_MS = 520;
const STRIKE_MS = 650;
const CLICK_MS = 380;
const MOVE_MS = 800;
const HOLD_MS = 520;
/** All of a cue's typing takes about this long, however long the words are. */
const TYPE_TOTAL_MS = 1400;

/** What comes after each phase, for each kind of action. */
function after(act: CueAct, phase: Phase, hasFrom: boolean): Phase | null {
  switch (act) {
    case "retype":
      return phase === "arrive" ? (hasFrom ? "strike" : "type") : phase === "strike" ? "type" : phase === "type" ? "hold" : null;
    case "type":
      return phase === "arrive" ? "type" : phase === "type" ? "hold" : null;
    case "place":
      return phase === "arrive" ? "click" : phase === "click" ? "hold" : null;
    case "drag":
    case "draw":
      return phase === "arrive" ? "move" : phase === "move" ? "hold" : null;
  }
}

/** The objects are landed as the motion ends. */
const landsOn = (act: CueAct, phase: Phase) => phase === "hold" && act !== "retype";

export function AgentCues({
  cues, seq, page, scale, onDone, onReveal, onTool,
}: {
  cues: Cue[];
  seq: number;
  page: number;
  scale: number;
  onDone: () => void;
  onReveal: (id: string) => void;
  onTool: (tool: CueTool | null) => void;
}) {
  const [i, setI] = useState(0);
  const [phase, setPhase] = useState<Phase>("arrive");
  const [typed, setTyped] = useState(0);
  const [t, setT] = useState(0);
  const [landed, setLanded] = useState(false);
  const cue = cues[i];

  // Held in refs: the caller passes fresh functions each render, and a timer
  // restarted by every render would never finish.
  const done = useRef(onDone);
  done.current = onDone;
  const reveal = useRef(onReveal);
  reveal.current = onReveal;
  const tool = useRef(onTool);
  tool.current = onTool;

  // A new run starts again from the first place.
  useEffect(() => {
    setI(0);
    setPhase("arrive");
    setTyped(0);
    setT(0);
    setLanded(false);
  }, [seq]);

  // The toolbar shows what the agent is using, for as long as it uses it.
  useEffect(() => {
    tool.current(cue && cue.page === page ? cue.tool : null);
    return () => tool.current(null);
  }, [cue, page]);

  useEffect(() => {
    if (!cue) {
      done.current();
      return;
    }
    const next = () => {
      setI((n) => n + 1);
      setPhase("arrive");
      setTyped(0);
      setT(0);
      setLanded(false);
    };
    // Another page's change is not shown here; what it placed just appears.
    if (cue.page !== page) {
      if (cue.itemId) reveal.current(cue.itemId);
      const timer = setTimeout(next, 30);
      return () => clearTimeout(timer);
    }
    if (landsOn(cue.act, phase) && cue.itemId) reveal.current(cue.itemId);

    if (phase === "arrive") {
      const move = requestAnimationFrame(() => setLanded(true));
      const timer = setTimeout(() => setPhase(after(cue.act, "arrive", Boolean(cue.from)) ?? "hold"), ARRIVE_MS);
      return () => { cancelAnimationFrame(move); clearTimeout(timer); };
    }
    if (phase === "strike") {
      const timer = setTimeout(() => setPhase("type"), STRIKE_MS);
      return () => clearTimeout(timer);
    }
    if (phase === "type") {
      if (typed >= cue.to.length) {
        setPhase(after(cue.act, "type", false) ?? "hold");
        return;
      }
      const timer = setTimeout(() => setTyped((n) => n + 1), Math.max(14, Math.min(40, TYPE_TOTAL_MS / Math.max(1, cue.to.length))));
      return () => clearTimeout(timer);
    }
    if (phase === "click") {
      const timer = setTimeout(() => setPhase("hold"), CLICK_MS);
      return () => clearTimeout(timer);
    }
    if (phase === "move") {
      // A drag or a stroke, as a number from 0 to 1.
      const started = performance.now();
      const id = setInterval(() => {
        const p = Math.min(1, (performance.now() - started) / MOVE_MS);
        setT(p);
        if (p >= 1) {
          clearInterval(id);
          setPhase("hold");
        }
      }, 30);
      return () => clearInterval(id);
    }
    const timer = setTimeout(next, HOLD_MS);
    return () => clearTimeout(timer);
  }, [cue, phase, typed, page]);

  if (!cue || cue.page !== page) return null;

  const size = Math.max(6, (cue.h / 1.15) * scale);
  const left = cue.x * scale;
  const top = cue.y * scale;
  const w = cue.w * scale;
  const h = cue.h * scale;

  // Where the cursor is: arriving, then wherever the action takes it.
  const pts = cue.points ?? [];
  let cursor = { x: left + Math.min(w, 24), y: top + h * 0.7 };
  if (cue.act === "place") cursor = { x: left + w / 2, y: top + h / 2 };
  if (cue.act === "drag" && phase !== "arrive") cursor = { x: left + w * (phase === "hold" ? 1 : t), y: top + h * (phase === "hold" ? 1 : t) };
  if (cue.act === "draw" && pts.length > 1 && phase !== "arrive") {
    const p = pts[Math.min(pts.length - 1, Math.floor((phase === "hold" ? 1 : t) * (pts.length - 1)))];
    cursor = { x: p.x * scale, y: p.y * scale };
  }
  const start = cue.act === "drag" ? { x: left, y: top } : cue.act === "draw" && pts[0] ? { x: pts[0].x * scale, y: pts[0].y * scale } : cursor;
  const placed = landed || phase !== "arrive";
  const showing = phase === "arrive" ? "" : phase === "strike" ? cue.from : cue.to.slice(0, typed);
  const textual = cue.act === "retype" || cue.act === "type";
  const progress = phase === "hold" ? 1 : phase === "move" ? t : 0;

  return (
    <div
      aria-hidden="true"
      data-agent-cue={`${phase}`}
      data-agent-act={cue.act}
      data-agent-tool={cue.tool}
      style={{ position: "absolute", left: 0, top: 0, width: 0, height: 0, pointerEvents: "none", zIndex: 60 }}
    >
      {textual && phase !== "arrive" && (
        <div
          data-agent-cue-text
          style={{
            position: "absolute", left: left - 3, top: top - 2, minWidth: w + 6, minHeight: h + 4,
            padding: "1px 3px", background: cue.act === "retype" ? "#fff" : "rgba(255,255,255,0.85)", borderRadius: 3,
            whiteSpace: "nowrap", color: "#111", fontFamily: "Helvetica, Arial, sans-serif", fontSize: size, lineHeight: `${h}px`,
            boxShadow: "0 0 0 2px rgba(124, 92, 255, 0.6)",
            textDecoration: phase === "strike" ? "line-through" : "none",
            textDecorationColor: "#d33", opacity: phase === "hold" ? 0.92 : 1,
          }}
        >
          {showing}
          {phase === "type" && <span style={{ borderRight: "2px solid #7c5cff", marginLeft: 1 }} />}
        </div>
      )}

      {cue.act === "drag" && phase !== "arrive" && (
        <div
          data-agent-drag
          style={{
            position: "absolute", left, top, width: w * progress, height: h * progress,
            border: "2px dashed #7c5cff", background: "rgba(124, 92, 255, 0.12)", borderRadius: 2,
            opacity: phase === "hold" ? 0 : 1, transition: phase === "hold" ? "opacity 300ms" : "none",
          }}
        />
      )}

      {cue.act === "draw" && pts.length > 1 && phase !== "arrive" && (
        <svg
          data-agent-stroke
          style={{ position: "absolute", left: 0, top: 0, overflow: "visible", opacity: phase === "hold" ? 0 : 1, transition: phase === "hold" ? "opacity 300ms" : "none" }}
          width="1"
          height="1"
        >
          <polyline
            fill="none"
            stroke="#7c5cff"
            strokeWidth={3}
            strokeLinecap="round"
            strokeLinejoin="round"
            opacity={0.8}
            points={pts.slice(0, Math.max(2, Math.ceil(progress * pts.length))).map((p) => `${p.x * scale},${p.y * scale}`).join(" ")}
          />
        </svg>
      )}

      {cue.act === "place" && phase === "click" && (
        <div
          data-agent-click
          style={{
            position: "absolute", left: cursor.x - 14, top: cursor.y - 14, width: 28, height: 28, borderRadius: 14,
            border: "2px solid #7c5cff", animation: "agent-click 380ms ease-out forwards",
          }}
        />
      )}

      <div
        style={{
          position: "absolute", left: 0, top: 0, willChange: "transform",
          transform: placed
            ? `translate(${cursor.x}px, ${cursor.y}px)`
            : `translate(${start.x - 70}px, ${start.y - 55}px)`,
          transition: phase === "arrive" ? `transform ${ARRIVE_MS}ms cubic-bezier(.2,.8,.2,1)` : "none",
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
      <style>{"@keyframes agent-click { from { transform: scale(.4); opacity: 1 } to { transform: scale(1.6); opacity: 0 } }"}</style>
    </div>
  );
}
