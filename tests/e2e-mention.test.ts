/**
 * @Name in a message: the lead is told the person addressed that colleague, starts it with agent_run, and gives the
 * report back. A message with no @ carries no such note, and an address is not a mention.
 *
 *   npx tsx tests/e2e-mention.test.ts
 */
import assert from "node:assert/strict";
import { startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app = await startApp();
  try {
    const made = await app.api("POST", "/api/agents", { name: "Bookkeeper", role: "Accountant", when: "tax and ledgers" });
    assert.equal(made.status, 200, JSON.stringify(made.body));
    const noteSeen = () => app.seen.some((r) => JSON.stringify(r.messages).includes("addressed Bookkeeper directly with @"));

    await test("a message that names an agent has the lead start it; the agent's report is the answer and the lead does not retell it", async () => {
      app.seen.length = 0;
      let agentTask = "";
      let leadAfterReport = 0;
      app.decide = (req) => {
        if (req.last.includes("You are Bookkeeper")) {
          agentTask = req.last;
          return { text: "The ledger balances to 412." };
        }
        if (req.messages.some((m) => m.role === "tool")) {
          leadAfterReport += 1;
          return { text: "Bookkeeper says the ledger balances to 412." };
        }
        return { tools: [{ name: "agent_run", args: { agent: "Bookkeeper", task: "Check whether the ledger balances." } }] };
      };
      const s = await app.newSession("mention", "build");
      const ev = await app.turn(s, "@Bookkeeper does the ledger balance?");
      assert.ok(noteSeen(), "the lead was told who the person addressed");
      assert.match(agentTask, /Check whether the ledger balances/, "and the agent got the task");
      assert.match(String(ev.filter((e) => e.kind === "agent.back").at(-1)?.payload.reply), /412/, "the agent reported in the chat");
      assert.equal(leadAfterReport, 0, "no extra round to retell what the agent already said");
      assert.equal(ev.filter((e) => e.kind === "turn.agent.text").length, 0, "and no summary line either");
      assert.equal(ev.filter((e) => e.kind === "turn.agent.done").length >= 1, true, "the turn still ends cleanly");
      app.decide = null;
    });

    await test("when the agent fails, the lead goes on and says so", async () => {
      app.seen.length = 0;
      app.decide = (req) => {
        if (req.last.includes("You are Bookkeeper")) return { status: 400, error: "the ledger is locked" };
        if (req.messages.some((m) => m.role === "tool")) return { text: "Bookkeeper could not open the ledger." };
        return { tools: [{ name: "agent_run", args: { agent: "Bookkeeper", task: "Check the ledger." } }] };
      };
      const s = await app.newSession("mention-fail", "build");
      const ev = await app.turn(s, "@Bookkeeper check the ledger");
      assert.match(ev.filter((e) => e.kind === "turn.agent.text").map((e) => String(e.payload.text)).join(""), /could not open/);
      app.decide = null;
    });

    await test("small talk in Agent mode is answered at once: no plan, no switch to build", async () => {
      app.seen.length = 0;
      app.script.push({ text: "Hi! Nothing queued on my side." });
      const s = await app.newSession("hello");
      await app.api("PATCH", `/api/sessions/${s}`, { mode: "agent" });
      const ev = await app.turn(s, "just saying hi");
      assert.equal(app.seen.length, 1, "one model call");
      assert.equal(ev.filter((e) => e.kind === "mode.switch").length, 0, "no plan phase to switch out of");
      assert.match(ev.filter((e) => e.kind === "turn.agent.text").map((e) => String(e.payload.text)).join(""), /Hi!/);
    });

    await test("a real task in Agent mode still starts by planning", async () => {
      app.seen.length = 0;
      app.script.push({ text: "On it." });
      const s = await app.newSession("task");
      await app.api("PATCH", `/api/sessions/${s}`, { mode: "agent" });
      const ev = await app.turn(s, "rename every file in the downloads folder by date");
      assert.equal(ev.filter((e) => e.kind === "mode.switch" && e.payload.to === "plan").length, 1);
    });

    await test("no @, no note; an address is not a mention", async () => {
      for (const text of ["does the ledger balance?", "mail bob@Bookkeeper.com the ledger"]) {
        app.seen.length = 0;
        app.script.push({ text: "ok" });
        const s = await app.newSession("plain", "build");
        await app.turn(s, text);
        assert.ok(!noteSeen(), `"${text}" should not route to the agent`);
      }
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
