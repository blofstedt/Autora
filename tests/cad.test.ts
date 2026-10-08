/**
 * Autora 3D: the agent's cad_* tools, the window's model on the server, and the routes between them.
 *
 * Needs the modeller built (`npm --prefix autora-3d run build`, which `npm run build` does): the engine is
 * loaded from dist/autora-3d-engine/ the way the server loads it.
 *
 *   npx tsx tests/cad.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-cad-"));
process.env.AUTORA_STATE_DIR = dir;

const express = (await import("express")).default;
const cad = await import("../server/caddesk");
const { cadSPECS } = await import("../server/specs/cad");
const { windowOff, toolSettings } = await import("../server/tools");
const { loadedFamilies, withoutUnloaded } = await import("../server/toolload");
const { getArtifact } = await import("../server/artifacts");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

assert.ok(cad.cadAvailable(), "the modeller is not built: run `npm --prefix autora-3d run build` first");

// ------------------------------------------------------------------ specs --

await test("every spec is a cad_ tool with a description and an object schema", () => {
  assert.ok(cadSPECS.length >= 40);
  for (const s of cadSPECS) {
    assert.match(s.name, /^cad_[a-z_]+$/);
    assert.ok(s.description.length > 8, s.name);
    assert.equal(s.parameters.type, "object", s.name);
  }
  assert.equal(new Set(cadSPECS.map((s) => s.name)).size, cadSPECS.length);
});

await test("the tools describe each other by the names the agent knows", () => {
  const all = JSON.stringify(cadSPECS);
  assert.ok(!/(?<![\w])scene_get/.test(all), "a bare scene_get is left in a description");
  assert.ok(all.includes("cad_scene_get"));
});

await test("the tools are in a family of their own, brought in by the person's words or by use", () => {
  const specs = cadSPECS.map((s) => ({ name: s.name }));
  const none = loadedFamilies({ events: [], said: "what's the weather" });
  assert.equal(withoutUnloaded(specs, none).length, 0);
  for (const said of ["model a phone stand for 3D printing", "open Autora 3D", "bevel the top edges", "export an STL"]) {
    assert.equal(withoutUnloaded(specs, loadedFamilies({ events: [], said })).length, specs.length, said);
  }
  const used = loadedFamilies({ events: [{ kind: "tool.call", payload: { name: "cad_shape_add" } }] });
  assert.equal(withoutUnloaded(specs, used).length, specs.length);
});

await test("the Tools page switch turns them off", () => {
  assert.equal(windowOff("cad_scene_get"), false);
  assert.equal(windowOff("cad_scene_get", { ...toolSettings(), cad: { enabled: false } }), true);
  assert.equal(windowOff("pdf_read", { ...toolSettings(), cad: { enabled: false } }), false);
});

// ------------------------------------------------------------------ tools --

const S = "cadtest1";
const shown: Array<{ id: string; name: string; mime: string; size: number }> = [];
const run = (name: string, args: Record<string, any> = {}) => cad.runCadTool(S, name, args, { showFile: (f) => shown.push(f) });
const states: unknown[] = [];
cad.onCadChange((id) => { if (id === S) states.push(cad.cadState(S)); });

await test("a tool call opens the window and changes the model", async () => {
  assert.equal(cad.cadState(S).open, false);
  const out = await run("cad_shape_add", { kind: "box", width: 80, depth: 40, height: 30, name: "Base" });
  assert.ok(out.ok, out.summary);
  const state = cad.cadState(S);
  assert.equal(state.open, true);
  assert.equal(state.shapes, 1);
  assert.equal(state.by, "agent");
  assert.ok((state.rev ?? 0) > 0);
  assert.ok(states.length > 0, "the page is told");
});

await test("what comes back is the engine's answer, named as the agent knows it", async () => {
  const scene = JSON.parse((await run("cad_scene_get")).summary);
  assert.equal(scene.result.shapes.length, 1);
  assert.equal(scene.result.shapes[0].size.width, 80);
  const missing = await run("cad_shape_get", { id: "nope" });
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /cad_scene_get|Shapes:/);
  assert.ok(!/(?<![\w])scene_get/.test(missing.summary), missing.summary);
});

await test("a batch takes tool names with or without the prefix, all or nothing", async () => {
  const out = await run("cad_batch", { commands: [
    { tool: "cad_shape_add", args: { kind: "cylinder", width: 20, height: 10, name: "Knob" } },
    { tool: "shape_add", args: { kind: "box", width: 10, depth: 10, height: 10, name: "Chip" } },
  ] });
  assert.ok(out.ok, out.summary);
  assert.equal(cad.cadState(S).shapes, 3);
  const bad = await run("cad_batch", { commands: [{ tool: "shape_add", args: { kind: "box" } }, { tool: "no_such_tool" }] });
  assert.equal(bad.ok, false);
  assert.equal(cad.cadState(S).shapes, 3, "nothing changed");
});

await test("the screen-only commands are not offered, and an unknown tool is refused", async () => {
  assert.ok(!cadSPECS.some((s) => s.name.startsWith("cad_ui_")));
  assert.equal((await run("cad_ui_screenshot")).ok, false);
  assert.equal((await run("cad_nonsense")).ok, false);
});

await test("an export is saved as an artifact, not returned in the conversation", async () => {
  const out = await run("cad_export", { format: "stl", name: "stand" });
  assert.ok(out.ok, out.summary);
  assert.match(out.summary, /stand\.stl/);
  assert.ok(out.summary.length < 400, "no file contents in the answer");
  assert.equal(shown.length, 1);
  const art = getArtifact(shown[0].id)!;
  assert.equal(art.name, "stand.stl");
  assert.equal(art.mime, "model/stl");
  assert.ok(art.size > 84 + 50 * 3, "a binary STL with triangles in it");
});

await test("the model can be measured: it is a real, watertight solid", async () => {
  const scene = JSON.parse((await run("cad_scene_get")).summary);
  const id = scene.result.shapes[0].id;
  const m = JSON.parse((await run("cad_shape_measure", { id })).summary);
  assert.equal(m.result.watertight, true);
  assert.ok(Math.abs(m.result.volume - 80 * 40 * 30) < 1, `volume ${m.result.volume}`);
});

// ----------------------------------------------------------------- routes --

const app = express();
cad.cadRoutes(app, {
  exists: (id) => id === S || id === "cadtest2" || id === "cadtest3",
  incognito: (id) => id === "cadtest2",
  off: () => false,
});
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = async (method: string, url: string, body?: unknown) => {
  const res = await fetch(base + url, { method, headers: { "content-type": "application/json" }, body: body === undefined ? undefined : JSON.stringify(body) });
  return { status: res.status, body: (await res.json().catch(() => null)) as any };
};

await test("the window reads the model the agent made", async () => {
  const r = await call("GET", `/api/cad/${S}/doc`);
  assert.equal(r.status, 200);
  assert.equal(r.body.doc.bodies.length, 3);
  assert.equal(r.body.rev, cad.cadState(S).rev);
});

await test("a change made in the window is the agent's to see, and is marked as the person's", async () => {
  const { body } = await call("GET", `/api/cad/${S}/doc`);
  const doc = body.doc;
  doc.bodies = doc.bodies.filter((b: any) => b.name !== "Chip");
  const put = await call("PUT", `/api/cad/${S}/doc`, { doc });
  assert.equal(put.status, 200);
  assert.equal(cad.cadState(S).by, "person");
  assert.equal(cad.cadState(S).shapes, 2);
  const scene = JSON.parse((await run("cad_scene_get")).summary);
  assert.deepEqual(scene.result.shapes.map((s: any) => s.name).sort(), ["Base", "Knob"]);
  assert.equal(cad.cadState(S).by, "agent", "and the agent's next change is the agent's again");
});

await test("a model that is not one is refused and nothing changes", async () => {
  const before = cad.cadState(S).rev;
  assert.equal((await call("PUT", `/api/cad/${S}/doc`, { doc: { nope: 1 } })).status, 400);
  assert.equal((await call("PUT", `/api/cad/${S}/doc`, {})).status, 400);
  assert.equal(cad.cadState(S).rev, before);
});

await test("an unknown chat is refused", async () => {
  assert.equal((await call("GET", "/api/cad/nobody")).status, 404);
  assert.equal((await call("GET", "/api/cad/..%2Fx/doc")).status, 404);
});

await test("opening it from the toolbox gives a block to hold; an incognito chat gets none", async () => {
  const id = "cadtest2";
  const r = await call("POST", `/api/cad/${id}/open`);
  assert.equal(r.status, 409);
  assert.equal(cad.cadState(id).open, false);
});

await test("opened from the toolbox it starts with a block to hold, and an empty model is not overwritten again", async () => {
  const r = await call("POST", "/api/cad/cadtest3/open");
  assert.equal(r.status, 200);
  assert.equal(r.body.open, true);
  assert.equal(r.body.shapes, 1);
  const again = await call("POST", "/api/cad/cadtest3/open");
  assert.equal(again.body.shapes, 1);
  cad.dropCad("cadtest3");
});

await test("putting it away closes the window and keeps the model", async () => {
  const r = await call("POST", `/api/cad/${S}/close`);
  assert.equal(r.body.open, false);
  assert.equal(cad.cadState(S).open, false);
  assert.equal(JSON.parse((await run("cad_scene_get")).summary).result.shapes.length, 2);
  assert.equal(cad.cadState(S).open, true, "and the next tool call opens it again");
});

await test("the model is kept on disk, and goes with the chat", async () => {
  await new Promise((r) => setTimeout(r, 900));
  const file = path.join(dir, `cad-${S}.json`);
  assert.ok(fs.existsSync(file), "saved");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.doc.bodies.length, 2);
  cad.dropCad(S);
  assert.ok(!fs.existsSync(file), "removed with the chat");
});

server.close();
console.log(`\n${passed} passed`);
process.exit(0);
