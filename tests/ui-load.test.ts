/**
 * Load, and the composer's Artifacts button, as a person uses them in a real browser.
 *
 * Every tool window's bar has Load beside Save: pick a saved file from Artifacts and it opens in that window, with no
 * message to the agent. And in the message box the Artifacts button, beside the notebook, attaches saved files or a whole
 * project folder to the message.
 *
 * Needs the app built (npm run build).
 *
 *   npx tsx tests/ui-load.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { PDFDocument } from "@cantoo/pdf-lib";
import { chromium } from "playwright-core";
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
    const upload = async (name: string, body: Uint8Array | string, session?: string) => {
      const res = await fetch(`${app.base}/api/artifacts`, {
        method: "POST",
        headers: { "Content-Type": "application/octet-stream", "X-File-Name": name, ...(session ? { "X-Session": session } : {}) },
        body: typeof body === "string" ? body : Buffer.from(body),
      });
      return ((await res.json()) as { artifact: { id: string } }).artifact.id;
    };
    const pdf = await PDFDocument.create();
    pdf.addPage([300, 200]).drawText("Lease agreement", { x: 20, y: 100 });
    await upload("lease.pdf", await pdf.save());
    const song = { name: "Night Drive", bpm: 96, beatsPerBar: 4, key: "A minor", bars: 4, tracks: [{ id: "t1", name: "Keys", instrument: "piano", clips: [] }] };
    await upload("night-drive.song.json", JSON.stringify(song));
    await upload("notes.txt", "not a song");

    const s = await app.newSession("Contracts", "build");
    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".composer", { timeout: 20_000 });

    await test("Load in Music offers only the songs, and opens the one picked in the window", async () => {
      assert.equal((await app.api("POST", `/api/studio/${s}/open`)).status, 200);
      await page.waitForSelector('[data-pane="studio"] .st-window');
      await page.locator('[data-pane="studio"] .win-load').click();
      const dialog = page.getByRole("dialog", { name: /Load a song you saved/ });
      await dialog.waitFor();
      await dialog.locator(".lib-row").first().waitFor();
      assert.equal(await dialog.locator(".lib-row").count(), 1, "only the song, not the pdf or the text file");
      await dialog.locator(".lib-row", { hasText: "night-drive.song.json" }).waitFor();
      await dialog.locator(".lib-row", { hasText: "night-drive.song.json" }).click();
      await dialog.getByRole("button", { name: "Load" }).click();
      await page.locator('[data-pane="studio"] .win-load.is-loaded').waitFor({ timeout: 10_000 });
      const doc = (await app.api("GET", `/api/studio/${s}/doc`)).body.doc;
      assert.equal(doc.name, "Night Drive");
      assert.equal(doc.bpm, 96);
    });

    await test("Load in PDF opens the PDF picked, and a file that is not one is refused by the server", async () => {
      assert.equal((await app.api("POST", `/api/sessions/${s}/new`, { kind: "pdf" })).status, 200);
      await page.waitForSelector('[data-pane="pdf"] .pdf-window');
      await page.locator('[data-pane="pdf"] .win-load').click();
      const dialog = page.getByRole("dialog", { name: /Load a PDF/ });
      await dialog.waitFor();
      await dialog.locator(".lib-row", { hasText: "lease.pdf" }).waitFor();
      const rows = await dialog.locator(".lib-row").allTextContents();
      assert.ok(rows.some((r) => r.includes("lease.pdf")), rows.join("|"));
      assert.ok(!rows.some((r) => r.includes("notes.txt")), "a text file is not offered");
      await dialog.locator(".lib-row", { hasText: "lease.pdf" }).click();
      await dialog.getByRole("button", { name: "Load" }).click();
      await page.locator('[data-pane="pdf"] .win-load.is-loaded').waitFor({ timeout: 15_000 });
      const st = (await app.api("GET", `/api/pdfdesk/${s}`)).body;
      assert.equal(st.name, "lease.pdf");
      const txt = await upload("notes.txt", "hello");
      const refused = await app.api("POST", `/api/sessions/${s}/load`, { app: "pdf", artifact: txt });
      assert.equal(refused.status, 400);
      assert.match(refused.body.error, /cannot open notes\.txt/);
    });

    await test("the Artifacts button in the message box attaches a project folder: its files go, and the chat joins the project", async () => {
      const a = await upload("floor-plan.txt", "plan");
      const b = await upload("budget.txt", "budget");
      const made = await app.api("POST", "/api/folders", { name: "House move", files: [a, b] });
      assert.equal(made.status, 200);
      const folder = made.body.folder.id as string;
      const fresh = await app.newSession("Moving", "build");
      const p2 = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await p2.goto(`${app.base}/?session=${fresh}`);
      await p2.waitForSelector(".composer", { timeout: 20_000 });
      await p2.getByRole("button", { name: "Add a saved file or a project folder from Artifacts" }).click();
      const dialog = p2.getByRole("dialog", { name: "Add from Artifacts" });
      await dialog.getByRole("tab", { name: "Folders" }).click();
      await dialog.locator(".lib-row", { hasText: "House move" }).click();
      await dialog.getByRole("button", { name: "Add" }).click();
      await p2.locator(".attach-chip.is-folder", { hasText: "House move" }).waitFor();
      app.script.push({ text: "Got the folder." });
      await p2.locator('textarea[aria-label="Task"]').fill("what is in my move folder?");
      await p2.getByRole("button", { name: "Send" }).click();
      for (let i = 0; i < 100 && app.seen.length === 0; i++) await sleep(100);
      const seen = JSON.stringify(app.seen[0]?.messages ?? []);
      assert.match(seen, /floor-plan\.txt/);
      assert.match(seen, /budget\.txt/);
      const chats = (await app.api("GET", "/api/artifacts")).body.chats as Record<string, string>;
      assert.equal(chats[fresh], folder, "the chat is in the project's folder");
      await p2.close();
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
