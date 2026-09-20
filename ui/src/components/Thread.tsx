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
 * by eye. The steps for the turn in flight are open, because that is the one
 * you are watching; finished turns collapse to a single line.
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
  // Undefined means "follow the turn": open while it runs, shut once it lands.
  // A deliberate toggle pins it, so a turn finishing does not close something
  // being read.
  const [pinned, setPinned] = useState<boolean | undefined>(undefined);
  const open = pinned ?? bucket.open;

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

      {bucket.steps.length > 0 && (
        <div className={`steps ${open ? "on" : ""}`}>
          <button
            className="steps-toggle"
            onClick={() => setPinned(!open)}
            aria-expanded={open}
          >
            <IconChevron size={11} />
            {bucket.steps.length} step{bucket.steps.length === 1 ? "" : "s"}
            {bucket.open && <em className="steps-live" />}
          </button>

          {open && (
            <div className="steps-body">
              {bucket.steps.map((e) => (
                <StepRow key={e.seq} event={e} startedAt={startedAt} onSeek={onSeek} />
              ))}
            </div>
          )}
        </div>
      )}

      {bucket.replies.map((r) => <Reply key={r.seq} turn={r} />)}
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

function Reply({ turn }: { turn: TranscriptTurn }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="msg agent">
      <span className="avatar"><IconSpark size={14} /></span>
      <div className="msg-body">
        <div className="msg-who">autora</div>
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
