/**
 * The parts of being proactive that have to be true rather than promised:
 * standing agreements, the look at the machine, and memories that say how old
 * they are.
 *
 * The three share a failure mode worth testing for -- behaving as if
 * something were known when it was only remembered, or agreed when it was
 * only assumed. So: a rule cannot be a way of pre-agreeing to something
 * irrecoverable, the machine is looked at rather than believed, and a memory
 * that has not been checked in months says so.
 *
 *   npx tsx tests/proactive.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-proactive-"));
const autonomy = await import("../server/autonomy");
const inventory = await import("../server/inventory");
const { freshness } = await import("../server/memory");
import type { MemoryRecord } from "../server/memory";
const { availableTools, runTool } = await import("../server/tools");
import type { ToolContext } from "../server/tools";

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

const record = (over: Partial<MemoryRecord> = {}): MemoryRecord => ({
  id: "mem-1", kind: "fact", scope: "workspace", title: "t", body: "b", tags: [],
  status: "confirmed", pinned: false, source_session: null, source_seq: null,
  created: 0, updated: 0, uses: 0, last_used: null, superseded_by: null, ...over,
});

const DAY = 86_400;

console.log("standing agreements");

await test("a rule covers a call whose words contain it, and counts the use", () => {
  const made = autonomy.addRule({
    tool: "terminal",
    match: "docker compose restart kokoro",
    note: "restarting the Kokoro app",
  });
  assert.ok(made.rule, made.error);
  assert.equal(autonomy.covered("terminal", { command: "cd /host && docker compose restart kokoro" })?.id, made.rule!.id);
  assert.equal(autonomy.covered("terminal", { command: "docker compose down" }), null);
  assert.equal(autonomy.covered("run_background", { command: "docker compose restart kokoro" }), null, "another tool is another rule");
  assert.equal(autonomy.listRules()[0].used, 1);
  assert.ok(autonomy.covered("terminal", { command: "docker compose restart kokoro" }));
  assert.equal(autonomy.listRules()[0].used, 2);
});

await test("the most specific agreement is the one credited", () => {
  autonomy.addRule({ tool: "terminal", match: "docker compose restart", note: "any compose restart" });
  const hit = autonomy.covered("terminal", { command: "docker compose restart kokoro" });
  assert.equal(hit?.match, "docker compose restart kokoro");
});

await test("http_request is covered by its method and address", () => {
  const made = autonomy.addRule({
    tool: "http_request",
    match: "POST https://api.example.com/deploy",
    note: "the deploy hook",
  });
  assert.ok(made.rule, made.error);
  assert.ok(autonomy.covered("http_request", { method: "POST", url: "https://api.example.com/deploy" }));
  assert.equal(autonomy.covered("http_request", { method: "GET", url: "https://api.example.com/deploy" }), null);
});

await test("nothing irrecoverable can be agreed in advance", () => {
  for (const command of [
    "mkfs.ext4 /dev/sda1",
    "rm -rf /",
    "docker volume rm autora_data",
    "git push --force origin main",
    "dd if=/dev/zero of=/dev/sda",
  ]) {
    const made = autonomy.addRule({ tool: "terminal", match: command });
    assert.equal(made.rule, undefined, `${command} should not be coverable`);
    assert.match(made.error ?? "", /every time/);
  }
});

await test("a rule too short to be a class of work is refused", () => {
  const made = autonomy.addRule({ tool: "terminal", match: "rm" });
  assert.equal(made.rule, undefined);
  assert.match(made.error ?? "", /too short/);
  assert.equal(autonomy.addRule({ tool: "browser_click", match: "npm run build" }).rule, undefined);
});

await test("the same agreement is not made twice, and one can be taken back", () => {
  assert.match(autonomy.addRule({ tool: "terminal", match: "docker compose restart" }).error ?? "", /already agreed/);
  const id = autonomy.listRules()[0].id;
  assert.equal(autonomy.revoke(id), true);
  assert.equal(autonomy.revoke(id), false);
  assert.ok(!autonomy.listRules().some((r) => r.id === id));
  assert.match(autonomy.autonomyBriefing(), /Standing agreements/);
});

console.log("\nwhat the machine has");

await test("the look at the machine names what is and is not installed", () => {
  const seen = inventory.look();
  assert.ok(seen.lines.length >= 3);
  assert.match(seen.lines[0], /The machine: /);
  assert.match(seen.lines.join("\n"), /Installed: .*node/);
  assert.match(seen.lines.join("\n"), /Commands start in /);
  assert.ok(seen.at > 0);
});

await test("it is looked at once and then remembered, and looked at again on request", () => {
  const first = inventory.get();
  assert.equal(inventory.get().at, first.at, "a second look inside the window is the same look");
  assert.ok(inventory.get(true).at >= first.at);
});

await test("a session is told once, not every turn", () => {
  const said = inventory.inventoryBriefing("session-a");
  assert.match(said, /What this machine has, looked at/);
  assert.equal(inventory.inventoryBriefing("session-a"), "");
  assert.match(inventory.inventoryBriefing("session-b"), /What this machine has/);
});

console.log("\nhow old a memory is");

await test("a memory checked recently says nothing about its age", () => {
  const at = Math.floor(Date.now() / 1000);
  assert.equal(freshness(record({ checked: at }), at), null);
  assert.equal(freshness(record({ updated: at, checked: at }), at), null);
});

await test("one nobody has checked in months says so", () => {
  const at = Math.floor(Date.now() / 1000);
  assert.match(freshness(record({ updated: at - 40 * DAY }), at) ?? "", /40 days ago and never checked since/);
  assert.match(
    freshness(record({ updated: at - 100 * DAY, checked: at - 90 * DAY }), at) ?? "",
    /last checked 3 months ago/,
  );
});

console.log("\nthe tools the agent is offered");

const fakeCtx = (): { made: any[]; ctx: ToolContext } => {
  const made: any[] = [];
  const ctx = {
    onOutput: () => undefined,
    cancelled: () => false,
    onCancel: () => undefined,
    session: "session-test",
    jobs: {
      list: () => [],
      create: (input: any) => {
        made.push(input);
        return { id: "job-1", error: input.cron === "nonsense" ? "cron needs five fields" : null };
      },
      update: (id: string, patch: any) => {
        made.push({ id, patch });
        return { ok: id !== "job-nope", error: null };
      },
      remove: (id: string) => id === "job-1",
    },
  } as unknown as ToolContext;
  return { made, ctx };
};

const specFor = async (name: string) => (await availableTools()).find((t) => t.name === name);

await test("every new tool is offered to the model", async () => {
  const names = (await availableTools()).map((t) => t.name);
  for (const name of [
    "run_background", "background_jobs", "background_output", "background_stop",
    "schedule", "schedules", "unschedule",
    "pre_authorise", "pre_authorisations", "inventory", "memory_confirm",
  ]) {
    assert.ok(names.includes(name), `${name} is not offered`);
  }
});

await test("a schedule the agent sets goes into the Schedule page's list", async () => {
  const { made, ctx } = fakeCtx();
  const spec = await specFor("schedule");
  assert.ok(spec);
  const out = await runTool(spec!, {
    name: "Release check",
    cron: "0 8 * * 1-5",
    prompt: "Check the release status and report.",
    watch: { kind: "page", target: "https://example.com/releases" },
  }, ctx);
  assert.equal(out.ok, true);
  assert.match(out.summary, /job-1/);
  assert.equal(made[0].cron, "0 8 * * 1-5");
  assert.deepEqual(made[0].watch, { kind: "page", target: "https://example.com/releases" });
});

await test("a bad cron comes back as a warning rather than a silent success", async () => {
  const { ctx } = fakeCtx();
  const spec = await specFor("schedule");
  const out = await runTool(spec!, { name: "X", cron: "nonsense", prompt: "do it" }, ctx);
  assert.equal(out.ok, false);
  assert.match(out.summary, /not valid/);
});

await test("a schedule with no prompt, or to change something that is not there, is refused", async () => {
  const { ctx } = fakeCtx();
  const spec = await specFor("schedule");
  assert.match((await runTool(spec!, { name: "X", cron: "* * * * *" }, ctx)).summary, /needs a prompt/);
  assert.match((await runTool(spec!, { id: "job-nope", prompt: "do it" }, ctx)).summary, /no job job-nope/);
  assert.match((await runTool(spec!, { name: "X", cron: "* * * * *", prompt: "p", watch: { kind: "page" } }, ctx)).summary,
    /needs something to watch/);
});

await test("unschedule removes one, or pauses it when asked to keep it", async () => {
  const { made, ctx } = fakeCtx();
  const spec = await specFor("unschedule");
  assert.equal((await runTool(spec!, { id: "job-1" }, ctx)).ok, true);
  assert.equal((await runTool(spec!, { id: "job-nope" }, ctx)).ok, false);
  const paused = await runTool(spec!, { id: "job-2", keep: true }, ctx);
  assert.equal(paused.ok, true);
  assert.deepEqual(made[0].patch, { enabled: false });
});

await test("the agent cannot pre-agree to something that cannot be undone", async () => {
  const { ctx } = fakeCtx();
  const spec = await specFor("pre_authorise");
  const out = await runTool(spec!, { tool: "terminal", match: "rm -rf /" }, ctx);
  assert.equal(out.ok, false);
  assert.match(out.summary, /every time/);
});

await test("the inventory tool answers with a fresh look", async () => {
  const { ctx } = fakeCtx();
  const spec = await specFor("inventory");
  const out = await runTool(spec!, {}, ctx);
  assert.equal(out.ok, true);
  assert.match(out.summary, /as of now/);
  assert.match(out.summary, /Installed: /);
});

await test("an agreement the person pressed through on a card is their own, and a whole list can be taken back", async () => {
  /* Exactly what the approval card writes when "do not ask again" is
     pressed: matchText of the call that was on the card, recorded as the
     person's rule, not the agent's. */
  const command = "cd /host && docker compose pull kokoro";
  const made = autonomy.addRule({
    tool: "terminal",
    match: autonomy.matchText("terminal", { command }) ?? "",
    note: "allowed on the card",
    by: "person",
  });
  assert.ok(made.rule, made.error);
  assert.equal(made.rule!.by, "person");
  assert.equal(autonomy.covered("terminal", { command })?.id, made.rule!.id, "the card's own call is covered");

  const aside = autonomy.addRule({ tool: "terminal", match: "docker system prune", by: "agent" });
  assert.ok(aside.rule, aside.error);
  assert.ok(autonomy.listRules().length >= 2);
  assert.ok(autonomy.revokeAll() >= 2);
  assert.deepEqual(autonomy.listRules(), []);
  assert.equal(autonomy.covered("terminal", { command }), null, "revoked means asked about again");
});

console.log(`\n${passed} passed`);
