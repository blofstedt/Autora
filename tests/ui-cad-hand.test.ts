/**
 * The 3D window with Visible work on: the agent's modelling is done with the modeller's own controls, live -- a shape
 * from the Shape tray, its sizes typed into Size & position, shapes picked in the viewport and Join, Subtract, Group or
 * Delete pressed -- and the agent is told it was done by hand.
 *
 * Needs the app and the 3D modeller built (npm run build).
 *
 *   npx tsx tests/ui-cad-hand.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

interface Body { id: string; name: string; points: Array<{ x: number; y: number }>; extrusionHeight: number; elevation?: number }
/** A shape's footprint and height, rounded to the millimetre. */
const sizeOf = (b: Body) => {
  const xs = b.points.map((p) => p.x);
  const ys = b.points.map((p) => p.y);
  return { w: Math.round(Math.max(...xs) - Math.min(...xs)), d: Math.round(Math.max(...ys) - Math.min(...ys)), h: Math.round(b.extrusionHeight), x: Math.round(Math.min(...xs)), y: Math.round(Math.min(...ys)) };
};

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/autora-3d/index.html")) { console.log("  skip  the modeller is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const s = await app.newSession("Stand", "build");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    page.on("console", (m) => { if (/error/i.test(m.text())) console.log(`    ${m.text().slice(0, 300)}`); });
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".composer", { timeout: 20_000 });

    const guard = (req: { system: string }) => /You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null;
    const run = async (said: string, calls: Array<{ name: string; args: Record<string, unknown> }>) => {
      let n = 0;
      app.seen.length = 0;
      // Only the turn's own steps get the calls: a request offering no such tool is one of the app's own, in the background.
      app.decide = (req) => guard(req) ?? (n < calls.length && req.tools.includes(calls[n].name) ? { tools: [calls[n++]] } : req.tools.length ? { text: "Done." } : { text: "SKIP" });
      await app.turn(s, said, 240_000);
      const out = app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n").replace(/\\+"/g, '"');
      assert.doesNotMatch(out, /Not by hand \(/, out.slice(-1500));
      return out;
    };
    const bodies = async () => ((await app.api("GET", `/api/cad/${s}/doc`)).body.doc.bodies ?? []) as Body[];
    let pointer = 0;
    const watch = setInterval(() => {
      void page.frames().find((f) => f.url().includes("/autora-3d/"))?.evaluate(() => {
        const a = document.querySelector("svg path.a")?.closest("svg")?.parentElement;
        return a ? getComputedStyle(a).opacity !== "0" : false;
      }).then((on) => { if (on) pointer++; }).catch(() => undefined);
    }, 120);

    // The window opens with the first call and needs a moment to start; the first hand waits for it.
    await run("open the 3D window", [{ name: "cad_scene_get", args: {} }]);
    for (let i = 0; i < 200 && !page.frames().some((f) => f.url().includes("/autora-3d/")); i++) await sleep(100);
    await sleep(3000);

    let box = "";
    await test("a box from the Shape tray, its sizes typed into Size & position, by hand", async () => {
      const out = await run("make a box 40 by 30 by 20", [{ name: "cad_shape_add", args: { kind: "box", width: 40, depth: 30, height: 20, name: "Base" } }]);
      assert.match(out, /Done by hand in the 3D window/, out.slice(-1500));
      const b = await bodies();
      assert.equal(b.length, 1, JSON.stringify(b));
      const z = sizeOf(b[0]);
      assert.deepEqual([z.w, z.d, z.h], [40, 30, 20], JSON.stringify(z));
      box = b[0].id;
    });

    await test("a move typed into X, Y and Z", async () => {
      const before = sizeOf((await bodies())[0]);
      const out = await run("move it", [{ name: "cad_shape_move", args: { ids: [box], by: { x: 10, y: 5 } } }]);
      assert.match(out, /Done by hand in the 3D window/, out.slice(-1500));
      const b = (await bodies()).find((x) => x.id === box)!;
      assert.ok(b, "the same shape, by the same id");
      const z = sizeOf(b);
      assert.deepEqual([z.x - before.x, z.y - before.y, z.w], [10, 5, 40], JSON.stringify(z));
    });

    await test("a resize typed into Width", async () => {
      const out = await run("make it wider", [{ name: "cad_shape_resize", args: { id: box, width: 60 } }]);
      assert.match(out, /Done by hand in the 3D window/, out.slice(-1500));
      assert.equal(sizeOf((await bodies()).find((x) => x.id === box)!).w, 60);
      assert.ok(pointer > 0, "the agent's pointer was there");
    });

    await test("a delete: the shape picked in the viewport and Delete pressed", async () => {
      const out = await run("remove it", [{ name: "cad_shape_delete", args: { ids: [box] } }]);
      assert.match(out, /Done by hand in the 3D window/, out.slice(-1500));
      assert.ok(!(await bodies()).some((x) => x.id === box));
    });
    await test("two shapes picked in the viewport and Join pressed", async () => {
      await run("two blocks", [
        { name: "cad_shape_add", args: { kind: "box", width: 20, depth: 20, height: 10, name: "A" } },
        { name: "cad_shape_add", args: { kind: "box", width: 20, depth: 20, height: 10, x: 10, name: "B" } },
      ]);
      const ids = (await bodies()).map((b) => b.id);
      assert.equal(ids.length, 2);
      const out = await run("join them", [{ name: "cad_shapes_join", args: { ids } }]);
      assert.match(out, /picked the shapes in the view; pressed Join/, out.slice(-1500));
      assert.equal((await bodies()).length, 1);
      await run("clear", [{ name: "cad_shape_delete", args: { ids: (await bodies()).map((b) => b.id) } }]);
    });

    await test("two shapes picked in the viewport, shift for the second, and Group pressed and named", async () => {
      await run("two blocks", [
        { name: "cad_shape_add", args: { kind: "box", width: 20, depth: 20, height: 10, name: "Left" } },
        { name: "cad_shape_add", args: { kind: "box", width: 20, depth: 20, height: 10, x: 40, name: "Right" } },
      ]);
      const ids = (await bodies()).map((b) => b.id);
      assert.equal(ids.length, 2);
      const out = await run("group them", [{ name: "cad_group_create", args: { ids, name: "Feet" } }]);
      assert.match(out, /Done by hand in the 3D window/, out.slice(-1500));
      const doc = (await app.api("GET", `/api/cad/${s}/doc`)).body.doc as { groups: Array<{ name: string }> };
      assert.deepEqual(doc.groups.map((g) => g.name), ["Feet"]);
    });
    clearInterval(watch);
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
