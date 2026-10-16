/**
 * The 3D window with Visible work on, for the rest of the cad_* calls: each is done with the modeller's own controls,
 * live, and the agent is told it was done by hand -- Draw (a rectangle dragged out, corners tapped, a circle on a shape's
 * top, a hole cut through), a turn with the ring, a wall's and a top's number typed, a bevel's handle dragged, Properties
 * and Material, Duplicate, a group renamed and dissolved, a repeat's count stepped and its end dragged, the library's
 * Save, Library and remove, Undo and Redo in the top bar, a batch one command at a time, and the whole model cleared.
 *
 * Each test starts from a model put in at speed (Visible work off for a moment), so it does not lean on the one before.
 * Needs the app and the 3D modeller built (npm run build).
 *
 *   npx tsx tests/ui-cad-hand-tools.test.ts            (CAD_ONLY=draw,turn to run some)
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
const only = (process.env.CAD_ONLY ?? "").split(",").filter(Boolean);
async function test(tag: string, name: string, fn: () => Promise<void>) {
  if (only.length && !only.includes(tag)) return;
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

interface Body { id: string; name: string; points: Array<{ x: number; y: number }>; extrusionHeight: number; elevation?: number; color: string; materialType: string; visible: boolean; holes?: unknown[]; edgeBevels?: Array<{ size: number; style?: string }>; groupId?: string }
interface Doc { bodies: Body[]; groups: Array<{ id: string; name: string; bodyIds: string[]; libraryId?: string }>; repeats: Array<{ bodyId: string; count: number }>; library: Array<{ id: string; name: string }> }
const box = (b: Body) => {
  const xs = b.points.map((p) => p.x);
  const ys = b.points.map((p) => p.y);
  return { w: Math.round(Math.max(...xs) - Math.min(...xs)), d: Math.round(Math.max(...ys) - Math.min(...ys)), h: Math.round(b.extrusionHeight), cx: Math.round((Math.max(...xs) + Math.min(...xs)) / 2), cy: Math.round((Math.max(...ys) + Math.min(...ys)) / 2) };
};

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/autora-3d/index.html")) { console.log("  skip  the modeller is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const s = await app.newSession("Workshop", "build");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (m) => { if (/error/i.test(m.text())) console.log(`    ${m.text().slice(0, 300)}`); });
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".composer", { timeout: 20_000 });

    const guard = (req: { system: string }) => /You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null;
    type Call = { name: string; args: Record<string, unknown> };
    const run = async (said: string, calls: Call[], opts: { notByHand?: boolean } = {}) => {
      let n = 0;
      app.seen.length = 0;
      // Only the turn's own steps get the calls: a request offering no such tool is one of the app's own, in the background.
      app.decide = (req) => guard(req) ?? (n < calls.length && req.tools.includes(calls[n].name) ? { tools: [calls[n++]] } : req.tools.length ? { text: "Done." } : { text: "SKIP" });
      await app.turn(s, said, 300_000);
      const out = app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n").replace(/\\+"/g, '"');
      if (!opts.notByHand) assert.doesNotMatch(out, /Not by hand \(/, out.slice(-1500));
      return out;
    };
    const byHand = async (said: string, calls: Call[]) => {
      const out = await run(said, calls);
      assert.match(out, /Done by hand in the 3D window/, out.slice(-1500));
      return out;
    };
    const doc = async () => (await app.api("GET", `/api/cad/${s}/doc`)).body.doc as Doc;
    const named = async (n: string) => {
      const d = await doc();
      const b = d.bodies.find((x) => x.name === n);
      assert.ok(b, `no shape named ${n} in ${JSON.stringify(d.bodies.map((x) => x.name))}\n${app.log().split("\n").filter((l) => l.includes("[cad")).slice(-15).join("\n")}`);
      return b;
    };
    /** A model to start from, put in at speed. */
    const start = async (calls: Call[]) => {
      await app.api("PATCH", "/api/agent-cursor", { on: false });
      await run("set up", [{ name: "cad_doc_clear", args: {} }, ...calls]);
      await app.api("PATCH", "/api/agent-cursor", { on: true });
      await sleep(1200);
    };
    const add = (name: string, extra: Record<string, unknown> = {}): Call => ({ name: "cad_shape_add", args: { kind: "box", width: 40, depth: 40, height: 20, x: 0, y: 0, name, ...extra } });

    // The window opens with the first call and needs a moment to start.
    await run("open the 3D window", [{ name: "cad_scene_get", args: {} }]);
    for (let i = 0; i < 200 && !page.frames().some((f) => f.url().includes("/autora-3d/")); i++) await sleep(100);
    await sleep(3000);

    await test("add", "a shape on top of another, named, coloured and given a finish, by hand", async () => {
      await start([add("Base")]);
      const base = await named("Base");
      const out = await byHand("put a red metal cylinder on top", [{ name: "cad_shape_add", args: { kind: "cylinder", width: 20, height: 30, onTopOf: base.id, name: "Post", color: "#ef4444", material: "metal" } }]);
      assert.match(out, /picked the top face/);
      assert.match(out, /typed the name "Post" in Properties/);
      assert.match(out, /chose Crimson Red in Material/);
      const post = await named("Post");
      assert.equal(post.color.toLowerCase(), "#ef4444");
      assert.equal(post.materialType, "metal");
      assert.equal(post.elevation, 20);
    });

    await test("draw", "Draw: a rectangle dragged out on the ground, and its height typed", async () => {
      await start([add("Base", { x: -80 })]);
      const out = await byHand("draw a plate", [{ name: "cad_shape_draw", args: { form: "rectangle", from: { x: 0, y: -15 }, to: { x: 50, y: 15 }, height: 6, name: "Plate" } }]);
      assert.match(out, /dragged out a rectangle with Draw/);
      const plate = await named("Plate");
      assert.deepEqual([box(plate).w, box(plate).d, box(plate).h], [50, 30, 6]);
    });

    await test("draw", "Draw: corners tapped one by one, then Finish", async () => {
      await start([add("Base", { x: -80 })]);
      const out = await byHand("draw a triangle", [{ name: "cad_shape_draw", args: { form: "polygon", points: [{ x: 0, y: 0 }, { x: 40, y: 0 }, { x: 0, y: 30 }], height: 10, name: "Wedge" } }]);
      assert.match(out, /tapped 3 corners with Draw/);
      assert.match(out, /pressed Finish/);
      assert.equal((await named("Wedge")).points.length, 3);
    });

    await test("draw", "Draw: a circle on the top of a shape, and a hole cut through one", async () => {
      await start([add("Base", { width: 60, depth: 60 })]);
      const base = await named("Base");
      let out = await byHand("a knob on top", [{ name: "cad_shape_draw", args: { form: "circle", center: { x: 0, y: 0 }, radius: 8, surface: { topOf: base.id }, height: 5, name: "Knob" } }]);
      assert.match(out, /dragged out a circle with Draw/);
      assert.equal((await named("Knob")).elevation, 20);
      await start([add("Base", { width: 60, depth: 60 })]);
      const again = await named("Base");
      out = await byHand("a hole through it", [{ name: "cad_shape_cut", args: { target: again.id, form: "circle", center: { x: 10, y: 10 }, radius: 6 } }]);
      assert.match(out, /picked the top face to cut into/);
      assert.ok((await doc()).bodies.some((b) => (b.holes ?? []).length > 0), "a hole in the shape");
    });

    await test("turn", "a turn: the ring dragged round", async () => {
      await start([{ name: "cad_shape_add", args: { kind: "box", width: 60, depth: 20, height: 20, x: 0, y: 0, name: "Bar" } }]);
      const bar = await named("Bar");
      const out = await byHand("turn it a quarter", [{ name: "cad_shape_turn", args: { ids: [bar.id], degrees: 90 } }]);
      assert.match(out, /dragged the ring round 90°/);
      assert.deepEqual([box(await named("Bar")).w, box(await named("Bar")).d], [20, 60]);
    });

    await test("faces", "a wall's number and the top's typed on the picked face", async () => {
      await start([add("Block")]);
      const block = await named("Block");
      let out = await byHand("make it 70 wide", [{ name: "cad_face_set", args: { id: block.id, face: { kind: "wall", index: 1 }, value: 70 } }]);
      assert.match(out, /picked the wall in the view/);
      assert.match(out, /on the face/);
      out = await byHand("pull the top up 15", [{ name: "cad_face_push", args: { id: block.id, face: "top", by: 15 } }]);
      assert.match(out, /typed Height 35 on the face/);
      assert.equal(box(await named("Block")).h, 35);
    });

    await test("bevel", "a bevel: the top edges picked with Pick edges, the handle tapped and Curved edge dragged", async () => {
      await start([add("Block", { width: 60, depth: 60, height: 30 })]);
      const block = await named("Block");
      const out = await byHand("round the top", [{ name: "cad_edge_bevel", args: { id: block.id, group: "top", size: 4, style: "round" } }]);
      assert.match(out, /picked the top edges with Pick edges/);
      assert.match(out, /pressed Curved edge and dragged it/);
      assert.ok(((await named("Block")).edgeBevels ?? []).some((e) => e.size > 0));
    });

    await test("set", "Properties and Material: a name, a colour, a finish, the corners rounded, then hidden", async () => {
      await start([add("Block")]);
      const block = await named("Block");
      const out = await byHand("tidy it", [{ name: "cad_shape_set", args: { id: block.id, name: "Lid", color: "#10b981", material: "glossy", cornerRadius: 5 } }]);
      assert.match(out, /typed All corners 5 in Properties/);
      const lid = await named("Lid");
      assert.equal(lid.materialType, "glossy");
      assert.equal(lid.color.toLowerCase(), "#10b981");
      await byHand("hide it", [{ name: "cad_shape_set", args: { id: lid.id, visible: false } }]);
      assert.equal((await named("Lid")).visible, false);
    });

    await test("dup", "Duplicate in Properties, the copy moved where it was asked", async () => {
      await start([add("Block")]);
      const block = await named("Block");
      const out = await byHand("copy it to the right", [{ name: "cad_shape_duplicate", args: { ids: [block.id], by: { x: 60, y: 0 } } }]);
      assert.match(out, /pressed Duplicate in Properties/);
      const all = (await doc()).bodies;
      assert.equal(all.length, 2);
      assert.deepEqual(all.map((b) => box(b).cx).sort((a, b) => a - b), [0, 60]);
    });

    await test("groups", "a group renamed in the top bar, then ungrouped", async () => {
      await start([add("A", { x: -40 }), add("B", { x: 40 })]);
      const d = await doc();
      await run("group", [{ name: "cad_group_create", args: { ids: d.bodies.map((b) => b.id), name: "Pair" } }]);
      const g = (await doc()).groups[0];
      let out = await byHand("rename it", [{ name: "cad_group_rename", args: { group: g.id, name: "Twins" } }]);
      assert.match(out, /named it "Twins" in the top bar/);
      assert.equal((await doc()).groups[0].name, "Twins");
      out = await byHand("ungroup it", [{ name: "cad_group_remove", args: { group: g.id } }]);
      assert.match(out, /pressed Ungroup/);
      assert.equal((await doc()).groups.length, 0);
    });

    await test("repeat", "a repeat: Repeat pressed, the count stepped, the end dragged, kept; then let go", async () => {
      await start([add("Peg", { width: 10, depth: 10 })]);
      const peg = await named("Peg");
      let out = await byHand("three in a row", [{ name: "cad_repeat_set", args: { id: peg.id, count: 3, gap: 30 } }]);
      assert.match(out, /stepped the count to 3/);
      assert.match(out, /kept the copies/);
      assert.equal((await doc()).repeats[0]?.count, 3);
      out = await byHand("let them go", [{ name: "cad_repeat_remove", args: { id: peg.id } }]);
      assert.match(out, /pressed Make copies separate/);
      assert.equal((await doc()).repeats.length, 0);
    });

    await test("library", "the library: Save to library, placed from Library, then removed", async () => {
      await start([add("Knob", { width: 20, depth: 20 })]);
      const knob = await named("Knob");
      let out = await byHand("keep it", [{ name: "cad_library_save", args: { id: knob.id, name: "Knob" } }]);
      assert.match(out, /pressed Save to library/);
      const item = (await doc()).library[0];
      assert.ok(item, "an object in the library");
      out = await byHand("place another", [{ name: "cad_library_place", args: { item: item.id, x: 60, y: 0 } }]);
      assert.match(out, /placed Knob from the Library/);
      out = await byHand("forget it", [{ name: "cad_library_remove", args: { item: item.id } }]);
      assert.match(out, /pressed remove beside Knob/);
      assert.equal((await doc()).library.length, 0);
    });

    await test("group-shape", "a shape inside a group: clicked again until only it is picked, then resized", async () => {
      await start([add("A", { x: -40 }), add("B", { x: 40 })]);
      const d = await doc();
      await run("group", [{ name: "cad_group_create", args: { ids: d.bodies.map((b) => b.id), name: "Pair" } }]);
      const a = await named("A");
      const out = await byHand("make A taller", [{ name: "cad_shape_resize", args: { id: a.id, height: 45 } }]);
      assert.match(out, /picked the shape in the view/);
      assert.equal(box(await named("A")).h, 45);
      assert.equal(box(await named("B")).h, 20, "its group-mate stays as it was");
    });

    await test("cutters", "a subtract with two cutters: Subtract pressed once for each", async () => {
      await start([
        { name: "cad_shape_add", args: { kind: "box", width: 100, depth: 40, height: 20, x: 0, y: 0, name: "Slab" } },
        { name: "cad_shape_add", args: { kind: "cylinder", width: 12, height: 40, x: -30, y: 0, name: "Drill 1" } },
        { name: "cad_shape_add", args: { kind: "cylinder", width: 12, height: 40, x: 30, y: 0, name: "Drill 2" } },
      ]);
      const d = await doc();
      const id = (n: string) => d.bodies.find((b) => b.name === n)!.id;
      const out = await byHand("drill two holes", [{ name: "cad_shapes_subtract", args: { from: [id("Slab")], cutters: [id("Drill 1"), id("Drill 2")] } }]);
      assert.equal((out.match(/pressed Subtract/g) ?? []).length, 2, out.slice(-1500));
      assert.ok(!(await doc()).bodies.some((b) => b.name.startsWith("Drill")), "the cutters are used up");
    });

    await test("wall", "Draw on a wall: the wall picked, Draw pressed, a rectangle dragged out on it", async () => {
      await start([{ name: "cad_shape_add", args: { kind: "box", width: 60, depth: 60, height: 60, x: 0, y: 0, name: "Cube" } }]);
      const cube = await named("Cube");
      const out = await byHand("a plaque on its side", [{ name: "cad_shape_draw", args: { form: "rectangle", from: { x: -10, y: -8 }, to: { x: 10, y: 8 }, surface: { wallOf: cube.id, wall: 0 }, height: 3, name: "Plaque" } }]);
      assert.match(out, /picked the wall to draw on/);
      assert.match(out, /dragged out a rectangle with Draw/);
      assert.ok((await doc()).bodies.some((b) => b.name === "Plaque"));
    });

    await test("history", "Undo and Redo pressed in the top bar", async () => {
      await start([add("Block")]);
      const block = await named("Block");
      await byHand("taller", [{ name: "cad_shape_resize", args: { id: block.id, height: 50 } }]);
      let out = await byHand("undo that", [{ name: "cad_history_undo", args: {} }]);
      assert.match(out, /pressed Undo in the top bar/);
      assert.equal(box(await named("Block")).h, 20);
      out = await byHand("redo it", [{ name: "cad_history_redo", args: {} }]);
      assert.match(out, /pressed Redo in the top bar/);
      assert.equal(box(await named("Block")).h, 50);
    });

    await test("batch", "a batch, one command at a time; and the whole model cleared by picking it all and Delete", async () => {
      await start([]);
      const out = await byHand("two blocks", [{ name: "cad_batch", args: { commands: [
        { tool: "cad_shape_add", args: { kind: "box", width: 30, depth: 30, height: 10, x: -40, y: 0, name: "Left" } },
        { tool: "cad_shape_add", args: { kind: "box", width: 30, depth: 30, height: 10, x: 40, y: 0, name: "Right" } },
      ] } }]);
      assert.equal((out.match(/added a box from the Shape tray/g) ?? []).length, 2);
      assert.equal((await doc()).bodies.length, 2);
      await byHand("clear it all", [{ name: "cad_doc_clear", args: {} }]);
      assert.equal((await doc()).bodies.length, 0);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
