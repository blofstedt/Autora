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
  /** Monthly ceiling in USD, or null for none. Advisory: it warns, it does not
      refuse -- a console that silently stops answering is a support ticket. */
  budgetUsd: number | null;
  usage: UsageEntry[];
}

const DEFAULT_PROMPT =
  "You are Autora, an autonomous AI execution console and agent workspace.";

/** How many turns of spend history to keep. Enough for a month of heavy use;
    the running totals are folded into `carried` as entries fall off the end,
    so the lifetime figure stays right even once detail is dropped. */
const MAX_USAGE = 5000;

const STATE_DIR =
  (process.env.AUTORA_STATE_DIR || "").trim() || path.join(process.cwd(), ".autora");
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
    budgetUsd: null,
    usage: [],
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
    if (typeof raw.budgetUsd === "number") state.budgetUsd = raw.budgetUsd;
    if (Array.isArray(raw.usage)) state.usage = raw.usage.filter(sane);
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
