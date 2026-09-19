import { useEffect, useRef, useState } from "react";
import type { TranscriptTurn } from "../lib/derive";
import { IconChevron, IconSpark, IconUser } from "./Icons";

/** The conversation. Reasoning is available but collapsed -- present, not loud. */
export function Transcript({ turns, busy }: { turns: TranscriptTurn[]; busy: boolean }) {
  const endRef = useRef<HTMLDivElement>(null);
  useEffect(() => {
    endRef.current?.scrollIntoView({ block: "end", behavior: "smooth" });
  }, [turns.length, turns[turns.length - 1]?.text.length, busy]);

  if (turns.length === 0 && !busy) {
    return (
      <div className="empty">
        <span className="empty-ring"><IconSpark size={20} /></span>
        <h3>Ready</h3>
        <p>Describe a task below. You will see every step as it happens.</p>
      </div>
    );
  }

  return (
    <div className="transcript">
      {turns.map((turn) => <Message key={turn.seq} turn={turn} />)}
      {busy && (
        <div className="working">
          <span className="bar" />
          working
        </div>
      )}
      <div ref={endRef} />
    </div>
  );
}

function Message({ turn }: { turn: TranscriptTurn }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`msg ${turn.role}`}>
      <span className="avatar">
        {turn.role === "user" ? <IconUser size={14} /> : <IconSpark size={14} />}
      </span>
      <div className="msg-body">
        <div className="msg-who">{turn.role === "user" ? "you" : "autora"}</div>
        {turn.thinking && (
          <>
            <button
              className={`reason-toggle ${open ? "open" : ""}`}
              onClick={() => setOpen(!open)}
            >
              <IconChevron size={11} />
              {open ? "hide reasoning" : "reasoning"}
            </button>
            {open && <pre className="reason-body">{turn.thinking}</pre>}
          </>
        )}
        {turn.text && <div className="msg-text">{turn.text}</div>}
      </div>
    </div>
  );
}
