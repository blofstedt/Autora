/**
 * The agent's passing word, in a real browser: it appears in the thread as a
 * line of its own when the person changes something in a shared window, and the
 * two "working together" switches in Settings change what the server does.
 *
 * Needs the app built (npm run build); skips without a browser.
 *
 *   npx tsx tests/ui-remark.test.ts
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
    const doc = await PDFDocument.create();
    doc.addPage([300, 200]).drawText("Form", { x: 30, y: 150, size: 18, font: await doc.embedFont(StandardFonts.Helvetica) });
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "f.pdf" }, body: new Uint8Array(await doc.save()),
    });
    const file = (await up.json()).artifact.id;
    app.decide = (req) => {
      if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
      if (/collaborator at the next desk/.test(req.system)) return { text: "That position reads better, I'll build around it." };
      return req.messages.some((m) => m.role === "tool") ? { text: "Done." } : { tools: [{ name: "pdf_edit", args: { file, add: [{ type: "text", text: "Name", page: 1, x: 30, y: 60, size: 14 }] } }] };
    };
    const s = await app.newSession("Remark", "build");
    await app.turn(s, "add a name field", 60_000);
    const item = ((await app.api("GET", `/api/pdfdesk/${s}`)).body.items as any[]).find((i) => i.type === "text");

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".pdf-window", { timeout: 15_000 });
    await sleep(800);

    await test("when the person changes something, the agent's word appears in the thread as a line", async () => {
      await fetch(`${app.base}/api/pdfdesk/${s}/changes`, {
        method: "POST", headers: { "Content-Type": "text/plain" }, body: JSON.stringify({ upsert: [{ ...item, x: item.x + 40 }], remove: [] }),
      });
      await page.waitForSelector(".cell-remark", { timeout: 12_000 });
      assert.match(await page.locator(".cell-remark").first().innerText(), /That position reads better/);
    });

    await test("the Working together switches in Settings change what the server does", async () => {
      await page.getByRole("link", { name: /Settings/ }).first().click().catch(async () => { await page.getByText("Settings", { exact: true }).first().click(); });
      const remarks = page.getByLabel(/Let the agent say a word about what I do/);
      await remarks.waitFor({ timeout: 10_000 });
      assert.equal(await remarks.isChecked(), true);
      await remarks.uncheck();
      for (let i = 0; i < 30 && (await app.api("GET", "/api/collaboration")).body.remarks; i++) await sleep(100);
      assert.equal((await app.api("GET", "/api/collaboration")).body.remarks, false);
      const cursor = page.getByLabel(/Show the agent's cursor and typing/);
      assert.equal(await cursor.isChecked(), true);
      await cursor.uncheck();
      for (let i = 0; i < 30 && (await app.api("GET", "/api/agent-cursor")).body.on; i++) await sleep(100);
      assert.equal((await app.api("GET", "/api/agent-cursor")).body.on, false);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
