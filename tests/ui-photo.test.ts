/**
 * The photo window, in a real browser with the real editor: PhotoCraft's own editor (Rust, as WebAssembly, built by
 * scripts/build-photo.mjs), served by Autora and working on the picture the agent's tools make.
 *
 * What this checks is the wire, end to end: the agent makes a canvas and the window opens beside the chat with the
 * picture in it; a stroke painted by hand is saved on the server by itself and marked as the person's; the agent's next
 * edit reaches the open editor without reloading the frame; and what the person saves in the editor comes out as a download.
 *
 * Needs PhotoCraft built (node scripts/build-photo.mjs); skips without it or without a browser.
 *
 *   npx tsx tests/ui-photo.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function waitFor(what: string, ok: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

/** How many pixels of a screenshot are near white: the canvas of a new picture is a white rectangle on a dark editor. */
async function whitePixels(page: Page, clip: { x: number; y: number; width: number; height: number }): Promise<number> {
  const png = (await page.screenshot({ clip })).toString("base64");
  return page.evaluate(async (data) => {
    const img = new Image();
    img.src = `data:image/png;base64,${data}`;
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width;
    c.height = img.height;
    const g = c.getContext("2d")!;
    g.drawImage(img, 0, 0);
    const px = g.getImageData(0, 0, c.width, c.height).data;
    let n = 0;
    for (let i = 0; i < px.length; i += 4) if (px[i] > 235 && px[i + 1] > 235 && px[i + 2] > 235) n += 1;
    return n;
  }, png);
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/photo/web/index.html")) { console.log("  skip  the editor is not built (node scripts/build-photo.mjs)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const s = await app.newSession("A photo", "build");
    app.decide = (req) => req.messages.filter((m) => m.role === "tool").length === 0
      ? { tools: [{ name: "photo_open", args: { new: { width: 400, height: 300, background: "white" } } }] }
      : { text: "Made a canvas." };
    await app.turn(s, "touch up a photo, start with a blank canvas");
    app.decide = null;

    const context = await browser.newContext({ viewport: { width: 1500, height: 950 }, acceptDownloads: true });
    const page = await context.newPage();
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    let editorLoads = 0;
    page.on("framenavigated", (f) => { if (f.url().includes("/autora-photo/")) editorLoads += 1; });
    await page.goto(`${app.base}/?session=${s}`);
    const pane = page.locator(".app-pane[data-pane=photo]");

    await test("what the agent makes opens beside the chat, with the picture in PhotoCraft's editor", async () => {
      await page.waitForSelector(".app-pane[data-pane=photo] iframe", { timeout: 20_000 });
      assert.equal(await page.locator("iframe[title='Autora Photo']").count(), 1);
      const box = (await pane.boundingBox())!;
      await waitFor("the white canvas to be drawn", async () => (await whitePixels(page, { x: box.x, y: box.y, width: box.width, height: box.height })) > 20_000, 90_000);
    });

    await test("a stroke painted by hand is saved by itself and is marked as the person's", async () => {
      const box = (await pane.boundingBox())!;
      const cx = box.x + box.width * 0.4;
      const cy = box.y + box.height * 0.5;
      const rev = ((await app.api("GET", `/api/photo/${s}`)).body.rev ?? 0) as number;
      await page.mouse.move(cx - 60, cy);
      await page.mouse.down();
      for (let i = 0; i <= 12; i++) await page.mouse.move(cx - 60 + i * 10, cy + Math.sin(i / 2) * 30, { steps: 2 });
      await page.mouse.up();
      await waitFor("the server to have the stroke", async () => {
        const st = (await app.api("GET", `/api/photo/${s}`)).body;
        return st.by === "person" && (st.rev ?? 0) > rev;
      }, 20_000);
    });

    await test("the agent's next edit lands in the open editor, without a reload", async () => {
      const before = editorLoads;
      app.script.push({ tools: [{ name: "photo_edit", args: { commands: [{ id: "layer.new.layer", params: { name: "Glow" } }] } }] });
      app.script.push({ tools: [{ name: "photo_info" }] });
      app.script.push({ text: "Added a layer." });
      await app.turn(s, "add a layer for a glow");
      const st = (await app.api("GET", `/api/photo/${s}`)).body;
      assert.equal(st.by, "agent");
      assert.equal(st.layers, 2);
      assert.match(JSON.stringify(app.seen[app.seen.length - 1].messages), /Glow/);
      await sleep(2500);
      assert.equal(editorLoads, before, "the frame was not reloaded");
      // And the editor did not send it straight back as if it were the person's work.
      await sleep(1500);
      assert.equal((await app.api("GET", `/api/photo/${s}`)).body.by, "agent");
    });

    await test("a file saved in the editor is offered as a download", async () => {
      const box = (await pane.boundingBox())!;
      await page.mouse.click(box.x + box.width * 0.5, box.y + box.height * 0.9);
      const download = page.waitForEvent("download", { timeout: 20_000 });
      await page.keyboard.press("Control+s");
      const got = await download;
      assert.match(got.suggestedFilename(), /\.(psd|pcraft|png)$/i);
    });

    await test("on a phone the editor is the paired-down one: the picture alone, and a bar whose sheets open over it", async () => {
      /* One CSS pixel to the device: the editor's canvas is sized in device pixels, and a headless browser pretending to
         be a phone at two or three to one reports a canvas the page cannot click, so this is the phone's size and not its density. */
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 1 });
      const phone = await ctx.newPage();
      await phone.goto(`${app.base}/?session=${s}`);
      await phone.waitForSelector(".stage .pdf-window", { timeout: 20_000 });
      assert.equal(await phone.locator(".pdf-bar .pdf-pill").count(), 0, "round buttons, not text pills");
      await phone.locator('.pdf-bar button[aria-label="Full screen"]').click();
      await phone.waitForSelector(".pdf-window.is-full");
      assert.match(await phone.locator("iframe[title='Autora Photo']").getAttribute("src") ?? "", /phone=1/);
      /* The desktop's chrome is away: the strip above the bar, where Photoshop's toolbox and options would be, is the picture's
         own black, with no menu bar's grey. Then the bar's Layers opens a sheet there. */
      const box = (await phone.locator("iframe[title='Autora Photo']").boundingBox())!;
      const lit = async (y0: number, y1: number) => {
        const png = (await phone.screenshot({ clip: { x: 8, y: box.y + y0, width: 374, height: y1 - y0 } })).toString("base64");
        return phone.evaluate(async (data) => {
          const img = new Image();
          img.src = `data:image/png;base64,${data}`;
          await img.decode();
          const c = document.createElement("canvas");
          c.width = img.width;
          c.height = img.height;
          const g = c.getContext("2d")!;
          g.drawImage(img, 0, 0);
          const px = g.getImageData(0, 0, c.width, c.height).data;
          let n = 0;
          for (let i = 0; i < px.length; i += 4) if (px[i] > 10 || px[i + 1] > 10 || px[i + 2] > 14) n += 1;
          return n;
        }, png);
      };
      await waitFor("the bar", async () => (await lit(box.height - 80, box.height - 4)) > 3000, 60_000);
      const before = await lit(box.height - 230, box.height - 90);
      // The bar's Layers button: the sixth of the round buttons (Move, Select, Crop, Brush, Eraser, Layers), 40 wide with 2 between.
      await phone.mouse.move(box.x + 236, box.y + box.height - 28);
      await sleep(200);
      await phone.mouse.down();
      await sleep(150);
      await phone.mouse.up();
      await waitFor("the layers sheet over the picture", async () => (await lit(box.height - 230, box.height - 90)) > before + 3000, 20_000);
      await ctx.close();
    });

    await test("nothing in the page broke", async () => {
      // The dev server's own socket closing is not the window's.
      assert.deepEqual(errors.filter((e) => !/WebSocket closed without opened|Network Error|Failed to fetch/.test(e)), []);
    });
  } finally {
    await browser.close().catch(() => undefined);
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
