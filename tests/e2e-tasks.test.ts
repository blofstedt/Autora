/**
 * What a task costs, end to end: the real server, a scripted model.
 *
 * The figure on the Usage page is only worth anything if it is the same money
 * the spend ledger wrote down, so that is the check: after a turn, the task's
 * cost, calls and tokens equal what the ledger gained over the turn -- to the
 * cent, on a priced model -- and how the turn ended is read from what happened,
 * not from what the agent said.
 *
 *   npx tsx tests/e2e-tasks.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const guardOk = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);
const near = (a: number, b: number) => Math.abs(a - b) < 1e-9;

async function main() {
  const app: App = await startApp({ env: { DEEPSEEK_API_KEY: "sk-test" } });
  try {
    const fake = app.modelUrl;
    /* DeepSeek's own price table, pointed at the fake model: a priced turn. */
    assert.equal((await app.api("PATCH", "/api/settings", {
      provider: "deepseek", models: { deepseek: "deepseek-flash" }, base_urls: { deepseek: fake },
    })).status, 200);

    const ledgerNow = async () => {
      const u = (await app.api("GET", "/api/usage")).body;
      return { cost: u.lifetime.cost as number, turns: u.lifetime.turns as number, input: u.lifetime.input as number, output: u.lifetime.output as number };
    };
    const tasks = async (q = "") => (await app.api("GET", `/api/tasks${q}`)).body;
    const taskOf = async (id?: string) => {
      const rows = (await tasks()).recent as { id: string; kind: string; cost: number; outcome: string; verdict: string | null; source: string | null; priced: boolean; mark: string | null }[];
      return id ? rows.find((r) => r.id === id)! : rows[0];
    };

    console.log("the task ledger");
    await test("a task's cost is exactly what the spend ledger gained over the turn", async () => {
      const before = await ledgerNow();
      const known = new Set((await tasks()).recent.map((r: { id: string }) => r.id));
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        return step === 1 ? { tools: [{ name: "terminal", args: { command: "echo hi" } }] } : { text: "Said hi." };
      };
      const s = await app.newSession("cost", "build");
      await app.turn(s, "say hi in the terminal");
      app.decide = null;
      await new Promise((r) => setTimeout(r, 700)); // the debounced write
      const after = await ledgerNow();
      const row = (await tasks()).recent.find((r: { id: string }) => !known.has(r.id));
      assert.ok(row, "the turn is a task");
      assert.equal(row.kind, "code");
      assert.equal(row.outcome, "finished");
      assert.equal(row.priced, true);
      assert.ok(row.cost > 0, "a priced model costs something");
      assert.ok(near(row.cost, after.cost - before.cost), `task ${row.cost} vs ledger ${after.cost - before.cost}`);
      assert.equal(row.verdict, null, "nothing said how it went: unjudged, not good");
      assert.equal(after.turns - before.turns, 2, "two model calls: the tool round and the answer");
    });

    await test("the look back after the turn is billed to the turn that caused it", async () => {
      assert.equal((await app.api("PATCH", "/api/memory-settings", { learning: true })).status, 200);
      const before = await ledgerNow();
      const known = new Set((await tasks()).recent.map((r: { id: string }) => r.id));
      app.decide = (req) => guardOk(req) ?? { text: "Hello there." };
      const s = await app.newSession("learns", "build");
      await app.turn(s, "My favourite colour is green and I always want answers short.");
      /* The look back runs after the turn is done; wait until the ledger stops growing. */
      let last = -1;
      for (let i = 0; i < 40; i += 1) {
        await new Promise((r) => setTimeout(r, 250));
        const now = (await ledgerNow()).turns;
        if (now === last && now - before.turns >= 2) break;
        last = now;
      }
      app.decide = null;
      assert.equal((await app.api("PATCH", "/api/memory-settings", { learning: false })).status, 200);
      await new Promise((r) => setTimeout(r, 700));
      const after = await ledgerNow();
      const row = (await tasks()).recent.find((r: { id: string }) => !known.has(r.id));
      assert.ok(row);
      assert.ok(after.turns - before.turns >= 2, `the look back made a call (the ledger gained ${after.turns - before.turns})`);
      assert.ok(near(row.cost, after.cost - before.cost), `task ${row.cost} vs ledger ${after.cost - before.cost}`);
    });

    await test("the person's project check says how a turn went, and the last run stands", async () => {
      const flag = path.join(app.home, "ready.txt");
      fs.rmSync(flag, { force: true });
      const check = `test -f ${flag}`;
      assert.equal((await app.api("PATCH", "/api/settings", { verify: { command: check, tries: 1 } })).status, 200);
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        return step === 1 ? { tools: [{ name: "terminal", args: { command: `echo built > ${path.join(app.home, "out.txt")}` } }] } : { text: "Done." };
      };
      const s = await app.newSession("check-fails", "build");
      await app.turn(s, "build it", 60_000);
      await new Promise((r) => setTimeout(r, 700));
      const failed = await taskOf();
      assert.equal(failed.verdict, "poor");
      assert.equal(failed.source, "check");

      step = 0;
      fs.writeFileSync(flag, "x");
      const s2 = await app.newSession("check-passes", "build");
      await app.turn(s2, "build it again", 60_000);
      await new Promise((r) => setTimeout(r, 700));
      const passedRow = await taskOf();
      assert.equal(passedRow.verdict, "good");
      assert.equal(passedRow.source, "check");
      app.decide = null;
      assert.equal((await app.api("PATCH", "/api/settings", { verify: { command: "" } })).status, 200);
    });

    await test("a turn the model could not answer is a failed task, however little it cost", async () => {
      app.decide = () => ({ status: 500, error: "the vendor is down" });
      const s = await app.newSession("down", "build");
      await app.turn(s, "anything", 60_000);
      app.decide = null;
      await new Promise((r) => setTimeout(r, 700));
      const row = await taskOf();
      assert.equal(row.outcome, "failed");
      assert.equal(row.verdict, "poor");
      assert.equal(row.source, "error");
    });

    await test("a turn the person stops is unjudged", async () => {
      app.decide = (req) => guardOk(req) ?? { text: "one two three four five six seven eight nine ten eleven twelve", slow: true };
      const s = await app.newSession("stopped", "build");
      await app.say(s, "tell me a long story");
      await app.until(s, (ev) => ev.some((e) => e.kind === "turn.agent.text"), "the reply to start");
      assert.equal((await app.api("POST", `/api/sessions/${s}/interrupt`)).status, 200);
      await app.until(s, (ev) => ev.some((e) => e.kind === "turn.agent.done"), "the turn to end");
      app.decide = null;
      await new Promise((r) => setTimeout(r, 700));
      const row = await taskOf();
      assert.equal(row.outcome, "stopped");
      assert.equal(row.verdict, null);
    });

    await test("the person's mark is saved, can be taken back, and bad ones are refused", async () => {
      const row = await taskOf();
      assert.equal((await app.api("POST", `/api/tasks/${row.id}/mark`, { mark: "good" })).status, 200);
      assert.equal((await taskOf(row.id)).verdict, "good");
      assert.equal((await taskOf(row.id)).source, "rated");
      assert.equal((await app.api("POST", `/api/tasks/${row.id}/mark`, { mark: null })).status, 200);
      assert.equal((await taskOf(row.id)).verdict, null);
      assert.equal((await app.api("POST", `/api/tasks/${row.id}/mark`, { mark: "great" })).status, 400);
      assert.equal((await app.api("POST", `/api/tasks/task-nope/mark`, { mark: "good" })).status, 404);
    });

    await test("this build alone, or every build", async () => {
      const all = await tasks();
      const mine = await tasks("?version=current");
      assert.ok(all.current && all.versions.includes(all.current));
      assert.equal(mine.tasks, all.tasks, "everything so far ran on this build");
      assert.equal((await tasks("?version=0.0.1")).tasks, 0);
    });

    await test("the tasks are still there after a restart", async () => {
      const before = (await tasks()).tasks;
      await app.restart();
      assert.equal((await tasks()).tasks, before);
    });
  } finally {
    const log = app.log();
    await app.stop();
    if (process.env.E2E_LOG) console.log(log);
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
