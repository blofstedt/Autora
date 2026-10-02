/**
 * Where a chat's time and tokens went, read back out of its log.
 *
 * Tuning an agent by feel is guessing: which tool is slow, which one keeps
 * failing, how much of each model call was the cache, how many rounds a turn
 * took. All of it is already in the log -- usage per call, a duration on every
 * result, the stops -- so this only reads it. Pure: events in, numbers out.
 */

export interface TraceEvent {
  kind: string;
  ts?: number;
  span?: string | null;
  payload: Record<string, any>;
}

export interface ToolTrace {
  name: string;
  calls: number;
  failures: number;
  /** Calls the person's own work held back (not failures). */
  held: number;
  totalMs: number;
  slowestMs: number;
}

export interface TurnTrace {
  /** Model calls in the turn. */
  rounds: number;
  tools: number;
  input: number;
  output: number;
  cached: number;
  stopped: boolean;
  reason: string | null;
  request: string;
}

export interface Trace {
  turns: number;
  rounds: number;
  input: number;
  output: number;
  cached: number;
  /** Share of input tokens that came from the cache, 0 to 1. */
  cacheRate: number;
  /** Calls that mostly missed the cache after the first of a turn, and how
      many of those came with a change in the tool list. */
  cacheMisses: number;
  cacheMissesFromTools: number;
  costUsd: number;
  tools: ToolTrace[];
  /** The most recent turns, newest last. */
  recent: TurnTrace[];
  /** Times the loop watch or error budget ended a turn. */
  loopStops: number;
  /** Tools brought in on demand, by set. */
  loaded: string[];
}

const num = (v: unknown) => (typeof v === "number" && Number.isFinite(v) ? v : 0);

export function buildTrace(events: readonly TraceEvent[], recentTurns = 8): Trace {
  const byTool = new Map<string, ToolTrace>();
  const names = new Map<string, string>();
  const turns: TurnTrace[] = [];
  let cur: TurnTrace | null = null;
  const total = { rounds: 0, input: 0, output: 0, cached: 0, cost: 0, loopStops: 0, misses: 0, toolMisses: 0 };
  const loaded = new Set<string>();

  const tool = (name: string): ToolTrace => {
    let t = byTool.get(name);
    if (!t) byTool.set(name, (t = { name, calls: 0, failures: 0, held: 0, totalMs: 0, slowestMs: 0 }));
    return t;
  };

  for (const e of events) {
    const p = e.payload ?? {};
    switch (e.kind) {
      case "turn.user":
        cur = { rounds: 0, tools: 0, input: 0, output: 0, cached: 0, stopped: false, reason: null, request: String(p.shown ?? p.text ?? "").replace(/\s+/g, " ").trim().slice(0, 80) };
        turns.push(cur);
        break;
      case "usage.turn": {
        const input = num(p.input_tokens), output = num(p.output_tokens), cached = num(p.cached_tokens);
        /* A call after the turn's first that read little of a large prompt from the
           cache: something early in it changed. Judged on what was not read, since
           only some providers (Anthropic) report what was written. */
        if (cur && cur.rounds > 0 && input - cached > 2000 && cached < input / 2) {
          total.misses += 1;
          if (p.tools_changed === true) total.toolMisses += 1;
        }
        total.rounds += 1; total.input += input; total.output += output; total.cached += cached; total.cost += num(p.cost_usd);
        if (cur) { cur.rounds += 1; cur.input += input; cur.output += output; cur.cached += cached; }
        break;
      }
      case "tool.call": {
        const name = String(p.name ?? "tool");
        if (e.span) names.set(e.span, name);
        tool(name).calls += 1;
        if (cur) cur.tools += 1;
        break;
      }
      case "tool.result":
      case "tool.error": {
        const name = e.span ? names.get(e.span) : undefined;
        if (!name) break;
        const t = tool(name);
        if (e.kind === "tool.error" || p.ok === false) {
          if (p.held) t.held += 1;
          else t.failures += 1;
        }
        const ms = num(p.duration_ms);
        t.totalMs += ms;
        t.slowestMs = Math.max(t.slowestMs, ms);
        break;
      }
      case "tools.enable":
        if (typeof p.family === "string") loaded.add(p.family);
        break;
      case "turn.agent.done":
        if (cur) {
          cur.stopped = p.stopped === true || p.interrupted === true;
          cur.reason = typeof p.reason === "string" ? p.reason : null;
          if (cur.reason) total.loopStops += 1;
        }
        break;
    }
  }

  return {
    turns: turns.length,
    rounds: total.rounds,
    input: total.input,
    output: total.output,
    cached: total.cached,
    cacheRate: total.input > 0 ? total.cached / total.input : 0,
    cacheMisses: total.misses,
    cacheMissesFromTools: total.toolMisses,
    costUsd: total.cost,
    tools: [...byTool.values()].sort((a, b) => b.totalMs - a.totalMs || b.calls - a.calls),
    recent: turns.slice(-recentTurns),
    loopStops: total.loopStops,
    loaded: [...loaded],
  };
}

const k = (n: number) => (n >= 10_000 ? `${Math.round(n / 1000)}k` : n.toLocaleString("en-US"));

/** The trace as text: what a person reads to see where the time went. */
export function traceText(t: Trace): string {
  const out = [
    `${t.turns} turn${t.turns === 1 ? "" : "s"}, ${t.rounds} model call${t.rounds === 1 ? "" : "s"}: ${k(t.input)} in (${Math.round(t.cacheRate * 100)}% from cache), ${k(t.output)} out` +
      (t.costUsd > 0 ? `, about $${t.costUsd.toFixed(t.costUsd < 1 ? 3 : 2)}` : "") + ".",
  ];
  if (t.loopStops > 0) out.push(`${t.loopStops} turn${t.loopStops === 1 ? " was" : "s were"} ended by the loop watch or error budget.`);
  if (t.cacheMisses > 0) {
    out.push(`${t.cacheMisses} call${t.cacheMisses === 1 ? "" : "s"} rewrote the cache mid-turn (${t.cacheMissesFromTools} with a change in the tool list).`);
  }
  if (t.loaded.length > 0) out.push(`Tool sets brought in: ${t.loaded.join(", ")}.`);
  if (t.tools.length > 0) {
    out.push("Tools, by time spent:");
    for (const x of t.tools.slice(0, 12)) {
      out.push(`- ${x.name}: ${x.calls} call${x.calls === 1 ? "" : "s"}, ${(x.totalMs / 1000).toFixed(1)}s (slowest ${(x.slowestMs / 1000).toFixed(1)}s)` +
        `${x.failures ? `, ${x.failures} failed` : ""}${x.held ? `, ${x.held} held for the person` : ""}`);
    }
  }
  return out.join("\n");
}
