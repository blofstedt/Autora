/**
 * Jev Mode, part three: when to use it, and when to let go.
 *
 * Every decision offered to Jev passes three gates before a request is made:
 * Jev is switched on, the model behind the current provider can return token
 * probabilities, and the decision's schema is independent and discrete. Past
 * those, the fields are scored in parallel and the decision is accepted only
 * if its least confident field clears the threshold. Everything else --
 * a gate that fails, a low score, a timeout, an error -- returns a fallback
 * and the caller carries on exactly as it did before Jev existed.
 *
 * Two memories keep failure cheap. A backend found not to support scoring is
 * remembered for a while, so turns stop paying to rediscover it; and three
 * failures in a row open a breaker that sends everything to the fallback for
 * a few minutes, so a struggling endpoint is not hit twice per turn.
 */

import { parseSchema, type JevValue, type JsonSchema, type JevField } from "./schema";
import {
  evaluateFields, staticSupport, JevUnsupported, type FieldScore, type JevTarget,
} from "./engine";

export interface JevSettings {
  enabled: boolean;
  /** Minimum per-field confidence for the fast path, 0.5-0.99. */
  threshold: number;
  /** A key for the hosted Jev API (api.typesafe.ai). When set, decisions go
      there instead of to the chat model, so they work whatever that model
      is -- including Anthropic's, which cannot score. Never sent to the page. */
  key?: string;
}

export const DEFAULT_JEV: JevSettings = { enabled: true, threshold: 0.75 };

/** Probability mass that must land on the candidates at all before a field's
    confidence means anything. Below this the model wanted to say something
    other than a letter, and the relative scores are noise. */
const MIN_COVERAGE = 0.5;

const UNSUPPORTED_TTL_MS = 30 * 60 * 1000;
const BREAKER_FAILURES = 3;
const BREAKER_OPEN_MS = 5 * 60 * 1000;

export type JevOutcome =
  | {
      mode: "jev";
      /** The programmatic payload: every field, as its schema's value. */
      values: Record<string, JevValue>;
      /** Confidence per field, 0-1. */
      confidence: Record<string, number>;
      min: number;
      fields: FieldScore[];
      ms: number;
      usage: { input: number; output: number; cached: number };
    }
  | {
      mode: "fallback";
      /** Said so a person can read it in the thread. */
      reason: string;
      /** Whether a request was actually made -- a gate failing costs nothing
          and is not worth reporting every turn. */
      attempted: boolean;
      fields?: FieldScore[];
      ms: number;
      usage?: { input: number; output: number; cached: number };
    };

export interface JevTask {
  /** What the decision is for, in a few words ("memory recall"). */
  name: string;
  context: string;
  schema: JsonSchema;
  instructions?: string;
  timeoutMs?: number;
  /** Human names for fields, for display only ("memory_3" -> its title). */
  labels?: Record<string, string>;
}

type Health = {
  unsupported?: { reason: string; until: number };
  failures: number;
  openUntil: number;
};
const health = new Map<string, Health>();
/** A first request to a backend not yet known to score, per backend. Other
    decisions made at the same moment wait for it rather than each finding out
    for themselves -- two decisions run side by side on every turn, and without
    this a model that cannot score was reported twice. */
const probing = new Map<string, Promise<unknown>>();

type Last = {
  task: string; mode: "jev" | "fallback"; ms: number; fields: number;
  min: number | null; reason?: string; at: number;
};
let last: Last | null = null;

const keyOf = (t: JevTarget) => `${t.provider}|${t.baseUrl}|${t.model}`;
const healthOf = (t: JevTarget): Health => {
  let h = health.get(keyOf(t));
  if (!h) { h = { failures: 0, openUntil: 0 }; health.set(keyOf(t), h); }
  return h;
};

/** Can this target score at all, as far as we know right now? */
export function supportFor(target: JevTarget | null): { state: "yes" | "no" | "unknown"; reason?: string } {
  if (!target) return { state: "no", reason: "No model is connected." };
  const stat = staticSupport(target);
  if (!stat.ok) return { state: "no", reason: stat.reason };
  const h = health.get(keyOf(target));
  if (h?.unsupported && h.unsupported.until > Date.now()) {
    return { state: "no", reason: h.unsupported.reason };
  }
  if (h && h.openUntil > Date.now()) {
    return { state: "no", reason: "Paused after repeated failures; retrying in a few minutes." };
  }
  if (h && (h.failures === 0) && last?.mode === "jev") return { state: "yes" };
  return { state: "unknown" };
}

export function lastDecision(): Last | null {
  return last;
}

/**
 * Decide, fast if possible.
 *
 * Never throws: every failure is a fallback, so wrapping an existing code
 * path in this cannot break it.
 */
export async function decide(
  task: JevTask,
  target: JevTarget | null,
  settings: JevSettings,
): Promise<JevOutcome> {
  const started = performance.now();
  const bail = (reason: string, attempted = false, extra: Partial<JevOutcome> = {}): JevOutcome => {
    const outcome = {
      mode: "fallback" as const, reason, attempted,
      ms: Math.round(performance.now() - started), ...extra,
    } as JevOutcome;
    if (attempted) {
      last = { task: task.name, mode: "fallback", ms: outcome.ms, fields: 0, min: null, reason, at: Date.now() };
    }
    return outcome;
  };

  if (!settings.enabled) return bail("Jev Mode is off.");
  if (!target) return bail("No model is connected.");
  const parsed = parseSchema(task.schema);
  if (!parsed.eligible) {
    return bail(`Not a fast decision: ${parsed.reasons.join("; ") || "no scorable fields"}.`);
  }

  const inFlight = probing.get(keyOf(target));
  if (inFlight) await inFlight.catch(() => undefined);
  const support = supportFor(target);
  if (support.state === "no") return bail(support.reason ?? "This model cannot score.");

  const h = healthOf(target);
  let result;
  try {
    const run = evaluateFields(target, parsed.fields, task.context, {
      instructions: task.instructions,
      timeoutMs: task.timeoutMs,
      probe: support.state === "unknown",
    });
    if (support.state === "unknown" && !probing.has(keyOf(target))) {
      const key = keyOf(target);
      probing.set(key, run);
      void run.catch(() => undefined).finally(() => {
        if (probing.get(key) === run) probing.delete(key);
      });
    }
    result = await run;
  } catch (err: any) {
    if (err instanceof JevUnsupported) {
      h.unsupported = { reason: err.message, until: Date.now() + UNSUPPORTED_TTL_MS };
      return bail(`This model cannot score: ${err.message}`, true);
    }
    h.failures += 1;
    if (h.failures >= BREAKER_FAILURES) {
      h.openUntil = Date.now() + BREAKER_OPEN_MS;
      h.failures = 0;
    }
    const why = err?.name === "AbortError" ? "timed out" : (err?.message ?? String(err));
    return bail(`Scoring failed (${why}).`, true);
  }
  h.failures = 0;

  const threshold = clampThreshold(settings.threshold);
  const weak = result.fields.filter(
    (f) => f.confidence < threshold || f.coverage < MIN_COVERAGE,
  );
  const min = Math.min(...result.fields.map((f) => f.confidence));
  if (weak.length > 0) {
    const named = (f: FieldScore) => task.labels?.[f.name] ?? f.name;
    const worst = weak
      .map((f) => f.coverage < MIN_COVERAGE
        ? `${named(f)} (answered off-list)`
        : `${named(f)} (${f.confidence.toFixed(2)})`)
      .slice(0, 3)
      .join(", ");
    const outcome = bail(`Low confidence on ${worst}; below ${threshold}.`, true, {
      fields: result.fields, usage: result.usage,
    } as Partial<JevOutcome>);
    last = {
      task: task.name, mode: "fallback", ms: result.ms, fields: result.fields.length,
      min, reason: `low confidence: ${worst}`, at: Date.now(),
    };
    return outcome;
  }

  // Programmatic assembly: values come only from the option maps, so the
  // payload is valid against the schema by construction.
  const values: Record<string, JevValue> = {};
  const confidence: Record<string, number> = {};
  for (const f of result.fields) {
    values[f.name] = f.value;
    confidence[f.name] = f.confidence;
  }
  last = { task: task.name, mode: "jev", ms: result.ms, fields: result.fields.length, min, at: Date.now() };
  return {
    mode: "jev", values, confidence, min, fields: result.fields, ms: result.ms, usage: result.usage,
  };
}

export function clampThreshold(value: unknown): number {
  const n = Number(value);
  if (!Number.isFinite(n)) return DEFAULT_JEV.threshold;
  return Math.min(0.99, Math.max(0.5, n));
}

/** Fields as the parser sees them, for callers that want to show the options. */
export function fieldsOf(schema: JsonSchema): JevField[] {
  return parseSchema(schema).fields;
}

/** For tests: forget every backend's history. */
export function resetHealth() {
  health.clear();
  probing.clear();
  last = null;
}
