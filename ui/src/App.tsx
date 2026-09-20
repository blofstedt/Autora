import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionStream, type StreamStatus } from "./lib/stream";
import { derive, inferStage, isRunning } from "./lib/derive";
import { HIDDEN_KINDS } from "./lib/describe";
import { usePlayback } from "./lib/playback";
import { chime, paintChrome, type Chrome } from "./lib/chrome";
import type { AutoraEvent } from "./lib/types";
import { Thread } from "./components/Thread";
import { MemoryRibbon } from "./components/MemoryRibbon";
import { StageDock, type Stage } from "./components/StageDock";
import { Sessions, type SessionRow } from "./components/Sessions";
import { TerminalView } from "./components/TerminalView";
import { BrowserView } from "./components/BrowserView";
import { DesktopView } from "./components/DesktopView";
import { DiffView } from "./components/DiffView";
import { Approvals } from "./components/Approvals";
import { Scrubber } from "./components/Scrubber";
import { KnowledgeWeb } from "./components/KnowledgeWeb";
import { Schedule } from "./components/Schedule";
import { Settings } from "./components/Settings";
import {
  IconArrow, IconChevron, IconGear, IconMessage, IconRepeat, IconSpark,
} from "./components/Icons";

/** How often to re-read the session list, so sessions started elsewhere (or
    from another tab) show up without a reload. */
const SESSION_POLL_MS = 10_000;

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(
    () => new URLSearchParams(location.search).get("session"),
  );
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  const [events, setEvents] = useState<AutoraEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>({ state: "connecting" });
  const [cursor, setCursor] = useState(-1);
  const [following, setFollowing] = useState(true);
  const [stage, setStage] = useState<Stage>("terminal");
  const [stagePinned, setStagePinned] = useState(false);
  const [dockOpen, setDockOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [mobileTab, setMobileTab] = useState<"chat" | "tasks">("chat");
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const streamRef = useRef<SessionStream | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    let alive = true;
    const load = () =>
      fetch("/api/sessions")
        .then((r) => r.json())
        .then((rows) => {
          if (!alive) return;
          setSessions(rows);
          // Functional update so polling never needs `sessionId` as a dep --
          // otherwise every session switch restarts the poll.
          setSessionId((current) => current ?? (rows.length > 0 ? rows[0].id : null));
        })
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, SESSION_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    setCursor(-1);
    setFollowing(true);
    const stream = new SessionStream(sessionId, {
      onEvents: (fresh) =>
        setEvents((prev) => {
          const next = [...prev, ...fresh];
          next.sort((a, b) => a.seq - b.seq);
          return next;
        }),
      onStatus: setStatus,
    });
    streamRef.current = stream;
    stream.connect();
    return () => {
      stream.close();
      streamRef.current = null;
    };
  }, [sessionId]);

  useEffect(() => {
    if (following) setCursor(events.length - 1);
  }, [events.length, following]);

  const view = useMemo(() => derive(events, cursor), [events, cursor]);
  const startedAt = events[0]?.ts ?? 0;

  // ------------------------------------------------------------- playback --
  const playbackSeek = useCallback((index: number) => {
    setFollowing(false);
    setCursor(index);
  }, []);
  const playback = usePlayback(
    events,
    cursor,
    playbackSeek,
    useCallback(() => setFollowing(true), []),
  );

  /** Any deliberate move by the reader: stops playback and stops following. */
  const seek = useCallback(
    (index: number) => {
      playback.pause();
      setFollowing(false);
      setCursor(index);
    },
    [playback],
  );

  /** A step row knows its sequence number, not its index. */
  const seekToSeq = useCallback(
    (targetSeq: number) => {
      const index = events.findIndex((e) => e.seq === targetSeq);
      if (index >= 0) seek(index);
    },
    [events, seek],
  );

  const jumpToNow = useCallback(() => {
    playback.pause();
    setFollowing(true);
    setCursor(events.length - 1);
  }, [playback, events.length]);

  const step = useCallback(
    (direction: 1 | -1, notable: boolean) => {
      playback.pause();
      setFollowing(false);
      setCursor((current) => {
        if (!notable) {
          return Math.min(Math.max(current + direction, -1), events.length - 1);
        }
        for (let i = current + direction; i >= 0 && i < events.length; i += direction) {
          if (!HIDDEN_KINDS.has(events[i].kind)) return i;
        }
        return direction > 0 ? events.length - 1 : -1;
      });
    },
    [playback, events],
  );

  const pending = useMemo(
    () => view.approvals.filter((a) => !a.settled).length,
    [view.approvals],
  );
  // An approval is the one thing that must not be missed behind an overlay.
  useEffect(() => {
    if (pending > 0) {
      setMobileTab("chat");
      setScheduleOpen(false);
    }
  }, [pending]);

  // Follow the action by default; a deliberate choice of pane must stick, or
  // the UI fights whoever is trying to look at something.
  useEffect(() => {
    if (stagePinned) return;
    setStage(inferStage(events, cursor));
  }, [events, cursor, stagePinned]);

  // The pin releases itself when a new prompt starts. There is no button to
  // release it -- the dock bar's width belongs to the pane names -- and a pin
  // that could only be set would strand the stage on whatever was last tapped
  // for the rest of the session.
  const turnCount = view.buckets.length;
  const lastTurn = useRef(turnCount);
  useEffect(() => {
    if (turnCount !== lastTurn.current) {
      lastTurn.current = turnCount;
      setStagePinned(false);
    }
  }, [turnCount]);

  const send = useCallback(async () => {
    const text = draft.trim();
    if (!text || !sessionId) return;
    setDraft("");
    setFollowing(true);
    await fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => undefined);
  }, [draft, sessionId]);

  const newSession = useCallback(async () => {
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { id } = await res.json();
    history.replaceState(null, "", `?session=${id}`);
    setSessionId(id);
    setSessionsOpen(false);
  }, []);

  const live = status.state === "live";
  const readOnly = !live;
  // Following means the cursor is pinned to the head by definition. Deriving
  // this from the cursor alone lags by a render -- the cursor catches up in an
  // effect -- so every arriving event briefly read as "not at the head" and
  // the transport flickered between following and offering to jump there.
  const atHead = following || cursor >= events.length - 1;

  // Whether a turn is running now, as opposed to whether one was running at
  // the cursor. Replay parks the cursor mid-turn on purpose; asking `view.busy`
  // there would put up a Stop button and relabel Send as "Interrupt & send",
  // which reads as the request having been sent again.
  const running = useMemo(() => isRunning(events), [events]);

  // ---------------------------------------------------------- tab chrome --
  const chromeState: Chrome = pending > 0
    ? "approval"
    : !live
      ? status.state === "closed" ? "offline" : "idle"
      : running ? "working" : "live";

  useEffect(() => {
    paintChrome(chromeState, view.title);
  }, [chromeState, view.title]);

  const hadPending = useRef(0);
  useEffect(() => {
    if (pending > hadPending.current && document.hidden) chime();
    hadPending.current = pending;
  }, [pending]);

  // ------------------------------------------------------------ shortcuts --
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const typing =
        !!target &&
        (target.isContentEditable ||
          ["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName));

      if (e.key === "Escape" && typing) {
        target!.blur();
        return;
      }
      if (typing || e.metaKey || e.ctrlKey || e.altKey) return;

      switch (e.key) {
        case " ":
          e.preventDefault();
          playback.toggle();
          break;
        case "ArrowLeft":
          e.preventDefault();
          step(-1, e.shiftKey);
          break;
        case "ArrowRight":
          e.preventDefault();
          step(1, e.shiftKey);
          break;
        case "Home":
          e.preventDefault();
          seek(-1);
          break;
        case "End":
          e.preventDefault();
          jumpToNow();
          break;
        case "/":
          e.preventDefault();
          composerRef.current?.focus();
          break;
        case "k":
          e.preventDefault();
          setKnowledgeOpen((open) => !open);
          break;
        case "s":
          e.preventDefault();
          setDockOpen((open) => !open);
          break;
        case "Escape":
          setKnowledgeOpen(false);
          setScheduleOpen(false);
          setSettingsOpen(false);
          setSessionsOpen(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playback, step, seek, jumpToNow]);

  const currentName =
    sessions.find((s) => s.id === sessionId)?.title?.trim() ||
    view.title ||
    "Untitled session";

  const closeOverlays = () => {
    setScheduleOpen(false);
    setKnowledgeOpen(false);
    setSettingsOpen(false);
  };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brand-mark"><IconSpark size={13} /></span>
          <span className="brand-word">Autora</span>
        </div>

        <button
          className="session-btn"
          onClick={() => setSessionsOpen(true)}
          title="Switch session"
        >
          <span className={`ses-dot ${live ? "is-live" : ""}`} />
          <span className="session-name">{currentName}</span>
          <IconChevron size={12} />
        </button>

        <div className="spacer" />

        {view.tokens.in > 0 && (
          <span className="badge tokens" title="tokens in / out / cached">
            {fmt(view.tokens.in)} in · {fmt(view.tokens.out)} out · {fmt(view.tokens.cached)} cached
          </span>
        )}
        <button
          className="btn icon ghost"
          onClick={() => setSettingsOpen(true)}
          title="Settings"
          aria-label="Open settings"
        >
          <IconGear size={15} />
        </button>
      </header>

      {/* Always on, above the conversation: what the agent knows, and what is
          happening to it as it happens. */}
      <MemoryRibbon memories={view.memories} onOpen={() => setKnowledgeOpen(true)} />

      <main className="page">
        <Thread
          buckets={view.buckets}
          busy={view.busy && atHead}
          startedAt={startedAt}
          onSeek={seekToSeq}
        />

        <Approvals
          approvals={view.approvals}
          readOnly={readOnly}
          onDecide={(id, approved) => streamRef.current?.approve(id, approved)}
        />

        <StageDock
          stage={stage}
          open={dockOpen}
          counts={{ files: view.files.length }}
          hasDesktop={view.hasDesktop}
          onStage={(id) => { setStage(id); setStagePinned(true); }}
          onToggle={() => setDockOpen((open) => !open)}
          running={live && running}
          onStop={() => streamRef.current?.interrupt()}
          scrubber={
            <Scrubber
              events={events}
              cursor={cursor}
              playback={playback}
              following={following}
              atHead={atHead}
              onSeek={seek}
              onToggleFollow={() => {
                if (following) {
                  playback.pause();
                  setFollowing(false);
                } else {
                  jumpToNow();
                }
              }}
            />
          }
        >
          {/* Every pane stays mounted: xterm replays its whole buffer on
              remount, and panes that exist can crossfade where panes that
              unmount can only snap. */}
          {[
            { id: "terminal" as const, node: <TerminalView data={view.terminal} /> },
            {
              id: "browser" as const,
              node: (
                <BrowserView
                  sessionId={sessionId ?? ""}
                  frame={view.frame}
                  url={view.url}
                  lastAction={view.lastAction}
                />
              ),
            },
            {
              id: "desktop" as const,
              node: <DesktopView sessionId={sessionId ?? ""} desktopFrame={view.desktopFrame} />,
            },
            { id: "files" as const, node: <DiffView files={view.files} /> },
          ].map(({ id, node }) => (
            <div
              key={id}
              id={`pane-${id}`}
              role="tabpanel"
              aria-labelledby={`tab-${id}`}
              className={`pane ${stage === id ? "on" : ""}`}
            >
              {node}
            </div>
          ))}
        </StageDock>

        <div className="composer">
          <div className="composer-box">
            <textarea
              ref={composerRef}
              value={draft}
              rows={2}
              aria-label="Task"
              placeholder={live ? "Describe a task…" : "This session is a recording."}
              disabled={readOnly}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <div className="composer-foot">
              <span className="hint"><kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline</span>
              <button className="btn primary" disabled={readOnly || !draft.trim()} onClick={send}>
                {running ? "Interrupt & send" : "Send"} <IconArrow size={13} />
              </button>
            </div>
          </div>
        </div>
      </main>

      {/* Two tabs: the conversation, and the work scheduled against it. The
          stage and the timeline used to be here and are now in the page. */}
      <nav className="mobile-nav" role="tablist" aria-label="Panel">
        <button
          role="tab"
          aria-selected={mobileTab === "chat" && !scheduleOpen}
          className={`mob-tab ${mobileTab === "chat" && !scheduleOpen ? "on" : ""}${
            pending > 0 ? " has-alert" : ""}`}
          onClick={() => { closeOverlays(); setMobileTab("chat"); }}
        >
          <span className="mob-alert" />
          <IconMessage size={18} />
          Chat
        </button>
        <button
          role="tab"
          aria-selected={scheduleOpen}
          className={`mob-tab ${scheduleOpen ? "on" : ""}`}
          onClick={() => { setMobileTab("tasks"); setScheduleOpen(true); }}
        >
          <IconRepeat size={18} />
          Tasks
        </button>
      </nav>

      {sessionsOpen && (
        <Sessions
          sessions={sessions}
          current={sessionId}
          onPick={(id) => {
            history.replaceState(null, "", `?session=${id}`);
            setSessionId(id);
            setSessionsOpen(false);
          }}
          onNew={newSession}
          onClose={() => setSessionsOpen(false)}
        />
      )}
      {settingsOpen && <Settings onClose={() => setSettingsOpen(false)} />}
      {knowledgeOpen && <KnowledgeWeb onClose={() => setKnowledgeOpen(false)} />}
      {scheduleOpen && (
        <Schedule
          onClose={() => { setScheduleOpen(false); setMobileTab("chat"); }}
          onOpenSession={(id) => {
            history.replaceState(null, "", `?session=${id}`);
            setSessionId(id);
            setScheduleOpen(false);
            setMobileTab("chat");
          }}
        />
      )}
    </div>
  );
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
