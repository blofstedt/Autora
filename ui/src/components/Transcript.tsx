import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { TranscriptTurn } from "../lib/derive";
import { IconArrowDown, IconChevron, IconSpark, IconUser } from "./Icons";

/** Within this many pixels of the bottom counts as "watching the live edge". */
const STICK_ZONE = 80;

/**
 * The conversation. Reasoning is available but collapsed -- present, not loud.
 *
 * Auto-scroll is conditional on the reader already being at the bottom. Pinning
 * unconditionally is the obvious implementation and the wrong one: text deltas
 * arrive dozens of times a second, so scrolling up to re-read something during a
 * stream turns into a fight with the scroll position. Leave the bottom and the
 * pane holds still; a pill appears instead, and clicking it hands the live edge
 * back.
 */
export function Transcript({ turns, busy }: { turns: TranscriptTurn[]; busy: boolean }) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const [unread, setUnread] = useState(false);

  const last = turns[turns.length - 1];
  const turnCount = turns.length;
  const tailLength = last?.text.length ?? 0;
  const prevCount = useRef(turnCount);

  const toBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollerRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Layout effect so the jump happens in the same frame the content grows --
  // in a plain effect the reader sees one frame of the pane at the old offset.
  useLayoutEffect(() => {
    const isNewTurn = turnCount !== prevCount.current;
    prevCount.current = turnCount;
    if (!stuck) {
      if (isNewTurn || tailLength) setUnread(true);
      return;
    }
    // A whole new turn is worth an animated move; a token landing is not, and
    // re-targeting a smooth scroll 40 times a second is what makes a streaming
    // pane feel seasick.
    toBottom(isNewTurn ? "smooth" : "auto");
  }, [turnCount, tailLength, busy, stuck, toBottom]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const distance = el.scrollHeight - el.scrollTop - el.clientHeight;
    const atBottom = distance <= STICK_ZONE;
    setStuck(atBottom);
    if (atBottom) setUnread(false);
  }, []);

  // Re-check after the pane resizes (the composer grows as you type, the mobile
  // keyboard opens), or "stuck" goes stale and the view silently unpins.
  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (stuck) toBottom("auto");
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [stuck, toBottom]);

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
    <div className="transcript-wrap">
      <div className="transcript" ref={scrollerRef} onScroll={onScroll}>
        {turns.map((turn) => <Message key={turn.seq} turn={turn} />)}
        {busy && (
          <div className="working">
            <span className="bar" />
            working
          </div>
        )}
      </div>

      <button
        className={`jump-pill ${unread && !stuck ? "on" : ""}`}
        onClick={() => { setStuck(true); setUnread(false); toBottom("smooth"); }}
        tabIndex={unread && !stuck ? 0 : -1}
        aria-hidden={!(unread && !stuck)}
      >
        <IconArrowDown size={12} />
        New messages
      </button>
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
              aria-expanded={open}
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
