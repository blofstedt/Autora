/**
 * Reading where a chat's time and tokens went.
 *
 *   npx tsx tests/trace.test.ts
 */
import assert from "node:assert/strict";
import { buildTrace, traceText, type TraceEvent } from "../server/trace";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const ev = (kind: string, payload: Record<string, any> = {}, span: string | null = null): TraceEvent => ({ kind, payload, span });

const log: TraceEvent[] = [
  ev("turn.user", { text: "fix the build" }),
  ev("usage.turn", { input_tokens: 1000, output_tokens: 100, cached_tokens: 0, cost_usd: 0.01 }),
  ev("tool.call", { name: "terminal" }, "s1"), ev("tool.result", { ok: true, duration_ms: 1200 }, "s1"),
  ev("usage.turn", { input_tokens: 1500, output_tokens: 50, cached_tokens: 1000, cost_usd: 0.005 }),
  ev("tool.call", { name: "terminal" }, "s2"), ev("tool.result", { ok: false, duration_ms: 3000 }, "s2"),
  ev("tool.call", { name: "pdf_edit" }, "s3"), ev("tool.error", { error: "x", held: true }, "s3"),
  ev("tools.enable", { family: "pdf" }),
  ev("turn.agent.done", {}),
  ev("turn.user", { text: "again" }),
  ev("usage.turn", { input_tokens: 500, output_tokens: 20, cached_tokens: 500 }),
  ev("turn.agent.done", { stopped: true, reason: "Stopped: same error" }),
];

console.log("trace");

test("tokens, rounds and the cache share are summed", () => {
  const t = buildTrace(log);
  assert.equal(t.turns, 2);
  assert.equal(t.rounds, 3);
  assert.equal(t.input, 3000);
  assert.equal(t.output, 170);
  assert.equal(t.cached, 1500);
  assert.equal(t.cacheRate, 0.5);
  assert.ok(Math.abs(t.costUsd - 0.015) < 1e-9);
});

test("each tool has its calls, time, failures and held calls", () => {
  const t = buildTrace(log);
  const terminal = t.tools.find((x) => x.name === "terminal")!;
  assert.deepEqual([terminal.calls, terminal.failures, terminal.totalMs, terminal.slowestMs], [2, 1, 4200, 3000]);
  const pdf = t.tools.find((x) => x.name === "pdf_edit")!;
  assert.deepEqual([pdf.failures, pdf.held], [0, 1], "a held call is not a failure");
  assert.equal(t.tools[0].name, "terminal", "slowest first");
});

test("per-turn lines, the stop, and loaded sets", () => {
  const t = buildTrace(log);
  assert.equal(t.recent[0].rounds, 2);
  assert.equal(t.recent[0].tools, 3);
  assert.equal(t.recent[1].stopped, true);
  assert.equal(t.loopStops, 1);
  assert.deepEqual(t.loaded, ["pdf"]);
});

test("the text names the cache, the stop and the slow tool", () => {
  const text = traceText(buildTrace(log));
  assert.match(text, /2 turns, 3 model calls/);
  assert.match(text, /50% from cache/);
  assert.match(text, /1 turn was ended by the loop watch/);
  assert.match(text, /- terminal: 2 calls, 4\.2s \(slowest 3\.0s\), 1 failed/);
  assert.match(text, /1 held for the person/);
});

test("an empty log is empty, not an error", () => {
  const t = buildTrace([]);
  assert.equal(t.turns, 0);
  assert.equal(t.cacheRate, 0);
  assert.match(traceText(t), /0 turns, 0 model calls/);
});

test("a call that rewrites the cache mid-turn is counted, with the tool list when that was why", () => {
  const t = buildTrace([
    ev("turn.user", { text: "go" }),
    ev("usage.turn", { input_tokens: 9000, cached_tokens: 0, cache_write_tokens: 9000 }),
    ev("usage.turn", { input_tokens: 9500, cached_tokens: 9000, cache_write_tokens: 500 }),
    ev("usage.turn", { input_tokens: 9800, cached_tokens: 0, cache_write_tokens: 9800, tools_changed: true }),
    ev("usage.turn", { input_tokens: 9900, cached_tokens: 0, cache_write_tokens: 9900 }),
  ]);
  assert.equal(t.cacheMisses, 2);
  assert.equal(t.cacheMissesFromTools, 1);
  assert.match(traceText(t), /2 calls rewrote the cache mid-turn \(1 with a change in the tool list\)/);
});

console.log(`${passed} passed`);
