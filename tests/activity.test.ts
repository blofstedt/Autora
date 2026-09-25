/**
 * The line under the thread says what the agent is on, and the agent speaks
 * by playing words rather than by making a file.
 *
 *   npx tsx tests/activity.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { activity, brief } from "../src/lib/activity";
import type { AutoraEvent } from "../src/lib/types";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-activity-"));
// Nothing listens here, so the voice server is known to be absent at once.
process.env.AUTORA_KOKORO_URL = "http://127.0.0.1:9";
const { availableTools, capabilityBriefing, findTool, runTool } = await import("../server/tools");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

let seq = 0;
function ev(kind: string, payload: Record<string, any> = {}, span: string | null = null): AutoraEvent {
  seq += 1;
  return { seq, ts: 0, kind, actor: "agent", span, payload, blob: null };
}

console.log("what the agent is on");

await test("nothing is said when no turn is running", () => {
  assert.equal(activity([]), null);
  assert.equal(activity([ev("turn.user", { text: "hi" }), ev("turn.agent.done")]), null);
});

await test("before it has done anything, it names the request", () => {
  const log = [ev("turn.user", { text: "Find me a cheap flight to Lisbon next Friday please" })];
  assert.equal(activity(log), "Thinking about “Find me a cheap flight to…”");
  assert.equal(activity([ev("turn.user", { text: "Hello." })]), "Thinking about “Hello”");
});

await test("a step in progress is named, with what it is working on", () => {
  const log = [
    ev("turn.user", { text: "check the tests" }),
    ev("turn.agent.thinking", { text: "Analyzing" }),
    ev("tool.call", { name: "terminal", args: { command: "npm test" } }, "a"),
  ];
  assert.equal(activity(log), "Running npm test");
  const web = [ev("turn.user", { text: "x" }), ev("tool.call", { name: "web_search", args: { query: "kokoro tts voices" } }, "b")];
  assert.equal(activity(web), "Searching the web for “kokoro tts voices”");
  const page = [ev("turn.user", { text: "x" }), ev("tool.call", { name: "browser_open", args: { url: "https://www.example.com/a" } }, "c")];
  assert.equal(activity(page), "Opening example.com");
  const mcp = [ev("turn.user", { text: "x" }), ev("tool.call", { name: "mcp__github__list", args: {} }, "d")];
  assert.equal(activity(mcp), "Using github");
});

await test("between steps it says what it is thinking over, or that it hit a wall", () => {
  const ok = [
    ev("turn.user", { text: "x" }),
    ev("tool.call", { name: "terminal", args: { command: "ls" } }, "a"),
    ev("tool.result", { ok: true }, "a"),
  ];
  assert.equal(activity(ok), "Thinking over the command's output");
  const failed = [
    ev("turn.user", { text: "x" }),
    ev("tool.call", { name: "browser_click", args: {} }, "a"),
    ev("tool.error", { error: "no such element" }, "a"),
  ];
  assert.equal(activity(failed), "Rethinking after a page step failed");
});

await test("streaming words is writing, and an open question is waiting", () => {
  assert.equal(activity([ev("turn.user", { text: "x" }), ev("turn.agent.text", { text: "Sure" })]), "Writing the reply");
  const asked = [ev("turn.user", { text: "x" }), ev("ask.request", { id: "q" })];
  assert.equal(activity(asked), "Waiting for your answer");
  assert.equal(activity([...asked, ev("ask.answer", { id: "q" })]), "Thinking about “x”");
});

await test("brief keeps a few words and marks the cut", () => {
  assert.equal(brief("  one   two three ", 2), "one two…");
  assert.equal(brief("", 3), "");
});

console.log("speaking");

await test("speak is always offered, and the model is told not to make audio files", async () => {
  assert.ok((await availableTools()).some((t) => t.name === "speak"));
  const briefing = await capabilityBriefing();
  assert.match(briefing, /Tool: speak/);
  assert.match(briefing, /do not make an audio file/);
});

await test("speak plays the words on the page and hands back no file", async () => {
  const said: string[] = [];
  const ctx = { speak: (text: string) => said.push(text), session: "s1" } as any;
  const outcome = await runTool(findTool("speak")!, { text: "  Hello\n there. " }, ctx);
  assert.equal(outcome.ok, true, outcome.summary);
  assert.deepEqual(said, ["Hello there."]);
  assert.match(outcome.summary, /browser's own voice/);
  assert.match(outcome.summary, /do not also make or attach an audio file/);
});

await test("nothing to say, or far too much, is refused", async () => {
  const said: string[] = [];
  const ctx = { speak: (text: string) => said.push(text), session: "s1" } as any;
  const spec = findTool("speak")!;
  assert.equal((await runTool(spec, { text: "   " }, ctx)).ok, false);
  assert.equal((await runTool(spec, { text: "a ".repeat(1500) }, ctx)).ok, false);
  assert.equal(said.length, 0);
});

console.log(`${passed} passed`);
process.exit(0);
