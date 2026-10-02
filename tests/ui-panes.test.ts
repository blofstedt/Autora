/**
 * The desktop's three panes can be dragged to the width the person wants, the menu on
 * the left can be folded away to the far left (and brought back), and it is all
 * remembered. A phone is left alone.
 *
 *   npx tsx tests/ui-panes.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const s = await app.newSession("Panes", "build");
    // A document beside the conversation: PDF is the cheapest window to open.
    app.decide = (req) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : req.tools.length === 0 ? { text: "SKIP" } : { text: "Hello." });
    await app.turn(s, "hi");
    await app.api("POST", `/api/pdfdesk/${s}/blank`).catch(() => undefined);

    const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
    await page.goto(`${app.base}/?session=${s}`);
    const width = (sel: string) => page.locator(sel).first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
    await page.waitForSelector(".rail-slot");

    await test("dragging the seam by the menu changes its width, and it is remembered", async () => {
      const before = await width(".rail-slot");
      const h = (await page.locator(".pane-handle.is-rail").boundingBox())!;
      await page.mouse.move(h.x + h.width / 2, h.y + 200);
      await page.mouse.down();
      await page.mouse.move(h.x + h.width / 2 + 80, h.y + 200, { steps: 6 });
      await page.mouse.up();
      const after = await width(".rail-slot");
      assert.ok(after >= before + 70 && after <= before + 90, `${before} -> ${after}`);
      await page.reload();
      await page.waitForSelector(".rail-slot");
      assert.equal(await width(".rail-slot"), after);
    });

    await test("it keeps to its limits, and a double click puts it back", async () => {
      const h = (await page.locator(".pane-handle.is-rail").boundingBox())!;
      await page.mouse.move(h.x + 3, h.y + 200);
      await page.mouse.down();
      await page.mouse.move(h.x + 900, h.y + 200, { steps: 4 });
      await page.mouse.up();
      assert.ok((await width(".rail-slot")) <= 520);
      await page.locator(".pane-handle.is-rail").dblclick();
      const back = await width(".rail-slot");
      assert.ok(back >= 300 && back <= 340, String(back));
    });

    await test("the menu folds away to the far left, and the button there brings it back", async () => {
      await page.getByRole("button", { name: "Fold the menu away" }).click();
      assert.equal(await page.locator(".rail-slot").evaluate((el) => getComputedStyle(el).display), "none");
      const burger = page.getByRole("button", { name: "Open the menu" });
      const box = (await burger.boundingBox())!;
      assert.ok(box.x < 40, `the button sits at the far left (${box.x})`);
      await page.reload();
      await page.waitForSelector(".menu-btn");
      assert.equal(await page.locator(".rail-slot").evaluate((el) => getComputedStyle(el).display), "none", "folded stays folded");
      await page.getByRole("button", { name: "Open the menu" }).click();
      await sleep(200);
      assert.ok((await width(".rail-slot")) > 200);
      assert.equal(await page.locator(".drawer-scrim").count(), 0, "it came back in the margin, not as a sheet");
    });

    await test("with a document open beside the conversation, the seam between them drags too, and the window keeps room", async () => {
      const d = await app.newSession("Panes with a document", "build");
      let n = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (req.tools.length === 0) return { text: "SKIP" };
        n += 1;
        return n === 1 ? { tools: [{ name: "office_create", args: { type: "docx", name: "memo", markdown: "# Memo\n\nHello.\n" } }] } : { text: "Made." };
      };
      await app.turn(d, "make a memo", 120_000);
      const p2 = await browser.newPage({ viewport: { width: 1500, height: 900 } });
      await p2.goto(`${app.base}/?session=${d}`);
      await p2.waitForSelector(".pane-handle.is-chat", { state: "visible", timeout: 30_000 });
      const w = (sel: string) => p2.locator(sel).first().evaluate((el) => Math.round(el.getBoundingClientRect().width));
      const before = await w(".chat-view.has-app > .page");
      const h = (await p2.locator(".pane-handle.is-chat").boundingBox())!;
      await p2.mouse.move(h.x + h.width / 2, h.y + 300);
      await p2.mouse.down();
      await p2.mouse.move(h.x + h.width / 2 + 100, h.y + 300, { steps: 6 });
      await p2.mouse.up();
      const after = await w(".chat-view.has-app > .page");
      assert.ok(after >= before + 90 && after <= before + 110, `${before} -> ${after}`);
      // Dragged as far as it goes, the window beside it still has room.
      const h2 = (await p2.locator(".pane-handle.is-chat").boundingBox())!;
      await p2.mouse.move(h2.x + 3, h2.y + 300);
      await p2.mouse.down();
      await p2.mouse.move(h2.x + 1200, h2.y + 300, { steps: 6 });
      await p2.mouse.up();
      assert.ok((await w(".app-pane")) >= 300, `the window has ${await w(".app-pane")}px`);
      await p2.locator(".pane-handle.is-chat").dblclick();
      assert.ok((await w(".chat-view.has-app > .page")) <= 540);
    });

    await test("on a phone nothing of this appears", async () => {
      const phone = await browser.newPage({ viewport: { width: 390, height: 800 } });
      await phone.goto(`${app.base}/?session=${s}`);
      await sleep(1500);
      assert.equal(await phone.locator(".pane-handle.is-rail").evaluate((el) => getComputedStyle(el).display), "none");
      assert.ok(await phone.locator(".menu-btn").isVisible());
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}
main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
