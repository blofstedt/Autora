import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SessionStream, type StreamStatus } from "./lib/stream";
import { derive, isRunning, type KanbanTask } from "./lib/derive";
import { chime, paintChrome, type Chrome } from "./lib/chrome";
import type { AutoraEvent, BrowserState } from "./lib/types";
import { setLiveFields, setLiveFrame } from "./lib/liveFrame";
import { Thread } from "./components/Thread";
import { Rail, pageLabel, PAGES, type PageId } from "./components/Rail";
import { SessionsPage } from "./components/pages/SessionsPage";
import { SystemPage, isSystemTab, type SystemTab } from "./components/pages/SystemPage";
import { McpPage } from "./components/pages/McpPage";
import { ArtifactsPage } from "./components/pages/ArtifactsPage";
import { MindPage } from "./components/pages/MindPage";
import type { Bucket } from "./lib/memory";
import {
  applyAppearance, cachedAppearance, saveAppearance, type Appearance,
} from "./lib/theme";
import { Sessions, type SessionRow } from "./components/Sessions";
import { Approvals } from "./components/Approvals";
import { Schedule } from "./components/Schedule";
import { Settings, type ConfigTab } from "./components/Settings";
import { DictateButton } from "./components/DictateButton";
import { LiveChat } from "./components/LiveChat";
import { useRelay } from "./components/RelaySetup";
import { UpdateNotice } from "./components/UpdateNotice";
import { AutoraMark, type MarkState } from "./components/AutoraMark";
import {
  dictationSupported, recognitionAvailable, secureOrigin, speakable,
  splitSpeakable, useSpeech,
} from "./lib/voice";
import {
  IconArrow, IconArrowUp, IconChevron, IconMenu, IconStop,
  IconX,
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
  /** The newest frame off the session's browser, and whether there is one at
      all. Held here rather than in the card because the socket is here; it is
      one frame at a time and never accumulates, so re-rendering on it costs a
      picture swap and nothing else. */
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [draft, setDraft] = useState("");
  const [liveOn, setLiveOn] = useState(false);
  const [userSpeaking] = useState(false);
  /** Which page of the app is showing. Chat is the conversation; the rest
      are the sidebar's pages. Kept in the address so a reload stays put. */
  const [page, setPage] = useState<PageId>(() => {
    const asked = new URLSearchParams(location.search).get("page");
    // Memory and Skills were folded into the Mind; old links still land there.
    if (asked === "memory" || asked === "skills") return "mind";
    // API Keys is a section of Config now.
    if (asked === "keys") return "config";
    // Status and Logs are sections of System now.
    if (asked === "status" || asked === "logs") return "system";
    return PAGES.some((p) => p.id === asked) ? (asked as PageId) : "chat";
  });
  /** Which half of Config to open on. An object so asking for the keys
      again, from anywhere, takes you back to them. */
  const [configJump, setConfigJump] = useState<{ tab: ConfigTab }>(() => {
    const params = new URLSearchParams(location.search);
    const keys = params.get("page") === "keys" ||
      (params.get("page") === "config" && params.get("tab") === "keys");
    return { tab: keys ? "keys" : "general" };
  });
  /** Which section of System to open on, from the address. */
  const [systemTab, setSystemTab] = useState<SystemTab>(() => {
    const params = new URLSearchParams(location.search);
    const asked = params.get("page");
    if (asked === "status" || asked === "logs") return asked;
    const tab = params.get("tab");
    return isSystemTab(tab) ? tab : "status";
  });
  /** Which of the Mind's buckets to open on: Skills for a ?page=skills link. */
  const [mindBucket] = useState<{ kind: Bucket }>(
    () => ({ kind: new URLSearchParams(location.search).get("page") === "skills" ? "skill" : "preference" }),
  );
  const [drawerOpen, setDrawerOpen] = useState(false);
  const [appearance, setAppearance] = useState<Appearance>(cachedAppearance);
  const [sessionsOpen, setSessionsOpen] = useState(false);
  const [securePort, setSecurePort] = useState<number | null>(null);
  const [hasCertificate, setHasCertificate] = useState(false);
  /** Something that went wrong where the reader was looking, said in
      words. A phone has no tooltips and no console, so anything reported
      only through `title` is reported to nobody. */
  const [notice, setNotice] = useState<string | null>(null);
  const [voiceHelp, setVoiceHelp] = useState(false);
  const streamRef = useRef<SessionStream | null>(null);
  const composerRef = useRef<HTMLTextAreaElement>(null);
  const speech = useSpeech();
  const { say, cancel: hush, prime, speaking, supported: canSpeak } = speech;
  const relay = useRelay();
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
          // otherwise every session switch restarts the poll. A session that
          // has been deleted gives way to the newest one.
          setSessionId((current) =>
            current && rows.some((r: SessionRow) => r.id === current)
              ? current
              : rows.length > 0 ? rows[0].id : null);
        })
        .catch(() => undefined);
    load();
    const timer = window.setInterval(load, SESSION_POLL_MS);
    return () => {
      alive = false;
      window.clearInterval(timer);
    };
  }, []);

  // The theme saved on the server wins over this browser's cached copy, so a
  // choice made on the desktop shows up on the phone.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        const saved = d?.appearance;
        if (!saved?.theme || !saved?.font) return;
        const next = { theme: saved.theme, font: saved.font } as Appearance;
        setAppearance(next);
        applyAppearance(next);
      })
      .catch(() => undefined);
  }, []);

  const changeAppearance = useCallback((next: Appearance) => {
    setAppearance(next);
    void saveAppearance(next);
  }, []);

  const navigate = useCallback((next: PageId) => {
    setPage(next);
    setDrawerOpen(false);
    setSessionsOpen(false);
    const url = new URL(location.href);
    url.searchParams.delete("tab");
    if (next === "chat") url.searchParams.delete("page");
    else url.searchParams.set("page", next);
    history.replaceState(null, "", url.toString());
  }, []);

  // Where the https copy of this page is listening, if the server put one up.
  // Only interesting on a page that is not itself secure, which is the page
  // that cannot have a microphone.
  useEffect(() => {
    if (secureOrigin) return;
    fetch("/api/origin")
      .then((r) => r.json())
      .then((d) => {
        setSecurePort(typeof d?.secure_port === "number" ? d.secure_port : null);
        setHasCertificate(!!d?.certificate);
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    setEvents([]);
    setLiveFrame(null);
    setLiveFields([]);
    setBrowser(null);
    const stream = new SessionStream(sessionId, {
      onEvents: (fresh) =>
        setEvents((prev) => {
          const next = [...prev, ...fresh];
          next.sort((a, b) => a.seq - b.seq);
          return next;
        }),
      onStatus: setStatus,
      onFrame: setLiveFrame,
      onBrowser: (state) => {
        setLiveFields(state?.fields);
        setBrowser(state);
      },
    });
    streamRef.current = stream;
    stream.connect();
    return () => {
      stream.close();
      streamRef.current = null;
    };
  }, [sessionId]);

  const view = useMemo(() => derive(events), [events]);

  // A page that has been closed has no more frames coming, and the last one
  // to arrive would otherwise sit on the card claiming to be live forever.
  useEffect(() => {
    if (browser && !browser.open) setLiveFrame(null);
  }, [browser]);

  /** Shut the page. Worth a control of its own rather than leaving it to the
      agent: a browser left open is a browser still holding the last thing you
      were looking at, and closing it is the sort of thing you want to be able
      to do yourself. */
  const closeBrowser = useCallback(async () => {
    if (!sessionId) return;
    setLiveFrame(null);
    await fetch(`/api/sessions/${sessionId}/browser`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ action: "close" }),
    }).catch(() => undefined);
  }, [sessionId]);

  // A question from the agent counts: it is the turn waiting on you.
  const pending = useMemo(
    () => view.approvals.filter((a) => !a.settled).length + (view.asking ? 1 : 0),
    [view.approvals, view.asking],
  );
  // An approval is the one thing that must not be missed behind an overlay.
  useEffect(() => {
    if (pending > 0) navigate("chat");
  }, [pending, navigate]);

  // The box grows with what is in it, up to a limit, and shrinks back when
  // it is sent -- a one-line box you have to scroll inside is the thing that
  // made it feel like a form field.
  useLayoutEffect(() => {
    const box = composerRef.current;
    if (!box) return;
    box.style.height = "auto";
    box.style.height = `${Math.min(box.scrollHeight, 240)}px`;
  }, [draft]);

  const send = useCallback(async (spoken?: string) => {
    const text = (spoken ?? draft).trim();
    if (!text || !sessionId) return;
    // Dictated turns never touched the box, so there is nothing to clear and
    // clearing anyway would eat something half-typed.
    if (spoken === undefined) setDraft("");
    await fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => undefined);
  }, [draft, sessionId]);

  /** Stop the turn in flight.
   *
   * Both paths, because the websocket alone was not enough: a phone that has
   * been asleep comes back holding a socket that reports itself OPEN and is
   * not, and `send` drops anything it cannot deliver without a word -- so Stop
   * did nothing, said nothing, and left the agent running. The fetch is the
   * one that can fail loudly, and interrupting twice is free: it sets a flag
   * the loop is already watching.
   */
  const stopTurn = useCallback(async () => {
    streamRef.current?.interrupt();
    if (!sessionId) return;
    try {
      const res = await fetch(`/api/sessions/${sessionId}/interrupt`, { method: "POST" });
      const body = await res.json();
      if (!body?.interrupted) setNotice("Nothing was running to stop.");
    } catch {
      setNotice("Could not reach the server to stop it.");
    }
  }, [sessionId]);

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

  const pickSession = useCallback((id: string) => {
    history.replaceState(null, "", `?session=${id}`);
    setSessionId(id);
    setSessionsOpen(false);
  }, []);

  const live = status.state === "live";
  const readOnly = !live;

  // Whether a turn is running now, read from the tail of the log so a reload
  // mid-turn comes back knowing one is in flight.
  const running = useMemo(() => isRunning(events), [events]);

  /** The agent has its hands on things: a turn is running and it is not
      stopped on a question for you. The browser is locked while this holds. */
  const driving = live && running && !view.asking;
  const browserHandedOver = view.asking?.kind === "browser";


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
    setLiveOn(true);
  }, [liveOn, hush, prime, events]);

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
  // speaking each token is a stutter.
  useEffect(() => {
    if (!liveOn || !canSpeak) return;
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
        narrated.current.set(reply.seq, already + chunk.length);
        const prose = speakable(chunk);
        if (prose) say(prose);
      }
    }
  }, [liveOn, canSpeak, view.buckets, say]);

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

  /** What the mark on the live button is doing.
   *
   *  The icon in the bottom middle should NOT light up when the agent is just
   *  working as normal. It should only light up like that whenever the person
   *  is talking in live mode. When in live mode and listening quietly, it sits
   *  in "live" state as the active indicator. When live mode is off, it stays
   *  quietly in "rest". */
  const liveState: MarkState = liveOn
    ? (userSpeaking ? "working" : "live")
    : "rest";

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
        case "/":
          e.preventDefault();
          composerRef.current?.focus();
          break;
        case "k":
          e.preventDefault();
          navigate(page === "mind" ? "chat" : "mind");
          break;
        case "v":
          e.preventDefault();
          if (readOnly) break;
          if (voiceReady) toggleLive();
          else if (voiceBlocked) setVoiceHelp(true);
          break;
        case "Escape":
          setSessionsOpen(false);
          setDrawerOpen(false);
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [toggleLive, readOnly, voiceReady, voiceBlocked, navigate, page]);

  const currentName =
    sessions.find((s) => s.id === sessionId)?.title?.trim() ||
    view.title ||
    "Untitled session";

  const openKnowledge = useCallback(() => navigate("mind"), [navigate]);

  const refreshSessions = useCallback(() => {
    fetch("/api/sessions").then((r) => r.json()).then(setSessions).catch(() => undefined);
  }, []);

  const openSession = useCallback((id: string) => {
    pickSession(id);
    navigate("chat");
  }, [navigate, pickSession]);

  const handlePermissionDecide = useCallback(async (requestId: string, approved: boolean, response?: string) => {
    await fetch(`/api/policy/${requestId}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ approved, response, who: "user" }),
    }).catch(() => undefined);
  }, []);

  const handleRunAutonomous = useCallback(async (task: KanbanTask) => {
    if (!sessionId) return;
    await fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: `Autonomously execute task: "${task.title}"` }),
    }).catch(() => undefined);
  }, [sessionId]);

  return (
    <div className="app">
      {/* Wide screens get the session list in the margin instead of behind a
          sheet; narrow ones never render it at all. */}
      {/* The sidebar: in the margin on a desktop, a drawer on a phone. */}
      {(["rail", "drawer"] as const).map((kind) => kind === "drawer" && !drawerOpen ? null : (
        <div
          key={kind}
          className={kind === "drawer" ? "drawer-scrim" : "rail-slot"}
          onClick={kind === "drawer"
            ? (e) => { if (e.target === e.currentTarget) setDrawerOpen(false); }
            : undefined}
        >
          <Rail
            page={page}
            onNavigate={(next) => {
              // From the menu, a page opens on its first section.
              if (next === "config") setConfigJump({ tab: "general" });
              if (next === "system") setSystemTab("status");
              navigate(next);
            }}
            relayOn={!!relay?.connected}
            alert={pending > 0}
            onNew={() => { void newSession(); navigate("chat"); }}
            appearance={appearance}
            onAppearance={changeAppearance}
            drawer={kind === "drawer"}
            onClose={() => setDrawerOpen(false)}
          />
        </div>
      ))}

      <div className="shell">
        {/* Above everything, including the header: an app running code that is
            two releases old is not a detail to mention further down. */}
        <UpdateNotice />

        <header className="top">
          <button
            className="btn icon ghost menu-btn"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open the menu"
            title="Menu"
          >
            <IconMenu size={18} />
          </button>

          {page !== "chat" ? (
            <h1 className="top-title">{pageLabel(page)}</h1>
          ) : (
          <button
            className="session-btn"
            onClick={() => setSessionsOpen(true)}
            title="Switch session"
          >
            <span className={`ses-dot ${live ? "is-live" : ""}`} />
            <span className="session-name">{currentName}</span>
            <IconChevron size={12} />
          </button>
          )}

          <div className="spacer" />

          {/* A page is open somewhere up the thread. Said here because the
              card carrying it scrolls away, and a browser you have forgotten
              is open is the one worth mentioning. */}
          {browser?.open && (
            <span className="badge browsing" title={browser.url ?? "a page is open"}>
              <span className="watch-dot" aria-hidden="true" />
              <span className="badge-host">{hostOf(browser.url)}</span>
              <button
                className="badge-x"
                onClick={() => void closeBrowser()}
                aria-label="Close the page"
                title="Close the page"
              >
                <IconX size={10} />
              </button>
            </span>
          )}
          {view.tokens.in > 0 && (
            <span className="badge tokens" title="tokens in / out / cached">
              {fmt(view.tokens.in)} in · {fmt(view.tokens.out)} out ·{" "}
              {fmt(view.tokens.cached)} cached
            </span>
          )}
        </header>

        {page !== "chat" && (
          <div className="page-host">
            {page === "config" && (
              <Settings key={`config-${configJump.tab}`} section="config" embedded initialTab={configJump.tab} />
            )}
            {page === "analytics" && <Settings key="analytics" section="analytics" embedded />}
            {page === "system" && (
              <SystemPage
                key={systemTab}
                initialTab={systemTab}
                sessions={sessions}
                onOpenSession={openSession}
                onNavigate={navigate}
              />
            )}
            {page === "sessions" && (
              <SessionsPage current={sessionId} onOpen={openSession} onChanged={refreshSessions} />
            )}
            {page === "artifacts" && <ArtifactsPage sessions={sessions} onOpenSession={openSession} />}
            {page === "mcp" && <McpPage />}
            {page === "cron" && <Schedule embedded onOpenSession={openSession} />}
            {page === "mind" && (
              <MindPage jump={mindBucket} recent={view.memories} />
            )}
          </div>
        )}

        {/* The conversation stays mounted under the other pages, so leaving
            it and coming back keeps your place in the thread. */}
        <div className="chat-view" hidden={page !== "chat"}>

        <main className="page">
          <Thread
            buckets={view.buckets}
            // Stopped on a question is not working; the card says what it is.
            busy={view.busy && !view.asking}
            sessionId={sessionId ?? ""}
            liveBrowserSeq={view.liveBrowserSeq}
            live={live}
            onPermissionDecide={handlePermissionDecide}
            onRunAutonomous={handleRunAutonomous}
            driving={driving}
            browserHandedOver={browserHandedOver}
            onStop={() => void stopTurn()}
            onOpenMind={openKnowledge}
          />

          <Approvals
            approvals={view.approvals}
            readOnly={readOnly}
            onDecide={(id, approved) => streamRef.current?.approve(id, approved)}
          />

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
                      {hasCertificate && (
                        <em className="voice-help-trust">
                          Rather not see that warning — or install this to your home
                          screen? <a href="/autora-ca.crt" download>Install the
                          certificate</a>, and this becomes an ordinary trusted
                          site on this device. Settings explains where it goes.
                        </em>
                      )}
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
              <>
                <div className={`composer-box ${draft.trim() ? "has-text" : ""}`}>
                  {/* On a phone or tablet the live control floats just above
                      Send, where the thumb already is. It steps aside while
                      the voice note above is up, so it does not cover it. */}
                  {!voiceHelp && (
                  <button
                    type="button"
                    className={`mob-live-btn composer-float is-${liveState}`}
                    onClick={voiceReady ? toggleLive : () => setVoiceHelp(true)}
                    disabled={readOnly}
                    title={voiceReady ? "Start live voice chat" : "Live voice requires https"}
                    aria-label="Live voice chat"
                    aria-pressed={liveOn}
                  >
                    <span className="mob-live-glow" aria-hidden="true" />
                    <AutoraMark state={liveState} size={23} />
                  </button>
                  )}
                  <textarea
                    ref={composerRef}
                    value={draft}
                    rows={1}
                    aria-label="Task"
                    placeholder={live ? "Ask Autora to do something…" : "This session is a recording."}
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
                    <div className="composer-tools">
                      <DictateButton
                        onText={appendDictation}
                        disabled={readOnly}
                        onBlocked={() => setVoiceHelp(true)}
                        onTrouble={setNotice}
                      />
                      {/* Only shown on a desktop, where the control floating
                          above Send is hidden. */}
                      <button
                        className="btn icon ghost composer-live"
                        onClick={voiceReady ? toggleLive : () => setVoiceHelp(true)}
                        disabled={readOnly}
                        title={voiceReady ? "Start live voice chat (v)" : "Live voice requires https"}
                        aria-label="Live voice chat"
                      >
                        <AutoraMark state="rest" size={18} />
                      </button>
                      {notice ? (
                        <button
                          className="hint voice-note"
                          onClick={() => setNotice(null)}
                          title="Dismiss"
                        >
                          {notice}
                        </button>
                      ) : voiceBlocked ? (
                        <button
                          className="hint voice-note"
                          onClick={() => setVoiceHelp(true)}
                          title="Browsers only allow microphone access on a secure page."
                        >
                          Voice needs <code>https</code>
                        </button>
                      ) : null}
                    </div>
                    <div className="composer-acts">
                      {/* Stop sits with Send: they are the same decision. */}
                      {live && running && (
                        <button
                          className="composer-stop"
                          onClick={() => void stopTurn()}
                          title="Stop the agent"
                          aria-label="Stop the agent"
                        >
                          <IconStop size={14} />
                        </button>
                      )}
                      <button
                        className="composer-send"
                        disabled={readOnly || !draft.trim()}
                        onClick={() => void send()}
                        title={running ? "Interrupt & send" : "Send"}
                        aria-label={running ? "Interrupt & send" : "Send"}
                      >
                        <IconArrowUp size={17} />
                      </button>
                    </div>
                  </div>
                </div>
                <p className="composer-hint">
                  <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line
                </p>
              </>
            )}
          </div>
        </main>
        </div>

      </div>

      {sessionsOpen && (
        <Sessions
          sessions={sessions}
          current={sessionId}
          onPick={pickSession}
          onNew={newSession}
          onClose={() => setSessionsOpen(false)}
          onChanged={refreshSessions}
          onDeleted={(id, remaining) => {
            if (id !== sessionId) return;
            // The open session is gone: move to the next one, or a fresh one,
            // and leave the list open so the tidying can carry on.
            const next = remaining[0]?.id;
            if (next) {
              history.replaceState(null, "", `?session=${next}`);
              setSessionId(next);
            } else {
              void newSession().then(() => setSessionsOpen(true));
            }
          }}
        />
      )}
    </div>
  );
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));

/** Just the site, for a badge with room for about fifteen characters. */
function hostOf(url: string | null): string {
  if (!url) return "a page";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.slice(0, 24);
  }
}
