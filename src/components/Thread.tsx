import { memo, useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import type { Bucket, Cell, KanbanTask, MemoryTouch } from "../lib/derive";
import { turnItems } from "../lib/steps";
import { isPicture, sizeLabel, type Attachment } from "../lib/attachments";
import { IconAlert, IconArrow, IconArrowDown, IconBrain, IconChevron, IconFile, IconSpeaker, IconSpeakerOff, IconTerminal, IconUser, IconWrench } from "./Icons";
import { sameReply } from "../lib/voice";
import { AutoraMark } from "./AutoraMark";
import type { MarkPhase } from "../lib/activity";
import { TerminalCell } from "./TerminalCell";
import { ScreencastCell } from "./ScreencastCell";
import { FileCell } from "./FileCell";
import { ToolCell, describeArgs } from "./ToolCell";
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
/** How long a touch counts as still on the thread after the finger has gone. */
const TOUCH_TAIL_MS = 260;

/** What the working line wears while the agent is busy: a brain while it is
    thinking, a wrench while it is doing. One glyph per phase, so a new phase
    is a new line here and nothing else. */
function phaseGlyph(phase: MarkPhase) {
  return phase === "thinking" ? <IconBrain size={15} /> : <IconWrench size={15} />;
}

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
  doing,
  phase = "thinking",
  sessionId,
  liveBrowserSeq,
  live,
  onPermissionDecide,
  onRunAutonomous,
  placeholder,
  dock,
  ...work
}: {
  buckets: Bucket[];
  /** What an empty session shows: the setup card, or tasks to start from. */
  placeholder?: ReactNode;
  /** The pinned corner widgets, if any: they sit in the pane's corners, over
      the margin rather than in the scroll. See components/Dock.tsx. */
  dock?: ReactNode;
  busy: boolean;
  /** What it is on right now, in a few words (see lib/activity.ts). */
  doing?: string | null;
  /** Which of the mark's two busy states that is: thinking or building. */
  phase?: MarkPhase;
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

  /**
   * Where the thread sits, readable from a handler that is not re-rendered.
   */
  const stuckRef = useRef(stuck);
  stuckRef.current = stuck;

  /**
   * A finger on the thread outranks the live edge.
   *
   * Following the bottom during a gesture is what the swipe at the end of a
   * working turn used to do: scroll events that had only gone a few pixels --
   * still inside the stick zone, so still "following" -- kept the thread
   * stuck, and every token, image or resize that landed while the finger was
   * moving scrolled it back to the bottom underneath it. The reader lost the
   * gesture and got a jitter instead, each yank feeding the next.
   *
   * So while a finger is down nothing moves the thread, and a drag that goes
   * up lets go of the live edge at any distance from the bottom, not just past
   * the stick zone. The flag is held a moment past the touch, because on a
   * phone the scroll keeps going after the finger has gone (momentum) and that
   * tail is the reader's too. One catch-up at the end: if the thread is still
   * following, it lands on the live edge where it would have been.
   */
  const finger = useRef(false);
  const fingerTimer = useRef<number | null>(null);

  const touchStart = useCallback(() => {
    if (fingerTimer.current !== null) {
      window.clearTimeout(fingerTimer.current);
      fingerTimer.current = null;
    }
    finger.current = true;
  }, []);

  const touchEnd = useCallback(() => {
    if (fingerTimer.current !== null) window.clearTimeout(fingerTimer.current);
    fingerTimer.current = window.setTimeout(() => {
      fingerTimer.current = null;
      finger.current = false;
      if (stuckRef.current) toBottom("auto");
    }, TOUCH_TAIL_MS);
  }, [toBottom]);

  useEffect(() => () => {
    if (fingerTimer.current !== null) window.clearTimeout(fingerTimer.current);
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
    // A finger on the thread is in charge of where it sits; the catch-up is
    // in touchEnd, once it has gone. A whole new turn is worth an animated
    // move; a token landing is not, and re-targeting a smooth scroll 40 times
    // a second feels seasick.
    if (!finger.current) toBottom(isNewTurn ? "smooth" : "auto");
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
    // The reader's own drag lets go of the live edge at any distance, inside
    // the stick zone included: re-sticking on the same gesture is what made a
    // swipe at the bottom jump back under the finger.
    if (wentUp && finger.current) { setStuck(false); setUnread(false); return; }
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
    const observer = new ResizeObserver(() => { if (stuck && !finger.current) toBottom("auto"); });
    observer.observe(el);
    if (content) observer.observe(content);
    return () => observer.disconnect();
  }, [stuck, toBottom, count]);

  if (buckets.length === 0 && !busy) {
    return (
      <div className="empty">
        {/* Still: the sidebar mark is the one that breathes at rest. */}
        <AutoraMark size={80} state="rest" className="empty-mark" />
        {placeholder ?? (
          <>
            <h3>I'm here.</h3>
            <p>Describe a task below and watch me do it here.</p>
          </>
        )}
      </div>
    );
  }

  return (
    <div className="thread-wrap">
      {dock}
      <div
        className="thread"
        ref={scrollerRef}
        onScroll={onScroll}
        onTouchStart={touchStart}
        onTouchEnd={touchEnd}
        onTouchCancel={touchEnd}
      >
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
            phase={phase}
          />
        ))}
        {busy && (
          <div className="working" aria-live="polite">
            {/* The line under the thread wears a glyph of its own, not the
                mark: the mark is the agent signing its own words, and a second
                one down here turned the brand into a progress spinner.
                Thinking is a brain, doing is a wrench -- see phaseGlyph. */}
            <span className="working-mark" aria-hidden="true">{phaseGlyph(phase)}</span>
            {/* Keyed on the words, so each new step fades in over the last
                rather than snapping -- a train of thought, not a counter. */}
            <span className="working-what" key={doing || "working"}>{doing || "Working"}</span>
          </div>
        )}
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
  /** Opens Settings on the model, from a reply that needs one connected. */
  onOpenSettings?: () => void;
  /** Reads one reply out loud, in the voice the page already speaks with. */
  onSpeakReply?: (text: string) => void;
  /** Which reply the voice is on, and whether it has been silenced -- so the
      speaker under it can be one button rather than a play button with a
      separate way to stop it. */
  speakingReply?: { text: string; muted: boolean } | null;
};

/* TurnBucket, CellView and Reply are memoised, and that is what keeps a long
   thread responsive: the cards App hands down are the same objects from one
   update to the next unless they changed (lib/share.ts), so while a reply
   streams only its own card is drawn again -- not every earlier reply's
   Markdown and every terminal above it. It relies on every prop being stable
   too: pass handlers made with useCallback, never an inline arrow. */
/**
 * What a message came with, under the words.
 *
 * The same artifacts the agent was handed, drawn where the person can see that
 * they went with this message rather than the one before it: a picture shows
 * itself, anything else shows its name and opens from there. Small on purpose
 * -- this is a receipt, not a gallery.
 */
const MessageFiles = memo(function MessageFiles({ files }: { files: Attachment[] }) {
  if (files.length === 0) return null;
  return (
    <div className="msg-files">
      {files.map((file) => (
        <a
          className="msg-file"
          key={file.id}
          href={`/api/artifacts/${file.id}`}
          target="_blank"
          rel="noreferrer"
          title={`${file.name} — ${sizeLabel(file.size)}`}
        >
          {isPicture(file.mime)
            ? <img src={`/api/artifacts/${file.id}`} alt={file.name} loading="lazy" />
            : <IconFile size={14} />}
          <span className="msg-file-name">{file.name}</span>
        </a>
      ))}
    </div>
  );
});

const TurnBucket = memo(function TurnBucket({
  bucket,
  sessionId,
  liveBrowserSeq,
  live,
  phase,
  onPermissionDecide,
  onRunAutonomous,
  ...work
}: {
  bucket: Bucket;
  sessionId: string;
  liveBrowserSeq: number | null;
  live: boolean;
  phase: MarkPhase;
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
      {(bucket.prompt || bucket.attachments.length > 0) && (
        <div className="msg user">
          <span className="avatar"><IconUser size={14} /></span>
          <div className="msg-body">
            <div className="msg-who">you</div>
            {bucket.prompt && <div className="msg-text">{bucket.prompt}</div>}
            <MessageFiles files={bucket.attachments} />
          </div>
        </div>
      )}

      <div className="work">
        <StepRun
          cells={bucket.cells}
          activeKey={bucket.open && speaking >= 0 ? cellKey(bucket.cells[speaking]) : null}
          sessionId={sessionId}
          liveBrowserSeq={liveBrowserSeq}
          live={live}
          open={bucket.open}
          phase={phase}
          onPermissionDecide={onPermissionDecide}
          onRunAutonomous={onRunAutonomous}
          {...work}
        />
      </div>
    </article>
  );
});

/**
 * Who a cell is, for React: the event that started it.
 *
 * Not its position. The thread regroups cells while a turn runs -- what is
 * said on a page moves into that page's card -- and a key with the index in
 * it then named a different cell, so React tore the card down and built a
 * new one. For the browser that meant a blank stage for a beat: the black
 * flash in the middle of the conversation.
 */
function cellKey(cell: Cell): string {
  return `${cell.kind}-${cell.seq}`;
}

/** Everything a cell needs to draw itself, apart from which cell it is. */
type CellContext = {
  sessionId: string;
  liveBrowserSeq: number | null;
  live: boolean;
  /** The turn this belongs to is still running. */
  open: boolean;
  /** Which of the mark's two busy states suits what it is doing. */
  phase: MarkPhase;
  onPermissionDecide?: (requestId: string, approved: boolean, response?: string) => void;
  onRunAutonomous?: (task: KanbanTask) => void;
} & WorkState;

/* ---------------------------------------------------------------- steps -- */

const stepStatus = (cell: Cell) =>
  cell.kind === "terminal" ? cell.status
    : cell.kind === "tool" ? cell.span.status : "ok";

/** The line of a step that is worth showing without opening it. */
const stepLine = (cell: Cell) =>
  cell.kind === "terminal" ? cell.command
    : cell.kind === "tool" ? describeArgs(cell.span.args) : "";

/** What the steps took, added up. Only counted where it was reported. */
function stepsTook(steps: Cell[]): number | null {
  let sum = 0;
  let any = false;
  for (const step of steps) {
    const ms = step.kind === "terminal" ? step.durationMs
      : step.kind === "tool" ? step.span.durationMs : null;
    if (typeof ms === "number") { sum += ms; any = true; }
  }
  return any ? sum : null;
}

const shortMs = (value: number) =>
  value >= 1000 ? `${(value / 1000).toFixed(value >= 10000 ? 0 : 1)}s` : `${Math.round(value)}ms`;

/**
 * One turn's commands, folded into a line.
 *
 * Closed by default, and closed again when the turn ends: what is being read
 * is what the agent said, and the commands behind it are one tap away rather
 * than in the way. While one of them is running the line carries it, so a
 * folded turn is still a turn you can watch.
 */
const StepGroup = memo(function StepGroup({ steps, ...cell }: { steps: Cell[] } & CellContext) {
  const [open, setOpen] = useState(false);
  const running = cell.open && steps.some((s) => stepStatus(s) === "running");
  // Marked running in a turn that is over: it never reported back. Saying
  // "running" forever would be a lie.
  const orphaned = !cell.open && steps.some((s) => stepStatus(s) === "running");
  const failed = steps.filter((s) =>
    stepStatus(s) === "error"
    || (s.kind === "terminal" && s.exitCode !== null && s.exitCode !== 0)).length;
  const denied = steps.filter((s) => stepStatus(s) === "denied").length;
  const took = stepsTook(steps);
  const many = steps.length > 1;
  const last = steps[steps.length - 1];
  const doing = running ? steps.find((s) => stepStatus(s) === "running") ?? last : last;
  const title = many ? `${steps.length} steps` : stepLine(steps[0]) || steps[0].kind;
  const tail = many ? stepLine(doing) : "";
  const tone = failed ? "is-bad" : denied ? "is-warn" : running ? "is-live" : "";

  return (
    <section className={`steps ${tone} ${open ? "is-open" : ""}`.trim()}>
      <button className="steps-top" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="steps-chev"><IconChevron size={11} /></span>
        {steps.some((s) => s.kind === "terminal")
          ? <IconTerminal size={13} />
          : <span className="steps-dot" />}
        <b className="steps-title" title={title}>{title}</b>
        {tail && <span className="steps-doing">{tail}</span>}
        {running && <em className="cell-chip is-running">running</em>}
        {orphaned && <em className="cell-chip">no result</em>}
        {denied > 0 && <em className="cell-chip is-warn">declined</em>}
        {failed > 0 && <em className="cell-chip is-bad">{failed} failed</em>}
        {!running && took !== null && <em className="cell-at">{shortMs(took)}</em>}
      </button>
      {open && (
        <div className="steps-body">
          {steps.map((step) => (
            <CellView key={cellKey(step)} cell={step} active={false} {...cell} />
          ))}
        </div>
      )}
    </section>
  );
});

/** A run of cells: commands folded together, everything else as it was. */
const StepRun = memo(function StepRun({
  cells, activeKey, ...cell
}: { cells: Cell[]; activeKey: string | null } & CellContext) {
  return (
    <>
      {turnItems(cells).map((item) =>
        item.kind === "steps" ? (
          <StepGroup key={item.key} steps={item.cells} {...cell} />
        ) : (
          <CellView
            key={item.key}
            cell={item.cell}
            active={activeKey !== null && cellKey(item.cell) === activeKey}
            {...cell}
          />
        ))}
    </>
  );
});

const CellView = memo(function CellView({
  cell,
  sessionId,
  liveBrowserSeq,
  live,
  open,
  phase,
  active,
  onPermissionDecide,
  onRunAutonomous,
  driving,
  browserHandedOver,
  onStop,
  onOpenMind,
  onOpenSettings,
  onSpeakReply,
  speakingReply,
}: {
  cell: Cell;
  sessionId: string;
  liveBrowserSeq: number | null;
  live: boolean;
  open: boolean;
  phase: MarkPhase;
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
          phase={phase}
          onOpenMind={onOpenMind}
          onOpenSettings={cell.turn.setup ? onOpenSettings : undefined}
          onSpeak={onSpeakReply}
          speakingReply={speakingReply}
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
          {cell.log.length > 0 && (
            <StepRun
              cells={cell.log}
              // The newest thing said, while the page is still being worked.
              activeKey={cell.live ? cellKey(cell.log[cell.log.length - 1]) : null}
              sessionId={sessionId}
              liveBrowserSeq={liveBrowserSeq}
              live={live}
              open={open}
              phase={phase}
              onPermissionDecide={onPermissionDecide}
              onRunAutonomous={onRunAutonomous}
              driving={driving}
              browserHandedOver={browserHandedOver}
              onStop={onStop}
              onOpenMind={onOpenMind}
              onOpenSettings={onOpenSettings}
            />
          )}
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
});

/**
 * What the agent said, with its reasoning one tap away.
 *
 * Folded by default, live turn included: the reply is what you came for, and
 * reasoning that unfolds itself shoves the reply off the screen as it lands.
 */
const Reply = memo(function Reply({
  text,
  thinking,
  memories = NO_MEMORIES,
  working,
  phase = "thinking",
  onOpenMind,
  onOpenSettings,
  onSpeak,
  speakingReply,
}: {
  text: string;
  thinking?: string;
  memories?: MemoryTouch[];
  onOpenMind?: () => void;
  onOpenSettings?: () => void;
  /** Read this one reply out loud. Absent when the page has no voice at all,
      which is what hides the button. */
  onSpeak?: (text: string) => void;
  /** This reply is the one the voice is on, and whether it has been silenced.
      Null while the voice is on some other reply or on none. */
  speakingReply?: { text: string; muted: boolean } | null;
  /** Still being written. The mark animates while this holds and plays its
      own ending when it drops, so the reply visibly lands rather than just
      stopping. */
  working?: boolean;
  /** Whether it is waiting on something (thinking) or a step is in flight
      (building) -- the two busy states of the mark. */
  phase?: MarkPhase;
}) {
  const [open, setOpen] = useState(false);
  /* Whether the voice is on this reply, and whether it has been silenced. */
  const mine = speakingReply && sameReply(speakingReply.text, text) ? speakingReply : null;
  const spokenLabel = mine
    ? mine.muted
      ? "Unmute this reply"
      : "Mute this reply"
    : "Read this reply aloud";
  if (!text && !thinking && memories.length === 0) return null;

  return (
    <div className={`msg agent ${working ? "is-working" : ""}`.trim()}>
      {/* 27 boxes is a 11.9 x 10.6 triangle: the mark fills 14.04 of its own
          32-unit box, and the man opposite it (IconUser, a 14px glyph) has ink
          9.2 x 10.2 -- so this is a hair the bigger of the two, not the
          tile-filling mark it was. The stylesheet owns the real number, in
          --is so it follows the icon size in Settings; what is here is what a
          page without it gets. See the .msg.agent .avatar .amark rules. */}
      <span className="avatar">
        <AutoraMark size={27} state={working ? phase : "rest"} />
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
        {text && <div className="msg-text is-md"><Markdown text={text} streaming={working} /></div>}
        {/* One button with two faces, and it says what the next press will do
            rather than what is happening now: the speaker to hear the reply,
            the slashed one once it has been stopped, the speaker again to hear
            it. Only on a reply that has landed -- offering to read out a
            sentence still being written is offering to read half of it -- and
            only the reply the voice is actually on shows the second face, since
            pressing another reply's speaker stops this one: there is one
            voice. */}
        {onSpeak && text && !working && (
          <div className="msg-tools">
            <button
              type="button"
              className={`msg-tool ${mine ? (mine.muted ? "is-muted" : "is-speaking") : ""}`.trim()}
              onClick={() => onSpeak(text)}
              title={spokenLabel}
              aria-label={spokenLabel}
              aria-pressed={Boolean(mine)}
            >
              {mine?.muted ? <IconSpeakerOff size={13} /> : <IconSpeaker size={13} />}
            </button>
          </div>
        )}
        {onOpenSettings && (
          <button className="btn primary msg-action" onClick={onOpenSettings}>
            Open Settings <IconArrow size={13} />
          </button>
        )}
      </div>
    </div>
  );
});

/** One empty list for every reply without memories, so the default does not
    count as a change on each render. */
const NO_MEMORIES: MemoryTouch[] = [];
