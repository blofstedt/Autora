/**
 * Autora Games through a real turn: the model asks for a game_ tool, the tool runs on the chat's game, the window is told,
 * and what the person then does in the editor is what the agent sees next.
 *
 *   npx tsx tests/e2e-game.test.ts
 */
import assert from "node:assert/strict";
import WebSocket from "ws";
import { startApp, sleep, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app: App = await startApp();
  try {
    console.log("Autora Games");
    const s = await app.newSession("a game", "build");
    const told: any[] = [];
    const ws = new WebSocket(`${app.base.replace(/^http/, "ws")}/ws/${s}`);
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "gamedesk") told.push(m.state); });
    await new Promise((r) => ws.once("open", r));
    await sleep(200);

    await test("a chat starts with the window shut, and the page is told so", async () => {
      assert.equal((await app.api("GET", `/api/game/${s}`)).body.open, false);
      assert.equal(told[0]?.open, false);
    });

    await test("the tools are offered when the person talks about making a game, and the agent uses them", async () => {
      app.seen.length = 0;
      app.script.push({ tools: [{ name: "game_open", args: { name: "Cat jump" } }] });
      app.script.push({ tools: [{ name: "game_edit", args: { ops: [{ op: "set", path: "properties.description", value: "A cat that jumps." }] } }] });
      app.script.push({ text: "Started the game." });
      await app.turn(s, "make me a platformer game about a cat");
      assert.ok(app.seen[0].tools.includes("game_open"), "offered from the first step");
      assert.match(app.seen[0].system, /Autora Games/);
      assert.match(app.seen[0].system, /creative choices/);
      const state = (await app.api("GET", `/api/game/${s}`)).body;
      assert.equal(state.open, true);
      assert.equal(state.name, "Cat jump");
      assert.equal(state.by, "agent");
      assert.ok(told.some((t) => t.open && t.by === "agent" && t.name === "Cat jump"), "the page was told the agent changed the game");
      assert.match(JSON.stringify(app.seen[app.seen.length - 1].messages), /Cat jump/);
    });

    await test("what the person changes in the editor is what the agent sees next", async () => {
      const { body } = await app.api("GET", `/api/game/${s}/project`);
      body.project.properties.author = "Mia";
      assert.equal((await app.api("PUT", `/api/game/${s}/project`, { project: body.project, ifRev: body.rev })).status, 200);
      assert.ok(told.some((t) => t.by === "person"), "and the page knows whose change it was");
      app.script.push({ tools: [{ name: "game_look", args: { what: "json", path: "properties.author" } }] });
      app.script.push({ text: "Seen." });
      await app.turn(s, "what is the author now?");
      assert.match(JSON.stringify(app.seen[app.seen.length - 1].messages), /Mia/);
    });

    await test("a mistake in an instruction is reported back to the agent, with where", async () => {
      app.script.push({ tools: [{ name: "game_edit", args: { ops: [{ op: "insert", path: "layouts[Scene].events", value: { type: "BuiltinCommonInstructions::Standard", conditions: [], actions: [{ type: { value: "Jump" }, parameters: ["Cat"], subInstructions: [] }], events: [] } }] } }] });
      app.script.push({ text: "Added it." });
      await app.turn(s, "make the cat jump");
      assert.match(JSON.stringify(app.seen[app.seen.length - 1].messages), /layouts\[Scene\]\.events\[0\]\.actions\[0\]/);
      assert.match(JSON.stringify(app.seen[app.seen.length - 1].messages), /game_catalog/);
    });

    await test("the editor's page is served with a policy that lets it talk to this app and nobody else", async () => {
      const res = await fetch(`${app.base}/gdevelop-editor/index.html`);
      assert.equal(res.status, 200);
      const csp = res.headers.get("content-security-policy") ?? "";
      assert.match(csp, /connect-src 'self' data: blob:/);
      assert.match(csp, /frame-ancestors 'self'/);
      assert.ok(!/https?:\/\//.test(csp), "no outside host is allowed");
      const runtime = await fetch(`${app.base}/gdevelop-editor/GDJS/Runtime/index.html`);
      assert.equal(runtime.status, 200, "the runtime a game is made of comes with the editor");
      assert.equal(runtime.headers.get("access-control-allow-origin"), "*");
    });

    await test("a restart keeps the game and the window", async () => {
      await sleep(700);
      ws.close();
      await app.restart();
      const state = (await app.api("GET", `/api/game/${s}`)).body;
      assert.equal(state.open, true);
      const { body } = await app.api("GET", `/api/game/${s}/project`);
      assert.equal(body.project.properties.author, "Mia");
      assert.equal(body.project.properties.name, "Cat jump");
    });

    await test("switched off on the Tools page, the tools go and the window cannot be opened", async () => {
      assert.equal((await app.api("PATCH", "/api/settings", { tools: { game: { enabled: false } } })).status, 200);
      app.seen.length = 0;
      app.script.push({ text: "No." });
      await app.turn(s, "make a game with GDevelop");
      assert.ok(!app.seen[0].tools.some((n) => n.startsWith("game_")));
      assert.equal((await app.api("POST", `/api/game/${s}/open`)).status, 403);
      assert.equal((await app.api("PATCH", "/api/settings", { tools: { game: { enabled: true } } })).status, 200);
    });

    await test("a chat that is deleted takes its game with it", async () => {
      assert.equal((await app.api("DELETE", `/api/sessions/${s}`)).status, 200);
      assert.equal((await app.api("GET", `/api/game/${s}`)).status, 404);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
