/**
 * A tool call that never comes back used to hold the whole turn: nothing timed
 * it out, nothing told the model, and nothing told the person whether the step
 * was slow or wedged.
 *
 * Every call now has a ceiling; when the time is up the tool behind it is asked
 * to stop the way Stop asks it, so a command really is killed, and the call is
 * ended rather than left holding a promise that may never settle. Only a call
 * that cannot do anything twice is ever tried again -- and a read that hangs
 * twice is not tried a third time.
 *
 *   npx tsx tests/toolcap.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { ToolContext, ToolSpec } from "../server/tools";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-toolcap-"));

const { AGENT_RUN_CAP_MS, afterGivingUp, canRepeat, capFor, findTool, runTool, toolSettings, updateToolSettings } =
  await import("../server/tools");

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

/** A spec for a name that is not a tool in this build: the table is about
    names and flags, and both are in the spec. */
function fake(name: string, extra: Partial<ToolSpec> = {}): ToolSpec {
  return { name, group: "terminal", description: "", parameters: { type: "object", properties: {} }, ...extra };
}

/** The context the tools are given in the app, with only what these calls use. */
function ctx(over: Partial<Record<string, any>> = {}): ToolContext {
  return {
    onOutput: () => undefined,
    putBlob: () => "blob",
    showImage: () => undefined,
    showWidget: () => undefined,
    showScreen: () => undefined,
    browser: () => {
      throw new Error("no browser in this test");
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
    session: "test",
    ask: async () => ({ cancelled: true, choices: [], text: "", who: "" }),
    ...over,
  } as unknown as ToolContext;
}

console.log("how long a call may take");

await test("a call the person has to answer is never cut short", () => {
  assert.equal(capFor(findTool("ask_user")!, {}), 0);
  assert.equal(capFor(findTool("browser_handoff")!, {}), 0);
});

await test("an agent of the organization gets room for three of its own runs", () => {
  const agents = findTool("agents");
  assert.ok(agents, "the agents tool is in this build");
  assert.equal(capFor(agents!, { action: "run" }), AGENT_RUN_CAP_MS * 3 + 60_000);
  assert.ok(AGENT_RUN_CAP_MS >= 600_000, "one agent's run is at least ten minutes");
});

await test("a command gets its own timeout, and never less than ten minutes", () => {
  const terminal = findTool("terminal")!;
  const before = toolSettings().terminal.timeout;
  assert.equal(capFor(terminal, { command: "ls" }), Math.max(600_000, before * 1000 + 10_000));
  try {
    updateToolSettings({ terminal: { timeout: 900 } });
    assert.equal(capFor(terminal, { command: "ls" }), 910_000, "a longer setting moves the cap with it");
  } finally {
    updateToolSettings({ terminal: { timeout: before } });
  }
});

await test("a read is cut at a minute, a write at ninety seconds", () => {
  assert.equal(capFor(findTool("read_file")!, { path: "x.txt" }), 60_000);
  assert.equal(capFor(findTool("web_search")!, { query: "x" }), 60_000);
  assert.equal(capFor(findTool("browser_click")!, {}), 90_000);
  assert.equal(capFor(findTool("game_edit")!, {}), 90_000);
  assert.equal(capFor(findTool("http_request")!, { url: "https://example.com", method: "DELETE" }), 90_000);
  assert.equal(capFor(fake("terminal_thing"), {}), 90_000);
});

await test("work that is minutes long by design is given the long leash", () => {
  assert.equal(capFor(findTool("video_export")!, {}), 900_000);
  assert.equal(capFor(findTool("office_pdf")!, { file: "x.docx" }), 900_000);
  assert.equal(capFor(fake("my_husqvarna", {}), {}), 900_000);
  assert.equal(capFor(fake("mcp__sentry__search_issues"), {}), 900_000);
});

console.log("what may be tried again");

await test("only a call that cannot do anything twice is repeatable", () => {
  assert.equal(canRepeat(findTool("read_file")!, { path: "x.txt" }), true);
  assert.equal(canRepeat(findTool("office_read")!, { file: "x.docx" }), true);
  assert.equal(canRepeat(findTool("web_search")!, { query: "x" }), true);
  assert.equal(canRepeat(findTool("terminal")!, { command: "npm test" }), false);
  assert.equal(canRepeat(findTool("office_create")!, { type: "docx" }), false);
  /* The address is arbitrary and the person's sign-ins go out with it: a GET
     is asked again for real, so nothing about it is repeated. */
  assert.equal(canRepeat(findTool("http_request")!, { url: "https://example.com" }), false);
  assert.equal(canRepeat(fake("my_husqvarna"), {}), false);
  assert.equal(canRepeat(fake("mcp__sentry__search_issues"), {}), false);
  assert.equal(canRepeat(fake("thing_look"), {}), true);
  assert.equal(canRepeat(fake("thing_set"), {}), false);
});

console.log("a call that never comes back");

await test("a command that never returns is cut off, killed, and run once", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-cap-"));
  const ran = path.join(dir, "ran");
  const survived = path.join(dir, "survived");
  const stops: Array<() => void> = [];
  const command = `echo ran >> ${ran}; sleep 3; echo survived >> ${survived}`;

  const started = Date.now();
  const outcome = await runTool(
    findTool("terminal")!,
    { command },
    ctx({ onCancel: (stop: () => void) => stops.push(stop) }),
    600,
  );
  const took = Date.now() - started;

  assert.equal(outcome.ok, false);
  assert.match(outcome.summary, /terminal gave up after 1s/);
  assert.ok(took < 2500, `the call ended at the cap, not after the command (${took}ms)`);
  assert.ok(stops.length >= 1, "the command was told to stop");
  assert.equal(fs.readFileSync(ran, "utf8").trim().split("\n").length, 1, "run once, never twice");

  /* Abandoning the call is not enough: the work behind it has to be gone. */
  await wait(3600);
  assert.equal(fs.existsSync(survived), false, "the shell and its child were killed, not left running");
});

await test("a cap of nothing means no cap at all", async () => {
  const outcome = await runTool(findTool("terminal")!, { command: "echo hi" }, ctx(), 0);
  assert.equal(outcome.ok, true);
  assert.match(outcome.summary, /hi/);
});

await test("a read that gave up is asked once more, and the words say which", async () => {
  const read = findTool("read_file")!;
  /* Answered this time: this function is the second attempt itself. */
  let tries = 0;
  const answer = async () => {
    tries += 1;
    return { outcome: { ok: true, summary: "the file" }, gaveUp: false };
  };
  const worked = await afterGivingUp(read, { path: "x.txt" }, ctx(), 60_000, answer, 5);
  assert.equal(worked.ok, true);
  assert.equal(tries, 1, "asked once more, which is the second time in all");
  assert.match(worked.summary, /read_file gave up after 60s/);
  assert.match(worked.summary, /Tried once more, 0s later, and the second attempt worked/);
  assert.match(worked.summary, /the file/);

  /* Nothing at all the second time: the model is told not to try a third. */
  tries = 0;
  const never = async () => {
    tries += 1;
    return { outcome: { ok: false, summary: "" }, gaveUp: true };
  };
  const stuck = await afterGivingUp(read, { path: "x.txt" }, ctx(), 60_000, never, 5);
  assert.equal(stuck.ok, false);
  assert.equal(tries, 1, "asked once more, and that is the end of it");
  assert.match(stuck.summary, /read_file gave up after 60s/);
  assert.match(stuck.summary, /Twice now it has not answered/);
  assert.match(stuck.summary, /do not try it a third time/);
});

await test("a call that changes the world is never tried twice", async () => {
  let tries = 0;
  const answer = async () => {
    tries += 1;
    return { outcome: { ok: true, summary: "a document" }, gaveUp: false };
  };
  const outcome = await afterGivingUp(findTool("office_create")!, { type: "docx" }, ctx(), 90_000, answer, 5);
  assert.equal(tries, 0, "the second attempt is never even reached");
  assert.equal(outcome.ok, false);
  assert.match(outcome.summary, /office_create gave up after 90s/);
  assert.doesNotMatch(outcome.summary, /Tried once more/);
  assert.match(outcome.summary, /read the thing back before doing it again/);
});

await test("Stop pressed while it hangs is not a retry", async () => {
  let tries = 0;
  const answer = async () => {
    tries += 1;
    return { outcome: { ok: true, summary: "late" }, gaveUp: false };
  };
  const outcome = await afterGivingUp(
    findTool("read_file")!,
    { path: "x.txt" },
    ctx({ cancelled: () => true }),
    60_000,
    answer,
    5,
  );
  assert.equal(outcome.summary, "Stopped.");
  assert.equal(tries, 0, "nothing was asked again after Stop");
});

await test("a file that is not a file is refused, not waited on", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-fifo-"));
  const pipe = path.join(dir, "pipe");
  execFileSync("mkfifo", [pipe]);
  const started = Date.now();
  const outcome = await runTool(findTool("read_file")!, { path: pipe }, ctx());
  const took = Date.now() - started;
  assert.equal(outcome.ok, false);
  assert.match(outcome.summary, /not a regular file/);
  assert.ok(took < 3000, `it came back at once (${took}ms)`);
});

console.log(`\n${passed} passed (tool caps)`);
