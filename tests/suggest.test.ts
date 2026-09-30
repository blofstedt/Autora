/**
 * Suggestions come from what is here, or not at all: starters for an empty
 * chat, offers asked once, and next steps after a turn.
 *
 *   npx tsx tests/suggest.test.ts
 */
import assert from "node:assert/strict";
import {
  DISCOVER, nextSteps, offers, outsideQuiet, starters,
  type KnownThing, type Signals,
} from "../server/suggest";
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

const GB = 1024 ** 3;
const bare = (): Signals => ({
  disk: { used: 20 * GB, total: 100 * GB },
  containers: null,
  signIns: [],
  memories: [],
  jobs: [],
  tools: { terminal: true, browser: true, customTools: true },
});
const memory = (over: Partial<KnownThing>): KnownThing => ({
  id: "mem-1", kind: "fact", title: "t", body: "b", tags: [], status: "confirmed",
  worked: 0, uses: 0, last_used: null, ...over,
});
const noQuiet = { quiet: false, from: 0, to: 0 };

console.log("suggestions");

test("nothing known, nothing suggested: the chat falls back to its examples", () => {
  assert.deepEqual(starters(bare()), []);
  assert.deepEqual(offers(bare(), {}, noQuiet), []);
  assert.match(DISCOVER.prompt, /Do not start any of them yet/);
});

test("trouble comes first: a full disk, an app restarting, a failed schedule", () => {
  const s = bare();
  s.disk = { used: 92 * GB, total: 100 * GB };
  s.containers = [
    { name: "jellyfin", state: "restarting", status: "Restarting (1) 5 seconds ago" },
    { name: "nextcloud", state: "running", status: "Up 2 hours (unhealthy)" },
    { name: "pihole", state: "running", status: "Up 3 days (healthy)" },
  ];
  s.jobs = [{ id: "j1", name: "Backup", prompt: "run the backup", cron: "0 3 * * *", enabled: true, last_error: "exit 1: no space", failed: true }];
  s.signIns = ["github.com"];
  const out = starters(s);
  assert.equal(out.length, 4);
  assert.deepEqual(out.map((x) => x.key), ["disk", "container:jellyfin", "container:nextcloud", "job:j1"]);
  assert.match(out[0].title, /92% full/);
  assert.match(out[0].prompt, /Delete nothing/);
});

test("what they follow, what worked before, and where the browser is signed in", () => {
  const s = bare();
  s.memories = [
    memory({ id: "m1", tags: ["stocks"], title: "Holdings", body: "40 shares of ASML" }),
    memory({ id: "m2", kind: "procedure", title: "Restart the media server", worked: 2, last_used: 100 }),
    memory({ id: "m3", kind: "procedure", title: "Unproven guess", status: "provisional", worked: 5 }),
  ];
  s.signIns = ["google.com", "example.org", "github.com"];
  const keys = starters(s).map((x) => x.key);
  assert.deepEqual(keys, ["markets", "again:m2", "site:gmail", "site:github"]);
  assert.ok(!keys.includes("again:m3"), "an unconfirmed procedure is not offered as something that works");
});

test("a tool group that is off suggests nothing that needs it", () => {
  const s = bare();
  s.signIns = ["github.com"];
  s.disk = { used: 95 * GB, total: 100 * GB };
  s.tools = { terminal: false, browser: false, customTools: false };
  assert.deepEqual(starters(s), []);
});

test("an offer is made from what is known, asked once, and never for what is covered", () => {
  const s = bare();
  s.memories = [memory({ tags: ["watchlist"], body: "NVDA, ASML" })];
  s.signIns = ["google.com"];
  const first = offers(s, {}, noQuiet);
  assert.deepEqual(first.map((o) => o.key), ["offer:markets", "offer:email"]);
  assert.equal(first[0].job.cron, "45 7 * * 1-5");
  assert.match(first[0].job.prompt, /Buy nothing/);
  // Answered, either way, it does not come back.
  assert.deepEqual(offers(s, { "offer:markets": "no" }, noQuiet).map((o) => o.key), ["offer:email"]);
  // A job of theirs already covers email.
  s.jobs = [{ id: "j", name: "Inbox digest", prompt: "summarize my email", cron: "0 8 * * *", enabled: true, last_error: null, failed: false }];
  assert.deepEqual(offers(s, {}, noQuiet).map((o) => o.key), ["offer:markets"]);
});

test("an offer's time steps out of the quiet hours", () => {
  const quiet = { quiet: true, from: 23 * 60, to: 8 * 60 };
  assert.equal(outsideQuiet(7 * 60 + 45, quiet), 8 * 60 + 15);
  assert.equal(outsideQuiet(9 * 60, quiet), 9 * 60);
  const s = bare();
  s.memories = [memory({ tags: ["portfolio"] })];
  const [o] = offers(s, {}, quiet);
  assert.equal(o.job.cron, "15 8 * * 1-5");
  assert.match(o.text, /08:15/);
});

test("after a turn: watch the page it read, do it every morning, keep it as a tool", () => {
  const read = nextSteps({
    request: "what is the price of ASML today",
    calls: [{ name: "browser_open", args: { url: "https://www.google.com/finance/quote/ASML:NASDAQ" }, ok: true }],
    customTools: true,
  });
  assert.equal(read[0].label, "Tell me when this page changes");
  assert.match(read[0].prompt, /Watch https:\/\/www\.google\.com\/finance/);

  const checked = nextSteps({
    request: "check the disk usage",
    calls: [1, 2, 3].map(() => ({ name: "terminal", args: { command: "df -h" }, ok: true })),
    customTools: true,
  }, [{ label: "Clear the apt cache", prompt: "Clear the apt cache and tell me how much it freed." }]);
  assert.deepEqual(checked.map((x) => x.label), ["Do this every morning", "Clear the apt cache", "Save this as a tool"]);
});

test("no next steps that make no sense", () => {
  // Already scheduled: neither watch nor every morning.
  assert.deepEqual(nextSteps({
    request: "check example.com every hour",
    calls: [{ name: "http_request", args: { url: "https://example.com" }, ok: true }, { name: "schedule", args: {}, ok: true }],
    customTools: false,
  }), []);
  // This machine's own pages are not worth watching; a question is not worth repeating.
  assert.deepEqual(nextSteps({
    request: "explain this error",
    calls: [{ name: "browser_open", args: { url: "http://localhost:3000" }, ok: true }],
    customTools: false,
  }), []);
  // At most three, however many the look back thought of.
  assert.equal(nextSteps({ request: "hi", calls: [], customTools: false }, [
    { label: "a", prompt: "a" }, { label: "b", prompt: "b" }, { label: "c", prompt: "c" },
  ]).length, 2);
});

test("the thread shows the newest next steps under the turn they belong to", () => {
  let seq = 0;
  const ev = (kind: string, payload: Record<string, any> = {}): AutoraEvent =>
    ({ seq: ++seq, ts: seq, kind, actor: "agent", span: null, payload, blob: null });
  const first = [{ label: "Do this every morning", prompt: "every morning" }];
  const later = [...first, { label: "Compare with last week", prompt: "compare" }];
  const events = [
    ev(Kind.UserMessage, { text: "check the disk" }),
    ev(Kind.AgentText, { text: "It is 88% full." }),
    ev(Kind.AgentDone),
    ev(Kind.SuggestNext, { steps: first }),
    ev(Kind.SuggestNext, { steps: [...later, { label: 3 }] }),
  ];
  assert.deepEqual(derive(events).buckets[0].next, later, "the newest set wins, and a malformed step is dropped");
  const after = derive([...events, ev(Kind.UserMessage, { text: "thanks" })]).buckets;
  assert.equal(after[1].next, undefined, "a new message starts without any");
});

console.log(`${passed} passed`);
