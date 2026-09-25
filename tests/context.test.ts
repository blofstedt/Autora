/**
 * Spending less per round: the turn's own context rides on the person's
 * message, old page snapshots shrink, and cached input is priced as cached.
 *
 *   npx tsx tests/context.test.ts
 */
import assert from "node:assert/strict";
import { ContextEngine, pageSnapshotAt } from "../server/context";
import { costOf } from "../server/providers";
import { compactJson, htmlToText, textParts } from "../server/pages";
import { outlineOf, type Ref } from "../server/browser";

/** The line the console puts above anything that came from outside itself:
    a page, a search, an uploaded file, a command's output. */
const OUTSIDE = /^\[Content from .*not from the person[^\]]*\]\n/;

/** The same text with that line taken off, for the tests about the text. */
const inside = (text: string) => text.replace(OUTSIDE, "");

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
  assert.match(inside(replies[0].result), /^\[Page snapshot of https:\/\/a removed.*vault_read with id "art_/);
  assert.match(inside(replies[1].result), /^Clicked \[1\]\.\n\n\[Page snapshot of https:\/\/b removed/);
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
  assert.match(inside(second), /^Clicked \[5\]\.\n\nPage: Shop\nURL: https:\/\/shop.test\/a\nChanges since page snapshot #1 above/);
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
  assert.match(again, /Interactive elements on screen: unchanged\./);
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
  assert.match(inside(d1.result), /^\[Page changes of https:\/\/shop.test\/a removed/);
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

test("scrolling lists what came on screen and names what left, by number", () => {
  const engine = new ContextEngine();
  engine.load([{ message: { role: "user", text: "go" }, seq: 1 }]);
  const top = nav.slice(0, 20);
  const lower = [...nav.slice(5, 20), `[31] button "Buy"`];
  const first = engine.ingest("browser_read", snap("https://shop.test/a", top, body), true);
  engine.append({ role: "tool", replies: [{ id: "1", name: "browser_read", ok: true, result: first }] }, 2);
  const scrolled = engine.ingest("browser_scroll", snap("https://shop.test/a", lower, body), true);
  assert.match(scrolled, /new or changed:\n\[31\] button "Buy"/);
  assert.match(scrolled, /No longer on screen, or gone: \[1\], \[2\], \[3\], \[4\], \[5\]\./);
});

test("a different part of the text is sent whole", () => {
  const engine = new ContextEngine();
  engine.load([{ message: { role: "user", text: "go" }, seq: 1 }]);
  const one = snap("https://shop.test/a", nav, body).replace("\n\nText:\n", "\n\nText (part 1 of 2; browser_read with part 2 for the next):\n");
  const two = snap("https://shop.test/a", nav, body).replace("\n\nText:\n", "\n\nText (part 2 of 2, the last):\n");
  const first = engine.ingest("browser_read", one, true);
  engine.append({ role: "tool", replies: [{ id: "1", name: "browser_read", ok: true, result: first }] }, 2);
  assert.match(engine.ingest("browser_read", two, true), /Snapshot: #2/);
});

console.log("reading pages");

const ref = (n: number, name: string, inView: boolean): Ref => ({
  ref: n, role: "link", name, value: null, x: 0, y: inView ? 100 : 2000, w: 10, h: 10,
  href: null, checked: null, disabled: false, inView,
});

test("the outline lists what is on screen and counts the rest", () => {
  const refs = [ref(0, "Top", false), ref(1, "Home", false), ref(2, "Read more", true), ref(3, "Next", true), ref(4, "Footer", false)];
  const outline = outlineOf(refs);
  assert.match(outline, /^\[2\] link "Read more"\n\[3\] link "Next"/);
  assert.ok(!outline.includes("Home"));
  assert.match(outline, /2 more above and 1 more below/);
});

test("long text comes in parts that break at lines, and nothing is lost", () => {
  const text = Array.from({ length: 400 }, (_, i) => `Line ${i} of the article.`).join("\n");
  const parts = textParts(text, 1000);
  assert.ok(parts.length > 5);
  assert.ok(parts.every((p) => p.length <= 1000));
  assert.ok(parts.every((p) => /^Line \d+/.test(p) && /article\.$/.test(p)));
  assert.equal(parts.join("\n"), text);
});

test("a web page's HTML becomes the article's text, links kept", () => {
  const html = `<!doctype html><html><head><title>x</title><style>body{color:red}</style>
    <script>var tracking = 1;</script></head><body>
    <nav><a href="/">Home</a> <a href="/about">About</a></nav>
    <main><h1>Hello &amp; welcome</h1><p>First paragraph with a <a href="/docs">link to docs</a>.</p>
    <ul><li>One</li><li>Two</li></ul>${"<p>More words in the article body.</p>".repeat(20)}
    <pre>  indented
    code</pre></main><footer>Copyright</footer></body></html>`;
  const text = htmlToText(html, "https://site.test/page");
  assert.match(text, /^# Hello & welcome/);
  assert.match(text, /link to docs \(https:\/\/site.test\/docs\)/);
  assert.match(text, /- One\n- Two/);
  assert.match(text, / {2}indented\n {4}code/);
  for (const gone of ["tracking", "color:red", "About", "Copyright"]) assert.ok(!text.includes(gone), gone);
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

console.log("untrusted content");

test("a result from outside says what it is, before anything it says", () => {
  const engine = new ContextEngine();
  assert.match(engine.ingest("browser_read", "Page: Shop", true), OUTSIDE);
  assert.match(engine.ingest("browser_open", "Page: Shop", true), /^\[Content from a web page/);
  assert.match(engine.ingest("http_request", "{}", true), /^\[Content from an external source/);
  assert.match(engine.ingest("web_search", "1. something", true), /^\[Content from search results/);
  assert.match(engine.ingest("terminal", "exit 0", true), /^\[Content from a command's output/);
  assert.match(engine.ingest("artifact_read", "notes", true), /^\[Content from an uploaded file/);
});

test("the console's own tools are not labelled", () => {
  const engine = new ContextEngine();
  for (const tool of ["memory_search", "memory_write", "vault_read", "artifact_save", "widget_show"]) {
    assert.equal(engine.ingest(tool, "something", true).startsWith("["), false, tool);
  }
});

test("the label survives the vault, where the point is the head and tail", () => {
  const engine = new ContextEngine();
  const big = engine.ingest("terminal", "x".repeat(400_000), true);
  assert.match(big, /^\[Content from a command's output/);
  assert.match(big, /more than fits in context/);
});

console.log(`\n${passed} passed`);
