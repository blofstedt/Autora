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
import { AUTO_ORDER, PROVIDERS, providerSpec } from "./providers";

export type ApprovalMode = "always" | "risky" | "never";

export interface ToolSettings {
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
}

export interface PersistedState {
  provider: string;
  /** Chosen model per provider, so switching vendors and back does not lose
      the choice you made the first time. */
  models: Record<string, string>;
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
  usage: UsageEntry[];
  /** Which of the agent's groups of tools are on, and how tightly each is
      gated. See ./tools for what each group actually is. */
  tools: ToolSettings;
}

const DEFAULT_PROMPT =
  "You are Autora, an autonomous AI execution console and agent workspace.";

/**
 * What the tools do before anybody visits Settings.
 *
 * Capable, and gated. Every group is on, so the agent that ships is the agent
 * described -- but the terminal asks before every single command, and the ones
 * that touch a page or a desktop ask before anything that changes rather than
 * reads. A shell on the host is only a reasonable default under a prompt that
 * shows you the exact command first, which is the promise this console was
 * built on.
 *
 * Turning a group off is a real answer too: it removes the tools from the
 * model's schema entirely and the agent is told, in words, that the group is
 * off rather than left to guess why it cannot do something.
 */
function defaultTools(): ToolSettings {
  return {
    terminal: { enabled: true, cwd: "", timeout: 120, approval: "always", shell: "" },
    browser: { enabled: true, approval: "risky" },
    computer: { enabled: true, approval: "risky" },
    /* Unattended: writing a note down is not destructive, and an approval
       prompt for every remembered fact is how people learn to click yes
       without reading -- which is the prompt that matters going unread. */
    memory: { enabled: true, approval: "never" },
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
  const modes = new Set(["always", "risky", "never"]);
  const bool = (value: any, fallback: boolean) =>
    typeof value === "boolean" ? value : fallback;
  const mode = (value: any, fallback: ToolSettings["browser"]["approval"]) =>
    modes.has(value) ? value : fallback;

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
  for (const group of ["browser", "computer", "memory"] as const) {
    const given = patch[group];
    if (!given || typeof given !== "object") continue;
    into[group].enabled = bool(given.enabled, into[group].enabled);
    into[group].approval = mode(given.approval, into[group].approval);
  }
  return into;
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

/** Spend that has aged out of the ledger, kept so lifetime totals survive it. */
let carried = { cost: 0, input: 0, output: 0, turns: 0 };

function blank(): PersistedState {
  return {
    provider: "auto",
    models: {},
    baseUrls: {},
    systemPrompt: DEFAULT_PROMPT,
    keys: {},
    secrets: {},
    budgetUsd: null,
    usage: [],
    tools: defaultTools(),
  };
}

function read(): PersistedState {
  try {
    const raw = JSON.parse(fs.readFileSync(STATE_FILE, "utf8"));
    const state = blank();
    if (typeof raw.provider === "string") state.provider = raw.provider;
    if (raw.models && typeof raw.models === "object") state.models = { ...raw.models };
    if (raw.baseUrls && typeof raw.baseUrls === "object") state.baseUrls = { ...raw.baseUrls };
    if (typeof raw.systemPrompt === "string") state.systemPrompt = raw.systemPrompt;
    if (raw.keys && typeof raw.keys === "object") state.keys = { ...raw.keys };
    if (raw.secrets && typeof raw.secrets === "object") state.secrets = { ...raw.secrets };
    if (typeof raw.budgetUsd === "number") state.budgetUsd = raw.budgetUsd;
    if (Array.isArray(raw.usage)) state.usage = raw.usage.filter(sane);
    /* Field by field, so a settings file written by an older build -- which
       has no `tools` key at all -- comes up with the defaults rather than with
       an undefined the tool layer would then dereference. Same reason each
       group is merged rather than replaced: a group added in a later release
       must not be missing from a file saved before it existed. */
    if (raw.tools) mergeTools(state.tools, raw.tools);
    if (raw.carried && typeof raw.carried === "object") {
      carried = {
        cost: Number(raw.carried.cost) || 0,
        input: Number(raw.carried.input) || 0,
        output: Number(raw.carried.output) || 0,
        turns: Number(raw.carried.turns) || 0,
      };
    }
    return state;
  } catch {
    // No file yet, or one edited into nonsense by hand. Either way the app
    // should come up: defaults now, and the first save writes a clean file.
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

export function saveNow() {
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true, mode: 0o700 });
    const body = JSON.stringify({ ...state, carried }, null, 2);
    fs.writeFileSync(STATE_FILE, body, { mode: 0o600 });
  } catch (err: any) {
    console.warn(`[state] could not save settings: ${err?.message ?? err}`);
  }
}

export function stateFilePath(): string {
  return STATE_FILE;
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

/**
 * Scrub all sensitive secret and API key values from any text before
 * sending it to the model transcript, event logs, or UI streams.
 */
export function redactSecrets(text: string): string {
  if (!text || typeof text !== "string") return text;
  let sanitized = text;

  // 1. Scrub workspace and env secrets
  const secrets = allSecrets();
  for (const [name, val] of Object.entries(secrets)) {
    if (val && val.length >= 4) {
      sanitized = sanitized.split(val).join(`[REDACTED_${name}]`);
    }
  }

  // 2. Scrub provider API keys
  if (state.keys) {
    for (const [prov, key] of Object.entries(state.keys)) {
      if (key && key.length >= 4) {
        sanitized = sanitized.split(key).join(`[REDACTED_${prov.toUpperCase()}_KEY]`);
      }
    }
  }

  return sanitized;
}

// ------------------------------------------------------------- selection --

export function modelFor(providerId: string): string {
  const chosen = (state.models[providerId] || "").trim();
  return chosen || providerSpec(providerId)?.defaultModel || "";
}

export function baseUrlFor(providerId: string): string {
  const override = (state.baseUrls[providerId] || "").trim();
  return override || providerSpec(providerId)?.baseUrl || "";
}

export interface Resolved {
  provider: string;
  model: string;
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

  const usable = (id: string) => Boolean(keyFor(id)) || id === "local";

  let chosen = wanted;
  if (wanted === "auto") {
    chosen = AUTO_ORDER.find(usable) ?? "";
    if (!chosen) {
      return {
        provider: "",
        model: "",
        key: "",
        baseUrl: "",
        problem: "No provider is connected. Add an API key in Settings.",
      };
    }
  }

  const spec = providerSpec(chosen);
  if (!spec) {
    return {
      provider: chosen,
      model: "",
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

  return { provider: chosen, model, key, baseUrl: baseUrlFor(chosen), problem };
}

// ------------------------------------------------------------------ spend --

export function recordUsage(entry: UsageEntry) {
  state.usage.push(entry);
  while (state.usage.length > MAX_USAGE) {
    const dropped = state.usage.shift()!;
    carried.cost += dropped.cost;
    carried.input += dropped.input;
    carried.output += dropped.output;
    carried.turns += 1;
  }
  save();
}

export function carriedTotals() {
  return { ...carried };
}

export function clearUsage() {
  state.usage = [];
  carried = { cost: 0, input: 0, output: 0, turns: 0 };
  saveNow();
}

/** Every provider, for the settings panel to lay out. */
export function knownProviders() {
  return PROVIDERS;
}
