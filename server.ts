import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import {
  AUTO_ORDER, PRICES_CHECKED, PROVIDERS, costOf, isPriced, modelsFor,
  providerSpec, rememberModels,
} from "./server/providers";
import {
  baseUrlFor, clearUsage, keyFor, keySource, maskKey, modelFor, recordUsage,
  resolveProvider, save, setKey, state, stateFilePath, type Resolved,
  listSecrets, setSecret, deleteSecret, getSecret, SECRET_PRESETS, redactSecrets,
  mergeJev,
} from "./server/state";
import { decide, lastDecision, supportFor, type JevOutcome, type JevTask } from "./server/jev/router";
import type { JevTarget } from "./server/jev/engine";
import { guardWorthy } from "./server/jev/guard";
import {
  ProviderError, listModels, streamChat,
  type ChatMessage, type ChatTurn, type ToolReply,
} from "./server/llm";
import { billingSummary } from "./server/billing";
import { dropSession, fromDataUrl, getBlob, putBlob } from "./server/blobs";
import { ContextEngine, type CompactionReport } from "./server/context";
import { LiveBrowser, VIEWPORT, probeBrowser, type PageRead } from "./server/browser";
import {
  attachRelay, relayClientSource, relayStatus, watchDesktop,
} from "./server/desktop";
import {
  availableTools, capabilityBriefing, findTool, groupStates, needsApproval,
  renderCall, runTool, toolSettings, updateToolSettings,
  type ToolContext, type ToolGroup, type AskRequest, type AskAnswer,
} from "./server/tools";

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
    body: "Open a page with browser_open, read it as numbered elements with browser_read, then browser_click, browser_fill and browser_scroll. Checkbox CAPTCHAs (reCAPTCHA, hCaptcha, Turnstile) live in iframes outside the outline: tick them with browser_captcha. Every step is screencast to whoever is watching.",
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
    body: "Run a command with the terminal tool: bash -lc on this host, output streamed as it arrives, exit code reported. Pipes rather than a TTY, so interactive programs are not usable.",
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
    body: "Break a multi-step goal into backlog cards on the board. The board is edited from the app; moving a card is not itself an action the agent can take.",
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
    body: "Autora runs in yolo mode: tool calls run straight away with no approval card in the chat. Every command is still shown in the transcript as it runs, and Stop kills it.",
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
  /* No approval card here any more. This session is seeded before anything
     has been asked for, so a card in it was waiting on nothing: clicking it
     released no tool call, because there was none, and the only thing it
     demonstrated was that the prompt could be drawn. Real ones now appear
     where a real call is parked on the answer. */
  add("turn.agent.text", "agent", { local: true, text: "Autora is running. What I can reach — a shell on this host, a browser I drive, and a desktop if you run the relay — is listed under Tools in Settings, and none of it waits for your approval. Type a task and it happens in this thread: every command, page and keystroke shown where it occurred." });
  add("turn.agent.done", "agent", {});

  return session;
}

const defaultSession = createInitialSession();
sessions.set(defaultSession.id, defaultSession);

// Broadcast an event to all connected websockets for a session
function emitEvent(session: Session, kind: string, actor: string, payload: Record<string, any>, span: string | null = null, blob: string | null = null): AutoraEvent {
  session.seqCounter += 1;

  // Sanitize any potential secret leakages from payload fields
  const safePayload: Record<string, any> = {};
  for (const [k, v] of Object.entries(payload || {})) {
    if (typeof v === "string") {
      safePayload[k] = redactSecrets(v);
    } else if (v && typeof v === "object" && !Array.isArray(v)) {
      const subObj: Record<string, any> = {};
      for (const [subK, subV] of Object.entries(v)) {
        subObj[subK] = typeof subV === "string" ? redactSecrets(subV) : subV;
      }
      safePayload[k] = subObj;
    } else {
      safePayload[k] = v;
    }
  }

  const event: AutoraEvent = {
    seq: session.seqCounter,
    ts: Math.floor(Date.now() / 1000),
    kind,
    actor,
    span,
    payload: safePayload,
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

// ------------------------------------------------------ approvals & turns --

/**
 * Turns that are running, and how to stop them.
 *
 * A turn can now take minutes -- a build, a page that will not load, an
 * approval nobody has looked at yet -- so interrupting it has to reach further
 * than a flag. Each running tool registers a way to be killed, and Stop calls
 * all of them.
 */
type RunningTurn = { stopped: boolean; cancels: Set<() => void> };
const running = new Map<string, RunningTurn>();

function stopTurn(sessionId: string) {
  const turn = running.get(sessionId);
  if (!turn) return;
  turn.stopped = true;
  for (const cancel of turn.cancels) {
    try {
      cancel();
    } catch {
      // A kill that fails because the thing already exited is not news.
    }
  }
  turn.cancels.clear();
}

/**
 * Approvals that are actually waiting on an answer.
 *
 * The permission card in the transcript used to be decorative: it was emitted,
 * the reply was broadcast, and nothing anywhere was blocked on it. Now the tool
 * call genuinely stops here until somebody clicks, which is the only reading of
 * that card that is not a lie.
 */
type PendingApproval = {
  sessionId: string;
  settle: (decision: { approved: boolean; response?: string }) => void;
  timer: NodeJS.Timeout;
};
const awaitingApproval = new Map<string, PendingApproval>();

/** Long enough to walk away and come back; short enough that a forgotten
    prompt does not hold a session busy overnight. */
const APPROVAL_TIMEOUT_MS = 15 * 60 * 1000;

function settleApproval(
  requestId: string,
  decision: { approved: boolean; response?: string },
) {
  const pending = awaitingApproval.get(requestId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  awaitingApproval.delete(requestId);
  pending.settle(decision);
  return true;
}

/**
 * Ask the person, and wait.
 *
 * Emits the card into the session it belongs to -- not to every session, which
 * is what the old broadcast did -- and resolves when the answer arrives, when
 * the turn is stopped, or when nobody has answered for a quarter of an hour.
 */
function askPermission(
  session: Session,
  what: { tool: string; rendered: string; reason: string },
): Promise<{ approved: boolean; response?: string }> {
  const requestId = `req-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  emitEvent(session, "permission.request", "agent", {
    request_id: requestId,
    requestId,
    tool: what.tool,
    rendered: what.rendered,
    reason: what.reason,
    inputType: "boolean",
    settled: false,
  });

  return new Promise((resolve) => {
    let done = false;
    const finish = (decision: { approved: boolean; response?: string }) => {
      if (done) return;
      done = true;
      resolve(decision);
    };

    const timer = setTimeout(() => {
      if (!awaitingApproval.delete(requestId)) return;
      emitEvent(session, "policy.decision", "system", {
        request_id: requestId,
        decision: "deny",
        approved: false,
        who: "timeout",
        reason: "Nobody answered within 15 minutes.",
      });
      finish({ approved: false });
    }, APPROVAL_TIMEOUT_MS);
    timer.unref?.();

    awaitingApproval.set(requestId, { sessionId: session.id, settle: finish, timer });

    // Stop should not leave a turn parked on a question nobody is going to
    // answer, so the kill switch settles it too.
    running.get(session.id)?.cancels.add(() => {
      if (awaitingApproval.delete(requestId)) {
        clearTimeout(timer);
        finish({ approved: false });
      }
    });
  });
}

// ---------------------------------------------------------------- jev mode --

/** The model the next turn will call, in the shape Jev scores against, or
    null when nothing usable is connected. */
function jevTarget(): JevTarget | null {
  const active = resolveProvider();
  if (!active.provider || active.problem) return null;
  const spec = providerSpec(active.provider);
  if (!spec) return null;
  return {
    provider: active.provider, kind: spec.kind,
    baseUrl: active.baseUrl, key: active.key, model: active.model,
  };
}

/**
 * Run a decision through Jev, bill it, and say in the thread what happened.
 *
 * Reported only when something was actually tried: a model that cannot score
 * falls back silently every turn, and a note saying so each time is noise.
 */
async function jevDecide(session: Session | null, task: JevTask): Promise<JevOutcome> {
  const target = jevTarget();
  const outcome = await decide(task, target, state.jev);
  const usage = outcome.usage;
  if (target && usage && (usage.input || usage.output)) {
    recordUsage({
      ts: Math.floor(Date.now() / 1000),
      session: session?.id ?? "jev",
      provider: target.provider,
      model: target.model,
      input: usage.input,
      output: usage.output,
      cost: costOf(target.provider, target.model, usage.input, usage.output),
      priced: isPriced(target.provider, target.model),
      estimated: false,
    });
  }
  if (session && (outcome.mode === "jev" || outcome.attempted)) {
    emitEvent(session, "jev.decision", "system", {
      task: task.name,
      mode: outcome.mode,
      ms: outcome.ms,
      threshold: state.jev.threshold,
      min: outcome.mode === "jev" ? outcome.min : null,
      reason: outcome.mode === "fallback" ? outcome.reason : null,
      model: target?.model ?? null,
      cached_tokens: usage?.cached ?? 0,
      fields: (outcome.fields ?? []).map((f) => ({
        name: task.labels?.[f.name] ?? f.name,
        value: f.value, confidence: f.confidence, coverage: f.coverage,
      })),
    });
  }
  return outcome;
}

/**
 * Which memories bear on this request, scored rather than keyword-matched.
 *
 * One yes/no field per memory: independent of each other, two values each --
 * exactly the shape Jev is for. Returns null to mean "fall back to the
 * keyword recall", which is what happens whenever Jev is off, the model
 * cannot score, or any memory's call is too close to make.
 */
async function jevRecall(session: Session, request: string): Promise<MemoryRecord[] | null> {
  const candidates = memoryRecords
    .filter((m) => !m.superseded_by)
    .sort((a, b) => b.uses - a.uses)
    .slice(0, 20);
  if (candidates.length === 0) return null;

  const properties: Record<string, any> = {};
  const labels: Record<string, string> = {};
  const byField = new Map<string, MemoryRecord>();
  candidates.forEach((m, i) => {
    const field = `memory_${i + 1}`;
    byField.set(field, m);
    labels[field] = m.title;
    properties[field] = {
      type: "boolean",
      description: `${m.title} -- ${m.body.replace(/\s+/g, " ").slice(0, 180)}`,
    };
  });

  const outcome = await jevDecide(session, {
    name: "memory recall",
    context: `The person's request:\n${request.slice(0, 2000)}`,
    instructions:
      "Each field is one stored memory. Answer true if knowing it would help " +
      "with the request, false if it is unrelated.",
    schema: { type: "object", properties },
    labels,
    timeoutMs: 5000,
  });
  if (outcome.mode !== "jev") return null;

  const picked = candidates.filter((m) => m.pinned);
  for (const [field, value] of Object.entries(outcome.values)) {
    const m = byField.get(field);
    if (m && value === true && !picked.includes(m)) picked.push(m);
  }
  return picked;
}

/**
 * Which kind of request this is, decided before the turn starts.
 *
 * One field, three values: answer from what the agent knows, act with tools,
 * or clarify first. The answer is a line in the system instructions -- the
 * tools stay on offer either way -- so a misjudged route costs a nudge, not a
 * capability. Returns null (no hint, the turn runs as it always has) whenever
 * Jev cannot decide confidently.
 */
async function jevRoute(session: Session, request: string): Promise<string | null> {
  const previous = previousAgentReply(session);
  const outcome = await jevDecide(session, {
    name: "question routing",
    context:
      (previous ? `The agent's previous reply:\n${previous.slice(-800)}\n\n` : "") +
      `The person's new message:\n${request.slice(0, 2000)}`,
    instructions: "Decide how the agent should handle the person's new message.",
    schema: {
      type: "object",
      properties: {
        route: {
          description: "How to handle the message",
          oneOf: [
            { const: "answer", description: "answer directly from knowledge; a question, explanation or conversation that needs no tools" },
            { const: "act", description: "do something with tools: run commands, browse, edit files, look things up" },
            { const: "clarify", description: "too ambiguous to act on safely; ask one clarifying question first" },
          ],
        },
      },
    },
    timeoutMs: 5000,
  });
  if (outcome.mode !== "jev") return null;
  switch (outcome.values.route) {
    case "answer":
      return "Routing: this message looks answerable directly. Reply from what you know; " +
        "use tools only if the answer genuinely depends on something you must check.";
    case "act":
      return "Routing: this message needs action. Start working with your tools rather " +
        "than describing what you would do.";
    case "clarify":
      return "Routing: this message is ambiguous. Before acting, ask the person one short " +
        "clarifying question with ask_user, offering concrete options.";
    default:
      return null;
  }
}

/** What the agent said last, so "yes, do it" can be routed with its antecedent. */
function previousAgentReply(session: Session): string {
  let seenUser = 0;
  const parts: string[] = [];
  for (let i = session.events.length - 1; i >= 0; i--) {
    const e = session.events[i];
    if (e.kind === "turn.user") {
      seenUser += 1;
      if (seenUser === 2) break;
      continue;
    }
    if (seenUser === 1 && e.kind === "turn.agent.text" && !e.payload?.local) {
      parts.unshift(String(e.payload?.text ?? ""));
    }
  }
  return parts.join("").trim();
}

/* ---- the tool guard -------------------------------------------------------

   Autora runs in yolo mode, and the guard does not change that for ordinary
   work: it looks only at calls that could plausibly destroy something, and
   stops one only when Jev is confident it is destructive AND that the person
   did not ask for it. Then the call does not run; the agent is told why and
   must ask the person with ask_user. Once they have answered, the same call
   goes through. Everything the guard is unsure about runs, as before. */

/** Answers the person has given, per session: a held call is let through
    once this has moved on since it was held. */
const answeredAsks = new Map<string, number>();
/** The words of the most recent answer, per session, to read a yes from a no. */
const lastAnswer = new Map<string, string>();
/** Held calls, by session and exact rendering, with the count at hold time. */
const heldCalls = new Map<string, number>();

async function jevGuard(
  session: Session,
  spec: { name: string },
  args: Record<string, any>,
  request: string,
  reason: string,
): Promise<string | null> {
  if (!guardWorthy(spec.name, args)) return null;
  const rendered = renderCall(spec as any, args);
  const key = `${session.id}\u0000${spec.name}\u0000${rendered}`;
  const answered = answeredAsks.get(session.id) ?? 0;
  const heldAt = heldCalls.get(key);
  if (heldAt !== undefined && answered > heldAt) {
    heldCalls.delete(key);
    // Asked and answered. Through, unless the answer was a clear no -- the
    // agent was told not to retry after a refusal, but that is a promise,
    // and this is the check that does not depend on it.
    const said = lastAnswer.get(session.id) ?? "";
    const verdict = await jevDecide(session, {
      name: "tool guard · your answer",
      context:
        `The action:\n${rendered.slice(0, 1000)}\n\n` +
        `The person's answer when asked about it:\n${said.slice(0, 1000)}`,
      schema: {
        type: "object",
        properties: {
          approved: { type: "boolean", description: "The person agreed to this action going ahead." },
        },
      },
      timeoutMs: 5000,
    });
    if (verdict.mode === "jev" && verdict.values.approved === false) {
      heldCalls.set(key, answered);
      return "Held by the guard: the person declined this when asked.";
    }
    return null;
  }

  const outcome = await jevDecide(session, {
    name: "tool guard",
    context:
      `The person's request:\n${request.slice(0, 1500)}\n\n` +
      (reason ? `The agent's stated reason:\n${reason.slice(0, 600)}\n\n` : "") +
      `The action about to run (${spec.name}):\n${rendered.slice(0, 1500)}`,
    instructions: "Judge the action about to run, strictly.",
    schema: {
      type: "object",
      properties: {
        destructive: {
          type: "boolean",
          description: "It could permanently delete, overwrite or break data, systems or accounts in a way that cannot easily be undone.",
        },
        requested: {
          type: "boolean",
          description: "The person explicitly asked for this specific destructive action, not merely for a task it might help with.",
        },
      },
    },
    timeoutMs: 5000,
  });
  if (outcome.mode !== "jev") return null;
  if (outcome.values.destructive !== true || outcome.values.requested !== false) return null;

  heldCalls.set(key, answered);
  const sure = Math.min(outcome.confidence.destructive, outcome.confidence.requested);
  return `Held by the guard: this looks destructive and the person did not ask for it (confidence ${sure.toFixed(2)}).`;
}

// ------------------------------------------------------- asking the person --

/**
 * A question the agent has put to the person, parked until they answer.
 *
 * Unlike an approval this is the agent's own choice to stop: it has hit
 * something only the person can settle -- a preference, an ambiguity, a
 * sign-in -- and the turn waits here, visibly, on a card in the thread.
 */
type PendingAsk = {
  sessionId: string;
  settle: (answer: AskAnswer) => void;
  timer: NodeJS.Timeout;
};
const awaitingAsk = new Map<string, PendingAsk>();

/** Longer than an approval: signing in somewhere can mean finding a phone. */
const ASK_TIMEOUT_MS = 30 * 60 * 1000;

/** Whether the turn in this session is stopped on the person rather than
    working. While it is, the browser belongs to them. */
function waitingOnPerson(sessionId: string): boolean {
  for (const pending of awaitingAsk.values()) {
    if (pending.sessionId === sessionId) return true;
  }
  return false;
}

/** The agent is at the wheel: a turn is running and it is not waiting on the
    person. User input to the browser is refused while this holds, so two
    pairs of hands never fight over one page. */
function agentDriving(session: Session): boolean {
  return session.busy && !waitingOnPerson(session.id);
}

function settleAsk(askId: string, answer: AskAnswer): boolean {
  const pending = awaitingAsk.get(askId);
  if (!pending) return false;
  clearTimeout(pending.timer);
  awaitingAsk.delete(askId);
  const session = sessions.get(pending.sessionId);
  if (!answer.cancelled && answer.who === "user") {
    answeredAsks.set(pending.sessionId, (answeredAsks.get(pending.sessionId) ?? 0) + 1);
    lastAnswer.set(pending.sessionId, [...answer.choices, answer.text].filter(Boolean).join(" -- "));
  }
  if (session) {
    emitEvent(session, "ask.answer", answer.who === "user" ? "user" : "system", {
      ask_id: askId,
      cancelled: answer.cancelled,
      choices: answer.choices,
      text: answer.text,
      who: answer.who,
    });
  }
  pending.settle(answer);
  return true;
}

function askPerson(session: Session, request: AskRequest): Promise<AskAnswer> {
  const askId = `ask-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;

  emitEvent(session, "ask.request", "agent", {
    ask_id: askId,
    kind: request.kind,
    title: request.title,
    detail: request.detail ?? "",
    options: request.options,
    multi: request.multi,
    allow_text: request.allowText,
    placeholder: request.placeholder ?? "",
  });

  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      settleAsk(askId, { cancelled: true, choices: [], text: "", who: "timeout" });
    }, ASK_TIMEOUT_MS);
    timer.unref?.();
    awaitingAsk.set(askId, { sessionId: session.id, settle: resolve, timer });
    // Stop releases the question too; nobody is going to answer it.
    running.get(session.id)?.cancels.add(() => {
      settleAsk(askId, { cancelled: true, choices: [], text: "", who: "stopped" });
    });
  });
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

// ---------------------------------------------------------------- desktop --

/**
 * Which session the desktop feed is pointed at.
 *
 * There is one relay and therefore one desktop, but any number of sessions
 * could ask about it. The one that most recently touched it is the one whose
 * thread the frames belong in; pointing them at all of them would put a video
 * of somebody's screen into conversations that never asked for it.
 */
let desktopSession: string | null = null;

/** The last frame kept as an event, so the desktop cell has something to show
    on replay rather than an empty box where a live feed used to be. */
let lastDesktopKeyframe = 0;
const DESKTOP_KEYFRAME_MS = 15_000;

function watchDesktopFor(session: Session) {
  if (desktopSession === session.id) return;
  desktopSession = session.id;
  watchDesktop((base64, mime) => {
    sendEphemeral(session.id, {
      type: "frame",
      session: session.id,
      source: "desktop",
      mime,
      data: base64,
      ts: Date.now(),
    });

    // One every so often becomes part of the record. The feed is ephemeral by
    // design -- see sendEphemeral -- but a session with no stored frame at all
    // replays as a desktop cell that shows nothing.
    const now = Date.now();
    if (now - lastDesktopKeyframe < DESKTOP_KEYFRAME_MS) return;
    lastDesktopKeyframe = now;
    const relay = relayStatus();
    const blob = putBlob(session.id, Buffer.from(base64, "base64"), mime);
    emitEvent(
      session, "desktop.frame", "agent",
      { w: relay.screen.w, h: relay.screen.h }, null, blob,
    );
  });
}

/** Stop the relay capturing when the session it was feeding has no watchers
    left -- a relay on somebody's laptop should not be shipping JPEGs because a
    tab was open an hour ago. */
function releaseDesktopIfIdle(sessionId: string) {
  if (desktopSession !== sessionId) return;
  if ((sessionSockets.get(sessionId)?.size ?? 0) > 0) return;
  desktopSession = null;
  watchDesktop(null);
}

/**
 * A relay connected, disconnected, or changed resolution.
 *
 * Logged rather than pushed at the browser: the settings card and the rail
 * indicator both poll `/api/relay` already, which reads the same status this
 * would carry. A second delivery path for one boolean would be two things to
 * keep in agreement in exchange for eight seconds of latency on a screen
 * somebody is looking at while they start the relay by hand.
 */
function noteRelayChange() {
  const state = relayStatus();
  console.log(
    state.connected
      ? `[relay] connected: ${state.platform ?? "unknown platform"} ${
          state.screen.w ?? "?"}x${state.screen.h ?? "?"}${
          state.canControl ? "" : " (capture only)"}`
      : `[relay] ${state.detail ?? "disconnected"}`,
  );
}

// ---------------------------------------------------------------- models --

/* How much history the model is handed is no longer a fixed count of turns:
   ./server/context folds older turns into an anchored working memory in the
   background once the prompt passes its high-water mark, so a long session
   stays bounded without forgetting what its early turns established. */

/** Each session's context engine: its anchored memory, live history and
    vault. Made on first use; lives as long as the session does. */
const contexts = new Map<string, ContextEngine>();

function engineFor(sessionId: string): ContextEngine {
  let engine = contexts.get(sessionId);
  if (!engine) {
    engine = new ContextEngine();
    contexts.set(sessionId, engine);
  }
  return engine;
}

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
 * may not open on the assistant, so any leading assistant turns are dropped --
 * unless earlier turns were folded into the anchored memory, in which case the
 * context engine opens the history with a line saying so instead.
 *
 * Events at or below `sinceSeq` have already been folded into that memory and
 * are left out. Each message carries the highest seq it was built from, which
 * is how the engine knows, later, what a fold has covered.
 */
function historyFor(session: Session, sinceSeq = 0): { message: ChatMessage; seq: number }[] {
  const turns: { message: ChatMessage; seq: number }[] = [];

  for (const event of session.events) {
    if (event.seq <= sinceSeq) continue;
    let role: "user" | "assistant" | null = null;
    if (event.kind === "turn.user") role = "user";
    else if (event.kind === "turn.agent.text") {
      /* Text this server composed -- the no-model notice, the seeded opening
         turn -- is not something a model said, and must not come back as if
         it were. Replaying it is how a perfectly live provider ends up
         insisting no provider is connected: it reads its own canned notice
         in the history, takes it for its own earlier words, and stays
         consistent with it. */
      if (event.payload?.local) continue;
      role = "assistant";
    }
    if (!role) continue;

    const text = String(event.payload?.text ?? "");
    if (!text) continue;

    const last = turns[turns.length - 1];
    if (last && last.message.role === role) {
      /* Assistant text arrives as stream deltas -- one event per fragment of
         a single reply -- so those join edge to edge. Two user turns running
         together are two separate things somebody typed, which happens
         whenever what sat between them was console text rather than the
         model's, and they need the break: Anthropic rejects consecutive
         same-role messages, so they cannot simply be kept apart. */
      last.message.text += role === "user" ? `\n\n${text}` : text;
      last.seq = event.seq;
    } else {
      turns.push({ message: { role, text }, seq: event.seq });
    }
  }

  if (sinceSeq === 0) {
    while (turns.length > 0 && turns[0].message.role === "assistant") turns.shift();
  }
  return turns;
}

/** How many times to re-ask after a transient refusal, and how long to wait.
    Free tiers answer 503 "high demand" often enough that one spike would
    otherwise read, in the thread, as the app being broken. */
const MODEL_RETRIES = 3;
const RETRY_BACKOFF_MS = [600, 1500, 3200];

/** Codes worth asking again for: rate limits, overload, and the generic 500. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

/**
 * How many rounds of tool calls one prompt may take.
 *
 * Each round is a billed call to the model, and a model that has talked itself
 * into a loop -- re-reading the same page, re-running a command that will fail
 * the same way -- will spend every round it is given. Twelve is enough for real
 * multi-step work (open a page, read it, click through, run a command, check
 * the output, report) and cheap enough to hit by accident without it mattering.
 * Running out is reported in the thread rather than passed over in silence.
 */
const MAX_TOOL_STEPS = 12;

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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

/** How many past tool calls to recap. Enough to cover the work behind a
    follow-up question, bounded so a long session does not push the whole
    prompt out on the digest alone. */
const RECAP_CALLS = 30;

/**
 * What the agent did earlier in this session, read back out of the log.
 *
 * One line per call: the tool, the essential argument, and how it turned out.
 * Paired by span, which is how the log already ties a call to its result --
 * the same relation the transcript is built from, so this cannot describe a
 * call the person cannot also see.
 */
function pastToolCalls(sessionId: string): string[] {
  const session = sessions.get(sessionId);
  if (!session) return [];

  const calls = new Map<string, { name: string; args: any; outcome: string }>();
  for (const event of session.events) {
    if (!event.span) continue;
    if (event.kind === "tool.call") {
      calls.set(event.span, {
        name: String(event.payload?.name ?? "tool"),
        args: event.payload?.args ?? {},
        outcome: "did not finish",
      });
      continue;
    }
    const found = calls.get(event.span);
    if (!found) continue;
    if (event.kind === "tool.result") {
      const code = event.payload?.display?.exit_code;
      found.outcome =
        code !== undefined
          ? `exit ${code}`
          : event.payload?.ok === false
            ? "failed"
            : `ok${event.payload?.preview ? ` -- ${String(event.payload.preview).slice(0, 80)}` : ""}`;
    } else if (event.kind === "tool.error") {
      found.outcome = event.payload?.denied
        ? "declined by the person"
        : `failed: ${String(event.payload?.error ?? "unknown").slice(0, 80)}`;
    }
  }

  const essential = (name: string, args: any): string => {
    if (name === "terminal") return String(args.command ?? "");
    if (name === "browser_open") return String(args.url ?? "");
    if (name === "memory_write") return String(args.title ?? "");
    if (name === "memory_search") return String(args.query ?? "");
    const keys = Object.keys(args ?? {});
    return keys.length > 0 ? JSON.stringify(args).slice(0, 80) : "";
  };

  return [...calls.values()]
    .slice(-RECAP_CALLS)
    .map((c) => {
      const what = essential(c.name, c.args);
      return `- ${c.name}${what ? ` (${what})` : ""} -> ${c.outcome}`;
    });
}

/** What the model is told it is, and what it knows, before the conversation. */
async function systemInstructionFor(
  sessionId: string,
  recalled: MemoryRecord[],
  active?: Resolved | null,
  /** Jev's reading of what kind of request this is, when it had one. */
  routeHint?: string | null,
): Promise<string> {
  const lines = [state.systemPrompt.trim()];
  if (routeHint) lines.push("", routeHint);

  /* What it can actually do, generated from the tool registry rather than
     written down here. This is the section whose absence made the console
     dishonest in both directions: with no inventory the model denied having a
     terminal it was about to be given one of, and with the memory graph's
     skill records as the only nearby claim it confabulated command output to
     match. See server/tools.ts -- the schemas the model receives and this
     prose come from the same array, so they cannot drift. */
  lines.push("", await capabilityBriefing());

  /* Which vendor is answering, said plainly.
     Nothing else in the prompt carries it, so a model asked "which provider
     is this?" has only the thread to go on -- and the thread may contain the
     notice this console writes when no provider is configured. Asked, it then
     reports itself offline while visibly streaming. The selection lives in
     Settings; this is where the model gets to read it. */
  if (active?.provider && !active.problem) {
    const label = PROVIDERS.find((p) => p.id === active.provider)?.label ?? active.provider;
    lines.push(
      "",
      `This turn is being generated by ${label}, model "${active.model}", ` +
        "as selected in this console's Settings. That is the answer if you " +
        "are asked which provider or model is running. Earlier turns in this " +
        "thread may claim no model is connected; those were written by the " +
        "console before a provider was configured, not by you, and they are " +
        "out of date.",
    );
  }

  if (recalled.length > 0) {
    lines.push(
      "",
      "What you already know about this workspace (from the memory graph):",
      ...recalled.map((m) => `- [${m.kind}] ${m.title}: ${m.body}`),
    );
  }

  /* The open page used to be pasted in here on every turn, because reading it
     was the only thing the agent could do with a browser and it had no way to
     ask. It can ask now -- browser_read returns the same text, on demand and
     at the point it is wanted -- so this says only that a page is open, and
     the six thousand characters of it are fetched if they turn out to matter. */
  const open = browsers.get(sessionId)?.status();
  if (open?.open && open.url) {
    lines.push(
      "",
      `A browser is already open at ${open.url}${
        open.title ? ` ("${open.title}")` : ""}. Call browser_read to see what ` +
        "is on it; the numbered elements it returns are what browser_click and " +
        "browser_fill take.",
    );
  }

  /* What it did earlier in this session.
     The chat history rebuilds from the event log on every turn (see
     historyFor) and carries only words, so without this the agent forgets
     every command it ran the moment the turn ends -- and then answers "what
     was that exit code?" by guessing. The tool calls themselves are not
     replayed as tool_use/tool_result pairs on purpose: vendors validate that
     pairing strictly, and a call whose result went missing across a restart
     would fail the whole request. A digest is stated as what it is, so
     nothing here can be mistaken for something the model said. */
  const done = pastToolCalls(sessionId);
  if (done.length > 0) {
    lines.push(
      "",
      "What you have already done in this session, oldest first:",
      ...done,
      "These happened. Do not repeat one to find out what it returned.",
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

    // 2. Mark busy, and open a fresh cancellation slate for this turn
    session.busy = true;
    running.set(session.id, { stopped: false, cancels: new Set() });
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

        /* A skill record is a claim about what this agent can do, and it is
           injected into the system prompt under "what you already know about
           this workspace". While the tool layer did not exist, mem-skill-2 --
           "Direct PTY execution, streaming command output chunks, exit code
           monitoring" -- was told to a model holding no tools at all, which is
           how a console with no shell came to narrate command output. Now that
           the tools are real, the claim is only made where the tool behind it
           is actually available; the briefing above says what is off and why. */
        const BACKED_BY: Record<string, ToolGroup> = {
          "mem-skill-1": "browser",
          "mem-skill-2": "terminal",
        };
        const usable = new Set(
          (await groupStates()).filter((g) => g.available).map((g) => g.group),
        );

        /* Jev Mode: when the model can score, which memories this turn gets
           is decided by the model, per memory, with a confidence each. The
           keyword rules above stay as the fallback for everything else. */
        // Both at once: two small decisions, one wait.
        const [scored, routeHint] = await Promise.all([
          jevRecall(session, text),
          jevRoute(session, text),
        ]);
        if (scored) accessedRecords.splice(0, accessedRecords.length, ...scored);

        const uniqueAccessed = accessedRecords.filter(
          (item, idx, self) =>
            self.findIndex((r) => r.id === item.id) === idx &&
            (!BACKED_BY[item.id] || usable.has(BACKED_BY[item.id])),
        );
        if (uniqueAccessed.length > 0) {
          emitEvent(session, "memory.recall", "agent", {
            ids: uniqueAccessed.map((r) => r.id),
            titles: uniqueAccessed.map((r) => r.title),
          });
        }

        // ------------------------------------------------------ the turn --

        const active = resolveProvider();
        const connected = Boolean(active.provider) && !active.problem;
        let streamed = 0;
        /* Whether any tool actually ran this turn. The two ways a turn ends
           with no words are not the same thing: the provider never answered
           (an error is already in the log), or tools ran and the model simply
           never wrote a closing line. Pointing at work that did not happen is
           its own small lie. */
        let ranSomething = false;
        /* One per turn, and outside the retry loop on purpose: a retry only
           happens when nothing has been said yet, so the sieve is empty, and
           a fresh one per attempt would be the same object with more steps. */
        const sieve = new DataUrlSieve();

        if (connected) {
          const tools = await availableTools();
          /* The conversation lives in the session's context engine for the
             length of the turn: rebuilt from the log (minus whatever has been
             folded into anchored memory), then grown by each round of tool
             calls. A background compaction may swap part of it out between
             any two steps; nothing here waits for one. */
          const context = engineFor(session.id);
          context.load(historyFor(session, context.foldedThroughSeq));
          const canReadVault = tools.some((t) => t.name === "vault_read");

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

          /**
           * One call to the model, retried while nothing has reached the thread.
           *
           * Returns what it said and what it wants run, or null once the
           * failure has been reported and there is no point going again.
           */
          const askModel = async (pinned: string): Promise<ChatTurn | null> => {
            // Across attempts, not within one: a second attempt after half a
            // sentence has been delivered would say that half twice.
            let delivered = 0;

            for (let attempt = 0; attempt <= MODEL_RETRIES; attempt += 1) {
              try {
                /* Frame 0 (the pinned instructions) with Frame 1 (anchored
                   memory) under it, and a fresh copy of the history: taken
                   per attempt, so a retry picks up a compaction that landed in
                   the meantime, and a copy, so one landing mid-request cannot
                   touch the request. */
                const system = context.systemFor(pinned);
                const turn = await streamChat({
                  provider: active.provider,
                  model: active.model,
                  key: active.key,
                  baseUrl: active.baseUrl,
                  system,
                  messages: context.messagesFor(system),
                  temperature: 0.7,
                  maxTokens: 2048,
                  thinkingBudget: THINKING_BUDGET,
                  tools: tools.map((t) => ({
                    name: t.name,
                    description: t.description,
                    parameters: t.parameters,
                  })),
                }, (piece) => {
                  // The client coalesces these deltas into one reply (see
                  // derive.ts), so a chunk per emit is a sentence appearing,
                  // not forty cards.
                  const { text: clean, images } = sieve.feed(piece);
                  if (clean) {
                    emitEvent(session, "turn.agent.text", "agent", { text: clean });
                    delivered += clean.length;
                    streamed += clean.length;
                  }
                  show(images);
                });

                const tail = sieve.flush();
                if (tail.text) {
                  emitEvent(session, "turn.agent.text", "agent", { text: tail.text });
                  delivered += tail.text.length;
                  streamed += tail.text.length;
                }
                show(tail.images);

                // What the turn cost, written down at the moment it happened.
                // Prices move, so re-pricing an old turn later from today's
                // table would quietly rewrite history; the ledger keeps the
                // figure that was in force when the call was made. One entry
                // per model call, so a turn that used six tools is billed as
                // the six calls it actually was.
                const priced = isPriced(active.provider, active.model);
                const cost = costOf(
                  active.provider, active.model, turn.usage.input, turn.usage.output,
                );
                recordUsage({
                  ts: Math.floor(Date.now() / 1000),
                  session: session.id,
                  provider: active.provider,
                  model: active.model,
                  input: turn.usage.input,
                  output: turn.usage.output,
                  cost,
                  priced,
                  estimated: turn.usage.estimated,
                });
                emitEvent(session, "usage.turn", "system", {
                  provider: active.provider,
                  model: active.model,
                  input_tokens: turn.usage.input,
                  output_tokens: turn.usage.output,
                  cost_usd: cost,
                  priced,
                  estimated: turn.usage.estimated,
                });

                return turn;
              } catch (err: any) {
                const detail = err?.message ?? String(err);
                const status = err instanceof ProviderError ? err.status : null;
                console.warn(
                  `[model] ${active.provider}/${active.model} attempt ${attempt + 1}: ${detail}`,
                );

                const retryable =
                  delivered === 0 &&
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
                const vendor =
                  PROVIDERS.find((p) => p.id === active.provider)?.label ?? active.provider;
                emitEvent(session, "system.error", "system", {
                  error: `${vendor} (${active.model}) did not answer: ${detail}`,
                });
                return null;
              }
            }
            return null;
          };

          /**
           * The background summariser behind compaction: the same provider,
           * no tools, a low temperature, nothing streamed to the thread.
           * AUTORA_COMPACTION_MODEL names a cheaper model of that provider to
           * use for it instead. Its cost goes in the ledger like any call.
           */
          const summarize = async (prompt: string): Promise<string> => {
            const model = (process.env.AUTORA_COMPACTION_MODEL || "").trim() || active.model;
            const turn = await streamChat({
              provider: active.provider,
              model,
              key: active.key,
              baseUrl: active.baseUrl,
              system:
                "You compress an AI agent's working context into a structured " +
                "record of task state. Output only that record.",
              messages: [{ role: "user", text: prompt }],
              temperature: 0.2,
              maxTokens: 2048,
              thinkingBudget: 0,
            }, () => undefined);
            recordUsage({
              ts: Math.floor(Date.now() / 1000),
              session: session.id,
              provider: active.provider,
              model,
              input: turn.usage.input,
              output: turn.usage.output,
              cost: costOf(active.provider, model, turn.usage.input, turn.usage.output),
              priced: isPriced(active.provider, model),
              estimated: turn.usage.estimated,
            });
            return turn.text;
          };

          const compacted = (report: CompactionReport) => {
            if (!report.ok) {
              // Nothing was lost -- the turns stay raw -- so this is for the
              // server log, not the thread.
              console.warn(`[context] ${session.id}: compaction failed: ${report.error}`);
              return;
            }
            console.log(
              `[context] ${session.id}: folded ${report.folded} messages ` +
                `(~${report.tokensBefore} -> ~${report.tokensAfter} tokens)`,
            );
            emitEvent(session, "system.log", "system", {
              message:
                `Condensed ${report.folded} earlier message${report.folded === 1 ? "" : "s"} ` +
                "into working memory, in the background " +
                `(about ${report.tokensBefore.toLocaleString("en-US")} tokens of context ` +
                `down to ${report.tokensAfter.toLocaleString("en-US")}).`,
            });
          };

          /** Everything a tool needs from this session, handed in rather than
              imported, so server/tools.ts knows nothing about sessions. */
          const contextFor = (span: string): ToolContext => ({
            onOutput: (chunk) =>
              emitEvent(session, "pty.output", "agent", { data: chunk }, span),
            putBlob: (data, mime) => putBlob(session.id, data, mime),
            showImage: (blob, alt, caption, size) =>
              emitEvent(session, "media.image", "agent", {
                alt, caption, ...(size ? { w: size.w, h: size.h } : {}),
              }, null, blob),
            browser: () => browserFor(session),
            browserChanged: () => broadcastBrowserState(session),
            watchDesktop: () => watchDesktopFor(session),
            cancelled: () => Boolean(running.get(session.id)?.stopped),
            onCancel: (stop) => { running.get(session.id)?.cancels.add(stop); },
            memory: {
              write: ({ title, body, kind }) => {
                const record: MemoryRecord = {
                  id: `mem-${Date.now().toString(36)}`,
                  kind: kind as MemoryRecord["kind"],
                  scope: "workspace",
                  title,
                  body,
                  tags: ["agent-authored"],
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
                memoryRecords.push(record);
                emitEvent(session, "memory.write", "agent", {
                  id: record.id, title: record.title, kind: record.kind,
                });
                return { id: record.id };
              },
              search: (query) => {
                const terms = query.toLowerCase().split(/\s+/).filter(Boolean);
                const hits = memoryRecords.filter((m) => {
                  const haystack =
                    `${m.title} ${m.body} ${m.tags.join(" ")}`.toLowerCase();
                  return terms.some((t) => haystack.includes(t));
                });
                if (hits.length > 0) {
                  // A search is a recall, and the ribbon should light up for it
                  // exactly as it does for the automatic kind.
                  emitEvent(session, "memory.recall", "agent", {
                    ids: hits.slice(0, 8).map((m) => m.id),
                    titles: hits.slice(0, 8).map((m) => m.title),
                  });
                }
                return hits.slice(0, 8).map((m) => ({
                  kind: m.kind, title: m.title, body: m.body,
                }));
              },
            },
            vault: (id) => context.vault.get(id),
            ask: (request) => askPerson(session, request),
          });

          /**
           * The agent loop.
           *
           * Ask, run whatever came back, tell the model what happened, ask
           * again -- until it stops asking for tools, or the step budget runs
           * out. The budget exists because a model that has got itself into a
           * loop will happily spend a hundred calls on it, and every one of
           * those is billed.
           */
          let spans = 0;
          for (let step = 0; step < MAX_TOOL_STEPS; step += 1) {
            if (running.get(session.id)?.stopped) break;

            const pinned = await systemInstructionFor(session.id, uniqueAccessed, active, routeHint);
            /* Past the high-water mark this starts a background fold of the
               older turns and returns at once. It is never awaited: this
               step's call goes out now, on the history as it stands. */
            context.maybeCompact(pinned, summarize, compacted);

            const turn = await askModel(pinned);
            if (!turn || turn.calls.length === 0) break;

            context.append(
              { role: "assistant", text: turn.text, calls: turn.calls },
              session.seqCounter,
            );
            const replies: ToolReply[] = [];

            for (const use of turn.calls) {
              const span = `span-${session.id}-${session.seqCounter}-${spans++}`;
              const reply = (ok: boolean, result: string): void => {
                replies.push({ id: use.id, name: use.name, ok, result });
              };

              if (running.get(session.id)?.stopped) {
                reply(false, "The person stopped the turn before this ran.");
                continue;
              }

              const spec = findTool(use.name);
              /* Offered tools are the available ones, so an unknown name here
                 means the model invented it -- or asked for something from a
                 group that is switched off. Naming what it does have is more
                 use to it than "unknown tool". */
              if (!spec || !tools.some((t) => t.name === use.name)) {
                emitEvent(session, "tool.call", "agent", {
                  name: use.name, args: use.args,
                }, span);
                const known = tools.map((t) => t.name).join(", ") || "none";
                const why = spec
                  ? `"${use.name}" exists but its group is not available right now.`
                  : `There is no tool called "${use.name}".`;
                emitEvent(session, "tool.error", "agent", { error: why }, span);
                reply(false, `${why} The tools you have are: ${known}.`);
                continue;
              }

              emitEvent(session, "tool.call", "agent", {
                name: spec.name, args: use.args,
              }, span);

              if (needsApproval(spec)) {
                const decision = await askPermission(session, {
                  tool: spec.name,
                  rendered: renderCall(spec, use.args),
                  reason: turn.text.trim()
                    // The model's own words for why, when it gave any: far more
                    // use on the card than a fixed sentence about elevation.
                    ? turn.text.trim().slice(0, 300)
                    : `${spec.name} needs your approval before it runs.`,
                });
                if (!decision.approved) {
                  emitEvent(session, "tool.error", "agent", {
                    denied: true, reason: "The person declined this.",
                  }, span);
                  reply(
                    false,
                    "The person declined this. Do not retry it. Either find " +
                      "another way, or tell them what you needed it for and why.",
                  );
                  continue;
                }
                if (decision.response) {
                  emitEvent(session, "context.note", "user", {
                    text: `You answered the approval with: ${decision.response}`,
                  });
                }
              }

              const held = await jevGuard(session, spec, use.args, text, turn.text.trim());
              if (held) {
                emitEvent(session, "tool.error", "agent", {
                  guarded: true, denied: true, error: held,
                }, span);
                reply(
                  false,
                  `${held} It did not run. Ask the person with ask_user first -- say ` +
                    "exactly what it will do and what cannot be undone. If they agree, " +
                    "make the same call again and it will go through. If they decline, " +
                    "find another way or stop.",
                );
                continue;
              }

              const started = Date.now();
              ranSomething = true;
              const outcome = await runTool(spec, use.args, contextFor(span));
              const durationMs = Date.now() - started;

              if (spec.group === "terminal") {
                // The terminal cell reads its exit code from here, and the
                // pipes are closed by the time this lands.
                emitEvent(session, "pty.exit", "agent", {
                  exit_code: outcome.exitCode ?? null,
                  duration_ms: durationMs,
                }, span);
              }

              if (outcome.ok) {
                emitEvent(session, "tool.result", "agent", {
                  ok: true,
                  preview: outcome.preview ?? "",
                  duration_ms: durationMs,
                  ...(outcome.exitCode !== undefined
                    ? { display: { exit_code: outcome.exitCode } }
                    : {}),
                }, span);
              } else {
                /* A command that exits non-zero is a result, not a broken
                   tool: the model needs to read it and decide. Only a tool
                   that could not run at all is an error. */
                if (outcome.exitCode !== undefined) {
                  emitEvent(session, "tool.result", "agent", {
                    ok: false,
                    preview: outcome.preview ?? "",
                    duration_ms: durationMs,
                    display: { exit_code: outcome.exitCode },
                  }, span);
                } else {
                  emitEvent(session, "tool.error", "agent", {
                    error: outcome.summary,
                    duration_ms: durationMs,
                  }, span);
                }
              }

              /* Ingestion filter: control codes and repeated lines out, and
                 anything still too long kept whole in the vault with its head
                 and tail left in the prompt. The thread already showed it
                 all, live; this is only what the model reads. */
              reply(outcome.ok, context.ingest(spec.name, outcome.summary, canReadVault));
            }

            context.append({ role: "tool", replies }, session.seqCounter);

            if (step === MAX_TOOL_STEPS - 1) {
              /* Out of budget with the model still working. Said in the log
                 rather than silently stopping, because a turn that ends
                 mid-task with no explanation looks like a crash. */
              emitEvent(session, "system.log", "system", {
                message:
                  `Stopped after ${MAX_TOOL_STEPS} rounds of tool calls. Ask ` +
                  "again to carry on from here.",
              });
            }
          }
        }

        // Nothing came back -- no provider configured, or the call failed. Say
        // something useful rather than leaving the turn blank.
        if (streamed === 0) {
          let reply: string;
          if (!connected) {
            reply =
              "No model is connected yet, so nothing can answer you. " +
              `${active.problem ?? ""} Open Settings, add a key for OpenAI, Google, ` +
              "Anthropic, DeepSeek, or OpenRouter, and pick a model. The tools — " +
              "terminal, browser, computer control — are configured in Settings too, " +
              "but it takes a model to decide to use them.";
          } else if (running.get(session.id)?.stopped) {
            reply = "Stopped.";
          } else if (ranSomething) {
            /* Tools ran and the model never wrote a closing word. The work is
               in the transcript above, so point at it rather than inventing a
               summary of it. */
            reply =
              "That turn ended without a written answer. What ran is above, " +
              "with its output.";
          } else {
            /* Nothing ran and nothing was said, which means the model call
               itself failed -- and that failure is already in the log as a
               system error naming the vendor and the reason. Repeating it here
               in vaguer words would only bury it. */
            reply = "Nothing came back that turn. The error above says why.";
          }
          /* `local` keeps this out of the history the model is shown next
             turn -- see historyFor. */
          emitEvent(session, "turn.agent.text", "agent", { text: reply, local: true });
        }

        emitEvent(session, "turn.agent.done", "agent", {});
      } catch (err: any) {
        emitEvent(session, "system.error", "system", {
          error: err?.message || "Execution error",
        });
      } finally {
        session.busy = false;
        // Nothing from this turn is still cancellable, and anything left in
        // the set holds a reference to a process that has exited.
        running.delete(session.id);
        /* If the turn touched the desktop but nobody is watching this session,
           stop the relay capturing. Without this a single computer_screenshot
           left a relay on somebody's laptop shipping JPEGs at two a second
           indefinitely, because the only thing that turned it off was a
           websocket closing and there had never been one. */
        releaseDesktopIfIdle(session.id);
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
    /* Stop now reaches the work rather than just the flag: a running command
       is killed, an approval nobody answered is settled as declined, and the
       agent loop checks before every further step. Clearing `busy` alone left
       a `npm install` running to completion behind a UI that said it had
       stopped. */
    stopTurn(session.id);
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

  // 6b. Live Browser Direct Interaction & Handoff
  const DRIVING =
    "The agent is using the browser. Wait until it finishes or asks you, or stop it.";

  /** An answer to a question the agent asked. */
  app.post("/api/sessions/:id/ask/:askId", (req: Request, res: Response) => {
    const pending = awaitingAsk.get(req.params.askId);
    if (!pending || pending.sessionId !== req.params.id) {
      return res.status(404).json({ error: "That question is no longer waiting." });
    }
    const choices = Array.isArray(req.body?.choices)
      ? req.body.choices.map((c: unknown) => String(c)).slice(0, 20)
      : [];
    const text = typeof req.body?.text === "string" ? req.body.text.slice(0, 4000) : "";
    settleAsk(req.params.askId, {
      cancelled: Boolean(req.body?.cancelled),
      choices,
      text,
      who: "user",
    });
    res.json({ ok: true });
  });
  app.get("/api/sessions/:id/browser/status", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const live = browsers.get(session.id);
    if (!live) return res.json({ open: false, control: { holder: "agent" } });
    res.json(live.status());
  });

  app.post("/api/sessions/:id/browser/control", (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    const live = browsers.get(session.id);
    if (!live) return res.status(400).json({ error: "No browser active" });

    const holder = req.body?.holder === "human" ? "human" : req.body?.holder === "shared" ? "shared" : "agent";
    const reason = req.body?.reason ? String(req.body.reason) : null;
    live.setControl(holder, reason);

    broadcastBrowserState(session);

    emitEvent(session, "browser.control", "user", {
      holder,
      reason,
      by: "user",
    });

    res.json({ ok: true, control: live.status().control });
  });

  app.post("/api/sessions/:id/browser/scroll", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = browsers.get(session.id);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const dx = Number(req.body?.dx ?? 0);
    const dy = Number(req.body?.dy ?? 0);
    try {
      await live.mouseWheel(dx, dy);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Scroll failed" });
    }
  });

  app.post("/api/sessions/:id/browser/reload", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = browsers.get(session.id);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    try {
      const page = await live.reload();
      res.json({ ok: true, url: page.url, title: page.title });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Reload failed" });
    }
  });

  app.post("/api/sessions/:id/browser/back", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = browsers.get(session.id);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    try {
      const page = await live.goBack();
      res.json({ ok: true, url: page?.url, title: page?.title });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Back navigation failed" });
    }
  });

  app.post("/api/sessions/:id/browser/click", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = browsers.get(session.id);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: "Invalid click coordinates." });
    }

    try {
      const button = req.body?.button === "right" ? "right" : req.body?.button === "middle" ? "middle" : "left";
      const { editable } = await live.userClick(x, y, button, !!req.body?.double);
      res.json({ ok: true, editable });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Click failed" });
    }
  });

  app.post("/api/sessions/:id/browser/move", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = browsers.get(session.id);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const x = Number(req.body?.x);
    const y = Number(req.body?.y);
    if (!Number.isFinite(x) || !Number.isFinite(y)) {
      return res.status(400).json({ error: "Invalid move coordinates." });
    }

    try {
      await live.mouseMove(x, y);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Move failed" });
    }
  });

  app.post("/api/sessions/:id/browser/type", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = browsers.get(session.id);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const text = String(req.body?.text ?? "");
    try {
      await live.keyboardType(text);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Type failed" });
    }
  });

  app.post("/api/sessions/:id/browser/key", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = browsers.get(session.id);
    if (!live?.status().open) return res.status(400).json({ error: "No page is open." });

    const key = String(req.body?.key ?? "");
    if (!key) return res.status(400).json({ error: "No key specified." });

    try {
      await live.keyboardPress(key);
      res.json({ ok: true });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Key press failed" });
    }
  });

  app.post("/api/sessions/:id/browser/navigate", async (req: Request, res: Response) => {
    const session = sessions.get(req.params.id);
    if (!session) return res.status(404).json({ error: "Session not found" });
    if (agentDriving(session)) return res.status(409).json({ error: DRIVING });
    const live = browsers.get(session.id);
    if (!live) return res.status(400).json({ error: "No browser active." });

    const url = String(req.body?.url ?? "").trim();
    if (!url) return res.status(400).json({ error: "No URL specified." });

    try {
      const page = await live.goto(url);
      res.json({ ok: true, url: page.url, title: page.title });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? "Navigation failed" });
    }
  });

  // 7. Policy Approvals
  /**
   * Yes or no to a waiting tool call.
   *
   * The decision is emitted into the one session that asked, and the call that
   * is parked on it is released. It used to be broadcast to every session --
   * which put an answer to somebody else's question into your transcript --
   * and released nothing, because nothing was waiting.
   */
  app.post("/api/policy/:requestId", (req: Request, res: Response) => {
    const requestId = req.params.requestId;
    const approved = Boolean(req.body?.approved);
    const who = req.body?.who || "user";
    const response = typeof req.body?.response === "string" ? req.body.response : undefined;

    const pending = awaitingApproval.get(requestId);
    const session = pending ? sessions.get(pending.sessionId) : null;

    if (session) {
      emitEvent(session, "policy.decision", "user", {
        request_id: requestId,
        requestId,
        decision: approved ? "allow" : "deny",
        approved,
        who,
        response,
      });
    }

    const released = settleApproval(requestId, { approved, response });

    /* An id nothing is waiting on is not an error: the card is still in the
       transcript after a restart, or after the prompt timed out, and clicking
       it then should say so rather than appear to work. */
    if (!released) {
      return res.json({
        ok: false,
        approved,
        who,
        detail: "Nothing is waiting on that request any more.",
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

  /* The tool section is assembled separately because availability is asked of
     the world -- is Chromium installed, is a relay dialled in -- which is
     async, and the rest of the payload is not. */
  const settingsWithTools = async () => ({
    ...settingsPayload(),
    jev: {
      ...state.jev,
      support: supportFor(jevTarget()),
      last: lastDecision(),
    },
    tools: {
      config: toolSettings(),
      groups: await groupStates(),
    },
  });

  /**
   * Score a decision directly: `{ context, schema, instructions? }` in, the
   * outcome out -- the programmatic payload with a confidence per field, or
   * the reason it fell back. For scripts, and for checking a backend.
   */
  app.post("/api/jev/evaluate", async (req: Request, res: Response) => {
    const body = req.body ?? {};
    if (!body.schema || typeof body.schema !== "object") {
      return res.status(400).json({ error: "A JSON schema is required." });
    }
    const outcome = await jevDecide(null, {
      name: String(body.name ?? "api"),
      context: String(body.context ?? ""),
      schema: body.schema,
      instructions: typeof body.instructions === "string" ? body.instructions : undefined,
    });
    res.json(outcome);
  });

  app.get("/api/settings", async (req: Request, res: Response) => {
    res.json(await settingsWithTools());
  });

  app.patch("/api/settings", async (req: Request, res: Response) => {
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

    /* Which tools the agent has, and how tightly each is gated. Turning a
       group off here removes its tools from the model's schema on the very
       next turn and changes what the agent is told it can do -- both come from
       the one registry, so the panel cannot promise something the schema does
       not deliver. */
    if (body.tools && typeof body.tools === "object") {
      updateToolSettings(body.tools);
    }
    if (body.jev && typeof body.jev === "object") mergeJev(state.jev, body.jev);

    save();
    res.json(await settingsWithTools());
  });

  // 10a. Secrets Store Management
  app.get("/api/secrets", (req: Request, res: Response) => {
    res.json(listSecrets());
  });

  app.get("/api/secrets/presets", (req: Request, res: Response) => {
    res.json(SECRET_PRESETS);
  });

  app.post("/api/secrets/reveal", (req: Request, res: Response) => {
    const name = String(req.body?.name ?? "").trim();
    if (!name) return res.status(400).json({ error: "Secret name is required" });
    const value = getSecret(name);
    if (value === null) return res.status(404).json({ error: "Secret not found" });
    res.json({ ok: true, name, value });
  });

  app.post("/api/secrets", (req: Request, res: Response) => {
    const name = String(req.body?.name ?? "").trim().toUpperCase();
    const value = String(req.body?.value ?? "");
    if (!name) return res.status(400).json({ error: "Secret variable name is required" });
    if (!/^[A-Z_][A-Z0-9_]*$/i.test(name)) {
      return res.status(400).json({ error: "Name must be a valid environment variable identifier (letters, digits, and underscores, starting with a letter or underscore)" });
    }
    if (!value && value !== "") {
      return res.status(400).json({ error: "Secret value is required" });
    }
    setSecret(name, value);
    save();
    res.json({ ok: true, secrets: listSecrets() });
  });

  app.delete("/api/secrets/:name", (req: Request, res: Response) => {
    const name = req.params.name;
    deleteSecret(name);
    save();
    res.json({ ok: true, secrets: listSecrets() });
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
  /** Where this server can be reached from the machine being relayed, worked
      out from the request rather than guessed, so the download it hands out
      already knows its own address. */
  const relayAddress = (req: Request) => {
    const host = req.headers["host"] || `127.0.0.1:${PORT}`;
    const proto = req.headers["x-forwarded-proto"] === "https" ? "https" : "http";
    return {
      ws: `${proto === "https" ? "wss" : "ws"}://${host}/ws/desktop-relay`,
      http: `${proto}://${host}`,
    };
  };

  app.get("/api/relay", (req: Request, res: Response) => {
    const where = relayAddress(req);
    res.json({
      ...relayStatus(),
      ws_url: where.ws,
      download: `${where.http}/relay.py`,
      install: "pip install websockets mss pyautogui pillow",
      run: "python relay.py",
    });
  });

  /**
   * The relay client itself.
   *
   * This was a two-line stub that printed "ready" and exited, which is why the
   * desktop has never worked: the instructions were real, the websocket route
   * dropped the connection, and the file at the end of the curl was a joke.
   * See server/desktop.ts for the source and the protocol it speaks.
   */
  app.get("/relay.py", (req: Request, res: Response) => {
    res.setHeader("Content-Type", "text/x-python");
    res.setHeader("Content-Disposition", 'attachment; filename="relay.py"');
    res.send(relayClientSource(relayAddress(req).ws));
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

      /* The relay is not a session. This path used to `return` here, leaving
         the socket open and unread -- so a correctly configured relay
         connected, sent its hello into nothing, and the app went on reporting
         that no desktop was available. */
      if (sessionId === "desktop-relay") {
        attachRelay(ws, noteRelayChange);
        return;
      }

      if (!sessionId) return;

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
            stopTurn(session.id);
            session.busy = false;
            broadcastLiveStatus(session);
          } else if (msg.type === "policy") {
            // Same gate as POST /api/policy: emit the decision, then release
            // the tool call that is parked on it.
            emitEvent(session, "policy.decision", "user", {
              request_id: msg.request_id,
              requestId: msg.request_id,
              decision: msg.approved ? "allow" : "deny",
              approved: Boolean(msg.approved),
              who: msg.who || "user",
              response: typeof msg.response === "string" ? msg.response : undefined,
            });
            settleApproval(String(msg.request_id), {
              approved: Boolean(msg.approved),
              response: typeof msg.response === "string" ? msg.response : undefined,
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
        // Nobody left watching: stop asking the relay for pictures of
        // somebody's screen.
        releaseDesktopIfIdle(sessionId);
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
