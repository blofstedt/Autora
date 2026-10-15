/**
 * Autora Photo, Visible work: the agent's photo_edit is handed to the open window to do by hand, the first window to
 * claim it does it and answers with the picture, and with nobody to claim it (or Visible work off) it runs on the
 * server at speed. The editor's side is in photo/overlay/autora.rs; here a stand-in command line and a stand-in window.
 *
 *   npx tsx tests/photo-hand.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-photo-hand-"));
process.env.AUTORA_STATE_DIR = path.join(dir, "state");
// A stand-in build: an editor page, and a command line that answers every request and writes what doc.save names.
const build = path.join(dir, "photo");
fs.mkdirSync(path.join(build, "web"), { recursive: true });
fs.mkdirSync(path.join(build, "native"), { recursive: true });
fs.writeFileSync(path.join(build, "web", "index.html"), "<!doctype html><title>stand-in</title>");
const cli = path.join(build, "native", "photocraft-cli");
fs.writeFileSync(
  cli,
  `#!/usr/bin/env node
const fs = require("node:fs");
let input = "";
process.stdin.on("data", (d) => (input += d));
process.stdin.on("end", () => {
  for (const line of input.split("\\n").filter(Boolean)) {
    const r = JSON.parse(line);
    if (r.method === "doc.save") fs.writeFileSync(r.params.path, "saved by the command line");
    const result = r.method === "doc.inspect" ? { size: { width: 64, height: 48 }, layers: [{ name: "Background" }] }
      : r.method === "batch" ? { results: (r.params.steps || []).map(() => ({ ok: true })) } : {};
    process.stdout.write(JSON.stringify({ id: r.id, ok: true, result }) + "\\n");
  }
});
`,
  { mode: 0o755 },
);
process.env.AUTORA_PHOTO_DIR = build;

const express = (await import("express")).default;
const photo = await import("../server/photodesk");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const session = "hand-chat";
let visible = true;
const pushes: Array<Record<string, unknown>> = [];
let onPush: (m: Record<string, unknown>) => void = () => undefined;
const app = express();
photo.photoRoutes(app, {
  exists: (id) => id === session,
  incognito: () => false,
  off: () => false,
  push: (_id, m) => { pushes.push(m); onPush(m); },
  visible: () => visible,
});
const server = app.listen(0, "127.0.0.1");
await new Promise((r) => server.once("listening", r));
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api/photo/${session}`;

// A picture, and the window open on it.
fs.mkdirSync(path.join(process.env.AUTORA_STATE_DIR, "photo", session), { recursive: true });
fs.writeFileSync(path.join(process.env.AUTORA_STATE_DIR, "photo", session, "work.pcraft"), "the picture");
await fetch(`${base}/open`, { method: "POST" });

const commands = [{ id: "filter.blur.gaussianBlur", params: { radius: 3 } }, { id: "layer.new.layer", params: {} }];
const edit = () => photo.runPhotoTool(session, "photo_edit", { commands }, { cwd: dir });

/** A window that claims what it is sent and answers as the editor would. */
function windowAnswers(results: unknown[], bytes: string) {
  onPush = (m) => {
    if (m.type !== "photodesk.hand") return;
    void (async () => {
      const claim = (await (await fetch(`${base}/hand/claim?id=${m.id}`, { method: "POST" })).json()) as { won: boolean };
      if (!claim.won) return;
      await fetch(`${base}/hand/reply?id=${m.id}`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-Photo-Hand": encodeURIComponent(JSON.stringify({ results })) },
        body: bytes,
      });
    })();
  };
}

await test("with Visible work on, the window is handed the edit and its picture is kept as the agent's", async () => {
  windowAnswers([{ command: "filter.blur.gaussianBlur", ok: true, how: "ui" }, { command: "layer.new.layer", ok: true, how: "ui" }], "edited by hand");
  const out = await edit();
  assert.equal(out.ok, true, out.summary);
  assert.match(out.summary, /by hand in the window/);
  const sent = pushes.find((m) => m.type === "photodesk.hand") as { commands: unknown } | undefined;
  assert.deepEqual(sent?.commands, commands);
  assert.equal(fs.readFileSync(path.join(process.env.AUTORA_STATE_DIR!, "photo", session, "work.pcraft"), "utf8"), "edited by hand");
  const now = photo.photoState(session);
  assert.equal(now.by, "agent");
  // The window made this revision itself, so it is told not to load it again.
  assert.equal(now.hand, now.rev);
});

await test("a second window cannot claim an edit the first one took", async () => {
  let second: boolean | undefined;
  onPush = (m) => {
    if (m.type !== "photodesk.hand") return;
    void (async () => {
      const a = (await (await fetch(`${base}/hand/claim?id=${m.id}`, { method: "POST" })).json()) as { won: boolean };
      const b = (await (await fetch(`${base}/hand/claim?id=${m.id}`, { method: "POST" })).json()) as { won: boolean };
      second = b.won;
      if (a.won) await fetch(`${base}/hand/reply?id=${m.id}`, { method: "POST", headers: { "X-Photo-Hand": encodeURIComponent(JSON.stringify({ results: [{ ok: true }, { ok: true }] })) }, body: "again" });
    })();
  };
  assert.equal((await edit()).ok, true);
  assert.equal(second, false);
});

await test("a command that failed in the window stops the edit and says which", async () => {
  windowAnswers([{ command: "filter.blur.gaussianBlur", ok: false, error: "no pixels selected", how: "ui" }], "partly");
  const out = await edit();
  assert.equal(out.ok, false);
  assert.match(out.summary, /Stopped at command 1/);
  assert.match(out.summary, /no pixels selected/);
});

await test("with nobody to claim it, the edit runs on the server at speed", async () => {
  onPush = () => undefined;
  pushes.length = 0;
  const started = Date.now();
  const out = await edit();
  assert.equal(out.ok, true, out.summary);
  assert.doesNotMatch(out.summary, /by hand/);
  assert.ok(pushes.length > 0, "the window was asked first");
  assert.ok(Date.now() - started < 9000);
  assert.equal(fs.readFileSync(path.join(process.env.AUTORA_STATE_DIR!, "photo", session, "work.pcraft"), "utf8"), "saved by the command line");
  assert.equal(photo.photoState(session).hand, undefined);
});

await test("with Visible work off, the window is not asked at all", async () => {
  visible = false;
  pushes.length = 0;
  const out = await edit();
  assert.equal(out.ok, true, out.summary);
  assert.equal(pushes.filter((m) => m.type === "photodesk.hand").length, 0);
});

server.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log(`photo-hand: ${passed} passed`);
