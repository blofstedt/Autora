/**
 * MCP end to end: a server connected through the API, its tools offered to the
 * model as mcp__<name>__<tool>, called, and shown; a server that breaks is
 * reported and does not take the turn down.
 *
 *   npx tsx tests/e2e-mcp.test.ts
 */
import assert from "node:assert/strict";
import { sleep, startApp, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const toolBack = (app: App) => JSON.stringify(app.seen.at(-1)!.messages.filter((m) => m.role === "tool"));

async function main() {
  const app = await startApp();
  try {
    // Write the server file where the app keeps them, with the app's own writer.
    process.env.AUTORA_HOME = app.home;
    const { writeScriptServer } = await import("../server/mcpscript");
    const file = writeScriptServer("lab", [
      { name: "greet", description: "Greet somebody.", parameters: { properties: { name: { type: "string" } }, required: ["name"] }, code: "return 'hello ' + args.name + ' from the lab';" },
      { name: "boom", description: "Always fails.", code: "throw new Error('the lab is on fire');" },
    ]);

    await test("a server is added, connects, and lists its tools", async () => {
      const made = await app.api("POST", "/api/mcp", { name: "lab", command: process.execPath, args: [file] });
      assert.equal(made.status, 200, JSON.stringify(made.body).slice(0, 300));
      const server = made.body.servers.find((s: any) => s.name === "lab");
      assert.ok(server, "not listed");
      for (let i = 0; i < 40 && server.status !== "connected"; i++) {
        await sleep(250);
        Object.assign(server, (await app.api("GET", "/api/mcp")).body.servers.find((s: any) => s.name === "lab"));
      }
      assert.equal(server.status, "connected", `${server.status}: ${server.error}`);
      assert.equal(server.tools.length, 2);
    });
    await test("the model is offered its tools under the prefix, and a call's result comes back", async () => {
      const s = await app.newSession();
      app.seen.length = 0;
      app.decide = (req) => req.messages.some((m) => m.role === "tool")
        ? { text: "Greeted." } : { tools: [{ name: "mcp__lab__greet", args: { name: "Ada" } }] };
      await app.turn(s, "greet Ada");
      assert.ok(app.seen[0].tools.includes("mcp__lab__greet"), app.seen[0].tools.filter((t) => /mcp/.test(t)).join(","));
      assert.match(toolBack(app), /hello Ada from the lab/);
      app.decide = null;
    });
    await test("a tool that throws is reported to the model as an error and the turn carries on", async () => {
      const s = await app.newSession();
      app.decide = (req) => req.messages.some((m) => m.role === "tool")
        ? { text: "It failed, sorry." } : { tools: [{ name: "mcp__lab__boom", args: {} }] };
      const ev = await app.turn(s, "break it");
      assert.match(toolBack(app), /on fire/);
      assert.equal(ev.at(-1)!.kind, "turn.agent.done");
      app.decide = null;
    });
    await test("a server that stops is shown as down, and its tools stop being offered", async () => {
      const list = (await app.api("GET", "/api/mcp")).body.servers;
      const id = list.find((s: any) => s.name === "lab").id;
      await app.api("PATCH", `/api/mcp/${id}`, { enabled: false });
      const s = await app.newSession();
      app.seen.length = 0;
      app.script.push({ text: "no tools" });
      await app.turn(s, "hello");
      assert.ok(!app.seen[0].tools.includes("mcp__lab__greet"), "a disabled server's tool is still offered");
    });
    await test("a server that cannot start is said to be, with why, and does not hang the app", async () => {
      const made = await app.api("POST", "/api/mcp", { name: "broken", command: "/definitely/not/a/binary", args: [] });
      assert.equal(made.status, 200);
      await sleep(1500);
      const broken = (await app.api("GET", "/api/mcp")).body.servers.find((s: any) => s.name === "broken");
      assert.notEqual(broken.status, "connected");
      assert.ok(broken.error, "no reason given");
    });
    await test("a name that is taken is refused", async () => {
      const again = await app.api("POST", "/api/mcp", { name: "LAB", command: "x" });
      assert.equal(again.status, 400);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
