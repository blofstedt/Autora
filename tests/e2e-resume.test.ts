/**
 * An interrupted task is picked up by the turn that follows: the real
 * server, a scripted model. What is checked is what the model is told.
 *
 *   npx tsx tests/e2e-resume.test.ts
 */
import assert from "node:assert/strict";
import { startApp, type App, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const done = (ev: Ev[]) => ev.filter((e) => e.kind === "turn.agent.done");

async function main() {
  const app: App = await startApp();
  try {
    console.log("interrupting the agent");
    await test("a message sent mid-work is told the work it cut off", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "echo step-one-done" } }] };
        if (step === 2) return { text: "Carrying on with the rename. ".repeat(60), slow: true };
        return { text: "Carried on." };
      };
      const s = await app.newSession("resume", "build");
      await app.say(s, "rename every helper in the repo to snake_case");
      await app.until(s, (ev) => ev.some((e) => e.kind === "turn.agent.text"), "the second step to start");
      const before = app.seen.length;
      // Sent while it is still working: interrupt & send.
      await app.say(s, "also keep the old names as aliases");
      const ev = await app.until(s, (e) => done(e).length >= 2, "the second turn to end", 20_000);
      assert.equal(done(ev)[0].payload.stopped, true, "the cut turn is marked as stopped");
      const next = app.seen.slice(before).map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n");
      assert.match(next, /\[Interrupted work\]/);
      assert.match(next, /rename every helper in the repo to snake_case/);
      assert.match(next, /also keep the old names as aliases/);
      assert.match(next, /carry on with the interrupted work/);
      app.decide = null;
    });

    await test("a turn that finished is not followed by a resume note", async () => {
      app.seen.length = 0;
      const s = await app.newSession("clean", "build");
      app.script.push({ text: "All done." });
      await app.turn(s, "say hi");
      app.script.push({ text: "Fine." });
      await app.turn(s, "and again");
      assert.ok(!app.seen.some((r) => /\[Interrupted work\]/.test(r.system + JSON.stringify(r.messages))));
    });

    await test("after Stop, the next message still carries the work on", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "echo working" } }] };
        if (step === 2) return { text: "Still going. ".repeat(80), slow: true };
        return { text: "Resumed." };
      };
      const s = await app.newSession("stopped", "build");
      await app.say(s, "migrate the notes to the new folder");
      await app.until(s, (ev) => ev.some((e) => e.kind === "turn.agent.text"), "the reply to start");
      await app.api("POST", `/api/sessions/${s}/interrupt`);
      await app.until(s, (e) => done(e).length >= 1, "the turn to stop", 10_000);
      const before = app.seen.length;
      await app.turn(s, "ok go on");
      const next = app.seen.slice(before).map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n");
      assert.match(next, /\[Interrupted work\]/);
      assert.match(next, /migrate the notes to the new folder/);
      app.decide = null;
    });
    await test("in Agent mode an interrupted build stays a build, instead of going back to planning", async () => {
      let step = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        step += 1;
        if (step === 1) return { tools: [{ name: "set_mode", args: { to: "build", reason: "simple" } }] };
        if (step === 2) return { tools: [{ name: "terminal", args: { command: "echo built" } }] };
        if (step === 3) return { text: "Building on. ".repeat(80), slow: true };
        return { text: "Resumed." };
      };
      const s = await app.newSession("agent resume", "agent");
      await app.say(s, "convert the scripts to modules");
      await app.until(s, (ev) => ev.some((e) => e.kind === "turn.agent.text"), "the build to be under way");
      await app.say(s, "and keep the tests green");
      const ev = await app.until(s, (e) => done(e).length >= 2, "the second turn to end", 20_000);
      const users = ev.filter((e) => e.kind === "turn.user");
      assert.equal(users.length, 2);
      const after = ev.filter((e) => e.seq > users[1].seq);
      assert.ok(!after.some((e) => e.kind === "mode.switch" && e.payload.to === "plan"), "it was sent back to planning");
      const first = ev.filter((e) => e.seq > users[0].seq && e.seq < users[1].seq);
      assert.ok(first.some((e) => e.kind === "mode.switch" && e.payload.to === "build"));
      app.decide = null;
    });
    await test("a turn the loop watch ends is followed by a turn that knows why, and the budget carries over", async () => {
      app.seen.length = 0;
      let n = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (n < 12) {
          n += 1;
          // Different arguments each time, the same failure.
          return { tools: [{ name: "terminal", args: { command: `cat /no/such/file-${n}.txt` } }] };
        }
        return { text: "Done." };
      };
      const s = await app.newSession("loop", "build");
      const ev = await app.turn(s, "read the config file", 60_000);
      const stop = ev.find((e) => e.kind === "system.log" && /Stopped: terminal failed with the same error/.test(e.payload.message ?? ""));
      assert.ok(stop, "the turn was stopped by the error budget: " + JSON.stringify(ev.filter((e) => /^(system|tool)\./.test(e.kind)).map((e) => [e.kind, JSON.stringify(e.payload).slice(0, 160)])));
      const end = ev.filter((e) => e.kind === "turn.agent.done").at(-1)!;
      assert.equal(end.payload.stopped, true);
      assert.match(end.payload.reason, /different attempts/);
      const before = app.seen.length;
      // The next turn meets the same wall once: what the chat has used is remembered.
      app.decide = (req) => (/You check one action/.test(req.system)
        ? { text: '{"destructive": false, "requested": true}' }
        : { tools: [{ name: "terminal", args: { command: "cat /no/such/file-99.txt" } }] });
      const again = await app.turn(s, "ok, try something else", 60_000);
      assert.ok(
        again.some((e) => e.kind === "system.log" && /Stopped: terminal failed with the same error/.test(e.payload.message ?? "")),
        "one more failure with the same error stopped the next turn at once",
      );
      const lastUser = again.filter((e) => e.kind === "turn.user").at(-1)!;
      assert.equal(again.filter((e) => e.seq > lastUser.seq && e.kind === "tool.call").length, 1);
      const next = app.seen.slice(before).map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n");
      assert.match(next, /\[Interrupted work\]/);
      assert.match(next, /going in circles/);
      assert.match(next, /Do not make those attempts again/);
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
