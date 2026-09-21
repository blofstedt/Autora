import http from "node:http";
import path from "node:path";
import express, { type Request, type Response } from "express";
import { WebSocketServer, WebSocket } from "ws";
import { createServer as createViteServer } from "vite";
import { GoogleGenAI } from "@google/genai";

const PORT = 3000;
const HOST = "0.0.0.0";

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

let appSettings = {
  provider: "auto",
  // Follows Google's current free Flash unless the environment pins one.
  // Kept in step with DEFAULT_GEMINI_MODEL below.
  model: (process.env.GEMINI_MODEL || "").trim() || "gemini-flash-latest",
  baseUrl: "",
  systemPrompt: "You are Autora, an autonomous AI execution console and agent workspace.",
};

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

// ------------------------------------------------------------------ gemini --

/** The free tier's rolling Flash alias. Pinning a dated model means the app
    stops working the day that model retires; the alias follows Google's
    current free Flash and needs no release of ours to keep up. */
const DEFAULT_GEMINI_MODEL = "gemini-flash-latest";

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

const geminiKey = () => (process.env.GEMINI_API_KEY || "").trim();

/** The model actually asked for: the setting if it names one, else the env
    override, else the rolling alias. */
function geminiModel(): string {
  return (
    appSettings.model.trim() ||
    (process.env.GEMINI_MODEL || "").trim() ||
    DEFAULT_GEMINI_MODEL
  );
}

/** Lazy client, rebuilt if the key changes underneath us. */
let geminiClient: GoogleGenAI | null = null;
let geminiClientKey = "";
function getGemini(): GoogleGenAI | null {
  const key = geminiKey();
  if (!key) {
    geminiClient = null;
    geminiClientKey = "";
    return null;
  }
  if (!geminiClient || geminiClientKey !== key) {
    geminiClient = new GoogleGenAI({ apiKey: key });
    geminiClientKey = key;
  }
  return geminiClient;
}

type GeminiTurn = { role: "user" | "model"; parts: { text: string }[] };

/**
 * This session's conversation, in the shape Gemini wants.
 *
 * Built from the event log rather than a second transcript kept alongside it,
 * so what the model sees is what the thread shows -- including the turn just
 * posted, which the caller has already emitted by the time we get here.
 *
 * Two details the API cares about: consecutive turns from the same speaker are
 * merged (streamed replies arrive as many `turn.agent.text` deltas, and forty
 * one-word model turns is not a conversation), and a history may not open on
 * the model, so any leading model turns are dropped.
 */
function conversationFor(session: Session): GeminiTurn[] {
  const turns: GeminiTurn[] = [];

  for (const event of session.events) {
    let role: "user" | "model" | null = null;
    if (event.kind === "turn.user") role = "user";
    else if (event.kind === "turn.agent.text") role = "model";
    if (!role) continue;

    const text = String(event.payload?.text ?? "");
    if (!text) continue;

    const last = turns[turns.length - 1];
    if (last && last.role === role) last.parts[0].text += text;
    else turns.push({ role, parts: [{ text }] });
  }

  while (turns.length > 0 && turns[0].role === "model") turns.shift();
  return turns.slice(-HISTORY_TURNS);
}

/** How many times to re-ask after a transient refusal, and how long to wait.
    Flash on the free tier answers 503 "high demand" often enough that one
    spike would otherwise read, in the thread, as the app being broken. */
const GEMINI_RETRIES = 3;
const RETRY_BACKOFF_MS = [600, 1500, 3200];

/** Codes worth asking again for: rate limits, overload, and the generic 500. */
const TRANSIENT = new Set([429, 500, 502, 503, 504]);

/**
 * The readable sentence inside a Gemini error.
 *
 * The SDK hands back a message that is itself a JSON document with another
 * JSON document quoted inside it, so the useful sentence arrives buried two
 * levels deep behind escaped newlines. Shown raw it is a wall of braces, which
 * tells the reader nothing about whether their key is wrong or Google is busy.
 */
function describeGeminiError(err: any): { text: string; status: number | null } {
  const raw = err?.message ?? String(err);
  let status: number | null = typeof err?.status === "number" ? err.status : null;
  let text = String(raw);

  // Unwrap as far as the nesting goes, keeping the innermost message.
  for (let depth = 0; depth < 3; depth += 1) {
    const start = text.indexOf("{");
    if (start < 0) break;
    try {
      const parsed = JSON.parse(text.slice(start));
      const inner = parsed?.error ?? parsed;
      if (typeof inner?.code === "number") status = inner.code;
      if (typeof inner?.message !== "string") break;
      text = inner.message;
    } catch {
      break;
    }
  }

  return { text: text.trim().replace(/\s+/g, " ") || "no detail given", status };
}

const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

/** What the model is told it is, and what it knows, before the conversation. */
function systemInstructionFor(recalled: MemoryRecord[]): string {
  const lines = [appSettings.systemPrompt.trim()];

  if (recalled.length > 0) {
    lines.push(
      "",
      "What you already know about this workspace (from the memory graph):",
      ...recalled.map((m) => `- [${m.kind}] ${m.title}: ${m.body}`),
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
      version: "0.1.0",
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

        // Generate the reply with Gemini, streaming it so the thread fills as
        // the model writes rather than sitting empty and then blinking a
        // paragraph into place.
        const gemini = getGemini();
        let streamed = 0;

        if (gemini) {
          const model = geminiModel();
          const request = {
            model,
            contents: conversationFor(session),
            config: {
              systemInstruction: systemInstructionFor(uniqueAccessed),
              temperature: 0.7,
              maxOutputTokens: 2048,
              thinkingConfig: { thinkingBudget: THINKING_BUDGET },
            },
          };

          for (let attempt = 0; attempt <= GEMINI_RETRIES; attempt += 1) {
            try {
              const stream = await gemini.models.generateContentStream(request);

              for await (const chunk of stream) {
                const piece = chunk.text;
                if (!piece) continue;
                // The client coalesces these deltas into one reply (see
                // derive.ts), so a chunk per emit is a sentence appearing,
                // not forty cards.
                emitEvent(session, "turn.agent.text", "agent", { text: piece });
                streamed += piece.length;
              }
              break;
            } catch (err: any) {
              const { text: detail, status } = describeGeminiError(err);
              console.warn(`[gemini] ${model} attempt ${attempt + 1}: ${detail}`);

              // Only worth another go while nothing has reached the thread --
              // re-running a half-delivered reply would say the first half
              // twice.
              const retryable =
                streamed === 0 &&
                attempt < GEMINI_RETRIES &&
                (status === null || TRANSIENT.has(status));

              if (retryable) {
                await wait(RETRY_BACKOFF_MS[Math.min(attempt, RETRY_BACKOFF_MS.length - 1)]);
                continue;
              }

              // Said out loud rather than swallowed: a canned reply in place
              // of a real one is indistinguishable from the model working,
              // and what people need to know is whether their key is wrong or
              // Google is simply busy.
              emitEvent(session, "system.error", "system", {
                error: `Gemini (${model}) did not answer: ${detail}`,
              });
              break;
            }
          }
        }

        // Nothing came back -- no key configured, or the call failed. Say
        // something useful rather than leaving the turn blank.
        if (streamed === 0) {
          let reply: string;
          if (!gemini) {
            reply =
              "No model is connected yet, so I am running on local responses only. " +
              "Set GEMINI_API_KEY in the server environment and restart to bring " +
              "Gemini online; everything else in the console works without it.";
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

  // 6. UI Element Pick
  app.post("/api/sessions/:id/pick", (req: Request, res: Response) => {
    const label = req.body?.label || "element";
    res.json({ ok: true, text: `Selected UI target (${label})` });
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
    const connected = Boolean(geminiKey());
    return {
      provider: appSettings.provider,
      model: appSettings.model,
      base_url: appSettings.baseUrl,
      providers: ["auto", "gemini", "anthropic", "deepseek", "local"],
      system_prompt: appSettings.systemPrompt,
      system_prompt_limit: 8000,
      credentials: [
        {
          name: "gemini",
          label: "Google Gemini",
          note: "Google AI Studio API key, read from GEMINI_API_KEY",
          role: "model",
          set: connected,
          hint: connected
            ? "Connected (server environment)"
            : "Set GEMINI_API_KEY and restart",
        },
        {
          name: "anthropic",
          label: "Anthropic Claude",
          note: "Claude API Key",
          role: "model",
          set: Boolean(process.env.ANTHROPIC_API_KEY),
          hint: "sk-ant-...",
        },
      ],
      active: {
        // What the next turn will actually call, rather than a name written
        // down once and left behind by every model change since.
        model: geminiModel(),
        endpoint: appSettings.baseUrl || null,
        provider: "Gemini",
        hint: connected
          ? `Google ${geminiModel()}`
          : "No key set -- replies are local fallbacks",
      },
    };
  };

  app.get("/api/settings", (req: Request, res: Response) => {
    res.json(settingsPayload());
  });

  app.patch("/api/settings", (req: Request, res: Response) => {
    if (req.body.provider !== undefined) appSettings.provider = req.body.provider;
    if (req.body.model !== undefined) appSettings.model = req.body.model;
    if (req.body.base_url !== undefined) appSettings.baseUrl = req.body.base_url;
    if (req.body.system_prompt !== undefined) appSettings.systemPrompt = req.body.system_prompt;

    res.json(settingsPayload());
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
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: "spa",
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.join(process.cwd(), "dist");
    app.use(express.static(distPath));
    app.get("*", (req: Request, res: Response) => {
      res.sendFile(path.join(distPath, "index.html"));
    });
  }

  server.listen(PORT, HOST, () => {
    console.log(`Autora server running on http://${HOST}:${PORT}`);
  });
}

startServer().catch((err) => {
  console.error("Failed to start Autora server:", err);
  process.exit(1);
});
