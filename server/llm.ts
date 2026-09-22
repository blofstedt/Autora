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

/** A tool the model may call, in the one shape all three vendors accept once
    it has been wrapped in their own envelope. */
export interface ToolDef {
  name: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, any>; required?: string[] };
}

/** The model asking for a tool to be run. */
export interface ToolUse {
  /** The vendor's own id for this call, which its tool result must quote back.
      Gemini issues none, so one is made up and kept only on our side. */
  id: string;
  name: string;
  args: Record<string, any>;
}

/** What came back, on its way to the model. */
export interface ToolReply {
  id: string;
  name: string;
  result: string;
  ok: boolean;
}

/**
 * One turn of the conversation.
 *
 * Three shapes in one interface rather than a union, because the great majority
 * of messages are still plain text and every existing caller builds them that
 * way. `calls` only ever appears on an assistant message; `replies` only on a
 * tool one.
 */
export interface ChatMessage {
  role: "user" | "assistant" | "tool";
  text?: string;
  /** Assistant only: tools this turn asked for. */
  calls?: ToolUse[];
  /** Tool only: what those calls returned. */
  replies?: ToolReply[];
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
  /** What the model may call this turn. Omitted or empty means text only, and
      the request then carries no tool field at all -- some local servers 400
      on an empty array. */
  tools?: ToolDef[];
}

export interface ChatUsage {
  input: number;
  output: number;
  /** True when the counts are our arithmetic rather than the vendor's. */
  estimated: boolean;
}

/** What one call to a model produced: words, and whatever it wants run. */
export interface ChatTurn {
  usage: ChatUsage;
  text: string;
  calls: ToolUse[];
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

/** Everything in a message that costs tokens, text or not: a page of tool
    output is the bulk of an agentic turn and leaving it out of the estimate
    would under-report the expensive turns by an order of magnitude. */
function weigh(message: ChatMessage): string {
  return [
    message.text ?? "",
    ...(message.calls ?? []).map((c) => c.name + JSON.stringify(c.args)),
    ...(message.replies ?? []).map((r) => r.result),
  ].join("");
}

function estimate(call: ChatCall, reply: string): ChatUsage {
  const prompt = call.system + call.messages.map(weigh).join("");
  return { input: roughTokens(prompt), output: roughTokens(reply), estimated: true };
}

/**
 * The arguments a model streamed, as an object.
 *
 * Arguments arrive as a JSON string assembled from deltas, and a model that
 * stopped mid-object leaves that string unparseable. An empty object is the
 * right answer there: the tool then reports its own missing-argument error into
 * the thread, which the model can read and retry, where a thrown parse error
 * would end the turn with a stack trace.
 */
function parseArgs(raw: string): Record<string, any> {
  const text = raw.trim();
  if (!text) return {};
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
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

/**
 * The history, in OpenAI's shape.
 *
 * A tool message per reply rather than per turn: the API pairs each result with
 * the `tool_call_id` it answers, and batching several into one message loses
 * that pairing -- which a model then notices as a call it never got an answer
 * for.
 */
function openAiMessages(call: ChatCall): any[] {
  const out: any[] = [];
  if (call.system) out.push({ role: "system", content: call.system });

  for (const message of call.messages) {
    if (message.role === "tool") {
      for (const reply of message.replies ?? []) {
        out.push({ role: "tool", tool_call_id: reply.id, content: reply.result });
      }
      continue;
    }
    if (message.role === "assistant") {
      const calls = message.calls ?? [];
      out.push({
        role: "assistant",
        // Null rather than "" when a turn was nothing but tool calls: some
        // gateways reject an assistant message with both an empty string and
        // tool_calls set.
        content: message.text || (calls.length > 0 ? null : ""),
        ...(calls.length > 0
          ? {
              tool_calls: calls.map((c) => ({
                id: c.id,
                type: "function",
                function: { name: c.name, arguments: JSON.stringify(c.args) },
              })),
            }
          : {}),
      });
      continue;
    }
    out.push({ role: "user", content: message.text ?? "" });
  }

  return out;
}

async function streamOpenAi(call: ChatCall, onDelta: (text: string) => void): Promise<ChatTurn> {
  const res = await request(`${trimSlash(call.baseUrl)}/chat/completions`, {
    method: "POST",
    headers: openAiHeaders(call),
    body: JSON.stringify({
      model: call.model,
      stream: true,
      stream_options: { include_usage: true },
      temperature: call.temperature ?? 0.7,
      max_tokens: call.maxTokens ?? 2048,
      messages: openAiMessages(call),
      ...(call.tools?.length
        ? {
            tools: call.tools.map((t) => ({
              type: "function",
              function: {
                name: t.name,
                description: t.description,
                parameters: t.parameters,
              },
            })),
            tool_choice: "auto",
          }
        : {}),
    }),
  });

  if (!res.ok) throw await failure(res);

  let reply = "";
  let usage: ChatUsage | null = null;
  /* Tool calls arrive as deltas keyed by position, not by id: the first chunk
     for a slot carries the id and name, and every chunk after it carries more
     of the argument JSON. So they are assembled by index and only parsed once
     the stream is done. */
  const building = new Map<number, { id: string; name: string; args: string }>();

  for await (const payload of sse(res)) {
    let chunk: any;
    try {
      chunk = JSON.parse(payload);
    } catch {
      continue;
    }
    // Some gateways deliver an error mid-stream with a 200 on the envelope.
    if (chunk.error) throw new ProviderError(chunk.error.message ?? "stream failed", null);

    const delta = chunk.choices?.[0]?.delta;
    const piece = delta?.content;
    if (typeof piece === "string" && piece) {
      reply += piece;
      onDelta(piece);
    }

    for (const part of delta?.tool_calls ?? []) {
      const slot = Number(part.index ?? 0);
      const found = building.get(slot) ?? { id: "", name: "", args: "" };
      if (part.id) found.id = String(part.id);
      if (part.function?.name) found.name += String(part.function.name);
      if (part.function?.arguments) found.args += String(part.function.arguments);
      building.set(slot, found);
    }

    if (chunk.usage) {
      usage = {
        input: chunk.usage.prompt_tokens ?? 0,
        output: chunk.usage.completion_tokens ?? 0,
        estimated: false,
      };
    }
  }

  const calls: ToolUse[] = [...building.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, found]) => found.name)
    .map(([slot, found]) => ({
      // A local server that omits ids still needs something stable to pair the
      // result against.
      id: found.id || `call_${slot}`,
      name: found.name,
      args: parseArgs(found.args),
    }));

  return { usage: usage ?? estimate(call, reply), text: reply, calls };
}

// ------------------------------------------------------------- anthropic --

/**
 * The history, in Anthropic's shape.
 *
 * Tool results are a *user* message here, not a role of their own, and all of
 * one turn's results belong in a single message -- the API rejects an assistant
 * turn whose tool_use blocks are not all answered before the next assistant
 * turn. Empty text blocks are dropped rather than sent: a content block with an
 * empty string is a 400, and a turn that was nothing but tool calls has exactly
 * that.
 */
function anthropicMessages(call: ChatCall): any[] {
  return call.messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        content: (message.replies ?? []).map((reply) => ({
          type: "tool_result",
          tool_use_id: reply.id,
          content: reply.result,
          ...(reply.ok ? {} : { is_error: true }),
        })),
      };
    }

    const content: any[] = [];
    if (message.text) content.push({ type: "text", text: message.text });
    for (const use of message.calls ?? []) {
      content.push({ type: "tool_use", id: use.id, name: use.name, input: use.args });
    }
    return {
      role: message.role,
      // Never an empty array, which is also a 400.
      content: content.length > 0 ? content : [{ type: "text", text: "(no content)" }],
    };
  });
}

async function streamAnthropic(call: ChatCall, onDelta: (text: string) => void): Promise<ChatTurn> {
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
      messages: anthropicMessages(call),
      ...(call.tools?.length
        ? {
            tools: call.tools.map((t) => ({
              name: t.name,
              description: t.description,
              input_schema: t.parameters,
            })),
          }
        : {}),
    }),
  });

  if (!res.ok) throw await failure(res);

  let reply = "";
  const usage: ChatUsage = { input: 0, output: 0, estimated: false };
  let counted = false;
  /* Blocks are addressed by index across the whole message: a tool_use opens
     at some index, its arguments arrive as partial JSON against that index, and
     text blocks are interleaved at other indices. */
  const building = new Map<number, { id: string; name: string; args: string }>();

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
    } else if (event.type === "content_block_start" && event.content_block?.type === "tool_use") {
      building.set(Number(event.index ?? 0), {
        id: String(event.content_block.id ?? ""),
        name: String(event.content_block.name ?? ""),
        // A tool with no arguments sends no input_json_delta at all, so the
        // starting input is what it gets.
        args: JSON.stringify(event.content_block.input ?? {}),
      });
    } else if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
      const piece = String(event.delta.text ?? "");
      if (piece) {
        reply += piece;
        onDelta(piece);
      }
    } else if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
      const found = building.get(Number(event.index ?? 0));
      if (found) {
        // The first delta replaces the "{}" the block opened with; every one
        // after it appends.
        if (found.args === "{}") found.args = "";
        found.args += String(event.delta.partial_json ?? "");
      }
    } else if (event.type === "message_delta" && event.usage) {
      usage.output = event.usage.output_tokens ?? usage.output;
      counted = true;
    }
  }

  const calls: ToolUse[] = [...building.entries()]
    .sort((a, b) => a[0] - b[0])
    .filter(([, found]) => found.name && found.id)
    .map(([, found]) => ({ id: found.id, name: found.name, args: parseArgs(found.args) }));

  return { usage: counted ? usage : estimate(call, reply), text: reply, calls };
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

/**
 * The history, in Gemini's shape.
 *
 * Gemini names no ids: a functionResponse is matched to its functionCall by
 * name alone. So the ids the rest of this module relies on are ours, invented
 * at parse time, and dropped again here.
 */
function geminiContents(call: ChatCall): any[] {
  return call.messages.map((message) => {
    if (message.role === "tool") {
      return {
        role: "user",
        parts: (message.replies ?? []).map((reply) => ({
          functionResponse: {
            name: reply.name,
            // The payload must be an object; the string goes inside it. A
            // failure travels as an `error` key so the model can tell a tool
            // that reported a problem from one that returned prose about one.
            response: reply.ok ? { result: reply.result } : { error: reply.result },
          },
        })),
      };
    }

    const parts: any[] = [];
    if (message.text) parts.push({ text: message.text });
    for (const use of message.calls ?? []) {
      parts.push({ functionCall: { name: use.name, args: use.args } });
    }
    return {
      role: message.role === "assistant" ? "model" : "user",
      parts: parts.length > 0 ? parts : [{ text: "(no content)" }],
    };
  });
}

async function streamGemini(call: ChatCall, onDelta: (text: string) => void): Promise<ChatTurn> {
  const client = gemini(call.key, call.baseUrl);
  const stream = await client.models.generateContentStream({
    model: call.model,
    contents: geminiContents(call),
    config: {
      systemInstruction: call.system || undefined,
      temperature: call.temperature ?? 0.7,
      maxOutputTokens: call.maxTokens ?? 2048,
      thinkingConfig: { thinkingBudget: call.thinkingBudget ?? 0 },
      ...(call.tools?.length
        ? {
            tools: [{
              functionDeclarations: call.tools.map((t) => ({
                name: t.name,
                description: t.description,
                /* Not `parameters`, which wants Google's own Schema type with
                   its uppercase Type enum. This field takes JSON Schema
                   verbatim, which is the one shape all three vendors share --
                   so the registry needs no per-vendor translation. */
                parametersJsonSchema: t.parameters,
              })),
            }],
          }
        : {}),
    },
  });

  let reply = "";
  const usage: ChatUsage = { input: 0, output: 0, estimated: false };
  let counted = false;
  const calls: ToolUse[] = [];

  for await (const chunk of stream) {
    /* `chunk.text` throws rather than returning undefined when the chunk holds
       a function call instead of prose, which would otherwise abort the stream
       on the very turn the tool was requested. */
    let piece: string | undefined;
    try {
      piece = chunk.text;
    } catch {
      piece = undefined;
    }
    if (piece) {
      reply += piece;
      onDelta(piece);
    }

    /* Function calls arrive whole -- there is no partial-argument streaming to
       reassemble -- but they can arrive on either the convenience getter or in
       the raw parts, depending on SDK version. Reading both and keyed
       de-duplication is cheaper than pinning a version. */
    const found: any[] = [];
    try {
      for (const fn of (chunk as any).functionCalls ?? []) found.push(fn);
    } catch {
      // Same getter problem as above.
    }
    for (const part of (chunk as any).candidates?.[0]?.content?.parts ?? []) {
      if (part?.functionCall) found.push(part.functionCall);
    }
    for (const fn of found) {
      const name = String(fn?.name ?? "");
      if (!name) continue;
      const args = fn?.args && typeof fn.args === "object" ? fn.args : {};
      const id = `${name}-${calls.length}`;
      if (calls.some((c) => c.name === name && JSON.stringify(c.args) === JSON.stringify(args))) {
        continue;
      }
      calls.push({ id, name, args });
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

  return { usage: counted ? usage : estimate(call, reply), text: reply, calls };
}

/**
 * Ask the configured model, streaming the words through `onDelta`.
 *
 * Returns what the model said *and* whatever it wants run. Running those, and
 * deciding whether to go round again, belongs to the caller: the agent loop
 * needs the session, the event log and the approval gate, none of which this
 * module should know about.
 *
 * Throws ProviderError on refusal; the caller decides whether that is worth
 * another attempt and what to tell the reader.
 */
export function streamChat(call: ChatCall, onDelta: (text: string) => void): Promise<ChatTurn> {
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
