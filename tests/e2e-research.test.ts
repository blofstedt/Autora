/**
 * The research worker through the real server: it looks in a clean context,
 * cannot change anything, and only its report reaches the main conversation.
 *
 *   npx tsx tests/e2e-research.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app: App = await startApp();
  try {
    const proj = path.join(app.home, "proj");
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src", "retry.ts"), "export async function withRetry(fn) {\n  for (let attempt = 0; attempt < 3; attempt++) {\n    try { return await fn(); } catch {}\n  }\n}\n");

    console.log("the research worker");
    for (const mode of ["build", "plan"]) {
      await test(`a worker looks in its own context and only its report comes back (${mode} mode)`, async () => {
        app.seen.length = 0;
        const marker = "UNIQUE-SEARCH-RESULT-LINE";
        app.decide = (req) => {
          if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
          if (/research worker for another agent/.test(req.system)) {
            const toolMsgs = req.messages.filter((m) => m.role === "tool");
            if (toolMsgs.length === 0) return { tools: [{ name: "code_search", args: { query: "retry attempt", path: proj } }] };
            if (toolMsgs.length === 1) return { tools: [{ name: "terminal", args: { command: `rm -rf ${proj}` } }] };
            return { text: "withRetry in src/retry.ts:1 retries 3 times with no backoff." };
          }
          if (req.messages.some((m) => m.role === "tool")) return { text: "It retries three times." };
          return { tools: [{ name: "research", args: { question: "Where is the retry logic and how many attempts does it make?" } }] };
        };
        const s = await app.newSession(`research ${mode}`, mode);
        const ev = await app.turn(s, "how does retrying work here?", 60_000);
        assert.ok(ev.some((e) => e.kind === "tool.call" && e.payload.name === "research"));
        assert.ok(!ev.some((e) => e.kind === "tool.error"), JSON.stringify(ev.filter((e) => e.kind === "tool.error").map((e) => e.payload)));
        assert.ok(fs.existsSync(path.join(proj, "src", "retry.ts")), "the worker deleted something");

        const worker = app.seen.filter((r) => /research worker for another agent/.test(r.system));
        const main = app.seen.filter((r) => !/research worker for another agent/.test(r.system) && !/You check one action/.test(r.system));
        assert.ok(worker.length >= 3, `the worker made ${worker.length} requests`);
        assert.ok(worker.every((r) => !r.tools.includes("research")), "the worker cannot start another worker");
        assert.ok(worker.every((r) => !r.tools.includes("file_write")));
        // A clean context: its first request holds the question and nothing of the conversation.
        assert.deepEqual(worker[0].messages.filter((m) => m.role !== "system").map((m) => m.role), ["user"]);
        assert.match(JSON.stringify(worker[0].messages), /Where is the retry logic/);
        assert.doesNotMatch(JSON.stringify(worker[0].messages), /how does retrying work here/);
        // The delete was refused, in the worker's own context.
        assert.match(JSON.stringify(worker.at(-1)!.messages), /only looks/);
        // What the main agent was told is the report, not the searching.
        const told = JSON.stringify(main.at(-1)!.messages.filter((m) => m.role === "tool"));
        assert.match(told, /withRetry in src\/retry\.ts:1 retries 3 times/);
        assert.doesNotMatch(told, /score/);
        assert.doesNotMatch(told, new RegExp(marker));
        app.decide = null;
      });
    }

    await test("a missing question is refused before the worker starts", async () => {
      app.seen.length = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (req.messages.some((m) => m.role === "tool")) return { text: "ok" };
        return { tools: [{ name: "research", args: {} }] };
      };
      const s = await app.newSession("noquestion", "build");
      await app.turn(s, "look into it");
      assert.match(JSON.stringify(app.seen.at(-1)!.messages.filter((m) => m.role === "tool")), /Say what to find out/);
      app.decide = null;
    });

    await test("several questions are looked into by separate workers and come back together", async () => {
      app.seen.length = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (/research worker for another agent/.test(req.system)) {
          const q = JSON.stringify(req.messages);
          return { text: /first thing/.test(q) ? "Answer about the first thing." : "Answer about the second thing." };
        }
        if (req.messages.some((m) => m.role === "tool")) return { text: "Both answered." };
        return { tools: [{ name: "research", args: { questions: ["Tell me the first thing.", "Tell me the second thing."] } }] };
      };
      const s = await app.newSession("parallel", "build");
      await app.turn(s, "look into two things", 60_000);
      const workers = app.seen.filter((r) => /research worker for another agent/.test(r.system));
      assert.equal(workers.length, 2, "one worker each");
      const told = JSON.stringify(app.seen.at(-1)!.messages.filter((m) => m.role === "tool"));
      assert.match(told, /Question 1: Tell me the first thing/);
      assert.match(told, /Answer about the first thing/);
      assert.match(told, /Question 2: Tell me the second thing/);
      assert.match(told, /Answer about the second thing/);
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
