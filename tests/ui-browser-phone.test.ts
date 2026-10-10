/**
 * The browser window on a phone: the paired-down one. A toolbar of back, reload, the address, drag and enlarge (no window
 * bar over it, no strip of tabs while there is one); Enlarge goes straight to full screen, magnified, with one button for
 * the page's size; and the toolbar is on top of the app's own header, not under it.
 *
 *   npx tsx tests/ui-browser-phone.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { startApp } from "./e2e-harness";

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
    const s = await app.newSession("Browse", "build");
    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".composer", { timeout: 20_000 });
    let n = 0;
    app.decide = (req) => {
      if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
      if (req.tools.length === 0) return { text: "SKIP" };
      return n++ === 0 ? { tools: [{ name: "browser_open", args: { url: `${app.base}/?page=tools` } }] } : { text: "Opened." };
    };
    await app.turn(s, "open the app's tools page", 120_000);
    await page.waitForSelector(".stage .cell.shot", { timeout: 30_000 });

    await test("the toolbar is the window: no bar of its own, no tab strip for one tab, and thumb-sized buttons", async () => {
      assert.equal(await page.locator(".stage .cell.shot .pdf-bar").count(), 0);
      assert.equal(await page.locator(".stage .cell.shot .shot-tabs").count(), 0);
      assert.equal(await page.locator('.stage .cell.shot .shot-address input').count(), 1);
      const sizes = await page.evaluate(() => [...document.querySelectorAll(".stage .cell.shot .cell-top button")].filter((b) => b.getClientRects().length > 0).map((b) => { const r = b.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)}`; }));
      assert.ok(sizes.length >= 3 && sizes.every((z) => Number(z.split("x")[1]) >= 40), `buttons: ${sizes.join(" ")}`);
    });

    await test("Enlarge is full screen at once, magnified, with one button for the size; the toolbar is above the app's header", async () => {
      await page.locator(".stage .cell.shot .shot-corner").click();
      await page.waitForSelector(".cell.shot.is-max", { timeout: 10_000 });
      assert.match(await page.locator(".shot-zoom-cycle").innerText(), /2×/);
      const top = await page.evaluate(() => {
        const el = document.querySelector(".cell.shot.is-max .cell-top")!;
        const r = el.getBoundingClientRect();
        const hit = document.elementFromPoint(r.left + 30, r.top + r.height / 2);
        return { y: Math.round(r.top), inside: !!hit && !!hit.closest(".cell.shot.is-max") };
      });
      assert.ok(top.y < 40 && top.inside, `the toolbar is covered: ${JSON.stringify(top)}`);
      await page.locator(".shot-zoom-cycle").click();
      assert.match(await page.locator(".shot-zoom-cycle").innerText(), /3×/);
      await page.locator(".cell.shot.is-max .shot-corner").click();
      await page.waitForSelector(".cell.shot.is-max", { state: "detached", timeout: 10_000 });
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
