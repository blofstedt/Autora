/**
 * Jev Mode, part two: scoring every field at once.
 *
 * Each field becomes one tiny request: the same long prefix -- instructions,
 * the context, every field and its lettered options -- then a short suffix
 * naming the one field to answer, capped at a single output token, with the
 * top alternatives' log-probabilities returned. The requests go out together.
 *
 * Why the prefix is identical, byte for byte, across fields: that is what
 * lets the backend reuse it. vLLM's prefix cache and llama.cpp's prompt cache
 * keep its KV state after the first request and only prefill the suffix for
 * the rest; OpenAI and DeepSeek apply their own prompt caching to a repeated
 * prefix. We cannot pin a cache from outside the server, but we can make sure
 * there is one to hit.
 *
 * Why letters rather than the values themselves: "high" and " high" and
 * "High" are different tokens, and a value's probability would otherwise be
 * split across tokenizations the model happens to prefer. A lone capital
 * letter is a single token in every tokenizer we know of; the spelling
 * variants the model may still emit (" A", "A)", "(A") are folded together
 * before the scores are compared.
 */

import type { JevField, JevValue } from "./schema";

export interface JevTarget {
  provider: string;
  /** "typesafe" is the hosted Jev API itself: it answers typed questions
      with probabilities directly, so no log-probabilities are needed from
      the chat model. */
  kind: "openai" | "gemini" | "anthropic" | "typesafe";
  baseUrl: string;
  key: string;
  model: string;
}

export interface FieldScore {
  name: string;
  /** The winning label and the value it stands for. */
  label: string;
  value: JevValue;
  /** Softmax over the candidate labels only: the winner's share. */
  confidence: number;
  /** How much of the model's probability landed on any candidate at all.
      Low coverage means it wanted to say something else entirely. */
  coverage: number;
  /** Every candidate's share, for the confidence matrix. */
  distribution: Record<string, number>;
}

export interface EngineResult {
  fields: FieldScore[];
  ms: number;
  usage: { input: number; output: number; cached: number };
}

/** The backend cannot score (no log-probabilities, or refuses the request
    shape). Remembered, so the next turn does not pay to find out again. */
export class JevUnsupported extends Error {}

const FIELD_TIMEOUT_MS = 8000;
const TOP_LOGPROBS = 20;

/** Model families known to refuse log-probabilities outright. Checked before
    any request, so choosing one costs nothing. */
const NO_LOGPROBS = /(^|\/)(o\d(-|$)|o\d-mini|gpt-5)/i;

export function staticSupport(target: JevTarget): { ok: boolean; reason?: string } {
  if (target.kind === "typesafe") {
    return target.key ? { ok: true } : { ok: false, reason: "No Jev API key is set." };
  }
  if (target.kind === "anthropic") {
    return { ok: false, reason: "Anthropic's API does not return token probabilities." };
  }
  if (target.kind === "openai" && NO_LOGPROBS.test(target.model)) {
    return { ok: false, reason: `${target.model} is a reasoning model and does not return token probabilities.` };
  }
  return { ok: true };
}

/** The shared prefix. Deliberately stable: no timestamps, no per-field text. */
export function buildPrefix(context: string, fields: JevField[], instructions?: string): string {
  const lines = [
    "You make quick structured decisions. For each field below, pick exactly one option.",
    "Answer with the option's letter only.",
  ];
  if (instructions?.trim()) lines.push("", instructions.trim());
  lines.push("", "Context:", context.trim() || "(none)", "", "Fields:");
  for (const f of fields) {
    lines.push(`- ${f.name}${f.description ? `: ${f.description}` : ""}`);
    for (const o of f.options) lines.push(`  ${o.label}) ${o.text}`);
  }
  return lines.join("\n");
}

function fieldPrompt(field: JevField): string {
  const letters = field.options.map((o) => o.label).join(", ");
  return `Field "${field.name}". Reply with one letter (${letters}) and nothing else.`;
}

/** " A", "A)", "(a", "**A**" -> "A". Anything that is not a lone letter is
    not a candidate. */
function normalize(token: string): string | null {
  const bare = token.replace(/[\s"'`*().:\[\]]/g, "").toUpperCase();
  return /^[A-Z]$/.test(bare) ? bare : null;
}

/** Fold a token -> logprob list into per-label probabilities. */
export function scoreField(
  field: JevField,
  alternatives: { token: string; logprob: number }[],
): FieldScore {
  const labels = new Map(field.options.map((o) => [o.label, o]));
  const mass: Record<string, number> = Object.fromEntries(field.options.map((o) => [o.label, 0]));
  for (const alt of alternatives) {
    const p = Math.exp(alt.logprob);
    const label = normalize(alt.token);
    if (label && labels.has(label)) mass[label] += p;
  }
  const covered = Object.values(mass).reduce((a, b) => a + b, 0);
  const distribution: Record<string, number> = {};
  let best = field.options[0].label;
  for (const o of field.options) {
    distribution[o.label] = covered > 0 ? mass[o.label] / covered : 0;
    if (distribution[o.label] > distribution[best]) best = o.label;
  }
  return {
    name: field.name,
    label: best,
    value: labels.get(best)!.value,
    confidence: covered > 0 ? distribution[best] : 0,
    // Against all the probability the model spent, not just the part the
    // API listed: the unlisted tail is still probability not on a candidate.
    coverage: Math.min(1, covered),
    distribution,
  };
}

async function post(url: string, headers: Record<string, string>, body: unknown, signal: AbortSignal) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", ...headers },
    body: JSON.stringify(body),
    signal,
  });
  const text = await res.text();
  let data: any = null;
  try { data = JSON.parse(text); } catch { /* reported below */ }
  if (!res.ok) {
    const message = data?.error?.message ?? data?.error ?? text.slice(0, 200) ?? `HTTP ${res.status}`;
    // A 400 that mentions the feature is the backend saying it cannot do this.
    if (res.status === 400 && /logprob|log_prob|not supported|unsupported|responseLogprobs/i.test(String(message))) {
      throw new JevUnsupported(String(message));
    }
    throw new Error(`${res.status}: ${message}`);
  }
  return data;
}

async function scoreOpenAi(
  target: JevTarget, prefix: string, field: JevField, signal: AbortSignal,
) {
  const headers: Record<string, string> = {};
  if (target.key) headers.Authorization = `Bearer ${target.key}`;
  const data = await post(`${target.baseUrl.replace(/\/+$/, "")}/chat/completions`, headers, {
    model: target.model,
    messages: [
      { role: "system", content: prefix },
      { role: "user", content: fieldPrompt(field) },
    ],
    max_tokens: 1,
    temperature: 0,
    logprobs: true,
    top_logprobs: TOP_LOGPROBS,
    stream: false,
  }, signal);
  const first = data?.choices?.[0]?.logprobs?.content?.[0];
  if (!first) throw new JevUnsupported("The endpoint answered without token probabilities.");
  const alternatives: { token: string; logprob: number }[] =
    Array.isArray(first.top_logprobs) && first.top_logprobs.length
      ? first.top_logprobs
      : [{ token: first.token, logprob: first.logprob }];
  return {
    score: scoreField(field, alternatives),
    usage: {
      input: data?.usage?.prompt_tokens ?? 0,
      output: data?.usage?.completion_tokens ?? 1,
      cached: data?.usage?.prompt_cache_hit_tokens ?? data?.usage?.prompt_tokens_details?.cached_tokens ?? 0,
    },
  };
}

async function scoreGemini(
  target: JevTarget, prefix: string, field: JevField, signal: AbortSignal,
) {
  const base = target.baseUrl.replace(/\/+$/, "");
  const url = `${base}/v1beta/models/${encodeURIComponent(target.model)}:generateContent`;
  const data = await post(url, { "x-goog-api-key": target.key }, {
    systemInstruction: { parts: [{ text: prefix }] },
    contents: [{ role: "user", parts: [{ text: fieldPrompt(field) }] }],
    generationConfig: {
      maxOutputTokens: 1,
      temperature: 0,
      responseLogprobs: true,
      logprobs: TOP_LOGPROBS,
    },
  }, signal);
  const top = data?.candidates?.[0]?.logprobsResult?.topCandidates?.[0]?.candidates;
  if (!Array.isArray(top) || top.length === 0) {
    throw new JevUnsupported("The model answered without token probabilities.");
  }
  return {
    score: scoreField(field, top.map((c: any) => ({ token: String(c.token ?? ""), logprob: Number(c.logProbability) }))),
    usage: {
      input: data?.usageMetadata?.promptTokenCount ?? 0,
      output: data?.usageMetadata?.candidatesTokenCount ?? 1,
      cached: data?.usageMetadata?.cachedContentTokenCount ?? 0,
    },
  };
}

/**
 * Every field in one request to the hosted Jev API (TypeSafe's System One).
 *
 * Each field goes as a "choice" question whose criteria are keyed by the
 * option's letter, so the answer maps straight back onto the option table and
 * the rest of the pipeline -- thresholds, coverage, the confidence matrix --
 * is the same as for the log-probability path.
 */
async function scoreTypeSafe(
  target: JevTarget, context: string, fields: JevField[], instructions: string | undefined,
  signal: AbortSignal,
): Promise<{ scores: FieldScore[]; usage: { input: number; output: number; cached: number } }> {
  const questions: Record<string, unknown> = {};
  for (const f of fields) {
    questions[f.name] = {
      type: "choice",
      instructions: f.description || f.name,
      criteria: Object.fromEntries(f.options.map((o) => [o.label, o.text])),
    };
  }
  const state = instructions?.trim()
    ? `${instructions.trim()}\n\n${context.trim() || "(none)"}`
    : context.trim() || "(none)";
  const data = await post(`${target.baseUrl.replace(/\/+$/, "")}/v1/systemone`, {
    Authorization: `Bearer ${target.key}`,
  }, { model: target.model, state, questions }, signal);
  const answers = data?.answers;
  if (!answers || typeof answers !== "object") {
    throw new Error("Jev answered without any answers.");
  }
  const scores = fields.map((f) => {
    const answer = answers[f.name];
    const probs: Record<string, unknown> = answer?.probabilities ?? {};
    const alternatives = f.options
      .map((o) => ({ token: o.label, p: Number(probs[o.label]) }))
      .filter((a) => Number.isFinite(a.p) && a.p > 0)
      .map((a) => ({ token: a.token, logprob: Math.log(a.p) }));
    if (alternatives.length === 0 && typeof answer?.choice === "string") {
      // No distribution, only a pick: trust it at the confidence Jev gave.
      const c = Number(answer.confidence);
      alternatives.push({ token: answer.choice, logprob: Math.log(Number.isFinite(c) && c > 0 ? c : 1) });
    }
    return scoreField(f, alternatives);
  });
  return {
    scores,
    usage: {
      input: data?.usage?.input_tokens ?? data?.usage?.prompt_tokens ?? 0,
      output: data?.usage?.output_tokens ?? data?.usage?.completion_tokens ?? 0,
      cached: 0,
    },
  };
}

/**
 * Score every field in parallel against one shared prefix.
 *
 * Throws JevUnsupported if the backend cannot do this at all, and an
 * ordinary error for anything transient; either way the caller falls back.
 */
export async function evaluateFields(
  target: JevTarget,
  fields: JevField[],
  context: string,
  opts: {
    instructions?: string; timeoutMs?: number; signal?: AbortSignal;
    /** Send one field first and the rest only if it came back scored: for a
        backend not yet known to support this, so finding out it does not
        costs one request rather than one per field. */
    probe?: boolean;
  } = {},
): Promise<EngineResult> {
  const support = staticSupport(target);
  if (!support.ok) throw new JevUnsupported(support.reason);

  const started = performance.now();
  const prefix = buildPrefix(context, fields, opts.instructions);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs ?? FIELD_TIMEOUT_MS);
  opts.signal?.addEventListener("abort", () => controller.abort(), { once: true });

  if (target.kind === "typesafe") {
    try {
      const { scores, usage } = await scoreTypeSafe(
        target, context, fields, opts.instructions, controller.signal,
      );
      return { fields: scores, ms: Math.round(performance.now() - started), usage };
    } finally {
      clearTimeout(timer);
    }
  }

  const score = target.kind === "gemini" ? scoreGemini : scoreOpenAi;

  try {
    const results = opts.probe && fields.length > 1
      ? [
          await score(target, prefix, fields[0], controller.signal),
          ...(await Promise.all(
            fields.slice(1).map((field) => score(target, prefix, field, controller.signal)),
          )),
        ]
      : await Promise.all(fields.map((field) => score(target, prefix, field, controller.signal)));
    const usage = { input: 0, output: 0, cached: 0 };
    for (const r of results) {
      usage.input += r.usage.input;
      usage.output += r.usage.output;
      usage.cached += r.usage.cached;
    }
    return {
      fields: results.map((r) => r.score),
      ms: Math.round(performance.now() - started),
      usage,
    };
  } finally {
    clearTimeout(timer);
  }
}
