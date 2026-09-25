/**
 * Folding an event log back into a thread.
 *
 * This is the one fold that matters twice: `derive()` is what the app draws
 * as events stream in, and what it re-draws from the log after a restart. If
 * the two disagree, a session looks different depending on whether you were
 * watching -- which is exactly the bug nobody sees until it confuses them.
 * Nothing tested it, so here is a log with one of everything in it, and the
 * shape it has to fold into.
 *
 *   npx tsx tests/derive.test.ts
 */
import assert from "node:assert/strict";
import { derive } from "../src/lib/derive";
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

/** A log built the way the server writes one: seq in order, one span per call. */
function log(): AutoraEvent[] {
  const events: AutoraEvent[] = [];
  let seq = 0;
  const add = (kind: string, actor: string, payload: Record<string, any>, span: string | null = null) => {
    seq += 1;
    events.push({ seq, ts: 1_700_000_000 + seq, kind, actor, span, payload, blob: null });
  };

  add(Kind.SessionStarted, "system", { title: "Fix the tests" });
  add(Kind.UserMessage, "user", { text: "Run the test suite and tell me what broke." });
  add(Kind.AgentText, "agent", { text: "Running it now." });
  add(Kind.ToolCall, "agent", { name: "terminal", args: { command: "npm test" } }, "span-1");
  add(Kind.PtyOutput, "agent", { data: "3 passing\n" }, "span-1");
  add(Kind.PtyOutput, "agent", { data: "1 failing\n" }, "span-1");
  add(Kind.PtyExit, "agent", { exit_code: 1, duration_ms: 1200 }, "span-1");
  add(Kind.ToolResult, "agent", { ok: false, preview: "1 failing", duration_ms: 1200 }, "span-1");
  add(Kind.PermissionRequest, "agent", {
    request_id: "req-1", tool: "terminal", rendered: "rm -rf /", reason: "irreversible",
  }, "span-2");
  add(Kind.PolicyDecision, "user", { request_id: "req-1", decision: "allow", approved: true });
  add(Kind.ToolCall, "agent", { name: "terminal", args: { command: "rm -rf /" } }, "span-2");
  add(Kind.FileEdit, "agent", { path: "server/store.ts", diff: "+ one line", added: 1, removed: 0 }, "span-2");
  add(Kind.AgentText, "agent", { text: "The suite fails in one place." });
  add(Kind.AgentDone, "agent", {});
  return events;
}

console.log("derive");

test("the words land in the transcript, in order, and only once", () => {
  const view = derive(log());
  assert.deepEqual(
    view.transcript.map((t) => t.role),
    ["user", "agent", "agent"],
  );
  assert.equal(view.transcript[0].text, "Run the test suite and tell me what broke.");
  assert.equal(view.transcript[1].text, "Running it now.");
  assert.equal(view.transcript[2].text, "The suite fails in one place.");
});

test("a tool call with its output and its exit code is one span", () => {
  const view = derive(log());
  const span = view.spansById.get("span-1");
  assert.ok(span, "the call's span is in the view");
  assert.equal(span.name, "terminal");
  assert.deepEqual(span.args, { command: "npm test" });
  assert.equal(span.status, "error");
  assert.equal(span.exitCode, 1);
  assert.equal(span.durationMs, 1200);
});

test("the terminal card holds what the command printed", () => {
  const view = derive(log());
  const cells = view.buckets.flatMap((b) => b.cells);
  const terminal = cells.find((c) => c.kind === "terminal");
  assert.ok(terminal, "a terminal cell was opened by the call");
  assert.equal(terminal.kind === "terminal" && terminal.output, "3 passing\n1 failing\n");
  assert.equal(terminal.kind === "terminal" && terminal.exitCode, 1);
});

test("an approval is pending until the answer is in the same log", () => {
  const settled = derive(log());
  const approval = settled.approvals.find((a) => a.requestId === "req-1");
  assert.ok(approval, "the request made an approval");
  assert.equal(approval.tool, "terminal");
  assert.equal(approval.settled, true);
  assert.equal(approval.approved, true);

  // The same log without the answer: the card must come back as still waiting.
  const waiting = derive(log().filter((e) => e.kind !== Kind.PolicyDecision));
  assert.equal(waiting.approvals[0].settled, false);
});

test("a file change is kept with its counts, for the diff card", () => {
  const view = derive(log());
  assert.equal(view.files.length, 1);
  assert.equal(view.files[0].path, "server/store.ts");
  assert.equal(view.files[0].added, 1);
});

test("the title comes from the session, not from the first thing said", () => {
  const view = derive(log());
  assert.equal(view.title, "Fix the tests");
});

test("nothing is running when the log says the turn ended", () => {
  const view = derive(log());
  assert.equal(view.busy, false);
});

console.log(`\nderive: ${passed} passed`);
