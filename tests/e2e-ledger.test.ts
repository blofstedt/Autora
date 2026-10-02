/**
 * Working notes reach the next turn, including after the turn was cut off.
 *
 *   npx tsx tests/e2e-ledger.test.ts
 */
import assert from "node:assert/strict";
import { startApp, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app: App = await startApp();
  try {
    console.log("working notes");
    await test("what the agent wrote down is in front of it on the next turn", async () => {
      app.seen.length = 0;
      const s = await app.newSession("notes", "build");
      app.script.push({ tools: [{ name: "ledger", args: { goal: "move the notes", decided: ["keep the old folder until verified"], learned: ["notes live in ~/notes/2024"], next: ["copy", "verify"] } }] });
      app.script.push({ text: "Noted." });
      await app.turn(s, "move my notes");
      const before = app.seen.length;
      app.script.push({ text: "Carrying on." });
      await app.turn(s, "continue");
      const next = app.seen.slice(before).map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n");
      assert.match(next, /Your working notes/);
      assert.match(next, /Goal: move the notes/);
      assert.match(next, /notes live in ~\/notes\/2024/);
      assert.match(next, /keep the old folder until verified/);
    });

    await test("a chat that wrote nothing is told nothing", async () => {
      app.seen.length = 0;
      const s = await app.newSession("quiet", "build");
      app.script.push({ text: "Hi." });
      await app.turn(s, "hello");
      assert.ok(!app.seen.some((r) => /Your working notes/.test(r.system)));
    });

    await test("they survive the turn being stopped", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        step += 1;
        if (step === 1) return { tools: [{ name: "ledger", args: { learned: ["the config is in /etc/app.toml"], next: ["edit it"] } }] };
        if (step === 2) return { text: "Working on it. ".repeat(80), slow: true };
        return { text: "Resumed." };
      };
      const s = await app.newSession("stopnotes", "build");
      await app.say(s, "fix the config");
      await app.until(s, (ev) => ev.some((e) => e.kind === "turn.agent.text"), "the reply to start");
      await app.api("POST", `/api/sessions/${s}/interrupt`);
      await app.until(s, (e) => e.some((x) => x.kind === "turn.agent.done"), "the turn to stop", 10_000);
      const before = app.seen.length;
      await app.turn(s, "go on");
      const next = app.seen.slice(before).map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n");
      assert.match(next, /the config is in \/etc\/app\.toml/);
      assert.match(next, /1\. edit it/);
      app.decide = null;
    });
  } finally {
    await app.stop();
  }
  console.log(`${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
