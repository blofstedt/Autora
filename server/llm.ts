/**
 * One way to ask a model something, whichever vendor is answering.
 *
 * Three wire protocols cover the field: Google's, Anthropic's, and OpenAI's --
 * which DeepSeek, OpenRouter, and every local server also speak. Each is
 * streamed, because a console that sits blank for eight seconds and then
 * prints a paragraph reads as broken, and each reports back how many tokens
 * the turn used, because that is what the billing page is counting.
 *
 * Token counts come from the vendor where the vendor sends them. Where one
 * does not, the turn is measured by the rough four-characters-per-token rule
 * and flagged `estimated`, so the billing page can mark that figure as an
 * approximation rather than quietly mixing it in with measured ones.
 */

import { GoogleGenAI } from "@google/genai";
import { type ModelSpec, providerSpec } from "./providers";

export interface ChatMessage {
  role: "user" | "assistant";
  text: string;
}

export interface ChatCall {
  provider: string;
  model: string;
  key: string;
  baseUrl: string;
  system: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Gemini only: tokens of thinking allowed before the first word. */
  thinkingBudget?: number;
}

export interface ChatUsage {
  input: number;
  output: number;
  /** True when the counts are our arithmetic rather than the vendor's. */
  estimated: boolean;
}

/** An error with the HTTP status kept, so the caller can tell a busy vendor
    (worth retrying) from a wrong key (never worth retrying). */
export class ProviderError extends Error {
  status: number | null;
  constructor(message: string, status: number | null) {
    super(message);
    this.name = "ProviderError";
    this.status = status;
  }
}

const roughTokens = (text: string) => Math.max(1, Math.round(text.length / 4));

function estimate(call: ChatCall, reply: string): ChatUsage {
  const prompt = call.system + call.messages.map((m) => m.text).join("");
  return { input: roughTokens(prompt), output: roughTokens(reply), estimated: true };
}

/** The readable sentence inside a vendor's error body, which is variously a
    plain string, `{error: {message}}`, or `{message}`, sometimes nested. */
function readError(body: string, status: number): ProviderError {
  let text = body.trim();
  for (let depth = 0; depth < 3; depth += 1) {
    const start = text.indexOf("{");
    if (start < 0) break;
    try {
      const parsed = JSON.parse(text.slice(start));
      const inner = parsed?.error ?? parsed;
      const message = typeof inner === "string" ? inner : inner?.message;
      if (typeof message !== "string") break;
      text = message;
    } catch {
      break;
    }
  }
  const clean = text.replace(/\s+/g, " ").trim() || `HTTP ${status}`;
  return new ProviderError(clean, status);
}

async function failure(res: Response): Promise<ProviderError> {
  const body = await res.text().catch(() => "");
  return readError(body, res.status);
}

/**
 * fetch, with a network failure said in words.
 *
 * Node's fetch reports every DNS failure, refused connection, and TLS problem
 * as the two words "fetch failed", which in the thread reads as the app being
 * broken rather than as a server that is not there. The URL is what makes it
 * diagnosable -- nine times in ten the base URL has a typo in it.
 */
async function request(url: string, init?: RequestInit): Promise<Response> {
  try {
    return await fetch(url, init);
  } catch (err: any) {
    const cause = err?.cause?.code ?? err?.cause?.message ?? err?.message ?? "unknown error";
    throw new ProviderError(`could not reach ${url} (${cause})`, null);
  }
}

/** Server-sent events, one `data:` payload at a time. */
async function* sse(res: Response): AsyncGenerator<string> {
  const body = res.body;
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let cut = buffer.indexOf("\n");
    while (cut >= 0) {
      const line = buffer.slice(0, cut).trim();
      buffer = buffer.slice(cut + 1);
      cut = buffer.indexOf("\n");
      if (line.startsWith("data:")) {
        const payload = line.slice(5).trim();
        if (payload && payload !== "[DONE]") yield payload;
      }
    }
  }
}

const trimSlash = (url: string) => url.replace(/\/+$/, "");

// ------------------------------------------------------------- openai-ish --

function openAiHeaders(call: ChatCall): Record<string, string> {
  const headers: Record<string, string> = { "Content-Type": "application/json" };
  if (call.key) headers.Authorization = `Bearer ${call.key}`;
  if (call.provider === "openrouter") {
    // OpenRouter attributes traffic by these and shows the name on its own
    // activity page, which is where people go to check a bill against ours.
    headers["HTTP-Referer"] = "https://github.com/blofstedt/autora";
    headers["X-Title"] = "Autora";
  }
  return headers;
}

async function streamOpenAi(call: ChatCall, onDelta: (text: string) => void): Promise<ChatUsage> {
  const res = await request(`${trimSlash(call.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(call),
    body: JSON.stringify({
      model: call.model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: call.temperature ?? 0.7,
      max_tokens: call.maxTokens ?? 2048,
      messages: [
        ...(call.system ? [{ role: "system", content: call.system }] : []),
        ...call.messages.map((m) => ({
          role: m.role === "assistant" ? "assistant" : "user",
          content: m.text,
        })),
      ],
    }),
  });

  if (!res.ok) throw await failure(res);

  let reply = "";
  let usage: ChatUsage | null = null;

  for await (const payload of sse(res)) {
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    // Some gateways deliver an error mid-stream with a 200 on the envelope.
    if (chunk.error) throw new ProviderError(chunk.error.message ?? "stream failed", null);

    const piece = chunk.choices?.[0]?.delta?.content;
    if (typeof piece === "string" && piece) {
      reply += piece;
      onDelta(piece);
    }
    if (chunk.usage) {
      usage = {
        input: chunk.usage.prompt_tokens ?? 0,
        output: chunk.usage.completion_tokens ?? 0,
        estimated: false,
      };
    }
  }

  return usage ?? estimate(call, reply);
}

// ------------------------------------------------------------- anthropic --

async function streamAnthropic(call: ChatCall, onDelta: (text: string) => void): Promise<ChatUsage> {
  const res = await request(`${trimSlash(call.baseUrl)}/v1/messages`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      "x-api-key": call.key,
      "anthropic-version": "2023-06-01",
    },
    body: JSON.stringify({
      model: call.model,
      stream: true,
      max_tokens: call.maxTokens ?? 2048,
      temperature: call.temperature ?? 0.7,
      system: call.system || undefined,
      messages: call.messages.map((m) => ({
        role: m.role,
        content: [{ type: "text", text: m.text }],
      })),
    }),
  });

  if (!res.ok) throw await failure(res);

  let reply = "";
  const usage: ChatUsage = { input: 0, output: 0, estimated: false };
  let counted = false;

  for await (const payload of sse(res)) {
    let event: any;
    try {
      event = JSON.parse(payload);
    } catch {
      continue;
    }
    if (event.type === "error") {
      throw new ProviderError(event.error?.message ?? "stream failed", null);
    }
    if (event.type === "message_start") {
      usage.input = event.message?.usage?.input_tokens ?? 0;
      counted = true;
    } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const piece = String(event.delta.text ?? "");
      if (piece) {
        reply += piece;
        onDelta(piece);
      }
    } else if (event.type === "message_delta" && event.usage) {
      usage.output = event.usage.output_tokens ?? usage.output;
      counted = true;
    }
  }

  return counted ? usage : estimate(call, reply);
}

// ---------------------------------------------------------------- gemini --

/** Lazy client per key and endpoint: rebuilding it on every turn throws away
    the SDK's connection reuse, and holding one past a change talks to the old
    key -- or, for anyone pointing this at a proxy, the old server. */
let geminiClient: GoogleGenAI | null = null;
let geminiClientFor = "";

function gemini(key: string, baseUrl: string): GoogleGenAI {
  const signature = `${key}@${baseUrl}`;
  if (!geminiClient || geminiClientFor !== signature) {
    geminiClient = new GoogleGenAI({
      apiKey: key,
      httpOptions: baseUrl ? { baseUrl } : undefined,
    });
    geminiClientFor = signature;
  }
  return geminiClient;
}

/**
 * A Gemini SDK error, made readable.
 *
 * The SDK hands back a message that is itself a JSON document with another
 * JSON document quoted inside it, so the useful sentence arrives buried two
 * levels deep behind escaped newlines. Shown raw it is a wall of braces, which
 * tells the reader nothing about whether their key is wrong or Google is busy.
 */
function fromSdk(err: any): ProviderError {
  const status = typeof err?.status === "number" ? err.status : null;
  const parsed = readError(String(err?.message ?? err), status ?? 0);
  return new ProviderError(parsed.message, status ?? parsed.status);
}

async function streamGemini(call: ChatCall, onDelta: (text: string) => void): Promise<ChatUsage> {
  const client = gemini(call.key, call.baseUrl);
  const stream = await client.models.generateContentStream({
    model: call.model,
    contents: call.messages.map((m) => ({
      role: m.role === "assistant" ? "model" : "user",
      parts: [{ text: m.text }],
    })),
    config: {
      systemInstruction: call.system || undefined,
      temperature: call.temperature ?? 0.7,
      maxOutputTokens: call.maxTokens ?? 2048,
      thinkingConfig: { thinkingBudget: call.thinkingBudget ?? 0 },
    },
  });

  let reply = "";
  const usage: ChatUsage = { input: 0, output: 0, estimated: false };
  let counted = false;

  for await (const chunk of stream) {
    const piece = chunk.text;
    if (piece) {
      reply += piece;
      onDelta(piece);
    }
    const meta = (chunk as any).usageMetadata;
    if (meta) {
      // Gemini reports cumulative counts, so the last word wins rather than
      // the sum -- adding them up bills a long reply several times over.
      usage.input = meta.promptTokenCount ?? usage.input;
      usage.output = (meta.candidatesTokenCount ?? 0) + (meta.thoughtsTokenCount ?? 0);
      counted = true;
    }
  }

  return counted ? usage : estimate(call, reply);
}

/**
 * Ask the configured model, streaming the answer through `onDelta`.
 *
 * Throws ProviderError on refusal; the caller decides whether that is worth
 * another attempt and what to tell the reader.
 */
export function streamChat(call: ChatCall, onDelta: (text: string) => void): Promise<ChatUsage> {
  const kind = providerSpec(call.provider)?.kind ?? "openai";
  // The Gemini SDK throws its own error shape rather than returning a
  // response, so unwrapping happens here rather than at the fetch.
  if (kind === "gemini") return streamGemini(call, onDelta).catch((err) => { throw fromSdk(err); });
  if (kind === "anthropic") return streamAnthropic(call, onDelta);
  return streamOpenAi(call, onDelta);
}

// -------------------------------------------------------- model discovery --

/**
 * The models a vendor says it has, right now.
 *
 * The shipped catalogue is a convenience, not the truth: models appear and
 * retire between releases of this app, and OpenRouter alone carries hundreds.
 * Where a vendor publishes prices with the list (OpenRouter does; nobody else
 * does) they come back priced, and those prices are what the billing page then
 * uses.
 */
export async function listModels(
  providerId: string,
  key: string,
  baseUrl: string,
): Promise<ModelSpec[]> {
  const spec = providerSpec(providerId);
  if (!spec) throw new ProviderError(`Unknown provider "${providerId}".`, null);
  const root = trimSlash(baseUrl || spec.baseUrl);

  if (spec.kind === "gemini") {
    const res = await request(`${root}/v1beta/models?key=${encodeURIComponent(key)}&pageSize=200`);
    if (!res.ok) throw await failure(res);
    const body: any = await res.json();
    return (body.models ?? [])
      .filter((m: any) => (m.supportedGenerationMethods ?? []).includes("generateContent"))
      .map((m: any) => ({
        id: String(m.name ?? "").replace(/^models\//, ""),
        label: m.displayName || String(m.name ?? "").replace(/^models\//, ""),
        input: 0,
        output: 0,
        priced: false,
      }));
  }

  if (spec.kind === "anthropic") {
    const res = await request(`${root}/v1/models?limit=100`, {
      headers: { "x-api-key": key, "anthropic-version": "2023-06-01" },
    });
    if (!res.ok) throw await failure(res);
    const body: any = await res.json();
    return (body.data ?? []).map((m: any) => ({
      id: String(m.id),
      label: m.display_name || String(m.id),
      input: 0,
      output: 0,
      priced: false,
    }));
  }

  const res = await request(`${root}/models`, {
    headers: key ? { Authorization: `Bearer ${key}` } : {},
  });
  if (!res.ok) throw await failure(res);
  const body: any = await res.json();

  return (body.data ?? []).map((m: any): ModelSpec => {
    // OpenRouter is the one vendor that quotes a price per token here. It
    // arrives as a decimal string, sometimes "0" for a free model, so the
    // conversion to dollars-per-million is deliberate rather than implied.
    const prompt = Number(m.pricing?.prompt);
    const completion = Number(m.pricing?.completion);
    const quoted = Number.isFinite(prompt) && Number.isFinite(completion);
    return {
      id: String(m.id),
      label: m.name || String(m.id),
      input: quoted ? prompt * 1_000_000 : 0,
      output: quoted ? completion * 1_000_000 : 0,
      priced: quoted,
      note: m.context_length ? `${Math.round(m.context_length / 1000)}k context` : undefined,
    };
  });
}

/** Does this key work? Asked in the cheapest way each vendor allows -- by
    listing models, which costs nothing and still fails loudly on a bad key. */
export async function testKey(providerId: string, key: string, baseUrl: string) {
  const models = await listModels(providerId, key, baseUrl);
  return { ok: true, models: models.length };
}
