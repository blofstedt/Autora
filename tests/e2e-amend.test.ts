/**
 * Complex, changing work, end to end: asks kept whole, changes added while the
 * agent works without stopping it, the agent made to account for every ask,
 * and the project check run when an item is finished. A scripted model; what
 * is checked is what it is told and what the log holds.
 *
 *   npx tsx tests/e2e-amend.test.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { startApp, type App, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const guardOk = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);
const told = (app: App, from = 0) => app.seen.slice(from).map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n");
const logs = (ev: Ev[]) => ev.filter((e) => e.kind === "system.log").map((e) => String(e.payload.message));
const lastList = (ev: Ev[]) => [...ev].reverse().find((e) => e.kind === "requirements.update")?.payload.items as any[] | undefined;

async function main() {
  const app: App = await startApp();
  try {
    console.log("asks kept whole");
    await test("a message that lists its asks has each one recorded, and told back every turn", async () => {
      app.seen.length = 0;
      app.script.push({ text: "On it." });
      const s = await app.newSession("list", "build");
      const ev = await app.turn(s, "Please:\n1. add a dark mode toggle\n2. fix the login redirect\n3. remove the old banner");
      const items = lastList(ev)!;
      assert.deepEqual(items.map((r) => r.text), ["add a dark mode toggle", "fix the login redirect", "remove the old banner"]);
      assert.match(told(app), /R2: fix the login redirect/);
    });

    console.log("adding to work in progress");
    await test("a message sent while it works is added, not a reason to stop", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "echo first" } }] };
        if (step === 2) return { tools: [{ name: "terminal", args: { command: "sleep 2; echo second" } }] };
        if (step === 3) return { tools: [{ name: "requirements", args: { add: ["add tests for the toggle"], done: [{ id: "R1", how: "ran it" }] } }] };
        return { text: "Both done." };
      };
      const s = await app.newSession("amend", "build");
      await app.say(s, "1. build the settings page\n2. wire up the save button");
      await app.until(s, (ev) => ev.some((e) => e.kind === "tool.call" && e.payload.args?.command === "sleep 2; echo second"), "the slow step to start");
      const sent = await app.api("POST", `/api/sessions/${s}/message`, { text: "also add tests for the toggle" });
      assert.equal(sent.body.queued, true, "it was queued onto the running turn");
      const ev = await app.until(s, (e) => e.some((x) => x.kind === "turn.agent.done"), "the turn to end", 30_000);
      assert.equal(ev.filter((e) => e.kind === "turn.agent.done").length, 1, "one turn, not two");
      assert.ok(!ev.some((e) => e.kind === "turn.agent.done" && e.payload.stopped), "it was not stopped");
      assert.ok(ev.some((e) => e.kind === "turn.amend" && /also add tests/.test(e.payload.text)), "it is in the thread");
      const note = told(app);
      assert.match(note, /added this while you were working -- you were not stopped/);
      assert.match(note, /also add tests for the toggle/);
      const items = lastList(ev)!;
      assert.ok(items.some((r) => /add tests for the toggle/.test(r.text) && r.source), "kept as a requirement");
      app.decide = null;
    });

    await test("a message that lands as the agent is finishing is not lost", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "echo a" } }] };
        if (step === 2) return { text: "That is everything, all finished. ".repeat(60), slow: true };
        return { text: "Added the last thing too." };
      };
      const s = await app.newSession("late", "build");
      await app.say(s, "do the first thing");
      await app.until(s, (ev) => ev.some((e) => e.kind === "turn.agent.text"), "the final answer to start");
      const sent = await app.api("POST", `/api/sessions/${s}/message`, { text: "one more thing: print the date" });
      assert.equal(sent.body.queued, true);
      const ev = await app.until(s, (e) => e.some((x) => x.kind === "turn.agent.done") && step >= 3, "the turn to take it up", 30_000);
      assert.ok(!ev.some((e) => e.kind === "turn.agent.done" && e.payload.stopped), "not stopped");
      assert.match(told(app), /one more thing: print the date/);
      assert.ok(step >= 3, "the model was asked again after the late message");
      app.decide = null;
    });

    await test("an explicit interrupt still stops it first", async () => {
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "echo working" } }] };
        if (step === 2) return { text: "Still going. ".repeat(80), slow: true };
        return { text: "Switched." };
      };
      const s = await app.newSession("interrupt", "build");
      await app.say(s, "do the long job");
      await app.until(s, (ev) => ev.some((e) => e.kind === "turn.agent.text"), "the reply to start");
      const sent = await app.api("POST", `/api/sessions/${s}/message`, { text: "forget that, do this instead", mode: "interrupt" });
      assert.notEqual(sent.body.queued, true);
      const ev = await app.until(s, (e) => e.filter((x) => x.kind === "turn.agent.done").length >= 2, "both turns to end", 20_000);
      assert.equal(ev.filter((e) => e.kind === "turn.agent.done")[0].payload.stopped, true);
      app.decide = null;
    });

    console.log("accounting for every ask");
    await test("finishing with an ask open sends the agent back once, and a drop with a reason ends it", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "echo did-the-first" } }] };
        if (step === 2) return { text: "All finished." };
        if (step === 3) return { tools: [{ name: "requirements", args: { done: [{ id: "R1", how: "echoed" }], drop: [{ id: "R2", why: "not possible offline" }] } }] };
        return { text: "R1 done; R2 dropped because it needs the network." };
      };
      const s = await app.newSession("audit", "build");
      const ev = await app.turn(s, "1. echo something\n2. fetch the live price", 30_000);
      assert.ok(logs(ev).some((m) => /not marked done as the turn ended/.test(m)), logs(ev).join(" | "));
      assert.match(told(app), /\[Before you finish\] These asks are not marked done:[\s\S]*R2: fetch the live price/);
      const items = lastList(ev)!;
      assert.equal(items.find((r) => r.id === "R2").status, "dropped");
      assert.equal(items.find((r) => r.id === "R2").note, "not possible offline");
      assert.equal(step, 4);
      app.decide = null;
    });

    console.log("checking as it goes");
    await test("the project check runs when an item is finished, and a failure is told then", async () => {
      const flag = path.join(app.home, "item-ready.txt");
      const check = `test -f ${flag} || { echo "FAIL missing item-ready.txt"; exit 4; }`;
      assert.equal((await app.api("PATCH", "/api/settings", { verify: { command: check, tries: 3 } })).status, 200);
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: `echo built > ${path.join(app.home, "o.txt")}` } }] };
        if (step === 2) return { tools: [{ name: "requirements", args: { done: [{ id: "R1", how: "built it" }] } }] };
        if (step === 3) return { tools: [{ name: "terminal", args: { command: `touch ${flag}` } }] };
        if (step === 4) return { tools: [{ name: "requirements", args: { done: [{ id: "R1", how: "fixed" }] } }] };
        return { text: "Done." };
      };
      const s = await app.newSession("itemcheck", "build");
      const ev = await app.turn(s, "1. build the thing\n2. nothing else really", 60_000);
      const said = logs(ev);
      assert.ok(said.some((m) => /check failed after an item was finished/.test(m)), said.join(" | "));
      assert.match(told(app), /after you marked that item done: .* exited 4/);
      assert.match(told(app), /FAIL missing item-ready\.txt/);
      await app.api("PATCH", "/api/settings", { verify: { command: "", tries: 3 } });
      app.decide = null;
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
