/**
 * What the agent can actually do.
 *
 * One registry, and it is the only answer to that question. The system prompt
 * is generated from it, the model's tool schemas are generated from it, the
 * Settings panel renders from it, and the executor dispatches through it. There
 * is deliberately no second list: the failure this module exists to end was a
 * console that advertised a terminal in its memory graph, described one in its
 * README, drew one in the transcript, and had no way to run a command.
 *
 * Four groups. The first three are three genuinely different machines:
 *
 *   terminal  -- the host Autora itself runs on. In the Umbrel container that
 *                is the container, and `sudo` there is usually unnecessary
 *                rather than unavailable.
 *   browser   -- a real Chromium this server drives (see ./browser.ts).
 *   computer  -- somebody's actual desktop, over the relay (see ./desktop.ts).
 *   memory    -- the workspace graph, which outlives the session.
 *
 * A group can be *off* (nobody turned it on) or *unavailable* (turned on, but
 * the thing it needs is not there -- no Chromium installed, no relay dialled
 * in). Those are different sentences and the agent is told which it is, because
 * "I can't browse" and "Chromium isn't installed on the server" send the reader
 * to two very different places.
 */

import type { TodoResult } from "./todos";
import type { LedgerResult } from "./ledger";
import type { RequirementResult } from "./requirements";
import { checkEntry } from "./mindrules";
import { officeDir, runOfficeTool } from "./office";
import type { Phase } from "./modes";
import { callMcpTool, mcpTools, statusOf as mcpStatusOf } from "./mcp";
import { existing as existingMcp, install as installMcp, noteDeclined, overview as mcpOverview, planOffer, wasDeclined } from "./mcpoffer";
import {
  PREFIX as CUSTOM_PREFIX, customEnv, defineCustomTool, deleteCustomTool, getCustomTool,
  listCustomTools, missingArgs, noteCustomRun,
} from "./customtools";
import { spawn } from "node:child_process";
import { searchCode } from "./codesearch";
import { readFile } from "./readfile";
import type { EditArgs, EditResult } from "./editfile";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { GoogleGenAI } from "@google/genai";
import { MANUAL_IDS, manualText, windowsOverview, type ManualId } from "./handbook";
import { termAgentBegin, termAgentChunk, termAgentEnd, termCwd, termNews } from "./termdesk";
import { mergeTools, save, state, allSecrets, keyFor, secretFor, redactSecrets as redactStored } from "./state";
import { APP_GUIDE, BROWSING_GUIDE, MEMORY_GUIDE, OFFICE_GUIDE, TODO_GUIDE, VOICE_GUIDE, WINDOWS_GUIDE } from "./guides";
import { credentialsBriefing, fillPlaceholders, hasPlaceholder, identityEnv, redactCredentials } from "./credentials";
import type { ChatImage } from "./llm";
import { frameImage, latestFrame } from "./liveview";
import { htmlToText, textParts } from "./pages";
import { probeBrowser, VIEWPORT, type LiveBrowser, type PageRead, type UploadFile } from "./browser";
import { describeCaptchas } from "./pagedescribe";
import { parseCookieExport, sitesOf } from "./cookies";
import { recordSignIn, signInBriefing } from "./signins";
import { relayAction, relayConnected, relayStatus } from "./desktop";
import { CONTEXT_CONFIG, readVault } from "./context";
import {
  artifactPath, cleanName, deleteArtifact, formatSize, getArtifact, isText, listArtifacts,
  readArtifact, saveArtifact, MAX_ARTIFACT_BYTES,
} from "./artifacts";
import { checkWidget } from "./widgets";
import { deskHooks } from "./pdfdesk";
import { officeHooks } from "./officedesk";
import { runPdfTool } from "./pdf";
import { runVideoTool } from "./opencut";
import { runStudioTool, studioBriefing } from "./studio";
import {
  addEntries, createNotebook, describeNotebook, findNotebook, listNotebooks, moveEntry,
  notebookLine, notebookMarkdown, removeEntry, updateEntry, updateNotebook, type Notebook,
} from "./notebooks";
import {
  AgentError, agentLine, createAgent, deleteAgent, findAgent, HIRING, listAgents, mergeAgents, moveAgent, orgBriefing,
  updateAgent, LEAD_ID,
} from "./agents";
import { remember, type NoteKind } from "./agentmind";
import { ThreadError, addComment, createPost, describePost, getPost, listPosts, postLine, toggleLike } from "./threads";
import { describe as describeJob, findJob, listJobs, readTail, startJob, stopJob } from "./background";
import { addRule, listRules, revoke as revokeRule } from "./autonomy";
import { get as getInventory } from "./inventory";
import { speechStatus } from "./speech";
import {
  MAX_WIDGET_CHARS, WIDGET_DEFAULT_HEIGHT, WIDGET_MAX_HEIGHT, WIDGET_MIN_HEIGHT, widgetDocument,
} from "../src/lib/widget";

/** What one speak call may say: a few paragraphs, the same ceiling the voice
    server route holds a sentence to. */
const MAX_SPOKEN_CHARS = 2_000;

/** Blank out stored secrets and the person's saved credentials. The one
    redactor lives in credentials.ts; this is the local name for it. */
export function redactForModel(text: string): string {
  return redactCredentials(redactStored(text));
}

// --------------------------------------------------------------- settings --

type ApprovalMode = "always" | "risky" | "never";

interface ToolSettings {
  terminal: {
    enabled: boolean;
    /** Where commands run. Empty means the server's own working directory. */
    cwd: string;
    /** Seconds before a command is killed. */
    timeout: number;
    approval: ApprovalMode;
    shell?: string;
  };
  browser: { enabled: boolean; approval: ApprovalMode };
  computer: { enabled: boolean; approval: ApprovalMode };
  memory: { enabled: boolean; approval: ApprovalMode };
  voice: { enabled: boolean; approval: ApprovalMode };
  widgets: { enabled: boolean };
  app: { enabled: boolean };
  pdf: { enabled: boolean };
  video: { enabled: boolean };
  studio: { enabled: boolean };
  pages: { enabled: boolean };
  sheets: { enabled: boolean };
  slides: { enabled: boolean };
  cad: { enabled: boolean };
  game: { enabled: boolean };
  photo: { enabled: boolean };
}

export function toolSettings(): ToolSettings {
  return state.tools;
}

/**
 * Where commands run when nothing more specific is asked: the directory
 * chosen in Settings, else AUTORA_WORKDIR, else the server's own.
 *
 * The Umbrel app sets AUTORA_WORKDIR=/host -- the host's filesystem, mounted
 * so the agent can work on the server it lives on -- and nothing read it, so
 * every command started in the app's own install directory instead.
 */
export function terminalDir(): string {
  const chosen = toolSettings().terminal.cwd.trim();
  if (chosen) return chosen;
  const fromEnv = (process.env.AUTORA_WORKDIR || "").trim();
  if (fromEnv) {
    try {
      if (fs.statSync(fromEnv).isDirectory()) return fromEnv;
    } catch {
      // Named but not there: the server's own directory, as before.
    }
  }
  return process.cwd();
}

/** Apply a patch from the settings panel and persist it. The merge itself
    lives with the settings file, since the file needs the same validation. */
export function updateToolSettings(patch: any): ToolSettings {
  const next = mergeTools(state.tools, patch);
  save();
  return next;
}

import { terminalSPECS } from "./specs/terminal";
import { scheduleSPECS } from "./specs/schedule";
import { browserSPECS } from "./specs/browser";
import { computerSPECS } from "./specs/computer";
import { personSPECS } from "./specs/person";
import { voiceSPECS } from "./specs/voice";
import { filesSPECS } from "./specs/files";
import { memorySPECS } from "./specs/memory";
import { videoSPECS } from "./specs/video";
import { studioSPECS } from "./specs/studio";
import { cadSPECS } from "./specs/cad";
import { gameSPECS } from "./specs/game";
import { gameAvailable, gameBriefing, runGameTool } from "./gamedesk";
import { cadAvailable, cadBriefing, runCadTool } from "./caddesk";
import { photoSPECS } from "./specs/photo";
import { photoAvailable, photoBriefing, runPhotoTool } from "./photodesk";

// ------------------------------------------------------------- the registry --

export type ToolGroup = "terminal" | "browser" | "computer" | "memory" | "voice" | "schedule";

/** A question for the person, drawn as a card in the thread. */
export type AskRequest = {
  /** "browser" is a sign-in or similar handed over in the live page;
      "offer" is the agent offering to set up an MCP server. */
  kind: "question" | "browser" | "offer";
  title: string;
  detail?: string;
  options: { label: string; detail?: string }[];
  multi: boolean;
  allowText: boolean;
  placeholder?: string;
  /** Checked about once a second while the question is open. A string back
      settles it without the person: the thing they were asked to do has
      visibly been done, and saying so would only be a second chore. */
  watch?: () => Promise<string | null>;
  /** For an offer: what would be set up, drawn on the card. */
  offer?: {
    name: string;
    title: string;
    summary: string;
    runs: string;
    kind: string;
    needs: { env: string; label: string; url?: string; hint?: string; optional?: boolean; set: boolean }[];
  };
};
export type AskAnswer = { cancelled: boolean; choices: string[]; text: string; who: string };

export interface ToolSpec {
  name: string;
  /** "person" and "files" are not settings: asking is always possible, and
      so is handing over or reading back an artifact. */
  group: ToolGroup | "person" | "files" | "mcp";
  /** What the model is told this does. Written for the model, not the UI. */
  description: string;
  /** JSON Schema for the arguments. Every vendor accepts this shape. */
  parameters: {
    type: "object";
    properties: Record<string, any>;
    required?: string[];
  };
  /** True for anything that changes the world rather than reading it. These
      are what `approval: "risky"` gates. */
  risky?: boolean;
}

/* One array of 81 entries used to live here. It is now one file per group
   under server/specs/, each holding the same specs in the same order; they are
   joined here in the order the groups first appeared, so the tool list the
   model sees is the same list it always was. */
const TOOLS: ToolSpec[] = [
  ...terminalSPECS,
  ...scheduleSPECS,
  ...browserSPECS,
  ...computerSPECS,
  ...personSPECS,
  ...voiceSPECS,
  ...filesSPECS,
  ...cadSPECS,
  ...gameSPECS,
  ...photoSPECS,
  ...memorySPECS,
  ...videoSPECS,
  ...studioSPECS,
];

// ------------------------------------------------------------ availability --

interface GroupState {
  group: ToolGroup;
  label: string;
  enabled: boolean;
  available: boolean;
  /** One sentence: what this is, or why it cannot be used. */
  detail: string;
  approval: ApprovalMode;
  tools: string[];
}

const LABELS: Record<ToolGroup, string> = {
  terminal: "Terminal",
  browser: "Web browser",
  computer: "Computer control",
  memory: "Memory",
  voice: "Voice",
  /* Not a setting and so not in groupStates: scheduling, background work and
     the rest of what happens outside the turn are simply always on. */
  schedule: "Beyond the turn",
};

/**
 * Which groups are on, and which of those can actually be used right now.
 *
 * Asked on every turn, so the browser probe is the cached one from
 * ./browser.ts rather than a fresh launch attempt.
 */
export async function groupStates(): Promise<GroupState[]> {
  const settings = toolSettings();
  const names = (group: ToolGroup) =>
    TOOLS.filter((t) => t.group === group).map((t) => t.name);

  const browserProbe = settings.browser.enabled
    ? await probeBrowser()
    : { ok: false, detail: null };

  const relay = relayStatus();

  return [
    {
      group: "terminal",
      label: LABELS.terminal,
      enabled: settings.terminal.enabled,
      available: settings.terminal.enabled,
      detail: settings.terminal.enabled
        ? `A real shell on this host, as ${os.userInfo().username}, in ${terminalDir()}.`
        : "No commands can run, and the agent is told so rather than left to guess.",
      approval: settings.terminal.approval,
      tools: names("terminal"),
    },
    {
      group: "browser",
      label: LABELS.browser,
      enabled: settings.browser.enabled,
      available: settings.browser.enabled && browserProbe.ok,
      detail: !settings.browser.enabled
        ? "The agent cannot open pages."
        : browserProbe.ok
          ? `Chromium, driven by the agent at ${VIEWPORT.width}×${VIEWPORT.height} and streamed back to you.`
          : browserProbe.detail ?? "No browser is installed on this server.",
      approval: settings.browser.approval,
      tools: names("browser"),
    },
    {
      group: "computer",
      label: LABELS.computer,
      enabled: settings.computer.enabled,
      available: settings.computer.enabled && relayConnected(),
      detail: !settings.computer.enabled
        ? "The agent cannot see or touch any desktop."
        : relay.connected
          ? `Relay connected${relay.platform ? ` from ${relay.platform}` : ""}${
              relay.screen.w ? ` · ${relay.screen.w}×${relay.screen.h}` : ""}${
              relay.canControl ? "" : " · screen capture only, input not permitted"}.`
          : "No relay is connected. Run the relay on the machine you want controlled.",
      approval: settings.computer.approval,
      tools: names("computer"),
    },
    {
      group: "voice",
      label: LABELS.voice,
      enabled: settings.voice.enabled,
      available: settings.voice.enabled,
      detail: settings.voice.enabled
        ? "The agent can say something out loud on this page, in the console's own voice."
        : "The agent cannot make this page say anything. Replies read out in talk mode are unaffected.",
      approval: settings.voice.approval,
      tools: names("voice"),
    },
    {
      group: "memory",
      label: LABELS.memory,
      enabled: settings.memory.enabled,
      // Nothing outside the process to check: the graph is always there.
      available: settings.memory.enabled,
      detail: settings.memory.enabled
        ? "The workspace memory graph, which survives sessions and restarts."
        : "The agent cannot write anything down between sessions.",
      approval: settings.memory.approval,
      tools: names("memory"),
    },
  ];
}

/** A tool that lives in a built-in window the Tools page has switched off. */
export function windowOff(name: string, settings: ToolSettings = toolSettings()): boolean {
  if (name === "widget_show") return !settings.widgets.enabled;
  if (name === "app_preview") return !settings.app.enabled;
  if (name.startsWith("pdf_")) return !settings.pdf.enabled;
  if (name.startsWith("video_")) return !settings.video.enabled;
  if (name.startsWith("studio_")) return !settings.studio.enabled;
  // Built by autora-3d/ (npm run build); a server without it does not offer tools that cannot work.
  if (name.startsWith("cad_")) return !cadAvailable() || !settings.cad.enabled;
  // Built by gdevelop-editor/ (npm run build): the same.
  if (name.startsWith("game_")) return !gameAvailable() || !settings.game.enabled;
  // Built by scripts/build-photo.mjs (PhotoCraft's editor and command line): the same.
  if (name.startsWith("photo_")) return !photoAvailable() || !settings.photo.enabled;
  // Built by scripts/build-office.mjs; a server without the build does not offer tools that cannot work.
  if (name.startsWith("office_")) return !officeDir() || !(settings.pages.enabled || settings.sheets.enabled || settings.slides.enabled);
  return false;
}

/** The tools to offer the model this turn: enabled, and actually usable. */
export async function availableTools(): Promise<ToolSpec[]> {
  const groups = await groupStates();
  const usable = new Set(groups.filter((g) => g.available).map((g) => g.group));
  const settings = toolSettings();
  return [
    ...TOOLS.filter((t) => !windowOff(t.name, settings) && (
      t.group === "person" || t.group === "files" || t.group === "schedule" ||
      /* Muting the voice is the one thing that survives having muted it: a
         tool that takes itself away with the thing it turns off would leave
         no way back except the settings panel. */
      t.name === "voice_mute" ||
      usable.has(t.group as ToolGroup))),
    ...(usable.has("terminal") ? customSpecs() : []),
    ...mcpSpecs(),
  ];
}

export function findTool(name: string): ToolSpec | undefined {
  return TOOLS.find((t) => t.name === name) ??
    customSpecs().find((t) => t.name === name) ??
    mcpSpecs().find((t) => t.name === name);
}

/** Tools the agent wrote (see ./customtools.ts), in the registry's shape. */
function customSpecs(): ToolSpec[] {
  return listCustomTools().map((t) => ({
    name: `${CUSTOM_PREFIX}${t.name}`,
    group: "terminal" as const,
    description: `${t.description} (A tool you wrote earlier; runs a saved shell script.)`,
    parameters: {
      type: "object" as const,
      properties: Object.fromEntries(t.params.map((p) => [p.name, { type: "string", description: p.description }])),
      required: t.params.filter((p) => p.required).map((p) => p.name),
    },
    risky: true,
  }));
}

/** Tools from connected MCP servers, in the registry's own shape. */
function mcpSpecs(): ToolSpec[] {
  return mcpTools().map((t) => ({
    name: t.name,
    group: "mcp" as const,
    description: t.description,
    parameters: t.parameters,
  }));
}

/**
 * Does this call need a human to say yes first?
 *
 * No: Autora runs in yolo mode, from one call to the next, with no card in
 * the chat. This reads the per-group setting ("always", "risky", "never"),
 * but mergeTools in server/state.ts pins every group to "never", so an older
 * settings file that says otherwise cannot bring the cards back.
 *
 * Asking is the chat's own choice instead (server/modes.ts), applied in
 * server.ts. Beyond it, the guard and the irrecoverable tier still stop and
 * ask, exactly as before.
 */
export function needsApproval(spec: ToolSpec): boolean {
  const group = spec.group;
  /* "person", "files", "schedule" and "mcp" are not settings: nobody turns
     handing over, reading an artifact or asking a question off. */
  if (group !== "terminal" && group !== "browser" && group !== "computer" && group !== "memory" && group !== "voice") return false;
  const approval = toolSettings()[group]?.approval;
  if (approval === "always") return true;
  if (approval === "risky") return Boolean(spec.risky);
  return false;
}

/** The exact thing being asked for, for the approval card. Never a summary:
    the entire value of the prompt is reading precisely what will happen. */
export function renderCall(spec: ToolSpec, args: Record<string, any>): string {
  switch (spec.name) {
    case "terminal":
      return String(args.command ?? "");
    case "browser_open":
      return `open ${args.url}`;
    case "browser_click":
      return `click element [${args.ref}] on the open page`;
    case "browser_fill": {
      const rows = Array.isArray(args.values) ? args.values : [];
      const shown = rows
        .map((v: any) => `[${v?.ref}] ← ${JSON.stringify(String(v?.text ?? ""))}`)
        .join(", ");
      return `fill ${shown}${args.submit ? ", then submit" : ""}`;
    }
    case "computer_click":
      return `${args.double ? "double-click" : "click"} the desktop at ${
        args.x},${args.y}${args.button && args.button !== "left" ? ` (${args.button})` : ""}`;
    case "computer_move":
      return `move the desktop pointer to ${args.x},${args.y}`;
    case "computer_type":
      return `type on the desktop: ${JSON.stringify(String(args.text ?? ""))}`;
    case "computer_key":
      return `press ${(Array.isArray(args.keys) ? args.keys : [args.keys]).join(" then ")}`;
    case "computer_scroll":
      return `scroll the desktop by ${args.dy}`;
    case "memory_write":
      return `remember "${args.title}": ${args.body}`;
    case "tool_create":
      return `save tool ${CUSTOM_PREFIX}${String(args.name ?? "").replace(CUSTOM_PREFIX, "")}:\n${args.script}`;
    case "memory_update":
      return `update memory ${args.id}`;
    case "memory_forget":
      return `forget memory ${args.id}${args.replaced_by ? ` (replaced by ${args.replaced_by})` : ""}`;
    case "read_file":
      return `read ${args.path}${args.symbol ? ` (${args.symbol})` : args.outline ? " (outline)" : ""}`;
    case "vault_read":
      return args.search
        ? `search vault artifact ${args.id} for "${args.search}"`
        : `read vault artifact ${args.id}`;
    case "browser_captcha":
      return "tick the checkbox CAPTCHA on the open page";
    case "browser_eval":
      return `run in the page: ${String(args.script ?? "").split("\n")[0]}`;
    case "browser_upload":
      return `attach ${(Array.isArray(args.ids) ? args.ids : [args.ids]).join(", ")} to element [${args.ref}] on the open page`;
    case "browser_press":
      return `press ${Array.isArray(args.keys) ? args.keys.join(", ") : args.keys}`;
    case "browser_signin_import":
      return `import a sign-in from uploaded file ${args.id}`;
    case "browser_handoff":
      return `handoff browser control: ${args.reason}`;
    case "http_request":
      return `${args.method || "GET"} ${args.url}`;
    case "web_search":
      return `search web for "${args.query}"`;
    case "image_generate":
      return `generate image: "${args.prompt}"`;
    case "artifact_save":
      return `save artifact ${args.name}${args.notebook ? ` into notebook "${args.notebook}"` : ""}`;
    case "notebook":
      return `notebook ${args.action ?? ""}${args.notebook ? ` "${args.notebook}"` : args.title ? ` "${args.title}"` : ""}`;
    case "agents":
      return `agents ${args.action ?? ""}${args.agent ? ` "${args.agent}"` : ""}`;
    case "thread":
      return `threads ${args.action ?? ""}${args.title ? ` "${args.title}"` : ""}`;
    case "tool_manual":
      return `read the ${args.window} manual`;
    case "widget_show":
      return `show widget "${args.title}"`;
    case "speak":
      return `say aloud: ${JSON.stringify(String(args.text ?? ""))}`;
    case "voice_mute":
      return String(args.muted) === "false"
        ? "unmute the voice"
        : "mute the voice: stop saying things out loud";
    case "camera_look":
      return "look through the camera";
    case "artifact_read":
      return `read artifact ${args.id}`;
    default: {
      const rest = Object.keys(args).length ? ` ${JSON.stringify(args)}` : "";
      return `${spec.name}${rest}`;
    }
  }
}

// ---------------------------------------------------------------- running --

/** Everything the executor needs from the session it is running in, passed in
    rather than imported, so this module stays independent of the server. */
/** A scheduled task or watcher, as the agent sees it. The records are the
    server's; this is what it is told about them. */
export interface AgentJob {
  id: string;
  name: string;
  cron: string;
  prompt: string;
  enabled: boolean;
  watch: { kind: string; target: string } | null;
  next_run: number | null;
  last_run: number | null;
  last_error: string | null;
  cron_error: string | null;
  running: boolean;
}

/** What the agent asks of a job: only the fields it may set. */
export interface AgentJobInput {
  name?: string;
  cron?: string;
  prompt?: string;
  watch?: { kind: string; target: string } | null;
  enabled?: boolean;
}

export interface ToolContext {
  /** A line of live output, as it arrives. */
  onOutput: (chunk: string) => void;
  /** Stash a picture and return its blob id. */
  putBlob: (data: Buffer, mime: string) => string;
  /** Show a picture in the conversation. */
  showImage: (blob: string, alt: string, caption: string | null, size?: { w: number; h: number }) => void;
  /** Show a file a tool made (an artifact) in the conversation, to open or download. */
  showFile?: (file: { id: string; name: string; mime: string; size: number }) => void;
  /** Say something aloud on the page the person has open. */
  speak?: (text: string) => void;
  /** Stop or start the page saying things aloud, at once -- what the speak
      tool's own mute does, so the sound stops in the same breath as the
      setting rather than at the next turn. */
  mute?: (muted: boolean) => void;
  /** Show an interactive widget in the conversation. */
  showWidget: (widget: { title: string; html: string; height: number; artifact?: string }) => void;
  /** Show a picture of the browser or desktop in the card already showing
      that screen, rather than as a card of its own beside it. */
  showScreen: (source: "browser" | "desktop", blob: string, size?: { w: number; h: number }) => void;
  /** The session's browser, made on first use. */
  browser: () => LiveBrowser;
  /** The browser's state changed; tell the watchers. */
  browserChanged: () => void;
  /** Start forwarding desktop frames to this session. */
  watchDesktop: () => void;
  /** Change a file so that what the person saved meanwhile is kept (see
      server/editfile.ts). Absent where there is no folder to work in. */
  code?: { edit: (args: EditArgs) => EditResult };
  /** Why something the person is using may not be touched right now (see
      server/presence.ts), or null. `subject` is an object id or a file. */
  held?: (surface: "pdf" | "office" | "app" | "browser" | "code" | "video", subject: string) => string | null;
  /** Hand a question to a research worker with its own context (see
      server/subagent.ts) and get its report back. Absent inside the worker. */
  research?: (question: string) => Promise<string>;
  /** The organization (server/agents.ts): which agent this turn is, and a way
      to start another one on a task and wait for its report. */
  agents?: {
    self: { id: string; name: string };
    run: (agent: string, task: string) => Promise<{ ok: boolean; summary: string }>;
    /** The mind of whoever is asking: where its knowledge clusters, and handing a body of it to an agent. */
    mind: {
      domains: () => string;
      teach: (agent: string, query: string, move: boolean) => { ok: boolean; summary: string };
    };
  };
  /** True once the turn has been interrupted; long tools should give up. */
  cancelled: () => boolean;
  /** Register a kill switch so an interrupt can stop a running command. */
  onCancel: (stop: () => void) => void;
  /** The memory graph, which the server owns. */
  memory: {
    /** True in an incognito chat: a read is fine, a write is refused, because
        nothing in that chat is written down anywhere. */
    incognito?: boolean;
    write: (entry: {
      title: string; body: string; kind: string; tags?: string[]; subject?: string; facet?: string;
      source?: string; version?: string; status?: "confirmed" | "provisional";
    }) => { id: string; action: string };
    search: (query: string) => {
      id: string; kind: string; title: string; body: string; status: string; subject?: string; source?: string; fetched?: number;
    }[];
    /** true when changed, false when there is no such memory, or why the change was refused. */
    update: (id: string, patch: {
      title?: string; body?: string; kind?: string; tags?: string[]; subject?: string; facet?: string; source?: string; version?: string;
    }) => boolean | string;
    /** Say that a memory still holds, and stamp it checked today. */
    confirm: (id: string, note?: string) => boolean;
    forget: (id: string, replacedBy?: string | null) => boolean;
  };
  /** A tool output this session kept out of the prompt, by artifact id. */
  vault: (id: string) => string | null;
  /** The session the call runs in, so what it makes can say where from. */
  session: string;
  /** The Schedule page's jobs, so the agent can set up its own. */
  jobs?: {
    list: () => AgentJob[];
    create: (input: AgentJobInput & { name: string; cron: string; prompt: string }) =>
      { id: string | null; error: string | null };
    update: (id: string, patch: AgentJobInput) => { ok: boolean; error: string | null };
    remove: (id: string) => boolean;
  };
  /** Put a question to the person and wait for the answer. */
  ask: (request: AskRequest) => Promise<AskAnswer>;
  /** The session's to-do list: what the person watches the work tick off.
      Absent where there is no session to show one in. */
  todos?: (action: Record<string, any>) => TodoResult;
  /** Folders that are Autora's own data, never read or edited as the agent's files. */
  protectedPaths?: string[];
  /** Bring in a set of tools (see toolload.ts); says what came in. */
  enableTools?: (family: string) => { ok: boolean; summary: string };
  /** The chat's working notes (see ledger.ts). */
  ledger?: (action: Record<string, any>) => LedgerResult;
  /** What the person asked for, kept whole (see requirements.ts). */
  requirements?: (action: Record<string, any>) => RequirementResult;
  /** The app window: what the agent builds, shown beside the conversation. */
  preview?: {
    start: (args: { command?: string; cwd?: string; dir?: string; url?: string; port?: number }) => Promise<{ ok: boolean; summary: string }>;
    stop: () => Promise<{ ok: boolean; summary: string }>;
    reload: () => Promise<{ ok: boolean; summary: string }>;
    look: () => Promise<{ ok: boolean; summary: string; png?: Buffer }>;
    /** Use the page as a person would: click, hover, type, press a key, scroll. */
    act: (args: { action: string; target?: string; text?: string; key?: string; dy?: number; submit?: boolean }) => Promise<{ ok: boolean; summary: string; png?: Buffer }>;
  };
  /** Agent mode's switch between planning and building. Absent where there is
      no session to switch. */
  setPhase?: (to: Phase, reason: string) => { ok: boolean; summary: string };
}

interface ToolOutcome {
  ok: boolean;
  /** What the model is told came back. */
  summary: string;
  /** For the transcript card, where it differs from the summary. */
  preview?: string;
  exitCode?: number;
  /** Pictures that came back with the result, which the model is handed
      rather than told about. The tool was asked for a look, and text about a
      picture is not a look. */
  images?: ChatImage[];
  /** Not done because the person is using it: said to the agent, and never
      counted as a failure. */
  held?: boolean;
}

/**
 * The page, as the model reads it: what is on screen to act on, and the
 * page's main content one part at a time. Only browser_read asks for a part
 * past the first; every action answers with the first, which is what a
 * page that has just changed is most likely to have changed.
 */
function describePage(page: PageRead, part = 1): string {
  const parts = textParts(page.text);
  const k = Math.min(Math.max(1, Math.floor(part) || 1), parts.length);
  const head = parts.length === 1
    ? "Text:"
    : k < parts.length
      ? `Text (part ${k} of ${parts.length}; browser_read with part ${k + 1} for the next):`
      : `Text (part ${k} of ${parts.length}, the last):`;
  return [
    `Page: ${page.title || "(untitled)"}`,
    `URL: ${page.url}`,
    "",
    "Interactive elements:",
    page.outline || "(nothing interactive on screen)",
    ...(page.captchas.length ? ["", describeCaptchas(page.captchas)] : []),
    ...(page.challenge ? ["", challengeNote(page.challenge)] : []),
    ...(page.blocked ? ["", refusalNote(page.blocked)] : []),
    "",
    head,
    parts[k - 1] || "(no text)",
  ].join("\n");
}

/**
 * What the model is told when Cloudflare is deciding about this browser.
 *
 * The page is a holding screen with nothing on it, which reads as a broken
 * page: it is not, and it is not the thing to send the person to either --
 * the check passes on its own for a browser it trusts, and it trusts this one
 * more often than it used to.
 */
function challengeNote(title: string): string {
  return (
    `CLOUDFLARE CHECK: the page is "${title}" -- Cloudflare is deciding about this ` +
    "browser and does not want anything clicked. Give it half a minute: passing on its own is what it " +
    "does when it is going to pass, and there is nothing on the page to act on until it does. If it " +
    "is still there after that, hand the browser to the person with browser_handoff -- a person passing " +
    "it once also earns this profile the site's clearance cookie, which then lasts hours."
  );
}

/** What the model is told when a site turns this browser's sign-in away. */
export function refusalNote(said: string): string {
  return (
    `SIGN-IN REFUSED: the site says "${said}". It is refusing this browser, not ` +
    "the password, so retrying, retyping or handing the page to the person will " +
    "not get past it. Stop and tell the person, and offer the ways that do " +
    "work: they sign in to the site in their own browser, export its cookies " +
    "(Cookie-Editor extension: Export, JSON) and upload the file, which you then " +
    "load with browser_signin_import; or, if their desktop is connected, do it " +
    "on their own computer with the computer tools; or use the service's API " +
    "with a token or app password if it has one."
  );
}

/** What an action did, above the page it left: one line per field filled. */
function withNotes(page: PageRead, lead: string): string {
  const notes = page.notes?.length ? `\n${page.notes.map((n) => `- ${n}`).join("\n")}` : "";
  return `${lead}${notes}\n\n${describePage(page)}`;
}

/** A key as the model might write it, as Playwright names it: "esc" is
    Escape, "ctrl+a" is Control+A, "down" is ArrowDown. */
export function keyName(raw: string): string {
  const alias: Record<string, string> = {
    esc: "Escape", escape: "Escape", enter: "Enter", return: "Enter", tab: "Tab",
    space: "Space", spacebar: "Space", backspace: "Backspace", delete: "Delete", del: "Delete",
    up: "ArrowUp", down: "ArrowDown", left: "ArrowLeft", right: "ArrowRight",
    arrowup: "ArrowUp", arrowdown: "ArrowDown", arrowleft: "ArrowLeft", arrowright: "ArrowRight",
    pageup: "PageUp", pagedown: "PageDown", pgup: "PageUp", pgdn: "PageDown",
    home: "Home", end: "End", ctrl: "Control", control: "Control", cmd: "Meta",
    command: "Meta", meta: "Meta", alt: "Alt", option: "Alt", shift: "Shift",
  };
  return raw
    .trim()
    .split("+")
    .map((part) => {
      const p = part.trim();
      if (!p) return "";
      return alias[p.toLowerCase().replace(/[\s_-]/g, "")] ?? (p.length === 1 ? p : p[0].toUpperCase() + p.slice(1));
    })
    .filter(Boolean)
    .join("+");
}

function candidateShells(): string[] {
  const settings = toolSettings().terminal;
  const list: string[] = [];
  if (settings.shell?.trim()) list.push(settings.shell.trim());
  if (process.env.AUTORA_SHELL?.trim()) list.push(process.env.AUTORA_SHELL.trim());
  if (process.env.SHELL?.trim()) list.push(process.env.SHELL.trim());
  list.push("/bin/bash", "bash", "/bin/ash", "ash", "/bin/sh", "sh");
  return Array.from(new Set(list));
}

/**
 * Run one command, streaming its output.
 *
 * Pipes, not a PTY. Shell is resolved with automatic fallback across bash, ash, and sh
 * to handle minimal containers without crashing with ENOENT. All workspace secrets
 * are automatically injected into the process environment.
 */
function runCommand(
  command: string,
  cwd: string,
  timeoutSeconds: number,
  ctx: ToolContext,
  extraEnv: Record<string, string> = {},
  /** Output in colour, for a person watching a terminal rather than a model reading it. */
  color = false,
): Promise<ToolOutcome> {
  const candidates = candidateShells();
  const secrets = allSecrets();
  const workingDir = cwd || terminalDir();
  /* A missing directory fails the spawn with the same ENOENT as a missing
     shell, which sent this through every shell in the list and ended with
     "no usable shell found" -- true of none of them. */
  if (!fs.existsSync(workingDir) || !fs.statSync(workingDir).isDirectory()) {
    return Promise.resolve({
      ok: false,
      summary: `Could not run that: the directory ${workingDir} does not exist on this machine.`,
    });
  }

  const tryShell = (candidateIdx: number): Promise<ToolOutcome> => {
    if (candidateIdx >= candidates.length) {
      return Promise.resolve({
        ok: false,
        summary: "Could not start a shell: no usable shell found on this system.",
      });
    }

    const shell = candidates[candidateIdx];
    return new Promise<ToolOutcome>((resolve) => {
      let child: any;
      let timer: any = null;
      let killedBy: "timeout" | "user" | null = null;
      /* What the model reads back: the start and the end of the output.
         Only the start used to be kept, so a build that printed 30 KB and
         then its error handed the model 24 KB of progress lines and no
         error. The whole of it is in the transcript either way. */
      const HEAD = 8_000;
      const TAIL = 16_000;
      let head = "";
      let tail = "";
      let omitted = 0;
      let spawnedOk = false;

      const killGroup = () => {
        if (!child?.pid) return;
        try {
          process.kill(-child.pid, "SIGKILL");
        } catch {
          try {
            child.kill("SIGKILL");
          } catch {}
        }
      };

      try {
        child = spawn(shell, ["-lc", command], {
          cwd: workingDir,
          detached: true,
          env: {
            ...process.env,
            ...secrets,
            ...identityEnv(),
            ...extraEnv,
            PATH: process.env.PATH || "/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin",
            ...(color
              ? { TERM: "xterm-256color", FORCE_COLOR: "1", CLICOLOR_FORCE: "1", COLORTERM: "truecolor" }
              : { TERM: "dumb", NO_COLOR: "1" }),
            PAGER: "cat",
            GIT_PAGER: "cat",
            DEBIAN_FRONTEND: "noninteractive",
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
      } catch (err: any) {
        return resolve(tryShell(candidateIdx + 1));
      }

      timer = setTimeout(() => {
        killedBy = "timeout";
        killGroup();
      }, timeoutSeconds * 1000);
      timer.unref?.();

      ctx.onCancel(() => {
        if (killedBy) return;
        killedBy = "user";
        killGroup();
      });

      const take = (chunk: Buffer) => {
        spawnedOk = true;
        const text = chunk.toString("utf8");
        const safeText = redactForModel(text);
        ctx.onOutput(safeText);
        let rest = safeText;
        if (head.length < HEAD) {
          const room = HEAD - head.length;
          head += rest.slice(0, room);
          rest = rest.slice(room);
        }
        if (rest) {
          tail += rest;
          if (tail.length > TAIL) {
            omitted += tail.length - TAIL;
            tail = tail.slice(-TAIL);
          }
        }
      };

      child.stdout?.on("data", take);
      child.stderr?.on("data", take);

      child.on("error", (err: any) => {
        clearTimeout(timer);
        if (!spawnedOk && (err.code === "ENOENT" || String(err?.message ?? "").includes("ENOENT"))) {
          // Fallback to next shell candidate
          return resolve(tryShell(candidateIdx + 1));
        }
        resolve({ ok: false, summary: `Could not run that: ${redactForModel(err?.message ?? err)}` });
      });

      child.on("close", (code: number | null, signal: string | null) => {
        clearTimeout(timer);
        const exit = code ?? (signal ? 128 : 0);
        const collected = omitted > 0
          ? `${head}\n\n[... ${omitted.toLocaleString("en-US")} characters of output omitted here ...]\n\n${tail}`
          : head + tail;
        /* Already scrubbed: head and tail were built from safeText as each
           chunk arrived, and the omission marker between them is our own
           words. Redacting again walked the same text a third time. */
        const body = collected.trim();
        const note =
          killedBy === "timeout"
            ? `\n\n[killed after ${timeoutSeconds}s -- it had not finished]`
            : killedBy === "user"
              ? "\n\n[stopped by the person watching]"
              : omitted > 0
                ? "\n\n[output shortened: its start and its end are above; the full output is in the transcript]"
                : "";

        resolve({
          ok: killedBy === null && exit === 0,
          exitCode: exit,
          summary:
            `Exit code ${exit}${killedBy === "timeout" ? " (timed out)" : ""}\n\n` +
            (body || "(no output)") +
            note,
          preview: body.split("\n").slice(-1)[0]?.slice(0, 120) || `exit ${exit}`,
        });
      });
    });
  };

  return tryShell(0);
}

/**
 * A command run with nobody watching: for a watcher checking a command's
 * output. Same shell, secrets and working directory as the terminal tool.
 */
export async function runShellQuiet(command: string, timeoutSeconds = 60): Promise<{ ok: boolean; output: string }> {
  const quiet: Pick<ToolContext, "onOutput" | "onCancel"> = { onOutput: () => undefined, onCancel: () => undefined };
  const outcome = await runCommand(command, terminalDir(), timeoutSeconds, quiet as ToolContext);
  return { ok: outcome.ok, output: outcome.summary };
}

/**
 * How long a request may take, joined to Stop.
 *
 * These fetches had neither: a search engine or an API that accepted the
 * connection and then said nothing held the turn until the operating system
 * gave up on it, and Stop could not reach it, since nothing was listening.
 */
function requestSignal(ctx: Pick<ToolContext, "onCancel" | "cancelled"> | null, ms: number): AbortSignal {
  // Stop has already been pressed: its callbacks have run and will not again.
  if (ctx?.cancelled()) return AbortSignal.abort();
  const timeout = AbortSignal.timeout(ms);
  if (!ctx) return timeout;
  const stop = new AbortController();
  ctx.onCancel(() => stop.abort());
  return AbortSignal.any([timeout, stop.signal]);
}

/** A failed fetch in words: which of the two limits ended it, or why not. */
function fetchFailure(err: any, ms: number): string {
  if (err?.name === "TimeoutError") return `no answer within ${Math.round(ms / 1000)}s`;
  if (err?.name === "AbortError") return "stopped";
  const cause = err?.cause?.code ?? err?.cause?.message;
  return err?.message === "fetch failed" && cause ? `could not connect (${cause})` : String(err?.message ?? err);
}

/** Up to `limit` bytes of a body. A response of unknown size used to be read
    whole into memory, however big it turned out to be. */
async function readCapped(res: Response, limit: number): Promise<{ text: string; truncated: boolean }> {
  const reader = res.body?.getReader();
  if (!reader) return { text: "", truncated: false };
  const chunks: Buffer[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    if (size + value.byteLength > limit) {
      chunks.push(Buffer.from(value.subarray(0, limit - size)));
      await reader.cancel().catch(() => undefined);
      return { text: Buffer.concat(chunks).toString("utf8"), truncated: true };
    }
    chunks.push(Buffer.from(value));
    size += value.byteLength;
  }
  return { text: Buffer.concat(chunks).toString("utf8"), truncated: false };
}

/**
 * Whether a URL is GitHub's API, and so may be sent the saved GitHub token.
 *
 * Decided on the parsed address. It used to be a substring test, so
 * `https://anywhere.example/?api.github.com` -- an address a web page could
 * talk the agent into requesting -- was sent the token too.
 */
export function isGitHubApi(url: string): boolean {
  try {
    const parsed = new URL(url);
    return parsed.protocol === "https:" && parsed.hostname.toLowerCase() === "api.github.com";
  } catch {
    return false;
  }
}

const SEARCH_TIMEOUT_MS = 20_000;
const REQUEST_TIMEOUT_MS = 60_000;
/** More than any page or API answer the model can read; the rest is not fetched. */
const MAX_RESPONSE_BYTES = 5 * 1024 * 1024;

async function searchWeb(query: string, ctx: Pick<ToolContext, "onCancel" | "cancelled"> | null = null): Promise<string> {
  const signal = () => requestSignal(ctx, SEARCH_TIMEOUT_MS);
  const tavilyKey = secretFor("TAVILY_API_KEY") || process.env.TAVILY_API_KEY;
  if (tavilyKey) {
    try {
      const res = await fetch("https://api.tavily.com/search", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ api_key: tavilyKey, query, max_results: 6 }),
        signal: signal(),
      });
      if (res.ok) {
        const data = (await res.json()) as any;
        return (data.results || [])
          .map((r: any) => `### [${r.title}](${r.url})\n${r.content}`)
          .join("\n\n");
      }
    } catch {}
  }

  const braveKey = secretFor("BRAVE_SEARCH_API_KEY") || process.env.BRAVE_SEARCH_API_KEY;
  if (braveKey) {
    try {
      const res = await fetch(
        `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent(query)}&count=6`,
        { headers: { "X-Subscription-Token": braveKey }, signal: signal() },
      );
      if (res.ok) {
        const data = (await res.json()) as any;
        return (data.web?.results || [])
          .map((r: any) => `### [${r.title}](${r.url})\n${r.description}`)
          .join("\n\n");
      }
    } catch {}
  }

  // Fallback web search using DuckDuckGo Instant Answers
  try {
    const res = await fetch(
      `https://api.duckduckgo.com/?q=${encodeURIComponent(query)}&format=json&no_html=1&skip_disambig=1`,
      { headers: { "User-Agent": "Mozilla/5.0 (X11; Linux x86_64)" }, signal: signal() },
    );
    if (res.ok) {
      const data = (await res.json()) as any;
      const results: string[] = [];
      if (data.AbstractText) {
        results.push(`### ${data.Heading || query}\n${data.AbstractText}\nSource: ${data.AbstractURL || ""}`);
      }
      for (const t of data.RelatedTopics || []) {
        if (t.Text && t.FirstURL) {
          results.push(`- [${t.Text}](${t.FirstURL})`);
        }
      }
      if (results.length > 0) return results.join("\n\n");
    }
  } catch {}

  // Fallback html snippet search
  try {
    const res = await fetch(`https://html.duckduckgo.com/html/?q=${encodeURIComponent(query)}`, {
      headers: {
        "User-Agent":
          "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: signal(),
    });
    if (res.ok) {
      const { text: html } = await readCapped(res, MAX_RESPONSE_BYTES);
      const snippets: string[] = [];
      const matches = html.matchAll(
        /<a class="result__snippet[^>]*href="([^"]*)"[^>]*>(.*?)<\/a>/gi,
      );
      for (const m of matches) {
        const cleanText = m[2].replace(/<[^>]+>/g, "").trim();
        if (cleanText) snippets.push(cleanText);
        if (snippets.length >= 5) break;
      }
      if (snippets.length > 0) return snippets.join("\n\n");
    }
  } catch {}

  return `Search for "${query}" completed. No immediate web snippets found.`;
}

async function runHttpRequest(args: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
}, ctx: Pick<ToolContext, "onCancel" | "cancelled"> | null = null): Promise<ToolOutcome> {
  const url = String(args.url || "").trim();
  if (!/^https?:\/\//i.test(url)) {
    return { ok: false, summary: "http_request needs a full http:// or https:// address." };
  }
  const method = (args.method || "GET").toUpperCase();
  const headers: Record<string, string> = {};
  if (args.headers && typeof args.headers === "object") {
    for (const [k, v] of Object.entries(args.headers)) headers[k] = String(v);
  }
  const has = (name: string) => Object.keys(headers).some((k) => k.toLowerCase() === name);

  // If calling GitHub API and GITHUB_TOKEN exists in secret store, inject Authorization
  if (isGitHubApi(url) && !has("authorization")) {
    const ghToken = secretFor("GITHUB_TOKEN") || secretFor("GH_TOKEN");
    if (ghToken) {
      headers["Authorization"] = `Bearer ${ghToken}`;
      if (!has("user-agent")) headers["User-Agent"] = "Autora-Agent";
      if (!has("accept")) headers["Accept"] = "application/vnd.github.v3+json";
    }
  }

  if (!has("user-agent")) {
    headers["User-Agent"] = "Autora/1.0";
  }

  /* The person's saved details, in the address, any header value or the
     body: {{cred:github.com:password}}, {{cred:email}}. Filled in here, the
     way they are in a page, and never carried further -- the request goes out
     with the real value, the transcript and the log keep the placeholder.
     Which sign-in may be used is decided by the site the request is going to,
     so a sign-in saved for one site cannot be spent on another. */
  let target = url;
  let body = args.body;
  try {
    target = fillPlaceholders(url, url);
    for (const [name, value] of Object.entries(headers)) {
      headers[name] = fillPlaceholders(value, target);
    }
    if (body) body = fillPlaceholders(body, target);
  } catch (err: unknown) {
    return { ok: false, summary: `http_request: ${err instanceof Error ? err.message : String(err)}` };
  }

  try {
    const res = await fetch(target, {
      method,
      headers,
      body: ["GET", "HEAD"].includes(method) ? undefined : body,
      signal: requestSignal(ctx, REQUEST_TIMEOUT_MS),
    });

    const status = res.status;
    const statusText = res.statusText;
    const { text: raw, truncated: cut } = await readCapped(res, MAX_RESPONSE_BYTES);
    const type = res.headers.get("content-type") || "unknown";
    /* A web page's HTML is mostly scripts, styles and menus: on a typical
       article the first 20,000 characters hold none of the article at all.
       What the model can use is the text a person would read. */
    const html = /html/i.test(type) || /^\s*(<!doctype html|<html)/i.test(raw);
    const text = html ? htmlToText(raw, url) : raw;
    const cap = html ? 12_000 : 20_000;

    const preview = redactForModel(`${method} ${url} → ${status} ${statusText}`);
    let summary = `HTTP ${status} ${statusText}\n`;
    summary += `Content-Type: ${type}${html ? " (shown as readable text, not HTML)" : ""}\n\n`;
    summary += text.length > cap || cut
      ? text.slice(0, cap) + (html
        ? "\n\n[page truncated here -- open it with browser_open and read on with browser_read's part]"
        : "\n\n[response truncated]")
      : text;

    return {
      ok: res.ok,
      summary: redactForModel(summary),
      preview,
    };
  } catch (err: any) {
    return { ok: false, summary: `HTTP request failed: ${redactForModel(fetchFailure(err, REQUEST_TIMEOUT_MS))}` };
  }
}

/**
 * A picture for the model, or null when it is too big to hand over.
 *
 * Vendors cap a picture at a few megabytes, and a page of photographs shot at
 * the full window can pass that; a call that fails on the request is worse
 * than one that says the picture is only on the person's screen.
 */
function pictureFor(image: Buffer, mime: string): ChatImage | null {
  if (image.byteLength > PICTURE_LIMIT_BYTES) return null;
  return { mime, data: image.toString("base64") };
}

/** Three and a half megabytes: under every vendor's four-to-five, with the
    base64 inflation and the rest of the request to spare. */
const PICTURE_LIMIT_BYTES = 3_500_000;

/** A file name from a sentence: a few lowercase words, hyphenated. */
function slug(text: string): string {
  const words = text.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim().split(" ").slice(0, 6);
  return words.join("-").slice(0, 60) || "image";
}

function artifactLine(a: { id: string; origin: string; name: string; mime: string; size: number; ts: number; note?: string }) {
  const who = a.origin === "user" ? "uploaded by the person" : "made by you";
  const when = new Date(a.ts).toISOString().slice(0, 16).replace("T", " ");
  return `- ${a.id}  ${a.name}  (${a.mime}, ${formatSize(a.size)}, ${who}, ${when})${
    a.note ? ` -- ${a.note.replace(/\s+/g, " ").slice(0, 120)}` : ""}`;
}

/** A screenshot to keep or to see more than the window of. */
async function keepScreenshot(
  live: LiveBrowser,
  ctx: ToolContext,
  opts: { fullPage: boolean; ref?: number; selector: string; area: any; saveAs: string; notebook: string; note: string },
): Promise<ToolOutcome> {
  const area = opts.area
    ? { x: Number(opts.area.x) || 0, y: Number(opts.area.y) || 0, w: Number(opts.area.width) || 0, h: Number(opts.area.height) || 0 }
    : null;
  if (area && (area.w < 2 || area.h < 2)) return { ok: false, summary: "An area needs a width and height of at least 2 pixels." };
  let png: Buffer | null;
  try {
    png = area ? await live.cropShot(area) : await live.screenshot({ fullPage: opts.fullPage, ref: opts.ref, selector: opts.selector || undefined });
  } catch (err: any) {
    const why = String(err?.message ?? err).split("\n")[0];
    return {
      ok: false,
      summary: opts.ref !== undefined
        ? `Could not take a picture of element [${opts.ref}]: ${why}.`
        : opts.selector
        ? `Could not take a picture of "${opts.selector}": ${why}. Check the selector matches something visible (browser_eval can test it).`
        : `Could not take the screenshot: ${why}`,
    };
  }
  if (!png) return { ok: false, summary: "No page is open to take a picture of." };
  const status = live.status();
  const what = opts.ref !== undefined ? `element [${opts.ref}]` : opts.selector ? `"${opts.selector}"` : area ? "that area" : opts.fullPage ? "the whole page" : "the window";
  const blob = ctx.putBlob(png, "image/png");

  let kept = "";
  let caption = `Screenshot of ${what}`;
  if (opts.saveAs || opts.notebook) {
    /* An unnamed one is stamped with the time: the agent's saves of one name
       replace each other, and a second picture of the same page filed as
       evidence would otherwise take the place of the first. */
    const stamp = new Date().toISOString().slice(0, 19).replace(/[-:]/g, "").replace("T", "-");
    const base = (opts.saveAs || `screenshot-${slug(status.title || status.url || "page")}-${stamp}`).replace(/\.png$/i, "");
    const art = saveArtifact({
      origin: "agent", name: `${base}.png`, data: png, mime: "image/png", session: ctx.session,
      note: opts.note || (status.url ? `Screenshot of ${status.url}` : undefined),
    });
    kept = ` Saved as artifact ${art.id} (${art.name}, ${formatSize(art.size)}).`;
    caption = `Saved as ${art.name}`;
    if (opts.notebook) {
      const { book, made } = notebookFor(opts.notebook);
      addEntries(book.id, [{
        artifact: art.id,
        text: opts.note || (status.url ? `Screenshot of ${status.url}, taken ${new Date().toISOString().slice(0, 16).replace("T", " ")} UTC.` : undefined),
      }], "agent");
      kept += made ? ` Filed in a new notebook ${book.id}, "${book.title}".` : ` Filed in "${book.title}" (${book.id}).`;
    }
  }
  ctx.showImage(blob, caption, caption);

  // Vendors refuse a picture past about 8000 pixels a side, which a long page passes.
  const tall = png.byteLength >= 24 && (png.readUInt32BE(16) > 7800 || png.readUInt32BE(20) > 7800);
  const picture = tall ? null : pictureFor(png, "image/png");
  return {
    ok: true,
    summary: `A picture of ${what}${status.url ? ` on ${status.url}` : ""} is in the conversation${picture ? " and in this result" : ""}.${kept}` +
      (picture ? "" : " It is too large to hand back to you as a picture; take the window or an element to see it."),
    preview: kept ? caption : status.url ?? "screenshot",
    ...(picture ? { images: [picture] } : {}),
  };
}

/** A notebook named by id or title; a title nobody has makes one. */
function notebookFor(ref: string): { book: Notebook; made: boolean } {
  const found = findNotebook(ref);
  if (found) return { book: found, made: false };
  if (/^nb_[0-9a-f]+$/.test(ref)) throw new Error(`There is no notebook "${ref}". Use notebook list to see what there is.`);
  return { book: createNotebook({ title: ref, by: "agent" }), made: true };
}

const listOf = (raw: unknown): string[] =>
  Array.isArray(raw) ? raw.map((v) => String(v).trim()).filter(Boolean)
    : typeof raw === "string" && raw.trim() ? raw.split(",").map((v) => v.trim()).filter(Boolean) : [];

/** The lead shaping the organization: hire, edit, merge, remove, move. */
function shapeOrganization(action: string, args: Record<string, any>, ctx: ToolContext): ToolOutcome {
  const agent = String(args.agent ?? "").trim();
  const next = args.next ?? args.hands_to;
  try {
    if (action === "hire") {
      const made = createAgent({
        name: args.name, role: args.role, instructions: args.instructions, when: args.when,
        reportsTo: args.reports_to, next,
      });
      welcomeToThreads(made);
      const knowledge = String(args.knowledge ?? "").trim();
      const taught = knowledge && ctx.agents ? ctx.agents.mind.teach(made.id, knowledge, args.move !== false) : null;
      return {
        ok: true,
        summary: `Hired ${made.name} (${made.id}). ${agentLine(made)}${taught ? `\n${taught.summary}` : ""}`,
        preview: `hired ${made.name}`,
      };
    }
    if (!agent) return { ok: false, summary: "Say which agent (agent: its id or name)." };
    const found = findAgent(agent);
    if (!found) return { ok: false, summary: `There is no agent "${agent}". Use agents list to see who there is.` };
    if (action === "edit") {
      const patch: Record<string, unknown> = {};
      for (const [from, to] of [["name", "name"], ["role", "role"], ["instructions", "instructions"], ["when", "when"], ["reports_to", "reportsTo"], ["enabled", "enabled"]]) {
        if (args[from] !== undefined) patch[to] = args[from];
      }
      if (next !== undefined) patch.next = next;
      if (!Object.keys(patch).length) return { ok: false, summary: "Nothing to change: give name, role, instructions, when, reports_to, next or enabled." };
      const now = updateAgent(found.id, patch);
      return { ok: true, summary: `Updated ${now.name}. ${agentLine(now)}`, preview: `edited ${now.name}` };
    }
    if (action === "remove") {
      deleteAgent(found.id);
      return { ok: true, summary: `Removed ${found.name}. Whoever reported to it now reports one level up.`, preview: `removed ${found.name}` };
    }
    if (action === "merge") {
      const into = mergeAgents(found.id, args.into);
      return { ok: true, summary: `Merged ${found.name} into ${into.name}. ${agentLine(into)}`, preview: `${found.name} -> ${into.name}` };
    }
    const moved = moveAgent(found.id, { reportsTo: args.reports_to, position: args.position });
    return { ok: true, summary: `Moved ${moved.name}. ${agentLine(moved)}`, preview: `moved ${moved.name}` };
  } catch (err) {
    if (err instanceof AgentError) return { ok: false, summary: err.message };
    throw err;
  }
}

/** A new agent introduces itself on Threads, so the others (and the person) meet it. */
function welcomeToThreads(a: { id: string; name: string; role: string; when: string }) {
  try {
    createPost({
      title: `${a.name} has joined${a.role ? ` as ${a.role}` : ""}`,
      body: `Hello, I'm ${a.name}${a.role ? `, the ${a.role}` : ""}.${a.when ? ` Call me when: ${a.when}` : ""}`,
      tags: ["introductions"],
      by: { kind: "agent", id: a.id, name: a.name },
    });
  } catch { /* a full forum does not stop a hire */ }
}

async function runAgents(args: Record<string, any>, ctx: ToolContext): Promise<ToolOutcome> {
  const action = String(args.action ?? "").trim().toLowerCase();
  if (action === "list") {
    const all = listAgents();
    return { ok: true, summary: all.map(agentLine).join("\n"), preview: `${all.length} agent${all.length === 1 ? "" : "s"}` };
  }
  if (action === "domains") {
    if (!ctx.agents) return { ok: false, summary: "No mind to look at from here." };
    return { ok: true, summary: ctx.agents.mind.domains(), preview: "domains" };
  }
  if (action === "teach") {
    if (!ctx.agents) return { ok: false, summary: "Agents cannot be taught from here." };
    const to = findAgent(args.agent);
    if (!to) return { ok: false, summary: `There is no agent "${String(args.agent ?? "")}" to teach. Use agents list.` };
    const r = ctx.agents.mind.teach(to.id, String(args.query ?? ""), args.move !== false);
    return { ...r, preview: r.ok ? `taught ${to.name}` : undefined };
  }
  if (action === "note") {
    const who = findAgent(args.agent) ?? findAgent(ctx.agents?.self.id ?? LEAD_ID)!;
    const kept = remember(who.id, args.text, ["fact", "lesson", "tip", "colleague"].includes(String(args.kind)) ? (args.kind as NoteKind) : "lesson");
    return kept
      ? { ok: true, summary: `Kept for ${who.name}: "${kept.text}". It will be in front of ${who.name} next time.`, preview: "noted" }
      : { ok: false, summary: "Nothing to keep: say it in a sentence (text)." };
  }
  if (["hire", "edit", "merge", "remove", "move"].includes(action)) return shapeOrganization(action, args, ctx);
  if (action !== "run") return { ok: false, summary: `Unknown agents action "${action}". Use list, run, domains, teach, note, hire, edit, merge, remove or move.` };
  const ref = String(args.agent ?? "").trim();
  const task = String(args.task ?? "").trim();
  if (!ref || !task) return { ok: false, summary: "Say which agent and what its task is (agent, task)." };
  const found = findAgent(ref);
  if (!found) return { ok: false, summary: `There is no agent "${ref}". Use agents list to see who there is.` };
  if (found.id === ctx.agents?.self.id || (found.id === LEAD_ID && !ctx.agents)) {
    return { ok: false, summary: "That is you. Do the task yourself." };
  }
  if (!ctx.agents) return { ok: false, summary: "Agents cannot be started from here." };
  const done = await ctx.agents.run(found.id, task);
  return { ok: done.ok, summary: done.summary, preview: `${found.name}: ${done.ok ? "reported" : "did not finish"}` };
}

function runThread(args: Record<string, any>, ctx: ToolContext): ToolOutcome {
  const action = String(args.action ?? "").trim().toLowerCase();
  const me = (() => {
    const named = String(args.as ?? "").trim();
    const agent = named ? findAgent(named) : null;
    if (named && !agent) throw new ThreadError(`There is no agent "${named}" to post as.`);
    return agent ?? (ctx.agents ? findAgent(ctx.agents.self.id) : null) ?? findAgent(LEAD_ID)!;
  });
  try {
    if (action === "list") {
      const sort = ["top", "active"].includes(String(args.sort)) ? (String(args.sort) as "top" | "active") : "new";
      const all = listPosts(sort).slice(0, 25);
      if (!all.length) return { ok: true, summary: "Nothing has been posted yet. Start a conversation with action post.", preview: "0 posts" };
      return { ok: true, summary: all.map(postLine).join("\n"), preview: `${all.length} post${all.length === 1 ? "" : "s"}` };
    }
    const ref = String(args.post ?? "").trim();
    if (action === "post") {
      const a = me();
      const post = createPost({ title: args.title, body: args.text, tags: args.tags, by: { kind: "agent", id: a.id, name: a.name } });
      return { ok: true, summary: `Posted ${post.id}, "${post.title}", as ${a.name}. It is on the Threads page.`, preview: post.title };
    }
    if (!ref) return { ok: false, summary: "Say which post, by id (thread list shows them)." };
    const post = getPost(ref);
    if (!post) return { ok: false, summary: `There is no post "${ref}". Use thread list to see what there is.` };
    if (action === "read") return { ok: true, summary: describePost(post), preview: post.title };
    if (action === "comment") {
      const a = me();
      const r = addComment(post.id, { text: args.text, parent: args.reply_to, by: { kind: "agent", id: a.id, name: a.name } });
      return { ok: true, summary: `Commented (${r.comment.id}) on "${post.title}" as ${a.name}.`, preview: post.title };
    }
    if (action === "like") {
      const a = me();
      const r = toggleLike(post.id, { kind: "agent", id: a.id, name: a.name }, String(args.comment ?? "").trim() || null);
      return {
        ok: true,
        summary: `${r.liked ? "Liked" : "Took back the like on"} ${args.comment ? `comment ${args.comment} on ` : ""}"${post.title}" as ${a.name} (${r.likes} now).`,
        preview: post.title,
      };
    }
    return { ok: false, summary: `Unknown thread action "${action}". Use list, read, post, comment or like.` };
  } catch (err) {
    if (err instanceof ThreadError) return { ok: false, summary: err.message };
    throw err;
  }
}

function runNotebook(args: Record<string, any>, ctx: ToolContext): ToolOutcome {
  const action = String(args.action ?? "").trim().toLowerCase();
  const ref = String(args.notebook ?? "").trim();
  const unknownNote = (unknown: string[]) => unknown.length
    ? ` Not found, so not filed: ${unknown.join(", ")} -- check artifact_list for the right id.`
    : "";

  if (action === "list") {
    const all = listNotebooks();
    if (!all.length) return { ok: true, summary: "There are no notebooks yet. Make one with action create.", preview: "0 notebooks" };
    return { ok: true, summary: all.map(notebookLine).join("\n"), preview: `${all.length} notebook${all.length === 1 ? "" : "s"}` };
  }

  if (action === "create") {
    const title = String(args.title ?? ref).trim();
    const had = findNotebook(title);
    if (had) {
      return {
        ok: true,
        summary: `A notebook called "${had.title}" already exists (${had.id}, ${had.entries.length} entries); use it rather than making a second.`,
        preview: had.title,
      };
    }
    const book = createNotebook({ title, purpose: args.purpose, by: "agent" });
    return { ok: true, summary: `Made notebook ${book.id}, "${book.title}". It is on the Notebooks page.`, preview: book.title };
  }

  if (!ref) return { ok: false, summary: "Say which notebook, by id or title (notebook list shows them)." };

  if (action === "add") {
    const { book, made } = notebookFor(ref);
    const files = listOf(args.artifacts);
    const note = { title: args.title, text: args.text, cites: args.cites };
    const inputs = files.length
      ? files.map((artifact) => ({ artifact, title: files.length === 1 ? args.title : undefined, text: args.text, cites: args.cites }))
      : [note];
    const r = addEntries(book.id, inputs, "agent", Number(args.position) || undefined);
    if (!r.added.length && !r.updated.length) {
      return { ok: false, summary: `Nothing was added to "${book.title}": give artifacts, or a note's title or text.${unknownNote(r.unknown)}` };
    }
    const what = [
      r.added.length ? `added ${r.added.map((e) => e.id).join(", ")}` : "",
      r.updated.length ? `updated ${r.updated.map((e) => e.id).join(", ")} (already in it)` : "",
    ].filter(Boolean).join("; ");
    return {
      ok: true,
      summary: `${made ? `Made notebook ${book.id}, "${book.title}", and ` : `In "${book.title}" (${book.id}): `}${what}. ` +
        `It now has ${r.notebook.entries.length} entries.${unknownNote(r.unknown)}`,
      preview: `${book.title} · ${r.notebook.entries.length} entries`,
    };
  }

  const book = findNotebook(ref);
  if (!book) return { ok: false, summary: `There is no notebook "${ref}". Use notebook list to see what there is.` };
  const entry = String(args.entry ?? "").trim();

  switch (action) {
    case "read": {
      const text = describeNotebook(book);
      const room = CONTEXT_CONFIG.maxToolTokens * 4 - 200;
      const offset = Math.max(0, Number(args.offset) || 0);
      const part = text.slice(offset, offset + room);
      const rest = text.length - (offset + part.length);
      return {
        ok: true,
        summary: `${part}${rest > 0 ? `\n\n[${rest} more characters -- read on with offset ${offset + part.length}]` : ""}`,
        preview: `${book.title} · ${book.entries.length} entries`,
      };
    }
    case "edit": {
      if (!entry) {
        const next = updateNotebook(book.id, { title: args.title, purpose: args.purpose });
        return { ok: true, summary: `Updated notebook ${next.id}, "${next.title}".`, preview: next.title };
      }
      const r = updateEntry(book.id, entry, { title: args.title, text: args.text, cites: args.cites });
      return { ok: true, summary: `Updated ${r.entry.id} in "${book.title}".${unknownNote(r.unknown)}`, preview: book.title };
    }
    case "remove": {
      if (!entry) return { ok: false, summary: "Say which entry to remove (its en_... id, from read)." };
      if (!removeEntry(book.id, entry)) return { ok: false, summary: `There is no entry "${entry}" in "${book.title}".` };
      return { ok: true, summary: `Removed ${entry} from "${book.title}". Any file it was stays on the Artifacts page.`, preview: book.title };
    }
    case "move": {
      if (!entry) return { ok: false, summary: "Say which entry to move (its en_... id, from read)." };
      moveEntry(book.id, entry, Number(args.position) || 1);
      return { ok: true, summary: `Moved ${entry} to position ${Number(args.position) || 1} in "${book.title}".`, preview: book.title };
    }
    case "export": {
      const name = `${cleanName(book.title, "notebook").replace(/\.md$/i, "")}.md`;
      const art = saveArtifact({
        origin: "agent", name, data: Buffer.from(notebookMarkdown(book), "utf8"),
        mime: "text/markdown", session: ctx.session, note: `Export of the notebook "${book.title}"`,
      });
      ctx.showFile?.({ id: art.id, name: art.name, mime: art.mime, size: art.size });
      return { ok: true, summary: `Exported "${book.title}" as artifact ${art.id} (${art.name}, ${formatSize(art.size)}).`, preview: art.name };
    }
    default:
      return { ok: false, summary: `Unknown notebook action "${action}". Use list, create, read, add, edit, remove, move or export.` };
  }
}

async function generateImageTool(prompt: string, ctx: ToolContext): Promise<ToolOutcome> {
  // The Gemini key saved in Settings counts: it used to be only the
  // environment or the secret store, so a key pasted into the provider card
  // -- the way the app asks for one -- could chat but not draw.
  const apiKey =
    keyFor("gemini") ||
    secretFor("GEMINI_API_KEY") ||
    secretFor("GOOGLE_API_KEY");
  if (!apiKey) {
    return {
      ok: false,
      summary: "Cannot generate image: no Google Gemini key is saved in Settings, the environment or the secret store.",
    };
  }

  try {
    const ai = new GoogleGenAI({ apiKey });
    const response = await ai.models.generateImages({
      model: "imagen-3.0-generate-002",
      prompt,
      config: {
        numberOfImages: 1,
        outputMimeType: "image/jpeg",
        aspectRatio: "1:1",
      },
    });

    const base64 = response.generatedImages?.[0]?.image?.imageBytes;
    if (!base64) {
      return { ok: false, summary: "The image model returned no image bytes." };
    }

    const buffer = Buffer.from(base64, "base64");
    const blob = ctx.putBlob(buffer, "image/jpeg");
    ctx.showImage(blob, prompt, `Generated: ${prompt}`, { w: 1024, h: 1024 });

    // Kept as an artifact too: the blob goes when the process does.
    let saved = "";
    try {
      const art = saveArtifact({
        origin: "agent", name: `${slug(prompt)}.jpg`, data: buffer,
        mime: "image/jpeg", session: ctx.session, note: prompt,
      });
      saved = ` Saved as artifact ${art.id}.`;
    } catch {
      // The picture is still in the thread; losing the copy is not a failure.
    }

    return {
      ok: true,
      summary: `Generated image for prompt: "${prompt}". It is now displayed in the conversation for the person to see.${saved}`,
      preview: `Generated image: ${prompt.slice(0, 80)}`,
    };
  } catch (err: any) {
    return { ok: false, summary: `Image generation failed: ${err?.message ?? err}` };
  }
}

/**
 * Do the thing, whatever it is.
 *
 * Every path returns a ToolOutcome rather than throwing, because a failed tool
 * call is a normal event in a turn: the model needs to read what went wrong and
 * try something else, and an exception here would end the turn instead.
 */
/**
 * What the agent is told when it tries to write to memory in an incognito
 * chat. An answer in words rather than a silent no: it should say that
 * nothing here is kept, not try the same call again three ways.
 */
function incognitoMemory(): { ok: boolean; summary: string } {
  return {
    ok: false,
    summary:
      "This chat is incognito: nothing in it is saved or recorded, so there is " +
      "nothing to write down and nothing learned here will be remembered. Tell " +
      "the person that, rather than trying again.",
  };
}

export async function runTool(
  spec: ToolSpec,
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  /* Whatever the tool read -- a page that now shows the address it was
     given, a form echoing a username -- goes back to the model with the
     person's saved details blanked out. */
  const outcome = await runToolUnredacted(spec, args, ctx);
  return {
    ...outcome,
    summary: redactForModel(outcome.summary),
    ...(outcome.preview !== undefined ? { preview: redactForModel(outcome.preview) } : {}),
  };
}

async function runToolUnredacted(
  spec: ToolSpec,
  args: Record<string, any>,
  ctx: ToolContext,
): Promise<ToolOutcome> {
  try {
    switch (spec.name) {
      // ------------------------------------------------------- terminal --
      case "terminal": {
        const settings = toolSettings().terminal;
        const command = String(args.command ?? "").trim();
        if (!command) return { ok: false, summary: "No command was given." };
        const asked = String(args.cwd ?? "").trim();
        // A relative directory is taken from the terminal's own, like `cd`; once the Terminal window is open, its own.
        const base = termCwd(ctx.session) ?? terminalDir();
        const cwd = asked ? path.resolve(base, asked) : base;
        // The same command appears in the Terminal window, marked as the agent's, and the person's own are told back.
        const shown = termAgentBegin(ctx.session, command, cwd);
        const outcome = await runCommand(command, cwd, settings.timeout, {
          ...ctx,
          onOutput: (chunk: string) => { ctx.onOutput(chunk); termAgentChunk(ctx.session, shown, chunk); },
        } as ToolContext);
        termAgentEnd(ctx.session, shown, outcome.exitCode);
        const news = termNews(ctx.session);
        return news ? { ...outcome, summary: `${outcome.summary}\n\n${news}` } : outcome;
      }

      case "research": {
        if (!ctx.research) return { ok: false, summary: "A research worker cannot start another one. Answer from what you can look at yourself." };
        const many = (Array.isArray(args.questions) ? args.questions : []).map((q: unknown) => String(q ?? "").trim()).filter(Boolean).slice(0, 3);
        const one = String(args.question ?? "").trim();
        if (one && !many.includes(one)) many.unshift(one);
        const questions = many.slice(0, 3);
        if (questions.length === 0) return { ok: false, summary: "Say what to find out: question, or questions for several at once." };
        if (questions.length === 1) {
          return { ok: true, summary: await ctx.research(questions[0]), preview: "research report" };
        }
        /* Separate workers, at the same time: each has a clean context, so they
           cannot step on one another, and the wait is the slowest one, not the sum. */
        const reports = await Promise.all(questions.map((q: string) => ctx.research!(q).catch((err: Error) => `The worker failed: ${String(err.message).split("\n")[0]}`)));
        return {
          ok: true,
          summary: reports.map((r, i) => `Question ${i + 1}: ${questions[i]}\n${r}`).join("\n\n---\n\n"),
          preview: `${questions.length} research reports`,
        };
      }

      case "edit_file": {
        if (!ctx.code) return { ok: false, summary: "There is no folder to edit files in, in this chat." };
        const r = ctx.code.edit({
          path: String(args.path ?? ""),
          edits: Array.isArray(args.edits) ? args.edits.map((e: any) => ({ old: String(e?.old ?? ""), new: String(e?.new ?? ""), all: e?.all === true })) : undefined,
          content: typeof args.content === "string" ? args.content : undefined,
          overwrite: args.overwrite === true,
        });
        return { ok: r.ok, summary: r.summary, preview: r.ok ? (r.wrote?.created ? "created a file" : "edited a file") : "not written" };
      }

      case "code_search": {
        const where = String(args.path ?? "").trim();
        const found = searchCode({
          root: where ? path.resolve(terminalDir(), where) : terminalDir(),
          query: String(args.query ?? ""),
          mode: args.mode === "exact" || args.mode === "regex" ? args.mode : "ranked",
          glob: typeof args.glob === "string" ? args.glob : undefined,
          caseSensitive: args.case_sensitive === true,
          max: typeof args.max === "number" ? args.max : undefined,
        });
        return { ok: found.ok, summary: found.text, preview: found.ok ? `${found.files} files searched` : "no search" };
      }

      case "read_file": {
        const r = readFile(
          { path: String(args.path ?? ""), start: args.start, end: args.end, outline: args.outline === true, symbol: typeof args.symbol === "string" ? args.symbol : undefined },
          { root: terminalDir(), protect: ctx.protectedPaths ?? [] },
        );
        return { ok: r.ok, summary: r.text, preview: r.ok ? String(args.path ?? "") : "not read" };
      }

      // --------------------------------------------------- background --
      case "run_background": {
        const command = String(args.command ?? "").trim();
        if (!command) return { ok: false, summary: "No command was given." };
        const asked = String(args.cwd ?? "").trim();
        const cwd = asked ? path.resolve(terminalDir(), asked) : terminalDir();
        const started = startJob({ command, cwd, note: String(args.note ?? ""), session: ctx.session });
        if (!started.job) return { ok: false, summary: started.error ?? "It did not start." };
        const job = started.job;
        return {
          ok: true,
          summary:
            `Started ${job.id} in the background, running: ${command}\n` +
            `Working directory: ${cwd}\n` +
            `Its output is going to ${job.log}.\n` +
            "Nothing is waiting for it: this turn is free to carry on, and the " +
            `next turn is told how it ended. Read it with background_output ${job.id}.`,
          preview: `background ${job.id}`,
        };
      }

      case "background_jobs": {
        const list = listJobs();
        if (list.length === 0) {
          return {
            ok: true,
            summary: "No background commands. Start one with run_background.",
            preview: "no background jobs",
          };
        }
        const lines = list.map((j) => {
          const tail = j.last.trim();
          return tail ? `- ${describeJob(j)} Last line: ${tail}` : `- ${describeJob(j)}`;
        });
        return {
          ok: true,
          summary: ["Background commands, newest first:", ...lines].join("\n"),
          preview: `${list.length} background job(s)`,
        };
      }

      case "background_output": {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No job id was given." };
        const job = findJob(id);
        if (!job) {
          return {
            ok: false,
            summary: `There is no background job ${id}. background_jobs lists the ones there are.`,
          };
        }
        const wanted = Math.min(Math.max(Number(args.lines ?? 40) || 40, 1), 500);
        const text = readTail(job, 200_000).replace(/\s+$/, "");
        const rows = text.split("\n");
        const shown = rows.slice(-wanted).join("\n");
        const omitted = rows.length > wanted ? `\n[${rows.length - wanted} earlier line(s) not shown]\n` : "\n";
        return {
          ok: job.state === "running" || job.exit === 0,
          exitCode: job.exit ?? undefined,
          summary:
            `${describeJob(job)}\n` +
            (job.state === "running" ? "(still running: this is what it has printed so far)\n" : "") +
            omitted + (shown || "(nothing printed)"),
          preview: `${job.id} · ${job.state}${job.exit === null ? "" : ` · exit ${job.exit}`}`,
        };
      }

      case "background_stop": {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No job id was given." };
        const stopped = stopJob(id);
        return { ok: stopped.ok, summary: stopped.message };
      }

      // ------------------------------------------------------ schedule --
      case "schedule": {
        const jobs = ctx.jobs;
        if (!jobs) return { ok: false, summary: "Scheduled tasks are not available here." };
        const name = String(args.name ?? "").trim();
        const cron = String(args.cron ?? "").trim();
        const prompt = String(args.prompt ?? "").trim();
        const id = String(args.id ?? "").trim();
        if (!prompt) return { ok: false, summary: "A task needs a prompt: what to do when it runs." };
        if (!id && !name) return { ok: false, summary: "Give it a name, so the person knows what it is." };
        if (!cron && !id) return { ok: false, summary: "Give it a time: a five-field cron expression." };
        const watch = args.watch && typeof args.watch === "object"
          ? {
            kind: String((args.watch as any).kind ?? ""),
            target: String((args.watch as any).target ?? "").trim(),
          }
          : null;
        if (watch && !watch.target) return { ok: false, summary: "A watcher needs something to watch." };
        const enabled = args.enabled === undefined ? true : Boolean(args.enabled);
        if (id) {
          const changed = jobs.update(id, { name: name || undefined, cron: cron || undefined, prompt, watch, enabled });
          if (!changed.ok) return { ok: false, summary: changed.error ?? `There is no job ${id}.` };
          return {
            ok: !changed.error,
            summary: changed.error
              ? `Saved, but its time is not valid: ${changed.error}`
              : `Changed ${id}. It runs "${prompt}" on ${cron || "its time"}.`,
            preview: `schedule ${id} changed`,
          };
        }
        const made = jobs.create({ name, cron, prompt, watch, enabled });
        if (!made.id) return { ok: false, summary: made.error ?? "It could not be created." };
        return {
          ok: !made.error,
          summary: made.error
            ? `Made ${made.id}, but its time is not valid: ${made.error}. Change the cron or remove it.`
            : `Made ${made.id}${watch ? ` watching the ${watch.kind} ${watch.target}` : ""}. ` +
              "It runs in a session of its own and what it says appears there; you do not have to wait for it.",
          preview: `schedule ${made.id}`,
        };
      }

      case "schedules": {
        const jobs = ctx.jobs;
        if (!jobs) return { ok: false, summary: "Scheduled tasks are not available here." };
        const list = jobs.list();
        if (list.length === 0) {
          return { ok: true, summary: "Nothing is scheduled. Set something with schedule.", preview: "no schedules" };
        }
        const when = (sec: number | null) =>
          sec ? new Date(sec * 1000).toISOString().slice(0, 16).replace("T", " ") : "never";
        return {
          ok: true,
          summary: [
            "Scheduled tasks and watchers:",
            ...list.map((j) =>
              `- ${j.id} "${j.name}" -- ${j.cron}, next ${when(j.next_run)}, last ${when(j.last_run)}` +
              `${j.watch ? `, watching the ${j.watch.kind} ${j.watch.target}` : ""}` +
              `${j.enabled ? "" : ", PAUSED"}${j.running ? ", running now" : ""}` +
              `${j.cron_error ? ` -- its time is not valid: ${j.cron_error}` : ""}` +
              `${j.last_error ? ` -- last run failed: ${j.last_error}` : ""}`),
          ].join("\n"),
          preview: `${list.length} scheduled job(s)`,
        };
      }

      case "unschedule": {
        const jobs = ctx.jobs;
        if (!jobs) return { ok: false, summary: "Scheduled tasks are not available here." };
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No job id was given." };
        if (args.keep === true || args.keep === "true") {
          const paused = jobs.update(id, { enabled: false });
          return paused.ok
            ? { ok: true, summary: `Paused ${id}. It stays, and never fires until it is enabled again.` }
            : { ok: false, summary: paused.error ?? `There is no job ${id}.` };
        }
        return jobs.remove(id)
          ? { ok: true, summary: `Removed ${id}.` }
          : { ok: false, summary: `There is no job ${id}. schedules lists the ones there are.` };
      }

      // ----------------------------------------------------- autonomy --
      case "pre_authorise": {
        const tool = String(args.tool ?? "").trim();
        const match = String(args.match ?? "").trim();
        const made = addRule({ tool, match, note: String(args.note ?? ""), by: "agent" });
        if (!made.rule) return { ok: false, summary: made.error ?? "It was not agreed." };
        return {
          ok: true,
          summary:
            `Agreed: ${made.rule.tool} calls containing "${made.rule.match}" run without being held. ` +
            "It is listed in Settings, and the person can take it back. " +
            "It covers the guard only -- nothing irrecoverable is ever covered.",
          preview: `standing agreement ${made.rule.id}`,
        };
      }

      case "pre_authorisations": {
        const revoke = String(args.revoke ?? "").trim();
        if (revoke) {
          return revokeRule(revoke)
            ? { ok: true, summary: `Taken back: ${revoke}. It will be asked about again.` }
            : { ok: false, summary: `There is no standing agreement ${revoke}.` };
        }
        const list = listRules();
        if (list.length === 0) {
          return {
            ok: true,
            summary: "Nothing is pre-authorised. pre_authorise agrees a class of work so the guard stops asking about it.",
            preview: "no standing agreements",
          };
        }
        return {
          ok: true,
          summary: [
            "Standing agreements:",
            ...list.map((r) =>
              `- ${r.id} — ${r.tool}: anything containing "${r.match}"` +
              `${r.note ? ` (${r.note})` : ""}, added by the ${r.by}, used ${r.used} time${r.used === 1 ? "" : "s"}.`),
          ].join("\n"),
          preview: `${list.length} standing agreement(s)`,
        };
      }

      case "inventory": {
        const seen = getInventory(true);
        return {
          ok: true,
          summary: ["What this machine has, as of now:", ...seen.lines].join("\n"),
          preview: "looked at the machine",
        };
      }

      case "app_preview": {
        if (!ctx.preview) return { ok: false, summary: "There is no app window in this chat." };
        const action = String(args.action ?? "").trim().toLowerCase();
        if (action === "start") {
          const r = await ctx.preview.start({
            command: args.command, cwd: args.cwd, dir: args.dir, url: args.url, port: Number(args.port) || undefined,
          });
          return { ok: r.ok, summary: r.summary, preview: r.ok ? "app preview open" : undefined };
        }
        if (action === "reload") return await ctx.preview.reload();
        if (action === "stop") return await ctx.preview.stop();
        if (action === "look") {
          const r = await ctx.preview.look();
          const picture = r.png ? pictureFor(r.png, "image/png") : null;
          return { ok: r.ok, summary: r.summary, preview: r.ok ? "looked at the app" : undefined, ...(picture ? { images: [picture] } : {}) };
        }
        if (["click", "hover", "type", "press", "scroll"].includes(action)) {
          const r = await ctx.preview.act({
            action, target: args.target === undefined ? undefined : String(args.target), text: args.text === undefined ? undefined : String(args.text),
            key: args.key === undefined ? undefined : String(args.key), dy: args.dy === undefined ? undefined : Number(args.dy), submit: args.submit === true,
          });
          const picture = r.png ? pictureFor(r.png, "image/png") : null;
          return { ok: r.ok, summary: r.summary, preview: r.ok ? `${action} in the app` : undefined, ...(picture ? { images: [picture] } : {}) };
        }
        return { ok: false, summary: "action is start, reload, look, stop, click, hover, type, press or scroll." };
      }

      case "set_mode": {
        if (!ctx.setPhase) return { ok: false, summary: "There is no chat to switch here." };
        const to = String(args.to ?? "").trim().toLowerCase();
        if (to !== "build" && to !== "plan") {
          return { ok: false, summary: "to is build or plan." };
        }
        const result = ctx.setPhase(to, String(args.reason ?? "").trim().slice(0, 160));
        return { ok: result.ok, summary: result.summary, preview: result.ok ? to : undefined };
      }

      case "todo": {
        if (!ctx.todos) {
          return { ok: false, summary: "There is no to-do list to write to in this chat." };
        }
        const result = ctx.todos(args as Record<string, any>);
        return {
          ok: result.ok,
          summary: result.summary,
          ...(result.preview ? { preview: result.preview } : {}),
        };
      }

      case "tools_enable": {
        if (!ctx.enableTools) return { ok: false, summary: "There is nothing to load here." };
        const r = ctx.enableTools(String(args.family ?? "").trim().toLowerCase());
        return { ok: r.ok, summary: r.summary, preview: r.ok ? String(args.family) : undefined };
      }

      case "requirements": {
        if (!ctx.requirements) return { ok: false, summary: "There is no requirements list in this chat." };
        const result = ctx.requirements(args as Record<string, any>);
        return { ok: result.ok, summary: result.summary, ...(result.preview ? { preview: result.preview } : {}) };
      }

      case "ledger": {
        if (!ctx.ledger) return { ok: false, summary: "There are no working notes to write to in this chat." };
        const result = ctx.ledger(args as Record<string, any>);
        return { ok: result.ok, summary: result.summary, ...(result.preview ? { preview: result.preview } : {}) };
      }

      // -------------------------------------------------------- browser --
      case "browser_open": {
        const url = String(args.url ?? "").trim();
        if (!url) return { ok: false, summary: "No address was given." };
        const page = await ctx.browser().goto(url);
        ctx.browserChanged();
        return {
          ok: true,
          summary: describePage(page),
          preview: `${page.title || page.url} · ${page.refs.length} elements`,
        };
      }

      case "browser_read": {
        const page = await ctx.browser().snapshot();
        ctx.browserChanged();
        const part = Number(args.part ?? 1);
        /* A third identical read used to be served as the same page again, and
           looked like progress while the agent went round. It is replaced by
           what to do instead -- the note names the way out rather than the
           problem, which the loop-check already says into the same wind. */
        const again = ctx.browser().lookNote(page, part);
        return {
          ok: true,
          summary: again ? `${again}\n\n(The page, unchanged, for reference:)\n${describePage(page, part)}` : describePage(page, part),
          preview: again ? `unchanged → ${page.url}` : part > 1 ? `${page.url} · part ${part}` : page.url,
        };
      }

      case "browser_click": {
        const ref = Number(args.ref);
        if (!Number.isFinite(ref)) {
          return { ok: false, summary: "That is not an element number." };
        }
        const page = await ctx.browser().click(ref);
        ctx.browserChanged();
        const held = page.notes?.some((n) => n.startsWith("NOT CLICKED")) ?? false;
        return {
          ok: true,
          summary: withNotes(page, held ? "Held back." : `Clicked [${ref}].`),
          preview: held ? `held back [${ref}]: covered` : `clicked [${ref}] → ${page.url}`,
        };
      }

      case "browser_fill": {
        const values = (Array.isArray(args.values) ? args.values : [])
          .map((v: any) => ({ ref: Number(v?.ref), text: String(v?.text ?? "") }))
          .filter((v: any) => Number.isFinite(v.ref));
        if (values.length === 0) {
          return { ok: false, summary: "No fields were given to fill." };
        }
        if (values.some((v: { text: string }) => hasPlaceholder(v.text))) {
          const at = ctx.browser().status().url ?? "";
          try {
            for (const v of values) v.text = fillPlaceholders(v.text, at);
          } catch (err: any) {
            return { ok: false, summary: `Nothing was filled. ${err?.message ?? err}` };
          }
        }
        const page = await ctx.browser().fill(values, Boolean(args.submit));
        ctx.browserChanged();
        return {
          ok: true,
          summary: withNotes(
            page,
            `Filled ${values.length} field${values.length === 1 ? "" : "s"}${args.submit ? " and submitted" : ""}:`,
          ),
          preview: page.url,
        };
      }

      case "browser_upload": {
        const ref = Number(args.ref);
        if (!Number.isFinite(ref)) return { ok: false, summary: "Give the upload field's element number as ref." };
        const ids = (Array.isArray(args.ids) ? args.ids : [args.ids])
          .map((id: unknown) => String(id ?? "").trim())
          .filter(Boolean)
          .slice(0, 10);
        if (ids.length === 0) return { ok: false, summary: "No artifact ids were given. Use artifact_list to find the file." };
        const files: UploadFile[] = [];
        for (const id of ids) {
          const meta = getArtifact(id);
          const data = meta ? readArtifact(id) : null;
          if (!meta || !data) {
            return { ok: false, summary: `There is no artifact "${id}". Use artifact_list to find the file.` };
          }
          files.push({ name: meta.name, mimeType: meta.mime, buffer: data });
        }
        const page = await ctx.browser().upload(ref, files);
        ctx.browserChanged();
        return {
          ok: true,
          summary: withNotes(page, `Attached ${files.map((f) => f.name).join(", ")}:`),
          preview: `attached ${files.map((f) => f.name).join(", ")} → [${ref}]`,
        };
      }

      case "browser_scroll": {
        const to = args.to === "top" || args.to === "bottom" ? args.to : undefined;
        const text = typeof args.text === "string" && args.text.trim() ? args.text.trim() : undefined;
        const ref = Number.isFinite(Number(args.ref)) && args.ref !== null && args.ref !== undefined
          ? Number(args.ref) : null;
        const dy = Number(args.dy);
        const screens = Number(args.screens);
        const page = await ctx.browser().scroll({
          to, text, ref,
          ...(Number.isFinite(screens) && screens !== 0
            ? { screens }
            : Number.isFinite(dy) && dy !== 0
              ? { dy }
              : to || text || ref !== null ? {} : { screens: 1 }),
        });
        ctx.browserChanged();
        return {
          ok: true,
          summary: page.notes?.length ? withNotes(page, "Scrolled.") : describePage(page),
          preview: page.url,
        };
      }

      case "browser_press": {
        const keys = (Array.isArray(args.keys) ? args.keys : [args.keys])
          .map((k: unknown) => keyName(String(k ?? "")))
          .filter(Boolean)
          .slice(0, 20);
        if (keys.length === 0) return { ok: false, summary: "No keys were given." };
        const ref = Number.isFinite(Number(args.ref)) && args.ref !== null && args.ref !== undefined
          ? Number(args.ref) : null;
        const page = await ctx.browser().press(keys, ref);
        ctx.browserChanged();
        return {
          ok: true,
          summary: `Pressed ${keys.join(", ")}.\n\n${describePage(page)}`,
          preview: `pressed ${keys.join(" ")}`,
        };
      }

      case "browser_signin_import": {
        const id = String(args.id ?? "").trim();
        const meta = getArtifact(id);
        const data = meta ? readArtifact(id) : null;
        if (!meta || !data) {
          return { ok: false, summary: `There is no uploaded file "${id}". Use artifact_list to find the cookie file.` };
        }
        let parsed;
        try {
          parsed = parseCookieExport(data.toString("utf8"));
        } catch (err) {
          return { ok: false, summary: `${meta.name}: ${err instanceof Error ? err.message : String(err)}` };
        }
        if (parsed.cookies.length === 0) {
          return {
            ok: false,
            summary: `${meta.name} has no usable cookies in it${
              parsed.expired ? ` (${parsed.expired} had already expired -- the sign-in needs exporting again)` : ""}.`,
          };
        }
        const { added, refused } = await ctx.browser().importCookies(parsed.cookies);
        const sites = sitesOf(parsed.cookies);
        if (added > 0) for (const site of sites) recordSignIn(site, "import");
        const kept = Boolean(args.keep_file);
        if (!kept && added > 0) deleteArtifact(id);
        const extra = [
          refused ? `${refused} were refused by the browser` : "",
          parsed.expired ? `${parsed.expired} had expired` : "",
          parsed.skipped ? `${parsed.skipped} were unreadable` : "",
        ].filter(Boolean).join("; ");
        return {
          ok: added > 0,
          summary:
            `Imported ${added} cookie${added === 1 ? "" : "s"} for ${sites.slice(0, 12).join(", ")}` +
            `${sites.length > 12 ? ` and ${sites.length - 12} more sites` : ""}${extra ? ` (${extra})` : ""}. ` +
            `${!kept && added > 0 ? "The uploaded file has been deleted. " : ""}` +
            "Open the site to check it shows the person signed in; if it still asks " +
            "for a sign-in, the export was from a signed-out browser or for a different address.",
          preview: `signed in: ${sites.slice(0, 4).join(", ")}${sites.length > 4 ? "…" : ""}`,
        };
      }

      case "browser_back": {
        const page = await ctx.browser().back();
        ctx.browserChanged();
        return { ok: true, summary: describePage(page), preview: page.url };
      }

      case "browser_devtools": {
        const rows = ctx.browser().devtools({
          kind: args.panel === "network" ? "request" : "console",
          errorsOnly: !!args.errors_only,
          limit: Math.min(Math.max(Number(args.limit) || 40, 1), 200),
        });
        if (!rows.length) return { ok: true, summary: `Nothing in the ${args.panel === "network" ? "network" : "console"} log${args.errors_only ? " that is an error" : ""}.` };
        const line = (e: (typeof rows)[number]) => e.kind === "console"
          ? `[${e.level}] ${e.text}`
          : `${e.method} ${e.failed ? `FAILED (${e.failed})` : e.status} ${e.level} ${e.ms ?? 0}ms${e.bytes ? ` ${e.bytes}B` : ""} ${e.text}`;
        return { ok: true, summary: rows.map(line).join("\n") };
      }

      case "browser_tabs": {
        const live = ctx.browser();
        const action = String(args.action ?? "list");
        const show = (tabs: Array<{ id: number; url: string; title: string; active: boolean }>) =>
          tabs.length
            ? tabs.map((t) => `${t.active ? "*" : " "} [${t.id}] ${t.title || "(untitled)"} -- ${t.url}`).join("\n")
            : "No tabs are open.";
        if (action === "new") {
          const out = await live.newTab(typeof args.url === "string" ? args.url : undefined);
          ctx.browserChanged();
          if ("text" in out) return { ok: true, summary: `${describePage(out)}\n\n${show(live.tabList())}`, preview: out.url };
          return { ok: true, summary: `Opened a blank tab.\n${show(out.tabs)}` };
        }
        if (action === "switch" || action === "close") {
          const id = Number(args.id);
          if (!Number.isInteger(id)) return { ok: false, summary: `${action} needs the tab's id (see action 'list').` };
          try {
            const out = action === "switch" ? await live.switchTab(id) : await live.closeTab(id);
            ctx.browserChanged();
            return { ok: true, summary: show(out.tabs) };
          } catch (err: any) {
            return { ok: false, summary: `${err?.message ?? err}\n${show(live.tabList())}` };
          }
        }
        return { ok: true, summary: show(live.tabList()) };
      }

      case "browser_screenshot": {
        const live = ctx.browser();
        const selector = String(args.selector ?? "").trim();
        const ref = Number.isInteger(Number(args.ref)) && args.ref !== null && args.ref !== "" ? Number(args.ref) : undefined;
        const area = args.area && typeof args.area === "object" ? args.area : null;
        const saveAs = String(args.save_as ?? "").trim();
        const filedIn = String(args.notebook ?? "").trim();
        if (ref !== undefined || selector || area || args.full_page === true || saveAs || filedIn) {
          return await keepScreenshot(live, ctx, {
            fullPage: args.full_page === true, ref, selector, area, saveAs, notebook: filedIn,
            note: String(args.note ?? "").trim(),
          });
        }
        const png = await live.capture();
        const blob = ctx.putBlob(png, "image/png");
        const status = live.status();
        ctx.showScreen("browser", blob, { w: VIEWPORT.width, h: VIEWPORT.height });
        /* Four pictures of a page that has not moved a pixel is the same loop
           as four reads of it: the picture is still shown to the person, but
           the model is told what to do instead of handed it again. */
        const unmoved = live.shotNote(png);
        if (unmoved) {
          return { ok: true, summary: unmoved, preview: status.url ?? "screenshot" };
        }
        /* The picture goes to the model as well, in the result. It used to
           say here that she could not see it, which left "what does the page
           look like" answerable only from the text -- and a screenshot asked
           for because a page is stuck, or because something looks wrong, is
           exactly the question the text cannot answer. */
        const picture = pictureFor(png, "image/png");
        return {
          ok: true,
          summary:
            "A picture of the page as it is now is in this result, and on the " +
            "browser screen where the person can see it. This is the only way to " +
            "see the page rather than read it: use it when the person asks what " +
            "something looks like, when a page seems to be stuck, or when a click " +
            "did nothing and the text gives no reason." +
            (picture ? "" : " It is too large to hand back as a picture; it is on the person's screen."),
          preview: status.url ?? "screenshot",
          ...(picture ? { images: [picture] } : {}),
        };
      }

      case "browser_eval": {
        const script = String(args.script ?? "").trim();
        if (!script) {
          return {
            ok: false,
            summary:
              "No script was given. `script` is the JavaScript to run in the page, " +
              "either an expression or statements with a return.",
          };
        }
        const { page, value, hits, elapsed } = await ctx.browser().runScript(script);
        ctx.browserChanged();
        const clicked = hits.length
          ? `\nIt clicked: ${hits.map((h: { label?: string }) => h.label || "an element").join(", ")}.`
          : "";
        return {
          ok: true,
          summary: `${value}${clicked}\n\n${describePage(page)}`,
          preview: `eval${hits.length ? ` (clicked ${hits.map((h: { label?: string }) => h.label || "an element").join(", ")})` : ""} → ${page.url}`,
          ...(elapsed > 4000 ? { notes: [`The script took ${(elapsed / 1000).toFixed(1)}s.`] } : {}),
        };
      }

      case "browser_captcha": {
        const { outcome, kind, page, detail, backend } = await ctx.browser().solveCaptcha();
        ctx.browserChanged();
        const said: Record<typeof outcome, string> = {
          none: "There is no checkbox CAPTCHA on this page.",
          solved: `The ${kind ?? "CAPTCHA"} check passed.` +
            (backend ? ` The picture challenge was answered by the ${backend} backend.` : ""),
          pending:
            `Clicked the ${kind ?? "CAPTCHA"} checkbox, but it has not confirmed yet. ` +
            "Re-read the page in a moment; if it is still unticked, try browser_captcha once more.",
          challenge:
            `The ${kind ?? "CAPTCHA"} checkbox escalated to a picture challenge and the solver did not get it. ` +
            "Hand the browser to the person with browser_handoff to solve it.",
        };
        return {
          ok: outcome === "solved" || outcome === "none",
          summary:
            `${said[outcome]}` +
            (detail ? `\n\nWhat the solver did: ${detail}` : "") +
            `\n\n${describePage(page)}`,
          preview: `captcha: ${outcome}`,
        };
      }

      case "browser_handoff": {
        const reason = String(args.reason ?? "Your help is needed in the browser.");
        const live = ctx.browser();
        live.setControl("human", reason);
        ctx.browserChanged();
        const watch = await captchaWatch(live, reason);
        const answer = await ctx.ask({
          kind: "browser",
          title: reason,
          detail: watch
            ? "Solve it in the page below. Autora carries on by itself as soon as it passes."
            : "Tap and type in the page below. Nothing you type there is saved to the chat.",
          options: [],
          multi: false,
          allowText: false,
          watch,
        });
        live.setControl("agent", null);
        ctx.browserChanged();
        if (answer.cancelled) {
          return {
            ok: false,
            summary:
              answer.who === "user"
                ? "The person said they cannot do this. Tell them what you were " +
                  "trying to reach, and ask how they would like to proceed."
                : "Nobody took over the browser. Stop here and say what is needed.",
            preview: "handoff: not done",
          };
        }
        const page = await live.snapshot();
        /* What the person did in the page is most often a sign-in, and it is
           kept: noted here so no later conversation asks for it again. */
        if (answer.who !== "auto" && !watch && /sign|log ?in|auth|2fa|mfa|verif|code|password|account|sso|oauth/i.test(reason)) {
          recordSignIn(page.url, "handoff");
        }
        if (answer.who === "auto") {
          return {
            ok: true,
            summary:
              "The CAPTCHA passed while the person had the browser -- detected on the page, " +
              "not reported by them. Carry straight on with the task; do not ask whether " +
              "they finished it.\n\n" + describePage(page),
            preview: "handoff: captcha passed",
          };
        }
        return {
          ok: true,
          summary:
            "The person says they are done in the browser" +
            (answer.text ? ` and added: ${answer.text}` : "") +
            ".\n\n" + describePage(page),
          preview: "handoff: done",
        };
      }

      case "ask_user": {
        const question = String(args.question ?? "").trim();
        if (!question) return { ok: false, summary: "No question was given." };
        const options = Array.isArray(args.options)
          ? args.options
              .map((o: any) => typeof o === "string"
                ? { label: o }
                : { label: String(o?.label ?? "").trim(), detail: o?.detail ? String(o.detail) : undefined })
              .filter((o: { label: string }) => o.label)
              .slice(0, 8)
          : [];
        const answer = await ctx.ask({
          kind: "question",
          title: question,
          detail: args.context ? String(args.context) : undefined,
          options,
          multi: Boolean(args.multi_select),
          allowText: args.allow_text !== false || options.length === 0,
          placeholder: args.placeholder ? String(args.placeholder) : undefined,
        });
        if (answer.cancelled) {
          return {
            ok: false,
            summary: answer.who === "user"
              ? "The person dismissed the question without answering. Use your best judgement, and say what you assumed."
              : "The question went unanswered. Stop and say what you need.",
            preview: "no answer",
          };
        }
        const parts: string[] = [];
        if (answer.choices.length) parts.push(`chose: ${answer.choices.join("; ")}`);
        if (answer.text) parts.push(`wrote: ${answer.text}`);
        return {
          ok: true,
          summary: `The person answered. They ${parts.join(", and ")}.`,
          preview: answer.choices.join(", ") || answer.text.slice(0, 80),
        };
      }

      case "tool_manual": {
        const id = String(args.window ?? "").trim().toLowerCase() as ManualId;
        if (!MANUAL_IDS.includes(id)) return { ok: false, summary: `There is no manual called "${id}". The manuals are: ${MANUAL_IDS.join(", ")}.` };
        return { ok: true, summary: manualText(id), preview: `manual: ${id}` };
      }

      case "mcp_servers": {
        return { ok: true, summary: mcpOverview(String(args.topic ?? "")), preview: "MCP servers" };
      }

      case "mcp_offer": {
        const plan = planOffer(args);
        if (typeof plan === "string") return { ok: false, summary: plan };
        const already = existingMcp(plan.name);
        if (already) {
          const status = mcpStatusOf(already.id);
          if (status.status === "connected") {
            return {
              ok: true,
              summary: `${plan.title} is already set up and connected. Its tools: ` +
                `${status.tools.map((t) => `mcp__${plan.name}__${t.name}`).join(", ") || "(none)"}. Use them.`,
              preview: "already set up",
            };
          }
        }
        if (wasDeclined(ctx.session, plan.name)) {
          return {
            ok: false,
            summary: `The person already said not now to ${plan.title} in this session. Do not offer it again; carry on another way.`,
            preview: "declined earlier",
          };
        }
        const answer = await ctx.ask({
          kind: "offer",
          title: `Set up ${plan.title}?`,
          detail: plan.why,
          options: [{ label: "Set it up" }, { label: "Not now" }],
          multi: false,
          allowText: false,
          offer: {
            name: plan.name, title: plan.title, summary: plan.summary,
            runs: plan.runs, kind: plan.kind, needs: plan.needs,
          },
        });
        if (answer.cancelled || !answer.choices.includes("Set it up")) {
          noteDeclined(ctx.session, plan.name);
          return {
            ok: true,
            summary: `The person chose not to set up ${plan.title} now. Carry on with the tools you have ` +
              "and do not offer it again this session.",
            preview: "not now",
          };
        }
        const result = await installMcp(plan);
        if (!result.ok) {
          return {
            ok: false,
            summary: `${plan.title} was saved but did not connect: ${result.error ?? "unknown error"}` +
              (result.missing.length ? ` Missing secrets: ${result.missing.join(", ")}.` : "") +
              " Tell the person what went wrong in a sentence; it can be fixed on the Integrations page. " +
              "Meanwhile carry on another way.",
            preview: "did not connect",
          };
        }
        return {
          ok: true,
          summary: `${plan.title} is set up and connected. New tools, yours from your next step: ` +
            `${result.tools.map((t) => `mcp__${plan.name}__${t}`).join(", ")}. Use them for the rest of this task.`,
          preview: `${result.tools.length} new tool${result.tools.length === 1 ? "" : "s"}`,
        };
      }

      case "http_request": {
        return await runHttpRequest({
          url: args.url,
          method: args.method,
          headers: args.headers,
          body: args.body,
        }, ctx);
      }

      case "web_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, summary: "No search query was provided." };
        const results = await searchWeb(query, ctx);
        return {
          ok: true,
          summary: `Web search results for "${query}":\n\n${results}`,
          preview: `search: ${query.slice(0, 60)}`,
        };
      }

      case "image_generate": {
        const prompt = String(args.prompt ?? "").trim();
        if (!prompt) return { ok: false, summary: "No image prompt was provided." };
        return await generateImageTool(prompt, ctx);
      }

      // ------------------------------------------------------- computer --
      case "computer_screenshot": {
        ctx.watchDesktop();
        const result = await relayAction("screenshot");
        if (!result.ok) return { ok: false, summary: result.error ?? "The screenshot failed." };
        const image = String(result.data?.image ?? "");
        if (!image) return { ok: false, summary: "The relay sent back no picture." };
        const buffer = Buffer.from(image, "base64");
        const blob = ctx.putBlob(buffer, "image/jpeg");
        const w = Number(result.data?.w) || null;
        const h = Number(result.data?.h) || null;
        ctx.showScreen("desktop", blob, w && h ? { w, h } : undefined);
        const picture = pictureFor(buffer, "image/jpeg");
        return {
          ok: true,
          summary: [
            "The desktop is now shown in the conversation for the person to see,",
            "and the picture is in this result for you to look at.",
            w && h
              ? `Its screen is ${w}×${h} pixels; click and move coordinates are in that` +
                " space, measured from the top-left."
              : "",
            picture ? "" : "It is too large to hand back as a picture; it is on the person's screen.",
          ].filter(Boolean).join(" "),
          preview: w && h ? `${w}×${h}` : "desktop",
          ...(picture ? { images: [picture] } : {}),
        };
      }

      case "computer_click": {
        ctx.watchDesktop();
        const result = await relayAction(
          args.double ? "double_click" : args.button === "right" ? "right_click" : "click",
          { x: Number(args.x), y: Number(args.y), button: args.button ?? "left" },
        );
        return result.ok
          ? { ok: true, summary: `Clicked at ${args.x},${args.y}.`, preview: `${args.x},${args.y}` }
          : { ok: false, summary: result.error ?? "The click failed." };
      }

      case "computer_move": {
        ctx.watchDesktop();
        const result = await relayAction("move", { x: Number(args.x), y: Number(args.y) });
        return result.ok
          ? { ok: true, summary: `Pointer moved to ${args.x},${args.y}.`,
              preview: `${args.x},${args.y}` }
          : { ok: false, summary: result.error ?? "The move failed." };
      }

      case "computer_type": {
        ctx.watchDesktop();
        const text = String(args.text ?? "");
        const result = await relayAction("type", { text });
        return result.ok
          ? { ok: true, summary: `Typed ${text.length} characters.`,
              preview: text.length > 24 ? `${text.slice(0, 24)}…` : text }
          : { ok: false, summary: result.error ?? "Typing failed." };
      }

      case "computer_key": {
        ctx.watchDesktop();
        const keys = (Array.isArray(args.keys) ? args.keys : [args.keys])
          .filter(Boolean)
          .map(String);
        if (keys.length === 0) return { ok: false, summary: "No keys were given." };
        const result = await relayAction("key", { keys });
        return result.ok
          ? { ok: true, summary: `Pressed ${keys.join(", then ")}.`,
              preview: keys.join(" ") }
          : { ok: false, summary: result.error ?? "The keystroke failed." };
      }

      case "computer_scroll": {
        ctx.watchDesktop();
        const result = await relayAction("scroll", { dy: Number(args.dy ?? -400) });
        return result.ok
          ? { ok: true, summary: `Scrolled by ${args.dy}.`, preview: String(args.dy) }
          : { ok: false, summary: result.error ?? "The scroll failed." };
      }

      // ---------------------------------------------------------- voice --
      case "voice_mute": {
        const muted = args.muted !== false;
        updateToolSettings({ voice: { enabled: !muted } });
        ctx.mute?.(muted);
        return {
          ok: true,
          summary: muted
            ? "Muted: nothing is said out loud on the page any more, and the speak " +
              "tool is off until it is turned back on in Settings -> Model & tools -> Voice."
            : "Unmuted: the speak tool can be heard on the page again.",
        };
      }
      case "speak": {
        const text = String(args.text ?? "").replace(/\s+/g, " ").trim();
        if (!text) return { ok: false, summary: "Nothing to say." };
        if (text.length > MAX_SPOKEN_CHARS) {
          return {
            ok: false,
            summary: `That is ${text.length.toLocaleString("en-US")} characters; say at most ${
              MAX_SPOKEN_CHARS.toLocaleString("en-US")} per call, in more than one call if you need to.`,
          };
        }
        if (!ctx.speak) return { ok: false, summary: "There is no page open to speak on." };
        ctx.speak(text);
        const voice = await speechStatus().catch(() => null);
        return {
          ok: true,
          summary: voice?.available
            ? `Played aloud on the person's page in the ${voice.voice} voice from ${voice.url}. Nothing else to do: do not also make or attach an audio file.`
            : "Played aloud on the person's page in the browser's own voice (no Deepgram key is set up). Nothing else to do: do not also make or attach an audio file.",
          preview: text.slice(0, 80),
        };
      }

      /* ------------------------------------------------------- live view -- */
      case "camera_look": {
        const frame = latestFrame(ctx.session);
        if (!frame) {
          return {
            ok: false,
            summary:
              "Live view is off: nothing is coming in from the camera. It is on only while the " +
              "person is in talk mode with the view switched on, so say so rather than asking again.",
          };
        }
        const image = frameImage(frame);
        if (!image) {
          return { ok: false, summary: "That frame is too large to hand over as a picture." };
        }
        const agoMs = Date.now() - frame.at;
        const ago = agoMs < 1500 ? "just now" : `${Math.round(agoMs / 1000)}s old`;
        return {
          ok: true,
          summary:
            `The newest frame from the person's camera (${ago}) is in this result. It is the only ` +
            "one there is -- earlier frames were never kept -- so anything that has already gone " +
            "from the view is gone.",
          preview: `camera frame (${ago})`,
          images: [image],
        };
      }

      // -------------------------------------------------------- widgets --
      case "widget_show": {
        const html = String(args.html ?? "");
        if (!html.trim()) return { ok: false, summary: "The widget has no HTML." };
        if (html.length > MAX_WIDGET_CHARS) {
          return {
            ok: false,
            summary: `The widget is ${html.length.toLocaleString("en-US")} characters; the limit is ${
              MAX_WIDGET_CHARS.toLocaleString("en-US")}. Generate repetitive geometry or data in script instead of writing it out.`,
          };
        }
        const title = String(args.title ?? "").trim().slice(0, 120) || "Explainer";
        const asked = Number(args.height);
        const height = Number.isFinite(asked) && asked > 0
          ? Math.round(Math.min(WIDGET_MAX_HEIGHT, Math.max(WIDGET_MIN_HEIGHT, asked)))
          : WIDGET_DEFAULT_HEIGHT;
        const check = await checkWidget({ title, html, height });
        if (!check.ok) {
          return {
            ok: false,
            summary:
              `The widget "${title}" was NOT shown to the person: it failed when it was tried.\n\n${check.report}\n\n` +
              "Fix the cause and call widget_show again with the whole corrected widget.",
            preview: `${title}: failed its check`,
          };
        }

        // A copy that opens on its own, Three.js and all, from the Artifacts page.
        let artifact: string | undefined;
        try {
          artifact = saveArtifact({
            origin: "agent", name: `${slug(title)}.html`,
            data: Buffer.from(widgetDocument({ title, html }), "utf8"),
            mime: "text/html", session: ctx.session, note: `Interactive widget: ${title}`,
          }).id;
        } catch {
          // The widget is still in the thread; losing the copy is not a failure.
        }
        ctx.showWidget({ title, html, height, ...(artifact ? { artifact } : {}) });
        return {
          ok: true,
          summary:
            `The widget "${title}" is now shown in the conversation${artifact ? ` (saved as artifact ${artifact})` : ""}.\n\n` +
            `${check.report}\n\n` +
            (check.checked
              ? "If this is not what you meant it to look like or do, fix it and call widget_show again. "
              : "") +
            "Errors it throws later in the person's browser are reported to you in the conversation.",
          preview: check.checked ? title : `${title} (unchecked)`,
        };
      }

      // ------------------------------------------------------ artifacts --
      case "artifact_save": {
        const name = String(args.name ?? "").trim();
        if (!name) return { ok: false, summary: "An artifact needs a file name." };
        const given = String(args.path ?? "").trim();
        // Relative to where the terminal runs, which is where the agent just
        // made the file -- not to wherever the server was started from.
        const from = given ? path.resolve(terminalDir(), given) : "";
        let data: Buffer;
        if (from) {
          if (!fs.existsSync(from)) return { ok: false, summary: `There is no file at ${from}.` };
          const stat = fs.statSync(from);
          if (!stat.isFile()) return { ok: false, summary: `${from} is not a file.` };
          if (stat.size > MAX_ARTIFACT_BYTES) {
            return { ok: false, summary: `${from} is ${formatSize(stat.size)}; artifacts are capped at ${formatSize(MAX_ARTIFACT_BYTES)}.` };
          }
          data = fs.readFileSync(from);
        } else if (typeof args.content === "string") {
          data = Buffer.from(args.content, "utf8");
        } else {
          return { ok: false, summary: "Give either the file's content or a path to it." };
        }
        // Saving a name that is already up there rewrites that artifact, so
        // say which happened: "saved" reads as a new card beside the old one.
        const had = listArtifacts().find((a) => a.origin === "agent" && a.name === cleanName(name));
        const art = saveArtifact({
          origin: "agent", name, data, session: ctx.session,
          note: String(args.note ?? "").trim() || undefined,
        });
        const filedIn = String(args.notebook ?? "").trim();
        let filed = "";
        if (filedIn) {
          const { book, made } = notebookFor(filedIn);
          addEntries(book.id, [{ artifact: art.id, text: args.note }], "agent");
          filed = made ? ` Filed in a new notebook ${book.id}, "${book.title}".` : ` Filed in "${book.title}" (${book.id}).`;
        }
        return {
          ok: true,
          summary: (had
            ? `Updated the artifact ${art.id} (${art.name}, ${formatSize(art.size)}); there is one copy of it on the Artifacts page, now holding this version.`
            : `Saved as artifact ${art.id} (${art.name}, ${formatSize(art.size)}). The person can open and download it from the Artifacts page.`) + filed,
          preview: `${art.name} · ${formatSize(art.size)}`,
        };
      }

      case "artifact_list": {
        const origin = String(args.origin ?? "all");
        const all = listArtifacts().filter((a) => origin === "all" || a.origin === origin);
        if (all.length === 0) {
          return { ok: true, summary: "There are no artifacts yet.", preview: "0 artifacts" };
        }
        return {
          ok: true,
          summary: all.slice(0, 200).map(artifactLine).join("\n"),
          preview: `${all.length} artifact${all.length === 1 ? "" : "s"}`,
        };
      }

      case "artifact_read": {
        const id = String(args.id ?? "").trim();
        const meta = getArtifact(id);
        const data = meta ? readArtifact(id) : null;
        if (!meta || !data) return { ok: false, summary: `There is no artifact "${id}". Use artifact_list to see what there is.` };
        if (meta.mime.startsWith("image/") && meta.mime !== "image/svg+xml") {
          const blob = ctx.putBlob(data, meta.mime);
          ctx.showImage(blob, meta.name, meta.name);
          return {
            ok: true,
            summary: `${artifactLine(meta)}\nThe image is now shown in the conversation.`,
            preview: meta.name,
          };
        }
        if (!isText(meta.mime)) {
          if (meta.mime === "application/pdf") {
            return {
              ok: true,
              summary: `${artifactLine(meta)}\nA PDF: read it with pdf_read (text, form fields, attachments) and see its pages with pdf_look.`,
              preview: meta.name,
            };
          }
          return {
            ok: true,
            summary: `${artifactLine(meta)}\nNot a text file. It is on this host at ${
              artifactPath(meta.id)} if the terminal can read it (pdftotext, unzip, python...).`,
            preview: meta.name,
          };
        }
        const text = data.toString("utf8");
        const room = CONTEXT_CONFIG.maxToolTokens * 4 - 200;
        const offset = Math.max(0, Number(args.offset) || 0);
        const length = Math.min(room, Math.max(1, Number(args.length) || room));
        const part = text.slice(offset, offset + length);
        const rest = text.length - (offset + part.length);
        return {
          ok: true,
          summary: `${meta.name} (${text.length} characters${offset ? `, from ${offset}` : ""}):\n\n${part}${
            rest > 0 ? `\n\n[${rest} more characters -- read on with offset ${offset + part.length}]` : ""}`,
          preview: meta.name,
        };
      }

      case "notebook":
        return runNotebook(args, ctx);

      case "agents":
        return await runAgents(args, ctx);

      case "thread":
        return runThread(args, ctx);

      // ----------------------------------------------------------- PDFs --
      case "pdf_read":
      case "pdf_look":
      case "pdf_edit":
      case "pdf_compose":
      case "pdf_pages":
      case "pdf_redact":
      case "pdf_replace_text":
      case "pdf_compress":
        return await runPdfTool(spec.name, args, {
          session: ctx.session,
          cwd: terminalDir(),
          room: CONTEXT_CONFIG.maxToolTokens * 4 - 200,
          putBlob: ctx.putBlob,
          showImage: ctx.showImage,
          showFile: ctx.showFile,
          cancelled: ctx.cancelled,
          onCancel: ctx.onCancel,
          // The PDF window shows the work; an incognito chat keeps nothing on
          // disk, so it works on files without one.
          ...(ctx.memory.incognito ? {} : { desk: deskHooks(ctx.session) }),
          ...(ctx.held ? { held: (id: string) => ctx.held!("pdf", id) } : {}),
        });

      // ---------------------------------------------------------- video --
      case "video_open":
      case "video_look":
      case "video_import":
      case "video_edit":
      case "video_style":
      case "video_project":
      case "video_ui":
      case "video_catalog":
      case "video_frame":
      case "video_export":
        if (ctx.memory.incognito) {
          return { ok: false, summary: "Not available in an incognito chat: the video window keeps its projects on disk." };
        }
        return await runVideoTool(spec.name, args, {
          session: ctx.session,
          cwd: terminalDir(),
          showFile: ctx.showFile,
          putBlob: ctx.putBlob,
          showImage: ctx.showImage,
          cancelled: ctx.cancelled,
          ...(ctx.held ? { held: (subject: string) => ctx.held!("video", subject) } : {}),
        });

      // ---------------------------------------------------------- studio --
      case "studio_open":
      case "studio_look":
      case "studio_song":
      case "studio_track":
      case "studio_clip":
      case "studio_notes":
      case "studio_make":
      case "studio_play":
      case "studio_export":
        if (ctx.memory.incognito) {
          return { ok: false, summary: "Not available in an incognito chat: the music window keeps its song on disk." };
        }
        return await runStudioTool(ctx.session, spec.name, args, { showFile: ctx.showFile });

      // ---------------------------------------------------------- Office --
      case "office_guide":
      case "office_read":
      case "office_edit":
      case "office_check":
      case "office_look":
      case "office_open":
      case "office_pdf":
      case "office_create":
      case "office_convert":
        return await runOfficeTool(spec.name, args, {
          session: ctx.session,
          cwd: terminalDir(),
          room: CONTEXT_CONFIG.maxToolTokens * 4 - 200,
          showFile: ctx.showFile,
          putBlob: ctx.putBlob,
          showImage: ctx.showImage,
          ...(ctx.memory.incognito ? {} : { desk: deskHooks(ctx.session), win: officeHooks(ctx.session) }),
          ...(ctx.held ? { held: (_surface: "office", subject: string) => ctx.held!("office", subject) } : {}),
          off: (["docx", "xlsx", "pptx"] as const).filter((k) => !toolSettings()[{ docx: "pages", xlsx: "sheets", pptx: "slides" }[k] as "pages" | "sheets" | "slides"].enabled),
          cancelled: ctx.cancelled,
          onCancel: ctx.onCancel,
        });

      // --------------------------------------------------------- memory --
      case "memory_write": {
        if (ctx.memory.incognito) return incognitoMemory();
        const title = String(args.title ?? "").trim();
        const body = String(args.body ?? "").trim();
        if (!title || !body) {
          return { ok: false, summary: "A memory needs both a title and a body." };
        }
        /* Held to the mind's rules (see mindrules.ts): a subject in the title, one
           topic, nothing about the moment, a reference with its source. The refusal
           says what to change, so the next call can be right. */
        const verdict = checkEntry({
          title, body, kind: args.kind, tags: args.tags, subject: args.subject,
          facet: args.facet, source: args.source, version: args.version,
        });
        if (!verdict.ok) return { ok: false, summary: `Not written down. ${verdict.error}` };
        const e = verdict.entry;
        const { id, action } = ctx.memory.write({
          title: e.title, body: e.body, kind: e.kind, tags: e.tags, subject: e.subject,
          facet: e.facet, source: e.source, version: e.version, status: e.status,
        });
        const asked = verdict.notes.length ? ` ${verdict.notes.join(" ")}` : "";
        return {
          ok: true,
          summary: (action === "merged"
            ? `That was close to ${id}, so ${id} was updated rather than a copy added: "${e.title}".`
            : `Written down as ${id}: "${e.title}".`) + asked,
          preview: e.title,
        };
      }

      case "memory_update": {
        if (ctx.memory.incognito) return incognitoMemory();
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No memory id was given." };
        const patch = {
          title: typeof args.title === "string" ? args.title : undefined,
          body: typeof args.body === "string" ? args.body : undefined,
          kind: typeof args.kind === "string" ? args.kind : undefined,
          tags: Array.isArray(args.tags) ? args.tags.map(String) : undefined,
          subject: typeof args.subject === "string" ? args.subject : undefined,
          facet: typeof args.facet === "string" ? args.facet : undefined,
          source: typeof args.source === "string" ? args.source : undefined,
          version: typeof args.version === "string" ? args.version : undefined,
        };
        const changed = ctx.memory.update(id, patch);
        if (typeof changed === "string") return { ok: false, summary: `Not changed. ${changed}` };
        if (!changed) {
          return { ok: false, summary: `There is no memory ${id}. memory_search shows the ids.` };
        }
        return { ok: true, summary: `Updated ${id}.`, preview: id };
      }

      case "memory_forget": {
        if (ctx.memory.incognito) return incognitoMemory();
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No memory id was given." };
        const replacedBy = typeof args.replaced_by === "string" ? args.replaced_by.trim() : null;
        if (!ctx.memory.forget(id, replacedBy)) {
          return {
            ok: false,
            summary: `There is no memory ${id}${replacedBy ? ` or ${replacedBy}` : ""}. memory_search shows the ids.`,
          };
        }
        return {
          ok: true,
          summary: replacedBy ? `${id} is retired in favour of ${replacedBy}.` : `${id} is forgotten.`,
          preview: id,
        };
      }

      case "memory_confirm": {
        if (ctx.memory.incognito) return incognitoMemory();
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No memory id was given." };
        const note = typeof args.note === "string" ? args.note.trim() : "";
        if (!ctx.memory.confirm(id, note)) {
          return { ok: false, summary: `There is no memory ${id}. memory_search shows the ids.` };
        }
        return {
          ok: true,
          summary: `Marked ${id} as checked today${note ? ", with what you found added to it" : ""}.`,
          preview: id,
        };
      }

      case "memory_search": {
        const query = String(args.query ?? "").trim();
        if (!query) return { ok: false, summary: "No search terms were given." };
        const found = ctx.memory.search(query);
        if (found.length === 0) {
          return { ok: true, summary: `Nothing in memory matches "${query}".`, preview: "0 found" };
        }
        return {
          ok: true,
          summary: found
            .map((m) => `- ${m.id} [${m.kind}${m.status === "provisional" ? ", unconfirmed" : ""}] ${m.title}: ${m.body}` +
              (m.kind === "reference" && m.source ? ` (source ${m.source}${m.fetched ? `, read ${new Date(m.fetched * 1000).toISOString().slice(0, 10)}` : ""})` : ""))
            .join("\n"),
          preview: `${found.length} found`,
        };
      }

      case "vault_read": {
        const id = String(args.id ?? "").trim();
        if (!id) return { ok: false, summary: "No artifact id was given." };
        const text = ctx.vault(id);
        if (text === null) {
          return {
            ok: false,
            summary:
              `There is no vault artifact "${id}" -- it may have been evicted, ` +
              "or the server restarted. Run the tool again if you still need it.",
          };
        }
        // Kept under the ingestion cap, so what is read back is never itself
        // sent to the vault.
        const room = CONTEXT_CONFIG.maxToolTokens * 4 - 200;
        return { ok: true, summary: readVault(text, args, room), preview: id };
      }

      case "tool_create": {
        try {
          const { tool, replaced, warnings } = defineCustomTool({
            name: args.name, description: args.description, params: args.parameters,
            script: args.script, session: ctx.session,
          });
          return {
            ok: true,
            summary:
              `${replaced ? "Replaced" : "Saved"} ${CUSTOM_PREFIX}${tool.name}. It is offered from the ` +
              "next step on, like any other tool. Try it once now to make sure it works." +
              (tool.params.length ? ` It takes: ${tool.params.map((p) => p.name).join(", ")}.` : " It takes no arguments.") +
              (warnings.length ? `\n\nWARNING: ${warnings.join(" ")}` : ""),
            preview: `${CUSTOM_PREFIX}${tool.name}`,
          };
        } catch (err: any) {
          return { ok: false, summary: err?.message ?? String(err) };
        }
      }

      case "tool_delete": {
        const name = String(args.name ?? "").trim();
        return deleteCustomTool(name)
          ? { ok: true, summary: `Deleted ${name}.`, preview: name }
          : { ok: false, summary: `There is no tool you wrote called ${name}.` };
      }

      case "game_open":
      case "game_look":
      case "game_edit":
      case "game_check":
      case "game_catalog":
      case "game_template":
      case "game_import":
        if (ctx.memory.incognito) {
          return { ok: false, summary: "Not available in an incognito chat: the game window keeps its game on disk." };
        }
        return await runGameTool(ctx.session, spec.name, args, { cwd: terminalDir() });

      case "photo_open":
      case "photo_look":
      case "photo_info":
      case "photo_commands":
      case "photo_edit":
      case "photo_export":
        if (ctx.memory.incognito) {
          return { ok: false, summary: "Not available in an incognito chat: the photo window keeps its picture on disk." };
        }
        return await runPhotoTool(ctx.session, spec.name, args, {
          cwd: terminalDir(),
          showFile: ctx.showFile,
          showImage: (data, alt, size) => ctx.showImage(ctx.putBlob(data, "image/png"), alt, null, size),
        });

      default: {
        // Autora 3D: one tool for each call the modeller declares (server/specs/cad.ts), run on the chat's model.
        if (spec.name.startsWith("cad_")) {
          if (ctx.memory.incognito) return { ok: false, summary: "An incognito chat keeps nothing, so it has no 3D window. Model in a normal chat." };
          return await runCadTool(ctx.session, spec.name, args, { showFile: ctx.showFile });
        }
        const custom = spec.name.startsWith(CUSTOM_PREFIX) ? getCustomTool(spec.name) : undefined;
        if (custom) {
          const missing = missingArgs(custom, args);
          if (missing.length) {
            return { ok: false, summary: `${spec.name} needs ${missing.join(", ")}.` };
          }
          const settings = toolSettings().terminal;
          const outcome = await runCommand(custom.script, terminalDir(), settings.timeout, ctx, customEnv(custom, args));
          noteCustomRun(spec.name, outcome.ok);
          return outcome;
        }
        if (spec.group === "mcp") {
          const out = await callMcpTool(spec.name, args);
          return {
            ok: out.ok,
            summary: out.text,
            preview: out.text.replace(/\s+/g, " ").slice(0, 120),
          };
        }
        return { ok: false, summary: `There is no tool called "${spec.name}".` };
      }
    }
  } catch (err: any) {
    // Playwright in particular throws on a timeout, a detached element, a page
    // that navigated mid-click. All of those are things the model can react to.
    return { ok: false, summary: `${spec.name} failed: ${err?.message ?? String(err)}` };
  }
}

export async function capabilityBriefing(): Promise<string> {
  const groups = await groupStates();
  const lines: string[] = ["What you can actually do, right now, on this machine:"];

  for (const group of groups) {
    const head = group.available
      ? `- ${group.label}: available.`
      : group.enabled
        ? `- ${group.label}: turned on, but not usable right now.`
        : `- ${group.label}: turned off in Settings.`;
    lines.push(`${head} ${group.detail}`);
    if (group.available) {
      lines.push(`  Tools: ${group.tools.join(", ")}.`);
      lines.push("  These run straight away -- nothing waits on the person's approval.");
    }
  }

  if (groups.some((g) => g.group === "browser" && g.available)) lines.push(BROWSING_GUIDE, signInBriefing(), credentialsBriefing());
  if (groups.some((g) => g.group === "memory" && g.available)) lines.push(MEMORY_GUIDE);
  if (groups.some((g) => g.group === "voice" && g.available)) lines.push(VOICE_GUIDE);
  const windows = toolSettings();
  const offLine = (what: string) =>
    `- ${what}: turned off by the person on the Tools page; its tools are not yours this turn. ` +
    "If the task needs it, say so and that it is switched on there.";
  lines.push(TODO_GUIDE, windows.app.enabled ? APP_GUIDE : offLine("The Creator window"));

  const mcp = mcpTools();
  if (mcp.length > 0) {
    lines.push(
      `- MCP servers: ${mcp.length} tool${mcp.length === 1 ? "" : "s"} from connected servers, ` +
        "named mcp__<server>__<tool>. Use them like any other tool, in preference to the browser.",
    );
  }
  lines.push(
    "- Setting up MCP servers: always available. Tools: mcp_servers, mcp_offer. When the person asks about MCP servers or " +
      "integrations, answer from mcp_servers. When a task lives on a service with an API (GitHub, Slack, Notion, a database, " +
      "maps, library docs) and no connected server covers it, offer one with mcp_offer before reaching for the browser -- " +
      "once, with the reason in a line -- and use its tools if they say yes. Failing a ready-made one, write a small " +
      "one (mcp_offer tools=...). Do not offer for one-off lookups a page read answers faster, and never ask for keys in chat.",
  );
  lines.push(
    "- Artifacts: always available. Tools: artifact_list, artifact_read, artifact_save. Files the person uploaded are there " +
      "for you to read; save the deliverables you make with artifact_save so they can be found and downloaded later. Artifacts " +
      "are for what would otherwise be lost: a file you wrote, built or edited, or one the person asked you to keep. Do not " +
      "save a copy of a file already there, or a picture fetched from the web (its address still has it). Saving the same " +
      "name again updates that artifact in place: right when the file changed, wrong when it did not.",
  );
  lines.push(
    "- Notebooks: always available. Tool: notebook (and notebook= on artifact_save and browser_screenshot). A notebook is " +
      "the person's folder for one purpose, on their Notebooks page. To compile, assemble or build a case, report or dossier " +
      "from several sources, work in a notebook: file every source, annotated with what it shows; write each finding, rebuttal " +
      "or answer as a note citing the files it rests on, quoting the exact words you rely on. Go through every source, not a " +
      "sample. Before you say it is done, read the notebook back and check each source is filed and each claim cites one.",
  );
  lines.push(
    "- Organization and Threads: always available. Tools: agents, thread. The person can set up other agents on the " +
      "Organization page, each with its own task and a note on when it should be called; the agents tool lists them and " +
      "starts one. " +
      HIRING + " Threads is a forum for agents (and the person) to post, comment and like outside the main work; use the " +
      "thread tool when you have something worth saying there, not to report on work you were asked for.",
  );
  const org = orgBriefing();
  if (org) lines.push(org);
  lines.push(windows.pdf.enabled
    ? "- Autora PDF (the PDF window): always available. Tools: pdf_read, pdf_look, pdf_edit, pdf_compose, " +
      "pdf_pages, pdf_redact, pdf_replace_text, pdf_compress. To write a report or any document as a PDF, use pdf_compose " +
      "(headings, paragraphs, tables, sources; it keeps the document so you can update a section later rather than start again). " +
      "For any PDF -- uploaded, on this host, or made by you -- use these rather than the terminal: read it (text, form fields, " +
      "attachments, XFA), look at its pages, fill its form, sign, stamp, mark up, watermark, number pages, rearrange, merge, " +
      "split, redact for good, shrink. Each change is a new artifact; the original is never changed. " +
      "Check your changes with pdf_look before saying it is done."
    : offLine("Autora PDF"));
  lines.push(windows.video.enabled
    ? "- Autora Video (the video window, OpenCut's editor): always available. Tools: video_open, video_look, video_import " +
      "(an artifact id or a path), video_edit, video_style, video_project, video_ui (any control on the editor's screen, " +
      "clicked and typed into), video_catalog, video_frame (see a moment of the video) and video_export. Every part of the " +
      "editor is yours: when the typed tools do not cover something, read the screen with video_ui and do it as a person would. For any video the person wants made or " +
      "changed: open a project, import their footage, pictures and music, build the cut with video_edit, then read it back with " +
      "video_look and see it with video_frame before you say it is done. The person watches the timeline change and can take " +
      "the editor over; leave it alone while they hold it. Their creative choices (the story, the pacing, the " +
      "music, the look) stay theirs: ask and suggest, and do the technical work completely. Export only when they ask for a file."
    : offLine("Autora Video"));
  lines.push(studioBriefing(windows.studio.enabled));
  // Only a server that has the modeller built in says anything about it.
  if (cadAvailable()) lines.push(cadBriefing(windows.cad.enabled));
  if (gameAvailable()) lines.push(gameBriefing(windows.game.enabled));
  if (photoAvailable()) lines.push(photoBriefing(windows.photo.enabled));
  lines.push(windows.widgets.enabled
    ? "- Explainer widgets: always available. Tool: widget_show. When someone " +
      "asks how something works -- a physical process, a mechanism, an " +
      "algorithm, a piece of maths -- and seeing it move would help, build a " +
      "small interactive widget (2D canvas/SVG, or 3D with Three.js) and explain " +
      "in text alongside it. Not for plain facts, lists or anything a sentence answers."
    : offLine("The widget window"));
  const officeOn = Boolean(officeDir());
  for (const [on, name] of [[windows.pages.enabled, "Autora Pages"], [windows.sheets.enabled, "Autora Sheets"], [windows.slides.enabled, "Autora Slides"]] as const) {
    if (!on) lines.push(offLine(name));
  }
  if (officeOn && (windows.pages.enabled || windows.sheets.enabled || windows.slides.enabled)) {
    lines.push(OFFICE_GUIDE(windows.pages.enabled, windows.sheets.enabled, windows.slides.enabled));
  }
  lines.push(WINDOWS_GUIDE);
  // How the windows fit together; each window's manual arrives with its first tool call (server/handbook.ts).
  lines.push(windowsOverview());
  lines.push(
    "- Your voice: always available. Tool: speak. It plays words aloud on the " +
      "person's page at once, in the voice chosen under Settings -> Voice. When you " +
      "are asked to say or read something out loud, call speak -- do not make an " +
      "audio file, call Deepgram yourself, or present a recording. With " +
      "live voice on, your replies are already read aloud; do not repeat them with speak.",
  );
  lines.push(
    "- Work that happens later: always available. Tools: schedule, schedules, unschedule. A scheduled job is a task and a " +
      "cron time, run as a turn of its own in a new session; a watcher looks at a page, a file or a command and runs its task " +
      "only when what it sees changed. Set one whenever what you were asked for is not due yet or has to be checked again -- " +
      "instead of a sleep, a poll, or saying you cannot. Nothing runs while the machine is off. Say that you set it, and what it " +
      "will do.",
  );
  lines.push(
    "- Work that outlives the turn: always available. Tools: run_background, background_jobs, background_output, " +
      "background_stop. A background command is the terminal's shell, detached, so it keeps going after the turn ends: use it " +
      "for a build, a long test run, a download, anything slower than the terminal's time limit. Never sleep or poll for one " +
      "in the same turn; read it next turn, or use schedule.",
  );
  lines.push(
    "- The machine you are on: always available. Tool: inventory. What is installed, what is not, the shell, the working " +
      "directory and the disk, looked at now. The first turn of a session is given this; look again after installing " +
      "something or a restart, rather than guessing or trusting an old memory of it.",
  );
  lines.push(
    "- Standing agreements: always available. Tools: pre_authorise, pre_authorisations. The console holds a call that looks " +
      "destructive and unasked-for; when the person lets one through, that class of work is remembered so it is not put to " +
      "them again. pre_authorise adds one yourself for harmless work you keep being held on, and says why. Nothing " +
      "irrecoverable can ever be covered.",
  );
  lines.push(
    "- Asking the person: always available. Tool: ask_user. When you are " +
      "genuinely stuck on something only they can settle, ask with a short " +
      "question and a few concrete options rather than guessing or stopping " +
      "with a question in prose. Sign-ins go through browser_handoff instead.",
  );

  const off = groups.filter((g) => !g.available);
  if (off.length > 0) {
    lines.push(
      "",
      "Do not pretend to use what is not available, and do not write out " +
        "commands or their output as if you had run them. If something you need " +
        "is off or unusable, say which of the above it is and what would fix it.",
    );
  }
  if (groups.some((g) => g.available)) {
    lines.push(
      "",
      "These are real. The terminal runs on a real host, the browser opens real pages -- streamed live, so the person watches " +
        "every page load, pointer move and keystroke as you make it -- and the desktop belongs to a real person who is " +
        "watching. Take the actions you are asked for rather than describing them, and read each result before the next.",
    );
  }

  return lines.join("\n");
}

/** How long a passed CAPTCHA must stay passed before the turn carries on:
    two looks, so a checkbox that flickers ticked on its way to a picture
    challenge does not hand the page back mid-puzzle. */
const CAPTCHA_STEADY_POLLS = 2;

/**
 * A watch for a handoff that is about a CAPTCHA: settles it as soon as the
 * page shows the check passed, so the person solves the puzzle and the agent
 * simply carries on -- nobody has to come back and say "done".
 *
 * Only armed when there is a CAPTCHA to watch: on the page now, or named in
 * the reason (a Cloudflare page can take a moment to draw its widget). A
 * sign-in has no such signal and still waits for the person to say so.
 */
export async function captchaWatch(
  live: { captchaStatus(): Promise<{ present: boolean; passed: boolean; url: string | null }> },
  reason: string,
): Promise<(() => Promise<string | null>) | undefined> {
  const first = await live.captchaStatus().catch(() => null);
  if (!first) return undefined;
  const named = /captcha|recaptcha|hcaptcha|turnstile|cloudflare|verif|robot|human/i.test(reason);
  if (first.passed || (!first.present && !named)) return undefined;

  let seen = first.present;
  let steady = 0;
  return async () => {
    const now = await live.captchaStatus().catch(() => null);
    if (!now) return null;
    if (now.present) seen = true;
    // Passed on the page, or gone from it after being there (a Cloudflare
    // interstitial lets you through by leaving).
    const through = now.passed || (seen && !now.present);
    steady = through ? steady + 1 : 0;
    if (steady < CAPTCHA_STEADY_POLLS) return null;
    return now.passed ? "CAPTCHA passed — carrying on" : "Verification cleared — carrying on";
  };
}
