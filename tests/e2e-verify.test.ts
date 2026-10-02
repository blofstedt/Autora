/**
 * The project check, end to end: the agent says it is done, the person's
 * command decides, and a failure sends it back with the raw output.
 *
 *   npx tsx tests/e2e-verify.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp, type App, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const logs = (ev: Ev[]) => ev.filter((e) => e.kind === "system.log").map((e) => String(e.payload.message));
const guardOk = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);

async function main() {
  const app: App = await startApp();
  try {
    const flag = path.join(app.home, "ready.txt");
    const check = `test -f ${flag} || { echo "missing ready.txt: 1 check failed"; exit 3; }`;

    console.log("the project check");
    await test("a failing check sends the agent back with its output, and a pass ends the turn", async () => {
      assert.equal((await app.api("PATCH", "/api/settings", { verify: { command: check, tries: 3 } })).status, 200);
      assert.equal((await app.api("GET", "/api/settings")).body.verify.command, check);
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: `echo built > ${path.join(app.home, "out.txt")}` } }] };
        if (step === 2) return { text: "All done, everything works." };
        if (step === 3) return { tools: [{ name: "terminal", args: { command: `touch ${flag}` } }] };
        return { text: "Fixed it." };
      };
      const s = await app.newSession("verify", "build");
      const ev = await app.turn(s, "build the thing", 60_000);
      const said = logs(ev);
      assert.ok(said.some((m) => /Running the project's check/.test(m)));
      assert.ok(said.some((m) => /check failed \(exit 3\); the agent was sent back/.test(m)), said.join(" | "));
      assert.ok(said.some((m) => /project's check passed/.test(m)), said.join(" | "));
      const told = app.seen.map((r) => JSON.stringify(r.messages)).join("\n");
      assert.match(told, /exited 3, so it did not pass/);
      assert.match(told, /missing ready\.txt: 1 check failed/);
      assert.equal(step, 4, "the agent fixed it and finished");
      app.decide = null;
    });

    await test("a turn that changed nothing is not checked", async () => {
      fs.rmSync(flag, { force: true });
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "ls" } }] };
        return { text: "Looked." };
      };
      const s = await app.newSession("readonly", "build");
      const ev = await app.turn(s, "what is in here?");
      assert.ok(!logs(ev).some((m) => /project's check/.test(m)));
      app.decide = null;
    });

    await test("a check that keeps failing ends the turn saying so, after the runs allowed", async () => {
      fs.rmSync(flag, { force: true });
      assert.equal((await app.api("PATCH", "/api/settings", { verify: { tries: 2 } })).status, 200);
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step % 2 === 1) return { tools: [{ name: "terminal", args: { command: `echo try${step} > ${path.join(app.home, `t${step}.txt`)}` } }] };
        return { text: "Done." };
      };
      const s = await app.newSession("stubborn", "build");
      const ev = await app.turn(s, "make it pass", 60_000);
      const said = logs(ev);
      assert.equal(said.filter((m) => /Running the project's check/.test(m)).length, 2);
      const told = app.seen.map((r) => JSON.stringify(r.messages)).join("\n");
      assert.match(told, /last run this turn/);
      app.decide = null;
    });

    await test("with no command set, nothing is run", async () => {
      assert.equal((await app.api("PATCH", "/api/settings", { verify: { command: "" } })).status, 200);
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        return step === 1 ? { tools: [{ name: "terminal", args: { command: `echo x > ${path.join(app.home, "z.txt")}` } }] } : { text: "Done." };
      };
      const s = await app.newSession("off", "build");
      const ev = await app.turn(s, "do it");
      assert.ok(!logs(ev).some((m) => /project's check/.test(m)));
      app.decide = null;
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
