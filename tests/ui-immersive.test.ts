/**
 * Full screen on a phone with two tools open: Follow moves between them and the
 * screen stays full, with the agent's line and the message box over whichever
 * is up.
 *
 * Needs the app and the office editors built; skips without a browser.
 *
 *   npx tsx tests/ui-immersive.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function lease(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  doc.addPage([612, 792]).drawText("Lease agreement", { x: 50, y: 740, size: 22, font });
  return Buffer.from(await doc.save());
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/office/web/docs/index.html")) { console.log("  skip  the editors are not built"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "lease.pdf" }, body: new Uint8Array(await lease()),
    });
    const file = (await up.json()).artifact.id;
    const s = await app.newSession("Two tools");
    let step = 0;
    app.decide = (req) => {
      if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
      if (req.tools.length === 0) return { text: "SKIP" };
      step += 1;
      if (step === 1) return { tools: [{ name: "office_create", args: { type: "docx", name: "memo", markdown: "# Memo\n\nHello.\n" } }] };
      if (step === 2) return { text: "Memo made." };
      if (step === 3) return { tools: [{ name: "pdf_look", args: { file } }] };
      return { text: "Looking at the lease. Then I will mark it up." };
    };
    await app.turn(s, "write a memo", 120_000);
    await app.turn(s, "now show me the lease", 120_000);

    const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const errors: string[] = [];
    phone.on("pageerror", (e) => errors.push(String(e)));
    await phone.goto(`${app.base}/?session=${s}`);
    await phone.waitForSelector(".stage-tab", { timeout: 20_000 });

    await test("taking the memo's tab and going full screen, Follow carries the screen to the tool the agent used last, still full", async () => {
      await phone.locator(".stage-tab", { hasText: /Pages|Memo|Document/i }).first().tap();
      await phone.waitForSelector(".office-window", { timeout: 20_000 });
      await phone.getByRole("button", { name: "Full editor" }).tap();
      await phone.waitForSelector(".office-window.is-full");
      assert.equal(await phone.locator(".pdf-window:not(.office-window):visible").count(), 0, "only the memo is up");
      await phone.tap(".immersive-follow");
      await phone.locator(".pdf-window:not(.office-window).is-full:visible").waitFor({ timeout: 20_000 });
      assert.equal(await phone.locator(".office-window:visible").count(), 0, "the memo made way for the lease");
      const box = await phone.locator(".pdf-window:not(.office-window).is-full:visible").boundingBox();
      assert.ok(box && box.width >= 389 && box.height >= 840, "it covers the screen");
      assert.ok(await phone.locator(".immersive-chat").isVisible(), "the chat button is over it");
    });

    await test("leaving full screen takes the layer away", async () => {
      await phone.tap('.pdf-bar button[aria-label="Back to the conversation"]');
      assert.equal(await phone.locator(".immersive").count(), 0);
    });
    assert.deepEqual(errors, [], "the page threw");
    await phone.close();
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
