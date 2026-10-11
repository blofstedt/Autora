/**
 * Pages, Sheets and Slides on the tool bar (office/shim/rail.js, docs/TOOL-RAIL.md), in a real browser with the real editors:
 * the ribbon is never seen, the bar is down the right of a desktop with the common tools, All tools holds every command of
 * the ribbon (one group per tab, each tile pinnable), the editor's own keyboard shortcuts still work and the bar's tools
 * light up with them, and the tooltips say the shortcut.
 *
 * Needs the app and the Office editors built (npm run build, then node scripts/build-office.mjs); skips without a browser.
 *
 *   npx tsx tests/ui-office-rail.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);

async function until(what: string, fn: () => Promise<boolean>, ms = 20_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await fn().catch(() => false)) return; await sleep(200); }
  throw new Error(`timed out waiting for ${what}`);
}
const editorOf = (page: Page): Frame | undefined => page.frames().find((f) => f !== page.mainFrame() && f.url().includes("/office-app/"));

const DOCS = { name: "office_create", args: { type: "docx", name: "memo", markdown: "# Memo\n\nHello team.\n" } };
const SHEETS = { name: "office_create", args: { type: "xlsx", name: "pets", rows: [["Breed", "Weight"], ["Beagle", 10.5]] } };

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/office/web/docs/index.html")) { console.log("  skip  the Office editors are not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    for (const [app_, tool, bold] of [["docs", DOCS, "text=Hello team."], ["sheets", SHEETS, ""]] as const) {
      const s = await app.newSession(app_, "build");
      let n = 0;
      app.decide = (req) => guard(req) ?? (n++ === 0 ? { tools: [tool] } : { text: "Done." });
      await app.turn(s, "go", 120_000);
      app.decide = null;
      const page = await (await browser.newContext({ viewport: { width: 1440, height: 900 } })).newPage();
      await page.goto(`${app.base}/?session=${s}`);
      await page.waitForSelector(".office-window");
      await until("the editor's frame", async () => !!editorOf(page), 40_000);
      const frame = editorOf(page)!;
      await frame.waitForSelector("#autora-rail", { timeout: 40_000 });

      await test(`${app_}: the ribbon is not shown, and the bar is on the right with the common tools`, async () => {
        await until("the ribbon to be closed", async () => ((await frame.evaluate(() => document.querySelector(".ribbon, header.excel-header")?.getBoundingClientRect().height ?? 0)) < 2));
        const bar = await frame.evaluate(() => { const r = document.querySelector("#autora-rail")!.getBoundingClientRect(); return { right: window.innerWidth - r.right, buttons: document.querySelectorAll("#autora-rail button").length, mid: Math.abs((r.top + r.bottom) / 2 - window.innerHeight / 2) }; });
        assert.ok(bar.right < 20 && bar.mid < 10, "down the right, centred");
        assert.ok(bar.buttons >= 10, "as many tools as fit, and the grid button");
      });

      await test(`${app_}: All tools holds every command of the ribbon, grouped by tab, and each tile can be pinned`, async () => {
        await until("the ribbon to be read", async () => { await frame.click('#autora-rail [aria-label="All tools"]'); const groups = (await frame.locator("#autora-grid h4").allTextContents()).map((g) => g.trim()); await frame.click('#autora-grid [aria-label="Close"]'); return groups.includes("Insert") && groups.includes("View"); }, 40_000);
        await frame.click('#autora-rail [aria-label="All tools"]');
        assert.ok((await frame.locator("#autora-grid .ar-tile").count()) > 60, "dozens of commands, not a handful");
        assert.ok((await frame.locator("#autora-grid .ar-pin").count()) > 60, "each with a pin");
        await frame.click('#autora-grid [aria-label="Close"]');
        assert.equal(await frame.locator("#autora-grid").count(), 0);
      });

      await test(`${app_}: the editor's keyboard shortcuts still work, and the bar's tools follow them`, async () => {
        if (bold) await frame.locator(bold).first().click(); else await page.mouse.click(1000, 400);
        await page.keyboard.press("Control+A");
        await page.keyboard.press("Control+B");
        await until("Bold to light up on the bar", async () => (await frame.locator('#autora-rail [aria-label="Bold"].on').count()) === 1);
        await page.keyboard.press("Control+B");
        await until("Bold to go out again", async () => (await frame.locator('#autora-rail [aria-label="Bold"].on').count()) === 0);
        assert.match((await frame.locator('#autora-rail [aria-label="Bold"]').getAttribute("title")) ?? "", /Ctrl\+B/i, "the tooltip says the shortcut");
      });

      await test(`${app_}: a tool on the bar does what its ribbon button does`, async () => {
        if (bold) await frame.locator(bold).first().click(); else await page.mouse.click(1000, 400);
        await page.keyboard.press("Control+A");
        await frame.click('#autora-rail [aria-label="Italic"]');
        await until("Italic to be on", async () => (await frame.locator('#autora-rail [aria-label="Italic"].on').count()) === 1);
        await frame.click('#autora-rail [aria-label="Italic"]');
      });
      await page.close();
    }
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
