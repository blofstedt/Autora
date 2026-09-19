import { useEffect, useRef, useState } from "react";
import type { TranscriptTurn } from "../lib/derive";

/** The conversation. Reasoning is collapsed by default -- available, not loud. */
export function Transcript({ turns, busy }: { turns: TranscriptTurn[]; busy: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end" });
  }, [turns.length, turns[turns.length - 1]?.text.length]);

  return (
    <div className="transcript">
      {turns.map((turn) => (
        <Turn key={turn.seq} turn={turn} />
      ))}
      {busy && <div className="thinking-dots">working</div>}
      <div ref={endRef} />
    </div>
  );
}

function Turn({ turn }: { turn: TranscriptTurn }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`turn ${turn.role}`}>
      {turn.thinking && (
        <div className="reasoning">
          <button className="reasoning-toggle" onClick={() => setOpen(!open)}>
            {open ? "hide" : "show"} reasoning
          </button>
          {open && <pre className="reasoning-body">{turn.thinking}</pre>}
        </div>
      )}
      <div className="turn-text">{turn.text}</div>
    </div>
  );
}
