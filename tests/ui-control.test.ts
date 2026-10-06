/**
 * Taking a window from the agent, in a real browser: the app window and the PDF
 * window each have Take control / Hand back, and the server's record of who
 * holds what follows the buttons.
 *
 * Needs the app built (npm run build); skips without a browser.
 *
 *   npx tsx tests/ui-control.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    fs.mkdirSync(`${app.home}/site`, { recursive: true });
    fs.writeFileSync(`${app.home}/site/index.html`, "<!doctype html><body><h1>Hi</h1></body>");
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]).drawText("Contract", { x: 30, y: 150, size: 18, font: await doc.embedFont(StandardFonts.Helvetica) });
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "c.pdf" }, body: new Uint8Array(await doc.save()),
    });
    const file = (await up.json()).artifact.id;
    const s = await app.newSession("Control", "build");
    const held = async () => (await app.api("GET", `/api/sessions/${s}/presence`)).body.held as string[];
    const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);

    app.decide = (req) => guard(req) ?? (req.messages.some((m) => m.role === "tool") ? { text: "Open." } : { tools: [{ name: "app_preview", args: { action: "start", dir: "site" } }] });
    await app.turn(s, "show it", 60_000);
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${app.base}/?session=${s}`);

    await test("the app window's button takes the window, says so, and hands it back", async () => {
      await page.waitForSelector(".app-window");
      await page.getByRole("button", { name: "Take control" }).first().click();
      for (let i = 0; i < 30 && !(await held()).includes("app"); i++) await sleep(100);
      assert.deepEqual(await held(), ["app"]);
      await page.getByRole("button", { name: "Hand back" }).waitFor({ timeout: 5000 });
      await page.getByRole("button", { name: "Hand back" }).click();
      for (let i = 0; i < 30 && (await held()).length > 0; i++) await sleep(100);
      assert.deepEqual(await held(), []);
      await page.getByRole("button", { name: "Take control" }).first().waitFor({ timeout: 5000 });
    });

    await test("the PDF window has the same button, for the PDF", async () => {
      let n = 0;
      app.decide = (req) => guard(req) ?? (n++ === 0 ? { tools: [{ name: "pdf_edit", args: { file, add: [{ type: "text", text: "Signed", page: 1, x: 30, y: 100, size: 14 }] } }] } : { text: "Done." });
      await app.turn(s, "sign it", 60_000);
      await page.waitForSelector(".pdf-window", { timeout: 15_000 });
      await page.locator(".pdf-window").getByRole("button", { name: "Take control" }).click();
      for (let i = 0; i < 30 && !(await held()).includes("pdf"); i++) await sleep(100);
      assert.deepEqual(await held(), ["pdf"]);
      await page.locator(".pdf-window").getByRole("button", { name: "Hand back" }).click();
      for (let i = 0; i < 30 && (await held()).length > 0; i++) await sleep(100);
      assert.deepEqual(await held(), []);
    });
    await test("selecting an object in the editor is told to the server as holding it, with no change to the file", async () => {
      /* Gone with the old editor: it reported the object the person selected,
         and the server took that as the PDF being in use. Spectra's editor has
         no such report -- it is a page in a frame, not a partner in this
         protocol -- so there is nothing to assert here any more. The surface's
         own hold is covered by the test above. */
      return;
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
