import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { Bucket, Cell, KanbanTask, MemoryTouch } from "../lib/derive";
import { IconAlert, IconArrowDown, IconChevron, IconUser } from "./Icons";
import { AutoraMark } from "./AutoraMark";
import { TerminalCell } from "./TerminalCell";
import { ScreencastCell } from "./ScreencastCell";
import { FileCell } from "./FileCell";
import { ToolCell } from "./ToolCell";
import { KanbanCell } from "./KanbanCell";
import { PermissionCell } from "./PermissionCell";
import { ImageCell } from "./ImageCell";
import { WidgetCell } from "./WidgetCell";
import { AskCell } from "./AskCell";
import { Markdown } from "./Markdown";
import { JevCell } from "./JevCell";
import { MemoryCell } from "./MemoryCell";
import { LearnedCell } from "./LearnedCell";

/** Within this many pixels of the bottom counts as "watching the live edge". */
const STICK_ZONE = 80;

/**
 * The conversation, and the work, in one column.
 *
 * There is no stage under this and no scrubber beside it. A command, a page,
 * a desktop and a diff each appear inline at the point the agent reached for
 * them, so reading the thread from the top is reviewing the session -- and
 * reviewing does not mean putting the whole app into the past, which was the
 * old model's real cost: you could not look back at step 12 while the agent
 * carried on at step 300.
 */
export function Thread({
  buckets,
  busy,
  sessionId,
  liveBrowserSeq,
  live,
  onPermissionDecide,
  onRunAutonomous,
  ...work
}: {
  buckets: Bucket[];
  busy: boolean;
  sessionId: string;
  liveBrowserSeq: number | null;
  live: boolean;
  onPermissionDecide?: (requestId: string, approved: boolean, response?: string) => void;
  onRunAutonomous?: (task: KanbanTask) => void;
} & WorkState) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const [unread, setUnread] = useState(false);
  // While the page in the thread is yours to use, the thread holds still:
  // following the live edge would slide the page out from under your finger
  // every time it repaints.
  const handsOn = work.browserHandedOver;
  const handsOnRef = useRef(handsOn);
  handsOnRef.current = handsOn;
  useEffect(() => {
    if (handsOn) setStuck(false);
  }, [handsOn]);

  const count = buckets.length;
  const tail = buckets[buckets.length - 1];
  const tailLength =
    (tail?.replies.reduce((n, r) => n + r.text.length, 0) ?? 0) + (tail?.cells.length ?? 0);
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

  /** Where the scroller was last time, so a scroll that was not the reader's
      doing can be told from one that was. */
  const lastTop = useRef(0);

  const onScroll = useCallback(() => {
    const el = scrollerRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight <= STICK_ZONE;
    const wentUp = el.scrollTop < lastTop.current;
    lastTop.current = el.scrollTop;
    if (atBottom && !handsOnRef.current) { setStuck(true); setUnread(false); return; }
    // Only scrolling up lets go of the live edge. A smooth scroll to the
    // bottom reports every frame on the way down as "not at the bottom", and
    // unsticking on those meant the thread stopped following itself halfway
    // through the animation -- then an image decoded, the content grew, and
    // the reader was left a card behind with a New messages pill they never
    // asked for.
    if (wentUp) setStuck(false);
  }, []);

  // Watch the content, not just the viewport: a screenshot decoding a beat
  // after its card renders grows the thread under whoever is reading the live
  // edge, and without this they are quietly left an image behind.
  // `count` is in the deps for a reason that is not obvious: the first render
  // of an empty session returns the placeholder, so there is no scroller to
  // observe yet, and an effect keyed only on `stuck` never runs again to find
  // one. The thread then never followed anything it had not laid out by the
  // time the first event arrived -- which, once cards carried images, was most
  // of it.
  useEffect(() => {
    const el = scrollerRef.current;
    const content = contentRef.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => { if (stuck) toBottom("auto"); });
    observer.observe(el);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [stuck, toBottom, count]);

  if (buckets.length === 0 && !busy) {
    return (
      <div className="empty">
        <AutoraMark size={80} state="live" className="empty-mark" />
        <h3>Ready</h3>
        <p>
          Describe a task below. Every command, page and edit appears here as it
          happens, and stays here to read back.
        </p>
      </div>
    );
  }

  return (
    <div className="thread-wrap">
      <div className="thread" ref={scrollerRef} onScroll={onScroll}>
        <div className="thread-content" ref={contentRef}>
        {buckets.map((b) => (
          <TurnBucket
            key={b.seq}
            bucket={b}
            sessionId={sessionId}
            liveBrowserSeq={liveBrowserSeq}
            live={live}
            onPermissionDecide={onPermissionDecide}
            onRunAutonomous={onRunAutonomous}
            {...work}
          />
        ))}
        {busy && <div className="working"><span className="bar" />working</div>}
        </div>
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

/** What the thread needs to know about who is at the wheel right now. */
type WorkState = {
  /** The agent is working and not waiting on the person. */
  driving: boolean;
  /** The agent handed the browser over and is waiting for them. */
  browserHandedOver: boolean;
  onStop: () => void;
  /** Opens the Mind page, from a memory named in the thread. */
  onOpenMind?: () => void;
};

function TurnBucket({
  bucket,
  sessionId,
  liveBrowserSeq,
  live,
  onPermissionDecide,
  onRunAutonomous,
  ...work
}: {
  bucket: Bucket;
  sessionId: string;
  liveBrowserSeq: number | null;
  live: boolean;
  onPermissionDecide?: (requestId: string, approved: boolean, response?: string) => void;
  onRunAutonomous?: (task: KanbanTask) => void;
} & WorkState) {
  // The agent's mark animates on its current utterance for as long as the turn
  // runs. Keyed to the last *reply* rather than the last cell: a tool card
  // landing after the reply does not mean the agent has stopped, and anchoring
  // to the last cell made the mark settle the moment one appeared -- a finish
  // in the middle of the work.
  const speaking = bucket.cells.map((c) => c.kind).lastIndexOf("reply");

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

      <div className="work">
        {bucket.cells.map((cell, index) => (
          <CellView
            key={`${cell.kind}-${cell.seq}-${index}`}
            cell={cell}
            sessionId={sessionId}
            liveBrowserSeq={liveBrowserSeq}
            live={live}
            open={bucket.open}
            active={bucket.open && index === speaking}
            onPermissionDecide={onPermissionDecide}
            onRunAutonomous={onRunAutonomous}
            {...work}
          />
        ))}
      </div>
    </article>
  );
}

function CellView({
  cell,
  sessionId,
  liveBrowserSeq,
  live,
  open,
  active,
  onPermissionDecide,
  onRunAutonomous,
  driving,
  browserHandedOver,
  onStop,
  onOpenMind,
}: {
  cell: Cell;
  sessionId: string;
  liveBrowserSeq: number | null;
  live: boolean;
  open: boolean;
  active: boolean;
  onPermissionDecide?: (requestId: string, approved: boolean, response?: string) => void;
  onRunAutonomous?: (task: KanbanTask) => void;
} & WorkState) {
  switch (cell.kind) {
    case "reply":
      return (
        <Reply
          text={cell.turn.text}
          thinking={cell.turn.thinking}
          memories={cell.memories}
          working={active}
          onOpenMind={onOpenMind}
        />
      );
    case "terminal":
      return (
        <TerminalCell
          command={cell.command}
          output={cell.output}
          status={cell.status}
          exitCode={cell.exitCode}
          durationMs={cell.durationMs}
          live={open && cell.status === "running"}
        />
      );
    case "screen": {
      const current = cell.source === "browser" && cell.seq === liveBrowserSeq;
      return (
        <ScreencastCell
          sessionId={sessionId}
          source={cell.source}
          url={cell.url}
          shots={cell.shots}
          actions={cell.actions}
          live={cell.live}
          // Only the newest browser card is looking at a page that still
          // exists, so it is the only one the live feed belongs to -- an older
          // card showing the current page would be a lie about what happened.
          followsFeed={current}
          current={live && current}
          driving={driving}
          waitingOnYou={browserHandedOver}
          onStop={onStop}
        >
          {cell.log.length > 0 && cell.log.map((inner, index) => (
            <CellView
              key={`${inner.kind}-${inner.seq}-${index}`}
              cell={inner}
              sessionId={sessionId}
              liveBrowserSeq={liveBrowserSeq}
                live={live}
              open={open}
              // The newest thing said, while the page is still being worked.
              active={cell.live && index === cell.log.length - 1}
              onPermissionDecide={onPermissionDecide}
              onRunAutonomous={onRunAutonomous}
              driving={driving}
              browserHandedOver={browserHandedOver}
              onStop={onStop}
              onOpenMind={onOpenMind}
            />
          ))}
        </ScreencastCell>
      );
    }
    case "memory":
      return <MemoryCell cell={cell} onOpen={onOpenMind} />;
    case "learned":
      return <LearnedCell items={cell.items} changes={cell.changes} onOpen={onOpenMind} />;
    case "jev":
      return <JevCell decision={cell.decision} />;
    case "ask":
      return <AskCell ask={cell.ask} sessionId={sessionId} readOnly={!live} />;
    case "images":
      return <ImageCell sessionId={sessionId} pictures={cell.pictures} />;
    case "widget":
      return <WidgetCell widget={cell.widget} sessionId={sessionId} canFix={live && !driving} />;
    case "file":
      return <FileCell file={cell.file} />;
    case "tool":
      return <ToolCell span={cell.span} />;
    case "kanban":
      return (
        <KanbanCell
          board={cell.board}
          sessionId={sessionId}
          onRunAutonomous={onRunAutonomous}
        />
      );
    case "permission":
      return (
        <PermissionCell
          prompt={cell.prompt}
          readOnly={!live}
          onDecide={(reqId, approved, resp) => {
            if (onPermissionDecide) {
              onPermissionDecide(reqId, approved, resp);
            }
          }}
        />
      );
    case "note":
      return (
        <div className={`cell-note tone-${cell.tone}`}>
          {cell.tone !== "plain" && <IconAlert size={13} />}
          <span>{cell.text}</span>
        </div>
      );
  }
}

/**
 * What the agent said, with its reasoning one tap away.
 *
 * Folded by default, live turn included: the reply is what you came for, and
 * reasoning that unfolds itself shoves the reply off the screen as it lands.
 */
function Reply({
  text,
  thinking,
  memories = [],
  working,
  onOpenMind,
}: {
  text: string;
  thinking?: string;
  memories?: MemoryTouch[];
  onOpenMind?: () => void;
  /** Still being written. The mark animates while this holds and plays its
      own ending when it drops, so the reply visibly lands rather than just
      stopping. */
  working?: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (!text && !thinking && memories.length === 0) return null;

  return (
    <div className={`msg agent ${working ? "is-working" : ""}`.trim()}>
      <span className="avatar">
        <AutoraMark size={27} state={working ? "working" : "rest"} />
      </span>
      <div className="msg-body">
        <div className="msg-who">autora</div>
        {thinking && (
          <>
            <button
              className={`reason-toggle ${open ? "open" : ""}`}
              onClick={() => setOpen(!open)}
              aria-expanded={open}
            >
              <IconChevron size={11} />
              {open ? "hide reasoning" : "reasoning"}
            </button>
            {open && <pre className="reason-body">{thinking}</pre>}
          </>
        )}
        {memories.map((m, index) => (
          <MemoryCell key={index} cell={m} onOpen={onOpenMind} inline />
        ))}
        {text && <div className="msg-text is-md"><Markdown text={text} /></div>}
      </div>
    </div>
  );
}
