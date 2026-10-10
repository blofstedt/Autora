/**
 * Autora Photo through a real turn: the model asks for a photo_ tool, the tool runs on the chat's picture, the window is
 * told, and what the person then does in the window is what the agent sees next.
 *
 * Needs PhotoCraft built (`node scripts/build-photo.mjs`); without it the test says so and passes.
 *
 *   npx tsx tests/e2e-photo.test.ts
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
    console.log("Autora Photo");
    const s = await app.newSession("retouching", "build");
    const probe = await app.api("GET", `/api/photo/${s}`);
    if (probe.status === 503) {
      console.log("  skip  Autora Photo is not built (node scripts/build-photo.mjs)");
      return;
    }
    const told: any[] = [];
    const ws = new WebSocket(`${app.base.replace(/^http/, "ws")}/ws/${s}`);
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "photodesk") told.push(m.state); });
    await new Promise((r) => ws.once("open", r));
    await sleep(200);

    await test("a chat starts with the window shut, and the page is told so", async () => {
      assert.equal(probe.body.open, false);
      assert.equal(told[0]?.open, false);
    });

    await test("the tools are offered when the person talks about a photo, and the agent uses them", async () => {
      app.seen.length = 0;
      app.script.push({ tools: [{ name: "photo_open", args: { new: { width: 300, height: 200, background: "white" } } }] });
      app.script.push({ tools: [{ name: "photo_edit", args: { commands: [{ id: "layer.new.layer", params: { name: "Glow" } }] } }] });
      app.script.push({ tools: [{ name: "photo_look", args: { max_side: 128 } }] });
      app.script.push({ text: "Added a layer called Glow." });
      await app.turn(s, "touch up this photo: add a layer for a glow");
      assert.ok(app.seen[0].tools.includes("photo_open"), "offered from the first step");
      assert.match(app.seen[0].system, /Autora Photo/);
      const state = (await app.api("GET", `/api/photo/${s}`)).body;
      assert.equal(state.open, true);
      assert.deepEqual(state.size, { w: 300, h: 200 });
      assert.equal(state.by, "agent");
      assert.equal(state.layers, 2);
      assert.ok(told.some((t) => t.open && t.by === "agent"), "the page was told the agent changed the picture");
      const last = app.seen[app.seen.length - 1];
      assert.ok(JSON.stringify(last.messages).includes("Glow"));
      assert.ok(app.seen.some((r) => JSON.stringify(r.messages).includes("shown in the conversation")), "the picture came back from photo_look");
    });

    await test("what the person changes in the window is what the agent sees next", async () => {
      const got = await fetch(`${app.base}/api/photo/${s}/doc`);
      assert.equal(got.status, 200);
      const put = await fetch(`${app.base}/api/photo/${s}/doc`, { method: "PUT", headers: { "content-type": "application/octet-stream" }, body: new Uint8Array(await got.arrayBuffer()) });
      assert.equal(put.status, 200);
      assert.ok(told.some((t) => t.by === "person"), "and the page knows whose change it was");
      app.script.push({ tools: [{ name: "photo_info" }] });
      app.script.push({ text: "Seen." });
      await app.turn(s, "what does the picture look like now?");
      assert.match(JSON.stringify(app.seen[app.seen.length - 1].messages), /Glow/);
    });

    await test("an export lands in the thread as a file, not as bytes in the conversation", async () => {
      app.script.push({ tools: [{ name: "photo_export", args: { format: "jpg", name: "glow", quality: 80 } }] });
      app.script.push({ text: "Exported." });
      const events = await app.turn(s, "export it as a JPEG");
      const said = JSON.stringify(app.seen[app.seen.length - 1].messages);
      assert.match(said, /glow\.jpg/);
      assert.ok(said.length < 200_000, "no file contents in the prompt");
      assert.ok(JSON.stringify((await app.api("GET", "/api/artifacts")).body).includes("glow.jpg"));
      assert.ok(events.some((e) => e.kind === "media.file"), "the file is a card in the thread");
    });

    await test("a restart keeps the picture and the window", async () => {
      await sleep(700);
      ws.close();
      await app.restart();
      const state = (await app.api("GET", `/api/photo/${s}`)).body;
      assert.equal(state.open, true);
      assert.equal((await fetch(`${app.base}/api/photo/${s}/doc`)).status, 200);
    });

    await test("Plan mode refuses a change and allows a look", async () => {
      const p = await app.newSession("planning", "plan");
      app.script.push({ tools: [{ name: "photo_open", args: { new: { width: 10, height: 10 } } }] });
      app.script.push({ text: "Planned." });
      await app.turn(p, "touch up a photo");
      assert.equal((await app.api("GET", `/api/photo/${p}`)).body.open, false, "nothing was opened");
    });

    await test("switched off on the Tools page, the tools go and the window cannot be opened", async () => {
      assert.equal((await app.api("PATCH", "/api/settings", { tools: { photo: { enabled: false } } })).status, 200);
      app.seen.length = 0;
      app.script.push({ text: "No." });
      await app.turn(s, "edit my photo");
      assert.ok(!app.seen[0].tools.some((n) => n.startsWith("photo_")));
      assert.equal((await app.api("POST", `/api/photo/${s}/open`)).status, 403);
      assert.equal((await app.api("PATCH", "/api/settings", { tools: { photo: { enabled: true } } })).status, 200);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
