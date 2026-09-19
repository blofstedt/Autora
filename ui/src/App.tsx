import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { SessionStream, type StreamStatus } from "./lib/stream";
import { derive, inferStage } from "./lib/derive";
import type { AutoraEvent } from "./lib/types";
import { Timeline } from "./components/Timeline";
import { Transcript } from "./components/Transcript";
import { TerminalView } from "./components/TerminalView";
import { BrowserView } from "./components/BrowserView";
import { DiffView } from "./components/DiffView";
import { Approvals } from "./components/Approvals";
import {
  IconArrow, IconChevron, IconClock, IconFile, IconGlobe, IconMessage,
  IconPlus, IconSpark, IconStop, IconTerminal,
} from "./components/Icons";

type Stage = "terminal" | "browser" | "files";

const STAGES: { id: Stage; label: string; icon: typeof IconTerminal }[] = [
  { id: "terminal", label: "Terminal", icon: IconTerminal },
  { id: "browser", label: "Browser", icon: IconGlobe },
  { id: "files", label: "Files", icon: IconFile },
];

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
  const streamRef = useRef<SessionStream | null>(null);

  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((rows) => {
        setSessions(rows);
        if (!sessionId && rows.length > 0) setSessionId(rows[0].id);
      })
      .catch(() => undefined);
  }, [sessionId]);

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

  // On mobile, jump to Chat when an approval appears so it's never missed.
  useEffect(() => {
    if (view.approvals.length > 0) setMobileTab("chat");
  }, [view.approvals.length]);

  // Follow the action by default; a deliberate pin must stick, or the UI fights
  // whoever is trying to look at something.
  useEffect(() => {
    if (stagePinned || !following) return;
    setStage(inferStage(events, cursor));
  }, [events, cursor, stagePinned, following]);

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
  const progress = events.length > 1 ? ((cursor + 1) / events.length) * 100 : 0;

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
          style={{ transform: railOpen ? "rotate(180deg)" : undefined }}
        >
          <IconChevron size={14} />
        </button>

        <div className="session-pill">
          <select
            value={sessionId ?? ""}
            onChange={(e) => {
              history.replaceState(null, "", `?session=${e.target.value}`);
              setSessionId(e.target.value);
            }}
          >
            {sessions.map((s) => (
              <option key={s.id} value={s.id}>
                {s.live ? "● " : "○ "}{s.id}{s.title ? ` — ${s.title}` : ""}
              </option>
            ))}
          </select>
          <button className="btn icon ghost" onClick={newSession} title="New session">
            <IconPlus size={14} />
          </button>
        </div>

        <div className="spacer" />

        {view.tokens.in > 0 && (
          <span className="badge tokens" title="tokens in / out / cached">
            {fmt(view.tokens.in)} in · {fmt(view.tokens.out)} out · {fmt(view.tokens.cached)} cached
          </span>
        )}
        <span className={`badge ${badge.cls}`}>
          <span className="dot" />
          {badge.text}
        </span>
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
          <Timeline
            events={events}
            cursor={cursor}
            onSeek={(index) => {
              setFollowing(false);
              setCursor(index);
            }}
          />
        </aside>

        <main className="center">
          <div className="stage-bar">
            <div className="segmented">
              {STAGES.map(({ id, label, icon: Icon }) => (
                <button
                  key={id}
                  className={`seg ${stage === id ? "on" : ""}`}
                  onClick={() => { setStage(id); setStagePinned(true); }}
                >
                  <Icon size={14} />
                  {label}
                  {id === "files" && view.files.length > 0 && (
                    <em className="count">{view.files.length}</em>
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

          <div className="stage">
            {/* The terminal stays mounted across tab switches: xterm replays its
                entire buffer on remount, which is slow and loses scroll position. */}
            <div className={`pane ${stage === "terminal" ? "on" : ""}`}>
              <TerminalView data={view.terminal} />
            </div>
            <div className={`pane ${stage === "browser" ? "on" : ""}`}>
              {stage === "browser" && (
                <BrowserView
                  sessionId={sessionId ?? ""}
                  frame={view.frame}
                  url={view.url}
                  lastAction={view.lastAction}
                />
              )}
            </div>
            <div className={`pane ${stage === "files" ? "on" : ""}`}>
              {stage === "files" && <DiffView files={view.files} />}
            </div>
          </div>

          <div className="scrub">
            <div className="track">
              <span className="fill" style={{ width: `${progress}%` }} />
              <input
                type="range"
                min={-1}
                max={Math.max(events.length - 1, 0)}
                value={cursor}
                onChange={(e) => {
                  setFollowing(false);
                  setCursor(Number(e.target.value));
                }}
              />
            </div>
            <span className="counter">{cursor + 1} / {events.length}</span>
            {following && atHead ? (
              <span className="badge is-live"><span className="dot" />following</span>
            ) : (
              <button
                className="btn primary"
                onClick={() => { setFollowing(true); setCursor(events.length - 1); }}
              >
                Jump to now <IconArrow size={13} />
              </button>
            )}
          </div>
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
                value={draft}
                rows={2}
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
      <nav className="mobile-nav">
        <button
          className={`mob-tab ${mobileTab === "stage" ? "on" : ""}`}
          onClick={() => setMobileTab("stage")}
        >
          <IconTerminal size={18} />
          Stage
        </button>
        <button
          className={`mob-tab ${mobileTab === "chat" ? "on" : ""}${view.approvals.length > 0 ? " has-alert" : ""}`}
          onClick={() => setMobileTab("chat")}
        >
          <span className="mob-alert" />
          <IconMessage size={18} />
          Chat
        </button>
        <button
          className={`mob-tab ${mobileTab === "timeline" ? "on" : ""}`}
          onClick={() => setMobileTab("timeline")}
        >
          <IconClock size={18} />
          Timeline
        </button>
      </nav>
    </div>
  );
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
