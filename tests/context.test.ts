/**
 * Spending less per round: the turn's own context rides on the person's
 * message, old page snapshots shrink, and cached input is priced as cached.
 *
 *   npx tsx tests/context.test.ts
 */
import assert from "node:assert/strict";
import { ContextEngine, pageSnapshotAt } from "../server/context";
import { costOf } from "../server/providers";

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

const page = (url: string) =>
  `Page: Title\nURL: ${url}\n\nInteractive elements:\n[1] button Go\n\nText:\n${"words ".repeat(200)}`;

console.log("context");

test("the turn note goes on the latest user message, not the first", () => {
  const engine = new ContextEngine();
  engine.load([
    { message: { role: "user", text: "first" }, seq: 1 },
    { message: { role: "assistant", text: "ok" }, seq: 2 },
    { message: { role: "user", text: "second" }, seq: 3 },
  ]);
  engine.setTurnNote("[note]");
  const out = engine.messagesFor("system");
  assert.equal(out[0].text, "first");
  assert.equal(out[2].text, "second\n\n[note]");
});

test("the note does not change between rounds", () => {
  const engine = new ContextEngine();
  engine.load([{ message: { role: "user", text: "go" }, seq: 1 }]);
  engine.setTurnNote("[note]");
  const before = JSON.stringify(engine.messagesFor("s")[0]);
  engine.append({ role: "assistant", calls: [{ id: "a", name: "terminal", args: {} }] }, 2);
  engine.append({ role: "tool", replies: [{ id: "a", name: "terminal", ok: true, result: "done" }] }, 3);
  assert.equal(JSON.stringify(engine.messagesFor("s")[0]), before);
});

test("a page snapshot is found after the words that precede it", () => {
  assert.equal(pageSnapshotAt(page("https://a")), 0);
  assert.equal(pageSnapshotAt(`Clicked [4].\n\n${page("https://a")}`), "Clicked [4].\n\n".length);
  assert.equal(pageSnapshotAt("exit 0"), -1);
});

test("every page snapshot but the newest is shrunk to a line", () => {
  const engine = new ContextEngine();
  const replies = [
    { id: "1", name: "browser_open", ok: true, result: page("https://a") },
    { id: "2", name: "browser_click", ok: true, result: `Clicked [1].\n\n${page("https://b")}` },
    { id: "3", name: "browser_read", ok: true, result: page("https://c") },
  ];
  engine.load([{ message: { role: "user", text: "go" }, seq: 1 }]);
  engine.append({ role: "tool", replies: [replies[0]] }, 2);
  engine.append({ role: "tool", replies: [replies[1], replies[2]] }, 3);
  engine.supersedePages(true);
  assert.match(replies[0].result, /^\[Page snapshot of https:\/\/a removed.*vault_read with id "art_/);
  assert.match(replies[1].result, /^Clicked \[1\]\.\n\n\[Page snapshot of https:\/\/b removed/);
  assert.equal(replies[2].result, page("https://c"));
  // Running it again leaves the stubs alone.
  const stub = replies[0].result;
  engine.supersedePages(true);
  assert.equal(replies[0].result, stub);
});

console.log("prices");

// A weekday peak hour, so DeepSeek's off-peak half price does not apply.
const peak = new Date("2026-09-23T02:00:00Z");

test("DeepSeek cached input is priced at the cache-hit rate", () => {
  const full = costOf("deepseek", "deepseek-flash", 1_000_000, 0, peak);
  const cached = costOf("deepseek", "deepseek-flash", 1_000_000, 0, peak, { read: 1_000_000 });
  assert.equal(full.toFixed(3), "0.300");
  assert.equal(cached.toFixed(3), "0.006");
});

test("Anthropic reads cost a tenth and writes a quarter more", () => {
  const read = costOf("anthropic", "claude-haiku-4-5", 1_000_000, 0, peak, { read: 1_000_000 });
  const write = costOf("anthropic", "claude-haiku-4-5", 1_000_000, 0, peak, { write: 1_000_000 });
  assert.equal(read.toFixed(2), "0.10");
  assert.equal(write.toFixed(2), "1.25");
});

test("a model with no cached price charges cached tokens as ordinary input", () => {
  const plain = costOf("openai", "gpt-4o-mini", 1_000_000, 0, peak);
  const cached = costOf("openai", "gpt-4o-mini", 1_000_000, 0, peak, { read: 500_000 });
  assert.equal(cached, plain);
});

console.log(`\n${passed} passed`);
