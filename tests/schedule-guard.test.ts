/**
 * An agent may not schedule a plain task (no watcher) to run more often than
 * every 15 minutes: each run is a whole model turn. A watcher may look often,
 * since it costs a turn only when what it sees changes.
 *
 *   npx tsx tests/schedule-guard.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-schedguard-"));
const { findTool, runTool } = await import("../server/tools");

const made: any[] = [];
const ctx = { jobs: { create: (j: any) => { made.push(j); return { id: `job-${made.length}` }; }, update: () => ({ ok: true }), list: () => [] } } as any;
const spec = findTool("schedule")!;
const run = (args: Record<string, unknown>) => runTool(spec, { name: "t", prompt: "do it", ...args }, ctx);

let passed = 0;
async function test(name: string, fn: () => Promise<void>) { await fn(); passed += 1; console.log(`  ok  ${name}`); }

await test("a plain task every five minutes is refused, and the refusal points at a watcher", async () => {
  const r = await run({ cron: "*/5 * * * *" });
  assert.equal(r.ok, false);
  assert.match(r.summary, /watcher/);
  assert.equal(made.length, 0);
});
await test("a plain task every quarter hour or less often is made", async () => {
  assert.equal((await run({ cron: "*/15 * * * *" })).ok, true);
  assert.equal((await run({ cron: "0 8 * * 1-5" })).ok, true);
});
await test("a watcher may look every minute", async () => {
  const r = await run({ cron: "* * * * *", watch: { kind: "command", target: "git log -1" } });
  assert.equal(r.ok, true);
});

console.log(`${passed} passed`);
process.exit(0);
