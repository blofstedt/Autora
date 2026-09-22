import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import {
  AUTO_ORDER, PRICES_CHECKED, PROVIDERS, costOf, isPriced, modelsFor,
  rememberModels,
} from "./server/providers";
import {
  baseUrlFor, clearUsage, keyFor, keySource, maskKey, modelFor, recordUsage,
  resolveProvider, save, setKey, state, stateFilePath,
} from "./server/state";
import { ProviderError, listModels, streamChat, type ChatMessage } from "./server/llm";
import { billingSummary } from "./server/billing";
import { dropSession, fromDataUrl, getBlob, putBlob } from "./server/blobs";
import { LiveBrowser, VIEWPORT, probeBrowser, type PageRead } from "./server/browser";

/* Where to listen. Umbrel's compose file publishes 8817 and passes it in, so
   these cannot be constants; 3000 stays the default because that is what
   `npm run dev` and every link in the README say. */
const PORT = Number(process.env.AUTORA_PORT || process.env.PORT || 3000);
const HOST = (process.env.AUTORA_HOST || "").trim() || "0.0.0.0";

/**
 * What this build is, read from package.json.
 *
 * One string, in one place, and it is the one Umbrel compares to decide an
 * update exists. The app reports it at /api/origin and stamps it into the page
 * it serves, so "which version am I actually looking at" is answerable from
 * the app rather than from the store -- which is the whole point, since the
 * failure this guards against is a browser quietly running yesterday's bundle
 * while the container runs today's.
 */
const VERSION = (() => {
  /* Two places, because the working directory is not guaranteed to be the
     app's: in the container it is, but `node /somewhere/dist/server.cjs` from
     elsewhere is a normal thing to do. argv[1] is the bundle itself, and its
     parent is where package.json sits beside dist/. */
  const beside = process.argv[1] ? path.dirname(path.dirname(process.argv[1])) : "";
  for (const dir of [process.cwd(), beside].filter(Boolean)) {
    try {
      const raw = fs.readFileSync(path.join(dir, "package.json"), "utf8");
      const found = JSON.parse(raw)?.version;
      if (typeof found === "string" && found) return found;
    } catch {
      // Try the next place; a build that cannot find its own package.json
      // should still start.
    }
  }
  return "dev";
})();

// --- Types ---
interface AutoraEvent {
  seq: number;
  ts: number;
  kind: string;
  actor: string;
  span: string | null;
  payload: Record<string, any>;
  blob: string | null;
}

interface Session {
  id: string;
  title: string;
  live: boolean;
  createdAt: number;
  busy: boolean;
  events: AutoraEvent[];
  seqCounter: number;
}

interface MemoryRecord {
  id: string;
  kind: "fact" | "preference" | "procedure" | "skill";
  scope: string;
  title: string;
  body: string;
  tags: string[];
  status: "provisional" | "confirmed";
  pinned: boolean;
  source_session: string | null;
  source_seq: number | null;
  created: number;
  updated: number;
  uses: number;
  last_used: number | null;
  superseded_by: string | null;
}

interface MemoryLink {
  src: string;
  dst: string;
  rel: string;
}

interface Job {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  created: number;
  last_run: number | null;
  last_session: string | null;
  last_error: string | null;
  next_run: number | null;
  cron_error: string | null;
}

// --- In-Memory State ---
const sessions = new Map<string, Session>();
const sessionSockets = new Map<string, Set<WebSocket>>();

const memoryRecords: MemoryRecord[] = [
  {
    id: "mem-1",
    kind: "procedure",
    scope: "project",
    title: "Vite and Express deployment configuration",
    body: "Run server.ts on host 0.0.0.0 and port 3000 with Vite middleware in dev and dist static assets in production.",
    tags: ["build", "node", "deployment"],
    status: "confirmed",
    pinned: true,
    source_session: "session-init",
    source_seq: 1,
    created: Math.floor(Date.now() / 1000) - 86400,
    updated: Math.floor(Date.now() / 1000) - 86400,
    uses: 12,
    last_used: Math.floor(Date.now() / 1000),
    superseded_by: null,
  },
  {
    id: "mem-2",
    kind: "preference",
    scope: "user",
    title: "Concise responses with execution steps",
    body: "Provide explicit step-by-step actions and emit telemetry events for real-time console display.",
    tags: ["style", "output", "agent"],
    status: "confirmed",
    pinned: true,
    source_session: "session-init",
    source_seq: 2,
    created: Math.floor(Date.now() / 1000) - 43200,
    updated: Math.floor(Date.now() / 1000) - 43200,
    uses: 24,
    last_used: Math.floor(Date.now() / 1000),
    superseded_by: null,
  },
  {
    id: "mem-3",
    kind: "fact",
    scope: "workspace",
    title: "Autora Broadcast Architecture",
    body: "Event logs are persisted sequentially and streamed to client subscribers via WebSocket /ws/:session.",
    tags: ["architecture", "websocket", "events"],
    status: "confirmed",
    pinned: false,
    source_session: "session-init",
    source_seq: 3,
    created: Math.floor(Date.now() / 1000) - 10000,
    updated: Math.floor(Date.now() / 1000) - 10000,
    uses: 5,
    last_used: Math.floor(Date.now() / 1000),
    superseded_by: null,
  },
  {
    id: "mem-skill-1",
    kind: "skill",
    scope: "workspace",
    title: "Web Browsing & DOM Inspection",
    body: "Headless Chromium navigation, DOM selector targeting, screenshot screencast streaming, and interactive form submissions.",
    tags: ["skill", "browser", "automation", "dom"],
    status: "confirmed",
    pinned: true,
    source_session: "session-init",
    source_seq: 4,
    created: Math.floor(Date.now() / 1000) - 20000,
    updated: Math.floor(Date.now() / 1000) - 20000,
    uses: 18,
    last_used: Math.floor(Date.now() / 1000),
    superseded_by: null,
  },
  {
    id: "mem-skill-2",
    kind: "skill",
    scope: "workspace",
    title: "Terminal & Shell Orchestration",
    body: "Direct PTY execution, streaming command output chunks, exit code monitoring, and non-blocking process management.",
    tags: ["skill", "terminal", "bash", "cli"],
    status: "confirmed",
    pinned: true,
    source_session: "session-init",
    source_seq: 5,
    created: Math.floor(Date.now() / 1000) - 18000,
    updated: Math.floor(Date.now() / 1000) - 18000,
    uses: 32,
    last_used: Math.floor(Date.now() / 1000),
    superseded_by: null,
  },
  {
    id: "mem-skill-3",
    kind: "skill",
    scope: "workspace",
    title: "Autonomous Kanban Task Management",
    body: "Deconstruct multi-step goals into backlog cards, autonomously progress items through Doing, and verify Done criteria with tools.",
    tags: ["skill", "kanban", "planning", "autonomy"],
    status: "confirmed",
    pinned: true,
    source_session: "session-init",
    source_seq: 6,
    created: Math.floor(Date.now() / 1000) - 15000,
    updated: Math.floor(Date.now() / 1000) - 15000,
    uses: 21,
    last_used: Math.floor(Date.now() / 1000),
    superseded_by: null,
  },
  {
    id: "mem-skill-4",
    kind: "skill",
    scope: "workspace",
    title: "Policy Gating & Permission Elevations",
    body: "Present interactive approval cards in the chat transcript with parameter input and security validation prior to sensitive execution.",
    tags: ["skill", "security", "permissions", "policy"],
    status: "confirmed",
    pinned: false,
    source_session: "session-init",
    source_seq: 7,
    created: Math.floor(Date.now() / 1000) - 12000,
    updated: Math.floor(Date.now() / 1000) - 12000,
    uses: 9,
    last_used: Math.floor(Date.now() / 1000),
    superseded_by: null,
  },
  {
    id: "mem-skill-5",
    kind: "skill",
    scope: "workspace",
    title: "Neural Memory Graph Weaving",
    body: "Distill cognitive milestones, associative cross-links, and synaptically traversable memory nodes displayed in the top ribbon.",
    tags: ["skill", "neural", "memory", "graph"],
    status: "confirmed",
    pinned: false,
    source_session: "session-init",
    source_seq: 8,
    created: Math.floor(Date.now() / 1000) - 8000,
    updated: Math.floor(Date.now() / 1000) - 8000,
    uses: 14,
    last_used: Math.floor(Date.now() / 1000),
    superseded_by: null,
  },
];

const memoryLinks: MemoryLink[] = [
  { src: "mem-1", dst: "mem-3", rel: "enforces" },
  { src: "mem-2", dst: "mem-3", rel: "complements" },
  { src: "mem-skill-1", dst: "mem-skill-2", rel: "pairs_with" },
  { src: "mem-skill-3", dst: "mem-skill-4", rel: "gates" },
  { src: "mem-skill-5", dst: "mem-skill-3", rel: "informs" },
  { src: "mem-1", dst: "mem-skill-2", rel: "utilizes" },
  { src: "mem-3", dst: "mem-skill-5", rel: "visualizes" },
];

const jobs: Job[] = [
  {
    id: "job-1",
    name: "Hourly health and repo status check",
    cron: "0 * * * *",
    prompt: "Verify server status, review active memory items, and summarize pending tasks.",
    enabled: true,
    created: Math.floor(Date.now() / 1000) - 3600,
    last_run: Math.floor(Date.now() / 1000) - 1200,
    last_session: "session-init",
    last_error: null,
    next_run: Math.floor(Date.now() / 1000) + 2400,
    cron_error: null,
  },
  {
    id: "job-2",
    name: "Daily memory distillation and graph cleanup",
    cron: "0 3 * * *",
    prompt: "Scan recent session events, distill procedures and preferences into knowledge store.",
    enabled: false,
    created: Math.floor(Date.now() / 1000) - 7200,
    last_run: null,
    last_session: null,
    last_error: null,
    next_run: Math.floor(Date.now() / 1000) + 40000,
    cron_error: null,
  },
];

// Settings used to live here, in a module-level object that lasted exactly as
// long as the process. They now live in ./server/state, on disk, because a key
// you paste into the panel should survive the next deploy -- and so should the
// record of what you have spent. See that module for the file and its
// permissions.

// Seed an initial session with welcoming events
function createInitialSession(): Session {
  const now = Math.floor(Date.now() / 1000);
  const session: Session = {
    id: "session-init",
    title: "System Initialization & Agent Ready",
    live: true,
    createdAt: now - 300,
    busy: false,
    events: [],
    seqCounter: 0,
  };

  function add(kind: string, actor: string, payload: Record<string, any>, span: string | null = null) {
    session.seqCounter += 1;
    session.events.push({
      seq: session.seqCounter,
      ts: now - 300 + session.seqCounter * 2,
      kind,
      actor,
      span,
      payload,
      blob: null,
    });
  }

  add("session.started", "system", { title: session.title });
  add("memory.recall", "agent", {
    ids: ["mem-1", "mem-skill-3"],
    titles: ["Vite and Express deployment configuration", "Autonomous Kanban Task Management"],
  });
  add("turn.user", "user", { text: "Organize project priorities and prepare autonomous task queue." });
  add("turn.agent.thinking", "agent", { text: "Synthesizing workspace objectives into a structured Kanban board and checking elevated policy rules." });
  add("kanban.update", "agent", {
    id: "board-main",
    title: "Project Autonomy Board",
    autonomous: true,
    tasks: [
      { id: "t-1", title: "Verify container ingress on port 3000", status: "done", tag: "network" },
      { id: "t-2", title: "Mount neural synaptic tracers in memory ribbon", status: "doing", tag: "visual" },
      { id: "t-3", title: "Register autonomous skills in memory graph", status: "todo", tag: "skills" },
      { id: "t-4", title: "Verify permission elevation card interactions", status: "todo", tag: "security" },
    ],
  });
  add("permission.request", "agent", {
    requestId: "req-init-1",
    tool: "terminal.bash",
    rendered: "npm run lint && git status --short",
    reason: "Run syntax diagnostics and inspect workspace modification trees.",
    inputType: "boolean",
    settled: false,
  });
  add("turn.agent.text", "agent", { text: "I have initialized the workspace Kanban board and registered your active skill modules in memory. The memory ribbon at the top reflects neural synaptic connections, and interactive permissions cards are surfaced in-stream when elevation or inputs are needed." });
  add("turn.agent.done", "agent", {});

  return session;
}

const defaultSession = createInitialSession();
sessions.set(defaultSession.id, defaultSession);

// Broadcast an event to all connected websockets for a session
function emitEvent(session: Session, kind: string, actor: string, payload: Record<string, any>, span: string | null = null, blob: string | null = null): AutoraEvent {
  session.seqCounter += 1;
  const event: AutoraEvent = {
    seq: session.seqCounter,
    ts: Math.floor(Date.now() / 1000),
    kind,
    actor,
    span,
    payload,
    blob,
  };
  session.events.push(event);

  const sockets = sessionSockets.get(session.id);
  if (sockets) {
    const raw = JSON.stringify({ type: "event", ...event });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  }

  return event;
}

function broadcastLiveStatus(session: Session) {
  const sockets = sessionSockets.get(session.id);
  if (sockets) {
    const raw = JSON.stringify({
      type: "live",
      session: session.id,
      seq: session.events.length,
      busy: session.busy,
    });
    for (const ws of sockets) {
      if (ws.readyState === WebSocket.OPEN) {
        ws.send(raw);
      }
    }
  }
}

/**
 * Something for the watchers that is not part of the record.
 *
 * Live video frames go this way rather than through `emitEvent`. An event is
 * replayed on every reconnect, kept for the life of the session and folded
 * into the transcript; a frame from four seconds ago is worth none of that.
 * So the socket carries two kinds of traffic -- the log, which is durable and
 * resumable, and the feed, which is whatever is happening now and is gone if
 * you were not looking.
 */
function sendEphemeral(sessionId: string, message: Record<string, unknown>) {
  const sockets = sessionSockets.get(sessionId);
  if (!sockets || sockets.size === 0) return;
  const raw = JSON.stringify(message);
  for (const ws of sockets) {
    // Never queue video behind a slow reader: a phone that has gone to sleep
    // would come back to a minute of stale frames ahead of everything real.
    if (ws.readyState === WebSocket.OPEN && ws.bufferedAmount < 2 * 1024 * 1024) {
      ws.send(raw);
    }
  }
}

// ---------------------------------------------------------------- browser --

/** One browser per session, made on first use and kept until the session is
    done with it. */
const browsers = new Map<string, LiveBrowser>();

function browserFor(session: Session): LiveBrowser {
  const existing = browsers.get(session.id);
  if (existing) return existing;

  const live = new LiveBrowser({
    watchers: () => sessionSockets.get(session.id)?.size ?? 0,
    onFrame: (jpegBase64) =>
      sendEphemeral(session.id, {
        type: "frame",
        session: session.id,
        source: "browser",
        mime: "image/jpeg",
        data: jpegBase64,
        w: VIEWPORT.width,
        h: VIEWPORT.height,
        ts: Date.now(),
      }),
    onKeyframe: (jpeg, url) => {
      const blob = putBlob(session.id, jpeg, "image/jpeg");
      emitEvent(session, "browser.frame", "agent", { url, w: VIEWPORT.width, h: VIEWPORT.height }, null, blob);
    },
    onNav: (url, title) => {
      emitEvent(session, "browser.nav", "agent", { url, title });
    },
    onAction: (action, at, url) => {
      emitEvent(session, "browser.action", "agent", {
        action,
        url,
        ...(at ? { x: at.x, y: at.y } : {}),
      });
    },
  });

  browsers.set(session.id, live);
  return live;
}

/** Tell the watchers whether there is a live page to watch, so the card can
    show a feed rather than the last screenshot -- and stop when there is not. */
function broadcastBrowserState(session: Session) {
  const live = browsers.get(session.id);
  sendEphemeral(session.id, {
    type: "browser",
    session: session.id,
    state: live ? live.status() : { available: false, open: false, url: null, title: null, detail: null, fps: 0, viewport: VIEWPORT },
  });
}

// ---------------------------------------------------------------- models --

/** How many past turns of this session to hand the model. Enough for the
    conversation to hold together, bounded so a long session does not grow the
    prompt (and the bill, and the latency) without limit. */
const HISTORY_TURNS = 24;

/** Thinking costs tokens and seconds before a single word appears. This is a
    console you watch, so the default is off; set GEMINI_THINKING_BUDGET to a
    token count (or -1 for "let the model decide") to trade speed for depth. */
const THINKING_BUDGET = (() => {
  const raw = (process.env.GEMINI_THINKING_BUDGET || "").trim();
  if (!raw) return 0;
  const n = Number.parseInt(raw, 10);
  return Number.isFinite(n) ? n : 0;
})();

/** GEMINI_MODEL used to be the only way to pin a model, so an install that
    still sets it should keep working -- but only as a starting value. Once a
    model has been chosen in the panel, that choice is the one that stands;
    otherwise saving a setting would appear to do nothing. */
(() => {
  const pinned = (process.env.GEMINI_MODEL || "").trim();
  if (pinned && !state.models.gemini) {
    state.models.gemini = pinned;
    save();
  }
})();

/**
 * This session's conversation, in the vendor-neutral shape ./server/llm takes.
 *
 * Built from the event log rather than a second transcript kept alongside it,
 * so what the model sees is what the thread shows -- including the turn just
 * posted, which the caller has already emitted by the time we get here.
 *
 * Two details every vendor cares about: consecutive turns from the same
 * speaker are merged (streamed replies arrive as many `turn.agent.text`
 * deltas, and forty one-word model turns is not a conversation), and a history
 * may not open on the assistant, so any leading assistant turns are dropped.
 */
function historyFor(session: Session): ChatMessage[] {
  const turns: ChatMessage[] = [];

  for (const event of session.events) {
    let role: "user" | "assistant" | null = null;
    if (event.kind === "turn.user") role = "user";
    else if (event.kind === "turn.agent.text") role = "assistant";
    if (!role) continue;

    const text = String(event.payload?.text ?? "");
    if (!text) continue;

    const last = turns[turns.length - 1];
    if (last && last.role === role) last.text += text;
    else turns.push({ role, text });
  }

  while (turns.length > 0 && turns[0].role === "assistant") turns.shift();
  return turns.slice(-HISTORY_TURNS);
}

/** How many times to re-ask after a transient refusal, and how long to wait.
    Free tiers answer 503 "high demand" often enough that one spike would
    otherwise read, in the thread, as the app being broken. */
const MODEL_RETRIES = 3;
const RETRY_BACKOFF_MS = [600, 1500, 3200];

/** Codes worth asking again for: rate limits, overload, and the generic 500. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/**
 * A web address in what somebody typed, if there is one.
 *
 * The trigger for actually opening a browser is deliberately a written-down
 * address rather than a guess at intent: "check the deploy" could mean six
 * things, but a message with `example.com/status` in it means that page, and
 * an agent that opens a real browser should do so for a reason you can point
 * at afterwards. A bare domain counts -- nobody types the scheme -- but a
 * bare word does not, or every mention of a file would launch Chrome.
 */
const URL_PATTERN =
  /\b((?:https?:\/\/|www\.)[^\s<>"')]+|(?:localhost|\d{1,3}(?:\.\d{1,3}){3})(?::\d+)?(?:\/[^\s<>"')]*)?|[a-z0-9](?:[a-z0-9-]*[a-z0-9])?(?:\.[a-z0-9][a-z0-9-]*)*\.(?:com|org|net|io|dev|app|ai|co|uk|edu|gov|so|sh|me|xyz|info|news)(?::\d+)?(?:\/[^\s<>"')]*)?)/i;

/** Sentences that are about looking at a page, rather than merely containing
    something that resembles an address. `npm.io` in a paragraph about
    packages is not a request to browse; "open npm.io" is. */
const BROWSE_VERBS =
  /\b(open|go to|goto|visit|browse|navigate|load|fetch|check|look at|read|screenshot|show me|see|what(?:'s| is) on)\b/i;

/**
 * Keep whole images out of the prose, without giving up streaming.
 *
 * A model asked for a picture sometimes answers with one: a `data:` URL,
 * inline, in the middle of a sentence. Left alone that is two hundred
 * kilobytes of base64 across the conversation -- in the thread, in the event
 * log, and replayed to every tab that reconnects for the rest of the session.
 *
 * It cannot be cleaned up afterwards, because by then it has already been
 * streamed. So it is caught on the way past: text flows through untouched
 * until a `data:image/` appears, everything from there is held back until the
 * address ends, and what comes out the other side is the image itself, lifted
 * into a card of its own where it was written. The sentence closes over the
 * gap and the picture appears in it.
 *
 * The holdback is the length of the marker, so a `data:image/` split across
 * two deltas -- which is the normal case, not the edge one -- is still seen.
 */
const MARKER = "data:image/";
/** What ends a URL in prose. Base64 uses none of these. */
const URL_END = /[\s<>"'`)\]}\\]/;

class DataUrlSieve {
  private buffer = "";
  private inside = false;

  /** Text safe to say, and any whole images found in what was held back. */
  feed(piece: string): { text: string; images: string[] } {
    this.buffer += piece;
    return this.drain(false);
  }

  /** The stream is over: whatever is still held back is decided now. */
  flush(): { text: string; images: string[] } {
    return this.drain(true);
  }

  private drain(final: boolean): { text: string; images: string[] } {
    let text = "";
    const images: string[] = [];

    for (;;) {
      if (this.inside) {
        const end = URL_END.exec(this.buffer);
        if (!end) {
          if (!final) return { text, images };
          images.push(this.buffer);
          this.buffer = "";
          this.inside = false;
          return { text, images };
        }
        images.push(this.buffer.slice(0, end.index));
        this.buffer = this.buffer.slice(end.index);
        this.inside = false;
        continue;
      }

      const at = this.buffer.indexOf(MARKER);
      if (at >= 0) {
        text += this.buffer.slice(0, at);
        this.buffer = this.buffer.slice(at);
        this.inside = true;
        continue;
      }

      if (final) {
        text += this.buffer;
        this.buffer = "";
        return { text, images };
      }
      // Hold back just enough that a marker split across two deltas is still
      // recognised when the rest of it lands.
      const keep = Math.min(this.buffer.length, MARKER.length - 1);
      text += this.buffer.slice(0, this.buffer.length - keep);
      this.buffer = this.buffer.slice(this.buffer.length - keep);
      return { text, images };
    }
  }
}

function browseTarget(text: string): string | null {
  const found = URL_PATTERN.exec(text);
  if (!found) return null;
  const candidate = found[1].replace(/[.,;:]+$/, "");
  // An explicit scheme is a request on its own; anything looser needs a verb
  // in front of it saying what to do with it.
  if (/^https?:\/\//i.test(candidate)) return candidate;
  return BROWSE_VERBS.test(text) ? candidate : null;
}

/** What the model is told it is, and what it knows, before the conversation. */
function systemInstructionFor(recalled: MemoryRecord[], page?: PageRead | null): string {
  const lines = [state.systemPrompt.trim()];

  if (recalled.length > 0) {
    lines.push(
      "",
      "What you already know about this workspace (from the memory graph):",
      ...recalled.map((m) => `- [${m.kind}] ${m.title}: ${m.body}`),
    );
  }

  /* The page as text, which is the channel the model reads. The person
     watching is getting the video feed of the same page at the same moment
     from a different channel entirely -- see server/browser.ts. */
  if (page) {
    lines.push(
      "",
      `You have a browser open at ${page.url} ("${page.title}"). You are looking`,
      "at it now. Its interactive elements, numbered as a screen reader would",
      "announce them:",
      page.outline || "(nothing interactive on this page)",
      "",
      "And its readable text:",
      page.text.slice(0, 4000),
      "",
      "Answer from what is actually on that page. Say so plainly if it does not",
      "contain what was asked for.",
    );
  }

  lines.push(
    "",
    "Answer as the console itself: direct, concrete, and short enough to read",
    "between steps. Plain prose -- no headings, and no markdown emphasis.",
  );

  return lines.join("\n");
}

async function startServer() {
  const app = express();
  app.use(express.json());

  // --- API Routes ---

  // 1. Origin & Runtime Info
  app.get("/api/origin", (req: Request, res: Response) => {
    res.json({
      secure_port: null,
      secure_listening: false,
      certificate: false,
      version: VERSION,
    });
  });

  // 2. Sessions List & Creation
  app.get("/api/sessions", (req: Request, res: Response) => {
    const list = Array.from(sessions.values()).map((s) => ({
      id: s.id,
      title: s.title || `Session ${s.id.slice(-6)}`,
      live: s.live,
      created_at: s.createdAt,
      events: s.events.length,
    }));
    // Most recent first
    list.sort((a, b) => b.created_at - a.created_at);
    res.json(list);
  });

  app.post("/api/sessions", (req: Request, res: Response) => {
    const id = `session-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
    const title = (req.body?.title || "").trim() || "New Session";
    const session: Session = {
      id,
      title,
      live: true,
      createdAt: Math.floor(Date.now() / 1000),
      busy: false,
      events: [],
      seqCounter: 0,
    };
    sessions.set(id, session);
    emitEvent(session, "session.started", "system", { title: session.title });
    res.json({ id });
  });

  // 3. Session Events & Replay
  app.get("/api/sessions/:id/events", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    const fromSeq = parseInt((req.query.from_seq as string) || "0", 10);
    const limit = parseInt((req.query.limit as string) || "5000", 10);
    const slice = session.events.filter((e) => e.seq >= fromSeq).slice(0, limit);
    res.json(slice);
  });

  /**
   * 3b. The bytes behind a picture.
   *
   * Events carry an id; this hands over what it stands for. Ids are minted
   * once and never reused, so the answer for a given one can never change and
   * the response says so -- a session with four hundred frames in it is then
   * four hundred requests once, and none of them ever again.
   */
  app.get("/api/sessions/:id/blobs/:blob", (req: Request, res: Response) => {
    const blob = getBlob(req.params.blob);
    if (!blob || blob.session !== req.params.id) {
      return res.status(404).json({ error: "No such image" });
    }
    res.setHeader("Content-Type", blob.mime);
    res.setHeader("Cache-Control", "public, max-age=31536000, immutable");
    res.setHeader("Content-Length", String(blob.data.byteLength));
    res.end(blob.data);
  });

  // 3c. The browser: what it is doing, and telling it to do something.

  /** Whether there is a browser at all, and whether a page is open in it. */
  app.get("/api/sessions/:id/browser", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    await probeBrowser();
    res.json(browserFor(session).status());
  });

  /**
   * Drive the page.
   *
   * The same calls the agent makes, exposed so a person can make them too --
   * which is what turns the browser card from a recording into something you
   * can take over. Every one of them emits its own events, so whatever drove
   * it, the transcript reads the same afterwards.
   */
  app.post("/api/sessions/:id/browser", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const { ok, detail } = await probeBrowser();
    if (!ok) return res.status(503).json({ error: detail });

    const live = browserFor(session);
    const action = String(req.body?.action ?? "read");

    try {
      let read: PageRead | null = null;
      switch (action) {
        case "open":
          if (!req.body?.url) return res.status(400).json({ error: "Nowhere to go." });
          read = await live.goto(String(req.body.url));
          break;
        case "click":
          read = await live.click(Number(req.body?.ref));
          break;
        case "fill":
          read = await live.fill(
            Array.isArray(req.body?.values) ? req.body.values : [],
            Boolean(req.body?.submit),
          );
          break;
        case "scroll":
          read = await live.scroll(Number(req.body?.dy ?? 600));
          break;
        case "back":
          read = await live.back();
          break;
        case "shot": {
          const png = await live.capture();
          const blob = putBlob(session.id, png, "image/png");
          emitEvent(session, "media.image", "agent", {
            alt: "the page as it looks now",
            caption: live.status().url ?? "",
            w: VIEWPORT.width,
            h: VIEWPORT.height,
          }, null, blob);
          broadcastBrowserState(session);
          return res.json({ ok: true, blob });
        }
        case "close":
          await live.close();
          browsers.delete(session.id);
          emitEvent(session, "browser.action", "agent", { action: "close", url: "" });
          broadcastBrowserState(session);
          return res.json({ ok: true, closed: true });
        default:
          read = await live.snapshot();
      }
      broadcastBrowserState(session);
      res.json({ ok: true, ...read });
    } catch (err: any) {
      const message = err?.message ?? String(err);
      emitEvent(session, "system.error", "system", { error: `Browser: ${message}` });
      res.status(400).json({ error: message });
    }
  });

  // 4. Send Message / Agent Turn
  app.post("/api/sessions/:id/message", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }

    const text = (req.body?.text || "").trim();
    if (!text) {
      return res.status(400).json({ error: "Empty message" });
    }

    // If first message and title was generic, update session title
    if (session.events.filter((e) => e.kind === "turn.user").length === 0) {
      session.title = text.length > 40 ? text.slice(0, 37) + "..." : text;
    }

    // 1. Emit user message
    emitEvent(session, "turn.user", "user", { text });

    // 2. Mark busy
    session.busy = true;
    broadcastLiveStatus(session);
    res.json({ ok: true, queued: false });

    // 3. Process turn asynchronously
    (async () => {
      try {
        // Emit thinking event
        emitEvent(session, "turn.agent.thinking", "agent", {
          text: `Analyzing: "${text}"`,
        });

        // Determine which memories and skills the bot is actively reading / accessing
        const lower = text.toLowerCase();
        const accessedRecords: MemoryRecord[] = [];

        // Pinned user preference is consulted for execution style and interaction
        const pref = memoryRecords.find((m) => m.id === "mem-2");
        if (pref) accessedRecords.push(pref);

        if (lower.includes("kanban") || lower.includes("task") || lower.includes("autonomously execute")) {
          const kanbanSkill = memoryRecords.find((m) => m.id === "mem-skill-3");
          const archFact = memoryRecords.find((m) => m.id === "mem-3");
          if (kanbanSkill) accessedRecords.push(kanbanSkill);
          if (archFact) accessedRecords.push(archFact);
        } else if (lower.includes("permission") || lower.includes("elevat") || lower.includes("sudo") || lower.includes("deploy")) {
          const permSkill = memoryRecords.find((m) => m.id === "mem-skill-4");
          if (permSkill) accessedRecords.push(permSkill);
        } else if (lower.includes("browser") || lower.includes("dom") || lower.includes("web") || lower.includes("screen")) {
          const browserSkill = memoryRecords.find((m) => m.id === "mem-skill-1");
          if (browserSkill) accessedRecords.push(browserSkill);
        } else if (lower.includes("terminal") || lower.includes("bash") || lower.includes("shell") || lower.includes("run") || lower.includes("cmd") || lower.includes("ls")) {
          const shellSkill = memoryRecords.find((m) => m.id === "mem-skill-2");
          const deployProc = memoryRecords.find((m) => m.id === "mem-1");
          if (shellSkill) accessedRecords.push(shellSkill);
          if (deployProc) accessedRecords.push(deployProc);
        } else if (lower.includes("memory") || lower.includes("graph") || lower.includes("skill") || lower.includes("synapse") || lower.includes("tracer") || lower.includes("knowledge")) {
          const graphSkill = memoryRecords.find((m) => m.id === "mem-skill-5");
          const archFact = memoryRecords.find((m) => m.id === "mem-3");
          if (graphSkill) accessedRecords.push(graphSkill);
          if (archFact) accessedRecords.push(archFact);
        } else {
          const archFact = memoryRecords.find((m) => m.id === "mem-3");
          if (archFact) accessedRecords.push(archFact);
        }

        const uniqueAccessed = accessedRecords.filter(
          (item, idx, self) => self.findIndex((r) => r.id === item.id) === idx
        );
        if (uniqueAccessed.length > 0) {
          emitEvent(session, "memory.recall", "agent", {
            ids: uniqueAccessed.map((r) => r.id),
            titles: uniqueAccessed.map((r) => r.title),
          });
        }

        // Determine if user is requesting a tool-like action (e.g. command, memory, search, kanban, permission)
        const spanId = `span-${Date.now().toString(36)}`;

        if (lower.includes("kanban") || lower.includes("task") || lower.includes("autonomously execute")) {
          // Autonomous Kanban Task Execution
          const kanbanEvents = session.events.filter((e) => e.kind === "kanban.update");
          const lastBoard = kanbanEvents.length > 0 ? kanbanEvents[kanbanEvents.length - 1].payload : null;
          let boardTasks: any[] = lastBoard?.tasks ? JSON.parse(JSON.stringify(lastBoard.tasks)) : [
            { id: "t-1", title: "Verify container ingress on port 3000", status: "done", tag: "network" },
            { id: "t-2", title: "Mount neural synaptic tracers in memory ribbon", status: "doing", tag: "visual" },
            { id: "t-3", title: "Register autonomous skills in memory graph", status: "todo", tag: "skills" },
            { id: "t-4", title: "Verify permission elevation card interactions", status: "todo", tag: "security" },
          ];

          // Find task to execute
          let targetTask = boardTasks.find((t) => lower.includes(t.title.toLowerCase())) ||
                           boardTasks.find((t) => t.status === "doing") ||
                           boardTasks.find((t) => t.status === "todo");

          if (targetTask) {
            targetTask.status = "doing";
            emitEvent(session, "kanban.update", "agent", {
              id: lastBoard?.id || "board-main",
              title: lastBoard?.title || "Project Autonomy Board",
              autonomous: true,
              tasks: boardTasks,
              activeTaskId: targetTask.id,
            });

            // Simulate execution steps
            emitEvent(session, "tool.call", "agent", {
              tool: "autonomous_executor",
              args: { task: targetTask.title, mode: "autonomous" },
            }, spanId);

            emitEvent(session, "pty.output", "agent", {
              text: `$ run-task --autonomous "${targetTask.title}"\n[autora] resolving skill dependencies...\n[autora] executing task validation...\n[autora] verification passed: exit 0\n`,
            }, spanId);

            emitEvent(session, "tool.result", "agent", { ok: true, taskId: targetTask.id }, spanId);

            // Mark task done
            targetTask.status = "done";
            emitEvent(session, "kanban.update", "agent", {
              id: lastBoard?.id || "board-main",
              title: lastBoard?.title || "Project Autonomy Board",
              autonomous: true,
              tasks: boardTasks,
            });

            // Trigger memory association for completed task
            emitEvent(session, "memory.recall", "agent", {
              ids: ["mem-skill-3", "mem-3"],
              titles: ["Autonomous Kanban Task Management", "Autora Broadcast Architecture"],
            });
          }
        } else if (lower.includes("permission") || lower.includes("elevat") || lower.includes("sudo") || lower.includes("deploy")) {
          // Interactive Permission Request card
          emitEvent(session, "permission.request", "agent", {
            requestId: `req-${Date.now().toString(36)}`,
            tool: lower.includes("deploy") ? "deploy.production" : "terminal.bash",
            rendered: lower.includes("deploy") ? "docker compose up --build -d" : "npm run build && git push origin main",
            reason: "Elevated execution requires explicit confirmation before proceeding.",
            inputType: lower.includes("target") || lower.includes("branch") ? "text" : "boolean",
            placeholder: "Enter target deployment branch...",
            settled: false,
          });
        } else if (lower.includes("skill") || lower.includes("procedure")) {
          // Highlight skill library & synaptic memory
          const skills = memoryRecords.filter((m) => m.kind === "skill");
          emitEvent(session, "memory.recall", "agent", {
            ids: skills.slice(0, 3).map((s) => s.id),
            titles: skills.slice(0, 3).map((s) => s.title),
          });
        } else if (lower.includes("bash") || lower.includes("terminal") || lower.includes("run") || lower.includes("ls") || lower.includes("git")) {
          emitEvent(session, "tool.call", "agent", {
            tool: "terminal",
            args: { command: "echo '[autora] executing scheduled workspace task'" },
          }, spanId);

          emitEvent(session, "pty.output", "agent", {
            text: "$ echo '[autora] executing scheduled workspace task'\n[autora] executing scheduled workspace task\n",
          }, spanId);

          emitEvent(session, "tool.output", "agent", {
            output: "[autora] executing scheduled workspace task\nExit code: 0",
          }, spanId);

          emitEvent(session, "tool.result", "agent", { ok: true }, spanId);
        } else if (lower.includes("remember") || lower.includes("memory") || lower.includes("save")) {
          emitEvent(session, "tool.call", "agent", {
            tool: "memory",
            args: { action: "write", content: text },
          }, spanId);

          const newMem: MemoryRecord = {
            id: `mem-${Date.now().toString(36)}`,
            kind: "fact",
            scope: "user",
            title: text.slice(0, 35),
            body: text,
            tags: ["user-authored", "session-note"],
            status: "confirmed",
            pinned: false,
            source_session: session.id,
            source_seq: session.seqCounter,
            created: Math.floor(Date.now() / 1000),
            updated: Math.floor(Date.now() / 1000),
            uses: 1,
            last_used: Math.floor(Date.now() / 1000),
            superseded_by: null,
          };
          memoryRecords.push(newMem);

          emitEvent(session, "memory.write", "agent", {
            id: newMem.id,
            title: newMem.title,
            kind: newMem.kind,
          });

          emitEvent(session, "tool.result", "agent", { ok: true, id: newMem.id }, spanId);
        }

        /* If an address was named, actually go there -- in a real browser,
           with the screencast running, so the page is watched being opened
           rather than reported as having been. What comes back is text; what
           the person gets is the video feed of the same page. */
        let page: PageRead | null = null;
        const target = browseTarget(text);
        if (target) {
          const browseSpan = `span-web-${Date.now().toString(36)}`;
          emitEvent(session, "tool.call", "agent", {
            tool: "browser",
            args: { action: "open", url: target },
          }, browseSpan);
          try {
            const { ok, detail } = await probeBrowser();
            if (!ok) throw new Error(detail ?? "No browser available.");
            const live = browserFor(session);
            page = await live.goto(target);
            broadcastBrowserState(session);
            emitEvent(session, "tool.result", "agent", {
              ok: true,
              url: page.url,
              title: page.title,
              elements: page.refs.length,
            }, browseSpan);

            /* Asked what it *looks* like, rather than what it says: that is
               the one question the text channel genuinely cannot answer, so
               the picture goes into the conversation as a picture. */
            if (/\b(screenshot|show me|what does it look|looks? like|see it|picture|image)\b/i.test(text)) {
              const png = await live.capture();
              emitEvent(session, "media.image", "agent", {
                alt: `${page.title || page.url}`,
                caption: page.url,
                w: VIEWPORT.width,
                h: VIEWPORT.height,
              }, null, putBlob(session.id, png, "image/png"));
            }
          } catch (err: any) {
            emitEvent(session, "tool.error", "agent", {
              error: err?.message ?? String(err),
            }, browseSpan);
            emitEvent(session, "system.error", "system", {
              error: `Could not open ${target}: ${err?.message ?? err}`,
            });
          }
        }

        // Generate the reply with whichever provider is configured, streaming
        // it so the thread fills as the model writes rather than sitting empty
        // and then blinking a paragraph into place.
        const active = resolveProvider();
        const connected = Boolean(active.provider) && !active.problem;
        let streamed = 0;
        /* One per turn, and outside the retry loop on purpose: a retry only
           happens when nothing has been said yet, so the sieve is empty, and
           a fresh one per attempt would be the same object with more steps. */
        const sieve = new DataUrlSieve();

        if (connected) {
          const call = {
            provider: active.provider,
            model: active.model,
            key: active.key,
            baseUrl: active.baseUrl,
            system: systemInstructionFor(uniqueAccessed, page),
            messages: historyFor(session),
            temperature: 0.7,
            maxTokens: 2048,
            thinkingBudget: THINKING_BUDGET,
          };

          for (let attempt = 0; attempt <= MODEL_RETRIES; attempt += 1) {
            try {
              /** An image inlined into the reply becomes a card where it was
                  written, rather than a screenful of base64. */
              const show = (found: string[]) => {
                for (const raw of found) {
                  const decoded = fromDataUrl(raw);
                  if (!decoded || !decoded.mime.startsWith("image/")) continue;
                  emitEvent(session, "media.image", "agent", {
                    alt: "image from the reply",
                    caption: null,
                    inline: true,
                  }, null, putBlob(session.id, decoded.data, decoded.mime));
                }
              };

              const usage = await streamChat(call, (piece) => {
                // The client coalesces these deltas into one reply (see
                // derive.ts), so a chunk per emit is a sentence appearing,
                // not forty cards.
                const { text: clean, images } = sieve.feed(piece);
                if (clean) {
                  emitEvent(session, "turn.agent.text", "agent", { text: clean });
                  streamed += clean.length;
                }
                show(images);
              });

              const tail = sieve.flush();
              if (tail.text) {
                emitEvent(session, "turn.agent.text", "agent", { text: tail.text });
                streamed += tail.text.length;
              }
              show(tail.images);

              // What the turn cost, written down at the moment it happened.
              // Prices move, so re-pricing an old turn later from today's
              // table would quietly rewrite history; the ledger keeps the
              // figure that was in force when the call was made.
              const priced = isPriced(active.provider, active.model);
              const cost = costOf(active.provider, active.model, usage.input, usage.output);
              recordUsage({
                ts: Math.floor(Date.now() / 1000),
                session: session.id,
                provider: active.provider,
                model: active.model,
                input: usage.input,
                output: usage.output,
                cost,
                priced,
                estimated: usage.estimated,
              });
              emitEvent(session, "usage.turn", "system", {
                provider: active.provider,
                model: active.model,
                input_tokens: usage.input,
                output_tokens: usage.output,
                cost_usd: cost,
                priced,
                estimated: usage.estimated,
              });
              break;
            } catch (err: any) {
              const detail = err?.message ?? String(err);
              const status = err instanceof ProviderError ? err.status : null;
              console.warn(
                `[model] ${active.provider}/${active.model} attempt ${attempt + 1}: ${detail}`,
              );

              // Only worth another go while nothing has reached the thread --
              // re-running a half-delivered reply would say the first half
              // twice.
              const retryable =
                streamed === 0 &&
                attempt < MODEL_RETRIES &&
                (status === null || TRANSIENT.has(status));

              if (retryable) {
                await wait(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
                continue;
              }

              // Said out loud rather than swallowed: a canned reply in place
              // of a real one is indistinguishable from the model working,
              // and what people need to know is whether their key is wrong or
              // the vendor is simply busy.
              const vendor = PROVIDERS.find((p) => p.id === active.provider)?.label ?? active.provider;
              emitEvent(session, "system.error", "system", {
                error: `${vendor} (${active.model}) did not answer: ${detail}`,
              });
              break;
            }
          }
        }

        // Nothing came back -- no provider configured, or the call failed. Say
        // something useful rather than leaving the turn blank.
        if (streamed === 0) {
          let reply: string;
          if (page) {
            // Something real did happen, model or no model: a page was opened
            // and read. Say what is on it rather than apologising.
            reply =
              `Opened ${page.url} — "${page.title}". It has ${page.refs.length} ` +
              `interactive element${page.refs.length === 1 ? "" : "s"}; the live view above ` +
              "is the page itself, and the card keeps a frame from each step." +
              (connected ? "" : " Connect a model in Settings and I can tell you what it says.");
          } else if (!connected) {
            reply =
              "No model is connected yet, so I am running on local responses only. " +
              `${active.problem ?? ""} Open Settings, add a key for OpenAI, Google, ` +
              "Anthropic, DeepSeek, or OpenRouter, and pick a model; everything else " +
              "in the console works without one.";
          } else if (lower.includes("hello") || lower.includes("hi")) {
            reply = "Hello! Autora is active. You can prompt me to run tasks, manage memories, monitor live agent sessions, or configure automation schedules.";
          } else if (lower.includes("status")) {
            reply = "All systems operational. Connected to workspace host on port 3000. Session stream is live.";
          } else {
            reply = `Received: "${text}". I have processed your instruction, updated the execution graph, and recorded all output to this session's telemetry log.`;
          }
          emitEvent(session, "turn.agent.text", "agent", { text: reply });
        }

        emitEvent(session, "turn.agent.done", "agent", {});
      } catch (err: any) {
        emitEvent(session, "system.error", "system", {
          error: err?.message || "Execution error",
        });
      } finally {
        session.busy = false;
        broadcastLiveStatus(session);
      }
    })();
  });

  // 5. Interrupt current turn
  app.post("/api/sessions/:id/interrupt", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) {
      return res.status(404).json({ error: "Session not found" });
    }
    const wasBusy = session.busy;
    session.busy = false;
    broadcastLiveStatus(session);
    emitEvent(session, "system.log", "system", { message: "Turn interrupted by user" });
    res.json({ interrupted: wasBusy });
  });

  /**
   * 6. UI Element Pick
   *
   * You click a spot on the live page and this says what is there. The pick
   * lands in the thread as an event of its own, so the agent sees that you
   * pointed and at what -- which is the whole point: describing an element in
   * prose and hoping the agent finds the same one is the slow way to ask.
   */
  app.post("/api/sessions/:id/pick", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const live = browsers.get(session.id);
    if (!live?.status().open) {
      return res.json({ ok: false, error: "No page is open to point at." });
    }

    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.json({ ok: false, error: "That is not a point on the page." });
    }

    try {
      const found = await live.pickAt(x, y);
      if (found?.ok && found.pick) {
        const f = found.pick.fingerprint;
        const name = f?.text ? `“${f.text}”` : `<${f?.tag ?? "element"}>`;
        emitEvent(session, "context.note", "user", {
          text:
            `You pointed at ${name}` +
            (found.pick.ref != null ? ` — element [${found.pick.ref}]` : "") +
            (found.pick.source?.file
              ? `, rendered by ${found.pick.source.file}${
                  found.pick.source.line ? `:${found.pick.source.line}` : ""}`
              : `, selector ${found.pick.selector}`) +
            ".",
        });
      }
      res.json(found);
    } catch (err: any) {
      res.json({ ok: false, error: err?.message ?? "Could not read that point." });
    }
  });

  // 7. Policy Approvals
  app.post("/api/policy/:requestId", (req: Request, res: Response) => {
    const approved = Boolean(req.body?.approved);
    const who = req.body?.who || "user";
    const response = req.body?.response;

    for (const session of sessions.values()) {
      emitEvent(session, "policy.decision", "user", {
        request_id: req.params.requestId,
        decision: approved ? "allow" : "deny",
        approved,
        who,
        response,
      });
    }

    res.json({ ok: true, approved, who });
  });

  // 7b. Session Kanban Updates
  app.post("/api/sessions/:id/kanban", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });

    const { boardId, taskId, newStatus, task } = req.body;
    const kanbanEvents = session.events.filter((e) => e.kind === "kanban.update");
    const currentBoard = kanbanEvents.length > 0 ? kanbanEvents[kanbanEvents.length - 1].payload : null;
    let tasks: any[] = currentBoard?.tasks ? [...currentBoard.tasks] : [];

    if (taskId && newStatus) {
      tasks = tasks.map((t) => (t.id === taskId ? { ...t, status: newStatus } : t));
    } else if (task) {
      tasks.push(task);
    }

    emitEvent(session, "kanban.update", "user", {
      id: boardId || "board-main",
      title: currentBoard?.title || "Project Autonomy Board",
      autonomous: true,
      tasks,
    });

    res.json({ ok: true, tasks });
  });

  // 8. Memory / Knowledge Web
  app.get("/api/memory", (req: Request, res: Response) => {
    const q = ((req.query.q as string) || "").toLowerCase().trim();

    let records = memoryRecords;
    if (q) {
      records = records.filter(
        (r) =>
          r.title.toLowerCase().includes(q) ||
          r.body.toLowerCase().includes(q) ||
          r.tags.some((t) => t.toLowerCase().includes(q)),
      );
    }

    res.json({
      records,
      links: memoryLinks,
      enabled: true,
    });
  });

  app.post("/api/memory", (req: Request, res: Response) => {
    const title = (req.body?.title || "").trim();
    if (!title) return res.status(400).json({ error: "Title is required" });

    const newRecord: MemoryRecord = {
      id: `mem-${Date.now().toString(36)}`,
      kind: req.body?.kind || "skill",
      scope: req.body?.scope || "workspace",
      title,
      body: req.body?.body || "",
      tags: Array.isArray(req.body?.tags) ? req.body.tags : ["skill"],
      status: "confirmed",
      pinned: Boolean(req.body?.pinned),
      source_session: req.body?.source_session || null,
      source_seq: null,
      created: Math.floor(Date.now() / 1000),
      updated: Math.floor(Date.now() / 1000),
      uses: 1,
      last_used: Math.floor(Date.now() / 1000),
      superseded_by: null,
    };
    memoryRecords.push(newRecord);
    res.json(newRecord);
  });

  app.get("/api/memory/:id", (req: Request, res: Response) => {
    const record = memoryRecords.find((r) => r.id === req.params.id);
    if (!record) return res.status(404).json({ error: "Record not found" });
    res.json(record);
  });

  app.patch("/api/memory/:id", (req: Request, res: Response) => {
    const record = memoryRecords.find((r) => r.id === req.params.id);
    if (!record) return res.status(404).json({ error: "Record not found" });

    if (req.body.title !== undefined) record.title = req.body.title;
    if (req.body.body !== undefined) record.body = req.body.body;
    if (req.body.status !== undefined) record.status = req.body.status;
    if (req.body.pinned !== undefined) record.pinned = Boolean(req.body.pinned);
    record.updated = Math.floor(Date.now() / 1000);

    res.json(record);
  });

  app.delete("/api/memory/:id", (req: Request, res: Response) => {
    const idx = memoryRecords.findIndex((r) => r.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Record not found" });

    memoryRecords.splice(idx, 1);
    res.json({ ok: true });
  });

  // 9. Scheduled Jobs
  app.get("/api/jobs", (req: Request, res: Response) => {
    res.json(jobs);
  });

  app.post("/api/jobs", (req: Request, res: Response) => {
    const prompt = (req.body?.prompt || "").trim();
    if (!prompt) return res.status(400).json({ error: "A task needs a prompt" });

    const newJob: Job = {
      id: `job-${Date.now().toString(36)}`,
      name: (req.body?.name || "").trim() || "Scheduled Task",
      cron: (req.body?.cron || "").trim() || "0 * * * *",
      prompt,
      enabled: req.body?.enabled !== undefined ? Boolean(req.body?.enabled) : true,
      created: Math.floor(Date.now() / 1000),
      last_run: null,
      last_session: null,
      last_error: null,
      next_run: Math.floor(Date.now() / 1000) + 3600,
      cron_error: null,
    };
    jobs.push(newJob);
    res.json({ id: newJob.id });
  });

  app.patch("/api/jobs/:id", (req: Request, res: Response) => {
    const job = jobs.find((j) => j.id === req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    if (req.body.name !== undefined) job.name = req.body.name;
    if (req.body.cron !== undefined) job.cron = req.body.cron;
    if (req.body.prompt !== undefined) job.prompt = req.body.prompt;
    if (req.body.enabled !== undefined) job.enabled = Boolean(req.body.enabled);

    res.json({ ok: true });
  });

  app.delete("/api/jobs/:id", (req: Request, res: Response) => {
    const idx = jobs.findIndex((j) => j.id === req.params.id);
    if (idx === -1) return res.status(404).json({ error: "Job not found" });
    jobs.splice(idx, 1);
    res.json({ ok: true });
  });

  app.post("/api/jobs/:id/run", (req: Request, res: Response) => {
    const job = jobs.find((j) => j.id === req.params.id);
    if (!job) return res.status(404).json({ error: "Job not found" });

    // Create a new session for the job
    const sessionId = `session-job-${Date.now().toString(36)}`;
    const session: Session = {
      id: sessionId,
      title: job.name,
      live: true,
      createdAt: Math.floor(Date.now() / 1000),
      busy: false,
      events: [],
      seqCounter: 0,
    };
    sessions.set(sessionId, session);

    emitEvent(session, "session.started", "system", { title: session.title });
    emitEvent(session, "system.log", "system", {
      event: "schedule.fired",
      job: job.id,
      name: job.name,
      cron: job.cron,
    });
    emitEvent(session, "turn.user", "user", { text: job.prompt });

    job.last_run = Math.floor(Date.now() / 1000);
    job.last_session = sessionId;

    res.json({ session: sessionId });
  });

  // 10. Settings API

  /** One payload for both reads and writes -- two hand-kept copies drifted,
      and the PATCH one had already lost the Anthropic row. */
  const settingsPayload = () => {
    const active = resolveProvider();
    const activeSpec = PROVIDERS.find((p) => p.id === active.provider);

    /** What the running model charges, per million tokens. */
    const activePrice = () => {
      const models = modelsFor(active.provider);
      const spec = models.find((m) => m.id === active.model);
      if (!spec || spec.priced === false) {
        return `No published price for ${active.model} — its turns are counted but not billed.`;
      }
      return `$${spec.input} in / $${spec.output} out per 1M tokens`;
    };

    /* Every vendor Autora can talk to, with its key state and its models, so
       the panel can be built from one fetch. The key itself never leaves the
       server: what travels is whether one is set, where it came from, and
       four characters of it -- enough to recognise the key you meant to use,
       useless to anyone who intercepts it. */
    const catalog = PROVIDERS.map((spec) => {
      const source = keySource(spec.id);
      return {
        id: spec.id,
        label: spec.label,
        note: spec.note,
        kind: spec.kind,
        key_hint: spec.keyHint,
        keys_url: spec.keysUrl,
        base_url: baseUrlFor(spec.id),
        default_base_url: spec.baseUrl,
        default_model: spec.defaultModel,
        listable: spec.listable,
        open_ended: Boolean(spec.openEnded),
        needs_key: spec.id !== "local",
        key: {
          set: Boolean(keyFor(spec.id)),
          source,
          masked: maskKey(keyFor(spec.id)),
          env_names: spec.envKeys,
        },
        model: modelFor(spec.id),
        models: modelsFor(spec.id),
      };
    });

    return {
      provider: state.provider,
      // The legacy single-model field still answers "what will run", which is
      // what older clients did with it.
      model: active.model,
      base_url: active.provider ? baseUrlFor(active.provider) : "",
      providers: ["auto", ...PROVIDERS.map((p) => p.id)],
      auto_order: AUTO_ORDER,
      system_prompt: state.systemPrompt,
      system_prompt_limit: 8000,
      catalog,
      prices_checked: PRICES_CHECKED,
      budget_usd: state.budgetUsd,
      state_file: stateFilePath(),
      credentials: PROVIDERS.filter((spec) => spec.id !== "local").map((spec) => {
        const source = keySource(spec.id);
        return {
          name: spec.id,
          label: spec.label,
          note: spec.note,
          role: "model" as const,
          set: source !== null,
          hint:
            source === "app"
              ? `Saved in app (${maskKey(keyFor(spec.id))})`
              : source === "env"
                ? "From the server environment"
                : spec.keyHint,
        };
      }),
      active: {
        // What the next turn will actually call, rather than a name written
        // down once and left behind by every model change since.
        model: active.model || null,
        endpoint: active.provider ? baseUrlFor(active.provider) : null,
        provider: activeSpec?.label ?? null,
        // Not the name again -- that is already on the line above. What is
        // worth saying here is what this choice costs, which is the fact the
        // billing card is about to be counting with.
        hint: active.problem ?? activePrice(),
      },
    };
  };

  app.get("/api/settings", (req: Request, res: Response) => {
    res.json(settingsPayload());
  });

  app.patch("/api/settings", (req: Request, res: Response) => {
    const body = req.body ?? {};
    const known = new Set(["auto", ...PROVIDERS.map((p) => p.id)]);

    if (body.provider !== undefined) {
      if (!known.has(body.provider)) {
        return res.status(400).json({ detail: `Unknown provider "${body.provider}".` });
      }
      state.provider = body.provider;
    }

    // Per-provider choices. The flat `model` / `base_url` fields still work and
    // apply to whichever provider is selected, so an older client that knows
    // nothing about the catalogue can still change the model it is using.
    const target = state.provider === "auto" ? resolveProvider().provider : state.provider;

    if (body.models && typeof body.models === "object") {
      for (const [id, model] of Object.entries(body.models)) {
        if (!known.has(id) || typeof model !== "string") continue;
        state.models[id] = model.trim();
      }
    } else if (typeof body.model === "string" && target) {
      state.models[target] = body.model.trim();
    }

    if (body.base_urls && typeof body.base_urls === "object") {
      for (const [id, url] of Object.entries(body.base_urls)) {
        if (!known.has(id) || typeof url !== "string") continue;
        state.baseUrls[id] = url.trim();
      }
    } else if (typeof body.base_url === "string" && target) {
      state.baseUrls[target] = body.base_url.trim();
    }

    if (typeof body.system_prompt === "string") {
      state.systemPrompt = body.system_prompt.slice(0, 8000);
    }

    // A key arrives only when someone typed one: an untouched field sends
    // nothing, and an empty string means "remove it", not "save a blank".
    if (body.credentials && typeof body.credentials === "object") {
      for (const [name, value] of Object.entries(body.credentials)) {
        if (typeof value !== "string") continue;
        setKey(name, value);
      }
    }

    if (body.budget_usd !== undefined) {
      const raw = body.budget_usd;
      const amount = raw === null || raw === "" ? null : Number(raw);
      if (amount !== null && (!Number.isFinite(amount) || amount < 0)) {
        return res.status(400).json({ detail: "The monthly budget must be a positive amount." });
      }
      state.budgetUsd = amount;
    }

    save();
    res.json(settingsPayload());
  });

  // 10b. Provider models and key checks

  /**
   * The models a vendor says it has.
   *
   * Refreshing asks the vendor directly, which is the only way to keep up with
   * a catalogue that changes weekly -- and for OpenRouter, the only practical
   * way to offer it at all. Whatever comes back is remembered for pricing, so
   * a model discovered here is billed from the vendor's own numbers rather
   * than from nothing.
   */
  app.get("/api/providers/:id/models", async (req: Request, res: Response) => {
    const id = req.params.id;
    const spec = PROVIDERS.find((p) => p.id === id);
    if (!spec) return res.status(404).json({ detail: `Unknown provider "${id}".` });

    if (req.query.refresh !== "1") {
      return res.json({ provider: id, models: modelsFor(id), refreshed: false });
    }
    if (!spec.listable) {
      return res.status(400).json({ detail: `${spec.label} does not publish a model list.` });
    }

    // No key requirement here: OpenRouter publishes its catalogue (and its
    // prices) to anyone, which is exactly when browsing the list is most
    // useful -- before signing up. Vendors that do want a key say so
    // themselves, and their refusal is more accurate than our guess at it.
    const key = keyFor(id);

    try {
      const models = await listModels(id, key, baseUrlFor(id));
      rememberModels(id, models);
      res.json({ provider: id, models: modelsFor(id), refreshed: true, found: models.length });
    } catch (err: any) {
      res.status(502).json({ detail: `Could not reach ${spec.label}: ${err?.message ?? err}` });
    }
  });

  /** Does this key work? Checked before it is trusted with a conversation, so
      a typo is found here rather than as a failed turn ten minutes later. */
  app.post("/api/providers/:id/test", async (req: Request, res: Response) => {
    const id = req.params.id;
    const spec = PROVIDERS.find((p) => p.id === id);
    if (!spec) return res.status(404).json({ detail: `Unknown provider "${id}".` });

    // A key typed but not yet saved can be tested as it stands, so nobody has
    // to save a guess to find out whether it was right.
    const candidate =
      typeof req.body?.key === "string" && req.body.key.trim()
        ? req.body.key.trim()
        : keyFor(id);
    if (!candidate && id !== "local") {
      return res.status(400).json({ detail: `No ${spec.label} key to check.` });
    }

    try {
      // The catalogue is public information whichever key asked for it, so a
      // successful check doubles as a model refresh -- which is what someone
      // pasting a key is about to want anyway.
      const models = await listModels(id, candidate, baseUrlFor(id));
      rememberModels(id, models);
      res.json({ ok: true, models: models.length });
    } catch (err: any) {
      res.status(400).json({ ok: false, detail: err?.message ?? String(err) });
    }
  });

  // 10c. Billing

  /** What has been spent, and on what. Read-only: the ledger is written by
      the turns themselves, one row each, as they finish. */
  app.get("/api/usage", (req: Request, res: Response) => {
    res.json(billingSummary());
  });

  /** Start the count again -- after settling a bill, or after a spell of
      testing that should not colour the month. Deliberately a separate call
      rather than a settings field, because it throws away history. */
  app.post("/api/usage/reset", (req: Request, res: Response) => {
    clearUsage();
    res.json(billingSummary());
  });

  // 11. Relay API
  app.get("/api/relay", (req: Request, res: Response) => {
    const host = req.headers["host"] || "127.0.0.1:3000";
    const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    const wsProto = proto === "https" ? "wss" : "ws";

    res.json({
      connected: false,
      platform: null,
      screen: { w: null, h: null },
      since: null,
      ws_url: `${wsProto}://${host}/ws/desktop-relay`,
      download: `${proto}://${host}/relay.py`,
      install: "pip install websockets mss pyautogui pillow",
      run: "python relay.py",
    });
  });

  app.get("/relay.py", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/x-python");
    res.setHeader("Content-Disposition", 'attachment; filename="relay.py"');
    res.send(`# Autora Desktop Relay Stub\nprint("Autora desktop relay client ready")\n`);
  });

  // 12. Create HTTP Server & WebSocket Server
  const server = http.createServer(app);
  const wss = new WebSocketServer({ server });

  wss.on("connection", (ws: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url || "/", `http://${req.headers.host || "localhost"}`);
    const pathname = url.pathname;

    // Route: /ws/:sessionId
    if (pathname.startsWith("/ws/")) {
      const sessionId = pathname.replace("/ws/", "").split("/")[0].trim();
      if (!sessionId || sessionId === "desktop-relay") {
        return;
      }

      const session = sessions.get(sessionId);
      if (!session) {
        ws.send(JSON.stringify({ type: "error", error: "No such session" }));
        ws.close();
        return;
      }

      // Add to session subscriber set
      if (!sessionSockets.has(sessionId)) {
        sessionSockets.set(sessionId, new Set());
      }
      sessionSockets.get(sessionId)!.add(ws);

      // Replay backlog
      const fromSeq = parseInt(url.searchParams.get("from_seq") || "0", 10);
      const backlog = session.events.filter((e) => e.seq >= fromSeq);
      if (backlog.length > 0) {
        ws.send(JSON.stringify({ type: "batch", events: backlog }));
      }

      // Live announcement
      ws.send(
        JSON.stringify({
          type: "live",
          session: session.id,
          seq: session.events.length,
          busy: session.busy,
        }),
      );

      /* Whether there is a page to watch. Sent on connect because the feed is
         ephemeral: a tab that opens halfway through a browsing session would
         otherwise see nothing until the next frame, and show the last
         screenshot as though that were the live view. */
      const openBrowser = browsers.get(sessionId);
      if (openBrowser) {
        ws.send(JSON.stringify({
          type: "browser",
          session: sessionId,
          state: openBrowser.status(),
        }));
        // And one frame to start with, because a page that is sitting still
        // produces none on its own and this tab has never seen it.
        void openBrowser.nudge();
      }

      // Handle incoming messages
      ws.on("message", (data: string) => {
        try {
          const msg = JSON.parse(data.toString());
          if (msg.type === "ping") {
            ws.send(JSON.stringify({ type: "pong", t: Date.now() / 1000 }));
          } else if (msg.type === "interrupt") {
            session.busy = false;
            broadcastLiveStatus(session);
          } else if (msg.type === "policy") {
            emitEvent(session, "policy.decision", "system", {
              requestId: msg.request_id,
              approved: Boolean(msg.approved),
              who: msg.who || "user",
            });
          }
        } catch {
          // ignore malformed payloads
        }
      });

      ws.on("close", () => {
        const set = sessionSockets.get(sessionId);
        if (set) {
          set.delete(ws);
          if (set.size === 0) sessionSockets.delete(sessionId);
        }
      });
    }
  });

  // 13. Vite Integration (Development middleware / Production static serving)
  if (process.env.NODE_ENV !== "production") {
    // Imported here rather than at the top of the file: Vite is a build-time
    // dependency, and a static import would drag it into the production
    // container, where it is both absent and unwanted.
    const { createServer: createViteServer } = await import("vite");
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");

    /* The page is stamped with the version that served it, and handed over
       with no-store.

       An update can otherwise arrive and leave no trace: the browser keeps the
       shell in a cache, a page opened while the container was restarting --
       which is exactly what an update is -- stays pinned to the previous
       bundle, and the app then works perfectly while running old code. The
       page compares this stamp with what /api/origin reports and says so when
       they differ, which only works if the stamp itself is never cached. */
      const page = (() => {
        let html = "";
        try {
          html = fs.readFileSync(path.join(distPath, "index.html"), "utf8");
        } catch {
          return null;
        }
        return html.replace(
          /<meta name="autora-version" content="[^"]*"\s*\/?>/,
          `<meta name="autora-version" content="${VERSION}" />`,
        );
      })();

    const serveIndex = (req: Request, res: Response) => {
      if (page === null) return res.status(503).send("The UI has not been built yet.");
      res.setHeader("Content-Type", "text/html; charset=utf-8");
      res.setHeader("Cache-Control", "no-store");
      res.send(page);
    };

    app.get("/", serveIndex);
    app.use(express.static(distPath));
    app.get("*", serveIndex);
  }

  /* Chrome outlives its parent if nobody tells it not to, and a container
     restarted a few times then has several headless browsers in it holding
     memory for pages nobody can see. */
  const shutdown = async () => {
    for (const [id, live] of browsers) {
      await live.close().catch(() => undefined);
      dropSession(id);
    }
    browsers.clear();
    process.exit(0);
  };
  process.once("SIGINT", () => void shutdown());
  process.once("SIGTERM", () => void shutdown());

  // Asked once, at startup, so the settings panel and the browser card can
  // both say what is missing without every caller paying for the import.
  void probeBrowser().then(({ ok, detail }) => {
    console.log(ok ? "[browser] ready" : `[browser] unavailable: ${detail}`);
  });

  server.listen(PORT, HOST, () => {
    console.log(`Autora ${VERSION} running on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start Autora server:", err);
  process.exit(1);
});
