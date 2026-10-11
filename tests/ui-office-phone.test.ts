/**
 * The Office window on a phone: the document as pictures of its pages (drawn once,
 * kept), tap the words to point at them, and what was pointed at goes with the next
 * message to the agent. The full editor is a button away.
 *
 *   npx tsx tests/ui-office-phone.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
async function until(what: string, ok: () => Promise<boolean>, ms = 90_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/office/web/slides/index.html") || !fs.existsSync("dist/office/host/slides.cjs")) { console.log("  skip  the PowerPoint editor is not built"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const s = await app.newSession("Phone", "build");
    let step = 0;
    app.decide = (req) => {
      if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
      if (req.tools.length === 0) return { text: "SKIP" };
      step += 1;
      if (step === 1) return { tools: [{ name: "office_create", args: { type: "pptx", name: "pitch", spec: { pages: [{ title: "Hello", type: "cover", background: "#0E1A2B", elements: [{ type: "shape", shape: "rect", x: 80, y: 80, w: 600, h: 120, fill: "#1F3A5F", paragraphs: [{ align: "left", runs: [{ text: "Quarterly review", sizePt: 40, color: "#FFFFFF" }] }] }] }] } } }] };
      return { text: "Done." };
    };
    await app.turn(s, "make a one-slide deck", 120_000);

    const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 2 });
    const page = await ctx.newPage();
    await page.goto(`${app.base}/?session=${s}`);

    await test("on a phone the deck opens as pictures of its slides, not as the editor", async () => {
      await until("the slide picture", async () => (await page.locator(".office-page img").count()) > 0);
      assert.equal(page.frames().filter((f) => f.url().includes("/office-app/")).length, 0, "no editor was loaded");
      assert.equal(await page.locator(".office-page").count(), 1);
      if (process.env.OFFICE_SHOT) await page.screenshot({ path: `${process.env.OFFICE_SHOT}-pages.png` });
    });

    await test("the pages are kept: asking again is answered at once from the same pictures", async () => {
      const first = await app.api("POST", `/api/officedesk/${s}/pages`);
      assert.equal(first.body.status, "ready");
      const t = Date.now();
      const again = await app.api("POST", `/api/officedesk/${s}/pages`);
      assert.equal(again.body.hash, first.body.hash);
      assert.ok(Date.now() - t < 1500);
    });

    await test("tapping the words points at them, and the next message carries what was pointed at", async () => {
      const box = (await page.locator(".office-page").boundingBox())!;
      // The title sits near the top left of the slide.
      await page.touchscreen.tap(box.x + box.width * 0.2, box.y + box.height * 0.2);
      await until("the chip", async () => (await page.locator(".attach-chip.is-pointer").count()) > 0, 20_000);
      assert.match(await page.locator(".attach-chip.is-pointer").innerText(), /Quarterly review/);
      app.seen.length = 0;
      app.decide = (req) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : req.tools.length === 0 ? { text: "SKIP" } : { text: "Noted." });
      await page.locator("textarea[aria-label=Task]").fill("make this bigger");
      await page.locator(".composer-send").click();
      await until("the agent to see it", async () => app.seen.some((r) => /Pointing at “Quarterly review” \(element e_[0-9a-f]+\) on slide 1 of pitch\.pptx/.test(JSON.stringify(r.messages))), 30_000);
      assert.equal(await page.locator(".attach-chip.is-pointer").count(), 0, "the chip goes once sent");
    });

    await test("a shape with no words at the spot is pointed at by what it is, and named by the id office_edit takes", async () => {
      const box = (await page.locator(".office-page").boundingBox())!;
      await page.touchscreen.tap(box.x + box.width * 0.45, box.y + box.height * 0.2);
      await until("the chip", async () => /shape/i.test(await page.locator(".attach-chip.is-pointer").innerText().catch(() => "")), 20_000);
      app.seen.length = 0;
      await page.locator("textarea[aria-label=Task]").fill("round the corners");
      await page.locator(".composer-send").click();
      await until("the agent to see it", async () => app.seen.some((r) => /Pointing at the shape “Quarterly review” \(element e_[0-9a-f]+\) on slide 1/.test(JSON.stringify(r.messages))), 30_000);
    });

    await test("a phone edits in a simpler editor: the tool bar along the bottom, the ribbon behind All tools, and no AI button", async () => {
      // (The next test opens the same editor; this one looks at what is in it.)
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      const frame = await (async () => {
        for (let i = 0; i < 150; i++) { const f = page.frames().find((fr) => fr.url().includes("/office-app/slides/")); if (f) return f; await sleep(200); }
        throw new Error("the editor frame never appeared");
      })();
      await frame.waitForSelector("#autora-rail", { timeout: 30_000 });
      await until("every button on the bar to have an editor button behind it", async () => (await frame.locator("#autora-rail button[data-starts]:not([data-linked])").count()) === 0 && (await frame.locator("#autora-rail button[data-linked]").count()) >= 6, 20_000);
      const box = async (sel: string) => frame.evaluate((q) => { const r = document.querySelector(q)?.getBoundingClientRect(); return r ? [Math.round(r.height)] : null; }, sel);
      assert.equal((await box(".ribbon"))?.[0], 0, "the ribbon is closed");
      assert.equal(await frame.locator("#autora-phonebar").count(), 0, "the old bar and its More are gone: the rail replaced them");
      await until("every ribbon command to be a tool in All tools", async () => {
        await frame.click('#autora-rail [aria-label="All tools"]');
        const n = await frame.locator("#autora-grid .ar-tile").count();
        await frame.click('#autora-grid [aria-label="Close"]');
        return n > 40;
      }, 40_000);
      assert.equal(((await box(".ribbon"))?.[0]) ?? 0, 0, "and the ribbon is still never shown");
      assert.equal(await frame.locator(".ai-entry:visible").count(), 0, "the ribbon has no AI group");
      await page.getByRole("button", { name: "Page view", exact: true }).click();
      await until("the pictures again", async () => (await page.locator(".office-page img").count()) > 0, 20_000);
    });

    await test("editing by hand is a tap away, and back", async () => {
      await page.getByRole("button", { name: "Edit", exact: true }).click();
      await until("the editor frame", async () => page.frames().some((f) => f.url().includes("/office-app/slides/")), 30_000);
      await page.getByRole("button", { name: "Page view", exact: true }).click();
      await until("the pictures again", async () => (await page.locator(".office-page img").count()) > 0, 20_000);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}
main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
