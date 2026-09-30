/**
 * Finding a picture challenge on a real page: frames by their address, squares
 * by where they are drawn, and the button that answers them. The widgets are
 * stood in for by local pages at the addresses the real ones use, in a real
 * Chromium -- what is checked is that a click at the point the solver works
 * out lands on the square it means, through a frame that is itself offset in
 * the page, which is the arithmetic that was only ever exercised live.
 * Skipped where there is no browser.
 *
 *   npx tsx tests/captcha-widget.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

/** A reCAPTCHA-shaped challenge: the prompt, an n x n table of tiles that
    toggle when clicked, and the verify button. */
const recaptcha = (n: number, prompt: string) => `<!doctype html><body style="margin:0;font:14px sans-serif">
<div id="rc-imageselect"><div class="rc-imageselect-desc-wrapper"><strong>${prompt}</strong></div>
<table class="rc-imageselect-table">${Array.from({ length: n }, (_, r) => `<tr>${Array.from({ length: n }, (_, c) =>
  `<td class="rc-imageselect-tile" data-i="${r * n + c + 1}" style="width:${Math.floor(300 / n)}px;height:${Math.floor(300 / n)}px;border:1px solid #999;padding:0"
    onclick="this.classList.toggle('on');document.title=[...document.querySelectorAll('.on')].map(t=>t.dataset.i).join(',')"></td>`).join("")}</tr>`).join("")}</table></div>
<button id="recaptcha-verify-button" style="width:90px;height:36px;margin:8px" onclick="parent.postMessage('verified','*')">Verify</button></body>`;

/** hCaptcha draws its squares where nothing can query them. */
const hcaptcha = `<!doctype html><body style="margin:0;font:14px sans-serif"><div class="prompt-text" style="height:70px;padding:8px">Please click each image containing a bus</div>
<canvas width="340" height="340" style="display:block;margin:0 auto"></canvas><div class="button-submit" style="width:90px;height:36px;margin:6px"></div></body>`;

async function main() {
  const executable = process.env.AUTORA_BROWSER_PATH
    || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
  if (!executable) {
    console.log("  skip  no browser here");
    return;
  }
  const { chromium } = await import("playwright-core");
  const { findChallenge } = await import("../server/captcha");

  const server = http.createServer((req, res) => {
    const url = req.url ?? "";
    res.setHeader("content-type", "text/html; charset=utf-8");
    if (url.startsWith("/recaptcha/api2/bframe")) return void res.end(recaptcha(url.includes("four") ? 4 : 3, url.includes("dynamic")
      ? "Select all images with buses Click verify once there are none left" : "Select all images with buses"));
    if (url.includes("hcaptcha.com") && url.includes("frame=challenge")) return void res.end(hcaptcha);
    const inner = url.startsWith("/host-h") ? "/x/hcaptcha.com/c?frame=challenge" : `/recaptcha/api2/bframe${url.replace("/host", "")}`;
    // The frame sits down and to the right of the page's corner, and the page is scrolled: nothing lines up by accident.
    res.end(`<!doctype html><body style="margin:0"><div style="height:120px">a page</div><div style="margin-left:170px">
      <iframe src="${inner}" style="width:320px;height:420px;border:0"></iframe></div><div style="height:900px"></div></body>`);
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", r));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const browser = await chromium.launch({ executablePath: executable });
  const open = async (path: string) => {
    const page = await (await browser.newContext({ viewport: { width: 900, height: 700 } })).newPage();
    await page.goto(origin + path);
    await page.waitForLoadState("load");
    await page.waitForTimeout(300);
    return page;
  };
  const frameOf = (page: any) => page.frames().find((f: any) => f !== page.mainFrame());

  try {
    console.log("reCAPTCHA's picture challenge");
    await test("it is found by its frame, with its prompt, nine squares in reading order, and Verify", async () => {
      const page = await open("/host?a=1");
      const found = await findChallenge(page);
      assert.ok(found, "no challenge found");
      assert.equal(found!.kind, "grid");
      assert.equal(found!.widget, "reCAPTCHA");
      assert.match(found!.prompt, /Select all images with buses/);
      assert.equal(found!.tiles.length, 9);
      assert.deepEqual(found!.tiles.map((t) => t.index), [1, 2, 3, 4, 5, 6, 7, 8, 9]);
      assert.ok(found!.verify, "the Verify button was not found");
      assert.ok(found!.tiles[1].box.x > found!.tiles[0].box.x && found!.tiles[3].box.y > found!.tiles[0].box.y);
    });
    await test("a click at the centre of a square lands on that square, through the frame's offset", async () => {
      const page = await open("/host?a=2");
      const found = await findChallenge(page);
      for (const index of [1, 5, 9, 6]) {
        const box = found!.tiles.find((t) => t.index === index)!.box;
        await page.mouse.click(box.x + box.w / 2, box.y + box.h / 2);
      }
      assert.equal(await frameOf(page).title?.() ?? await frameOf(page).evaluate("document.title"), "1,5,6,9");
    });
    await test("the Verify centre is on the button", async () => {
      const page = await open("/host?a=3");
      const found = await findChallenge(page);
      const hit = await page.evaluate(`window.__v = 0, window.addEventListener('message', () => window.__v++), 0`);
      void hit;
      const v = found!.verify!;
      await page.mouse.click(v.x + v.w / 2, v.y + v.h / 2);
      await page.waitForTimeout(150);
      assert.equal(await page.evaluate("window.__v"), 1);
    });
    await test("a four by four grid is sixteen squares", async () => {
      const page = await open("/host?four=1");
      const found = await findChallenge(page);
      assert.equal(found!.tiles.length, 16);
    });
    await test("the instruction that squares are replaced is in the prompt the loop reads", async () => {
      const page = await open("/host?dynamic=1");
      const found = await findChallenge(page);
      assert.match(found!.prompt, /Click verify once there are none left/);
    });
    await test("a page with no challenge on it has none found", async () => {
      const page = await (await browser.newContext()).newPage();
      await page.setContent("<p>hello</p><iframe src='about:blank'></iframe>");
      assert.equal(await findChallenge(page), null);
    });

    console.log("hCaptcha's");
    await test("squares that cannot be queried are laid out from the frame's own geometry, three by three", async () => {
      const page = await open("/host-h");
      const found = await findChallenge(page);
      assert.ok(found, "no challenge found");
      assert.equal(found!.widget, "hCaptcha");
      assert.equal(found!.tiles.length, 9);
      const frame = (await frameOf(page).frameElement()).boundingBox ? await (await frameOf(page).frameElement()).boundingBox() : null;
      assert.ok(frame);
      for (const t of found!.tiles) {
        assert.ok(t.box.x >= frame!.x && t.box.x + t.box.w <= frame!.x + frame!.width + 1, `tile ${t.index} is outside the frame across`);
        assert.ok(t.box.y >= frame!.y && t.box.y + t.box.h <= frame!.y + frame!.height + 1, `tile ${t.index} is outside the frame down`);
      }
      const rows = new Set(found!.tiles.map((t) => Math.round(t.box.y)));
      assert.equal(rows.size, 3);
    });
  } finally {
    await browser.close();
    server.close();
  }
  console.log(`\n${passed} passed`);
}
main().catch((err) => { console.error(err); process.exit(1); });
