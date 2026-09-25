import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SessionStream, type StreamStatus } from "./lib/stream";
import { derive, isRunning, type KanbanTask } from "./lib/derive";
import { chime, paintChrome, type Chrome } from "./lib/chrome";
import { Kind, type AutoraEvent, type BrowserState } from "./lib/types";
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
import { SlashMenu } from "./components/SlashMenu";
import { resolve as resolveCommand, suggest as suggestCommands, type Command } from "./lib/commands";
import { LiveChat } from "./components/LiveChat";
import { useRelay } from "./components/RelaySetup";
import { UpdateNotice } from "./components/UpdateNotice";
import { SetupCard, Welcome } from "./components/SetupCard";
import { flySpark, visible } from "./lib/presence";
import { Notices } from "./components/Notices";
import { AutoraMark, type MarkState } from "./components/AutoraMark";
import { activity } from "./lib/activity";
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
/** How old a speak event may be and still be played: long enough for a slow
    connection to deliver it, short enough that a reload is not a recital. */
const SPEAK_FRESH_S = 30;

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
    if (params.get("page") === "keys") return { tab: "keys" };
    const tab = params.get("page") === "config" ? params.get("tab") : null;
    return { tab: tab === "keys" || tab === "credentials" || tab === "appearance" ? tab : "general" };
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
  /** Whether a turn sent now would reach a model: null until asked. The empty
      chat offers setup until it is true, and starting tasks after. */
  const [modelReady, setModelReady] = useState<boolean | null>(null);
  /** A turn just failed: the presence shivers and the tab turns red briefly. */
  const [failing, setFailing] = useState(false);
  const streamRef = useRef<SessionStream | null>(null);
  /** The newest event the presence has already reacted to, so a reload or a
      session switch does not replay old moments. */
  const noticed = useRef(0);
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
    void load();
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
        if (typeof d?.active?.connected === "boolean") setModelReady(d.active.connected);
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
    noticed.current = 0;
    setLiveFrame(null);
    setLiveFields([]);
    setBrowser(null);
    const stream = new SessionStream(sessionId, {
      onEvents: (fresh) => {
        // A batch of nothing but repeats: a new array would re-derive the
        // whole thread for no change.
        if (fresh.length === 0) return;
        setEvents((prev) => {
          const next = [...prev, ...fresh];
          next.sort((a, b) => a.seq - b.seq);
          return next;
        });
      },
      onStatus: setStatus,
      onFrame: setLiveFrame,
      onBrowser: (state) => {
        setLiveFields(state?.fields);
        setBrowser(state);
      },
    });
    streamRef.current = stream;
    stream.connect();
    /* An installed app is mostly resumed, not opened: from the home screen,
       the app switcher, a locked phone. Each of those can leave the socket
       dead or a reconnect parked behind a long backoff, so every way of
       coming back checks it at once instead of waiting it out. */
    const wake = () => {
      if (document.visibilityState === "visible") stream.wake();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("focus", wake);
    return () => {
      document.removeEventListener("visibilitychange", wake);
      window.removeEventListener("online", wake);
      window.removeEventListener("pageshow", wake);
      window.removeEventListener("focus", wake);
      stream.close();
      streamRef.current = null;
    };
  }, [sessionId]);

  // Coming back to the chat from Settings is when a model may have been
  // connected (or disconnected), so ask again then.
  useEffect(() => {
    if (page !== "chat") return;
    let alive = true;
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (alive && typeof d?.active?.connected === "boolean") setModelReady(d.active.connected);
      })
      .catch(() => undefined);
    return () => { alive = false; };
  }, [page]);

  const view = useMemo(() => derive(events), [events]);
  const doing = useMemo(() => activity(events), [events]);

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
    if (spoken === undefined) {
      setDraft("");
      // The message is handed over: a spark from Send to the agent's mark.
      flySpark(visible(".composer-send"), visible(".rail-slot .presence", ".top-presence"));
    }
    // Unlock audio inside this tap, so anything the reply says aloud can play
    // on a phone that only allows sound a gesture started.
    if (!speaking) prime();
    const res = await fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text }),
    }).catch(() => null);
    // Now that the box stays open while the connection comes back, a send
    // can fail: put what was typed back rather than losing it.
    if (!res?.ok) {
      if (spoken === undefined) setDraft((now) => now || text);
      setNotice("Could not reach the server; your message was not sent.");
    }
  }, [draft, sessionId, speaking, prime]);

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
    return id as string;
  }, []);

  const pickSession = useCallback((id: string) => {
    history.replaceState(null, "", `?session=${id}`);
    setSessionId(id);
    setSessionsOpen(false);
  }, []);

  const live = status.state === "live";
  /* Only a session that can never take a turn again is read-only. A socket
     that is reconnecting -- a phone waking up, a network blip, the server
     restarting -- used to count too, and that disabled the box (and threw
     away its focus) mid-sentence, at random as far as anyone typing could
     tell. Messages go over a plain request anyway, not the socket. */
  const readOnly = status.state === "recorded" || status.state === "closed";

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

  // What the agent says with its speak tool plays as it arrives, live mode or
  // not: it was asked to say something, so it is heard, not handed over as a
  // file. Only fresh events -- opening an old session must not replay every
  // sentence it ever spoke.
  const said = useRef(new Set<number>());
  useEffect(() => { said.current.clear(); }, [sessionId]);
  useEffect(() => {
    if (!canSpeak) return;
    const now = Date.now() / 1000;
    for (const e of events) {
      if (e.kind !== Kind.MediaSpeech || said.current.has(e.seq)) continue;
      said.current.add(e.seq);
      if (now - e.ts > SPEAK_FRESH_S) continue;
      const prose = speakable(String(e.payload?.text ?? ""));
      if (prose) say(prose);
    }
  }, [events, canSpeak, say]);

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

  // --------------------------------------------------------- slash commands --
  /** Where the highlight is in the command menu, and whether Escape put the
      menu away for this draft. */
  const [slashAt, setSlashAt] = useState(0);
  const [slashDismissed, setSlashDismissed] = useState(false);
  const slashOffered = useMemo(
    () => (readOnly ? [] : suggestCommands(draft, live && running)),
    [draft, live, running, readOnly],
  );
  const slashOpen = slashOffered.length > 0 && !slashDismissed;
  const slashActive = Math.min(slashAt, Math.max(slashOffered.length - 1, 0));

  const runCommand = useCallback((command: Command, arg: string) => {
    // Waiting on its argument: leave it in the box to be finished.
    if (command.arg && !arg) {
      setDraft(`/${command.name} `);
      composerRef.current?.focus();
      return;
    }
    setDraft("");
    switch (command.id) {
      case "stop":
        void stopTurn();
        break;
      case "continue":
        void send("Continue from where you left off.");
        break;
      case "retry": {
        const last = [...view.transcript].reverse().find((t) => t.role === "user");
        if (last?.text) void send(last.text);
        else setNotice("Nothing to send again yet.");
        break;
      }
      case "remember":
        void send(`Remember this for the future: ${arg}`);
        break;
      case "new":
        void newSession();
        break;
      case "close":
        void closeBrowser();
        break;
      case "live":
        if (voiceReady && live) toggleLive();
        else setVoiceHelp(true);
        break;
      case "sessions":
      case "mind":
      case "cron":
      case "config":
      case "system":
        navigate(command.id);
        break;
    }
  }, [stopTurn, send, view.transcript, newSession, closeBrowser, voiceReady, live, toggleLive, navigate]);

  /** Enter or the send button: a command if the box holds one, otherwise
      the message as typed. */
  const submit = useCallback(() => {
    if (slashOpen) {
      runCommand(slashOffered[slashActive], "");
      return;
    }
    const hit = resolveCommand(draft);
    if (hit) {
      runCommand(hit.command, hit.arg);
      return;
    }
    if (modelReady === false) {
      setNotice("No model is connected yet. Add one in Settings (/settings) first.");
      return;
    }
    void send();
  }, [slashOpen, slashOffered, slashActive, draft, runCommand, send, modelReady]);

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
    : failing
      ? "error"
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

  // ------------------------------------------------------------ presence --
  /* The agent as one living thing: its mark in the sidebar (and the header,
     on a phone) carries its mood, leans in while you type, blooms when you
     come back, and shivers when a turn fails. Every one of these is driven
     by something that actually happened -- nothing here is performed. */
  const [attention, setAttention] = useState(0);
  const [welcome, setWelcome] = useState(0);
  const [learned, setLearned] = useState(0);
  const [bloom, setBloom] = useState(0);
  const mood: MarkState = pending > 0
    ? "waiting"
    : failing
      ? "error"
      : live && running
        ? "working"
        : liveOn ? "live" : "rest";

  // Moments in the log, as they arrive: a failure, something learned. Only
  // fresh events count, so opening an old session is not a replay.
  useEffect(() => {
    const now = Date.now() / 1000;
    let newest = noticed.current;
    const timers: number[] = [];
    for (const e of events) {
      if (e.seq <= noticed.current) continue;
      newest = Math.max(newest, e.seq);
      if (now - e.ts > 10) continue;
      if (e.kind === Kind.Error) {
        setFailing(true);
        timers.push(window.setTimeout(() => setFailing(false), 1600));
      }
      if (e.kind === Kind.MemoryLearned) {
        const count = (Array.isArray(e.payload.items) ? e.payload.items.length : 0);
        if (!count) continue;
        // After the card has painted, so the spark leaves from it.
        timers.push(window.setTimeout(() => {
          flySpark(
            visible(".learned"),
            visible(".rail-slot [data-page=\"mind\"]", ".menu-btn"),
            () => { setLearned((n) => n + count); setBloom((b) => b + 1); },
            "glow",
          );
        }, 350));
      }
    }
    noticed.current = newest;
    // Deliberately not cleared on the next run: a later batch of events must
    // not cut short a shiver or a spark that is already under way.
    void timers;
  }, [events]);

  useEffect(() => { if (page === "mind") setLearned(0); }, [page]);

  // Leaning in while you type: brighter the faster you go, settling back a
  // moment after you stop.
  const strokes = useRef<number[]>([]);
  const settleTimer = useRef<number | null>(null);
  const noticeTyping = useCallback(() => {
    const t = performance.now();
    strokes.current = strokes.current.filter((k) => t - k < 1500);
    strokes.current.push(t);
    setAttention(Math.min(1, 0.25 + strokes.current.length / 12));
    if (settleTimer.current) window.clearTimeout(settleTimer.current);
    settleTimer.current = window.setTimeout(() => setAttention(0), 1100);
  }, []);

  // Coming back after a while is greeted with a bloom, and nothing ambient
  // keeps animating in a tab nobody is looking at.
  useEffect(() => {
    let awayAt = 0;
    const onVisibility = () => {
      document.documentElement.classList.toggle("is-away", document.hidden);
      if (document.hidden) { awayAt = Date.now(); return; }
      if (awayAt && Date.now() - awayAt > 60_000) setWelcome((n) => n + 1);
      awayAt = 0;
    };
    document.addEventListener("visibilitychange", onVisibility);
    return () => document.removeEventListener("visibilitychange", onVisibility);
  }, []);

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
          if (!live) break;
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
  }, [toggleLive, live, voiceReady, voiceBlocked, navigate, page]);

  const sessionCost = sessions.find((s) => s.id === sessionId)?.cost ?? 0;

  const currentName =
    sessions.find((s) => s.id === sessionId)?.title?.trim() ||
    view.title ||
    "Untitled session";

  const openKnowledge = useCallback(() => navigate("mind"), [navigate]);
  const openModelSettings = useCallback(() => {
    setConfigJump({ tab: "general" });
    navigate("config");
  }, [navigate]);

  /** A starting task goes into the box to be read and edited, not straight
      out: it is an example, and the person may want it slightly different. */
  const startFrom = useCallback((text: string) => {
    setDraft(text);
    composerRef.current?.focus();
  }, []);

  const placeholder = modelReady === false ? (
    <SetupCard
      onConnected={() => { setModelReady(true); composerRef.current?.focus(); }}
      onOpenSettings={openModelSettings}
    />
  ) : modelReady ? (
    <Welcome
      sessions={sessions}
      current={sessionId}
      // A closure: openSession is declared further down.
      onOpenSession={(id) => openSession(id)}
      onOpenMind={() => navigate("mind")}
      onOpenSchedules={() => navigate("cron")}
      onPick={startFrom}
    />
  ) : undefined;

  const refreshSessions = useCallback(() => {
    fetch("/api/sessions").then((r) => r.json()).then(setSessions).catch(() => undefined);
  }, []);

  const openSession = useCallback((id: string) => {
    pickSession(id);
    navigate("chat");
  }, [navigate, pickSession]);

  // ------------------------------------------------------ undoable delete --
  /** A session deleted a moment ago, still recoverable. Nothing is removed on
      the server until the Undo window passes -- a two-tap confirm guarded the
      same mistake, but slower, and still with no way back. */
  const [trash, setTrash] = useState<{
    id: string; title: string; wasOpen: boolean;
    /** The empty session opened because the last one was deleted. */
    stand?: Promise<string>;
  } | null>(null);
  const trashTimer = useRef<number | null>(null);
  const trashRef = useRef(trash);
  trashRef.current = trash;

  const commitDelete = useCallback(async (id: string) => {
    const res = await fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => null);
    if (!res?.ok) {
      const body = await res?.json().catch(() => null);
      setNotice(body?.error ?? "Could not delete that session.");
    }
    refreshSessions();
  }, [refreshSessions]);

  const deleteSession = useCallback((row: { id: string; title?: string }) => {
    // One Undo at a time: a second delete settles the first.
    const earlier = trashRef.current;
    if (earlier) {
      if (trashTimer.current) window.clearTimeout(trashTimer.current);
      void commitDelete(earlier.id);
    }
    const wasOpen = row.id === sessionId;
    let stand: Promise<string> | undefined;
    if (wasOpen) {
      const next = sessions.find((s) => s.id !== row.id && s.id !== earlier?.id);
      if (next) pickSession(next.id);
      else stand = newSession();
    }
    setTrash({ id: row.id, title: row.title?.trim() || "Untitled session", wasOpen, stand });
    trashTimer.current = window.setTimeout(() => {
      trashTimer.current = null;
      setTrash(null);
      void commitDelete(row.id);
    }, 6000);
  }, [commitDelete, sessionId, sessions, pickSession, newSession]);

  const undoDelete = useCallback(() => {
    const held = trashRef.current;
    if (!held) return;
    if (trashTimer.current) window.clearTimeout(trashTimer.current);
    trashTimer.current = null;
    setTrash(null);
    if (held.wasOpen) pickSession(held.id);
    // The stand-in opened in its place goes again, if nothing was said in it.
    void held.stand?.then(async (id) => {
      const rows: SessionRow[] = await fetch("/api/sessions").then((r) => r.json()).catch(() => []);
      const row = rows.find((r) => r.id === id);
      if (row && !row.turns) await fetch(`/api/sessions/${id}`, { method: "DELETE" }).catch(() => undefined);
      refreshSessions();
    });
  }, [pickSession, refreshSessions]);

  // Leaving the page settles a pending delete rather than forgetting it.
  useEffect(() => {
    const flush = () => {
      const held = trashRef.current;
      if (held) void fetch(`/api/sessions/${held.id}`, { method: "DELETE", keepalive: true });
    };
    window.addEventListener("pagehide", flush);
    return () => window.removeEventListener("pagehide", flush);
  }, []);

  const listed = useMemo(
    () => (trash ? sessions.filter((s) => s.id !== trash.id) : sessions),
    [sessions, trash],
  );

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
            mood={mood}
            attention={attention}
            pulse={welcome}
            learned={learned}
            bloom={bloom}
            alert={pending > 0}
            onNew={() => { void newSession(); navigate("chat"); }}
            drawer={kind === "drawer"}
            onClose={() => setDrawerOpen(false)}
          />
        </div>
      ))}

      <div className="shell">
        {/* Above everything, including the header: an app running code that is
            two releases old is not a detail to mention further down. */}
        <UpdateNotice />
        <Notices onOpenSession={openSession} />

        <header className="top">
          <button
            className="btn icon ghost menu-btn"
            onClick={() => setDrawerOpen(true)}
            aria-label="Open the menu"
            title="Menu"
          >
            <IconMenu size={18} />
          </button>

          {/* The presence, where the sidebar is folded away. */}
          <span className="top-presence">
            <AutoraMark size={24} state={mood} idle attention={attention} pulse={welcome} />
          </span>

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
          {/* What this session has cost, which is the question; the token
              counts behind it are one hover (or the Usage page) away. */}
          {page === "chat" && view.tokens.in > 0 && (
            <button
              className="badge tokens"
              onClick={() => navigate("analytics")}
              title={`${fmt(view.tokens.in)} tokens in · ${fmt(view.tokens.out)} out · ${fmt(view.tokens.cached)} cached — open Usage`}
            >
              {sessionCost > 0 ? `${money(sessionCost)} this session` : `${fmt(view.tokens.in + view.tokens.out)} tokens`}
            </button>
          )}
        </header>

        {page !== "chat" && (
          <div className="page-host">
            {page === "config" && (
              <Settings
                key={`config-${configJump.tab}`}
                section="config"
                embedded
                initialTab={configJump.tab}
                appearance={appearance}
                onAppearance={changeAppearance}
              />
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
              <SessionsPage
                current={sessionId}
                onOpen={openSession}
                onChanged={refreshSessions}
                onDelete={deleteSession}
                hidden={trash?.id ?? null}
              />
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
          {/* The room's light: cool at rest, warmer while it works, amber
              while it waits on you. Barely there, and still when away. */}
          <div className={`mood-light is-${mood}`} aria-hidden="true" />
          <Thread
            buckets={view.buckets}
            // Stopped on a question is not working; the card says what it is.
            busy={view.busy && !view.asking}
            doing={doing}
            sessionId={sessionId ?? ""}
            liveBrowserSeq={view.liveBrowserSeq}
            live={live}
            onPermissionDecide={handlePermissionDecide}
            onRunAutonomous={handleRunAutonomous}
            driving={driving}
            browserHandedOver={browserHandedOver}
            onStop={() => void stopTurn()}
            onOpenMind={openKnowledge}
            onOpenSettings={openModelSettings}
            placeholder={placeholder}
          />

          <Approvals
            approvals={view.approvals}
            readOnly={!live}
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
                  {/* One line to act on; the explanation is folded under it,
                      since on a phone it filled most of the screen. */}
                  {secureUrl ? (
                    <>
                      <b>Voice works on the secure page.</b> Browsers only open a
                      microphone over https; this session is running there too.
                      <details className="set-more">
                        <summary>About the certificate warning</summary>
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
                      </details>
                    </>
                  ) : (
                    <>
                      <b>Voice needs a secure (https) page.</b> Browsers only open a
                      microphone over https, and this page is plain http.
                      <details className="set-more">
                        <summary>How to fix it</summary>
                        <em className="voice-help-aside">
                          The fix is in front of the server, not in the browser. On a
                          tailnet, <code>tailscale serve --bg --https=8443 {location.port || 80}</code>{" "}
                          on the machine running Autora gives this page a real
                          certificate and a secure address on port 8443 (not 443,
                          which an Umbrel needs for itself); any reverse proxy with a
                          certificate does the same. See the README.
                        </em>
                      </details>
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
                onStop={() => void stopTurn()}
                agentSpeaking={speaking}
                agentWorking={running}
                agentDoing={doing}
                disabled={!live}
              />
            ) : (
              <>
                <div className={`composer-box ${draft.trim() ? "has-text" : ""}`}>
                  {slashOpen && (
                    <SlashMenu
                      commands={slashOffered}
                      active={slashActive}
                      onHover={setSlashAt}
                      onPick={(c) => runCommand(c, "")}
                    />
                  )}
                  <textarea
                    ref={composerRef}
                    value={draft}
                    rows={1}
                    aria-label="Task"
                    placeholder={readOnly
                      ? "This session is a recording."
                      : modelReady === false
                        ? "Connect a model to start…"
                        : "What should I do?"}
                    disabled={readOnly}
                    onChange={(e) => {
                      setDraft(e.target.value);
                      setSlashDismissed(false);
                      noticeTyping();
                    }}
                    onBlur={() => setAttention(0)}
                    onKeyDown={(e) => {
                      if (slashOpen) {
                        const n = slashOffered.length;
                        if (e.key === "ArrowDown" || e.key === "ArrowUp") {
                          e.preventDefault();
                          setSlashAt((slashActive + (e.key === "ArrowDown" ? 1 : n - 1)) % n);
                          return;
                        }
                        if (e.key === "Tab") {
                          e.preventDefault();
                          const picked = slashOffered[slashActive];
                          setDraft(`/${picked.name}${picked.arg ? " " : ""}`);
                          return;
                        }
                        if (e.key === "Escape") {
                          e.preventDefault();
                          setSlashDismissed(true);
                          return;
                        }
                      }
                      if (e.key === "Enter" && !e.shiftKey) {
                        e.preventDefault();
                        submit();
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
                      {/* In the row with Dictate, at every width. It used to
                          float over the thread above Send on phones, where
                          it covered the last line of whatever was there. */}
                      <button
                        className="btn ghost labeled composer-live"
                        onClick={voiceReady ? toggleLive : () => setVoiceHelp(true)}
                        disabled={!live}
                        title={voiceReady ? "Talk with Autora out loud (v)" : "Live voice requires https"}
                        aria-label="Live voice chat"
                        aria-pressed={liveOn}
                      >
                        <AutoraMark state={liveState} size={18} />
                        <span className="btn-label">Talk</span>
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
                        // Without a model a message can only fail; a slash
                        // command (/settings) still goes.
                        disabled={readOnly || !draft.trim()
                          || (modelReady === false && !draft.trim().startsWith("/"))}
                        onClick={submit}
                        title={running ? "Interrupt & send" : "Send"}
                        aria-label={running ? "Interrupt & send" : "Send"}
                      >
                        <IconArrowUp size={17} />
                      </button>
                    </div>
                  </div>
                </div>
                <p className="composer-hint">
                  <kbd>Enter</kbd> to send · <kbd>Shift</kbd> + <kbd>Enter</kbd> for a new line · <kbd>/</kbd> for commands
                </p>
              </>
            )}
          </div>
        </main>
        </div>

      </div>

      {sessionsOpen && (
        <Sessions
          sessions={listed}
          current={sessionId}
          onPick={pickSession}
          onNew={newSession}
          onClose={() => setSessionsOpen(false)}
          onChanged={refreshSessions}
          onDelete={deleteSession}
          onOpenPage={() => navigate("sessions")}
        />
      )}

      {trash && (
        <div className="toast" role="status">
          <span>Deleted “{trash.title}”</span>
          <button className="toast-act" onClick={undoDelete}>Undo</button>
        </div>
      )}
    </div>
  );
}

const fmt = (n: number) => (n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n));
const money = (n: number) => `$${n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

/** Just the site, for a badge with room for about fifteen characters. */
function hostOf(url: string | null): string {
  if (!url) return "a page";
  try {
    return new URL(url).host.replace(/^www\./, "");
  } catch {
    return url.slice(0, 24);
  }
}
