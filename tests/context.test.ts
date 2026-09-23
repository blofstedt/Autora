/**
 * Spending less per round: the turn's own context rides on the person's
 * message, old page snapshots shrink, and cached input is priced as cached.
 *
 *   npx tsx tests/context.test.ts
 */
import assert from "node:assert/strict";
import { ContextEngine, pageSnapshotAt } from "../server/context";
import { costOf } from "../server/providers";
import { compactJson } from "../server/pages";

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


console.log("page changes");

const snap = (url: string, elements: string[], text: string[]) =>
  `Page: Shop\nURL: ${url}\n\nInteractive elements:\n${elements.join("\n")}\n\nText:\n${text.join("\n")}`;
const nav = Array.from({ length: 30 }, (_, i) => `[${i + 1}] link "Menu item ${i + 1}" -> /m${i}`);
const body = Array.from({ length: 40 }, (_, i) => `Paragraph ${i} of the product page, with enough words to matter.`);

test("a click that changes little comes back as the change", () => {
  const engine = new ContextEngine();
  engine.load([{ message: { role: "user", text: "go" }, seq: 1 }]);
  const first = engine.ingest("browser_open", snap("https://shop.test/a", nav, body), true);
  assert.match(first, /\nSnapshot: #1\n/);
  engine.append({ role: "tool", replies: [{ id: "1", name: "browser_open", ok: true, result: first }] }, 2);

  const after = [...nav];
  after[4] = `[5] button "Added to cart"`;
  const second = engine.ingest("browser_click",
    `Clicked [5].\n\n${snap("https://shop.test/a", after, [...body, "Cart: 1 item"])}`, true);
  assert.match(second, /^Clicked \[5\]\.\n\nPage: Shop\nURL: https:\/\/shop.test\/a\nChanges since page snapshot #1 above/);
  assert.match(second, /\[5\] button "Added to cart"/);
  assert.match(second, /\+ Cart: 1 item/);
  assert.ok(!second.includes("Menu item 1\""), "unchanged elements are left out");
  assert.ok(second.length < first.length / 3);
});

test("a click that changes nothing says so", () => {
  const engine = new ContextEngine();
  engine.load([{ message: { role: "user", text: "go" }, seq: 1 }]);
  const first = engine.ingest("browser_read", snap("https://shop.test/a", nav, body), true);
  engine.append({ role: "tool", replies: [{ id: "1", name: "browser_read", ok: true, result: first }] }, 2);
  const again = engine.ingest("browser_click", snap("https://shop.test/a", nav, body), true);
  assert.match(again, /Interactive elements: unchanged\./);
  assert.match(again, /Text: unchanged\./);
});

test("another site, or a big change, gets the whole page", () => {
  const engine = new ContextEngine();
  engine.load([{ message: { role: "user", text: "go" }, seq: 1 }]);
  const first = engine.ingest("browser_open", snap("https://shop.test/a", nav, body), true);
  engine.append({ role: "tool", replies: [{ id: "1", name: "browser_open", ok: true, result: first }] }, 2);
  assert.match(engine.ingest("browser_open", snap("https://other.test/", nav, body), true), /Snapshot: #2/);
  const other = body.map((l) => `${l} changed`);
  assert.match(engine.ingest("browser_open", snap("https://shop.test/b", nav.slice(3), other), true), /Snapshot: #3/);
});

test("the base a difference points at is kept when older pages are shrunk", () => {
  const engine = new ContextEngine();
  engine.load([{ message: { role: "user", text: "go" }, seq: 1 }]);
  const base = { id: "1", name: "browser_open", ok: true, result: engine.ingest("browser_open", snap("https://shop.test/a", nav, body), true) };
  engine.append({ role: "tool", replies: [base] }, 2);
  const d1 = { id: "2", name: "browser_click", ok: true, result: engine.ingest("browser_click", snap("https://shop.test/a", nav, [...body, "one"]), true) };
  engine.append({ role: "tool", replies: [d1] }, 3);
  engine.supersedePages(true);
  const d2 = { id: "3", name: "browser_click", ok: true, result: engine.ingest("browser_click", snap("https://shop.test/a", nav, [...body, "two"]), true) };
  engine.append({ role: "tool", replies: [d2] }, 4);
  engine.supersedePages(true);
  assert.match(base.result, /Snapshot: #1/, "the base stays whole");
  assert.match(d1.result, /^\[Page changes of https:\/\/shop.test\/a removed/);
  assert.match(d2.result, /Changes since page snapshot #1/);
  assert.match(d2.result, /\+ two/);
});

test("once the base is gone, the next read is whole again", () => {
  const engine = new ContextEngine();
  engine.load([{ message: { role: "user", text: "go" }, seq: 1 }]);
  engine.ingest("browser_open", snap("https://shop.test/a", nav, body), true);
  // Never appended: as if compaction had folded it away.
  engine.append({ role: "tool", replies: [] }, 2);
  assert.match(engine.ingest("browser_read", snap("https://shop.test/a", nav, body), true), /Snapshot: #2/);
});

console.log("json");

test("pretty JSON loses its whitespace and nothing else", () => {
  const value = { name: "a  b", list: [1, 2, 3], nested: { quote: "say \"hi\"\n", big: "12345678901234567890" } };
  const pretty = JSON.stringify(value, null, 2) + "\n".repeat(1) + " ".repeat(0);
  const padded = pretty.length < 200 ? JSON.stringify({ ...value, pad: "x".repeat(200) }, null, 2) : pretty;
  const compact = compactJson(padded);
  assert.ok(compact.length < padded.length);
  assert.deepEqual(JSON.parse(compact), JSON.parse(padded));
  assert.ok(compact.includes('"a  b"'), "spaces inside strings are kept");
});

test("anything that is not JSON is left alone", () => {
  const text = "{ not json\n  at all " + "x".repeat(300);
  assert.equal(compactJson(text), text);
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
