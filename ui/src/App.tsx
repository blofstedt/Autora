import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionStream, type StreamStatus } from "./lib/stream";
import { derive, inferStage } from "./lib/derive";
import { HIDDEN_KINDS } from "./lib/describe";
import { usePlayback } from "./lib/playback";
import { chime, paintChrome, type Chrome } from "./lib/chrome";
import type { AutoraEvent } from "./lib/types";
import { Timeline } from "./components/Timeline";
import { Transcript } from "./components/Transcript";
import { TerminalView } from "./components/TerminalView";
import { BrowserView } from "./components/BrowserView";
import { DesktopView } from "./components/DesktopView";
import { DiffView } from "./components/DiffView";
import { Approvals } from "./components/Approvals";
import { Scrubber } from "./components/Scrubber";
import { KnowledgeWeb } from "./components/KnowledgeWeb";
import { Schedule } from "./components/Schedule";
import {
  IconArrow, IconBrain, IconChevron, IconClock, IconFile, IconGlobe, IconMessage,
  IconMonitor, IconPlus, IconRepeat, IconSpark, IconStop, IconTerminal,
} from "./components/Icons";

type Stage = "terminal" | "browser" | "files" | "desktop";

const STAGES: { id: Stage; label: string; icon: typeof IconTerminal }[] = [
  { id: "terminal", label: "Terminal", icon: IconTerminal },
  { id: "browser", label: "Browser", icon: IconGlobe },
  { id: "desktop", label: "Desktop", icon: IconMonitor },
  { id: "files", label: "Files", icon: IconFile },
];

/** How often to re-read the session list, so sessions started elsewhere (or
    from another tab) show up without a reload. */
const SESSION_POLL_MS = 10_000;

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(
    () => new URLSearchParams(location.search).get("session"),
  );
  const [sessions, setSessions] = useState<any[]>([]);
  const [events, setEvents] = useState<AutoraEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>({ state: "connecting" });
  const [cursor, setCursor] = useState(-1);
  const [following, setFollowing] = useState(true);
  const [stage, setStage] = useState<Stage>("terminal");
  const [stagePinned, setStagePinned] = useState(false);
  const [railOpen, setRailOpen] = useState(true);
  const [draft, setDraft] = useState("");
  const [mobileTab, setMobileTab] = useState<"stage" | "chat" | "timeline">("stage");
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
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

  // ------------------------------------------------------------- playback --
  // Replay moves the cursor but does not pin it: reaching the head hands
  // control back to following, so a recording that catches up with a live
  // session simply becomes a live session again.
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

  const jumpToNow = useCallback(() => {
    playback.pause();
    setFollowing(true);
    setCursor(events.length - 1);
  }, [playback, events.length]);

  /** Step to the next/previous event the timeline actually shows, skipping the
      streaming chatter -- otherwise ⇧→ walks through 400 PTY chunks. */
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

  // On mobile, jump to Chat when an approval appears so it's never missed.
  const pending = useMemo(
    () => view.approvals.filter((a) => !a.settled).length,
    [view.approvals],
  );
  useEffect(() => {
    if (pending > 0) setMobileTab("chat");
  }, [pending]);

  // Follow the action by default; a deliberate pin must stick, or the UI fights
  // whoever is trying to look at something. Unpinned it tracks the cursor
  // rather than the head, so replaying a session switches panes the same way
  // watching it live did.
  useEffect(() => {
    if (stagePinned) return;
    setStage(inferStage(events, cursor));
  }, [events, cursor, stagePinned]);

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
  }, []);

  const live = status.state === "live";
  const readOnly = !live;
  const atHead = cursor >= events.length - 1;

  // ---------------------------------------------------------- tab chrome --
  const chromeState: Chrome = pending > 0
    ? "approval"
    : !live
      ? status.state === "closed" ? "offline" : "idle"
      : view.busy ? "working" : "live";

  useEffect(() => {
    paintChrome(chromeState, view.title);
  }, [chromeState, view.title]);

  // A chime only when the tab is in the background -- on screen, the amber card
  // is already the loudest thing in the window.
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
        case "Escape":
          setKnowledgeOpen(false);
          setScheduleOpen(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [playback, step, seek, jumpToNow]);

  const badge = view.busy && live
    ? { cls: "is-working", text: "working" }
    : live
      ? { cls: "is-live", text: "live" }
      : status.state === "recorded"
        ? { cls: "is-recorded", text: "recording" }
        : status.state === "connecting"
          ? { cls: "", text: "connecting" }
          : { cls: "is-closed", text: "offline" };

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          <span className="brand-mark"><IconSpark size={13} /></span>
          Autora
        </div>

        <button
          className="btn icon ghost rail-toggle"
          onClick={() => setRailOpen(!railOpen)}
          title={railOpen ? "Hide timeline" : "Show timeline"}
          aria-label={railOpen ? "Hide timeline" : "Show timeline"}
          aria-expanded={railOpen}
          style={{ transform: railOpen ? "rotate(180deg)" : undefined }}
        >
          <IconChevron size={14} />
        </button>

        <div className="session-pill">
          <select
            value={sessionId ?? ""}
            aria-label="Session"
            onChange={(e) => {
              history.replaceState(null, "", `?session=${e.target.value}`);
              setSessionId(e.target.value);
            }}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {/* Title first: the id is a timestamp and a nonce, which is how
                    you find a session again, not how you recognise one. */}
                {s.live ? "● " : "○ "}{s.title ? `${s.title} · ${s.id}` : s.id}
              </option>
            ))}
          </select>
          <button className="btn icon ghost" onClick={newSession} title="New session" aria-label="New session">
            <IconPlus size={14} />
          </button>
        </div>

        <div className="spacer" />

        {view.tokens.in > 0 && (
          <span className="badge tokens" title="tokens in / out / cached">
            {fmt(view.tokens.in)} in · {fmt(view.tokens.out)} out · {fmt(view.tokens.cached)} cached
          </span>
        )}
        <span className={`badge status ${badge.cls}`}>
          <span className="dot" />
          {badge.text}
        </span>
        <button
          className="btn icon ghost"
          onClick={() => setScheduleOpen(true)}
          title="Scheduled tasks"
          aria-label="Open scheduled tasks"
        >
          <IconRepeat size={15} />
        </button>
        <button
          className="btn icon ghost"
          onClick={() => setKnowledgeOpen(true)}
          title="What the agent knows"
          aria-label="Open knowledge web"
        >
          <IconBrain size={15} />
        </button>
        {live && view.busy && (
          <button className="btn danger" onClick={() => streamRef.current?.interrupt()}>
            <IconStop size={13} /> Stop
          </button>
        )}
      </header>

      <div className={`body ${railOpen ? "" : "rail-closed"}`} data-tab={mobileTab}>
        <aside className="rail">
          <div className="panel-head">
            <span className="panel-title">Timeline</span>
            <span className="panel-title">{events.length}</span>
          </div>
          <Timeline events={events} cursor={cursor} onSeek={seek} />
        </aside>

        <main className="center">
          <div className="stage-bar">
            <div className="segmented" role="tablist" aria-label="Stage">
              {STAGES.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  role="tab"
                  id={`tab-${id}`}
                  aria-selected={stage === id}
                  aria-controls={`pane-${id}`}
                  className={`seg ${stage === id ? "on" : ""}`}
                  onClick={() => { setStage(id); setStagePinned(true); }}
                >
                  <Icon size={14} />
                  {label}
                  {id === "files" && view.files.length > 0 && (
                    <em className="count">{view.files.length}</em>
                  )}
                  {id === "desktop" && view.hasDesktop && (
                    <em className="count">●</em>
                  )}
                </button>
              ))}
            </div>
            <div className="spacer" />
            {stagePinned && (
              <button className="btn ghost" onClick={() => setStagePinned(false)}>
                Follow agent
              </button>
            )}
          </div>

          {/* Every pane stays mounted. xterm replays its whole buffer on
              remount, and the others keep their scroll position -- and panes
              that exist can crossfade, where panes that unmount can only snap. */}
          <div className="stage">
            {STAGES.map(({ id }) => (
              <div
                key={id}
                id={`pane-${id}`}
                role="tabpanel"
                aria-labelledby={`tab-${id}`}
                className={`pane ${stage === id ? "on" : ""}`}
              >
                {id === "terminal" && <TerminalView data={view.terminal} />}
                {id === "browser" && (
                  <BrowserView
                    sessionId={sessionId ?? ""}
                    frame={view.frame}
                    url={view.url}
                    lastAction={view.lastAction}
                  />
                )}
                {id === "desktop" && (
                  <DesktopView sessionId={sessionId ?? ""} desktopFrame={view.desktopFrame} />
                )}
                {id === "files" && <DiffView files={view.files} />}
              </div>
            ))}
          </div>

          <Scrubber
            events={events}
            cursor={cursor}
            playback={playback}
            following={following}
            atHead={atHead}
            onSeek={seek}
            onJumpToNow={jumpToNow}
          />
        </main>

        <aside className="side">
          <div className="panel-head">
            <span className="panel-title">Conversation</span>
          </div>
          <Transcript turns={view.transcript} busy={view.busy && atHead} />
          <Approvals
            approvals={view.approvals}
            readOnly={readOnly}
            onDecide={(id, approved) => streamRef.current?.approve(id, approved)}
          />
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
                  {view.busy ? "Interrupt & send" : "Send"} <IconArrow size={13} />
                </button>
              </div>
            </div>
          </div>
        </aside>
      </div>

      {/* Bottom tab bar — hidden on desktop via CSS, shown on mobile */}
      <nav className="mobile-nav" role="tablist" aria-label="Panel">
        <button
          role="tab"
          aria-selected={mobileTab === "stage"}
          className={`mob-tab ${mobileTab === "stage" ? "on" : ""}`}
          onClick={() => setMobileTab("stage")}
        >
          <IconTerminal size={18} />
          Stage
        </button>
        <button
          role="tab"
          aria-selected={mobileTab === "chat"}
          className={`mob-tab ${mobileTab === "chat" ? "on" : ""}${pending > 0 ? " has-alert" : ""}`}
          onClick={() => setMobileTab("chat")}
        >
          <span className="mob-alert" />
          <IconMessage size={18} />
          Chat
        </button>
        <button
          role="tab"
          aria-selected={mobileTab === "timeline"}
          className={`mob-tab ${mobileTab === "timeline" ? "on" : ""}`}
          onClick={() => setMobileTab("timeline")}
        >
          <IconClock size={18} />
          Timeline
        </button>
        {/* Tasks is a launcher rather than a fourth panel: the three panels are
            the live session, and a schedule is about sessions that do not exist
            yet. It opens the same overlay the header button does. */}
        <button
          role="tab"
          aria-selected={scheduleOpen}
          className={`mob-tab ${scheduleOpen ? "on" : ""}`}
          onClick={() => setScheduleOpen(true)}
        >
          <IconRepeat size={18} />
          Tasks
        </button>
      </nav>

      {knowledgeOpen && <KnowledgeWeb onClose={() => setKnowledgeOpen(false)} />}
      {scheduleOpen && (
        <Schedule
          onClose={() => setScheduleOpen(false)}
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
