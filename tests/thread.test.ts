/**
 * Keeping a long thread fast: unchanged cards keep their identity from one
 * update to the next, and nothing about what is shown changes because of it.
 *
 * The thread memoises every card on the object it is given (Thread.tsx), so
 * `share` handing back the previous object for an unchanged card is what
 * stops a streamed word from redrawing the whole conversation. The property
 * that matters most is the other one: whatever `share` returns must be equal,
 * field for field, to a fresh `derive` -- it may only reuse, never alter.
 *
 *   npx tsx tests/thread.test.ts
 */
import assert from "node:assert/strict";
import { derive } from "../src/lib/derive";
import { share } from "../src/lib/share";
import { mergeEvents } from "../src/lib/stream";
import { Kind, type AutoraEvent } from "../src/lib/types";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

/** A few turns of work, the way the server writes them, streamed word by word. */
function conversation(turns: number): AutoraEvent[] {
  const events: AutoraEvent[] = [];
  let seq = 0;
  const add = (kind: string, payload: Record<string, any>, span: string | null = null) => {
    seq += 1;
    events.push({ seq, ts: 1_700_000_000 + seq, kind, actor: "agent", span, payload, blob: null });
  };
  add(Kind.SessionStarted, { title: "Long one" });
  for (let t = 1; t <= turns; t++) {
    add(Kind.UserMessage, { text: `Check build ${t}` });
    add(Kind.MemoryRecall, { ids: [`mem-${t}`], titles: [`Build notes ${t}`], kinds: ["fact"] });
    for (const word of ["Looking ", "at ", `build ${t} `, "now."]) add(Kind.AgentText, { text: word });
    const span = `span-${t}`;
    add(Kind.ToolCall, { name: "terminal", args: { command: `make build-${t}` } }, span);
    add(Kind.PtyOutput, { data: "compiling\n" }, span);
    add(Kind.PtyOutput, { data: `done ${t}\n` }, span);
    add(Kind.PtyExit, { exit_code: 0, duration_ms: 900 }, span);
    add(Kind.ToolResult, { ok: true, preview: "done", duration_ms: 900, display: { exit_code: 0 } }, span);
    add(Kind.PermissionRequest, { request_id: `req-${t}`, tool: "terminal", rendered: "rm build", reason: "cleanup" });
    add(Kind.PolicyDecision, { request_id: `req-${t}`, decision: t % 2 ? "allow" : "deny", approved: t % 2 === 1 });
    for (const word of ["It ", "built ", "fine."]) add(Kind.AgentText, { text: word });
    add(Kind.AgentDone, {});
  }
  return events;
}

console.log("thread");

test("sharing never changes what is shown: every prefix equals a fresh derive", () => {
  const events = conversation(6);
  let shown = share(null, derive([]));
  for (let k = 1; k <= events.length; k++) {
    const fresh = derive(events.slice(0, k));
    shown = share(shown, derive(events.slice(0, k)));
    assert.deepEqual(shown, fresh, `after ${k} events`);
  }
});

test("finished turns and unchanged cards keep their identity while a reply streams", () => {
  const events = conversation(5);
  const before = share(null, derive(events));
  let seq = events[events.length - 1].seq;
  const next = [
    ...events,
    { seq: ++seq, ts: 0, kind: Kind.UserMessage, actor: "user", span: null, payload: { text: "And now?" }, blob: null },
    { seq: ++seq, ts: 0, kind: Kind.AgentText, actor: "agent", span: null, payload: { text: "Checking" }, blob: null },
  ];
  const middle = share(before, derive(next));
  const after = share(middle, derive([
    ...next,
    { seq: ++seq, ts: 0, kind: Kind.AgentText, actor: "agent", span: null, payload: { text: " again." }, blob: null },
  ]));

  // Every earlier turn is the very same object, so its cards are skipped.
  for (let i = 0; i < before.buckets.length; i++) assert.equal(after.buckets[i], before.buckets[i], `turn ${i}`);
  // The streaming turn changed, and only its growing reply within it.
  const tailBefore = middle.buckets[middle.buckets.length - 1];
  const tailAfter = after.buckets[after.buckets.length - 1];
  assert.notEqual(tailAfter, tailBefore);
  assert.equal(tailAfter.cells.at(-1)?.kind, "reply");
  assert.notEqual(tailAfter.cells.at(-1), tailBefore.cells.at(-1));
  // Lists nothing touched keep their identity too, for the effects keyed on them.
  assert.equal(after.memories, middle.memories);
  assert.equal(after.approvals, middle.approvals);
});

test("an update that changes nothing hands back the same thread", () => {
  const events = conversation(3);
  const first = share(null, derive(events));
  const again = share(first, derive(events));
  assert.equal(again.buckets, first.buckets);
  assert.equal(again.transcript, first.transcript);
});

test("sharing follows removals and odd values faithfully", () => {
  const prev = { a: [1, 2, 3], b: { c: 1, d: 2 }, when: new Date(0), m: new Map([["k", 1]]), n: NaN };
  const next = { a: [1, 2], b: { c: 1 }, when: new Date(0), m: new Map([["k", 1]]), n: NaN };
  const out = share(prev, next);
  assert.deepEqual(out, next);
  assert.equal(out.n, prev.n);
  // Class instances are never reused on content alone.
  assert.equal(out.when, next.when);
  assert.equal(out.m, next.m);
  // A shorter array whose items all match is the front of the old one.
  assert.deepEqual(out.a, [1, 2]);
  const item = { x: 1 };
  assert.equal(share([item], [{ x: 1 }])[0], item);
  assert.equal(share({ keep: item, drop: 1 }, { keep: { x: 1 } }).keep, item);
});

test("events are merged in seq order, sorting only when they arrived out of it", () => {
  const e = (seq: number): AutoraEvent => ({ seq, ts: 0, kind: Kind.AgentText, actor: "agent", span: null, payload: {}, blob: null });
  const prev = [e(1), e(2)];
  assert.equal(mergeEvents(prev, []), prev);
  assert.deepEqual(mergeEvents(prev, [e(3), e(4)]).map((x) => x.seq), [1, 2, 3, 4]);
  assert.deepEqual(mergeEvents(prev, [e(5), e(3)]).map((x) => x.seq), [1, 2, 3, 5]);
  assert.deepEqual(mergeEvents([e(4)], [e(2)]).map((x) => x.seq), [2, 4]);
  assert.deepEqual(prev.map((x) => x.seq), [1, 2], "the previous list is left alone");
});

console.log(`${passed} passed`);
