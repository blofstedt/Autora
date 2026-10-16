/**
 * Load, from the server's side: which saved file each app takes (the one test the picker and the route share), what the
 * route refuses, and a model kept by Autora 3D loaded back into a chat.
 *
 *   npx tsx tests/loadfile.test.ts
 */
import assert from "node:assert/strict";
import { LOAD_APPS, loadable } from "../src/lib/loadable";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

await test("each app takes what it can open, and nothing it cannot", () => {
  const f = (name: string, mime = "application/octet-stream") => ({ name, mime });
  assert.ok(loadable("pdf", f("a.pdf", "application/pdf")));
  assert.ok(!loadable("pdf", f("a.docx")));
  assert.ok(loadable("pages", f("Memo.DOCX")) && !loadable("pages", f("a.xlsx")));
  assert.ok(loadable("sheets", f("a.xlsx")) && loadable("slides", f("a.pptx")));
  assert.ok(loadable("photo", f("p.png", "image/png")) && loadable("photo", f("layers.psd")) && !loadable("photo", f("a.pdf")));
  assert.ok(loadable("video", f("clip.mp4", "video/mp4")) && loadable("video", f("song.wav", "audio/wav")) && !loadable("video", f("a.docx")));
  assert.ok(loadable("studio", f("Night.song.json")) && !loadable("studio", f("other.json")));
  assert.ok(loadable("cad", f("Stand.model.json")) && !loadable("cad", f("Stand.glb")));
  assert.ok(loadable("game", f("Game.json")) && loadable("game", f("hero.png", "image/png")) && loadable("game", f("theme.ogg")));
  for (const a of LOAD_APPS) assert.ok(!loadable(a, f("readme.txt", "text/plain")), `${a} takes a text file`);
});

const app = await startApp();
try {
  const upload = async (name: string, body: string) => {
    const res = await fetch(`${app.base}/api/artifacts`, { method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": name }, body });
    return ((await res.json()) as { artifact: { id: string } }).artifact.id;
  };
  const s = await app.newSession("Loading", "build");
  const post = (body: Record<string, unknown>, session = s) => app.api("POST", `/api/sessions/${session}/load`, body);

  await test("the route refuses what is not asked properly: an unknown chat, app or file, and a file the app cannot open", async () => {
    const id = await upload("notes.txt", "hello");
    assert.equal((await post({ app: "pdf", artifact: id }, "nope")).status, 404);
    assert.equal((await post({ app: "toaster", artifact: id })).status, 400);
    assert.equal((await post({ app: "pdf", artifact: "file_0000000000000000" })).status, 404);
    const r = await post({ app: "studio", artifact: id });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /cannot open notes\.txt/);
  });

  await test("a song that is not one is refused with what is wrong, and one that is loads", async () => {
    const bad = await upload("broken.song.json", "{ not json");
    const r = await post({ app: "studio", artifact: bad });
    assert.equal(r.status, 400);
    assert.match(r.body.error, /not a song/);
    const empty = await upload("empty.song.json", JSON.stringify({ name: "x" }));
    assert.equal((await post({ app: "studio", artifact: empty })).status, 400);
    const good = await upload("ok.song.json", JSON.stringify({ name: "Loaded", bpm: 120, tracks: [] }));
    const done = await post({ app: "studio", artifact: good });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    assert.equal((await app.api("GET", `/api/studio/${s}/doc`)).body.doc.name, "Loaded");
  });

  await test("a model Autora 3D kept loads back into the chat's model, as the agent's own change", async () => {
    const probe = await app.api("POST", `/api/cad/${s}/open`);
    if (probe.status !== 200) { console.log("    (Autora 3D is not built here: skipped)"); return; }
    app.script.push({ tools: [{ name: "cad_shape_add", args: { kind: "box", width: 30, depth: 20, height: 10, name: "Kept" } }] });
    app.script.push({ text: "Made." });
    await app.turn(s, "make a block");
    const had = (await app.api("GET", `/api/cad/${s}`)).body.shapes as number;
    assert.ok(had >= 1);
    const kept = await app.api("POST", `/api/cad/${s}/keep`);
    assert.equal(kept.status, 200, JSON.stringify(kept.body));
    const list = (await app.api("GET", "/api/artifacts")).body.artifacts as Array<{ id: string; name: string }>;
    const model = list.find((a) => /\.model\.json$/.test(a.name));
    assert.ok(model, `a .model.json next to the GLB in ${list.map((a) => a.name).join(", ")}`);
    // A different model is in the chat now; loading puts the kept one back.
    app.script.push({ tools: [{ name: "cad_doc_clear", args: {} }] });
    app.script.push({ text: "Cleared." });
    await app.turn(s, "clear it");
    assert.equal((await app.api("GET", `/api/cad/${s}`)).body.shapes, 0);
    const done = await post({ app: "cad", artifact: model!.id });
    assert.equal(done.status, 200, JSON.stringify(done.body));
    await sleep(200);
    const state = (await app.api("GET", `/api/cad/${s}`)).body;
    assert.equal(state.shapes, had);
    assert.equal(state.by, "agent");
  });
} finally {
  await app.stop();
}
console.log(`${passed} passed`);
process.exit(0);
