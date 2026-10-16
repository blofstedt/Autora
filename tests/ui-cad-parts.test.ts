/**
 * The 3D window's parts pane (a desktop): Shapes and Objects as named thumbnails, the Library beside them, and editing
 * inside a group. A library copy is independent: ordinary shapes that nothing follows.
 *
 * Needs the app and the 3D modeller built (npm run build).
 *
 *   npx tsx tests/ui-cad-parts.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

interface Body { id: string; name: string; groupId?: string; instanceOf?: string }
interface Group { id: string; name: string; libraryId?: string; place?: unknown; bodyIds: string[] }

async function waitFor(what: string, ok: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return;
    await sleep(200);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/autora-3d/index.html")) { console.log("  skip  the modeller is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-gl=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    const s = await app.newSession("Parts", "build");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".composer", { timeout: 20_000 });

    const guard = (req: { system: string }) => /You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null;
    const run = async (said: string, calls: Array<{ name: string; args: Record<string, unknown> }>) => {
      let n = 0;
      app.decide = (req) => guard(req) ?? (n < calls.length && req.tools.includes(calls[n].name) ? { tools: [calls[n++]] } : req.tools.length ? { text: "Done." } : { text: "SKIP" });
      await app.turn(s, said, 240_000);
    };
    const doc = async () => (await app.api("GET", `/api/cad/${s}/doc`)).body.doc as { bodies: Body[]; groups: Group[]; library: Array<{ id: string; name: string }> };

    // One batch, so the window takes the three shapes as one change.
    const add = (name: string, x: number, w: number, h: number) => ({ tool: "shape_add", args: { kind: "box", width: w, depth: w, height: h, x, name } });
    await run("two blocks and a peg", [{ name: "cad_batch", args: { commands: [add("Left", 0, 20, 10), add("Right", 40, 20, 10), add("Peg", 100, 10, 30)] } }]);
    const ids = (await doc()).bodies.filter((b) => b.name !== "Peg").map((b) => b.id);
    await run("group the blocks", [{ name: "cad_group_create", args: { ids, name: "Pair" } }]);
    for (let i = 0; i < 200 && !page.frames().some((f) => f.url().includes("/autora-3d/")); i++) await sleep(100);
    await sleep(4000);
    const f = (): Frame => page.frames().find((fr) => fr.url().includes("/autora-3d/"))!;

    await test("the pane lists each shape and each object with a thumbnail and its name", async () => {
      const pane = f().locator('aside[aria-label="Parts"]');
      await pane.waitFor({ timeout: 15_000 });
      assert.equal(await pane.locator('[role="tab"]').count(), 3);
      await pane.getByRole("tab", { name: /Shapes/ }).click();
      assert.equal(await pane.locator("img").count(), 3, "three shapes");
      assert.ok(await pane.getByText("Peg", { exact: true }).count());
      await pane.getByRole("tab", { name: /Objects/ }).click();
      assert.equal(await pane.locator("img").count(), 1, "one object");
      assert.ok(await pane.getByText("Pair", { exact: true }).count());
    });

    await test("the search box narrows the list by name, and the pane is a slim column", async () => {
      const pane = f().locator('aside[aria-label="Parts"]');
      await pane.getByRole("tab", { name: /Shapes/ }).click();
      const width = (await pane.boundingBox())!.width;
      assert.ok(width <= 200, `the pane is ${width}px wide`);
      await pane.getByLabel("Search by name").fill("peg");
      assert.equal(await pane.locator("img").count(), 1);
      await pane.getByLabel("Search by name").fill("zzz");
      assert.equal(await pane.locator("img").count(), 0);
      assert.ok(await pane.getByText(/No shapes match/).count());
      await pane.getByLabel("Search by name").fill("");
      assert.equal(await pane.locator("img").count(), 3);
    });

    await test("a shape and an object are named by double-clicking the name", async () => {
      const pane = f().locator('aside[aria-label="Parts"]');
      await pane.getByRole("tab", { name: /Shapes/ }).click();
      await pane.getByText("Peg", { exact: true }).dblclick();
      await pane.getByLabel("Name of Peg").fill("Dowel");
      await pane.getByLabel("Name of Peg").press("Enter");
      await waitFor("the new shape name", async () => (await doc()).bodies.some((b) => b.name === "Dowel"));
      await pane.getByRole("tab", { name: /Objects/ }).click();
      await pane.getByText("Pair", { exact: true }).dblclick();
      await pane.getByLabel("Name of Pair").fill("Twins");
      await pane.getByLabel("Name of Pair").press("Enter");
      await waitFor("the new object name", async () => (await doc()).groups.some((g) => g.name === "Twins"));
    });

    await test("both can be kept in the library, and a tap adds an independent copy", async () => {
      const pane = f().locator('aside[aria-label="Parts"]');
      await pane.getByRole("button", { name: "Save Twins to the library" }).click();
      await pane.getByRole("tab", { name: /Shapes/ }).click();
      await pane.getByRole("button", { name: "Save Dowel to the library" }).click();
      await waitFor("two library objects", async () => (await doc()).library.length === 2);
      assert.equal((await doc()).groups.filter((g) => g.libraryId).length, 0, "saving leaves the shapes as they were");
      const before = await doc();
      await pane.getByRole("tab", { name: /Library/ }).click();
      await pane.getByRole("button", { name: "Add a copy of Twins" }).click();
      await waitFor("the copy", async () => (await doc()).bodies.length === before.bodies.length + 2);
      const after = await doc();
      assert.ok(after.bodies.every((b) => !b.instanceOf), "no shape follows the library");
      assert.ok(after.groups.every((g) => !g.libraryId && !g.place), "no group is linked");
    });

    await test("editing inside a group shows only its shapes, and Exit group comes back", async () => {
      const pane = f().locator('aside[aria-label="Parts"]');
      await pane.getByRole("tab", { name: /Objects/ }).click();
      await pane.getByRole("button", { name: "Edit inside Twins" }).first().click();
      await f().getByText("Editing inside:", { exact: false }).waitFor({ timeout: 10_000 });
      await f().getByRole("button", { name: "Exit group" }).click();
      await waitFor("the banner to go", async () => (await f().getByText("Editing inside:", { exact: false }).count()) === 0);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
