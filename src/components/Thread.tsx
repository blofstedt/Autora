import { Suspense, memo, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import type { Bucket, Cell, MemoryTouch } from "../lib/derive";
import { turnItems } from "../lib/steps";
import { isPicture, sizeLabel, type Attachment } from "../lib/attachments";
import { IconAlert, IconArrow, IconArrowDown, IconBrain, IconCheck, IconChevron, IconCopy, IconDownload, IconFile, IconNotebook, IconSpeaker, IconSpeakerOff, IconTerminal, IconUser, IconWrench } from "./Icons";
import { OPEN_NOTEBOOK } from "../lib/notebooks";
import { copyText } from "../lib/clipboard";
import { sameReply } from "../lib/voice";
import { ImmersiveChat } from "./ImmersiveChat";
import { setFollowing, useFollowing } from "../lib/follow";
import { setFullscreen, useFullscreen } from "../lib/fullscreen";
import { AutoraMark } from "./AutoraMark";
import type { MarkPhase } from "../lib/activity";
import { TerminalCell } from "./TerminalCell";
import { ScreencastCell } from "./ScreencastCell";
import { FileCell } from "./FileCell";
import { RemarkCell } from "./RemarkCell";
import { ToolCell, describeArgs } from "./ToolCell";
import { TodoCell } from "./TodoCell";
import { usePreviewState } from "../lib/preview";
import { useDeskState } from "../lib/pdfdesk";
import { useVideoState } from "../lib/opencut";
import { useOfficeState, type OfficeKind } from "../lib/officedesk";
import { AppPreview, CadWindow, GameWindow, OfficeWindow, OpenCutWindow, PhotoWindow, SpectraWindow, StudioWindow, TerminalWindow } from "./lazyWindows";
import { useCadState } from "../lib/caddesk";
import { useGameState } from "../lib/gamedesk";
import { usePhotoState } from "../lib/photodesk";
import { useTermState } from "../lib/termdesk";
import { useStudioState } from "../lib/studio";
import { PermissionCell } from "./PermissionCell";
import { ImageCell } from "./ImageCell";
import { WidgetCell } from "./WidgetCell";
import { AskCell } from "./AskCell";
import { Markdown } from "./Markdown";
import { MemoryCell } from "./MemoryCell";
import { LearnedCell } from "./LearnedCell";
import { NAME, Stage, StageStub } from "./Stage";
import { busiestSurface, cellKey, newestSurface, pickSurfaces, usePhone, type Surface, type SurfaceKind } from "../lib/stage";

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
  chatOnly = false,
  buckets,
  busy,
  doing,
  elapsedMs = 0,
  steps = 0,
  phase = "thinking",
  sessionId,
  liveBrowserSeq,
  browserOpen = false,
  live,
  onPermissionDecide,
  onSuggest,
  placeholder,
  dock,
  dockedPlanKey = "",
  ...work
}: {
  /** A desktop has a work area beside the conversation (see WorkFeed), so what the agent looks at and does is shown
      there and the conversation keeps only the talking. A phone has one column and shows both. */
  chatOnly?: boolean;
  buckets: Bucket[];
  /** Sends a follow-up chip's words, as though typed. */
  onSuggest?: (text: string, title?: string) => void;
  /** What an empty session shows: the setup card, or tasks to start from. */
  placeholder?: ReactNode;
  /** The pinned corner widgets, if any: they sit in the pane's corners, over
      the margin rather than in the scroll. See components/Dock.tsx. */
  dock?: ReactNode;
  /** The key (cellKey) of the to-do list docked above the message box, which
      the thread then shows as a one-line stub. */
  dockedPlanKey?: string;
  busy: boolean;
  /** What it is on right now, in a few words (see lib/activity.ts). */
  doing?: string | null;
  /** How long this turn has been going, in ms. Zero before it starts. */
  elapsedMs?: number;
  /** How many tool calls this turn has made. A long turn with no visible
      progress looks stalled; the count says it is still moving. */
  steps?: number;
  /** Which of the mark's two busy states that is: thinking or building. */
  phase?: MarkPhase;
  sessionId: string;
  liveBrowserSeq: number | null;
  /** A page is open in the session's browser right now. */
  browserOpen?: boolean;
  live: boolean;
  onPermissionDecide?: (requestId: string, approved: boolean, response?: string) => void;
} & WorkState) {
  const scrollerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const [stuck, setStuck] = useState(true);
  const [unread, setUnread] = useState(false);
  /* Another conversation opens at its live edge with nothing unread: where
     the last one was left, and what arrived in it, say nothing about this. */
  const [shownSession, setShownSession] = useState(sessionId);
  if (shownSession !== sessionId) {
    setShownSession(sessionId);
    setStuck(true);
    setUnread(false);
  }
  // While the page in the thread is yours to use, the thread holds still:
  // following the live edge would slide the page out from under your finger
  // every time it repaints.
  const handsOn = work.browserHandedOver;
  const handsOnRef = useRef(handsOn);
  handsOnRef.current = handsOn;
  useEffect(() => {
    if (handsOn) setStuck(false);
  }, [handsOn]);

  /* The pinned stage (phones only; see lib/stage.ts). Which tab is up, and
     whether it is folded, only mean something for the set of surfaces they
     were chosen from: when a page opens or closes, or a new plan or explainer
     arrives, the choice lapses and the newest one is shown, unfolded. */
  const phone = usePhone();
  const appOpen = usePreviewState().open;
  const desk = useDeskState();
  const pdfSince = desk.open ? desk.since ?? 0 : null;
  const video = useVideoState();
  const videoSince = video.open ? video.since ?? 0 : null;
  const cadOpen = useCadState();
  const cadSince = cadOpen.open ? cadOpen.since ?? 0 : null;
  const gameOpen = useGameState();
  const gameSince = gameOpen.open ? gameOpen.since ?? 0 : null;
  const photoOpen = usePhotoState();
  const photoSince = photoOpen.open ? photoOpen.since ?? 0 : null;
  const termOpen = useTermState();
  const termSince = termOpen.open ? termOpen.since ?? 0 : null;
  const studioOpen = useStudioState();
  const studioSince = studioOpen.open ? studioOpen.since ?? 0 : null;
  const office = useOfficeState();
  // One entry per open Office window: "docx:12|xlsx:30". A string, so it is a stable memo key.
  const officeSince = office.windows.map((w) => `${w.kind}:${w.since ?? 0}`).join("|");
  const surfaces = useMemo(
    // Held only while the session is live: a recorded one is read, not watched.
    // The plan is not one of them: it is docked above the message box (see
    // TodoDock), on every screen, so the stage holds only the page, the app
    // and the explainer.
    () => {
      if (!phone || !live) return [];
      const held = pickSurfaces(buckets, browserOpen ? liveBrowserSeq : null, appOpen).filter((s) => s.kind !== "plan");
      // The PDF window is live state, not a card in the log: it is added here,
      // after the app (the order the tabs sit in).
      // The Office windows are the same kind of thing and sit beside it, one tab for each app that is open.
      const windows: Surface[] = [
        ...(pdfSince === null ? [] : [{ kind: "pdf" as const, cell: { kind: "pdf" as const, seq: pdfSince }, key: `pdf-${pdfSince}` }]),
        ...(videoSince === null ? [] : [{ kind: "video" as const, cell: { kind: "video" as const, seq: videoSince }, key: `video-${videoSince}` }]),
        ...(cadSince === null ? [] : [{ kind: "cad" as const, cell: { kind: "cad" as const, seq: cadSince }, key: `cad-${cadSince}` }]),
        ...(gameSince === null ? [] : [{ kind: "game" as const, cell: { kind: "game" as const, seq: gameSince }, key: `game-${gameSince}` }]),
        ...(photoSince === null ? [] : [{ kind: "photo" as const, cell: { kind: "photo" as const, seq: photoSince }, key: `photo-${photoSince}` }]),
        ...(termSince === null ? [] : [{ kind: "term" as const, cell: { kind: "term" as const, seq: termSince }, key: `term-${termSince}` }]),
        ...(studioSince === null ? [] : [{ kind: "studio" as const, cell: { kind: "studio" as const, seq: studioSince }, key: `studio-${studioSince}` }]),
        ...(officeSince === "" ? [] : officeSince.split("|").map((w) => {
          const [kind, since] = w.split(":") as [OfficeKind, string];
          return { kind, cell: { kind, seq: Number(since) }, key: `${kind}-${since}` };
        })),
      ];
      if (windows.length === 0) return held;
      const at = held.findIndex((s) => s.kind !== "app");
      return at < 0 ? [...held, ...windows] : [...held.slice(0, at), ...windows, ...held.slice(at)];
    },
    [phone, live, buckets, browserOpen, liveBrowserSeq, appOpen, pdfSince, videoSince, cadSince, gameSince, photoSince, termSince, studioSince, officeSince],
  );
  const held = surfaces.map((s) => s.key).join("|");
  /* What the thread shows as a stub rather than the card: whatever the stage
     holds, and the plan docked above the message box. */
  const docked = dockedPlanKey ? (held ? `${held}|${dockedPlanKey}` : dockedPlanKey) : held;
  const [stageView, setStageView] = useState<{ held: string; pick: SurfaceKind | null; folded: boolean; expanded: boolean }>(
    { held: "", pick: null, folded: false, expanded: false },
  );
  /* Follow: the tab tracks whatever the agent touched last. Tapping a tab is
     taking the wheel, so it lets go -- the way scrolling up lets go of the
     live edge -- and the button hands it back. */
  const follow = useFollowing();
  const stageFresh = stageView.held === held;
  const handedPage = work.browserHandedOver && surfaces.some((s) => s.kind === "browser");
  // A page handed to the person is what they are here to use: never folded away.
  const folded = !handedPage && stageFresh && stageView.folded;
  const expanded = stageFresh && stageView.expanded;
  const activeKind: SurfaceKind | null = handedPage
    ? "browser"
    : follow && surfaces.length > 1
      ? busiestSurface(surfaces)?.kind ?? null
      : (stageFresh && surfaces.find((s) => s.kind === stageView.pick)?.kind) || newestSurface(surfaces)?.kind || null;
  const pickTab = useCallback((kind: SurfaceKind) => {
    setFollowing(false);
    setStageView((v) => ({ held, pick: kind, folded: false, expanded: v.held === held && v.expanded }));
  }, [held]);
  const toggleFollow = useCallback(() => {
    setFollowing(!follow);
    setStageView((v) => ({ held, pick: v.held === held ? v.pick : null, folded: false, expanded: v.held === held && v.expanded }));
  }, [held, follow]);
  const foldStage = useCallback(
    () => setStageView((v) => ({ held, pick: v.held === held ? v.pick : null, folded: !(v.held === held && v.folded), expanded: v.held === held && v.expanded })),
    [held],
  );
  const expandStage = useCallback(
    () => setStageView((v) => ({ held, pick: v.held === held ? v.pick : null, folded: false, expanded: !(v.held === held && v.expanded) })),
    [held],
  );

  const count = buckets.length;
  const tail = buckets[buckets.length - 1];
  /* Full screen on a phone: follow moves between tools with the screen kept full (the flag is shared, so the
     next tool opens full too), and the agent's words and a small message box are laid over it. */
  const [fullscreen] = useFullscreen();
  const immersive = phone && live && fullscreen && activeKind !== null;
  useEffect(() => {
    if (fullscreen && (!phone || activeKind === null)) setFullscreen(false);
  }, [fullscreen, phone, activeKind]);
  /* A tool that opens on a phone opens full screen -- the page, the PDF, the
     document, the app -- whether the agent opened it or the person did from
     the wrench: a strip a third of the screen deep is no way to look at one,
     and the way out is the control in the window's own bar (Back to the
     conversation). Only an opening does it: a reload, or a window already up
     when the screen arrives, leaves the conversation where the person put it. */
  const windowsUp = `${pdfSince ?? ""}|${videoSince ?? ""}|${cadSince ?? ""}|${gameSince ?? ""}|${photoSince ?? ""}|${termSince ?? ""}|${studioSince ?? ""}|${officeSince}|${appOpen ? 1 : 0}`;
  /* What was open when this screen arrived, and the first thing that happens to it.
     The desk, the document and the app a session already had are sent with the
     session, so on a reload or a phone opening the session the window lands a moment
     after the thread: the first change a page sees once it is live is that landing,
     not the agent opening a window, and it leaves the conversation where it is. */
  const windowsSeen = useRef<string | null>(null);
  const settled = useRef(false);
  useEffect(() => {
    const seen = windowsSeen.current;
    windowsSeen.current = windowsUp;
    if (!phone || !live) return;
    if (seen === null) return;
    if (!settled.current) { settled.current = true; return; }
    if (seen === windowsUp) return;
    if (pdfSince !== null || videoSince !== null || termSince !== null || officeSince !== "" || appOpen) setFullscreen(true);
  }, [windowsUp, pdfSince, videoSince, termSince, officeSince, appOpen, phone, live]);
  useEffect(() => { windowsSeen.current = null; settled.current = false; }, [sessionId]);
  useEffect(() => () => setFullscreen(false), [sessionId]);
  const lastSaid = tail?.replies.length ? tail.replies[tail.replies.length - 1].text : "";
  const tailLength =
    (tail?.replies.reduce((n, r) => n + r.text.length, 0) ?? 0) + (tail?.cells.length ?? 0) +
    // Next-step chips arriving count as the thread growing, so they are scrolled into view.
    (tail?.next?.length ?? 0);
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
    <div className={`thread-wrap${immersive ? " is-immersive" : ""}${activeKind && expanded && !folded ? " has-expanded-stage" : ""}`}>
      {dock}
      {immersive && (
        <ImmersiveChat
          say={lastSaid}
          onSend={(text) => onSuggest?.(text)}
          canFollow={surfaces.length > 1}
          following={follow && surfaces.length > 1}
          onFollow={toggleFollow}
        />
      )}
      {activeKind && (
        <Stage
          surfaces={surfaces}
          active={activeKind}
          collapsed={folded}
          expanded={expanded}
          following={follow && surfaces.length > 1}
          onPick={pickTab}
          onFollow={toggleFollow}
          onToggle={foldStage}
          onExpand={expandStage}
          render={(surface) => (
            <CellView
              cell={surface.cell}
              stage
              docked=""
              sessionId={sessionId}
              liveBrowserSeq={liveBrowserSeq}
              live={live}
              open={tail?.open ?? false}
              phase={phase}
              active={false}
              onPermissionDecide={onPermissionDecide}
              {...work}
            />
          )}
        />
      )}
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
            docked={docked}
            chatOnly={chatOnly}
            onPermissionDecide={onPermissionDecide}
            {...work}
            phase={phase}
          />
        ))}
        {/* What to do next, under the last reply once it is finished. Outside
            the memoised cards: they come and go without redrawing any. */}
        {!busy && onSuggest && tail?.next && tail.next.length > 0 && (
          <div className="next-steps" role="group" aria-label="Suggested next steps">
            {tail.next.map((step, i) => (
              <button
                key={step.label}
                type="button"
                className="next-step"
                style={{ animationDelay: `${i * 60}ms` }}
                title={step.prompt}
                onClick={() => onSuggest(step.prompt)}
              >
                <IconArrow size={12} />
                <span>{step.label}</span>
              </button>
            ))}
          </div>
        )}
        {busy && (
          <div className="working" aria-live="polite">
            {/* The line under the thread wears a glyph of its own, not the
                mark: the mark is the agent signing its own words, and a second
                one down here turned the brand into a progress spinner.
                Thinking is a brain, doing is a wrench -- see phaseGlyph. */}
            <span className="working-mark" aria-hidden="true">{phaseGlyph(phase)}</span>
            {/* Keyed on the words, so each new step fades in over the last
                rather than snapping -- a train of thought, not a counter. */}
            <span className="working-what" key={chatOnly ? "working" : doing || "working"}>{chatOnly ? "Working" : doing || "Working"}</span>
            {/* How far in it is. A step count alone is noise on a short turn,
                so it waits for two, and the clock waits for a few seconds
                rather than counting 0s under every reply. */}
            {(elapsedMs >= 3000 || (steps > 1 && !chatOnly)) && (
              <span className="working-when">
                {elapsedMs >= 3000 ? clock(elapsedMs) : ""}
                {steps > 1 && !chatOnly ? `${elapsedMs >= 3000 ? " · " : ""}${steps} steps` : ""}
              </span>
            )}
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
const MessageFiles = memo(function MessageFiles({
  files, notebooks = [],
}: { files: Attachment[]; notebooks?: { id: string; title: string }[] }) {
  if (files.length === 0 && notebooks.length === 0) return null;
  return (
    <div className="msg-files">
      {notebooks.map((book) => (
        <a
          className="msg-file is-notebook"
          key={book.id}
          href={`?page=notebooks&notebook=${encodeURIComponent(book.id)}`}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey) return;
            e.preventDefault();
            window.dispatchEvent(new CustomEvent(OPEN_NOTEBOOK, { detail: book.id }));
          }}
          title={`Open the notebook ${book.title}`}
        >
          <IconNotebook size={14} />
          <span className="msg-file-name">{book.title}</span>
        </a>
      ))}
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

/**
 * Files a tool made, where it made them -- a filled-in form, a redacted copy:
 * the name opens it (a PDF in the browser's own viewer), the arrow downloads it.
 */
const FilesCell = memo(function FilesCell({ files }: { files: Attachment[] }) {
  return (
    <div className="out-files">
      {files.map((file) => (
        <div className="out-file" key={file.id}>
          <a
            className="out-file-open"
            href={`/api/artifacts/${file.id}`}
            target="_blank"
            rel="noreferrer"
            title={`Open ${file.name}`}
          >
            <IconFile size={15} />
            <span className="out-file-name">{file.name}</span>
            {file.size > 0 && <span className="out-file-size">{sizeLabel(file.size)}</span>}
          </a>
          <a
            className="out-file-save"
            href={`/api/artifacts/${file.id}?download`}
            download={file.name}
            title={`Download ${file.name}`}
            aria-label={`Download ${file.name}`}
          >
            <IconDownload size={14} />
          </a>
        </div>
      ))}
    </div>
  );
});

/**
 * The agent looking at something or doing something: a command, a page, a picture, a file it made, a change to code,
 * a widget, any other tool. On a desktop these are shown in the work area beside the conversation (WorkFeed).
 */
const isWorkCell = (cell: Cell) =>
  cell.kind === "terminal" || cell.kind === "screen" || cell.kind === "images" || cell.kind === "files"
  || cell.kind === "widget" || cell.kind === "file" || cell.kind === "tool" || cell.kind === "app";

/** What stays in the conversation: the talking. What the agent said while it worked a page stays too. */
function chatCells(cells: Cell[]): Cell[] {
  return cells.flatMap((cell) => (cell.kind === "screen" ? cell.log.filter((c) => !isWorkCell(c)) : isWorkCell(cell) ? [] : [cell]));
}

/** Whether a session has anything for the work area to show. */
export const hasWork = (buckets: Bucket[]) => buckets.some((b) => b.cells.some(isWorkCell));

const TurnBucket = memo(function TurnBucket({
  bucket,
  chatOnly = false,
  sessionId,
  liveBrowserSeq,
  live,
  docked,
  phase,
  onPermissionDecide,
  ...work
}: {
  bucket: Bucket;
  chatOnly?: boolean;
  sessionId: string;
  liveBrowserSeq: number | null;
  live: boolean;
  /** The keys of the cards held in the stage, so the thread leaves them out. */
  docked: string;
  phase: MarkPhase;
  onPermissionDecide?: (requestId: string, approved: boolean, response?: string) => void;
} & WorkState) {
  // The agent's mark animates on its current utterance for as long as the turn
  // runs. Keyed to the last *reply* rather than the last cell: a tool card
  // landing after the reply does not mean the agent has stopped, and anchoring
  // to the last cell made the mark settle the moment one appeared -- a finish
  // in the middle of the work.
  const cells = useMemo(() => (chatOnly ? chatCells(bucket.cells) : bucket.cells), [chatOnly, bucket.cells]);
  const speaking = cells.map((c) => c.kind).lastIndexOf("reply");

  return (
    <article className="turn">
      {(bucket.prompt || bucket.attachments.length > 0 || (bucket.notebooks?.length ?? 0) > 0) && (
        <div className="msg user">
          <span className="avatar"><IconUser size={14} /></span>
          <div className="msg-body">
            <div className="msg-who">User</div>
            {bucket.prompt && <div className="msg-text">{bucket.prompt}</div>}
            <MessageFiles files={bucket.attachments} notebooks={bucket.notebooks} />
          </div>
        </div>
      )}

      <div className="work">
        <StepRun
          cells={cells}
          activeKey={bucket.open && speaking >= 0 ? cellKey(cells[speaking]) : null}
          sessionId={sessionId}
          liveBrowserSeq={liveBrowserSeq}
          live={live}
          docked={docked}
          open={bucket.open}
          phase={phase}
          onPermissionDecide={onPermissionDecide}
          {...work}
        />
      </div>
    </article>
  );
});

/** Everything a cell needs to draw itself, apart from which cell it is. */
type CellContext = {
  sessionId: string;
  liveBrowserSeq: number | null;
  live: boolean;
  /** The turn this belongs to is still running. */
  open: boolean;
  /** Keys of the cards held in the pinned stage, joined with "|". */
  docked: string;
  /** Which of the mark's two busy states suits what it is doing. */
  phase: MarkPhase;
  onPermissionDecide?: (requestId: string, approved: boolean, response?: string) => void;
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

/** How long something has been going, as a clock: 4s, 1:23, 12:07. */
function clock(ms: number): string {
  const total = Math.max(0, Math.round(ms / 1000));
  if (total < 60) return `${total}s`;
  const m = Math.floor(total / 60);
  const s = total % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

/**
 * One turn's commands, folded into a line.
 *
 * Closed by default, and closed again when the turn ends: what is being read
 * is what the agent said, and the commands behind it are one tap away rather
 * than in the way. While one of them is running the line carries it, so a
 * folded turn is still a turn you can watch.
 */
const StepGroup = memo(function StepGroup({ steps, unfolded = false, ...cell }: { steps: Cell[]; unfolded?: boolean } & CellContext) {
  const [open, setOpen] = useState(unfolded);
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
  cells, activeKey, unfolded = false, ...cell
}: { cells: Cell[]; activeKey: string | null; /** Commands start open: the work area is for looking at them. */ unfolded?: boolean } & CellContext) {
  return (
    <>
      {turnItems(cells).map((item) =>
        item.kind === "steps" ? (
          <StepGroup key={item.key} steps={item.cells} unfolded={unfolded} {...cell} />
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

/** The Office window for the phone's pinned view: the one for the app this tab is. */
function OfficeStage({ sessionId, kind }: { sessionId: string; kind: OfficeKind }) {
  return <Suspense fallback={null}><OfficeWindow sessionId={sessionId} kind={kind} phone /></Suspense>;
}

/**
 * The work area's feed, on a desktop: what the agent looked at and did, as it happens -- commands, pages, pictures,
 * the files it made, changes to code, widgets and every other tool -- in the window beside the conversation, newest
 * at the bottom and followed while it is. The conversation beside it keeps only the talking (`chatOnly`).
 */
export const WorkFeed = memo(function WorkFeed({
  buckets, busy, doing, sessionId, liveBrowserSeq, browserOpen, live, phase, onPermissionDecide, ...work
}: {
  buckets: Bucket[];
  busy: boolean;
  doing?: string | null;
  sessionId: string;
  liveBrowserSeq: number | null;
  /** The page is shown in its own window beside this one, so its card is not repeated here. */
  browserOpen: boolean;
  live: boolean;
  phase: MarkPhase;
  onPermissionDecide?: (requestId: string, approved: boolean, response?: string) => void;
} & WorkState) {
  const scroller = useRef<HTMLDivElement>(null);
  const follow = useRef(true);
  const rows = useMemo(
    () => buckets
      .map((b) => ({ b, cells: b.cells.filter((c) => isWorkCell(c) && !(browserOpen && c.kind === "screen" && c.source === "browser")) }))
      .filter((r) => r.cells.length > 0),
    [buckets, browserOpen],
  );
  const latest = rows.length > 0 ? rows[rows.length - 1].cells.length : 0;
  // Followed while the person is at the bottom; scrolling up lets go.
  useEffect(() => {
    const el = scroller.current;
    if (el && follow.current) el.scrollTop = el.scrollHeight;
  }, [rows.length, latest, buckets]);
  const onScroll = () => {
    const el = scroller.current;
    if (el) follow.current = el.scrollHeight - el.scrollTop - el.clientHeight < 60;
  };
  return (
    <div className="work-feed" ref={scroller} onScroll={onScroll}>
      {busy && doing && (
        <div className="work-feed-doing" aria-live="polite">
          <span className="working-mark" aria-hidden="true">{phaseGlyph(phase)}</span>
          <span>{doing}</span>
        </div>
      )}
      {rows.length === 0 && <p className="work-feed-empty">What the agent looks at and does shows up here as it happens.</p>}
      {rows.map(({ b, cells }) => (
        <section className="work-feed-turn" key={b.seq}>
          {b.prompt && <h4 className="work-feed-prompt" title={b.prompt}>{b.prompt}</h4>}
          <StepRun
            cells={cells}
            activeKey={null}
            unfolded
            sessionId={sessionId}
            liveBrowserSeq={liveBrowserSeq}
            live={live}
            docked=""
            open={b.open}
            phase={phase}
            onPermissionDecide={onPermissionDecide}
            {...work}
          />
        </section>
      ))}
    </div>
  );
});

const CellView = memo(function CellView({
  cell,
  sessionId,
  liveBrowserSeq,
  live,
  open,
  docked,
  stage = false,
  phase,
  active,
  onPermissionDecide,
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
  docked: string;
  /** Drawn in the pinned stage itself, so it is never left out for it. */
  stage?: boolean;
  phase: MarkPhase;
  active: boolean;
  onPermissionDecide?: (requestId: string, approved: boolean, response?: string) => void;
} & WorkState) {
  const held = !stage && docked !== "" && docked.split("|").includes(cellKey(cell));
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
      const log = cell.log.length > 0 && (
        <StepRun
          cells={cell.log}
          // The newest thing said, while the page is still being worked.
          activeKey={cell.live ? cellKey(cell.log[cell.log.length - 1]) : null}
          sessionId={sessionId}
          liveBrowserSeq={liveBrowserSeq}
          live={live}
          open={open}
          docked={docked}
          phase={phase}
          onPermissionDecide={onPermissionDecide}
          driving={driving}
          browserHandedOver={browserHandedOver}
          onStop={onStop}
          onOpenMind={onOpenMind}
          onOpenSettings={onOpenSettings}
        />
      );
      /* Held above: the page is in the stage, and what was said while it was
         worked stays here, in the thread, where it scrolls. */
      if (held) {
        return (
          <StageStub kind="browser" title={NAME.browser} note="pinned above">
            {log}
          </StageStub>
        );
      }
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
          pinned={stage}
          onStop={onStop}
        >
          {!stage && log}
        </ScreencastCell>
      );
    }
    case "memory":
      return <MemoryCell cell={cell} onOpen={onOpenMind} />;
    case "learned":
      return <LearnedCell items={cell.items} changes={cell.changes} onOpen={onOpenMind} />;
    case "ask":
      return <AskCell ask={cell.ask} sessionId={sessionId} readOnly={!live} />;
    case "images":
      return <ImageCell sessionId={sessionId} pictures={cell.pictures} />;
    case "files":
      return <FilesCell files={cell.files} />;
    case "widget":
      if (held) return <StageStub kind="widget" title={NAME.widget} note={`${cell.widget.title} · pinned above`} />;
      return <WidgetCell widget={cell.widget} sessionId={sessionId} canFix={live && !driving} pinned={stage} />;
    case "file":
      return <FileCell file={cell.file} />;
    case "remark":
      return <RemarkCell text={cell.text} />;
    case "tool":
      return <ToolCell span={cell.span} />;
    case "todo": {
      if (held) {
        const done = cell.items.filter((t) => t.status === "completed").length;
        return (
          <StageStub
            kind="plan"
            title={NAME.plan}
            note={`${done} of ${cell.items.length} done · above the message box`}
          />
        );
      }
      return <TodoCell items={cell.items} />;
    }
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
    case "pdf":
      return stage ? <Suspense fallback={null}><SpectraWindow sessionId={sessionId} phone /></Suspense> : null;
    case "video":
      return stage ? <Suspense fallback={null}><OpenCutWindow sessionId={sessionId} phone /></Suspense> : null;
    case "term":
      return stage ? <Suspense fallback={null}><TerminalWindow sessionId={sessionId} phone /></Suspense> : null;
    case "cad":
      return stage ? <Suspense fallback={null}><CadWindow sessionId={sessionId} phone /></Suspense> : null;
    case "game":
      return stage ? <Suspense fallback={null}><GameWindow sessionId={sessionId} phone /></Suspense> : null;
    case "photo":
      return stage ? <Suspense fallback={null}><PhotoWindow sessionId={sessionId} phone /></Suspense> : null;
    case "studio":
      return stage ? <Suspense fallback={null}><StudioWindow sessionId={sessionId} phone /></Suspense> : null;
    case "docx":
    case "pptx":
    case "xlsx":
      return stage ? <OfficeStage sessionId={sessionId} kind={cell.kind} /> : null;
    case "app": {
      if (stage) return <Suspense fallback={null}><AppPreview sessionId={sessionId} phone /></Suspense>;
      if (held) return <StageStub kind="app" title={NAME.app} note="preview · pinned above" />;
      return (
        <div className="app-note-cell">
          <StageStub kind="app" title={NAME.app} note={cell.url ? `opened ${cell.url.replace(/^https?:\/\//, "").replace(/\/$/, "")}` : "opened"} />
        </div>
      );
    }
    case "mode":
      return (
        <div className={`mode-chip is-${cell.to}`}>
          <i aria-hidden="true" />
          <b>{cell.to === "plan" ? "Planning" : "Building"}</b>
          {cell.reason && <span>· {cell.reason}</span>}
        </div>
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
  const [copied, setCopied] = useState(false);
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
        {text && !working && (
          <div className="msg-tools">
            <button
              type="button"
              className={`msg-tool ${copied ? "is-copied" : ""}`.trim()}
              onClick={() => {
                void copyText(text).then((ok) => {
                  if (!ok) return;
                  setCopied(true);
                  setTimeout(() => setCopied(false), 1600);
                });
              }}
              title={copied ? "Copied" : "Copy this reply"}
              aria-label={copied ? "Copied" : "Copy this reply"}
            >
              {copied ? <IconCheck size={13} /> : <IconCopy size={13} />}
            </button>
            {onSpeak && <button
              type="button"
              className={`msg-tool ${mine ? (mine.muted ? "is-muted" : "is-speaking") : ""}`.trim()}
              onClick={() => onSpeak(text)}
              title={spokenLabel}
              aria-label={spokenLabel}
              aria-pressed={Boolean(mine)}
            >
              {mine?.muted ? <IconSpeakerOff size={13} /> : <IconSpeaker size={13} />}
            </button>}
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
