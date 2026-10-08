/**
 * Autora Games: the agent's game_* tools, the game on the server, and the routes between it and GDevelop's editor.
 *
 * Needs the editor built (`npm run build` does it: dist/gdevelop-editor/), because the tools are not offered without it.
 *
 *   npx tsx tests/game.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-game-"));
process.env.AUTORA_STATE_DIR = dir;

const express = (await import("express")).default;
const game = await import("../server/gamedesk");
const { gameSPECS } = await import("../server/specs/game");
const { windowOff, toolSettings } = await import("../server/tools");
const { loadedFamilies, withoutUnloaded } = await import("../server/toolload");
const { saveArtifact } = await import("../server/artifacts");
const catalog = (await import("../server/game-catalog.json")).default as any;

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

assert.ok(game.gameAvailable(), "the editor is not built: run `npm run build` first (dist/gdevelop-editor/)");

// ------------------------------------------------------------------ specs --

await test("every spec is a game_ tool with a description and an object schema", () => {
  for (const s of gameSPECS) {
    assert.match(s.name, /^game_[a-z_]+$/);
    assert.ok(s.description.length > 20, s.name);
    assert.equal(s.parameters.type, "object", s.name);
  }
  assert.equal(new Set(gameSPECS.map((s) => s.name)).size, gameSPECS.length);
});

await test("the tools are in a family of their own, brought in by the person's words or by use", () => {
  const specs = gameSPECS.map((s) => ({ name: s.name }));
  assert.equal(withoutUnloaded(specs, loadedFamilies({ events: [], said: "what's the weather" })).length, 0);
  for (const said of ["make me a platformer game", "open GDevelop", "build a game where a cat jumps", "add a sprite to my game"]) {
    assert.equal(withoutUnloaded(specs, loadedFamilies({ events: [], said })).length, specs.length, said);
  }
  const used = loadedFamilies({ events: [{ kind: "tool.call", payload: { name: "game_look" } }] });
  assert.equal(withoutUnloaded(specs, used).length, specs.length);
});

await test("the Tools page switch turns them off", () => {
  assert.equal(windowOff("game_look"), false);
  assert.equal(windowOff("game_look", { ...toolSettings(), game: { enabled: false } }), true);
  assert.equal(windowOff("pdf_read", { ...toolSettings(), game: { enabled: false } }), false);
});

// ---------------------------------------------------------------- catalog --

await test("the catalog is what the server reads: instructions with their parameters, and templates made by the engine", () => {
  assert.ok(catalog.extensions.length > 50);
  assert.ok(catalog.instructions.length > 1500);
  for (const i of catalog.instructions) {
    assert.ok(["action", "condition", "expression", "strExpression"].includes(i.kind), i.type);
    for (const p of i.params) assert.ok(p.i >= 0 && p.i < (i.n ?? 99), `${i.type} parameter ${p.i}`);
  }
  assert.ok(catalog.templates.objects.Sprite, "a Sprite template");
  assert.ok(catalog.templates.behaviors["PlatformBehavior::PlatformerObjectBehavior"], "the platformer behavior template");
  assert.ok(catalog.templates.resources.image, "an image resource template");
  assert.ok(catalog.instructions.some((i: any) => i.kind === "action" && i.type === "Create" && i.n === 5), "Create takes 5 parameters, one of them internal");
});

// ------------------------------------------------------------------ tools --

const S = "gametest1";
const run = (name: string, args: Record<string, any> = {}) => game.runGameTool(S, name, args, { cwd: dir });
const states: Array<ReturnType<typeof game.gameState>> = [];
game.onGameChange((id) => { if (id === S) states.push(game.gameState(S)); });

await test("a chat has no game window until one is opened", () => {
  assert.equal(game.gameState(S).open, false);
});

await test("game_open starts an empty game with one scene, opens the window and says what is in it", async () => {
  const r = await run("game_open", { name: "Cat jump" });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Cat jump/);
  assert.match(r.summary, /"Scene"/);
  const state = game.gameState(S);
  assert.equal(state.open, true);
  assert.equal(state.name, "Cat jump");
  assert.equal(state.scenes, 1);
  assert.equal(state.by, "agent");
});

await test("a template is the shape the editor saves, and goes into the game with game_edit", async () => {
  const t = await run("game_template", { kind: "object", type: "Sprite" });
  assert.equal(t.ok, true);
  const sprite = JSON.parse(t.summary.slice(t.summary.indexOf("{")));
  assert.equal(sprite.type, "Sprite");
  sprite.name = "Cat";
  const b = JSON.parse((await run("game_template", { kind: "behavior", type: "PlatformerObjectBehavior" })).summary.split("\n").slice(1).join("\n").slice(0));
  sprite.behaviors.push({ ...b, name: "Platformer" });
  const rev = game.gameState(S).rev;
  const r = await run("game_edit", { ops: [{ op: "insert", path: "layouts[Scene].objects", value: sprite }] });
  assert.equal(r.ok, true, r.summary);
  assert.ok((game.gameState(S).rev ?? 0) > (rev ?? 0), "the revision moved");
  assert.ok(states.some((s) => s.by === "agent"), "the page was told");
  const look = await run("game_look", { what: "scene", scene: "Scene" });
  assert.match(look.summary, /Cat \(Sprite\)/);
  assert.match(look.summary, /Platformer:PlatformBehavior::PlatformerObjectBehavior/);
});

await test("an instance and an event, written from the catalog, check out", async () => {
  const found = await run("game_catalog", { query: "key pressed", kind: "condition" });
  assert.match(found.summary, /KeyFromTextPressed/);
  const set = await run("game_catalog", { query: "x position", kind: "action", for: "Sprite" });
  assert.match(set.summary, /"SetX"/);
  const inst = JSON.parse((await run("game_template", { kind: "instance" })).summary.split("\n").slice(1).join("\n"));
  inst.name = "Cat"; inst.x = 100; inst.y = 200;
  const event = {
    type: "BuiltinCommonInstructions::Standard",
    conditions: [{ type: { inverted: false, value: "KeyFromTextPressed" }, parameters: ["", "Right"], subInstructions: [] }],
    actions: [{ type: { value: "SetX" }, parameters: ["Cat", "+", "5"], subInstructions: [] }],
    events: [],
  };
  const r = await run("game_edit", { ops: [
    { op: "insert", path: "layouts[Scene].instances", value: inst },
    { op: "insert", path: "layouts[Scene].events", value: event },
  ] });
  assert.equal(r.ok, true, r.summary);
  assert.ok(!/Check these/.test(r.summary), `no warnings expected: ${r.summary}`);
  const events = await run("game_look", { what: "events", scene: "Scene" });
  assert.match(events.summary, /layouts\[Scene\]\.events\[0\] IF KeyFromTextPressed\('', Right\) DO SetX\(Cat, \+, 5\)/);
  assert.equal((await run("game_check")).ok, true);
  assert.match((await run("game_check")).summary, /Nothing looks wrong/);
});

await test("an instruction the engine does not have is saved but flagged, with the place to fix it", async () => {
  const bad = { type: "BuiltinCommonInstructions::Standard", conditions: [], actions: [{ type: { value: "MoveTheCatLeft" }, parameters: ["Cat"], subInstructions: [] }, { type: { value: "SetX" }, parameters: ["Cat"], subInstructions: [] }], events: [] };
  const r = await run("game_edit", { ops: [{ op: "insert", path: "layouts[Scene].events", value: bad }] });
  assert.equal(r.ok, true);
  assert.match(r.summary, /MoveTheCatLeft" is not an action the engine has/);
  assert.match(r.summary, /SetX takes 3 parameters, this has 1/);
  assert.match(r.summary, /layouts\[Scene\]\.events\[1\]\.actions\[0\]/);
});

await test("an instance of an object that does not exist, and a picture that is not in the resources, are flagged", async () => {
  const r = await run("game_edit", { ops: [{ op: "insert", path: "layouts[Scene].instances", value: { name: "Ghost", x: 0, y: 0, layer: "", zOrder: 0, angle: 0, customSize: false, width: 0, height: 0 } }] });
  assert.match(r.summary, /instance in scene "Scene" is of "Ghost"/);
  const sprite = JSON.parse(JSON.stringify(catalog.templates.objects.Sprite));
  sprite.name = "Dog";
  sprite.animations = [{ name: "", useMultipleDirections: false, directions: [{ looping: false, timeBetweenFrames: 0.08, sprites: [{ image: "dog.png", points: [], originPoint: { name: "origine", x: 0, y: 0 }, centerPoint: { automatic: true, name: "centre", x: 0, y: 0 }, hasCustomCollisionMask: false, customCollisionMask: [] }] }] }];
  const r2 = await run("game_edit", { ops: [{ op: "insert", path: "layouts[Scene].objects", value: sprite }] });
  assert.match(r2.summary, /uses the picture "dog.png"/);
});

await test("a change that cannot be made changes nothing, and says which op and why", async () => {
  const before = JSON.stringify((await run("game_look", { what: "json", path: "layouts" })).summary);
  const rev = game.gameState(S).rev;
  const r = await run("game_edit", { ops: [
    { op: "set", path: "properties.name", value: "Changed" },
    { op: "remove", path: "layouts[Nowhere].objects" },
  ] });
  assert.equal(r.ok, false);
  assert.match(r.summary, /Op 2 of 2/);
  assert.match(r.summary, /nothing called \[Nowhere\] in layouts \(1 items: Scene\)/);
  assert.equal(game.gameState(S).rev, rev);
  assert.equal(JSON.stringify((await run("game_look", { what: "json", path: "layouts" })).summary), before);
  assert.equal((await run("game_edit", { ops: [{ op: "remove", path: "layouts" }] })).ok, false, "a game without scenes is not a game");
  assert.equal((await run("game_edit", { ops: [{ op: "set", path: "layouts[Scene].name", value: 5 }] })).ok, false);
  assert.equal((await run("game_look", { what: "json", path: "layouts[Scene].objects[Cat].name" })).ok, true);
});

await test("paths take positions, names and property=value", async () => {
  const r = await run("game_look", { what: "json", path: "layouts[Scene].objects[type=Sprite].name" });
  assert.match(r.summary, /Cat/);
  assert.match((await run("game_look", { what: "json", path: "layouts[0].objects[-1].name" })).summary, /Dog/);
  assert.equal((await run("game_look", { what: "json", path: "layouts[Scene].obj ects" })).ok, false);
  assert.equal((await run("game_edit", { ops: [{ op: "set", path: "layouts[Scene].objects[Cat].x; rm", value: 1 }] })).ok, false);
});

await test("merge, set and remove work on the parts of an object", async () => {
  assert.equal((await run("game_edit", { ops: [{ op: "merge", path: "layouts[Scene].objects[Cat].behaviors[Platformer]", value: { gravity: 2000 } }] })).ok, true);
  assert.match((await run("game_look", { what: "json", path: "layouts[Scene].objects[Cat].behaviors[0].gravity" })).summary, /2000/);
  assert.equal((await run("game_edit", { ops: [{ op: "remove", path: "layouts[Scene].objects[Dog]" }] })).ok, true);
  assert.equal((await run("game_edit", { ops: [{ op: "set", path: "layouts[Scene].objects[Cat].behaviors[0].gravity", value: 2000 }] })).summary, "Nothing changed: the game already was like that.");
});

await test("a file the agent has is added to the game's resources, by name, once", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const art = saveArtifact({ origin: "agent", name: "cat.png", data: png, mime: "image/png", session: S, note: "test" });
  const r = await run("game_import", { file: art.id });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /image "cat.png"/);
  const res = JSON.parse((await run("game_look", { what: "json", path: "resources.resources[cat.png]" })).summary);
  assert.equal(res.kind, "image");
  assert.match(res.file, new RegExp(`^/api/game/${S}/assets/cat\\.png$`));
  assert.ok(fs.existsSync(path.join(dir, "game-assets", S, "cat.png")));
  assert.equal((await run("game_import", { file: art.id, resource: "cat.png" })).ok, false, "a resource name that is taken is refused");
  assert.equal((await run("game_import", { file: art.id })).ok, true, "the same file again is another file and another resource");
  assert.ok(fs.existsSync(path.join(dir, "game-assets", S, "cat-2.png")), "kept under another name");
  assert.equal((await run("game_look", { what: "resources" })).summary.split("\n").length, 2);
  const bad = saveArtifact({ origin: "agent", name: "run.exe", data: Buffer.from("MZ"), mime: "application/octet-stream", session: S, note: "test" });
  assert.equal((await run("game_import", { file: bad.id })).ok, false);
});

await test("the game is kept on disk and comes back", async () => {
  await new Promise((r) => setTimeout(r, 900));
  const file = path.join(dir, `game-${S}.json`);
  assert.ok(fs.existsSync(file), "the game was saved");
  const saved = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.equal(saved.project.properties.name, "Cat jump");
  assert.equal(saved.open, true);
});

// ----------------------------------------------------------------- routes --

const app = express();
game.gameRoutes(app, {
  exists: (id) => id === S || id === "gametest2" || id === "gametest3",
  incognito: (id) => id === "gametest2",
  off: () => false,
});
const server = app.listen(0);
const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
const call = async (method: string, url: string, body?: unknown, headers: Record<string, string> = { "content-type": "application/json" }) => {
  const res = await fetch(base + url, { method, headers, body: body === undefined ? undefined : typeof body === "string" || Buffer.isBuffer(body) ? (body as any) : JSON.stringify(body) });
  return { status: res.status, headers: res.headers, text: await res.text() };
};
const json = (r: { text: string }) => JSON.parse(r.text);

await test("the editor reads the game the agent made", async () => {
  const r = await call("GET", `/api/game/${S}/project`);
  assert.equal(r.status, 200);
  const body = json(r);
  assert.equal(body.project.properties.name, "Cat jump");
  assert.equal(body.rev, game.gameState(S).rev);
  assert.equal(r.headers.get("cache-control"), "no-store");
});

await test("what the person does in the editor is kept, and is the person's change", async () => {
  const { project, rev } = json(await call("GET", `/api/game/${S}/project`));
  project.properties.name = "Cat jump 2";
  const put = await call("PUT", `/api/game/${S}/project`, { project, ifRev: rev });
  assert.equal(put.status, 200);
  assert.equal(game.gameState(S).by, "person");
  assert.equal(game.gameState(S).name, "Cat jump 2");
  assert.equal(json(put).rev, game.gameState(S).rev);
  assert.match((await run("game_look")).summary, /Cat jump 2/);
  assert.equal(game.gameState(S).by, "person", "reading is not changing");
});

await test("a save made from an older version than the agent's is refused, so the agent's change wins", async () => {
  const { project, rev } = json(await call("GET", `/api/game/${S}/project`));
  await run("game_edit", { ops: [{ op: "set", path: "properties.description", value: "by the agent" }] });
  project.properties.description = "by the person";
  const put = await call("PUT", `/api/game/${S}/project`, { project, ifRev: rev });
  assert.equal(put.status, 409);
  assert.match((await run("game_look", { what: "json", path: "properties.description" })).summary, /by the agent/);
});

await test("something that is not a game is refused", async () => {
  const before = game.gameState(S).rev;
  assert.equal((await call("PUT", `/api/game/${S}/project`, { project: { nope: 1 } })).status, 400);
  assert.equal((await call("PUT", `/api/game/${S}/project`, {})).status, 400);
  assert.equal((await call("PUT", `/api/game/${S}/project`, { project: { properties: {}, layouts: [{ nameless: true }] } })).status, 400);
  assert.equal(game.gameState(S).rev, before);
});

await test("unknown and malformed chats are not found", async () => {
  assert.equal((await call("GET", "/api/game/nobody")).status, 404);
  assert.equal((await call("GET", "/api/game/..%2Fx/project")).status, 404);
});

await test("an incognito chat has no game window", async () => {
  const r = await call("POST", "/api/game/gametest2/open");
  assert.equal(r.status, 409);
  assert.equal(game.gameState("gametest2").open, false);
});

await test("opening starts a game and putting it away closes the window", async () => {
  const r = await call("POST", "/api/game/gametest3/open");
  assert.equal(r.status, 200);
  assert.equal(game.gameState("gametest3").open, true);
  assert.equal(game.gameState("gametest3").scenes, 1);
  const closed = await call("POST", `/api/game/gametest3/close`);
  assert.equal(json(closed).open, false);
  game.dropGame("gametest3");
  assert.ok(!fs.existsSync(path.join(dir, "game-gametest3.json")));
});

await test("a file chosen in the editor is kept and served as data, never as a page", async () => {
  const png = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64");
  const up = await call("POST", `/api/game/${S}/assets?name=${encodeURIComponent("my hero.png")}`, png, { "content-type": "image/png" });
  assert.equal(up.status, 200, up.text);
  const { url } = json(up);
  assert.match(url, new RegExp(`^/api/game/${S}/assets/my-hero\\.png$`));
  const got = await fetch(base + url);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "image/png");
  assert.equal(got.headers.get("content-security-policy"), "sandbox");
  assert.equal(got.headers.get("x-content-type-options"), "nosniff");
  assert.equal(got.headers.get("access-control-allow-origin"), "*");
  assert.equal(Buffer.compare(Buffer.from(await got.arrayBuffer()), png), 0);
  const html = await call("POST", `/api/game/${S}/assets?name=page.html`, "<script>alert(1)</script>", { "content-type": "text/html" });
  assert.equal(html.status, 400, "a page is not a game file");
  assert.equal((await call("GET", `/api/game/${S}/assets/..%2F..%2Fgame-${S}.json`)).status, 404);
  assert.equal((await call("GET", `/api/game/${S}/assets/nothing.png`)).status, 404);
});

await test("a preview's files are kept and served in a box of their own", async () => {
  const put = await call("PUT", `/api/game/${S}/preview/abc123/preview/index.html`, "<h1>hi</h1><script src=x.js></script>", { "content-type": "text/html; charset=utf-8" });
  assert.equal(put.status, 200);
  const got = await fetch(`${base}/api/game/${S}/preview/abc123/preview/index.html`);
  assert.equal(got.status, 200);
  assert.equal(got.headers.get("content-type"), "text/html; charset=utf-8");
  const csp = got.headers.get("content-security-policy") ?? "";
  assert.match(csp, /^sandbox allow-scripts/);
  assert.ok(!/allow-same-origin/.test(csp), "the game never gets this app's origin");
  assert.equal(got.headers.get("access-control-allow-origin"), "*");
  assert.match(await got.text(), /<h1>hi<\/h1>/);
  assert.equal((await call("PUT", `/api/game/${S}/preview/abc123/preview/data.js`, "x=1", { "content-type": "text/javascript" })).status, 200);
  assert.equal(json(await call("DELETE", `/api/game/${S}/preview?prefix=${encodeURIComponent("/abc123/")}`)).deleted, 2);
  assert.equal((await fetch(`${base}/api/game/${S}/preview/abc123/preview/index.html`)).status, 404);
});

await test("a preview path cannot climb out", async () => {
  const sneaky = await fetch(`${base}/api/game/${S}/preview/a/..%2f..%2fx.js`, { method: "PUT", headers: { "content-type": "text/javascript" }, body: "x" });
  assert.equal(sneaky.status, 400);
  assert.equal((await call("PUT", `/api/game/${S}/preview/a/b c/x.js`, "x")).status, 400);
  assert.notEqual((await call("PUT", `/api/game/${S}/preview/`, "x")).status, 200);
});

await test("the Tools page switch refuses the editor's saves", async () => {
  const off = express();
  game.gameRoutes(off, { exists: () => true, incognito: () => false, off: () => true });
  const s2 = off.listen(0);
  const b2 = `http://127.0.0.1:${(s2.address() as { port: number }).port}`;
  const r = await fetch(`${b2}/api/game/${S}/project`, { method: "PUT", headers: { "content-type": "application/json" }, body: JSON.stringify({ project: json(await call("GET", `/api/game/${S}/project`)).project }) });
  assert.equal(r.status, 403);
  s2.close();
});

await test("a chat that goes takes its game, its files and its previews with it", () => {
  game.dropGame(S);
  assert.ok(!fs.existsSync(path.join(dir, `game-${S}.json`)));
  assert.ok(!fs.existsSync(path.join(dir, "game-assets", S)));
});

server.close();
console.log(`${passed} passed`);
process.exit(0);
