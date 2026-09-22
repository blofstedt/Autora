/**
 * Which model vendors Autora can talk to, and what they charge.
 *
 * One table, read by everything: the settings panel offers these models, the
 * chat client knows from `kind` which wire protocol to speak, and the billing
 * page prices a finished turn from the same numbers the panel quoted before it
 * ran. Keeping them apart is how a console ends up quoting one price and
 * billing another.
 *
 * Prices are the vendors' published list prices in US dollars per million
 * tokens, noted below with the date they were read. They move, and a cached
 * price silently going stale is worse than an honest "checked in March", so the
 * date travels with them to the UI. OpenRouter is the exception: it publishes
 * per-token prices over its API, so its catalogue can be refreshed live.
 */

/** The wire protocol a vendor speaks. Three shapes cover every provider here:
    most of the field has settled on OpenAI's chat-completions schema. */
export type ProviderKind = "gemini" | "openai" | "anthropic";

export interface ModelSpec {
  id: string;
  label: string;
  /** USD per million input tokens. */
  input: number;
  /** USD per million output tokens. */
  output: number;
  /** One short line: what this model is for, shown beside it in the picker. */
  note?: string;
  /** False for a model we found by asking the vendor for its catalogue but
      whose price it did not publish. Such a model can still be selected and
      used; its turns are counted and marked unpriced rather than billed at a
      figure nobody checked. */
  priced?: boolean;
}

export interface ProviderSpec {
  id: string;
  label: string;
  kind: ProviderKind;
  /** What this vendor is, in a sentence, for someone deciding whether to add it. */
  note: string;
  /** Environment variables consulted when no key has been saved in the app. */
  envKeys: string[];
  /** What a key looks like, so a wrong paste is obvious before it is saved. */
  keyHint: string;
  /** Where to get one. */
  keysUrl: string;
  /** API root. Editable per install for local servers and proxies. */
  baseUrl: string;
  defaultModel: string;
  models: ModelSpec[];
  /** True where the vendor publishes a model list we can fetch and merge. */
  listable: boolean;
  /** Free-form models: the picker offers typing an id rather than choosing. */
  openEnded?: boolean;
}

/** When the prices below were last read off the vendors' pricing pages. */
export const PRICES_CHECKED = "2026-05";

export const PROVIDERS: ProviderSpec[] = [
  {
    id: "openai",
    label: "OpenAI",
    kind: "openai",
    note: "GPT models, via the OpenAI API.",
    envKeys: ["OPENAI_API_KEY"],
    keyHint: "sk-...",
    keysUrl: "https://platform.openai.com/api-keys",
    baseUrl: "https://api.openai.com/v1",
    defaultModel: "gpt-4o-mini",
    listable: true,
    models: [
      { id: "gpt-5", label: "GPT-5", input: 1.25, output: 10, note: "Flagship reasoning" },
      { id: "gpt-5-mini", label: "GPT-5 mini", input: 0.25, output: 2, note: "Cheaper GPT-5" },
      { id: "gpt-5-nano", label: "GPT-5 nano", input: 0.05, output: 0.4, note: "Fastest, cheapest" },
      { id: "gpt-4.1", label: "GPT-4.1", input: 2, output: 8, note: "Long context, general" },
      { id: "gpt-4.1-mini", label: "GPT-4.1 mini", input: 0.4, output: 1.6 },
      { id: "gpt-4.1-nano", label: "GPT-4.1 nano", input: 0.1, output: 0.4 },
      { id: "gpt-4o", label: "GPT-4o", input: 2.5, output: 10 },
      { id: "gpt-4o-mini", label: "GPT-4o mini", input: 0.15, output: 0.6, note: "Good default for a console" },
      { id: "o3", label: "o3", input: 2, output: 8, note: "Deliberate reasoning" },
      { id: "o4-mini", label: "o4-mini", input: 1.1, output: 4.4 },
    ],
  },
  {
    id: "gemini",
    label: "Google Gemini",
    kind: "gemini",
    note: "Google AI Studio. The free tier covers Flash.",
    envKeys: ["GEMINI_API_KEY", "GOOGLE_API_KEY"],
    keyHint: "AIza...",
    keysUrl: "https://aistudio.google.com/apikey",
    baseUrl: "https://generativelanguage.googleapis.com",
    defaultModel: "gemini-flash-latest",
    listable: true,
    models: [
      {
        id: "gemini-flash-latest",
        label: "Gemini Flash (latest)",
        input: 0.3,
        output: 2.5,
        note: "Rolling alias — follows Google's current Flash",
      },
      { id: "gemini-2.5-pro", label: "Gemini 2.5 Pro", input: 1.25, output: 10, note: "Hardest questions" },
      { id: "gemini-2.5-flash", label: "Gemini 2.5 Flash", input: 0.3, output: 2.5 },
      { id: "gemini-2.5-flash-lite", label: "Gemini 2.5 Flash Lite", input: 0.1, output: 0.4 },
      { id: "gemini-2.0-flash", label: "Gemini 2.0 Flash", input: 0.1, output: 0.4 },
      { id: "gemini-2.0-flash-lite", label: "Gemini 2.0 Flash Lite", input: 0.075, output: 0.3 },
    ],
  },
  {
    id: "anthropic",
    label: "Anthropic Claude",
    kind: "anthropic",
    note: "Claude models, via the Anthropic Messages API.",
    envKeys: ["ANTHROPIC_API_KEY"],
    keyHint: "sk-ant-...",
    keysUrl: "https://console.anthropic.com/settings/keys",
    baseUrl: "https://api.anthropic.com",
    defaultModel: "claude-haiku-4-5",
    listable: true,
    models: [
      { id: "claude-sonnet-4-5", label: "Claude Sonnet 4.5", input: 3, output: 15, note: "Balanced" },
      { id: "claude-haiku-4-5", label: "Claude Haiku 4.5", input: 1, output: 5, note: "Fast and cheap" },
      { id: "claude-opus-4-1", label: "Claude Opus 4.1", input: 15, output: 75, note: "Most capable, priciest" },
    ],
  },
  {
    id: "deepseek",
    label: "DeepSeek",
    kind: "openai",
    note: "Very cheap, OpenAI-compatible.",
    envKeys: ["DEEPSEEK_API_KEY"],
    keyHint: "sk-...",
    keysUrl: "https://platform.deepseek.com/api_keys",
    baseUrl: "https://api.deepseek.com/v1",
    defaultModel: "deepseek-chat",
    listable: true,
    models: [
      { id: "deepseek-chat", label: "DeepSeek Chat", input: 0.27, output: 1.1, note: "General purpose" },
      { id: "deepseek-reasoner", label: "DeepSeek Reasoner", input: 0.55, output: 2.19, note: "Thinks before answering" },
    ],
  },
  {
    id: "openrouter",
    label: "OpenRouter",
    kind: "openai",
    note: "One key, hundreds of models from every vendor. Prices come from OpenRouter itself.",
    envKeys: ["OPENROUTER_API_KEY"],
    keyHint: "sk-or-v1-...",
    keysUrl: "https://openrouter.ai/keys",
    baseUrl: "https://openrouter.ai/api/v1",
    defaultModel: "openai/gpt-4o-mini",
    listable: true,
    models: [
      { id: "openai/gpt-4o-mini", label: "OpenAI GPT-4o mini", input: 0.15, output: 0.6 },
      { id: "openai/gpt-4.1-mini", label: "OpenAI GPT-4.1 mini", input: 0.4, output: 1.6 },
      { id: "anthropic/claude-sonnet-4.5", label: "Anthropic Claude Sonnet 4.5", input: 3, output: 15 },
      { id: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash", input: 0.3, output: 2.5 },
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat", input: 0.27, output: 1.1 },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct", input: 0.12, output: 0.3 },
      { id: "x-ai/grok-4", label: "xAI Grok 4", input: 3, output: 15 },
    ],
  },
  {
    id: "orcarouter",
    label: "Orca Router",
    kind: "openai",
    note: "Adaptive LLM routing across 200+ models with auto-failover, zero token markup, and intelligent complexity matching.",
    envKeys: ["ORCA_ROUTER_API_KEY", "ORCA_API_KEY"],
    keyHint: "orca-... or sk-...",
    keysUrl: "https://orcarouter.ai",
    baseUrl: "https://api.orcarouter.ai/v1",
    defaultModel: "orca-auto",
    listable: true,
    openEnded: true,
    models: [
      { id: "orca-auto", label: "Orca Auto Router", input: 0.15, output: 0.6, note: "Dynamically routes to the best model for cost and performance" },
      { id: "anthropic/claude-sonnet-4.5", label: "Anthropic Claude Sonnet 4.5", input: 3, output: 15 },
      { id: "anthropic/claude-haiku-4.5", label: "Anthropic Claude Haiku 4.5", input: 1, output: 5 },
      { id: "openai/gpt-5-mini", label: "OpenAI GPT-5 mini", input: 0.25, output: 2 },
      { id: "openai/gpt-4o", label: "OpenAI GPT-4o", input: 2.5, output: 10 },
      { id: "deepseek/deepseek-chat", label: "DeepSeek Chat", input: 0.27, output: 1.1 },
      { id: "google/gemini-2.5-flash", label: "Google Gemini 2.5 Flash", input: 0.3, output: 2.5 },
      { id: "meta-llama/llama-3.3-70b-instruct", label: "Llama 3.3 70B Instruct", input: 0.12, output: 0.3 },
    ],
  },
  {
    id: "local",
    label: "Local server",
    kind: "openai",
    note: "Anything speaking the OpenAI API on your own machine — vLLM, Ollama, llama.cpp. No key, no bill.",
    envKeys: ["LOCAL_API_KEY", "OPENAI_COMPATIBLE_API_KEY"],
    keyHint: "usually not needed",
    keysUrl: "",
    baseUrl: "http://localhost:8000/v1",
    defaultModel: "",
    listable: true,
    openEnded: true,
    models: [],
  },
];

/** Which provider "Automatic" reaches for first. Cheap and likely-configured
    before expensive and exotic; a local server last, because a forgotten
    Ollama on the box should not quietly outrank a key you just pasted. */
export const AUTO_ORDER = ["orcarouter", "openrouter", "openai", "gemini", "anthropic", "deepseek", "local"];

export function providerSpec(id: string): ProviderSpec | undefined {
  return PROVIDERS.find((p) => p.id === id);
}

/**
 * Prices found live, keyed `provider:model`.
 *
 * OpenRouter's catalogue is thousands of models deep and changes weekly, so
 * shipping it in the table above is hopeless. What we fetch lands here and
 * takes precedence, which also means a model the table has never heard of is
 * still billed correctly.
 */
const discovered = new Map<string, ModelSpec>();

export function rememberModels(providerId: string, models: ModelSpec[]) {
  const shipped = providerSpec(providerId)?.models ?? [];
  for (const model of models) {
    // A live listing that carries no price must not shadow a price we ship:
    // OpenAI's /models says which models exist, not what they cost.
    if (model.priced === false && shipped.some((m) => m.id === model.id)) continue;
    discovered.set(`${providerId}:${model.id}`, model);
  }
}

export function discoveredModels(providerId: string): ModelSpec[] {
  const prefix = `${providerId}:`;
  return [...discovered.entries()]
    .filter(([key]) => key.startsWith(prefix))
    .map(([, model]) => model);
}

/** Everything offerable for a provider: the shipped table, plus whatever a
    live refresh has since turned up, newest first and deduplicated. */
export function modelsFor(providerId: string): ModelSpec[] {
  const spec = providerSpec(providerId);
  const base = spec ? spec.models : [];
  const extra = discoveredModels(providerId).filter(
    (m) => !base.some((b) => b.id === m.id),
  );
  return [...base, ...extra];
}

export function modelSpec(providerId: string, modelId: string): ModelSpec | undefined {
  return (
    discovered.get(`${providerId}:${modelId}`) ??
    providerSpec(providerId)?.models.find((m) => m.id === modelId)
  );
}

/**
 * What a turn cost, in dollars.
 *
 * An unknown model prices at zero rather than at a guess. A made-up number
 * would flow into the billing total and be indistinguishable there from a real
 * one; a zero, paired with the "unpriced" count the billing page shows, says
 * plainly that this model is not in the table.
 */
export function costOf(
  providerId: string,
  modelId: string,
  inputTokens: number,
  outputTokens: number,
): number {
  const spec = modelSpec(providerId, modelId);
  if (!spec || spec.priced === false) return 0;
  return (inputTokens * spec.input + outputTokens * spec.output) / 1_000_000;
}

export function isPriced(providerId: string, modelId: string): boolean {
  const spec = modelSpec(providerId, modelId);
  return Boolean(spec) && spec!.priced !== false;
}
