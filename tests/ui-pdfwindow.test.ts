/**
 * The PDF window, in a real browser with the real editor: the agent signs a
 * file and it opens beside the chat with what was placed as objects on the
 * page; the person drags one and the agent is told; the agent adds another
 * while the window is open and it arrives without a reload; on a phone it is
 * a tab in the pinned view that can go full screen.
 *
 * Needs the editor built (npm run build); skips without a browser.
 *
 *   npx tsx tests/ui-pdfwindow.test.ts
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

async function lease(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText("Lease agreement", { x: 50, y: 740, size: 22, font });
  p.drawText("Tenant signature: ____________________", { x: 50, y: 200, size: 12, font });
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

/** Whether the page under the objects has been drawn: dark pixels on the editor's canvas. */
async function drawn(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => [...document.querySelectorAll("canvas")].some((c) => {
    if (c.width < 100) return false;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4 * 13) if (data[i] < 100) ink++;
    return ink > 20;
  }));
}

const texts = (frame: Frame) => frame.locator("textarea").evaluateAll((els) => els.map((e) => (e as HTMLTextAreaElement).value));

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/pdf-editor/index.html")) { console.log("  skip  the editor is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "lease.pdf" }, body: new Uint8Array(await lease()),
    });
    const file = (await up.json()).artifact.id;
    const s = await app.newSession("Lease");
    let n = 0;
    app.decide = () => n++ === 0
      ? { tools: [{ name: "pdf_edit", args: { file, add: [
        { type: "text", text: "Jane Tenant", page: 1, x: 170, y: 520, size: 16 },
        { type: "signature", text: "Jane Tenant", page: 1, x: 160, y: 560 },
        { type: "stamp", stamp: "approved", page: 1, x: 420, y: 120 },
      ] } }] }
      : { text: "Signed and stamped." };
    await app.turn(s, "sign the lease as Jane Tenant");

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !/WebSocket|ws:\/\//.test(m.text())) errors.push(m.text()); });
    await page.goto(`${app.base}/?session=${s}`);
    let editor!: Frame;

    await test("what the agent signs opens beside the chat, with what it placed as objects on the page", async () => {
      await page.waitForSelector(".app-pane .pdf-window", { timeout: 15_000 });
      assert.match(await page.locator(".pdf-bar-name").innerText(), /lease-edited\.pdf/);
      editor = await editorIn(page);
      await editor.waitForSelector("textarea", { timeout: 20_000 });
      assert.deepEqual(await texts(editor), ["Jane Tenant"]);
      for (let i = 0; i < 50 && !(await drawn(editor)); i++) await sleep(200);
      assert.ok(await drawn(editor), "the page itself is drawn under them");
      assert.equal(await editor.evaluate(() => String(origin)), "null", "the editor runs without an origin of its own");
    });

    await test("the person moves the agent's text, and the agent is told at its next turn", async () => {
      // Wait for the editor to finish fitting the page to the window.
      let box = (await editor.locator("textarea").first().boundingBox())!;
      for (let i = 0; i < 30; i++) {
        await sleep(300);
        const now = (await editor.locator("textarea").first().boundingBox())!;
        if (Math.abs(now.x - box.x) < 0.5 && Math.abs(now.y - box.y) < 0.5 && Math.abs(now.width - box.width) < 0.5) break;
        box = now;
      }
      // The left edge of a text object is its drag handle.
      await page.mouse.move(box.x + 1, box.y + box.height / 2);
      await page.mouse.down();
      for (let i = 1; i <= 10; i++) await page.mouse.move(box.x + 1 + i * 6, box.y + box.height / 2 + i * 5);
      await page.mouse.up();
      let moved = false;
      for (let i = 0; i < 40 && !moved; i++) {
        await sleep(150);
        const st = (await app.api("GET", `/api/pdfdesk/${s}`)).body;
        moved = st.items.some((it: any) => it.type === "text" && Math.round(it.y) > 530);
      }
      assert.ok(moved, "the server has it where it was put");
      const working = (await app.api("GET", `/api/pdfdesk/${s}`)).body.working;
      let m = 0;
      app.decide = () => m++ === 0
        ? { tools: [{ name: "pdf_edit", args: { file: working, add: [{ type: "text", text: "Witness: Bob Smith", page: 1, x: 60, y: 640, size: 13 }] } }] }
        : { text: "Added the witness." };
      await app.turn(s, "add Bob as witness");
      // The turn's note rides on the person's message: the first request of the turn has it.
      const said = app.seen.slice(-2).map((v) => JSON.stringify(v.messages)).join("\n");
      assert.match(said, /the person moved your text \\"Jane Tenant\\" on page 1/);
    });

    await test("what the agent adds while the window is open arrives in it, without a reload", async () => {
      for (let i = 0; i < 50 && (await texts(editor)).length < 2; i++) await sleep(200);
      assert.deepEqual((await texts(editor)).sort(), ["Jane Tenant", "Witness: Bob Smith"]);
      const st = (await app.api("GET", `/api/pdfdesk/${s}`)).body;
      assert.ok(st.items.find((it: any) => it.type === "text" && it.text === "Jane Tenant").y > 530, "the person's move survived the agent's edit");
    });

    await test("put away, it stays away until the agent works on a PDF again", async () => {
      await page.click('.pdf-bar button[aria-label="Put the PDF window away"]');
      await page.waitForSelector(".pdf-window", { state: "detached", timeout: 5_000 });
      assert.equal((await app.api("GET", `/api/pdfdesk/${s}`)).body.open, false);
    });
    assert.deepEqual(errors, [], "the page threw");
    await page.close();

    await test("on a phone it is a tab in the pinned view, and goes full screen", async () => {
      let k = 0;
      app.decide = () => k++ === 0 ? { tools: [{ name: "pdf_look", args: { file } }] } : { text: "Here it is." };
      await app.turn(s, "show me the lease");
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await phone.goto(`${app.base}/?session=${s}`);
      await phone.waitForSelector(".stage .pdf-window", { timeout: 15_000 });
      assert.match(await phone.locator(".stage-tab.is-on").innerText(), /PDF/);
      await phone.tap('.pdf-bar button[aria-label="Full screen"]');
      const full = await phone.locator(".pdf-window.is-full").boundingBox();
      assert.ok(full && full.width >= 389 && full.height >= 840, "it covers the screen");
      await phone.tap('.pdf-bar button[aria-label="Back to the conversation"]');
      assert.equal(await phone.locator(".pdf-window.is-full").count(), 0);
      await phone.close();
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
