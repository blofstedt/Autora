/**
 * Replaying a recorded chat against the loop rules.
 *
 *   npx tsx tests/replay.test.ts
 */
import assert from "node:assert/strict";
import { replay, replayText } from "../server/replay";
import type { TraceEvent } from "../server/trace";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const ev = (kind: string, payload: Record<string, any> = {}, span: string | null = null): TraceEvent => ({ kind, payload, span });

/** A turn that runs the same failing command `n` times, one per round. */
function stuck(n: number): TraceEvent[] {
  const out: TraceEvent[] = [ev("turn.user", { text: "build it" })];
  for (let i = 0; i < n; i += 1) {
    out.push(ev("usage.turn", { input_tokens: 1000, cached_tokens: 900, cost_usd: 0.01 }));
    out.push(ev("tool.call", { name: "terminal", args: { command: "make" } }, `s${i}`));
    out.push(ev("tool.result", { ok: false, preview: "make: *** error 2" }, `s${i}`));
  }
  return out;
}

console.log("replay");

test("a chat that went round in circles is stopped, and the work after the stop is counted", () => {
  const r = replay(stuck(12));
  assert.ok(r.stop, "it would have been stopped");
  assert.equal(r.stop?.by, "loop watch");
  assert.ok(r.notes >= 1);
  assert.equal(r.calls + r.callsAfterStop, 12, "every call is either replayed or saved");
  assert.ok(r.callsAfterStop > 0);
  assert.match(replayText(r), /later calls in the log would not have run/);
});

test("looser settings stop later than tighter ones", () => {
  const tight = replay(stuck(12), { warnAt: 2, stopAt: 4 });
  const loose = replay(stuck(8), { warnAt: 5, stopAt: 20 });
  assert.ok(tight.stop && tight.stop.call < 12);
  assert.equal(loose.stop?.call ?? null, null);
  assert.match(replayText(loose), /Never stopped/);
});

test("moving work is never stopped, and the person's holds are not counted", () => {
  const log: TraceEvent[] = [ev("turn.user", { text: "go" })];
  for (let i = 0; i < 20; i += 1) {
    log.push(ev("tool.call", { name: "terminal", args: { command: `step ${i}` } }, `s${i}`));
    log.push(ev("tool.result", { ok: true, preview: `output ${i}` }, `s${i}`));
  }
  log.push(ev("tool.call", { name: "edit_file", args: {} }, "h"), ev("tool.error", { held: true, error: "x" }, "h"));
  const r = replay(log);
  assert.equal(r.stop, null);
  assert.equal(r.calls, 20);
  assert.equal(r.notes, 0);
});

console.log(`${passed} passed`);
