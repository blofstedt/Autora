/**
 * The research worker's loop: a clean context, its own limits, and only a
 * report handed back. The model is a script.
 *
 *   npx tsx tests/subagent.test.ts
 */
import assert from "node:assert/strict";
import type { ChatMessage, ChatTurn } from "../server/llm";
import { runSubagent, WORKER_SYSTEM, type SubagentDeps } from "../server/subagent";
import type { ToolSpec } from "../server/tools";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const usage = { input: 1, output: 1, estimated: true };
const say = (text: string): ChatTurn => ({ usage, text, calls: [] });
const call = (name: string, args: Record<string, any>, id = `c${Math.random()}`): ChatTurn => ({ usage, text: "", calls: [{ id, name, args }] });

const search: ToolSpec = {
  name: "code_search", group: "terminal", description: "d",
  parameters: { type: "object", properties: { query: { type: "string" } }, required: ["query"] },
};
const tools = [search];

function deps(script: ChatTurn[], run: SubagentDeps["run"], extra: Partial<SubagentDeps> = {}) {
  const seen: { system: string; messages: ChatMessage[]; tools: string[] }[] = [];
  const d: SubagentDeps = {
    tools,
    cancelled: () => false,
    run,
    async ask(system, messages, offered) {
      seen.push({ system, messages: JSON.parse(JSON.stringify(messages)), tools: offered.map((t) => t.name) });
      // With no tools offered the worker can only answer: take the closing line.
      return (offered.length === 0 ? script.pop() : script.shift()) ?? say("nothing more");
    },
    ...extra,
  };
  return { d, seen };
}

console.log("research worker");

await test("it looks, then reports; only the report comes back", async () => {
  const { d, seen } = deps(
    [call("code_search", { query: "retry" }), say("Retries live in server/net.ts:40 (3 attempts, backoff).")],
    async () => ({ ok: true, summary: "server/net.ts:38-67  (score 9)\n  40: for (let attempt = 0; attempt < 3; attempt++)" }),
  );
  const r = await runSubagent("where is the retry logic?", d);
  assert.equal(r.ended, "answered");
  assert.equal(r.calls, 1);
  assert.match(r.report, /server\/net\.ts:40/);
  assert.equal(seen[0].system, WORKER_SYSTEM);
  assert.deepEqual(seen[0].messages.map((m) => m.role), ["user"], "it starts from the question alone");
  assert.equal(seen[1].messages.at(-1)!.role, "tool", "the second step has read the first's result");
});

await test("a call to a tool it was not given, or with bad arguments, is refused without running", async () => {
  let ran = 0;
  const { d, seen } = deps(
    [call("terminal", { command: "rm -rf /" }), call("code_search", {}), say("done")],
    async () => { ran += 1; return { ok: true, summary: "x" }; },
  );
  await runSubagent("q", d);
  assert.equal(ran, 0);
  const told = JSON.stringify(seen[1].messages) + JSON.stringify(seen[2].messages);
  assert.match(told, /There is no tool called \\"terminal\\" here/);
  assert.match(told, /missing required \\"query\\"/);
});

await test("a long tool output is cut before the worker reads it", async () => {
  const { d, seen } = deps(
    [call("code_search", { query: "x" }), say("ok")],
    async () => ({ ok: true, summary: "line\n".repeat(5000) }),
  );
  await runSubagent("q", d, { maxOutput: 500 });
  const reply = JSON.stringify(seen[1].messages.at(-1));
  assert.ok(reply.length < 1500, `reply was ${reply.length}`);
  assert.match(reply, /more characters were cut/);
});

await test("at the step limit it is asked once, with no tools, for what it has", async () => {
  const script: ChatTurn[] = [];
  for (let i = 0; i < 4; i += 1) script.push(call("code_search", { query: `q${i}` }));
  script.push(say("So far: found nothing conclusive."));
  const { d, seen } = deps(script, async () => ({ ok: true, summary: "ok" }));
  const r = await runSubagent("q", d, { maxSteps: 4 });
  assert.equal(r.ended, "step limit");
  assert.equal(r.report, "So far: found nothing conclusive.");
  assert.deepEqual(seen.at(-1)!.tools, [], "the last ask offers no tools");
  assert.match(JSON.stringify(seen.at(-1)!.messages.at(-1)), /Stop looking now/);
});

await test("going in circles ends it early, with a report", async () => {
  const script: ChatTurn[] = [];
  for (let i = 0; i < 20; i += 1) script.push(call("code_search", { query: "same" }));
  script.push(say("I kept getting the same result."));
  const { d } = deps(script, async () => ({ ok: true, summary: "same result" }));
  const r = await runSubagent("q", d, { maxSteps: 20 });
  assert.equal(r.ended, "loop");
  assert.ok(r.calls < 10, `${r.calls} calls`);
  assert.match(r.report, /same result/);
});

await test("stopping it ends it, and says so", async () => {
  let n = 0;
  const { d } = deps([call("code_search", { query: "a" }), call("code_search", { query: "b" })], async () => ({ ok: true, summary: "x" }), {
    cancelled: () => (n += 1) > 1,
  });
  const r = await runSubagent("q", d);
  assert.equal(r.ended, "stopped");
  assert.match(r.report, /stopped/);
});

await test("a report is capped, and an empty one is said", async () => {
  const { d } = deps([say("word ".repeat(2000))], async () => ({ ok: true, summary: "" }));
  assert.ok((await runSubagent("q", d, { maxReport: 300 })).report.length < 450);
  const empty = deps([say("   ")], async () => ({ ok: true, summary: "" }));
  assert.match((await runSubagent("q", empty.d)).report, /found nothing/);
});

console.log(`${passed} passed`);
