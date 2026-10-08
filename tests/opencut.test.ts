/**
 * The video window's server half (server/opencut.ts): what the editor keeps
 * (projects as JSON, media as bytes) and that no name can reach outside it; a
 * command reaches the window once, is answered once, and is sent again until a
 * window takes it; and the tools say what they did. No browser: the window is
 * played by the test, over the same routes.
 *
 *   npx tsx tests/opencut.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import type { AddressInfo } from "node:net";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-opencut-"));
process.env.AUTORA_STATE_DIR = dir;

const { default: express } = await import("express");
const oc = await import("../server/opencut");
const { loadedFamilies } = await import("../server/toolload");
const { looksOnly } = await import("../server/modes");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const pushes: Record<string, any>[] = [];
const app = express();
app.use(express.json());
oc.opencutRoutes(app, { exists: (id) => id === "s1", push: (_id, message) => { pushes.push(message); } });
const server = http.createServer(app);
await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

const kv = async (body: Record<string, unknown>) => {
  const res = await fetch(`${base}/api/opencut/kv`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify(body) });
  return { status: res.status, body: (await res.json()) as { value?: any; error?: { message: string } } };
};
const post = (url: string, body?: unknown) => fetch(`${base}${url}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body ?? {}) });

try {
  console.log("the store");
  await test("what the editor keeps comes back as it was, and lists and clears", async () => {
    const project = { id: "p1", metadata: { name: "One", duration: 5, updatedAt: "2026-01-02T00:00:00Z" } };
    assert.equal((await kv({ op: "set", ns: "video-editor-projects/projects", key: "p1", value: project })).status, 200);
    await kv({ op: "set", ns: "video-editor-projects/projects", key: "p2", value: { id: "p2", metadata: { name: "Two", updatedAt: "2026-03-01T00:00:00Z" } } });
    assert.deepEqual((await kv({ op: "get", ns: "video-editor-projects/projects", key: "p1" })).body.value, project);
    assert.equal((await kv({ op: "get", ns: "video-editor-projects/projects", key: "nope" })).body.value, null);
    assert.deepEqual(((await kv({ op: "list", ns: "video-editor-projects/projects" })).body.value as string[]).sort(), ["p1", "p2"]);
    assert.equal(((await kv({ op: "all", ns: "video-editor-projects/projects" })).body.value as unknown[]).length, 2);
    assert.deepEqual(oc.listProjects().map((p) => p.name), ["Two", "One"], "most recently touched first");
    await kv({ op: "remove", ns: "video-editor-projects/projects", key: "p2" });
    assert.deepEqual((await kv({ op: "list", ns: "video-editor-projects/projects" })).body.value, ["p1"]);
    await kv({ op: "clear", ns: "video-editor-projects/*" });
    assert.deepEqual(oc.listProjects(), [], "a whole database dropped at once");
  });

  await test("no name reaches outside the store", async () => {
    for (const key of ["../x", "..", ".hidden", "a/b", "", "x".repeat(300)]) {
      assert.equal((await kv({ op: "set", ns: "ok/ns", key, value: 1 })).status, 400, `key ${JSON.stringify(key)}`);
    }
    for (const ns of ["../escape", "a/../b", "/abs", "a//b", ""]) {
      assert.equal((await kv({ op: "list", ns })).status, 400, `ns ${JSON.stringify(ns)}`);
    }
    assert.ok(!fs.existsSync(path.join(dir, "escape")));
  });

  await test("media files go in as bytes and come out with what the browser knew of them", async () => {
    const bytes = Buffer.from([1, 2, 3, 4, 5, 250]);
    const q = new URLSearchParams({ ns: "files/media-files-p1", key: "m1", name: "clip.mp4", type: "video/mp4", modified: "1700000000000" });
    const put = await fetch(`${base}/api/opencut/file?${q}`, { method: "PUT", headers: { "Content-Type": "application/octet-stream" }, body: bytes });
    assert.equal(put.status, 200);
    const got = await fetch(`${base}/api/opencut/file?ns=files%2Fmedia-files-p1&key=m1`);
    assert.equal(got.status, 200);
    assert.deepEqual(Buffer.from(await got.arrayBuffer()), bytes);
    assert.deepEqual(JSON.parse(decodeURIComponent(got.headers.get("x-opencut-meta") ?? "")), { name: "clip.mp4", type: "video/mp4", lastModified: 1700000000000 });
    assert.match(got.headers.get("content-security-policy") ?? "", /sandbox/, "never served as a page");
    assert.deepEqual((await kv({ op: "list", ns: "files/media-files-p1" })).body.value, ["m1"]);
    assert.equal((await fetch(`${base}/api/opencut/file?ns=files%2Fmedia-files-p1&key=gone`)).status, 404);
    assert.equal((await fetch(`${base}/api/opencut/file?ns=video-editor-projects%2Fprojects&key=p1`)).status, 400, "only the file namespaces are files");
    await kv({ op: "remove", ns: "files/media-files-p1", key: "m1" });
    assert.deepEqual((await kv({ op: "list", ns: "files/media-files-p1" })).body.value, []);
  });

  console.log("commands");
  await test("a command waits for the editor, is sent, claimed once and answered", async () => {
    pushes.length = 0;
    const asked = oc.command("s1", "state", {}, 8_000);
    await sleep(300);
    assert.equal(pushes.length, 0, "nothing is sent to a frame that has not said it is up");
    assert.equal((await post("/api/opencut/ready?session=s1", { ready: true })).status, 200);
    await sleep(250);
    assert.equal(pushes.length, 1);
    assert.equal(pushes[0].type, "opencut.command");
    const id = pushes[0].id as string;
    const [a, b] = await Promise.all([post(`/api/opencut/claim?session=s1&id=${id}`), post(`/api/opencut/claim?session=s1&id=${id}`)]);
    const wins = [(await a.json()).won, (await b.json()).won].filter(Boolean).length;
    assert.equal(wins, 1, "two tabs, one does it");
    await post("/api/opencut/reply?session=s1", { id, ok: true, value: { hello: "there" } });
    assert.deepEqual(await asked, { hello: "there" });
  });

  await test("an unclaimed command is sent again, and one the editor refuses fails the call", async () => {
    pushes.length = 0;
    const asked = oc.command("s1", "split", { time: 1 }, 8_000).then(() => null, (e: Error) => e);
    await sleep(3_400);
    assert.ok(pushes.length >= 2, `sent again while nobody took it (${pushes.length})`);
    const id = pushes[0].id as string;
    await post(`/api/opencut/claim?session=s1&id=${id}`);
    await post("/api/opencut/reply?session=s1", { id, ok: false, value: { message: "time is outside that clip" } });
    assert.match(String(await asked), /time is outside that clip/);
    const settled = pushes.length;
    await sleep(1_800);
    assert.equal(pushes.length, settled, "and it stops once answered");
  });

  await test("a reply for another chat's command is ignored", async () => {
    pushes.length = 0;
    const asked = oc.command("s1", "play", {}, 3_000).then(() => null, (e: Error) => e);
    await sleep(200);
    const id = pushes[0].id as string;
    await post("/api/opencut/reply?session=nope", { id, ok: true, value: 1 });
    assert.match(String(await asked), /did not answer play/);
  });

  console.log("the window's state");
  await test("open, named by the project in it, and put away", async () => {
    const seen: string[] = [];
    oc.onOpencutChange((s) => seen.push(s));
    assert.deepEqual(oc.opencutState("s1"), { open: true, projectId: null, name: null, since: oc.opencutState("s1").since });
    await post("/api/opencut/state?session=s1", { projectId: "p9", name: "Holiday" });
    assert.equal(oc.opencutState("s1").name, "Holiday");
    assert.match(oc.videoBriefing("s1") ?? "", /Holiday/);
    await post("/api/opencut/close?session=s1");
    assert.equal(oc.opencutState("s1").open, false);
    assert.equal(oc.videoBriefing("s1"), null);
    assert.ok(seen.length >= 2);
    assert.equal((await post("/api/opencut/close?session=unknown")).status, 404);
  });

  console.log("the tools");
  const ctx = { session: "s1", cwd: dir, cancelled: () => false };
  await test("the agent is told what is wrong in words it can act on", async () => {
    assert.match((await oc.runVideoTool("video_edit", { action: "juggle" }, ctx)).summary, /action is one of/);
    assert.match((await oc.runVideoTool("video_style", { action: "effect_add" }, ctx)).summary, /Done|did not|editor/, "style actions are known");
    assert.match((await oc.runVideoTool("video_style", { action: "add_clip" }, ctx)).summary, /action is one of: effect_add/, "an action of another tool is not accepted");
    assert.match((await oc.runVideoTool("video_project", { action: "split" }, ctx)).summary, /action is one of: track_add/);
    assert.match((await oc.runVideoTool("video_ui", { action: "teleport" }, ctx)).summary, /action is one of: read, click/);
    assert.match((await oc.runVideoTool("video_import", { file: "no-such-file.mp4" }, ctx)).summary, /There is no file/);
    fs.writeFileSync(path.join(dir, "notes.txt"), "hello");
    assert.match((await oc.runVideoTool("video_import", { file: path.join(dir, "notes.txt") }, ctx)).summary, /not a video, audio or image/);
    const missing = await oc.runVideoTool("video_open", { project: "no such project" }, ctx);
    assert.equal(missing.ok, false);
    assert.match(missing.summary, /There is no video project/);
  });

  await test("a project the person holds is left alone, but can still be looked at", async () => {
    const held = { ...ctx, held: () => "The person has taken control of the video project, so this was not done." };
    const edit = await oc.runVideoTool("video_edit", { action: "seek", time: 1 }, held);
    assert.equal(edit.ok, false);
    assert.equal(edit.held, true);
  });

  await test("the tools are brought in by the person's words, and looking is allowed while planning", async () => {
    assert.ok(loadedFamilies({ events: [], said: "can you cut this footage into a short video?" }).has("video"));
    assert.ok(!loadedFamilies({ events: [], said: "what is the capital of France?" }).has("video"));
    assert.equal(looksOnly("video_look"), true);
    assert.equal(looksOnly("video_open", {}), true);
    assert.equal(looksOnly("video_open", { new: "x" }), false);
    assert.equal(looksOnly("video_edit", { action: "delete" }), false);
    assert.equal(looksOnly("video_export"), false);
    assert.equal(looksOnly("video_catalog"), true);
    assert.equal(looksOnly("video_frame"), true);
    assert.equal(looksOnly("video_ui", { action: "read" }), true);
    assert.equal(looksOnly("video_ui", { action: "click" }), false);
    assert.equal(looksOnly("video_style", { action: "effect_add" }), false);
    assert.equal(looksOnly("video_project", { action: "settings" }), false);
  });

  console.log(`\n${passed} passed`);
} finally {
  server.close();
  oc.dropOpencut("s1");
}
setTimeout(() => process.exit(0), 50);
