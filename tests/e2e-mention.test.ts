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

    await test("a message that names an agent has the lead start it, and the report comes back", async () => {
      app.seen.length = 0;
      let agentTask = "";
      app.decide = (req) => {
        if (req.last.includes("You are Bookkeeper")) {
          agentTask = req.last;
          return { text: "The ledger balances to 412." };
        }
        if (req.messages.some((m) => m.role === "tool")) return { text: "Bookkeeper says the ledger balances to 412." };
        return { tools: [{ name: "agent_run", args: { agent: "Bookkeeper", task: "Check whether the ledger balances." } }] };
      };
      const s = await app.newSession("mention", "build");
      const ev = await app.turn(s, "@Bookkeeper does the ledger balance?");
      assert.ok(noteSeen(), "the lead was told who the person addressed");
      assert.match(agentTask, /Check whether the ledger balances/, "and the agent got the task");
      assert.match(String(ev.filter((e) => e.kind === "turn.agent.text").at(-1)?.payload.text), /412/);
      app.decide = null;
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
