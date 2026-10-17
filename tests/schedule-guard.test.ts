/**
 * An agent may set a script on a cron time and nothing that wakes a model: no prompt, no watcher, no timer made in the
 * shell (crontab, at, systemd), no script that starts a chat or calls a model. A task the person made that wakes a model
 * may be paused by an agent, never changed.
 *
 *   npx tsx tests/schedule-guard.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-schedguard-"));
const { findTool, runTool } = await import("../server/tools");
const { makesTimerOrWake } = await import("../server/guard");

const made: any[] = [];
const updated: any[] = [];
const listed: any[] = [{ id: "theirs", command: null, cron: "0 8 * * *" }, { id: "mine", command: "echo hi", cron: "0 9 * * *" }];
const ctx = {
  jobs: {
    create: (j: any) => { made.push(j); return { id: `job-${made.length}` }; },
    update: (id: string, p: any) => { updated.push({ id, ...p }); return { ok: true }; },
    list: () => listed,
  },
} as any;
const spec = findTool("schedule")!;
const run = (args: Record<string, unknown>) => runTool(spec, args, ctx);

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) { await fn(); passed += 1; console.log(`  ok  ${name}`); }

await test("a script on a cron time is made, as often as every minute: it costs no tokens", async () => {
  const r = await run({ name: "Backup", cron: "* * * * *", command: "tar czf /tmp/b.tgz ~/notes", approved: true });
  assert.equal(r.ok, true, r.summary);
  assert.equal(made.length, 1);
  assert.equal(made[0].command, "tar czf /tmp/b.tgz ~/notes");
  assert.match(r.summary, /no model/);
});

await test("a new script is not made until the person has agreed: the agent is told to ask first", async () => {
  const before = made.length;
  const r = await run({ name: "Unasked", cron: "0 8 * * *", command: "echo hi" });
  assert.equal(r.ok, false);
  assert.match(r.summary, /ask_user/);
  assert.equal(made.length, before);
});

await test("a task with a prompt, which wakes a model, is refused, and the refusal points at a script", async () => {
  const r = await run({ name: "Check", cron: "0 8 * * *", prompt: "look at the release page and tell me" });
  assert.equal(r.ok, false);
  assert.match(r.summary, /wakes a model/);
  assert.match(r.summary, /command/);
  assert.equal(made.length, 1);
});

await test("a watcher, which wakes a model when something changes, is refused too", async () => {
  const r = await run({ name: "Page", cron: "*/5 * * * *", command: "true", watch: { kind: "page", target: "https://example.com" } });
  assert.equal(r.ok, false);
  assert.equal(made.length, 1);
});

await test("a job needs a command, a name and a time", async () => {
  assert.equal((await run({ name: "x", cron: "0 8 * * *" })).ok, false);
  assert.equal((await run({ cron: "0 8 * * *", command: "true" })).ok, false);
  assert.equal((await run({ name: "x", command: "true" })).ok, false);
});

await test("a script may not start a model or a chat", async () => {
  for (const command of [
    "curl -s -X POST http://localhost:3000/api/sessions",
    "wget -qO- http://127.0.0.1:8080/api/jobs/job-1/run",
    "curl https://api.anthropic.com/v1/messages -d '{}'",
    "claude -p 'summarise the logs'",
  ]) {
    const r = await run({ name: "Sneaky", cron: "0 * * * *", command, approved: true });
    assert.equal(r.ok, false, command);
  }
  assert.equal(made.length, 1);
});

await test("an agent's own script can be changed; a task that wakes a model can only be paused", async () => {
  assert.equal((await run({ id: "mine", cron: "0 10 * * *", command: "echo again" })).ok, true);
  assert.equal(updated.at(-1).cron, "0 10 * * *");
  const r = await run({ id: "theirs", cron: "0 12 * * *" });
  assert.equal(r.ok, false);
  assert.match(r.summary, /person's/);
});

await test("the terminal makes no timer of its own: crontab, at, batch, systemd-run", async () => {
  for (const command of ["crontab -e", "(crontab -l; echo '* * * * * x') | crontab -", "echo hi | at now + 1 minute", "sudo systemd-run --on-calendar=hourly foo", "batch < job.sh"]) {
    assert.ok(makesTimerOrWake(command), command);
  }
  for (const command of ["crontab -l", "git log --format='%at' | head", "echo meet at five", "cat notes.txt", "ls -la"]) {
    assert.equal(makesTimerOrWake(command), null, command);
  }
  const r = await runTool(findTool("terminal")!, { command: "crontab -e" }, ctx);
  assert.equal(r.ok, false);
  assert.match(r.summary, /schedule tool/);
});

console.log(`${passed} passed`);
process.exit(0);
