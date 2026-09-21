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
import { DictateButton } from "./components/DictateButton";
import { LiveChat } from "./components/LiveChat";
import {
  dictationSupported, recognitionAvailable, secureOrigin, speakable,
  splitSpeakable, useSpeech,
} from "./lib/voice";
import {
  IconArrow, IconChevron, IconGear, IconMessage, IconRepeat, IconSpark, IconWave, IconX,
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
  const [liveOn, setLiveOn] = useState(false);
  const [mobileTab, setMobileTab] = useState<"chat" | "tasks">("chat");
  const [knowledgeOpen, setKnowledgeOpen] = useState(false);
  const [scheduleOpen, setScheduleOpen] = useState(false);
  const [settingsOpen, setSettingsOpen] = useState(false);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [securePort, setSecurePort] = useState<number | null>(null);
  const [voiceHelp, setVoiceHelp] = useState(false);
  const streamRef = useRef<SessionStream | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const speech = useSpeech();
  const { say, cancel: hush, prime, speaking, supported: canSpeak } = speech;
  /** How much of each reply has been read out, so streaming text is spoken
      once and in order rather than re-read from the top on every token. */
  const narrated = useRef(new Map<number, number>());
  /** Replies at or before this sequence predate live chat and are not read
      aloud -- turning the microphone on should not recite the backlog. */
  const narrateAfter = useRef(-1);

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

  // Where the https copy of this page is listening, if the server put one up.
  // Only interesting on a page that is not itself secure, which is the page
  // that cannot have a microphone.
  useEffect(() => {
    if (secureOrigin) return;
    fetch("/api/origin")
      .then((r) => r.json())
      .then((d) => setSecurePort(typeof d?.secure_port === "number" ? d.secure_port : null))
      .catch(() => undefined);
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

  const send = useCallback(async (spoken?: string) => {
    const text = (spoken ?? draft).trim();
    if (!text || !sessionId) return;
    // Dictated turns never touched the box, so there is nothing to clear and
    // clearing anyway would eat something half-typed.
    if (spoken === undefined) setDraft("");
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

  // ------------------------------------------------------------ live chat --
  /** Turning it on has to happen inside the tap: iOS will not let a page speak
      unless the first utterance descends from a gesture. */
  const toggleLive = useCallback(() => {
    if (liveOn) {
      setLiveOn(false);
      hush();
      return;
    }
    prime();
    narrated.current.clear();
    narrateAfter.current = events[events.length - 1]?.seq ?? -1;
    jumpToNow();
    setLiveOn(true);
  }, [liveOn, hush, prime, events, jumpToNow]);

  // A recording has nothing to say back, and a session switch drops the thread
  // the voice was holding. Either way, hang up rather than listen to a page
  // that cannot answer.
  useEffect(() => {
    if (!liveOn) return;
    if (!live) { setLiveOn(false); hush(); }
  }, [live, liveOn, hush]);
  useEffect(() => {
    setLiveOn(false);
    hush();
  }, [sessionId, hush]);

  // Read the agent's replies out loud, a sentence at a time as they stream --
  // waiting for the whole answer is a silence as long as the answer, and
  // speaking each token is a stutter. Only at the head: scrubbing back through
  // a recording should not start narrating history.
  useEffect(() => {
    if (!liveOn || !canSpeak || !atHead) return;
    for (const bucket of view.buckets) {
      for (const reply of bucket.replies) {
        if (reply.seq <= narrateAfter.current) continue;
        const already = narrated.current.get(reply.seq) ?? 0;
        const rest = reply.text.slice(already);
        if (!rest) continue;
        // Once the turn has landed there is no more text coming, so the tail
        // is spoken whether or not it ends in a full stop.
        const chunk = bucket.open ? splitSpeakable(rest)[0] : rest;
        if (!chunk.trim()) continue;
        // The offset counts raw characters; scrubbing changes the length.
        narrated.current.set(reply.seq, already + chunk.length);
        const prose = speakable(chunk);
        if (prose) say(prose);
      }
    }
  }, [liveOn, canSpeak, atHead, view.buckets, say]);

  /** A spoken turn goes straight out: barge in over whatever is being said,
      then send. */
  const sendSpoken = useCallback((text: string) => {
    hush();
    void send(text);
  }, [hush, send]);

  const appendDictation = useCallback((text: string) => {
    // No focus() -- on a phone that throws the keyboard over the thread you
    // were watching, which is the thing dictation was meant to avoid.
    setDraft((current) => (current ? `${current.replace(/\s+$/, "")} ${text}` : text));
  }, []);

  const voiceReady = dictationSupported && canSpeak;
  /* An http page cannot have voice. The controls stay anyway, disabled, and
     say what is wrong -- dropping them left people hunting for a microphone
     that was never going to appear, and concluding it had not been built. A
     browser with no engine at all still gets nothing: that one has no fix. */
  const voiceBlocked = !secureOrigin && (recognitionAvailable || !!canSpeak);

  /** The same page over https, where the microphone is allowed. Built from the
      address that already worked: whatever name reached the http listener is
      the one this browser is known to have a route to. */
  const secureUrl = useMemo(() => {
    if (secureOrigin || !securePort) return null;
    const url = new URL(location.href);
    url.protocol = "https:";
    url.port = String(securePort);
    return url.toString();
  }, [securePort]);

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
        case "v":
          e.preventDefault();
          if (readOnly) break;
          if (voiceReady) toggleLive();
          else if (voiceBlocked) setVoiceHelp(true);
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
  }, [playback, step, seek, jumpToNow, toggleLive, readOnly, voiceReady, voiceBlocked]);

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

        {/* The screen above stays exactly as it was; only this strip changes,
            because the point of talking to it is to keep watching it work. */}
        <div className={`composer ${liveOn ? "is-live" : ""}`}>
          {/* Said here rather than in a settings page nobody opens: the button
              that did not work is two inches below it. */}
          {voiceHelp && !liveOn && (
            <div className="voice-help" role="status">
              <div className="voice-help-text">
                {secureUrl ? (
                  <>
                    <b>Voice lives on the secure page.</b> Browsers only open a
                    microphone over a secure connection, and this page is not one.
                    The same session is running on one — open it and the
                    microphone appears.
                    <em className="voice-help-aside">
                      Your browser will warn you once that it does not recognise
                      the certificate. That is expected: the certificate is your
                      own server's. Tap <b>Advanced</b>, then <b>Proceed</b>.
                    </em>
                  </>
                ) : (
                  <>
                    <b>Voice needs a secure page.</b> Browsers only open a
                    microphone over a secure connection, and this page is not one
                    — no site setting can change that, because the restriction is
                    not about trusting this site.
                    <em className="voice-help-aside">
                      The fix is in front of the server, not in the browser. On a
                      tailnet, <code>tailscale serve --bg {location.port || 80}</code>{" "}
                      on the machine running Autora gives this page a real
                      certificate and a secure address; any reverse proxy with a
                      certificate does the same. See the README.
                    </em>
                  </>
                )}
              </div>
              {secureUrl && (
                <a className="btn primary" href={secureUrl}>
                  Open the secure page <IconArrow size={13} />
                </a>
              )}
              <button
                className="btn icon ghost"
                onClick={() => setVoiceHelp(false)}
                aria-label="Dismiss"
              >
                <IconX size={14} />
              </button>
            </div>
          )}
          {liveOn ? (
            <LiveChat
              onUtterance={sendSpoken}
              onExit={toggleLive}
              onInterrupt={hush}
              agentSpeaking={speaking}
              agentWorking={running}
              disabled={readOnly}
            />
          ) : (
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
                {voiceBlocked ? (
                  <button
                    className="hint voice-note"
                    onClick={() => setVoiceHelp(true)}
                    title="Browsers only allow microphone access on a secure page."
                  >
                    Voice needs <code>https</code>
                  </button>
                ) : (
                  <span className="hint"><kbd>↵</kbd> send · <kbd>⇧↵</kbd> newline</span>
                )}
                <div className="composer-acts">
                  <DictateButton
                    onText={appendDictation}
                    disabled={readOnly}
                    onBlocked={() => setVoiceHelp(true)}
                  />
                  {(voiceReady || voiceBlocked) && (
                    <button
                      className={`btn ghost live-start ${voiceReady ? "" : "is-blocked"}`}
                      onClick={voiceReady ? toggleLive : () => setVoiceHelp(true)}
                      disabled={readOnly}
                      title={voiceReady ? "Live voice chat" : "Live voice chat needs an https page"}
                      aria-label={
                        voiceReady ? "Start live voice chat" : "Why live voice chat is unavailable"
                      }
                    >
                      <IconWave size={14} />
                      <span className="live-start-word">Live</span>
                    </button>
                  )}
                  <button
                    className="btn primary"
                    disabled={readOnly || !draft.trim()}
                    onClick={() => void send()}
                  >
                    {running ? "Interrupt & send" : "Send"} <IconArrow size={13} />
                  </button>
                </div>
              </div>
            </div>
          )}
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
