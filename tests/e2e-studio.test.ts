/**
 * Autora Music through a real turn: the model asks for a studio_ tool, the tool runs on the chat's song, the window is
 * told, and what the person then does in the window is what the agent sees next.
 *
 *   npx tsx tests/e2e-studio.test.ts
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
    console.log("Autora Music");
    const s = await app.newSession("music", "build");
    const told: any[] = [];
    const ws = new WebSocket(`${app.base.replace(/^http/, "ws")}/ws/${s}`);
    ws.on("message", (raw) => { const m = JSON.parse(String(raw)); if (m.type === "studiodesk") told.push(m.state); });
    await new Promise((r) => ws.once("open", r));
    await sleep(200);

    await test("a chat starts with the window shut, and the page is told so", async () => {
      assert.equal((await app.api("GET", `/api/studio/${s}`)).body.open, false);
      assert.equal(told[0]?.open, false);
    });

    await test("the tools come in when the person talks about music, and the agent makes chords", async () => {
      app.seen.length = 0;
      app.script.push({ tools: [{ name: "studio_make", args: { kind: "chords", progression: "Am F C G", style: "arpeggio", bars: 4 } }] });
      app.script.push({ text: "Laid down the chords." });
      await app.turn(s, "start a chord progression for a song in A minor");
      assert.ok(app.seen[0].tools.includes("studio_make"), "offered from the first step");
      assert.match(app.seen[0].system, /Autora Music/);
      const state = (await app.api("GET", `/api/studio/${s}`)).body;
      assert.equal(state.open, true);
      assert.equal(state.tracks, 1);
      assert.equal(state.by, "agent");
      assert.ok(told.some((t) => t.open && t.by === "agent" && t.tracks === 1), "the page was told the agent changed the song");
      assert.match(JSON.stringify(app.seen[app.seen.length - 1].messages), /Am F C G/);
    });

    await test("what the person changes in the window is what the agent sees next, and the turn is told the window is open", async () => {
      const { body } = await app.api("GET", `/api/studio/${s}/doc`);
      body.doc.tracks[0].name = "Wurli";
      body.doc.bpm = 84;
      assert.equal((await app.api("PUT", `/api/studio/${s}/doc`, { doc: body.doc, rev: body.rev })).status, 200);
      assert.equal((await app.api("POST", `/api/studio/${s}/focus`, { trackId: body.doc.tracks[0].id, clipId: body.doc.tracks[0].clips[0].id })).status, 200);
      assert.ok(told.some((t) => t.by === "person"), "and the page knows whose change it was");
      app.seen.length = 0;
      app.script.push({ tools: [{ name: "studio_look" }] });
      app.script.push({ text: "Seen." });
      await app.turn(s, "what does the song look like now?");
      assert.match(app.seen[0].system + JSON.stringify(app.seen[0].messages), /music window is open on/);
      const result = JSON.stringify(app.seen[app.seen.length - 1].messages);
      assert.match(result, /Wurli/);
      assert.match(result, /84 bpm/);
      assert.match(result, /this clip.{1,3} means that one/);
    });

    await test("a restart keeps the song and the window", async () => {
      await sleep(700);
      ws.close();
      const before = (await app.api("GET", `/api/studio/${s}`)).body.rev;
      await app.restart();
      const state = (await app.api("GET", `/api/studio/${s}`)).body;
      assert.equal(state.open, true);
      assert.ok(state.rev > before, "a window left open across a restart finds a newer revision, not an older one");
      const { body } = await app.api("GET", `/api/studio/${s}/doc`);
      assert.equal(body.doc.tracks[0].name, "Wurli");
      assert.equal(body.doc.bpm, 84);
    });

    await test("Plan mode reads the song but does not change it", async () => {
      const p = await app.newSession("planning", "plan");
      app.script.push({ tools: [{ name: "studio_make", args: { kind: "drums" } }] });
      app.script.push({ text: "Planned." });
      await app.turn(p, "make a beat");
      const { body } = await app.api("GET", `/api/studio/${p}/doc`);
      assert.equal(body.doc.tracks.length, 0);
    });

    await test("switched off on the Tools page, the tools go and the window cannot be opened", async () => {
      assert.equal((await app.api("PATCH", "/api/settings", { tools: { studio: { enabled: false } } })).status, 200);
      app.seen.length = 0;
      app.script.push({ text: "No." });
      await app.turn(s, "make a beat for a song");
      assert.ok(!app.seen[0].tools.some((n) => n.startsWith("studio_")));
      assert.match(app.seen[0].system, /Autora Music.*switched off/);
      assert.equal((await app.api("POST", `/api/studio/${s}/open`)).status, 403);
      assert.equal((await app.api("PATCH", "/api/settings", { tools: { studio: { enabled: true } } })).status, 200);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
