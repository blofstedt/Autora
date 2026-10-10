/**
 * Everything the console remembers between restarts: which model to call,
 * which keys to call it with, the standing instructions, and what has been
 * spent so far.
 *
 * It lives in one JSON file under `.autora/` (gitignored), written whenever
 * something changes and read once at startup. Before this, settings were held
 * in a module-level object: a key pasted into the panel survived exactly as
 * long as the process did, which on a container that restarts on deploy is not
 * long, and the spend counter would have reset with it -- a bill that forgets
 * itself is not a bill.
 *
 * The file holds API keys in plain text, so it is created with owner-only
 * permissions and the settings panel says out loud where they are kept. Keys
 * set in the environment are still honoured and are never written here; the
 * environment wins nothing and loses nothing, it is simply the fallback when
 * the app has not been given a key of its own.
 */

import fs from "node:fs";
import path from "node:path";
import { isEphemeral } from "./ephemeral";
import { AUTO_ORDER, PROVIDERS, providerSpec } from "./providers";
import { LOOP_DEFAULTS, type LoopWatchConfig } from "./loopwatch";
import { mergeVerify, VERIFY_DEFAULTS, type VerifyConfig } from "./verify";
import type { McpServerConfig } from "./mcp";
import { DEFAULT_CAPTCHA, mergeCaptcha, type CaptchaSettings } from "./captcha";
import { DEFAULT_PROACTIVITY, mergeProactivity, type Proactivity } from "./quiet";
import { AUTOMATION_DEFAULTS, mergeAutomation, type AutomationBudget } from "./automation";
import { defaultPush, mergePush, type PushSettings } from "./push";

export const THEMES = ["violet", "teal", "nous-blue", "midnight", "ember", "mono", "cyberpunk", "rose"] as const;
export const FONTS = ["inter", "system", "rounded", "mono"] as const;
/** How big the words and the icons are. Named, not numbered: the step is
    picked in the UI and its multiplier is the client's business. */
const TEXT_SIZES = ["small", "default", "large", "largest"] as const;
const ICON_SIZES = TEXT_SIZES;
const COLUMNS = ["comfort", "wide", "fill"] as const;
/** Which of the app's pages a pinned corner widget shows. */
const DOCK_WIDGETS = [
  "none", "system", "usage", "schedules", "mind",
  "artifacts", "sessions", "integrations", "settings",
] as const;
const DOCK_SLOTS = ["tl", "tr", "bl", "br"] as const;
interface Appearance {
  theme: (typeof THEMES)[number];
  font: (typeof FONTS)[number];
  text: (typeof TEXT_SIZES)[number];
  icons: (typeof ICON_SIZES)[number];
  column: (typeof COLUMNS)[number];
  dock: Record<(typeof DOCK_SLOTS)[number], (typeof DOCK_WIDGETS)[number]>;
}

/**
 * Which of Deepgram's hosted voices the console speaks in.
 *
 * Empty by default, which means "whatever the environment says" -- so an
 * install that has never been near the settings panel keeps working exactly as
 * before, and one that has merely set AUTORA_DEEPGRAM_VOICE is heard through it
 * without being configured at all. See ../server/speech.ts.
 *
 * It used to hold a second service and the address of a local voice server
 * running on the same box; both are gone, and the two fields with them. An old
 * settings file still carrying them loads fine -- they are simply ignored.
 */
interface SpeechSettings {
  voice: string;
  /** Whether a turn that was spoken to the console may think before it
      answers. Off by default: on a reasoning model the thinking is most of
      the wait before the first word -- the whole of the wait, in live voice --
      and a conversation wants the answer. Typed turns think as they please. */
  liveThinking: boolean;
  /** Live view: whether talk mode opens with the camera on, so the agent can
      see what is being shown to it while the person talks. Off by default --
      a camera that comes on when somebody opens voice mode is a surprise, and
      the switch is right there in the live bar. */
  liveView: boolean;
  /* `handsFree` was here, the switch between holding the mark and leaving the
     microphone open. There is no such switch any more -- the microphone is
     open in talk mode and answers to its own name, which is what makes talking
     over an answer work -- so the field is gone. An old settings file still
     carrying it loads fine, like the two before it: it is simply ignored. */
}

const DEFAULT_SPEECH: SpeechSettings = {
  voice: "",
  liveThinking: false,
  liveView: false,
};

export function mergeSpeech(into: SpeechSettings, patch: any): SpeechSettings {
  if (!patch || typeof patch !== "object") return into;
  if (typeof patch.voice === "string") into.voice = patch.voice.trim().slice(0, 60);
  if (typeof patch.liveThinking === "boolean") into.liveThinking = patch.liveThinking;
  if (typeof patch.liveView === "boolean") into.liveView = patch.liveView;

  return into;
}

type ApprovalMode = "always" | "risky" | "never";

/**
 * What the workspace keeps, and what it lets go (see ./retention, which does
 * the work). 0 days means "never on age alone"; the `keep` numbers are a
 * floor under any sweep, so housekeeping cannot empty the app of the threads
 * somebody was in the middle of.
 */
export interface RetentionPolicy {
  sessionDays: number;
  keepSessions: number;
  artifactDays: number;
  keepArtifacts: number;
}

export const RETENTION_DEFAULTS: RetentionPolicy = {
  sessionDays: 180,
  keepSessions: 500,
  artifactDays: 365,
  keepArtifacts: 500,
};

/** Out of whatever was posted, only numbers in a sane range. */
export function mergeRetention(into: RetentionPolicy, patch: any): RetentionPolicy {
  const clamp = (value: unknown, low: number, high: number, fallback: number) => {
    const n = Number(value);
    return Number.isFinite(n) ? Math.min(high, Math.max(low, Math.round(n))) : fallback;
  };
  into.sessionDays = clamp(patch?.sessionDays, 0, 3650, into.sessionDays);
  into.artifactDays = clamp(patch?.artifactDays, 0, 3650, into.artifactDays);
  into.keepSessions = clamp(patch?.keepSessions, 1, 100_000, into.keepSessions);
  into.keepArtifacts = clamp(patch?.keepArtifacts, 1, 100_000, into.keepArtifacts);
  return into;
}

/** What each loop-watch knob may be, so a mistyped number cannot stop every
    turn on the second call. */
const LOOP_LIMITS: Record<keyof LoopWatchConfig, [number, number]> = {
  warnAt: [2, 50],
  stopAt: [3, 200],
  staleAfter: [2, 200],
  checkEvery: [1, 500],
  stallAfter: [3, 200],
};

/** The knobs were fixed in code and invisible, so a turn could be stopped by
    a rule nobody could see or change. They are settings now, clamped. */
export function mergeLoop(into: LoopWatchConfig, patch: any): LoopWatchConfig {
  for (const key of Object.keys(LOOP_LIMITS) as (keyof LoopWatchConfig)[]) {
    const [low, high] = LOOP_LIMITS[key];
    const n = Number(patch?.[key]);
    if (Number.isFinite(n)) into[key] = Math.min(high, Math.max(low, Math.round(n)));
  }
  if (into.stopAt <= into.warnAt) into.stopAt = Math.max(into.warnAt + 1, LOOP_DEFAULTS.stopAt);
  return into;
}

interface ToolSettings {
  terminal: {
    enabled: boolean;
    /** Where commands run. Empty means the server's own working directory. */
    cwd: string;
    /** Seconds before a command is killed. */
    timeout: number;
    approval: ApprovalMode;
    /** Optional shell override, e.g. /bin/bash, /bin/sh. Defaults to auto-detection. */
    shell?: string;
  };
  browser: { enabled: boolean; approval: ApprovalMode };
  computer: { enabled: boolean; approval: ApprovalMode };
  memory: { enabled: boolean; approval: ApprovalMode };
  /** Whether the agent's own speak tool is heard. Off by default: the tool is
      the agent asking to be listened to, and a switch is how somebody in a
      quiet room says "not now" without turning the whole voice off. */
  voice: { enabled: boolean; approval: ApprovalMode };
  /** The built-in windows the Tools page switches beside the browser: the
      explainer widgets, the app (construction) window and the PDF editor. */
  widgets: { enabled: boolean };
  app: { enabled: boolean };
  pdf: { enabled: boolean };
  /** Autora Video (OpenCut's editor): the video_* tools and the window beside the chat. */
  video: { enabled: boolean };
  /** Autora Music, the music window: the studio_* tools and the window beside the chat. */
  studio: { enabled: boolean };
  /** Autora Pages (.docx), Autora Sheets (.xlsx) and Autora Slides (.pptx): each its own switch, for the
      Office tools' work on that kind of file and its window beside the chat. */
  pages: { enabled: boolean };
  sheets: { enabled: boolean };
  slides: { enabled: boolean };
  /** Autora 3D: the 3D modelling window and the agent's cad_* tools. */
  cad: { enabled: boolean };
  /** Autora Games: the game window (GDevelop's editor) and the agent's game_* tools. */
  game: { enabled: boolean };
  /** Autora Photo: the photo editing window (PhotoCraft's editor) and the agent's photo_* tools. */
  photo: { enabled: boolean };
}

export interface UsageEntry {
  ts: number;
  session: string;
  provider: string;
  model: string;
  input: number;
  output: number;
  /** USD, computed at the time of the call from the price then in force. */
  cost: number;
  /** False when the model was not in the price table, so the cost above is a
      zero standing in for "unknown" rather than a genuinely free call. */
  priced: boolean;
  /** True when the token counts are our own arithmetic, because the vendor
      streamed an answer without reporting usage. */
  estimated: boolean;
  /** Of `input`, how many tokens the provider served from its prompt cache.
      Missing on entries recorded before this was tracked. */
  cached?: number;
  /** The cost above, split by where it went, in USD. Missing on entries
      recorded before this was tracked. */
  parts?: CostParts;
}

/** A model call's cost by kind of token. */
export interface CostParts {
  /** Input the provider had not seen: new tool output, the latest message. */
  fresh: number;
  /** Input served from the provider's cache (and, for Anthropic, written to it). */
  cached: number;
  output: number;
}

/** How much tool output went to the model this month, by tool. */
interface ToolFeed {
  month: string;
  tools: Record<string, { calls: number; tokens: number }>;
}

interface PersistedState {
  provider: string;
  /** Chosen model per provider, so switching vendors and back does not lose
      the choice you made the first time. */
  models: Record<string, string>;
  /** The model talk mode answers with, per provider. Separate from the one
      above on purpose: a reasoning model is the right thing to think a task
      through and the wrong thing to wait for the first word of a sentence, so
      live voice may answer with a faster model of the same vendor and hand
      over when the question turns out to need the work. Empty means talk mode
      uses the main model, exactly as it did before this existed. */
  fastModels: Record<string, string>;
  /** Per-provider API root override. Mostly for local servers and proxies. */
  baseUrls: Record<string, string>;
  systemPrompt: string;
  /** Provider id (or voice credential name) -> secret. */
  keys: Record<string, string>;
  /** Secure workspace secrets (e.g. GITHUB_TOKEN, API keys) injected into terminal & tools. */
  secrets: Record<string, string>;
  /** Monthly ceiling in USD, or null for none. Advisory: it warns, it does not
      refuse -- a console that silently stops answering is a support ticket. */
  budgetUsd: number | null;
  /** What each vendor says is left with it, keyed by provider id. Real spend
      is read as "paid in, less what is left" rather than counted from tokens,
      because counting cannot see a call that was charged without reporting.
      Per vendor, because a balance is one vendor's money: reading DeepSeek's
      and calling it the Orca Router bill is how a wrong number gets believed.
      See ./vendor-money. */
  balances: Record<string, number | null>;
  /** When each of those balances was last read, in seconds since the epoch. */
  balanceAts: Record<string, number>;
  /** Paid in (topped up) in total per provider, in USD. What came before the
      first reading is entered by hand; a later rise is folded in by itself. */
  topUps: Record<string, number>;
  /** A balance reading that would need explaining -- a rise that looks like a
      payment, or a drop to nothing -- held until a later reading agrees. Per
      provider. See ./vendor-money. */
  pendingReadings: Record<string, { balance: number; at: number }>;
  /** Payments the console worked out for itself from a rising balance, newest
      last, so a wrong one can be seen and taken back. Per provider. */
  autoTopUps: Record<string, { at: number; usd: number; balance: number }[]>;
  /** What each vendor's own till had spent when the month began, per provider,
      so the month is the vendor's arithmetic too. `since` is when that was read. */
  monthBases: Record<string, { month: string; spent: number; since: number }>;
  /** Which tools' output the model has been reading, this month. */
  toolFeed: ToolFeed;
  usage: UsageEntry[];
  /** One-off corrections already applied to `usage`, by name, stamped with the
      second they were applied. See PRICE_REPAIRS. */
  repairs: Record<string, number>;
  /** Which of the agent's groups of tools are on, and how tightly each is
      gated. See ./tools for what each group actually is. */
  tools: ToolSettings;
  /** MCP servers whose tools are offered to the agent. */
  mcpServers: McpServerConfig[];
  /** How a CAPTCHA picture challenge is answered: which backends to try,
      and the person's own solver if they run one. See ../server/captcha.ts. */
  captcha: CaptchaSettings;
  /** When the agent keeps its own initiative to itself: nothing unprompted
      is said inside these hours. See ../server/quiet.ts. */
  proactivity: Proactivity;
  /** Theme and font, kept here so they follow you between devices. */
  appearance: Appearance;
  /** The voice the console speaks in, and the server it comes from. */
  speech: SpeechSettings;
  /** Whether the agent looks back over its work after a turn and writes
      down what it learned (as unconfirmed memories). */
  learning: boolean;
  /** Whether the agent's work is shown as it is done: the cursor in the PDF
      and app windows, and code typed out in the thread. A presentation only --
      off, the work is the same and simply appears. */
  agentCursor: boolean;
  /** Whether the agent says a short word about what the person does in the
      windows they share, when no turn is running (server/companion.ts). */
  collabRemarks: boolean;
  /** Whether the agent reads a site's official documentation before acting on a site it has nothing current on. */
  groundFirst: boolean;
  /** The person's time zone (an IANA name such as Europe/Stockholm), or empty
      to follow the machine. The clock every schedule, watcher and quiet hour
      is read on: in the Umbrel container that is UTC unless something sets it,
      so "8am" was 8am somewhere the person is not. See applyTimezone. */
  timezone: string;
  /** When a turn is called a loop: repeats that earn a note, repeats that
      stop the turn, and how often it is asked to check itself. */
  loop: LoopWatchConfig;
  /** The project check run when the agent says it is finished (see
      server/verify.ts). Empty command: off. */
  verify: VerifyConfig;
  /** How long sessions and artifacts are kept. */
  retention: RetentionPolicy;
  /** What automated runs -- schedules and watchers -- may cost, kept apart
      from what the person spends talking to the agent. See
      server/automation.ts. */
  automation: AutomationBudget;
  /** Which kinds of news reach the person's phone, through the installed
      app. See server/push.ts. */
  push: PushSettings;
}

export const DEFAULT_PROMPT =
  "You are Autora, an autonomous AI execution console and agent workspace.";

/**
 * The person's own rules, out of the stored prompt.
 *
 * The stored prompt starts life as the identity line above, and people type
 * their house rules under it (or over it). The identity always opens the
 * instructions anyway, so it is taken off here: what is left is only what
 * the person wrote, which is what has to be stated as theirs.
 */
export function standingRules(prompt: string): string {
  let text = prompt.trim();
  if (text.startsWith(DEFAULT_PROMPT)) text = text.slice(DEFAULT_PROMPT.length).trim();
  return text;
}

/**
 * What the tools do before anybody visits Settings.
 *
 * Capable, and ungated (yolo mode). Every group is on and nothing pauses for
 * approval in chat: each call runs straight away and is shown in the thread
 * as it happens.
 *
 * Turning a group off is a real answer too: it removes the tools from the
 * model's schema entirely and the agent is told, in words, that the group is
 * off rather than left to guess why it cannot do something.
 */
export function defaultTools(): ToolSettings {
  return {
    /* Yolo mode: nothing asks for approval in chat. */
    terminal: { enabled: true, cwd: "", timeout: 120, approval: "never", shell: "" },
    browser: { enabled: true, approval: "never" },
    computer: { enabled: true, approval: "never" },
    memory: { enabled: true, approval: "never" },
    voice: { enabled: true, approval: "never" },
    widgets: { enabled: true },
    app: { enabled: true },
    pdf: { enabled: true },
    video: { enabled: true },
    studio: { enabled: true },
    pages: { enabled: true },
    sheets: { enabled: true },
    slides: { enabled: true },
    cad: { enabled: true },
    game: { enabled: true },
    photo: { enabled: true },
  };
}

/**
 * Fold a patch of tool settings into the live ones, field by field.
 *
 * The same function serves the settings file and the PATCH handler, because
 * they need identical trust: a file hand-edited into nonsense and a request
 * body from a stale client both arrive as arbitrary JSON, and neither should be
 * able to leave a group with no approval mode or a timeout of NaN. Anything
 * unrecognised is left at whatever it already was rather than cleared.
 */
export function mergeTools(into: ToolSettings, patch: any): ToolSettings {
  if (!patch || typeof patch !== "object") return into;
  const bool = (value: any, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback;
  /* Yolo mode: whatever a settings file or a stale client says, nothing is
     gated. Older settings files saved with "always" or "risky" land here too. */
  const mode = (_value: any, _fallback: ApprovalMode): ApprovalMode => "never";

  if (patch.terminal && typeof patch.terminal === "object") {
    into.terminal.enabled = bool(patch.terminal.enabled, into.terminal.enabled);
    into.terminal.approval = mode(patch.terminal.approval, into.terminal.approval);
    if (typeof patch.terminal.cwd === "string") {
      into.terminal.cwd = patch.terminal.cwd.trim();
    }
    if (typeof patch.terminal.shell === "string") {
      into.terminal.shell = patch.terminal.shell.trim();
    }
    if (patch.terminal.timeout !== undefined) {
      const seconds = Number(patch.terminal.timeout);
      // A minute is not always enough (installs, builds); half an hour of a
      // held turn is past the point anybody meant.
      if (Number.isFinite(seconds)) {
        into.terminal.timeout = Math.min(1800, Math.max(5, Math.round(seconds)));
      }
    }
  }
  for (const group of ["browser", "computer", "memory", "voice"] as const) {
    const given = patch[group];
    if (!given || typeof given !== "object") continue;
    into[group].enabled = bool(given.enabled, into[group].enabled);
    into[group].approval = mode(given.approval, into[group].approval);
  }
  /* One switch for all three, as it was before they were told apart (older settings files, stale clients). */
  if (patch.office && typeof patch.office === "object" && typeof patch.office.enabled === "boolean") {
    for (const key of ["pages", "sheets", "slides"] as const) into[key].enabled = patch.office.enabled;
  }
  for (const key of ["widgets", "app", "pdf", "video", "studio", "pages", "sheets", "slides", "cad", "game", "photo"] as const) {
    const given = patch[key];
    if (given && typeof given === "object") into[key].enabled = bool(given.enabled, into[key].enabled);
  }
  return into;
}

export function mergeAppearance(into: Appearance, patch: any): Appearance {
  if (!patch || typeof patch !== "object") return into;
  if ((THEMES as readonly string[]).includes(patch.theme)) into.theme = patch.theme;
  if ((FONTS as readonly string[]).includes(patch.font)) into.font = patch.font;
  if ((TEXT_SIZES as readonly string[]).includes(patch.text)) into.text = patch.text;
  if ((ICON_SIZES as readonly string[]).includes(patch.icons)) into.icons = patch.icons;
  if ((COLUMNS as readonly string[]).includes(patch.column)) into.column = patch.column;
  // The corners arrive as a part, so what is not mentioned stays as it was:
  // one slot can be cleared without disturbing the other three.
  if (patch.dock && typeof patch.dock === "object") {
    for (const slot of DOCK_SLOTS) {
      const pick = patch.dock[slot];
      if ((DOCK_WIDGETS as readonly string[]).includes(pick)) into.dock[slot] = pick;
    }
  }
  return into;
}

/** An MCP server entry from the file or a request, or null if it is not one. */
export function saneMcp(raw: any): McpServerConfig | null {
  if (!raw || typeof raw !== "object") return null;
  const name = String(raw.name ?? "").trim().slice(0, 40);
  if (!name) return null;
  const transport = raw.transport === "http" ? "http" : "stdio";
  const strings = (v: any) => Array.isArray(v) ? v.map((x) => String(x)) : [];
  const record = (v: any) => {
    const out: Record<string, string> = {};
    if (v && typeof v === "object") for (const [k, val] of Object.entries(v)) if (k.trim()) out[k.trim()] = String(val);
    return out;
  };
  return {
    id: String(raw.id || `mcp-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`),
    name,
    transport,
    command: transport === "stdio" ? String(raw.command ?? "").trim() : undefined,
    args: transport === "stdio" ? strings(raw.args) : undefined,
    env: transport === "stdio" ? record(raw.env) : undefined,
    url: transport === "http" ? String(raw.url ?? "").trim() : undefined,
    headers: transport === "http" ? record(raw.headers) : undefined,
    enabled: raw.enabled !== false,
    ...(raw.origin === "agent" ? { origin: "agent" as const } : {}),
    ...(typeof raw.note === "string" && raw.note.trim() ? { note: raw.note.trim().slice(0, 200) } : {}),
  };
}

/** How many turns of spend history to keep. Enough for a month of heavy use;
    the running totals are folded into `carried` as entries fall off the end,
    so the lifetime figure stays right even once detail is dropped. */
const MAX_USAGE = 5000;

/**
 * Where the settings file lives.
 *
 * AUTORA_STATE_DIR names it outright. Failing that, AUTORA_HOME -- which in
 * the container points at the one directory Umbrel keeps across an update --
 * so keys and the spend ledger survive the thing most likely to erase them.
 * Everything inside the image is replaced on every update; state written there
 * is state you lose without being told.
 */
const STATE_DIR = (() => {
  const named = (process.env.AUTORA_STATE_DIR || "").trim();
  if (named) return named;
  const home = (process.env.AUTORA_HOME || "").trim();
  if (home) return path.join(home, "settings");
  return path.join(process.cwd(), ".autora");
})();
const STATE_FILE = path.join(STATE_DIR, "settings.json");

/** One day's spend that has aged out of the ledger. */
interface CarriedDay { cost: number; input: number; output: number; turns: number }

/**
 * Spend that has aged out of the ledger, kept so the totals survive it.
 *
 * The day-by-day copy is not decoration. The ledger holds the last 5,000
 * calls, which a busy week can be; the headline figures are this month and
 * today, and a lump sum with no dates in it can only be added to the lifetime
 * figure. Left that way, "this month" quietly dropped everything that had
 * aged out of the ledger, and read low against the vendor's own bill by
 * exactly the spend that had fallen off the end.
 */
let carried: { cost: number; input: number; output: number; turns: number; days: Record<string, CarriedDay> } =
  { cost: 0, input: 0, output: 0, turns: 0, days: {} };

/** How long the per-day copy is kept: enough for this month and the chart. */
const CARRIED_DAYS_KEPT = 70;

/** Local-time YYYY-MM-DD, the day the person spending it would call it. */
function carriedDayKey(ts: number): string {
  const d = new Date(ts * 1000);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
}

function blank(): PersistedState {
  return {
    provider: "auto",
    models: {},
    fastModels: {},
    baseUrls: {},
    systemPrompt: DEFAULT_PROMPT,
    keys: {},
    secrets: {},
    budgetUsd: null,
    balances: {},
    balanceAts: {},
    topUps: {},
    pendingReadings: {},
    autoTopUps: {},
    monthBases: {},
    toolFeed: { month: "", tools: {} },
    usage: [],
    repairs: {},
    tools: defaultTools(),
    mcpServers: [],
    appearance: {
      theme: "violet", font: "inter", text: "default", icons: "default", column: "comfort",
      dock: { tl: "none", tr: "none", bl: "none", br: "none" },
    },
    speech: { ...DEFAULT_SPEECH },
    captcha: { ...DEFAULT_CAPTCHA, backends: [...DEFAULT_CAPTCHA.backends] },
    proactivity: { ...DEFAULT_PROACTIVITY },
    learning: true,
    agentCursor: true,
    collabRemarks: true,
    groundFirst: true,
    timezone: "",
    loop: { ...LOOP_DEFAULTS },
    verify: { ...VERIFY_DEFAULTS },
    retention: { ...RETENTION_DEFAULTS },
    automation: { ...AUTOMATION_DEFAULTS },
    push: defaultPush(),
  };
}

/* Corrections to spend already on the books. Each is applied once, as the file
   is read, and stamped in `repairs` so it can never be applied twice. None of
   them can raise a figure, only lower one that was wrong.

   cache-price-2026-10: a turn's cached input was priced from the vendor's own
   catalogue before the catalogue's cache-read price was read at all (the
   reader was fixed in 0.9.158), so every token the provider served from its
   prompt cache was charged as a fresh one. Orca Router publishes
   tencent/hy4-preview's cache reads at $0.042/M against $0.834/M fresh -- its
   /v1/models, read 2026-10-06 -- so the 87.4M cached Orca tokens recorded on
   2026-10-05/06 stood at $91.17 while Orca itself charged about $22 (paid in
   $20.07, balance -$0.31), and the month read $101.45 against a $20 ceiling.
   Only the cached part of a row is rewritten: the fresh and output parts came
   from the published price and were right. Rows already folded into the
   `carried` totals keep no token split to correct, and none of these are
   among them. */
export const PRICE_REPAIRS = [
  { name: "cache-price-2026-10", provider: "orcarouter", model: "tencent/hy4-preview", cachedPerMillion: 0.042 },
];

export function applyRepairs(next: PersistedState): PersistedState {
  for (const repair of PRICE_REPAIRS) {
    if (next.repairs[repair.name]) continue;
    next.repairs[repair.name] = Math.floor(Date.now() / 1000);
    let rows = 0;
    let before = 0;
    let after = 0;
    for (const row of next.usage) {
      if (row.provider !== repair.provider || row.model !== repair.model) continue;
      if (!row.parts || !row.cached) continue;
      const corrected = (row.cached * repair.cachedPerMillion) / 1_000_000;
      /* Only ever downwards: a row that was already right -- priced after the
         reader was fixed, or from a table that carried the cache rate -- is
         left exactly as it stands. */
      if (!(corrected < row.parts.cached)) continue;
      before += row.parts.cached;
      row.parts.cached = corrected;
      row.cost = row.parts.fresh + corrected + row.parts.output;
      after += corrected;
      rows += 1;
    }
    if (rows) {
      console.log(
        `[state] repriced ${rows} ${repair.provider}/${repair.model} turns: cached input $${before.toFixed(2)} -> $${after.toFixed(2)}`,
      );
    }
  }
  return next;
}

function read(): PersistedState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const state = blank();
    if (typeof raw.provider === "string") state.provider = raw.provider;
    if (raw.models && typeof raw.models === "object") state.models = { ...raw.models };
    if (raw.fastModels && typeof raw.fastModels === "object") state.fastModels = { ...raw.fastModels };
    if (raw.baseUrls && typeof raw.baseUrls === "object") state.baseUrls = { ...raw.baseUrls };
    if (typeof raw.systemPrompt === "string") state.systemPrompt = raw.systemPrompt;
    if (raw.keys && typeof raw.keys === "object") state.keys = { ...raw.keys };
    if (raw.secrets && typeof raw.secrets === "object") state.secrets = { ...raw.secrets };
    if (typeof raw.budgetUsd === "number") state.budgetUsd = raw.budgetUsd;
    /* These three used to be single numbers and were only ever DeepSeek's:
       the balance was read from DeepSeek's endpoint whichever provider was
       selected. Anything already on disk is therefore DeepSeek's money, and
       is filed under that name rather than being applied to everyone. */
    if (raw.balances && typeof raw.balances === "object") state.balances = { ...raw.balances };
    if (raw.balanceAts && typeof raw.balanceAts === "object") state.balanceAts = { ...raw.balanceAts };
    if (raw.topUps && typeof raw.topUps === "object") state.topUps = { ...raw.topUps };
    if (raw.pendingReadings && typeof raw.pendingReadings === "object") state.pendingReadings = { ...raw.pendingReadings };
    if (raw.autoTopUps && typeof raw.autoTopUps === "object") state.autoTopUps = { ...raw.autoTopUps };
    if (raw.monthBases && typeof raw.monthBases === "object") state.monthBases = { ...raw.monthBases };
    if (typeof raw.balanceUsd === "number") state.balances.deepseek = raw.balanceUsd;
    if (typeof raw.balanceAt === "number") state.balanceAts.deepseek = raw.balanceAt;
    if (typeof raw.topUpUsd === "number") state.topUps.deepseek = raw.topUpUsd;
    if (typeof raw.learning === "boolean") state.learning = raw.learning;
    if (typeof raw.agentCursor === "boolean") state.agentCursor = raw.agentCursor;
    if (typeof raw.collabRemarks === "boolean") state.collabRemarks = raw.collabRemarks;
    if (typeof raw.groundFirst === "boolean") state.groundFirst = raw.groundFirst;
    if (typeof raw.timezone === "string" && validTimezone(raw.timezone)) {
      state.timezone = raw.timezone.trim();
      applyTimezone(state.timezone);
    }
    if (raw.toolFeed && typeof raw.toolFeed.month === "string" && raw.toolFeed.tools) {
      state.toolFeed = { month: raw.toolFeed.month, tools: { ...raw.toolFeed.tools } };
    }
    if (Array.isArray(raw.usage)) state.usage = raw.usage.filter(sane);
    if (raw.repairs && typeof raw.repairs === "object") state.repairs = { ...raw.repairs };
    /* Field by field, so a settings file written by an older build -- which
       has no `tools` key at all -- comes up with the defaults rather than with
       an undefined the tool layer would then dereference. Same reason each
       group is merged rather than replaced: a group added in a later release
       must not be missing from a file saved before it existed. */
    if (raw.tools) mergeTools(state.tools, raw.tools);
    if (Array.isArray(raw.mcpServers)) {
      state.mcpServers = raw.mcpServers.map(saneMcp).filter(Boolean) as McpServerConfig[];
    }
    if (raw.appearance) mergeAppearance(state.appearance, raw.appearance);
    if (raw.speech) mergeSpeech(state.speech, raw.speech);
    if (raw.captcha) mergeCaptcha(state.captcha, raw.captcha);
    if (raw.proactivity) mergeProactivity(state.proactivity, raw.proactivity);
    if (raw.loop) mergeLoop(state.loop, raw.loop);
    if (raw.verify) mergeVerify(state.verify, raw.verify);
    if (raw.retention) mergeRetention(state.retention, raw.retention);
    if (raw.automation) mergeAutomation(state.automation, raw.automation);
    if (raw.push) mergePush(state.push, raw.push);
    if (raw.carried && typeof raw.carried === "object") {
      carried = {
        cost: Number(raw.carried.cost) || 0,
        input: Number(raw.carried.input) || 0,
        output: Number(raw.carried.output) || 0,
        turns: Number(raw.carried.turns) || 0,
        days: {},
      };
      /* A file written before the days were kept has the lump sums only;
         those still count towards the lifetime figure, and there is no
         honest way to date them, so they are not guessed into a day. */
      if (raw.carried.days && typeof raw.carried.days === "object") {
        for (const [day, row] of Object.entries(raw.carried.days as Record<string, any>)) {
          if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !row || typeof row !== "object") continue;
          carried.days[day] = {
            cost: Number(row.cost) || 0,
            input: Number(row.input) || 0,
            output: Number(row.output) || 0,
            turns: Number(row.turns) || 0,
          };
        }
      }
    }
    return applyRepairs(state);
  } catch (err: any) {
    // No file yet, or one edited into nonsense by hand. Either way the app
    // should come up: defaults now, and the first save writes a clean file.
    // A file that exists but cannot be read is set aside first, though: the
    // first save would otherwise replace it, and every key saved in it with it.
    if (err?.code !== "ENOENT") {
      try {
        const aside = `${STATE_FILE}.unreadable-${Date.now()}`;
        fs.copyFileSync(STATE_FILE, aside);
        fs.chmodSync(aside, 0o600);
        console.warn(`[state] ${STATE_FILE} could not be read (${err?.message ?? err}); kept a copy at ${aside}`);
      } catch {
        // Nothing there to keep.
      }
    }
    return blank();
  }
}

function sane(entry: any): entry is UsageEntry {
  return (
    entry &&
    typeof entry.ts === "number" &&
    typeof entry.provider === "string" &&
    typeof entry.model === "string" &&
    typeof entry.cost === "number"
  );
}

export const state: PersistedState = read();

let pending: NodeJS.Timeout | null = null;

/** Write soon, not now. A streamed turn can touch this a few times in a
    second, and none of those moments is worth a synchronous disk write. */
export function save() {
  if (pending) return;
  pending = setTimeout(() => {
    pending = null;
    saveNow();
  }, 400);
  // Nothing here should hold the process open at shutdown.
  pending.unref?.();
}

/** Write now if a save is waiting. Called on the way out, where the timer
    above would never fire: a key pasted a moment before a restart, or the
    last turn's spend, was otherwise lost with the process. */
export function flushState() {
  if (!pending) return;
  clearTimeout(pending);
  pending = null;
  saveNow();
}

function saveNow() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ ...state, carried }, null, 2);
    /* Written aside and renamed into place: a process that dies mid-write
       must leave the old file, not half of one, which read() would take for
       nonsense and replace with defaults -- every saved key gone. */
    const tmp = `${STATE_FILE}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, body, { mode: 0o600 });
    fs.renameSync(tmp, STATE_FILE);
  } catch (err: any) {
    console.warn(`[state] could not save settings: ${err?.message ?? err}`);
  }
}

/** Whether this is a zone the runtime knows. Node quietly reads an unknown
    name as UTC, so it has to be asked, not tried. */
export function validTimezone(tz: unknown): boolean {
  const name = typeof tz === "string" ? tz.trim() : "";
  if (!name) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

/** What the machine was on before anybody chose: the environment's TZ, or
    what the runtime resolved at start. Kept so choosing "the machine's" again
    can put it back. */
const MACHINE_TIMEZONE = process.env.TZ?.trim() || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";

export function machineTimezone(): string {
  return MACHINE_TIMEZONE;
}

/**
 * Make the person's zone the clock the process reads. Node re-reads TZ on
 * assignment, so every local-time call from here on -- a cron field, a quiet
 * hour, a log line -- is on their clock. Empty puts the machine's back.
 */
export function applyTimezone(tz: string): void {
  process.env.TZ = validTimezone(tz) ? tz.trim() : MACHINE_TIMEZONE;
}

export function stateFilePath(): string {
  return STATE_FILE;
}

/** The directory the settings file lives in, which Umbrel keeps across an
    update -- the place for anything else that must outlive the image. */
export function stateDir(): string {
  return STATE_DIR;
}

// ------------------------------------------------------------------ keys --

/** The key to use for a provider: the one saved in the app, else the first of
    its environment variables that is set. */
export function keyFor(providerId: string): string {
  const saved = (state.keys[providerId] || "").trim();
  if (saved) return saved;
  const spec = providerSpec(providerId);
  for (const name of spec?.envKeys ?? []) {
    const value = (process.env[name] || "").trim();
    if (value) return value;
  }
  return "";
}

/** Where a provider's key came from, for the badge in settings. Being told
    "connected" while the app is using a key you thought you replaced is the
    confusion this exists to prevent. */
export function keySource(providerId: string): "app" | "env" | null {
  if ((state.keys[providerId] || "").trim()) return "app";
  const spec = providerSpec(providerId);
  for (const name of spec?.envKeys ?? []) {
    if ((process.env[name] || "").trim()) return "env";
  }
  return null;
}

/** Enough of a key to recognise it, never enough to use it. */
export function maskKey(key: string): string {
  const trimmed = key.trim();
  if (!trimmed) return "";
  if (trimmed.length <= 8) return "•".repeat(trimmed.length);
  return `${trimmed.slice(0, 3)}…${trimmed.slice(-4)}`;
}

/** Save, replace, or (on an empty string) remove a stored key. */
export function setKey(name: string, value: string) {
  const trimmed = value.trim();
  if (trimmed) state.keys[name] = trimmed;
  else delete state.keys[name];
  save();
}

// ---------------------------------------------------------------- secrets --

/** Retrieve a secret: checks workspace stored secrets first, then process.env. */
export function secretFor(name: string): string {
  const saved = (state.secrets?.[name] || "").trim();
  if (saved) return saved;
  const envVal = (process.env[name] || "").trim();
  if (envVal) return envVal;
  return "";
}

/** Save or update a workspace secret. */
export function setSecret(name: string, value: string) {
  if (!state.secrets) state.secrets = {};
  const trimmed = value.trim();
  if (trimmed) state.secrets[name] = trimmed;
  else delete state.secrets[name];
  save();
}

/** Remove a workspace secret. */
export function deleteSecret(name: string) {
  if (state.secrets) {
    delete state.secrets[name];
    save();
  }
}

/** Get raw secret value if stored in workspace. */
export function getSecret(name: string): string | null {
  if (state.secrets?.[name]) return state.secrets[name];
  if (process.env[name]) return process.env[name]!;
  return null;
}

/** Return all available secrets (from environment and workspace store). */
export function allSecrets(): Record<string, string> {
  const result: Record<string, string> = {};
  for (const k of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "BRAVE_SEARCH_API_KEY",
    "TAVILY_API_KEY",
    "SERPER_API_KEY",
    "GEMINI_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
    "AWS_ACCESS_KEY_ID",
    "AWS_SECRET_ACCESS_KEY",
    "SLACK_BOT_TOKEN",
  ]) {
    if (process.env[k]?.trim()) result[k] = process.env[k]!.trim();
  }
  if (state.secrets) {
    for (const [k, v] of Object.entries(state.secrets)) {
      if (v?.trim()) result[k] = v.trim();
    }
  }
  return result;
}

/** Known presets for UI suggestions */
export const SECRET_PRESETS: Record<string, { label: string; description: string; placeholder: string }> = {
  GITHUB_TOKEN: {
    label: "GitHub Token",
    description: "Personal access token for GitHub CLI, API requests, and private repo operations.",
    placeholder: "ghp_...",
  },
  TAVILY_API_KEY: {
    label: "Tavily Search Key",
    description: "Search API key for high-speed web browsing and automated research.",
    placeholder: "tvly-...",
  },
  BRAVE_SEARCH_API_KEY: {
    label: "Brave Search Key",
    description: "Search API key for independent web indexing and SERP queries.",
    placeholder: "BSA...",
  },
  OPENAI_API_KEY: {
    label: "OpenAI API Key",
    description: "API key for OpenAI models, embeddings, and completions.",
    placeholder: "sk-...",
  },
  ANTHROPIC_API_KEY: {
    label: "Anthropic API Key",
    description: "API key for Claude models.",
    placeholder: "sk-ant-...",
  },
  DEEPGRAM_API_KEY: {
    label: "Deepgram API Key",
    description: "Reads replies aloud through Deepgram's hosted Aura voices, the same ones on every device.",
    placeholder: "a Deepgram API key",
  },
  SLACK_BOT_TOKEN: {
    label: "Slack Bot Token",
    description: "Bot user OAuth token for Slack notifications and integrations.",
    placeholder: "xoxb-...",
  },
  AWS_ACCESS_KEY_ID: {
    label: "AWS Access Key ID",
    description: "Access key ID for AWS CLI and SDK calls.",
    placeholder: "AKIA...",
  },
  AWS_SECRET_ACCESS_KEY: {
    label: "AWS Secret Access Key",
    description: "Secret access key for AWS CLI and SDK calls.",
    placeholder: "wJalrXUtnFEMI/...",
  },
};

/** List configured secrets with masked values for UI display. */
export function listSecrets(): {
  name: string;
  source: "app" | "env";
  masked: string;
  length: number;
  preset?: { label: string; description: string };
}[] {
  const map = new Map<string, {
    name: string;
    source: "app" | "env";
    masked: string;
    length: number;
    preset?: { label: string; description: string };
  }>();

  for (const k of [
    "GITHUB_TOKEN",
    "GH_TOKEN",
    "BRAVE_SEARCH_API_KEY",
    "TAVILY_API_KEY",
    "SERPER_API_KEY",
    "OPENAI_API_KEY",
    "ANTHROPIC_API_KEY",
  ]) {
    const val = process.env[k]?.trim();
    if (val) {
      map.set(k, {
        name: k,
        source: "env",
        masked: maskKey(val),
        length: val.length,
        preset: SECRET_PRESETS[k] ? { label: SECRET_PRESETS[k].label, description: SECRET_PRESETS[k].description } : undefined,
      });
    }
  }

  if (state.secrets) {
    for (const [k, v] of Object.entries(state.secrets)) {
      const val = v?.trim();
      if (val) {
        map.set(k, {
          name: k,
          source: "app",
          masked: maskKey(val),
          length: val.length,
          preset: SECRET_PRESETS[k] ? { label: SECRET_PRESETS[k].label, description: SECRET_PRESETS[k].description } : undefined,
        });
      }
    }
  }

  return Array.from(map.values()).sort((a, b) => a.name.localeCompare(b.name));
}

/** Keys read from the environment by other parts of the app (voice)
    that are not a provider's and not in the secret store's own list. */
const OTHER_ENV_KEYS = [
  "DEEPGRAM_API_KEY", "ASSEMBLYAI_API_KEY",
];

/**
 * Every value that must never be shown, with what to show instead.
 *
 * Not only the secret store: a provider key set in the environment used to
 * be scrubbed only for three vendors, so `env` in the terminal printed a
 * DeepSeek, OpenRouter or local-server key straight into the thread, the log
 * on disk and the next prompt. Every provider's variables are here now.
 */
function secretTable(): { value: string; label: string }[] {
  const table = new Map<string, string>();
  const add = (value: string | undefined, label: string) => {
    const v = (value ?? "").trim();
    if (v.length >= 4 && !table.has(v)) table.set(v, label);
  };
  for (const [name, val] of Object.entries(allSecrets())) add(val, `[REDACTED_${name}]`);
  for (const [prov, key] of Object.entries(state.keys ?? {})) add(key, `[REDACTED_${prov.toUpperCase()}_KEY]`);
  for (const spec of PROVIDERS) for (const name of spec.envKeys) add(process.env[name], `[REDACTED_${name}]`);
  for (const name of OTHER_ENV_KEYS) add(process.env[name], `[REDACTED_${name}]`);
  return [...table].map(([value, label]) => ({ value, label }));
}

/** The table as one pattern, rebuilt only when a secret changes: this runs
    on every streamed chunk of every event, and splitting the text once per
    secret per chunk was most of what it cost. */
let redactor: { signature: string; pattern: RegExp | null; labels: Map<string, string> } | null = null;

function currentRedactor() {
  const table = secretTable();
  const signature = table.map((t) => `${t.label}\u0000${t.value}`).join("\u0001");
  if (redactor?.signature === signature) return redactor;
  // Longest first, so a secret that contains another is blanked whole.
  const values = table.map((t) => t.value).sort((a, b) => b.length - a.length);
  const escape = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  redactor = {
    signature,
    pattern: values.length ? new RegExp(values.map(escape).join("|"), "g") : null,
    labels: new Map(table.map((t) => [t.value, t.label])),
  };
  return redactor;
}

/**
 * Scrub all sensitive secret and API key values from any text before
 * sending it to the model transcript, event logs, or UI streams.
 */
export function redactSecrets(text: string): string {
  if (!text || typeof text !== "string") return text;
  const { pattern, labels } = currentRedactor();
  if (!pattern) return text;
  return text.replace(pattern, (found) => labels.get(found) ?? "[REDACTED]");
}

// ------------------------------------------------------------- selection --

export function modelFor(providerId: string): string {
  const chosen = (state.models[providerId] || "").trim();
  return chosen || providerSpec(providerId)?.defaultModel || "";
}

/** The model a spoken turn is answered by, when one is named for the
    provider. Empty means talk mode uses the main model. */
export function fastModelFor(providerId: string): string {
  return (state.fastModels[providerId] || "").trim();
}

export function baseUrlFor(providerId: string): string {
  const override = (state.baseUrls[providerId] || "").trim();
  if (override) return override;
  // The README has long offered AUTORA_LLM_BASE_URL for a local server; it
  // is the fallback for that provider, below an address saved in Settings.
  const fromEnv = providerId === "local" ? (process.env.AUTORA_LLM_BASE_URL || "").trim() : "";
  return fromEnv || providerSpec(providerId)?.baseUrl || "";
}

export interface Resolved {
  provider: string;
  model: string;
  /** Talk mode's own model: the fast one, when the vendor has one named.
      Empty when live voice should answer with `model` like everything else. */
  fastModel: string;
  key: string;
  baseUrl: string;
  /** Why nothing is usable, when nothing is. */
  problem: string | null;
}

/**
 * Which provider the next turn will actually call.
 *
 * "Automatic" means the first provider in AUTO_ORDER that has a key -- with a
 * local server counting as configured without one, since that is the whole
 * point of running your own. A named provider is used even when its key is
 * missing, and says so, because silently answering from a different vendor
 * than the one selected is how a bill arrives from somewhere unexpected.
 */
export function resolveProvider(): Resolved {
  const wanted = state.provider || "auto";

  // A local server needs no key, but on Automatic it only counts once a model
  // has been named for it: otherwise a fresh install "chose" Local server and
  // reported "No model chosen for Local server" -- a provider nobody picked.
  const usable = (id: string) => Boolean(keyFor(id)) || (id === "local" && Boolean(modelFor(id)));

  let chosen = wanted;
  if (wanted === "auto") {
    chosen = AUTO_ORDER.find(usable) ?? "";
    if (!chosen) {
      return {
        provider: "",
        model: "",
        fastModel: "",
        key: "",
        baseUrl: "",
        problem: "No provider is connected yet. Add an API key for one.",
      };
    }
  }

  const spec = providerSpec(chosen);
  if (!spec) {
    return {
      provider: chosen,
      model: "",
      fastModel: "",
      key: "",
      baseUrl: "",
      problem: `Unknown provider "${chosen}".`,
    };
  }

  const key = keyFor(chosen);
  const model = modelFor(chosen);
  let problem: string | null = null;
  if (!key && chosen !== "local") problem = `${spec.label} has no API key set.`;
  else if (!model) problem = `No model chosen for ${spec.label}.`;

  return {
    provider: chosen,
    model,
    fastModel: fastModelFor(chosen),
    key,
    baseUrl: baseUrlFor(chosen),
    problem,
  };
}

// ------------------------------------------------------------------ spend --

export function recordUsage(entry: UsageEntry) {
  /* An incognito chat is filed under a word that names no chat. The ledger is
     written for every call the app pays for, so leaving the id in it would be
     the one trace such a chat left on disk -- and leaving the call out
     altogether would make the spend wrong. Nothing else about the chat is in
     the row: no text, no title, only what was spent. */
  state.usage.push(isEphemeral(entry.session) ? { ...entry, session: "incognito" } : entry);
  while (state.usage.length > MAX_USAGE) {
    const dropped = state.usage.shift()!;
    carried.cost += dropped.cost;
    carried.input += dropped.input;
    carried.output += dropped.output;
    carried.turns += 1;
    /* Dated as well, so the month and today figures can still count it. */
    const day = carriedDayKey(dropped.ts);
    const row = carried.days[day] ?? { cost: 0, input: 0, output: 0, turns: 0 };
    row.cost += dropped.cost;
    row.input += dropped.input;
    row.output += dropped.output;
    row.turns += 1;
    carried.days[day] = row;
    const keys = Object.keys(carried.days).sort();
    while (keys.length > CARRIED_DAYS_KEPT) {
      const oldest = keys.shift()!;
      delete carried.days[oldest];
    }
  }
  save();
}

/** Count what one tool's output cost in prompt tokens, as the model reads it. */
export function recordToolFeed(tool: string, tokens: number, month: string) {
  if (state.toolFeed.month !== month) state.toolFeed = { month, tools: {} };
  const row = state.toolFeed.tools[tool] ?? { calls: 0, tokens: 0 };
  row.calls += 1;
  row.tokens += tokens;
  state.toolFeed.tools[tool] = row;
  save();
}

export function carriedTotals() {
  return { cost: carried.cost, input: carried.input, output: carried.output, turns: carried.turns };
}

/** The dated part of it, which the month, today and the chart can use. */
export function carriedDays(): Record<string, CarriedDay> {
  return carried.days;
}

export function clearUsage() {
  state.usage = [];
  carried = { cost: 0, input: 0, output: 0, turns: 0, days: {} };
  saveNow();
}
