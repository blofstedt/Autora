import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Bucket, TranscriptTurn } from "../lib/derive";
import { elapsed, labelFor, summarize, toneOf } from "../lib/describe";
import type { AutoraEvent } from "../lib/types";
import { IconArrowDown, IconChevron, IconSpark, IconUser } from "./Icons";

/** Within this many pixels of the bottom counts as "watching the live edge". */
const STICK_ZONE = 80;

/**
 * The conversation, one prompt at a time.
 *
 * Each request carries the work it caused: the steps fold away under the
 * prompt that produced them, so the thread reads as a conversation and the
 * detail is one tap down rather than in a separate rail you had to correlate
 * by eye. Every turn starts folded, the one in flight included: the reply is
 * what you came for, and reasoning that unfolds itself is reasoning that
 * shoves the reply off the screen while you are reading it.
 */
export function Thread({
  buckets, busy, startedAt, onSeek,
}: {
  buckets: Bucket[];
  busy: boolean;
  startedAt: number;
  onSeek: (seq: number) => void;
}) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const [unread, setUnread] = useState(false);

  const count = buckets.length;
  const tail = buckets[buckets.length - 1];
  const tailLength =
    (tail?.replies.reduce((n, r) => n + r.text.length, 0) ?? 0) + (tail?.steps.length ?? 0);
  const prevCount = useRef(count);

  const toBottom = useCallback((behavior: ScrollBehavior) => {
    const el = scrollerRef.current;
    if (el) el.scrollTo({ top: el.scrollHeight, behavior });
  }, []);

  // Layout effect so the jump happens in the same frame the content grows --
  // in a plain effect the reader sees one frame at the old offset.
  useLayoutEffect(() => {
    const isNewTurn = count !== prevCount.current;
    prevCount.current = count;
    if (!stuck) {
      if (isNewTurn || tailLength) setUnread(true);
      return;
    }
    // A whole new turn is worth an animated move; a token landing is not, and
    // re-targeting a smooth scroll 40 times a second feels seasick.
    toBottom(isNewTurn ? "smooth" : "auto");
  }, [count, tailLength, busy, stuck, toBottom]);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_ZONE;
    setStuck(atBottom);
    if (atBottom) setUnread(false);
  }, []);

  useEffect(() => {
    const el = scrollerRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (stuck) toBottom("auto"); });
    observer.observe(el);
    return () => observer.disconnect();
  }, [stuck, toBottom]);

  if (buckets.length === 0 && !busy) {
    return (
      <div className="empty">
        <span className="empty-ring"><IconSpark size={20} /></span>
        <h3>Ready</h3>
        <p>Describe a task below. You will see every step as it happens.</p>
      </div>
    );
  }

  return (
    <div className="thread-wrap">
      <div className="thread" ref={scrollerRef} onScroll={onScroll}>
        {buckets.map((b) => (
          <TurnBucket key={b.seq} bucket={b} startedAt={startedAt} onSeek={onSeek} />
        ))}
        {busy && <div className="working"><span className="bar" />working</div>}
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

function TurnBucket({
  bucket, startedAt, onSeek,
}: {
  bucket: Bucket;
  startedAt: number;
  onSeek: (seq: number) => void;
}) {
  // Collapsed until someone asks for it, live turn included. Reasoning is the
  // detail behind the answer rather than the answer, and a panel that opens
  // itself every turn pushes the reply off a phone screen exactly as it lands.
  // The live pip on the toggle is how you can tell there is something in there
  // without it taking the screen to say so.
  const [open, setOpen] = useState(false);

  return (
    <article className="turn">
      {bucket.prompt && (
        <div className="msg user">
          <span className="avatar"><IconUser size={14} /></span>
          <div className="msg-body">
            <div className="msg-who">you</div>
            <div className="msg-text">{bucket.prompt}</div>
          </div>
        </div>
      )}

      {/* One disclosure per turn, carrying both what the agent thought and
          what it did. They were two toggles in two places saying two halves of
          the same thing, and the steps sat under the prompt as though the
          person had taken them. */}
      {bucket.replies.length > 0 ? (
        bucket.replies.map((r, index) => (
          <Reply
            key={r.seq}
            turn={r}
            steps={index === 0 ? bucket.steps : []}
            live={index === 0 && bucket.open}
            open={index === 0 ? open : undefined}
            onToggle={index === 0 ? () => setOpen(!open) : undefined}
            startedAt={startedAt}
            onSeek={onSeek}
          />
        ))
      ) : (
        // A turn that has acted but not yet spoken still has reasoning to show.
        bucket.steps.length > 0 && (
          <Reply
            turn={{ role: "agent", text: "", seq: bucket.seq }}
            steps={bucket.steps}
            live={bucket.open}
            open={open}
            onToggle={() => setOpen(!open)}
            startedAt={startedAt}
            onSeek={onSeek}
          />
        )
      )}
    </article>
  );
}

function StepRow({
  event, startedAt, onSeek,
}: {
  event: AutoraEvent;
  startedAt: number;
  onSeek: (seq: number) => void;
}) {
  const [open, setOpen] = useState(false);
  const tone = toneOf(event);
  return (
    <button
      className={`step ${tone ? `tone-${tone}` : ""} ${open ? "is-open" : ""}`}
      onClick={() => { setOpen(!open); onSeek(event.seq); }}
      title={`seq ${event.seq}`}
    >
      <span className="step-label">{labelFor(event)}</span>
      <span className="step-text">{summarize(event)}</span>
      <span className="step-at">+{elapsed(event.ts, startedAt)}</span>
    </button>
  );
}

function Reply({
  turn, steps = [], live = false, open, onToggle, startedAt = 0, onSeek,
}: {
  turn: TranscriptTurn;
  steps?: AutoraEvent[];
  live?: boolean;
  /** Undefined for replies that carry no steps: those own their own state. */
  open?: boolean;
  onToggle?: () => void;
  startedAt?: number;
  onSeek?: (seq: number) => void;
}) {
  const [ownOpen, setOwnOpen] = useState(false);
  const isOpen = open ?? ownOpen;
  const toggle = onToggle ?? (() => setOwnOpen(!ownOpen));
  const hasReasoning = !!turn.thinking || steps.length > 0;

  return (
    <div className="msg agent">
      <span className="avatar"><IconSpark size={14} /></span>
      <div className="msg-body">
        <div className="msg-who">autora</div>
        {hasReasoning && (
          <>
            <button
              className={`reason-toggle ${isOpen ? "open" : ""}`}
              onClick={toggle}
              aria-expanded={isOpen}
            >
              <IconChevron size={11} />
              {isOpen ? "hide reasoning" : "reasoning"}
              {steps.length > 0 && <em className="reason-count">{steps.length}</em>}
              {live && <em className="steps-live" />}
            </button>
            {isOpen && (
              <div className="reason-open">
                {turn.thinking && <pre className="reason-body">{turn.thinking}</pre>}
                {steps.length > 0 && onSeek && (
                  <div className="steps-body">
                    {steps.map((e) => (
                      <StepRow key={e.seq} event={e} startedAt={startedAt} onSeek={onSeek} />
                    ))}
                  </div>
                )}
              </div>
            )}
          </>
        )}
        {turn.text && <div className="msg-text">{turn.text}</div>}
      </div>
    </div>
  );
}
