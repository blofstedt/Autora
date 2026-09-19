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

type Stage = "terminal" | "browser" | "files";

export function App() {
  const [sessionId, setSessionId] = useState<string | null>(
    () => new URLSearchParams(location.search).get("session"),
  );
  const [sessions, setSessions] = useState<any[]>([]);
  const [events, setEvents] = useState<AutoraEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>({ state: "connecting" });
  const [cursor, setCursor] = useState<number>(-1);
  const [following, setFollowing] = useState(true);
  const [stage, setStage] = useState<Stage>("terminal");
  const [stagePinned, setStagePinned] = useState(false);
  const [draft, setDraft] = useState("");
  const streamRef = useRef<SessionStream | null>(null);

  // -- session list ---------------------------------------------------
  useEffect(() => {
    fetch("/api/sessions")
      .then((r) => r.json())
      .then((rows) => {
        setSessions(rows);
        if (!sessionId && rows.length > 0) setSessionId(rows[0].id);
      })
      .catch(() => undefined);
  }, [sessionId]);

  // -- connect --------------------------------------------------------
  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    setCursor(-1);
    setFollowing(true);
    const stream = new SessionStream(sessionId, {
      onEvents: (fresh) =>
        setEvents((prev) => {
          const next = [...prev, ...fresh];
          // Keep the log ordered even if a resume overlaps a live delivery.
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

  // While following, the cursor tracks the head of the log.
  useEffect(() => {
    if (following) setCursor(events.length - 1);
  }, [events.length, following]);

  const view = useMemo(() => derive(events, cursor), [events, cursor]);

  // Auto-switch panes to whatever the agent is doing, unless the viewer has
  // deliberately pinned one. Following the action is the default; overriding it
  // must stick, or the UI fights you.
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

  return (
    <div className="app">
      <header className="top">
        <div className="brand">
          Autora<span className="spark">●</span>
        </div>
        <select
          className="session-select"
          value={sessionId ?? ""}
          onChange={(e) => {
            history.replaceState(null, "", `?session=${e.target.value}`);
            setSessionId(e.target.value);
          }}
        >
          {sessions.map((s) => (
            <option key={s.id} value={s.id}>
              {s.live ? "● " : "○ "}
              {s.id} {s.title ? `— ${s.title}` : ""}
            </option>
          ))}
        </select>
        <button className="btn ghost" onClick={newSession}>
          new
        </button>
        <div className="spacer" />
        <span className={`status ${status.state}`}>
          {status.state === "live"
            ? view.busy
              ? "agent working"
              : "live"
            : status.state === "recorded"
              ? "recording"
              : status.state}
        </span>
        {view.tokens.in > 0 && (
          <span className="tokens" title="tokens in / out / cached">
            {view.tokens.in}↓ {view.tokens.out}↑ {view.tokens.cached}⚡
          </span>
        )}
        {live && view.busy && (
          <button className="btn stop" onClick={() => streamRef.current?.interrupt()}>
            stop
          </button>
        )}
      </header>

      <div className="body">
        <aside className="left">
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
          <div className="stage-tabs">
            {(["terminal", "browser", "files"] as Stage[]).map((name) => (
              <button
                key={name}
                className={`tab ${stage === name ? "on" : ""}`}
                onClick={() => {
                  setStage(name);
                  setStagePinned(true);
                }}
              >
                {name}
                {name === "files" && view.files.length > 0 && (
                  <em className="badge">{view.files.length}</em>
                )}
              </button>
            ))}
            {stagePinned && (
              <button className="tab unpin" onClick={() => setStagePinned(false)}>
                auto
              </button>
            )}
          </div>

          <div className="stage">
            {/* The terminal stays mounted across tab switches: xterm replays its
                whole buffer on remount, which would be slow and would lose the
                viewer's scroll position. */}
            <div className={`pane ${stage === "terminal" ? "on" : ""}`}>
              <TerminalView data={view.terminal} />
            </div>
            {stage === "browser" && (
              <div className="pane on">
                <BrowserView
                  sessionId={sessionId ?? ""}
                  frame={view.frame}
                  url={view.url}
                  lastAction={view.lastAction}
                />
              </div>
            )}
            {stage === "files" && (
              <div className="pane on">
                <DiffView files={view.files} />
              </div>
            )}
          </div>

          <div className="scrubber">
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
            <span className="scrub-label">
              {cursor + 1} / {events.length}
            </span>
            {!atHead || !following ? (
              <button
                className="btn ghost"
                onClick={() => {
                  setFollowing(true);
                  setCursor(events.length - 1);
                }}
              >
                jump to now
              </button>
            ) : (
              <span className="dim">following</span>
            )}
          </div>
        </main>

        <aside className="right">
          <Transcript turns={view.transcript} busy={view.busy && atHead} />
          <Approvals
            approvals={view.approvals}
            readOnly={readOnly}
            onDecide={(id, approved) => streamRef.current?.approve(id, approved)}
          />
          <div className="composer">
            <textarea
              value={draft}
              placeholder={
                live ? "Tell the agent what to do…" : "This session is a recording."
              }
              disabled={readOnly}
              onChange={(e) => setDraft(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === "Enter" && !e.shiftKey) {
                  e.preventDefault();
                  void send();
                }
              }}
            />
            <button className="btn send" disabled={readOnly || !draft.trim()} onClick={send}>
              {view.busy ? "interrupt & send" : "send"}
            </button>
          </div>
        </aside>
      </div>
    </div>
  );
}
