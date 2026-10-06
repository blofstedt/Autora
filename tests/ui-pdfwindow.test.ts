/**
 * The PDF window, in a real browser with the real editor: Spectra-PDF's own
 * renderer (spectra-editor/), served by Autora and driven by Spectra's own
 * Python engine through the server.
 *
 * What this checks is the wire, end to end: the agent signs a file and the
 * window opens beside the chat with the document drawn from the file on disk;
 * the editor runs sandboxed with no origin of its own, so every command it makes
 * is relayed through the window that holds it; the agent's next edit lands in
 * the editor without the person doing anything; put away, it stays away; and on
 * a phone it is a tab in the pinned view that can go full screen.
 *
 * Needs the editor and the engine built (npm run build, node
 * scripts/build-spectra.mjs); skips without a browser.
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

/** The editor's frame: the only one served from the editor's own directory. */
async function editorIn(page: Page): Promise<Frame> {
  for (let i = 0; i < 150; i++) {
    const frame = page.frames().find((f) => f.url().includes("/spectra-editor/"));
    if (frame) return frame;
    await sleep(100);
  }
  throw new Error("the editor's frame never appeared");
}

/** Whether a page has been drawn: dark pixels on a canvas the size of a page. */
async function drawn(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => [...document.querySelectorAll("canvas")].some((c) => {
    if (c.width < 100) return false;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4 * 13) if (data[i] < 120) ink++;
    return ink > 20;
  }));
}

async function waitDrawn(frame: Frame): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (await drawn(frame)) return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/spectra-editor/index.html")) { console.log("  skip  the editor is not built (npm run build)"); return; }
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
    /* Every load of the editor's frame, counted from the page's own event:
       the window reloads it onto the file the agent has just written, and that
       reload is how the edit is seen to arrive. */
    let editorLoads = 0;
    page.on("framenavigated", (f) => { if (f.url().includes("/spectra-editor/")) editorLoads += 1; });
    await page.goto(`${app.base}/?session=${s}`);
    let editor!: Frame;

    await test("what the agent signs opens beside the chat, drawn by the engine", async () => {
      await page.waitForSelector(".app-pane .pdf-window", { timeout: 20_000 });
      assert.equal(await page.locator(".pdf-bar-app").innerText(), "Autora PDF");
      editor = await editorIn(page);
      if (!(await waitDrawn(editor))) {
        /* Why it did not draw: what the frame has, and what the server said
           while it was starting. A frame that is up but empty is a bridge
           problem, and this is the line that says which one. */
        const inside = await editor.evaluate(() => ({
          href: location.href,
          ready: document.readyState,
          html: document.documentElement.outerHTML.slice(0, 200),
          text: document.body?.innerText.replace(/\s+/g, " ").slice(0, 200) ?? "",
          tabs: [...document.querySelectorAll("[data-tab-path]")].length,
          canvases: [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height}`),
          resources: performance.getEntriesByType("resource").map((r) => r.name.split("/").pop()),
        }));
        const direct = await page.evaluate(async (u) => {
          const r = await fetch(u);
          return { status: r.status, type: r.headers.get("content-type"), length: (await r.text()).length };
        }, new URL(editor.url()).pathname);
        throw new Error(`the page was not drawn: ${JSON.stringify(inside)} served: ${JSON.stringify(direct)}\nerrors: ${errors.join("\n")}\n${app.log().slice(-600)}`);
      }
      const tabs = await editor.evaluate(() => [...document.querySelectorAll("[data-tab-path]")].map((t) => t.getAttribute("data-tab-path")));
      assert.equal(tabs.length, 1, "one document is open");
      assert.match(String(tabs[0]), /lease/i);
    });

    await test("the editor runs without an origin of its own, on Autora's side of the wire", async () => {
      assert.equal(await editor.evaluate(() => String(origin)), "null", "the frame has no origin to reach the app with");
      // The page counter is the engine's own answer (get_page_count) relayed in:
      // nothing would be open at all if the commands were not arriving.
      const counter = editor.locator('input[aria-label="Current page"]').first();
      assert.equal(await counter.inputValue(), "1", "the engine's page count reached the editor");
    });

    await test("the agent's next edit reaches the open editor", async () => {
      await editorIn(page);
      const before = editorLoads;
      let k = 0;
      app.decide = () => k++ === 0
        ? { tools: [{ name: "pdf_edit", args: { file, add: [{ type: "text", text: "Witness: Bob Smith", page: 1, x: 60, y: 640, size: 13 }] } }] }
        : { text: "Added the witness." };
      await app.turn(s, "add Bob as witness");
      for (let i = 0; i < 100 && editorLoads === before; i++) await sleep(200);
      assert.ok(editorLoads > before, "the window took the editor back to the file as it is now");
      const again = await editorIn(page);
      assert.ok(await waitDrawn(again), "and draws it");
    });

    await test("put away, it stays away until the agent works on a PDF again", async () => {
      await page.click('.pdf-bar button[aria-label="Put Autora PDF away"]');
      await page.waitForSelector(".pdf-window", { state: "detached", timeout: 5_000 });
      assert.equal((await app.api("GET", `/api/pdfdesk/${s}`)).body.open, false);
    });
    /* The 400s are the port's own refusals: the renderer asks on the way up for
       desktop things Autora has no answer for (the Windows ICC assent, the
       startup notice), and each is refused by name rather than faked -- the
       server's answer says which, and `That is not available in Autora's PDF
       window.` is what the editor shows. Anything else on the page is a bug. */
    const unexpected = errors.filter((e) => !/status of 400/.test(e));
    assert.deepEqual(unexpected, [], "the page threw");
    await page.close();

    await test("on a phone it is a tab in the pinned view, and goes full screen", async () => {
      let k = 0;
      app.decide = () => k++ === 0 ? { tools: [{ name: "pdf_look", args: { file } }] } : { text: "Here it is." };
      await app.turn(s, "show me the lease");
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await phone.goto(`${app.base}/?session=${s}`);
      await phone.waitForSelector(".stage .pdf-window", { timeout: 20_000 });
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
