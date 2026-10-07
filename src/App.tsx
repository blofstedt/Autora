import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react";
import { SessionStream, mergeEvents, type StreamStatus } from "./lib/stream";
import { derive, isRunning, type Cell, type Derived } from "./lib/derive";
import { share } from "./lib/share";
import { chime, paintChrome, type Chrome } from "./lib/chrome";
import { Kind, type AutoraEvent, type BrowserState } from "./lib/types";
import { setLiveFields, setLiveFrame, setLivePaneOwns, setLiveTabs } from "./lib/liveFrame";
import { resetPreview, setPreviewFrame, setPreviewState, usePreviewState, type PreviewState } from "./lib/preview";
import { AppPreview } from "./components/AppPreview";
import { ScreencastCell } from "./components/ScreencastCell";
import { OfficeWindow } from "./components/OfficeWindow";
import { SpectraWindow } from "./components/SpectraWindow";
import { emitSpectraEvent } from "./lib/spectra";
import { ResizeHandle } from "./components/ResizeHandle";
import { CHAT, RAIL, setChatWidth, setRailCollapsed, setRailWidth, usePanes, wideScreen } from "./lib/panes";
import { clearOfficePick, getOfficePick, pickLabel, pickSentence, useOfficePick } from "./lib/officeSelection";
import { emitOfficePush, resetOffice, setOfficeState, useOfficeState, type OfficeKind } from "./lib/officedesk";
import { resetDesk, setDeskState, useDeskState } from "./lib/pdfdesk";
import { resetCollab, setCollabState } from "./lib/collab";
import { cellKey, dockedPlan, usePhone } from "./lib/stage";
import { Thread } from "./components/Thread";
import { Dock } from "./components/Dock";
import { Rail, pageLabel, PAGES, type PageId } from "./components/Rail";
import { isSystemTab, type SystemTab } from "./lib/systemTabs";
import { TodoDock } from "./components/TodoDock";

/* The pages behind the rail are loaded when they are opened, not with the app.
   Together they are a third of the bundle, and most sessions never open them:
   the person arrives to talk, and the chat thread is what must appear at once.
   Each is a separate chunk fetched on first visit, then kept. */
const SessionsPage = lazyPage(() => import("./components/pages/SessionsPage"), "SessionsPage");
const SystemPage = lazyPage(() => import("./components/pages/SystemPage"), "SystemPage");
const McpPage = lazyPage(() => import("./components/pages/McpPage"), "McpPage");
const ArtifactsPage = lazyPage(() => import("./components/pages/ArtifactsPage"), "ArtifactsPage");
const NotebooksPage = lazyPage(() => import("./components/pages/NotebooksPage"), "NotebooksPage");
const ToolsPage = lazyPage(() => import("./components/pages/ToolsPage"), "ToolsPage");
const MindPage = lazyPage(() => import("./components/pages/MindPage"), "MindPage");
const Settings = lazyPage(() => import("./components/Settings"), "Settings");
const Schedule = lazyPage(() => import("./components/Schedule"), "Schedule");
const Triggers = lazyPage(() => import("./components/Triggers"), "Triggers");
// Talk mode (and the 1,900-line speech code behind it) loads when it is turned on.
const LiveChat = lazyPage(() => import("./components/LiveChat"), "LiveChat");
import { LibraryPicker, type LibraryTab } from "./components/LibraryPicker";
import { ToolsSheet } from "./components/ToolsSheet";
import { OPEN_NOTEBOOK, type NotebookRef } from "./lib/notebooks";
import { MONEY_CHANGED } from "./lib/spend";
import type { Bucket } from "./lib/memory";
import {
  applyAppearance, cachedAppearance, iconScale, saneAppearance, saveAppearance,
  type Appearance,
} from "./lib/theme";
import { Sessions, type SessionRow } from "./components/Sessions";
import { Approvals } from "./components/Approvals";
import type { ConfigTab } from "./components/Settings";
import { DictateButton } from "./components/DictateButton";
import { AttachButton, CameraButton } from "./components/AttachButton";
import { SpendBar, type Usage } from "./components/SpendBar";
import { SlashMenu } from "./components/SlashMenu";
import { resolve as resolveCommand, suggest as suggestCommands, type Command } from "./lib/commands";
import { useRelay } from "./components/RelaySetup";
import { UpdateNotice } from "./components/UpdateNotice";
import { SetupCard, Welcome } from "./components/SetupCard";
import { flySpark, visible } from "./lib/presence";
import { useBackOut } from "./lib/back";
import { Notices } from "./components/Notices";
import { InstallApp } from "./components/InstallApp";
import { PermissionsPill } from "./components/PermissionsPill";
import { ModeSelect } from "./components/ModeSelect";
import { DEFAULT_PERMISSIONS, DEFAULT_WORK_MODE, type Permissions, type WorkMode } from "./lib/modes";
import { AutoraMark, type MarkState } from "./components/AutoraMark";
import { readActivity } from "./lib/activity";
import { adoptDeviceTimezone } from "./lib/timezone";
import {
  dictationSupported, recognitionAvailable, sameReply, secureOrigin, speakable,
  splitSpeakable, useSpeech,
} from "./lib/voice";
import {
  IconArrow, IconArrowUp, IconChevron, IconFile, IconMask, IconMenu, IconNotebook, IconStop,
  IconWrench,
  IconX,
} from "./components/Icons";
import {
  MAX_UPLOAD_BYTES, isPicture, sizeLabel, uploadAttachment, type Attachment,
} from "./lib/attachments";
import { SureHost } from "./components/SureHost";

/* The pages behind the rail are loaded when they are opened rather than with
   the app: together they are a third of the bundle, and most sessions never
   open them. Each becomes its own chunk, fetched on first visit and kept
   after. Nothing is shown while it arrives -- the chunk is small and local,
   and a spinner for a fifth of a second reads as a flicker rather than as
   waiting -- so the fallback is nothing at all. */
function lazyPage<T extends React.ComponentType<any>>(
  load: () => Promise<{ [k: string]: any }>,
  name: string,
): T {
  return lazy(async () => {
    const mod = await load();
    return { default: (mod as any)[name] as T };
  }) as unknown as T;
}

/** How often to re-read the session list, so sessions started elsewhere (or
    from another tab) show up without a reload. */
const SESSION_POLL_MS = 10_000;
/** How old a speak event may be and still be played: long enough for a slow
    connection to deliver it, short enough that a reload is not a recital. */
const SPEAK_FRESH_S = 30;
/** The least time between two updates of the thread while events stream in:
    about fifteen a second, which reads as smooth text and leaves the page
    room to breathe on a long conversation. */
const EVENT_BATCH_MS = 66;
/** What the composer's library offers. */
const LIBRARY_TABS: LibraryTab[] = ["notebooks", "files"];

/** The windows that can sit beside the chat on a wide screen, one at a time. */
type SideWindow = "app" | "pdf" | "pages" | "sheets" | "slides" | "browser";

/**
 * The Office windows that can be open beside the chat, one per app, in the order their tabs sit in. Each has its
 * own document and its own tab, and they are all open at once: switching to one used to put the other away.
 */
const OFFICE_PANES: Array<{ pane: SideWindow; kind: OfficeKind; label: string }> = [
  { pane: "pages", kind: "docx", label: "Pages" },
  { pane: "sheets", kind: "xlsx", label: "Sheets" },
  { pane: "slides", kind: "pptx", label: "Slides" },
];

export function App() {
  /* Back, on a phone, is the system gesture, and in an installed app with
     nothing behind it, back means leaving. One entry of our own is pushed on
     load so the first back is ours to answer: it closes what is open over the
     chat, and otherwise steps out to the Umbrel dashboard rather than out of
     the app. See src/lib/back.ts. */
  useBackOut();

  const [sessionId, setSessionId] = useState<string | null>(
    () => new URLSearchParams(location.search).get("session"),
  );
  const [sessions, setSessions] = useState<SessionRow[]>([]);
  /* The chat that leaves nothing behind, when one is open. Its id is what
     says so: the server holds the chat in memory and refuses to write it, so
     "incognito" is a fact about the open session rather than a mode. */
  const [incognitoId, setIncognitoId] = useState<string | null>(null);
  /** The same, for the poll and the unload handler, which are set up once. */
  const incognitoRef = useRef<string | null>(null);

  /** This month's spend, for the bar over the composer. Read here, never
      written: the ledger is the turns' own, one row each as they finish. */
  const [usage, setUsage] = useState<Usage | null>(null);
  const [events, setEvents] = useState<AutoraEvent[]>([]);
  const [status, setStatus] = useState<StreamStatus>({ state: "connecting" });
  /** The newest frame off the session's browser, and whether there is one at
      all. Held here rather than in the card because the socket is here; it is
      one frame at a time and never accumulates, so re-rendering on it costs a
      picture swap and nothing else. */
  const [browser, setBrowser] = useState<BrowserState | null>(null);
  const [draft, setDraft] = useState("");
  /* Files on their way out with the next message. Uploaded the moment they
     were picked or taken, so what is held here is already an artifact id and
     Send does not have to wait for a photograph to travel. */
  const [attached, setAttached] = useState<Attachment[]>([]);
  /** Notebooks going with the next message, and whether the picker is open. */
  const [attachedBooks, setAttachedBooks] = useState<NotebookRef[]>([]);
  const [libraryOpen, setLibraryOpen] = useState(false);
  /** The toolbox: the apps the person opens themselves, with a new blank file. */
  const [toolsOpen, setToolsOpen] = useState(false);
  /** The notebook open on the Notebooks page. */
  const [notebookOpen, setNotebookOpen] = useState<string | null>(
    () => new URLSearchParams(location.search).get("notebook"),
  );
  const [attaching, setAttaching] = useState(0);
  const [liveOn, setLiveOn] = useState(false);
  const [userSpeaking] = useState(false);
  /** Which page of the app is showing. Chat is the conversation; the rest
      are the sidebar's pages. Kept in the address so a reload stays put. */
  /** Where a page puts its own button: the header's right-hand corner. An
      element handed to the page rather than a prop plumbed through it, because
      what the button does belongs to the page and where it goes belongs here. */
  const [topSlot, setTopSlot] = useState<HTMLElement | null>(null);
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
  const [mindBucket, setMindBucket] = useState<{ kind: Bucket; id?: string; auto?: boolean }>(
    () => new URLSearchParams(location.search).get("page") === "skills"
      ? { kind: "skill" }
      // Nobody asked for Preferences: the page picks a bucket with something in it.
      : { kind: "preference", auto: true },
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
  /** The strip the message box lives in. The scheduled-task notices sit on
      its top edge, so its geometry is published to CSS and kept current. */
  const composerEl = useRef<HTMLDivElement>(null);
  const speech = useSpeech();
  const { say, flush, cancel: hush, prime, speaking, supported: canSpeak } = speech;
  const relay = useRelay();
  /** How much of each reply has been read out, so streaming text is spoken
      once and in order rather than re-read from the top on every token. */
  const narrated = useRef(new Map<number, number>());
  /** Replies at or before this sequence predate live chat and are not read
      aloud -- turning the microphone on should not recite the backlog. */
  const narrateAfter = useRef(-1);
  /** The reply the voice is currently in the middle of, so a turn that is
      still arriving is not closed off early. */
  const narrating = useRef(-1);

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
            // A session that is not in the list because it is never written
            // down -- incognito -- is still the one that is open.
            current && (rows.some((r: SessionRow) => r.id === current) || current === incognitoRef.current)
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

  // The server's clock is the container's, which is UTC unless someone said
  // otherwise. The first device to open the app says what the person's is; once
  // a zone is chosen, this never touches it.
  useEffect(() => {
    void adoptDeviceTimezone();
  }, []);

  // The theme saved on the server wins over this browser's cached copy, so a
  // choice made on the desktop shows up on the phone.
  useEffect(() => {
    fetch("/api/settings")
      .then((r) => r.json())
      .then((d) => {
        if (typeof d?.active?.connected === "boolean") setModelReady(d.active.connected);
        if (!d?.appearance) return;
        // Everything is validated on the way in: the server may be a release
        // behind, and an older payload has no sizes or corner widgets in it.
        const next = saneAppearance(d.appearance);
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
        // Only a listener that is actually up: a port that is configured but
        // failed to start would be a link to an error page.
        setSecurePort(typeof d?.secure_port === "number" && d?.secure_listening ? d.secure_port : null);
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
    setLiveTabs([]);
    setBrowser(null);
    /* Events are added to the thread in batches, at most every
       EVENT_BATCH_MS and on a frame, not one at a time. A streamed reply is
       dozens of events a second and each one used to re-render the thread on
       its own, which on a long conversation was more work than a frame has
       room for. The first event after a quiet spell still shows on the very
       next frame. A hidden page paints no frames, so there they go straight
       in -- a reply read aloud with the screen off must not wait for one. */
    let queued: AutoraEvent[] = [];
    let frame: number | null = null;
    let timer: number | null = null;
    let lastFlush = 0;
    const flush = () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
      frame = null;
      timer = null;
      if (queued.length === 0) return;
      lastFlush = performance.now();
      const batch = queued;
      queued = [];
      setEvents((prev) => mergeEvents(prev, batch));
    };
    const schedule = () => {
      if (frame !== null || timer !== null) return;
      const wait = EVENT_BATCH_MS - (performance.now() - lastFlush);
      if (wait <= 0) frame = requestAnimationFrame(flush);
      else timer = window.setTimeout(() => {
        timer = null;
        frame = requestAnimationFrame(flush);
      }, wait);
    };
    resetPreview();
    resetDesk();
    resetOffice();
    resetCollab();
    const stream = new SessionStream(sessionId, {
      onEvents: (fresh) => {
        // A batch of nothing but repeats: a new array would re-derive the
        // whole thread for no change.
        if (fresh.length === 0) return;
        queued.push(...fresh);
        if (document.visibilityState === "hidden") flush();
        else schedule();
      },
      onStatus: setStatus,
      onFrame: (frame) => {
        // The app window's video is its own feed: the browser card's would
        // otherwise show the app.
        if (frame.source === "preview") {
          setPreviewFrame({ data: frame.data, mime: frame.mime, w: frame.w ?? 1280, h: frame.h ?? 800, ts: frame.ts });
        } else {
          setLiveFrame(frame);
        }
      },
      onPreview: (state) => setPreviewState(state as PreviewState),
      onPdfDesk: setDeskState,
      onSpectra: emitSpectraEvent,
      onOfficeDesk: setOfficeState,
      onOfficePush: emitOfficePush,
      onPresence: setCollabState,
      onBrowser: (state) => {
        setLiveFields(state?.fields);
        setLiveTabs(state?.tabs);
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
      stream.sendVisibility();
      if (document.visibilityState === "visible") stream.wake();
      // Going away with events waiting for a frame that will not come.
      else flush();
    };
    document.addEventListener("visibilitychange", wake);
    window.addEventListener("online", wake);
    window.addEventListener("pageshow", wake);
    window.addEventListener("focus", wake);
    return () => {
      if (frame !== null) cancelAnimationFrame(frame);
      if (timer !== null) window.clearTimeout(timer);
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

  /* The previous fold, so every card that did not change keeps its identity
     and the thread redraws only the one that did (see lib/share.ts). */
  const lastView = useRef<Derived | null>(null);
  const view = useMemo(() => {
    const next = share(lastView.current, derive(events));
    lastView.current = next;
    return next;
  }, [events]);
  /* What it is on, in words, and with it which of the mark's two busy
     states says that best: a step in flight is the mark building itself,
     everything else is it thinking. */
  const reading = useMemo(() => readActivity(events), [events]);
  const doing = reading.text;
  /* How long this turn has been going, ticking on its own so the line counts
     up without needing a new event to arrive. Nothing to show once the turn
     is over. */
  const [elapsed, setElapsed] = useState(0);
  useEffect(() => {
    if (!reading.since) { setElapsed(0); return; }
    const tick = () => setElapsed(Date.now() - reading.since!);
    tick();
    const id = window.setInterval(tick, 1000);
    return () => window.clearInterval(id);
  }, [reading.since]);

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

  // The notices rise from behind the message box, so they need the box's own
  // edges: --composer-h is how far its top is above the bottom of the window,
  // --composer-l and -w its left edge and width (which is how a notice is
  // centred on the box rather than on the window), --composer-r how far its
  // right edge is from the right. Measured from the element rather than
  // assumed, because the box grows with the textarea, carries a spend bar
  // when there is one, and gives way to the live bar.
  useEffect(() => {
    const el = composerEl.current;
    if (!el) return;
    const measure = () => {
      if (!el.offsetParent) return;                 // another page is showing
      const rect = el.getBoundingClientRect();
      if (rect.height === 0) return;
      const pad = parseFloat(getComputedStyle(el).paddingRight) || 0;
      const root = document.documentElement.style;
      root.setProperty("--composer-h", `${Math.round(window.innerHeight - rect.top)}px`);
      root.setProperty("--composer-l", `${Math.round(rect.left)}px`);
      root.setProperty("--composer-w", `${Math.round(rect.width)}px`);
      root.setProperty("--composer-r", `${Math.round(window.innerWidth - rect.right + pad)}px`);
    };
    measure();
    const ro = typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure);
    ro?.observe(el);
    window.addEventListener("resize", measure);
    return () => { ro?.disconnect(); window.removeEventListener("resize", measure); };
  }, []);

  const send = useCallback(async (spoken?: string, interrupt?: boolean) => {
    const typed = (spoken ?? draft).trim();
    /* What they pointed at in a document's pages goes in front of what they say about it. */
    const pointed = getOfficePick();
    const text = pointed && pointed.session === sessionId && typed ? `${pickSentence(pointed)}\n${typed}` : typed;
    /* A dictated turn carries nothing but words, and a message may be nothing
       but files: "look at this" with the photo is a whole request. */
    const files = spoken === undefined ? attached : [];
    const books = spoken === undefined ? attachedBooks : [];
    if ((!text && files.length === 0 && books.length === 0) || !sessionId) return;
    // Dictated turns never touched the box, so there is nothing to clear and
    // clearing anyway would eat something half-typed.
    if (pointed && typed) clearOfficePick();
    if (spoken === undefined) {
      setDraft("");
      setAttached([]);
      setAttachedBooks([]);
      // The message is handed over: a spark from Send to the agent's mark.
      flySpark(visible(".composer-send"), visible(".rail-slot .presence", ".top-presence"));
    }
    // Unlock audio inside this tap, so anything the reply says aloud can play
    // on a phone that only allows sound a gesture started.
    if (!speaking) prime();
    const res = await fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        text,
        ...(files.length > 0 ? { attachments: files.map((f) => f.id) } : {}),
        ...(books.length > 0 ? { notebooks: books.map((b) => b.id) } : {}),
        /* It was said out loud, and a spoken turn answers without thinking
           first: in live voice the wait is the whole experience. */
        ...(spoken !== undefined ? { spoken: true } : {}),
        /* Sent while the agent works, a message is added to what it is doing;
           only an explicit interrupt stops it first. */
        ...(interrupt ? { mode: "interrupt" } : {}),
      }),
    }).catch(() => null);
    // Now that the box stays open while the connection comes back, a send
    // can fail: put what was typed back rather than losing it.
    if (!res?.ok) {
      if (spoken === undefined) {
        setDraft((now) => now || text);
        // The files are not lost either: the artifacts are still there, so
        // the chips come back and Send can be pressed again.
        setAttached((now) => (now.length > 0 ? now : files));
        setAttachedBooks((now) => (now.length > 0 ? now : books));
      }
      setNotice("Could not reach the server; your message was not sent.");
    }
  }, [draft, attached, attachedBooks, sessionId, speaking, prime]);

  /** Put files into the message: up to the artifacts store now, into a chip
      beside the box while they travel, and into the message as their ids. */
  const addFiles = useCallback(async (files: File[]) => {
    if (files.length === 0) return;
    setNotice(null);
    for (const file of files) {
      if (file.size > MAX_UPLOAD_BYTES) {
        setNotice(`${file.name} is ${sizeLabel(file.size)}; the limit is ${sizeLabel(MAX_UPLOAD_BYTES)}.`);
        continue;
      }
      setAttaching((n) => n + 1);
      try {
        const attachment = await uploadAttachment(file);
        setAttached((list) => [...list, attachment]);
      } catch (err: any) {
        setNotice(err?.message ?? `Could not attach ${file.name}.`);
      } finally {
        setAttaching((n) => n - 1);
      }
    }
  }, []);

  const dropAttachment = useCallback((id: string) => {
    setAttached((list) => list.filter((file) => file.id !== id));
  }, []);

  /** Notebooks and saved files picked in the library go into the next message. */
  const addFromLibrary = useCallback((picked: { notebooks: NotebookRef[]; files: Attachment[] }) => {
    setLibraryOpen(false);
    setAttachedBooks((list) => [...list, ...picked.notebooks.filter((b) => !list.some((x) => x.id === b.id))
      .map((b) => ({ id: b.id, title: b.title }))]);
    setAttached((list) => [...list, ...picked.files.filter((f) => !list.some((x) => x.id === f.id))
      .map((f) => ({ id: f.id, name: f.name, mime: f.mime, size: f.size }))]);
  }, []);

  const closeLibrary = useCallback(() => setLibraryOpen(false), []);

  const notebookToChat = useCallback((ref: NotebookRef) => {
    setAttachedBooks((list) => (list.some((b) => b.id === ref.id) ? list : [...list, ref]));
    navigate("chat");
  }, [navigate]);

  // A notebook chip in the thread opens the notebook.
  useEffect(() => {
    const open = (e: Event) => {
      const id = (e as CustomEvent<string>).detail;
      if (typeof id !== "string") return;
      setNotebookOpen(id);
      navigate("notebooks");
    };
    window.addEventListener(OPEN_NOTEBOOK, open);
    return () => window.removeEventListener(OPEN_NOTEBOOK, open);
  }, [navigate]);

  // The open notebook is in the address too, so a reload stays on it.
  useEffect(() => {
    const url = new URL(location.href);
    if (page === "notebooks" && notebookOpen) url.searchParams.set("notebook", notebookOpen);
    else url.searchParams.delete("notebook");
    if (url.href !== location.href) history.replaceState(null, "", url.toString());
  }, [page, notebookOpen]);

  /** Stop the turn in flight.
   *
   * Both paths, because the websocket alone was not enough: a phone that has
   * been asleep comes back holding a socket that reports itself OPEN and is
   * not, and `send` drops anything it cannot deliver without a word -- so Stop
   * did nothing, said nothing, and left the agent running. The fetch is the
   * one that can fail loudly, and interrupting twice is free: it sets a flag
   * the loop is already watching.
   *
   * What the response says back is deliberately not read. `interrupted` is
   * false whenever the turn had already stopped by the time the request
   * arrived, and the socket interrupt above is usually there first -- so
   * stopping a turn that really was running answered "Nothing was running to
   * stop.", in the one place on the page a person looks for an error. Nothing
   * is lost with it: a stopped turn says so itself, in the thread, which is
   * where the answer to "did that work" belongs. A stop that cannot reach the
   * server at all is still reported here.
   */
  const stopTurn = useCallback(async () => {
    streamRef.current?.interrupt();
    if (!sessionId) return;
    try {
      await fetch(`/api/sessions/${sessionId}/interrupt`, { method: "POST" });
    } catch {
      setNotice("Could not reach the server to stop it.");
    }
  }, [sessionId]);

  /* Ending an incognito chat is one request: there is nothing on disk to
     remove and nothing to come back to, so telling the server to forget it is
     the whole of it. Sent keepalive, because the usual reason to end one is
     the window going. */
  const endIncognito = useCallback(() => {
    const id = incognitoRef.current;
    incognitoRef.current = null;
    setIncognitoId(null);
    if (id) {
      void fetch(`/api/sessions/${id}`, { method: "DELETE", keepalive: true }).catch(() => undefined);
    }
  }, []);

  /** A new chat that is never written down: created like any other, and kept
      differently. Whatever incognito chat was open ends with it. */
  const startIncognito = useCallback(async () => {
    endIncognito();
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ incognito: true }),
    }).catch(() => null);
    const id = res?.ok ? (await res.json().catch(() => null))?.id : null;
    if (typeof id !== "string" || !id) {
      setNotice("Could not open an incognito chat.");
      return;
    }
    /* To the chat first, then the id: a render that had the id but still
       showed another page would count as walking away from it. */
    setSessionsOpen(false);
    navigate("chat");
    incognitoRef.current = id;
    setIncognitoId(id);
    setSessionId(id);
    /* The address keeps no trace of it: a reload opens the chat you were in
       before, rather than asking the server for one that is already gone. */
    const url = new URL(location.href);
    url.searchParams.delete("session");
    history.replaceState(null, "", url.toString());
  }, [endIncognito, navigate]);

  /* Leaving the chat ends an incognito one, wherever you go next: it is a
     chat you close by walking away from, and a turn still running does not
     hold it open. */
  useEffect(() => {
    if (!incognitoId || page === "chat") return;
    endIncognito();
  }, [incognitoId, page, endIncognito]);

  /* And the window going ends it: a reload, a closed tab, a phone put away.
     The server has the same rule for a tab that dies without saying anything. */
  useEffect(() => {
    if (!incognitoId) return;
    const leaving = () => endIncognito();
    window.addEventListener("pagehide", leaving);
    window.addEventListener("beforeunload", leaving);
    return () => {
      window.removeEventListener("pagehide", leaving);
      window.removeEventListener("beforeunload", leaving);
    };
  }, [incognitoId, endIncognito]);

  const newSession = useCallback(async () => {
    // Opening another chat closes an incognito one: two at once is not a thing.
    endIncognito();
    const res = await fetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({}),
    });
    const { id } = await res.json();
    history.replaceState(null, "", `?session=${id}`);
    setSessionId(id);
    setSessionsOpen(false);
    /* Put it in the list before anything can be drawn from that list. It is
       only refetched on a ten-second timer, so without this the chat that was
       just created is missing from the switcher -- and from the top of it --
       for however long is left of that. */
    await fetch("/api/sessions")
      .then((r) => r.json())
      .then(setSessions)
      .catch(() => undefined);
    return id as string;
  }, [endIncognito]);

  const pickSession = useCallback((id: string) => {
    // Going to another chat ends an incognito one rather than leaving it open
    // in the background: it is not somewhere to come back to.
    if (incognitoRef.current && incognitoRef.current !== id) endIncognito();
    history.replaceState(null, "", `?session=${id}`);
    setSessionId(id);
    setSessionsOpen(false);
  }, [endIncognito]);

  /** The open chat is an incognito one. */
  const incognito = Boolean(incognitoId) && sessionId === incognitoId;

  const live = status.state === "live";
  /** The to-do list docked above the message box (lib/stage.ts says which):
      only in a live session -- a recorded one keeps its list in the thread. */
  const dockPlan = useMemo(() => (live ? dockedPlan(view.buckets) : null), [live, view.buckets]);
  /* Only a session that can never take a turn again is read-only. A socket
     that is reconnecting -- a phone waking up, a network blip, the server
     restarting -- used to count too, and that disabled the box (and threw
     away its focus) mid-sentence, at random as far as anyone typing could
     tell. Messages go over a plain request anyway, not the socket. */
  const readOnly = status.state === "recorded" || status.state === "closed";
  const nothingAttached = attached.length === 0 && attachedBooks.length === 0;

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

  /* The speaker under one reply. A press is a real gesture, which is what iOS
     wants before anything may be heard; anything already being read stops
     first, so this is also how a long reply gets cut short, and pressing the
     same speaker again starts it over. flush() is what actually renders the
     words -- say() only hands them over, and on the server voice they would
     otherwise wait for the next turn to end. */
  /**
   * One button under each reply: press to hear it, press again to stop it,
   * press again to hear it.
   *
   * Which reply the voice is on is remembered rather than asked for, because
   * "is this the one being read" is a question about the press, not about the
   * sound. A silenced reply keeps its slashed icon and its place until it is
   * pressed again, so the button says what will happen next rather than what is
   * happening now. Unmuting says the reply again: the voice renders a turn in
   * one piece and holds nothing to resume from, and hearing it from the start
   * is better than a button that appears to do nothing.
   */
  const [readingReply, setReadingReply] = useState<{ text: string; muted: boolean } | null>(null);
  const readingRef = useRef(readingReply);
  readingRef.current = readingReply;

  const speakReply = useCallback(
    (text: string) => {
      const on = readingRef.current;
      if (on && sameReply(on.text, text)) {
        if (!on.muted) {
          hush();
          setReadingReply({ text, muted: true });
          return;
        }
        prime();
        say(text);
        flush();
        setReadingReply({ text, muted: false });
        return;
      }
      prime();
      hush();
      say(text);
      flush();
      setReadingReply({ text, muted: false });
    },
    [prime, hush, say, flush],
  );

  /* The voice stopping by itself puts the speaker back to plain; one that was
     silenced keeps its slashed icon until it is pressed again. */
  useEffect(() => {
    if (speaking) return;
    setReadingReply((was) => (was && !was.muted ? null : was));
  }, [speaking]);

  // Read the agent's replies out loud, a sentence at a time as they stream --
  // waiting for the whole answer is a silence as long as the answer, and
  // speaking each token is a stutter.
  useEffect(() => {
    if (!liveOn || !canSpeak) return;
    /* Silenced means silenced: a reply being read as it arrives would otherwise
       start up again with the next sentence and the slashed icon would be a lie. */
    if (readingRef.current?.muted) return;
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
        if (prose) {
          narrating.current = reply.seq;
          say(prose);
          /* The speaker under this reply is the one being read, so it says so --
             and a reply that is still arriving grows under the same button. */
          setReadingReply((was) =>
            was && sameReply(was.text, reply.text)
              ? { ...was, text: reply.text }
              : { text: reply.text, muted: false },
          );
        }
      }
    }
    /* The turn is over, or the agent has moved on to something else -- so no
       more text is coming for this reply and it can be spoken. Waiting for the
       next token used to be impossible, so each sentence went out on its own,
       and each one arrived in a different draw of the voice. */
    const last = view.buckets[view.buckets.length - 1];
    const tail = last?.cells[last.cells.length - 1];
    const arriving = Boolean(last?.open) && tail?.kind === "reply"
      && tail.turn.seq === narrating.current;
    if (!arriving) flush();
  }, [liveOn, canSpeak, view.buckets, say, flush]);

  // What the agent says with its speak tool plays as it arrives, live mode or
  // not: it was asked to say something, so it is heard, not handed over as a
  // file. Only fresh events -- opening an old session must not replay every
  // sentence it ever spoke.
  const said = useRef(new Set<number>());
  useEffect(() => { said.current.clear(); }, [sessionId]);
  /* The voice muted from the thread: the agent calling voice_mute. The setting
     is saved server-side; this is the sound stopping in the same breath,
     because a mute that takes effect at the next turn is not a mute. */
  const muted = useRef(new Set<number>());
  useEffect(() => { muted.current.clear(); }, [sessionId]);
  useEffect(() => {
    const now = Date.now() / 1000;
    for (const e of events) {
      if (e.kind !== Kind.MediaMute || muted.current.has(e.seq)) continue;
      muted.current.add(e.seq);
      if (now - e.ts > SPEAK_FRESH_S) continue;
      if (e.payload?.muted !== false) hush();
    }
  }, [events, hush]);

  useEffect(() => {
    if (!canSpeak) return;
    const now = Date.now() / 1000;
    for (const e of events) {
      if (e.kind !== Kind.MediaSpeech || said.current.has(e.seq)) continue;
      said.current.add(e.seq);
      if (now - e.ts > SPEAK_FRESH_S) continue;
      const prose = speakable(String(e.payload?.text ?? ""));
      if (prose) {
        /* Asked to say something out loud: it is already whole, so it goes
           out at once rather than waiting for a turn that is not coming. */
        say(prose);
        flush();
      }
    }
  }, [events, canSpeak, say, flush]);

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
      case "triggers":
      case "config":
      case "system":
        navigate(command.id);
        break;
    }
  }, [stopTurn, send, view.transcript, newSession, closeBrowser, voiceReady, live, toggleLive, navigate]);

  /** Enter or the send button: a command if the box holds one, otherwise
      the message as typed. */
  const submit = useCallback((interrupt?: boolean) => {
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
    void send(undefined, interrupt);
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
  /* True only while the Mind is actually being lit up. The count in `bloom`
     stays where it is, so it can key the element; this flag is what the class
     reads, because a count that never goes back to zero keeps the animation
     class on the item for ever -- and a phone's drawer mounts the rail afresh
     every time it opens, which played that ending all over again. */
  const [mindGlow, setMindGlow] = useState(false);
  const mood: MarkState = pending > 0
    ? "waiting"
    : failing
      ? "error"
      : live && running
        ? reading.phase
        : liveOn ? "live" : "rest";

  // Moments in the log, as they arrive: a failure, something learned. Only
  // fresh events count, so opening an old session is not a replay.
  useEffect(() => {
    const now = Date.now() / 1000;
    let newest = noticed.current;
    const timers: number[] = [];
    const calls = new Map<string, string>();
    for (const e of events) {
      if (e.kind === Kind.ToolCall && e.span) calls.set(e.span, String(e.payload.name ?? ""));
      if (e.seq <= noticed.current) continue;
      newest = Math.max(newest, e.seq);
      if (now - e.ts > 10) continue;
      if (e.kind === Kind.Error) {
        setFailing(true);
        timers.push(window.setTimeout(() => setFailing(false), 1600));
      }
      // A new MCP server connected: a new capability, carried to Integrations.
      if (e.kind === Kind.ToolResult && e.payload.ok !== false && e.span
          && calls.get(e.span) === "mcp_offer" && /new tool/.test(String(e.payload.preview ?? ""))) {
        timers.push(window.setTimeout(() => {
          flySpark(
            visible(".ask.is-settled.is-answered", ".composer-send"),
            visible(".rail-slot [data-page=\"mcp\"]", ".menu-btn"),
            undefined,
            "glow",
          );
        }, 200));
      }
      if (e.kind === Kind.MemoryLearned) {
        const count = (Array.isArray(e.payload.items) ? e.payload.items.length : 0);
        if (!count) continue;
        // After the card has painted, so the spark leaves from it.
        timers.push(window.setTimeout(() => {
          flySpark(
            visible(".learned"),
            visible(".rail-slot [data-page=\"mind\"]", ".menu-btn"),
            () => {
              setLearned((n) => n + count);
              setBloom((b) => b + 1);
              setMindGlow(true);
              timers.push(window.setTimeout(() => setMindGlow(false), 1400));
            },
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

  /* How this chat works and what it may do without asking: both live on the
     server, per chat, and this is the one place they change. What the server
     says wins, except for a chat that is not in the list at all (incognito)
     or a change that has not been answered yet: those live here, so a
     control never disagrees with what was just pressed. */
  type ChatSettings = { mode: WorkMode; permissions: Permissions; ask_when: string };
  const [settingsOverride, setSettingsOverride] = useState<Record<string, Partial<ChatSettings>>>({});
  const [modeSaving, setModeSaving] = useState(false);
  const [modeError, setModeError] = useState<string | null>(null);
  const listedSession = sessions.find((s) => s.id === sessionId);
  const own = sessionId ? settingsOverride[sessionId] : undefined;
  const sessionMode: WorkMode = own?.mode ?? (listedSession?.mode as WorkMode | undefined) ?? DEFAULT_WORK_MODE;
  const sessionPermissions: Permissions =
    own?.permissions ?? (listedSession?.permissions as Permissions | undefined) ?? DEFAULT_PERMISSIONS;
  const sessionAskWhen: string = own?.ask_when ?? listedSession?.ask_when ?? "";

  const changeSession = useCallback(
    async (change: Partial<ChatSettings>) => {
      if (!sessionId) return;
      setModeSaving(true);
      setModeError(null);
      setSettingsOverride((prev) => ({ ...prev, [sessionId]: { ...prev[sessionId], ...change } }));
      const forget = () =>
        setSettingsOverride((prev) => {
          const next = { ...prev };
          delete next[sessionId];
          return next;
        });
      try {
        const res = await fetch(`/api/sessions/${sessionId}`, {
          method: "PATCH",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(change),
        });
        if (!res.ok) {
          const body = await res.json().catch(() => null);
          forget();
          setModeError(body?.error ?? "That could not be changed.");
        }
      } catch {
        forget();
        setModeError("Could not reach the server.");
      } finally {
        setModeSaving(false);
      }
    },
    [sessionId],
  );
  const setSessionMode = useCallback((mode: WorkMode) => void changeSession({ mode }), [changeSession]);
  const setSessionPermissions = useCallback(
    (permissions: Permissions) => void changeSession({ permissions }),
    [changeSession],
  );
  const setSessionAskWhen = useCallback(
    (ask_when: string) => void changeSession({ ask_when }),
    [changeSession],
  );

  /* The app window takes the right of the chat on a wide screen, for a live
     session; on a phone it lives in the pinned view. */
  const phoneLayout = usePhone();
  const preview = usePreviewState();
  const desk = useDeskState();
  const off = useOfficeState();
  const windowAt = (kind: OfficeKind) => off.windows.find((w) => w.kind === kind) ?? null;
  const pointedAt = useOfficePick();
  const panes = usePanes();
  /* What is open beside the chat, each with when it changed: the window shown is the newest, unless the person
     has picked a tab, and their pick sticks until that window is put away. The browser is live work in front of
     the person, so it takes the window while it is open; the document is back the moment it is put away. */
  const [pickedWindow, setPickedWindow] = useState<SideWindow | null>(null);
  const openWindows: Array<{ pane: SideWindow; since: number }> = [
    ...(preview.open ? [{ pane: "app" as const, since: preview.since ?? 0 }] : []),
    ...(desk.open ? [{ pane: "pdf" as const, since: desk.since ?? 0 }] : []),
    ...OFFICE_PANES.flatMap((o) => {
      const win = windowAt(o.kind);
      return win ? [{ pane: o.pane, since: win.since ?? 0 }] : [];
    }),
    ...(browser?.open ? [{ pane: "browser" as const, since: Number.MAX_SAFE_INTEGER }] : []),
  ];
  const sidePane: SideWindow | null = phoneLayout ? null : (() => {
    if (pickedWindow && openWindows.some((w) => w.pane === pickedWindow)) return pickedWindow;
    // Ties go to the later kind in this list: the more specific window.
    return openWindows.length ? openWindows.reduce((best, w) => (w.since >= best.since ? w : best)).pane : null;
  })();
  /* The tabs: one per window open beside the chat, named for the app rather than the file, in a settled order so
     they do not move about, and shown even when there is only one -- a window never disappears from under the
     person. Every window that is open stays mounted (see below), so a tab is never a reload. */
  const sideWindows: Array<{ pane: SideWindow; label: string }> = [
    ...(desk.open ? [{ pane: "pdf" as const, label: "PDF" }] : []),
    ...OFFICE_PANES.filter((o) => openWindows.some((w) => w.pane === o.pane)).map((o) => ({ pane: o.pane, label: o.label })),
    ...(browser?.open ? [{ pane: "browser" as const, label: "Browser" }] : []),
    ...(preview.open ? [{ pane: "app" as const, label: "Creator" }] : []),
  ];
  /* The newest browser card: the one looking at the page that still exists, which is
     the page the pane shows. */
  const screenCell = useMemo(() => {
    let best: Extract<Cell, { kind: "screen" }> | null = null;
    for (const bucket of view.buckets) {
      for (const cell of bucket.cells) {
        if (cell.kind !== "screen" || cell.source !== "browser") continue;
        if (!best || cell.seq > best.seq) best = cell;
      }
    }
    return best;
  }, [view.buckets]);
  const appPane = sidePane !== null;
  /* The browser window is the live view while it is open, so the thread's card
     stops following the feed: one live page, not the same one in two places. */
  useEffect(() => setLivePaneOwns(sidePane === "browser"), [sidePane]);

  const sessionCost = sessions.find((s) => s.id === sessionId)?.cost ?? 0;

  const currentName =
    sessions.find((s) => s.id === sessionId)?.title?.trim() ||
    view.title ||
    "Untitled session";

  const openKnowledge = useCallback(() => navigate("mind"), [navigate]);
  // Stable, like every other handler the thread gets: a new function each
  // render would make every card in it redraw on every streamed word.
  const stopFromThread = useCallback(() => void stopTurn(), [stopTurn]);
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

  /** A suggestion tapped -- a next step, a task on a new chat: sent as it
      is, in this chat, without touching anything half-typed in the box. */
  const sendSuggestion = useCallback(async (text: string, title?: string) => {
    if (!sessionId || !text.trim()) return;
    if (!speaking) prime();
    flySpark(visible(".next-steps, .starters", ".composer-send"), visible(".rail-slot .presence", ".top-presence"));
    const res = await fetch(`/api/sessions/${sessionId}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      // The card's own words name a new chat better than the instruction does.
      body: JSON.stringify({ text, ...(title ? { title } : {}) }),
    }).catch(() => null);
    if (!res?.ok) setNotice("Could not reach the server; that was not sent.");
  }, [sessionId, speaking, prime]);
  const suggestFromThread = useCallback(
    (text: string, title?: string) => void sendSuggestion(text, title),
    [sendSuggestion],
  );

  /** Something noticed, looked into from the sidebar: in a chat of its own,
      so whatever is open stays as it was. */
  const startTask = useCallback(async (text: string, title?: string) => {
    const id = await newSession();
    navigate("chat");
    setDrawerOpen(false);
    const res = await fetch(`/api/sessions/${id}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text, ...(title ? { title } : {}) }),
    }).catch(() => null);
    if (!res?.ok) setNotice("Could not reach the server; that was not sent.");
  }, [newSession, navigate]);

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
      onSend={suggestFromThread}
    />
  ) : undefined;

  const refreshSessions = useCallback(() => {
    fetch("/api/sessions").then((r) => r.json()).then(setSessions).catch(() => undefined);
  }, []);

  const readUsage = useCallback(() => {
    fetch("/api/usage").then((r) => r.json()).then(setUsage).catch(() => undefined);
  }, []);

  /* The ledger only moves when a turn finishes, so the reads that matter are
     one at the start, one when a turn ends, one when the window comes back, and
     one when a setting that decides the bars is saved -- the same reason the
     voice service is re-checked rather than decided once and kept. Each is a
     single read of a number the server already holds.

     The fourth is the one that was missing: a key taken out of Settings decides
     which vendors have a line at all, and without it the bar went on showing an
     account that had just been disconnected until some later turn ended. */
  useEffect(() => {
    readUsage();
    window.addEventListener("focus", readUsage);
    window.addEventListener(MONEY_CHANGED, readUsage);
    return () => {
      window.removeEventListener("focus", readUsage);
      window.removeEventListener(MONEY_CHANGED, readUsage);
    };
  }, [readUsage]);

  useEffect(() => { if (!running) readUsage(); }, [running, readUsage]);

  const openSession = useCallback((id: string) => {
    pickSession(id);
    navigate("chat");
  }, [navigate, pickSession]);

  /* The corner widgets, made once per change of what they hold rather than on
     every render: Thread's props must be stable. */
  const dockEl = useMemo(() => (
    <Dock
      dock={appearance.dock}
      targets={{
        go: navigate,
        openSession,
        openMemory: (id, kind) => { setMindBucket({ kind, id }); navigate("mind"); },
        settingsTab: (tab) => { setConfigJump({ tab }); navigate("config"); },
      }}
    />
  ), [appearance.dock, navigate, openSession]);

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

  return (
    <div
      className={`app${panes.collapsed ? " rail-collapsed" : ""}`}
      style={{
        ...(panes.rail ? { "--rail-w": `${panes.rail}px` } : {}),
        ...(panes.chat ? { "--chat-w": `${panes.chat}px` } : {}),
      } as React.CSSProperties}
    >
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
            onOpenSession={(id) => { openSession(id); setDrawerOpen(false); }}
            onOpenMemory={(id, kind) => { setMindBucket({ kind, id }); navigate("mind"); setDrawerOpen(false); }}
            context={view.context}
            relayOn={!!relay?.connected}
            mood={mood}
            attention={attention}
            pulse={welcome}
            learned={learned}
            bloom={bloom}
            mindGlow={mindGlow}
            alert={pending > 0}
            onNew={() => { void newSession(); navigate("chat"); }}
            onIncognito={() => { void startIncognito(); }}
            onStartTask={(text, title) => { void startTask(text, title); }}
            drawer={kind === "drawer"}
            onClose={() => setDrawerOpen(false)}
            onFold={() => setRailCollapsed(true)}
          />
        </div>
      ))}
      {/* The seam between the menu and the conversation, on a desktop. */}
      <ResizeHandle
        className="is-rail"
        label="Resize the menu"
        value={panes.rail ?? RAIL.fallback}
        min={RAIL.min}
        max={RAIL.max}
        onChange={setRailWidth}
        onReset={() => setRailWidth(null)}
      />

      <div className="shell">
        {/* Above everything, including the header: an app running code that is
            two releases old is not a detail to mention further down. */}
        <UpdateNotice />
        <Notices onOpenSession={openSession} />
        <SureHost />
        <InstallApp />

        <header className="top">
          <button
            className="btn icon ghost menu-btn"
            onClick={() => { if (panes.collapsed && wideScreen()) setRailCollapsed(false); else setDrawerOpen(true); }}
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

          {/* What this chat may do on its own. Beside the session name,
              because it is a property of the conversation. */}
          {page === "chat" && sessionId && (
            <PermissionsPill
              permissions={sessionPermissions}
              askWhen={sessionAskWhen}
              onChange={setSessionPermissions}
              onChangeWhen={setSessionAskWhen}
              busy={modeSaving}
              error={modeError}
            />
          )}

          {/* The one state of the header worth stating outright: this chat is
              written down nowhere, and leaving it ends it. */}
          {incognito && (
            <button
              className="badge incognito"
              onClick={() => { void newSession(); }}
              title="Incognito — nothing here is saved. Another chat or leaving the chat ends it."
              aria-label="Leave the incognito chat"
            >
              <IconMask size={12} />
              Incognito
              <IconX size={10} />
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

          {/* The page's own action, in the corner it is looked for in: a page
              that can make something should say so where its name is, rather
              than in a bar of its own under the title. Rightmost, because a
              page's one button is the thing the eye should land on last. */}
          <div className="top-action-slot" ref={setTopSlot} />
        </header>

        {page !== "chat" && (
          <div className="page-host">
            {/* One boundary for every page: whichever is opened arrives as its
                own chunk, and the header above stays put while it does. */}
            <Suspense fallback={null}>
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
            {page === "notebooks" && (
              <NotebooksPage open={notebookOpen} onOpen={setNotebookOpen} onUseInChat={notebookToChat} topSlot={topSlot} />
            )}
            {page === "tools" && <ToolsPage />}
            {page === "mcp" && <McpPage topSlot={topSlot} />}
            {page === "cron" && <Schedule embedded topSlot={topSlot} onOpenSession={openSession} />}
            {page === "triggers" && <Triggers topSlot={topSlot} onOpenSession={openSession} />}
            {page === "mind" && (
              <MindPage jump={mindBucket} recent={view.memories} />
            )}
            </Suspense>
          </div>
        )}

        {/* The conversation stays mounted under the other pages, so leaving
            it and coming back keeps your place in the thread. */}
        <div className={`chat-view${appPane ? " has-app" : ""}`} hidden={page !== "chat"}>

        <main className="page">
          {/* The room's light: cool at rest, warmer while it works, amber
              while it waits on you. Barely there, and still when away. */}
          <div className={`mood-light is-${mood}`} aria-hidden="true" />
          <Thread
            buckets={view.buckets}
            // Stopped on a question is not working; the card says what it is.
            busy={view.busy && !view.asking}
            doing={doing}
            elapsedMs={elapsed}
            steps={reading.steps}
            phase={reading.phase}
            sessionId={sessionId ?? ""}
            liveBrowserSeq={view.liveBrowserSeq}
            browserOpen={browser?.open === true}
            live={live}
            onPermissionDecide={handlePermissionDecide}
            onSuggest={suggestFromThread}
            onSpeakReply={canSpeak ? speakReply : undefined}
            speakingReply={readingReply}
            driving={driving}
            browserHandedOver={browserHandedOver}
            onStop={stopFromThread}
            onOpenMind={openKnowledge}
            onOpenSettings={openModelSettings}
            placeholder={placeholder}
            dockedPlanKey={dockPlan ? cellKey(dockPlan) : ""}
            // Anything pinned to the corners of the conversation. Empty
            // unless it is asked for in Settings -> Appearance.
            dock={dockEl}
          />

          <Approvals
            approvals={view.approvals}
            readOnly={!live}
            onDecide={(id, approved, remember) => streamRef.current?.approve(id, approved, remember)}
          />

          {/* The screen above stays exactly as it was; only this strip changes,
              because the point of talking to it is to keep watching it work. */}
          <div className={`composer ${liveOn ? "is-live" : ""}`} ref={composerEl}>
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
              <>
              {/* In talk mode too. A spoken turn costs what a typed one does,
                  and the bar used to vanish exactly when a conversation
                  started -- which is when the number is moving. */}
              {usage && (
                <div className="spend-strip">
                  <SpendBar
                    spent={usage.month.cost}
                    session={sessionCost}
                    budget={usage.budget.monthly_usd}
                    lifetime={usage.lifetime.cost}
                    vendors={usage.vendors}
                    onOpen={() => navigate("analytics")}
                  />
                </div>
              )}
              <Suspense fallback={null}>
              <LiveChat
                onUtterance={sendSpoken}
                onInterrupt={hush}
                sessionId={sessionId}
                agentSpeaking={speaking}
                agentWorking={running}
                speechLevel={speech.level}
                disabled={!live}
                onClose={toggleLive}
              />
              </Suspense>
              </>
            ) : (
              <>
                {/* The agent's to-do list, attached to the top of the box:
                    one line, the task it is on, tap for all of them. */}
                {dockPlan && <TodoDock key={cellKey(dockPlan)} items={dockPlan.items} />}
                <div className={`composer-box ${draft.trim() || attached.length > 0 || attachedBooks.length > 0 ? "has-text" : ""}`}>
                  {/* What the month has cost against the ceiling set in
                      Settings, with this session's share at the right-hand
                      end. Nothing until the first read comes back, so the
                      box never makes room for a number it does not have. */}
                  {usage && (
                    <SpendBar
                      spent={usage.month.cost}
                      session={sessionCost}
                      budget={usage.budget.monthly_usd}
                      lifetime={usage.lifetime.cost}
                      vendors={usage.vendors}
                      onOpen={() => navigate("analytics")}
                    />
                  )}
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
                    onPaste={(e) => {
                      // Files on the clipboard (a screenshot, a copied picture) are attached;
                      // pasted text goes into the box as usual.
                      const files = Array.from(e.clipboardData.items)
                        .filter((item) => item.kind === "file")
                        .map((item) => item.getAsFile())
                        .filter((file): file is File => file !== null);
                      if (files.length === 0) return;
                      e.preventDefault();
                      const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
                      void addFiles(files.map((file, i) => (/^image\.\w+$/i.test(file.name)
                        ? new File([file], `pasted-${stamp}${files.length > 1 ? `-${i + 1}` : ""}.${file.type.split("/")[1]?.replace(/[^a-z0-9]/gi, "") || "png"}`, { type: file.type })
                        : file)));
                    }}
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
                        // Alt, Ctrl or Cmd with Enter stops the agent first; plain Enter adds to its work.
                        submit(e.altKey || e.ctrlKey || e.metaKey);
                      }
                    }}
                  />
                  {(attached.length > 0 || attachedBooks.length > 0 || (pointedAt && pointedAt.session === sessionId)) && (
                    /* Boxes along the bottom of the field, left to right: a
                       picture is the picture, a file is its name. Both arrive
                       with the same small pop. */
                    <div className="attach-row">
                      {pointedAt && pointedAt.session === sessionId && (
                        <span className="attach-chip is-file is-pointer">
                          <IconFile size={16} />
                          <span className="attach-meta">
                            <b title={pickLabel(pointedAt)}>{pickLabel(pointedAt)}</b>
                            <em>{pointedAt.file}</em>
                          </span>
                          <button type="button" className="attach-drop" onClick={clearOfficePick} title="Stop pointing at this" aria-label="Stop pointing at this">
                            <IconX size={12} />
                          </button>
                        </span>
                      )}
                      {attachedBooks.map((book) => (
                        <span className="attach-chip is-file is-notebook" key={book.id}>
                          <IconNotebook size={16} />
                          <span className="attach-meta">
                            <b title={book.title}>{book.title}</b>
                            <em>notebook</em>
                          </span>
                          <button
                            type="button"
                            className="attach-drop"
                            onClick={() => setAttachedBooks((list) => list.filter((b) => b.id !== book.id))}
                            title={`Remove ${book.title}`}
                            aria-label={`Remove ${book.title}`}
                          >
                            <IconX size={12} />
                          </button>
                        </span>
                      ))}
                      {attached.map((file) => (
                        isPicture(file.mime) ? (
                          <span className="attach-chip is-pic" key={file.id} title={file.name}>
                            <img className="attach-pic" src={`/api/artifacts/${file.id}`} alt={file.name} />
                            <button
                              type="button"
                              className="attach-drop"
                              onClick={() => dropAttachment(file.id)}
                              title={`Remove ${file.name}`}
                              aria-label={`Remove ${file.name}`}
                            >
                              <IconX size={12} />
                            </button>
                          </span>
                        ) : (
                          <span className="attach-chip is-file" key={file.id}>
                            <IconFile size={16} />
                            <span className="attach-meta">
                              <b title={file.name}>{file.name}</b>
                              <em>{sizeLabel(file.size)}</em>
                            </span>
                            <button
                              type="button"
                              className="attach-drop"
                              onClick={() => dropAttachment(file.id)}
                              title={`Remove ${file.name}`}
                              aria-label={`Remove ${file.name}`}
                            >
                              <IconX size={12} />
                            </button>
                          </span>
                        )
                      ))}
                      {attaching > 0 && (
                        <span className="attach-chip is-loading" title="Uploading" aria-label="Uploading">
                          <span className="attach-spin" aria-hidden="true" />
                        </span>
                      )}
                    </div>
                  )}
                  <div className="composer-foot">
                    <div className="composer-tools">
                      {/* One strip, always one line: the row is the toolstrip,
                          and a control that falls to a second line reads as a
                          different kind of thing. What it holds gives way
                          instead -- the mode pill drops its word on a phone
                          (see ModeSelect) -- so the wrench stays at the end of
                          the row, beside Send, at every width. The note below
                          is outside the strip and takes its own line. */}
                      <div className="composer-strip">
                      {/* How the agent goes about the work, on the row above
                          Send: it applies to the words in the box. */}
                      <ModeSelect mode={sessionMode} onChange={setSessionMode} busy={modeSaving} compact={appPane} />
                      {/* Leftmost in the row, and the only one of the two that
                          carries a conversation: Talk sits where the hand
                          goes first. It used to float over the thread above
                          Send on phones, where it covered the last line of
                          whatever was there.

                          The word "Talk" is gone: four glyphs in a row read as
                          a toolstrip, and each one is named for a screen
                          reader anyway. The mark is drawn larger here than
                          anywhere else at this weight, because a triangle
                          fills under half of its own box -- 28 is what makes
                          it as big on screen as the 15px mic beside it. (The
                          one that carries the size is the mark in the live
                          bar; this row is a toolstrip and the mark is one
                          control in it.) It follows the icon size in Settings
                          (--is, which the plain glyphs get from their own
                          stylesheet). */}
                      <button
                        className="btn ghost icon composer-live"
                        onClick={voiceReady ? toggleLive : () => setVoiceHelp(true)}
                        disabled={!live}
                        title={voiceReady ? "Talk with Autora out loud (v)" : "Live voice requires https"}
                        aria-label="Live voice chat"
                        aria-pressed={liveOn}
                      >
                        <AutoraMark
                          state={liveState}
                          size={Math.round(28 * iconScale(appearance.icons))}
                        />
                      </button>
                      {/* Beside Talk: type by voice into the box instead of
                          speaking the turn, which is the quieter half of the
                          same idea. */}
                      <DictateButton
                        onText={appendDictation}
                        disabled={readOnly}
                        onBlocked={() => setVoiceHelp(true)}
                        onTrouble={setNotice}
                      />
                      {/* Beside the two voices, at every width: the two things you can
                          hand over without typing -- a file, or a photo taken
                          here. Both land in the artifacts store first, so
                          nothing is lost if Send comes later. */}
                      <AttachButton
                        onFiles={(files) => void addFiles(files)}
                        disabled={readOnly}
                        busy={attaching > 0}
                        onTrouble={setNotice}
                      />
                      <CameraButton
                        onFiles={(files) => void addFiles(files)}
                        disabled={readOnly}
                        onTrouble={setNotice}
                      />
                      <button
                        type="button"
                        className="btn ghost icon attach-btn"
                        onClick={() => setLibraryOpen(true)}
                        disabled={readOnly}
                        title="Add a notebook or a saved file"
                        aria-label="Add a notebook or a saved file"
                      >
                        <IconNotebook size={18} />
                      </button>
                      {/* The toolbox, between the notebook and Send: the apps the
                          person can open themselves, each with a new blank file,
                          without spending a turn on it. */}
                      <button
                        type="button"
                        className={`btn ghost icon attach-btn${toolsOpen ? " is-on" : ""}`}
                        onClick={() => setToolsOpen((v) => !v)}
                        disabled={readOnly}
                        title="Tools: open an app with a new blank file"
                        aria-label="Tools"
                        aria-expanded={toolsOpen}
                      >
                        <IconWrench size={18} />
                      </button>
                      </div>
                      {toolsOpen && sessionId && (
                        <ToolsSheet
                          session={sessionId}
                          onClose={() => setToolsOpen(false)}
                          onTrouble={setNotice}
                          onOpened={(name, app) => setNotice(`${name} is open in ${app}`)}
                        />
                      )}
                      {libraryOpen && (
                        <LibraryPicker
                          tabs={LIBRARY_TABS}
                          title="Add to this message"
                          action="Add"
                          exclude={new Set([...attached.map((f) => f.id), ...attachedBooks.map((b) => b.id)])}
                          onClose={closeLibrary}
                          onPick={addFromLibrary}
                        />
                      )}
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
                      <span className="composer-send-wrap">
                        {/* While the agent is working and there is nothing to send,
                            this is the way to stop it: the same button, the
                            same place, so a phone never has to find /stop. With
                            words in the box it is Send, which adds to the work. */}
                        <button
                          className={`composer-send${running && !draft.trim() && nothingAttached ? " is-stop" : ""}`}
                          // Without a model a message can only fail; a slash
                          // command (/settings) still goes.
                          disabled={readOnly || (!(running && !draft.trim() && nothingAttached)
                            && ((!draft.trim() && nothingAttached)
                              || (modelReady === false && !draft.trim().startsWith("/"))))}
                          onClick={running && !draft.trim() && nothingAttached ? () => void stopTurn() : () => submit()}
                          title={running ? (!draft.trim() && nothingAttached ? "Stop" : "Add to what it is doing (Alt+Enter interrupts & sends)") : "Send"}
                          aria-label={running ? (!draft.trim() && nothingAttached ? "Stop" : "Add to what it is doing") : "Send"}
                        >
                          {running && !draft.trim() && nothingAttached
                            ? <IconStop size={15} />
                            : <IconArrowUp size={17} />}
                        </button>
                      </span>
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
        {/* The seam between the conversation and whatever window is beside it. */}
        {sidePane !== null && (
          <ResizeHandle
            className="is-chat"
            label="Resize the conversation"
            value={panes.chat ?? 480}
            min={CHAT.min}
            max={CHAT.max}
            onChange={setChatWidth}
            onReset={() => setChatWidth(null)}
          />
        )}
        {sidePane !== null && (
          <div className="side-stack">
            {/* One tab per window open beside the chat, named for the app it is (PDF, Pages, Sheets, Slides) rather
                than the file in it. The strip is there whenever a window is open, and picking a tab shows that
                window and puts nothing away. */}
            {sideWindows.length > 0 && (
              <div className="pane-pick" role="tablist" aria-label="Windows open beside the chat">
                {sideWindows.map((w) => (
                  <button
                    key={w.pane}
                    type="button"
                    role="tab"
                    aria-selected={sidePane === w.pane}
                    className={`pane-pick-tab${sidePane === w.pane ? " is-on" : ""}`}
                    title={w.label}
                    data-pane={w.pane}
                    onClick={() => setPickedWindow(w.pane)}
                  >
                    {w.label}
                  </button>
                ))}
              </div>
            )}
            {/* Every window that is open stays mounted, and only the chosen one is shown: switching tabs neither
                reloads the page in one window nor restarts another's editor, and nothing is put away. */}
            {browser?.open && sessionId && (
              <aside className="app-pane" data-pane="browser" hidden={sidePane !== "browser"} aria-label="The browser the agent is driving">
                <ScreencastCell
                  sessionId={sessionId}
                  source="browser"
                  url={screenCell?.url ?? browser?.url ?? null}
                  shots={screenCell?.shots ?? []}
                  actions={screenCell?.actions ?? []}
                  live={screenCell?.live ?? false}
                  followsFeed
                  ownsFeed
                  current={live}
                  driving={driving}
                  waitingOnYou={browserHandedOver}
                  onStop={stopFromThread}
                />
              </aside>
            )}
            {/* The app being built, beside the conversation on a wide screen. On a
                phone it is a tab in the pinned view instead (see Stage). */}
            {preview.open && sessionId && (
              <aside className="app-pane" data-pane="app" hidden={sidePane !== "app"} aria-label="The app being built">
                <AppPreview sessionId={sessionId} phone={false} />
              </aside>
            )}
            {/* The PDF the agent is working on, open for the person to work on too. */}
            {desk.open && sessionId && (
              <aside className="app-pane" data-pane="pdf" hidden={sidePane !== "pdf"} aria-label="The PDF being worked on">
                <SpectraWindow sessionId={sessionId} phone={false} />
              </aside>
            )}
            {/* And one window for each Office app with a document open in it: Autora Pages, Autora Sheets and
                Autora Slides can all be open at the same time, each in its own window with its own tab. */}
            {sessionId && OFFICE_PANES.map((o) => (windowAt(o.kind) ? (
              <aside
                key={o.pane}
                className="app-pane"
                data-pane={o.pane}
                hidden={sidePane !== o.pane}
                aria-label={`The ${o.label} window, open beside the chat`}
              >
                <OfficeWindow sessionId={sessionId} kind={o.kind} phone={false} />
              </aside>
            ) : null))}
          </div>
        )}
        </div>

      </div>

      {sessionsOpen && (
        <Sessions
          sessions={listed}
          current={sessionId}
          onPick={pickSession}
          onNew={newSession}
          onIncognito={() => { void startIncognito(); }}
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
const money = (n: number) => `$${n > 0 && n < 1 ? n.toFixed(3) : n.toFixed(2)}`;

/** Just the site, for a badge with room for about fifteen characters. */
function hostOf(url: string | null): string {
  if (!url) return "a page";
  try {
    const parsed = new URL(url);
    // Chrome's own error page, where a page that failed to load leaves it:
    // its host is "chromewebdata", which means nothing to anyone.
    if (parsed.protocol === "chrome-error:") return "did not load";
    return parsed.host.replace(/^www\./, "") || "a page";
  } catch {
    return url.slice(0, 24);
  }
}
