/**
 * The agent's cursor in the PDF window, in a real browser with the real
 * editor: when the agent changes the words of a file, a labelled cursor
 * arrives where they are, the old words are struck, the new ones are typed,
 * and it goes away; the person can turn it off.
 *
 * Needs the editor built (npm run build); skips without a browser.
 *
 *   npx tsx tests/ui-pdfcursor.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame, type Page } from "playwright-core";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function invoice(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText("Invoice", { x: 50, y: 740, size: 22, font });
  p.drawText("Billed to: John Smith", { x: 50, y: 700, size: 14, font });
  p.drawText("Total due: 120 USD", { x: 50, y: 660, size: 14, font });
  return Buffer.from(await doc.save());
}

async function editorIn(page: Page): Promise<Frame> {
  for (let i = 0; i < 100; i++) {
    const frame = page.frames().find((f) => f.url().includes("/pdf-editor/"));
    if (frame) return frame;
    await sleep(100);
  }
  throw new Error("the editor's frame never appeared");
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/pdf-editor/index.html")) { console.log("  skip  the editor is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "invoice.pdf" }, body: new Uint8Array(await invoice()),
    });
    const file = (await up.json()).artifact.id;
    const s = await app.newSession("Invoice");
    const edits = (replace: { find: string; with: string }[]) => {
      let n = 0;
      app.decide = () => n++ === 0 ? { tools: [{ name: "pdf_replace_text", args: { file, replace } }] } : { text: "Changed it." };
    };
    edits([{ find: "John Smith", with: "Jane Doe" }]);
    await app.turn(s, "bill Jane Doe instead");

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${app.base}/?session=${s}`);
    let editor!: Frame;

    await test("the cursor arrives, the old words are struck, the new ones are typed, and it goes away", async () => {
      await page.waitForSelector(".app-pane .pdf-window", { timeout: 15_000 });
      editor = await editorIn(page);
      const seen = new Set<string>();
      let typed = "";
      let sawLabel = false;
      for (let i = 0; i < 120; i++) {
        const state = await editor.evaluate(() => {
          const cue = document.querySelector("[data-agent-cue]");
          const text = document.querySelector("[data-agent-cue-text]");
          return { phase: cue?.getAttribute("data-agent-cue") ?? null, text: text?.textContent ?? "", label: cue?.textContent?.includes("Autora") ?? false };
        });
        if (state.phase) seen.add(state.phase);
        if (state.label) sawLabel = true;
        if (state.phase === "strike") assert.equal(state.text, "John Smith");
        if ((state.phase === "type" || state.phase === "hold") && state.text.length > typed.length) typed = state.text;
        if (seen.has("hold") && !state.phase) break;
        await sleep(100);
      }
      assert.ok(sawLabel, "the cursor is labelled");
      assert.deepEqual([...seen].sort(), ["arrive", "hold", "strike", "type"]);
      assert.equal(typed, "Jane Doe", "it typed the new words");
      assert.equal(await editor.locator("[data-agent-cue]").count(), 0, "and it went away");
    });

    await test("the cue sits over the words it changed", async () => {
      // Play it again and catch the box over the page.
      const working = (await app.api("GET", `/api/pdfdesk/${s}`)).body.working;
      edits([{ find: "120 USD", with: "95 EUR" }]);
      await app.turn(s, "make the total 95 EUR");
      let box: { x: number; y: number; width: number; height: number } | null = null;
      for (let i = 0; i < 80 && !box; i++) {
        box = await editor.locator("[data-agent-cue-text]").first().boundingBox().catch(() => null);
        await sleep(100);
      }
      assert.ok(box, "the cue was drawn");
      const canvas = (await editor.locator("canvas").first().boundingBox())!;
      // "Total due: 120 USD" is the third line, a little below the middle-top of the page.
      assert.ok(box!.x > canvas.x && box!.x < canvas.x + canvas.width * 0.6, `x ${box!.x} within the page`);
      assert.ok(box!.y > canvas.y + canvas.height * 0.08 && box!.y < canvas.y + canvas.height * 0.2, `y ${box!.y - canvas.y} of ${canvas.height}`);
      assert.ok(working);
      for (let i = 0; i < 60 && (await editor.locator("[data-agent-cue]").count()) > 0; i++) await sleep(100);
    });

    await test("what the agent places is held back, performed with the toolbar lit, then lands as the editor's own object", async () => {
      // A clean slate: a window the cue of the last test has finished with.
      for (let i = 0; i < 60 && (await editor.locator("[data-agent-cue]").count()) > 0; i++) await sleep(100);
      const working = (await app.api("GET", `/api/pdfdesk/${s}`)).body.working;
      let n = 0;
      app.decide = () => n++ === 0
        ? { tools: [{ name: "pdf_edit", args: { file: working, add: [
          { type: "text", text: "Approved by Jane", page: 1, x: 60, y: 520, size: 14 },
          { type: "stamp", stamp: "approved", page: 1, x: 380, y: 520 },
        ] } }] }
        : { text: "Placed them." };
      await app.turn(s, "approve it");
      const acts = new Set<string>();
      const tools = new Set<string>();
      let heldWhileTyping = false;
      let litButtons: string[] = [];
      for (let i = 0; i < 150; i++) {
        const state = await editor.evaluate(() => ({
          act: document.querySelector("[data-agent-cue]")?.getAttribute("data-agent-act") ?? null,
          phase: document.querySelector("[data-agent-cue]")?.getAttribute("data-agent-cue") ?? null,
          tool: document.querySelector("[data-agent-cue]")?.getAttribute("data-agent-tool") ?? null,
          boxes: document.querySelectorAll("textarea").length,
          lit: [...document.querySelectorAll("[data-agent-using]")].map((e) => e.id),
        }));
        if (state.act) acts.add(state.act);
        if (state.tool) tools.add(state.tool);
        if (state.act === "type" && state.phase === "type" && state.boxes === 0) heldWhileTyping = true;
        if (state.lit.length) litButtons = state.lit;
        if (acts.size > 0 && !state.act) break;
        await sleep(80);
      }
      assert.deepEqual([...acts].sort(), ["place", "type"]);
      assert.deepEqual([...tools].sort(), ["stamp", "text"]);
      assert.ok(heldWhileTyping, "the text box was not on the page while the cursor was still typing it");
      assert.ok(litButtons.includes("tool-text-btn") || litButtons.includes("tool-stamp-btn"), `the toolbar was lit: ${litButtons.join(",")}`);
      // It landed: the editor's own text object, with the words typed.
      for (let i = 0; i < 40 && (await editor.locator("textarea").count()) === 0; i++) await sleep(100);
      assert.deepEqual(await editor.locator("textarea").evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value)), ["Approved by Jane"]);
      assert.equal(await editor.locator("[data-agent-using]").count(), 0, "and the toolbar went quiet");
      const st = (await app.api("GET", `/api/pdfdesk/${s}`)).body;
      assert.equal(st.items.filter((it: any) => it.type === "text" || it.type === "stamp").length, 2, "the server had both all along");
    });

    await test("turned off, nothing is played", async () => {
      await page.getByRole("button", { name: /Agent cursor on/ }).click();
      assert.ok(await page.getByRole("button", { name: /Agent cursor off/ }).count());
      edits([{ find: "Invoice", with: "Bill" }]);
      await app.turn(s, "rename the title");
      let appeared = false;
      for (let i = 0; i < 30; i++) {
        if ((await editor.locator("[data-agent-cue]").count()) > 0) appeared = true;
        await sleep(100);
      }
      assert.equal(appeared, false);
      await page.getByRole("button", { name: /Agent cursor off/ }).click();
    });

    assert.deepEqual(errors, [], errors.join("\n"));
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
