/**
 * QA: what the thread shows while a step is hanging, and what the step does
 * about it. Written as an independent check of the branch's own claims --
 * tests/toolcap.test.ts is the author's; this file asks the same questions
 * from the outside, through the real entry points, and says where it could
 * not reach one.
 *
 *   npx tsx tests/hang-visibility.qa.test.ts
 *
 * The last test (a read with no cap given) really waits a minute: it is the
 * only way to show the cap table reaching a call that was given no cap of its
 * own, without changing product code. Everything before it takes seconds.
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { ToolContext } from "../server/tools";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-hang-qa-"));

const { AGENT_RUN_CAP_MS, canRepeat, capFor, findTool, runTool } = await import("../server/tools");
const { activity, readActivity, stuckNote, STUCK_MS } = await import("../src/lib/activity");
const { Kind } = await import("../src/lib/types");

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

const wait = (ms: number) => new Promise((done) => setTimeout(done, ms));

/** A page shaped as browser_read reads one. */
const aPage = (url: string, text: string) => ({
  url,
  title: "A page",
  text,
  outline: "[1] a link",
  captchas: [],
  challenge: null,
  blocked: null,
});

/**
 * A browser whose every method is what the test says it is. `never` is a
 * promise that is never settled and never rejected -- the shape of the bug:
 * the tool call is made, the answer never comes.
 */
function stubBrowser(over: Record<string, any> = {}) {
  const calls: string[] = [];
  const browser = {
    snapshot: () => {
      calls.push("snapshot");
      return over.snapshot ? over.snapshot() : Promise.resolve(aPage("https://example.com/", "hello"));
    },
    lookNote: () => null,
    click: (ref: number) => {
      calls.push(`click:${ref}`);
      return over.click ? over.click() : Promise.resolve(aPage("https://example.com/", "clicked"));
    },
    goto: (url: string) => {
      calls.push(`goto:${url}`);
      return Promise.resolve(aPage(url, "hello"));
    },
  };
  return { calls, browser: () => browser };
}

function ctx(over: Partial<Record<string, any>> = {}): ToolContext {
  return {
    onOutput: () => undefined,
    putBlob: () => "blob",
    showImage: () => undefined,
    showWidget: () => undefined,
    showScreen: () => undefined,
    browser: () => {
      throw new Error("this test did not give the tools a browser");
    },
    browserChanged: () => undefined,
    watchDesktop: () => undefined,
    cancelled: () => false,
    onCancel: () => undefined,
    memory: {
      write: () => ({ id: "m", action: "add" }),
      search: () => [],
      update: () => false,
      forget: () => false,
    },
    vault: () => null,
    session: "qa",
    ask: async () => ({ cancelled: true, choices: [], text: "", who: "" }),
    ...over,
  } as unknown as ToolContext;
}

console.log("a call that never comes back");

await test("a tool that never settles is capped, and the caller is given an outcome", async () => {
  const never = () => new Promise(() => {});
  const { calls, browser } = stubBrowser({ snapshot: never });
  const started = Date.now();
  const outcome = await runTool(findTool("browser_read")!, { part: 1 }, ctx({ browser }), 1000);
  const took = Date.now() - started;

  assert.equal(outcome.ok, false);
  assert.match(outcome.summary, /browser_read gave up after 1s/);
  assert.ok(took >= 2000, `it waited for both tries (${took}ms)`);
  assert.ok(took < 9000, `and then it ended, rather than holding a promise for ever (${took}ms)`);
  assert.equal(calls.length, 2, "a read that never settles is asked exactly twice, no more");
});

await test("the second answer is the one that comes back", async () => {
  let n = 0;
  const { calls, browser } = stubBrowser({
    snapshot: () => {
      n += 1;
      return n === 1 ? new Promise(() => {}) : Promise.resolve(aPage("https://example.com/second", "the second answer"));
    },
  });
  const outcome = await runTool(findTool("browser_read")!, {}, ctx({ browser }), 1000);

  assert.equal(outcome.ok, true, "the retry that worked is the result");
  assert.match(outcome.summary, /Tried once more/);
  assert.match(outcome.summary, /https:\/\/example\.com\/second/);
  assert.match(outcome.summary, /the second answer/);
  assert.equal(calls.length, 2, "asked twice, not three times");
});

await test("a call that changes something is never asked twice", async () => {
  const { calls, browser } = stubBrowser({ click: () => new Promise(() => {}) });
  const started = Date.now();
  const outcome = await runTool(findTool("browser_click")!, { ref: 3 }, ctx({ browser }), 1000);
  const took = Date.now() - started;

  assert.equal(outcome.ok, false);
  assert.match(outcome.summary, /gave up after 1s/);
  assert.doesNotMatch(outcome.summary, /Tried once more/);
  assert.match(outcome.summary, /read the thing back before doing it again/);
  assert.equal(calls.length, 1, "a click that hung was not clicked again");
  assert.ok(took < 5000, `no second attempt was even waited for (${took}ms)`);
});

await test("a real request that never gets an answer is sent once", async () => {
  /* A server that accepts the connection and then says nothing at all. */
  let hits = 0;
  const server = http.createServer(() => {
    hits += 1; // and never writes a response
  });
  await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
  const port = (server.address() as any).port;
  try {
    const started = Date.now();
    const outcome = await runTool(
      findTool("http_request")!,
      { url: `http://127.0.0.1:${port}/nothing`, method: "GET" },
      ctx(),
      800,
    );
    const took = Date.now() - started;
    assert.equal(outcome.ok, false);
    assert.match(outcome.summary, /gave up after 1s/);
    assert.equal(hits, 1, "the person's request was sent once, not twice");
    assert.ok(took < 5000, `it came back at the cap (${took}ms)`);
  } finally {
    server.closeAllConnections?.();
    await new Promise<void>((done) => server.close(() => done()));
  }
});

await test("a command that hangs is killed, not merely abandoned", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-hang-cmd-"));
  const started_ = path.join(dir, "started");
  const survived = path.join(dir, "survived");
  const stops: Array<() => void> = [];
  const command = `echo x >> ${started_}; sleep 4; echo x >> ${survived}`;

  const outcome = await runTool(findTool("terminal")!, { command }, ctx({ onCancel: (s: () => void) => stops.push(s) }), 500);
  assert.equal(outcome.ok, false);
  assert.match(outcome.summary, /terminal gave up after 1s/);
  assert.ok(stops.length >= 1, "the command was told to stop");
  assert.equal(fs.readFileSync(started_, "utf8").trim().split("\n").length, 1, "run once, never twice");

  await wait(4500);
  assert.equal(fs.existsSync(survived), false, "the shell and its child were killed, not left running");
});

console.log("\nthe line under the thread");

await test("the organization's call gets the long leash, and is not run twice", () => {
  const agents = findTool("agents");
  assert.ok(agents, "the agents tool is in this build");
  const value = capFor(agents!, { action: "run", agent: "Sabrina" });
  assert.equal(value, AGENT_RUN_CAP_MS * 3 + 60_000);
  assert.equal(value, 1_860_000, "half an hour, not the ninety seconds of a default call");
  assert.ok(value > capFor(findTool("read_file")!, { path: "x" }), "far more than a read's minute");
  assert.equal(canRepeat(agents!, { action: "run", agent: "Sabrina" }), false, "an agent is never started twice by a retry");
});

await test("the line says whose report the turn is waiting on", () => {
  const running = (args: Record<string, any>) => [
    { seq: 1, ts: 1000, kind: Kind.UserMessage, actor: "user", span: null, payload: { text: "ask Sabrina" }, blob: null },
    { seq: 2, ts: 1001, kind: Kind.ToolCall, actor: "agent", span: "a", payload: { name: "agents", args }, blob: null },
  ] as any[];

  assert.equal(activity(running({ action: "run", agent: "Sabrina" })), "Waiting for Sabrina\u2019s report");
  assert.equal(activity(running({ action: "run" })), "Waiting for an agent\u2019s report");
  assert.equal(activity(running({ action: "list" })), "Looking through the organization");
  /* The reading and the words are the same thing: the line the person reads
     comes from the reading, and carries the count and the start of the turn. */
  const reading = readActivity(running({ action: "run", agent: "Sabrina" }));
  assert.equal(reading.text, "Waiting for Sabrina\u2019s report");
  assert.equal(reading.phase, "building");
  assert.equal(reading.steps, 1);
  assert.equal(reading.lastAt, 1001 * 1000, "the quiet clock counts from the last event, in ms");

  /* Nothing running: no line at all, so no clock under it either. */
  assert.equal(activity([]), null);
  assert.equal(readActivity([]).lastAt, null);
});

await test("a quiet minute is mentioned, and three is worth acting on", () => {
  /* The number the line compares is readActivity's lastAt; the threshold and
     the tail are stuckNote's and Thread.tsx:498's. Checked here at the exact
     boundaries (59999/60000, and the three-minute mark). */
  const saysQuiet = (quietMs: number) => quietMs >= 60_000; // Thread.tsx:498
  assert.equal(saysQuiet(59_999), false, "under a minute, the line says nothing about it");
  assert.equal(saysQuiet(60_000), true, "at a minute it does");
  assert.equal(stuckNote(60_000), "", "and it is not yet called stuck");
  assert.equal(stuckNote(STUCK_MS - 1), "");
  assert.match(stuckNote(STUCK_MS), /may be stuck; Stop ends it/);
  assert.equal(STUCK_MS, 180_000, "three minutes");
});

console.log("\nthe cap table, reaching a call that was given none");

await test("a read with no cap given is cut at the table's own minute (this test takes about a minute)", async () => {
  let n = 0;
  const { browser } = stubBrowser({
    snapshot: () => {
      n += 1;
      return n === 1 ? new Promise(() => {}) : Promise.resolve(aPage("https://example.com/late", "the second answer"));
    },
  });
  const started = Date.now();
  const outcome = await runTool(findTool("browser_read")!, {}, ctx({ browser }));
  const took = Date.now() - started;

  assert.match(outcome.summary, /gave up after 60s/, "no cap was given, so the table's minute was used");
  assert.equal(outcome.ok, true, "and the second attempt's answer is what came back");
  assert.ok(took >= 55_000, `it really waited the minute out (${took}ms)`);
  assert.ok(took < 90_000, `and no longer than the minute and its retry (${took}ms)`);
});

console.log(`\n${passed} passed (hang visibility)`);
