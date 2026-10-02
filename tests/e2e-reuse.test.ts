/**
 * Results the agent can reuse: a long output's vault handle in the recap, and
 * read_file through the real server.
 *
 *   npx tsx tests/e2e-reuse.test.ts
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
    console.log("reusing results");
    await test("the recap names the vault artifact a long output went to", async () => {
      app.seen.length = 0;
      const s = await app.newSession("long", "build");
      app.script.push({ tools: [{ name: "terminal", args: { command: "seq 1 40000" } }] });
      app.script.push({ text: "Counted." });
      await app.turn(s, "count to forty thousand");
      const before = app.seen.length;
      app.script.push({ text: "Done." });
      await app.turn(s, "what was the last number?");
      const next = app.seen.slice(before).map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n");
      assert.match(next, /full output in vault art_[0-9a-f]+ \(\d[\d,]* lines; vault_read it\)/);
    });

    await test("read_file reads a range and an outline from the working folder", async () => {
      app.seen.length = 0;
      const s = await app.newSession("read", "build");
      app.script.push({ tools: [{ name: "terminal", args: { command: "printf 'export function alpha() {\\n  return 1;\\n}\\nexport function beta() {\\n  return 2;\\n}\\n' > rf-demo.ts" } }] });
      app.script.push({ tools: [{ name: "read_file", args: { path: "rf-demo.ts", outline: true } }, { name: "read_file", args: { path: "rf-demo.ts", symbol: "beta" } }] });
      app.script.push({ text: "Read." });
      await app.turn(s, "make a file and read it");
      const all = app.seen.map((r) => JSON.stringify(r.messages)).join("\n");
      assert.match(all, /outline/);
      assert.match(all, /function beta/);
      assert.match(all, /lines 4-6 of rf-demo\.ts/);
    });

    await test("a command that names a missing file is told what is near it", async () => {
      app.seen.length = 0;
      const s = await app.newSession("near", "build");
      app.script.push({ tools: [{ name: "terminal", args: { command: "mkdir -p hint-lib && echo hi > hint-lib/userStore.ts" } }] });
      app.script.push({ tools: [{ name: "terminal", args: { command: "cat userStore.ts" } }] });
      app.script.push({ text: "It is under hint-lib." });
      await app.turn(s, "show me userStore.ts");
      const all = app.seen.map((r) => JSON.stringify(r.messages)).join("\n");
      assert.match(all, /Nearby: hint-lib\/userStore\.ts/);
      app.script.push({ tools: [{ name: "terminal", args: { command: "rm -rf hint-lib" } }] });
      app.script.push({ text: "Cleaned." });
      await app.turn(s, "clean up");
    });

    await test("the trace says where a chat's calls went", async () => {
      const s = await app.newSession("trace", "build");
      app.script.push({ tools: [{ name: "terminal", args: { command: "echo traced" } }] });
      app.script.push({ text: "Done." });
      await app.turn(s, "trace me");
      const t: any = (await app.api("GET", `/api/sessions/${s}/trace`)).body;
      assert.equal(t.turns, 1);
      assert.ok(t.tools.some((x: any) => x.name === "terminal" && x.calls === 1));
      assert.match(t.text, /1 turn, \d+ model calls?/);
      assert.match(t.text, /- terminal: 1 call/);
    });
  } finally {
    await app.stop();
  }
  console.log(`${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
