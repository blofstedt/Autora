/**
 * Autora Photo: the agent's photo_* tools, the window's picture on the server, and the routes between them.
 *
 * The specs, the family and the switch are tested always. The tools and routes need PhotoCraft built
 * (`node scripts/build-photo.mjs`: Rust, trunk, a few minutes); without it they are skipped, as the Office tests are.
 *
 *   npx tsx tests/photo.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-photo-"));
process.env.AUTORA_STATE_DIR = dir;

const express = (await import("express")).default;
const photo = await import("../server/photodesk");
const { photoSPECS } = await import("../server/specs/photo");
const { windowOff, toolSettings } = await import("../server/tools");
const { loadedFamilies, withoutUnloaded } = await import("../server/toolload");
const { getArtifact } = await import("../server/artifacts");
const { looksOnly } = await import("../server/modes");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

// ------------------------------------------------------------------ specs --

await test("every spec is a photo_ tool with a description and an object schema", () => {
  assert.equal(photoSPECS.length, 6);
  for (const s of photoSPECS) {
    assert.match(s.name, /^photo_[a-z_]+$/);
    assert.ok(s.description.length > 20, s.name);
    assert.equal(s.parameters.type, "object", s.name);
  }
  assert.equal(new Set(photoSPECS.map((s) => s.name)).size, photoSPECS.length);
});

await test("the tools are in a family of their own, brought in by the person's words or by use", () => {
  const specs = photoSPECS.map((s) => ({ name: s.name }));
  const none = loadedFamilies({ events: [], said: "what's the weather", lazy: true });
  assert.equal(withoutUnloaded(specs, none).length, 0);
  for (const said of ["touch up this photo", "open it in Autora Photo", "edit my.psd", "remove the background from this picture"]) {
    assert.equal(withoutUnloaded(specs, loadedFamilies({ events: [], said, lazy: true })).length, specs.length, said);
  }
  const used = loadedFamilies({ events: [{ kind: "tool.call", payload: { name: "photo_edit" } }], lazy: true });
  assert.equal(withoutUnloaded(specs, used).length, specs.length);
});

await test("the Tools page switch turns them off", () => {
  const on = { ...toolSettings(), photo: { enabled: true } };
  const off = { ...toolSettings(), photo: { enabled: false } };
  // Without the build the tools are off whatever the switch says.
  assert.equal(windowOff("photo_look", on), !photo.photoAvailable());
  assert.equal(windowOff("photo_look", off), true);
  assert.equal(windowOff("pdf_read", off), false);
});

await test("Plan mode allows looking and nothing that changes the picture", () => {
  for (const name of ["photo_look", "photo_info", "photo_commands"]) assert.equal(looksOnly(name, {}), true, name);
  assert.equal(looksOnly("photo_open", {}), true);
  assert.equal(looksOnly("photo_open", { file: "a.png" }), false);
  assert.equal(looksOnly("photo_open", { new: { width: 10 } }), false);
  for (const name of ["photo_edit", "photo_export"]) assert.equal(looksOnly(name, {}), false, name);
});

await test("a server without the build says so instead of failing", async () => {
  if (photo.photoAvailable()) return;
  const out = await photo.runPhotoTool("phototest0", "photo_look", {}, { cwd: dir });
  assert.equal(out.ok, false);
  assert.match(out.summary, /not built/);
});

if (!photo.photoAvailable()) {
  console.log(`${passed} passed; the rest is skipped: Autora Photo is not built (node scripts/build-photo.mjs)`);
  process.exit(0);
}

// ------------------------------------------------------------------ tools --

const S = "phototest1";
const shown: Array<{ id: string; name: string; mime: string; size: number }> = [];
const seen: Buffer[] = [];
const run = (name: string, args: Record<string, any> = {}) =>
  photo.runPhotoTool(S, name, args, { cwd: dir, showFile: (f) => shown.push(f), showImage: (data) => seen.push(data) });
const states: unknown[] = [];
photo.onPhotoChange((id) => { if (id === S) states.push(photo.photoState(S)); });

await test("a picture is needed before it can be looked at or changed", async () => {
  for (const name of ["photo_look", "photo_info", "photo_export"]) {
    const out = await run(name);
    assert.equal(out.ok, false, name);
    assert.match(out.summary, /photo_open/);
  }
  assert.equal((await run("photo_edit", { commands: [{ id: "x" }] })).ok, false);
});

await test("a new canvas opens the window", async () => {
  assert.equal(photo.photoState(S).open, false);
  const out = await run("photo_open", { new: { width: 320, height: 200, background: "white" } });
  assert.ok(out.ok, out.summary);
  const state = photo.photoState(S);
  assert.equal(state.open, true);
  assert.equal(state.by, "agent");
  assert.deepEqual(state.size, { w: 320, h: 200 });
  assert.ok((state.rev ?? 0) > 0);
  assert.ok(states.length > 0, "the page is told");
});

await test("the commands can be searched", async () => {
  const out = await run("photo_commands", { filter: "gaussian" });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /filter\.blur\.gaussianBlur/);
  assert.ok(out.summary.length < 5000, "only what was asked for");
  const none = await run("photo_commands", { filter: "zzzznothing" });
  assert.match(none.summary, /No command/);
});

await test("commands change the picture and the change is kept", async () => {
  const before = photo.photoState(S).rev ?? 0;
  const out = await run("photo_edit", { commands: [{ id: "layer.new.layer", params: { name: "Ink" } }] });
  assert.ok(out.ok, out.summary);
  assert.ok((photo.photoState(S).rev ?? 0) > before);
  assert.ok((photo.photoState(S).layers ?? 0) >= 2, "a layer was added");
  const info = await run("photo_info");
  assert.match(info.summary, /Ink/);
});

await test("a command that fails stops the list and says which, keeping what ran before", async () => {
  const out = await run("photo_edit", { commands: [{ id: "layer.new.layer", params: { name: "Kept" } }, { id: "no.such.command" }, { id: "layer.new.layer", params: { name: "Never" } }] });
  assert.equal(out.ok, false);
  assert.match(out.summary, /no\.such\.command/);
  const info = (await run("photo_info")).summary;
  assert.match(info, /Kept/);
  assert.ok(!/Never/.test(info));
});

await test("looking gives the model the picture and shows it in the thread", async () => {
  const out = await run("photo_look", { max_side: 128 });
  assert.ok(out.ok, out.summary);
  assert.equal(out.images?.length, 1);
  assert.equal(out.images?.[0].mime, "image/png");
  const png = Buffer.from(out.images![0].data, "base64");
  assert.equal(png.subarray(1, 4).toString(), "PNG");
  assert.equal(seen.length, 1);
});

await test("an export is saved as an artifact, not returned in the conversation", async () => {
  const out = await run("photo_export", { format: "png", name: "card" });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /card\.png/);
  assert.ok(out.summary.length < 400, "no file contents in the answer");
  assert.equal(shown.length, 1);
  const art = getArtifact(shown[0].id)!;
  assert.equal(art.name, "card.png");
  assert.equal(art.mime, "image/png");
  assert.equal((await run("photo_export", { format: "exe" })).ok, false);
  assert.equal(fs.readdirSync(path.join(dir, "photo", S)).filter((f) => f.startsWith("out-")).length, 0, "no scratch files left");
});

await test("a picture the agent is handed opens, layers and all", async () => {
  const exported = await run("photo_export", { format: "pcraft", name: "keep" });
  assert.ok(exported.ok, exported.summary);
  const id = shown[shown.length - 1].id;
  const S2 = "phototest4";
  const out = await photo.runPhotoTool(S2, "photo_open", { file: id }, { cwd: dir });
  assert.ok(out.ok, out.summary);
  const info = await photo.runPhotoTool(S2, "photo_info", {}, { cwd: dir });
  assert.match(info.summary, /Kept/);
  assert.equal(photo.photoState(S2).open, true);
});

await test("a file that is not a picture is refused", async () => {
  const bad = path.join(dir, "notes.png");
  fs.writeFileSync(bad, "this is not a picture");
  const out = await run("photo_open", { file: bad });
  assert.equal(out.ok, false);
});

// ----------------------------------------------------------------- routes --

const app = express();
photo.photoRoutes(app, {
  exists: (id) => id === S || id === "phototest2" || id === "phototest3",
  incognito: (id) => id === "phototest2",
  off: () => false,
});
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = (method: string, url: string, body?: Buffer) =>
  fetch(base + url, { method, headers: body ? { "content-type": "application/octet-stream" } : {}, body: body ? new Uint8Array(body) : undefined });

await test("the window reads the picture the agent made", async () => {
  const res = await call("GET", `/api/photo/${S}/doc`);
  assert.equal(res.status, 200);
  const bytes = Buffer.from(await res.arrayBuffer());
  assert.ok(bytes.length > 100);
  assert.equal(Number(res.headers.get("x-photo-rev")), photo.photoState(S).rev);
  assert.equal((await call("GET", "/api/photo/phototest3/doc")).status, 404, "no picture yet");
});

await test("a change made in the window is the agent's to see, and is marked as the person's", async () => {
  const bytes = Buffer.from(await (await call("GET", `/api/photo/${S}/doc`)).arrayBuffer());
  const put = await call("PUT", `/api/photo/${S}/doc`, bytes);
  assert.equal(put.status, 200);
  assert.equal(photo.photoState(S).by, "person");
  assert.ok((await run("photo_info")).ok);
  await run("photo_edit", { commands: [{ id: "layer.new.layer", params: { name: "Again" } }] });
  assert.equal(photo.photoState(S).by, "agent", "and the agent's next change is the agent's again");
});

await test("a file that is not a PhotoCraft picture is refused and nothing changes", async () => {
  const before = photo.photoState(S).rev;
  assert.equal((await call("PUT", `/api/photo/${S}/doc`, Buffer.from("nope"))).status, 400);
  assert.equal((await call("PUT", `/api/photo/${S}/doc`, Buffer.alloc(0))).status, 400);
  assert.equal(photo.photoState(S).rev, before);
  assert.equal(fs.readdirSync(path.join(dir, "photo", S)).filter((f) => f.startsWith("put-")).length, 0, "no scratch files left");
});

await test("unknown chats are refused, and an incognito chat keeps nothing", async () => {
  assert.equal((await call("GET", "/api/photo/nosuchchat")).status, 404);
  assert.equal((await call("POST", "/api/photo/phototest2/open")).status, 409);
  const opened = await call("POST", "/api/photo/phototest3/open");
  assert.equal(opened.status, 200);
  assert.equal(photo.photoState("phototest3").open, true);
  assert.equal((await (await call("POST", "/api/photo/phototest3/close")).json() as any).open, false);
});

await test("forgetting a chat removes its picture", () => {
  const folder = path.join(dir, "photo", S);
  assert.ok(fs.existsSync(folder));
  photo.dropPhoto(S);
  assert.equal(fs.existsSync(folder), false);
  assert.equal(photo.photoState(S).open, false);
});

server.close();
console.log(`${passed} passed`);
process.exit(0);
