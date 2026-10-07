/**
 * The pointer drawn into the browser's page follows real input: it moves with
 * each genuine mouse move, presses and ripples when the button goes down,
 * shows "typing" while keys are struck, and wears the same arrow and name as
 * the Office windows' cursor.
 *
 *   npx tsx tests/browser-cursor.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { CURSOR_SCRIPT } from "../server/browser";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const context = await browser.newContext({ viewport: { width: 600, height: 400 } });
    // The cursor's shadow root is closed so the page cannot reach it; open it here so the test can read it.
    await context.addInitScript(
      "const a = Element.prototype.attachShadow; Element.prototype.attachShadow = function (i) { return a.call(this, Object.assign({}, i, { mode: 'open' })); };",
    );
    await context.addInitScript(CURSOR_SCRIPT);
    const page = await context.newPage();
    await page.goto('data:text/html,<body style="margin:0"><input id="f" style="margin:100px"></body>');
    const cur = (q: string) => page.evaluate((sel) => {
      const root = (document.getElementById("__autora_cursor") as HTMLElement).shadowRoot!;
      const el = root.querySelector(sel) as HTMLElement;
      return { cls: el.className, text: el.textContent, transform: el.style.transform, opacity: el.style.opacity };
    }, q);

    await test("the cursor is the Office arrow with the Autora tag", async () => {
      const c = await cur(".cur");
      assert.equal(c.text, "Autora");
      assert.ok(CURSOR_SCRIPT.includes("M1 1 L1 15 L5 11.5 L8 18 L10.5 17 L7.5 10.5 L13 10.5 Z"));
    });

    await test("it follows each real mouse move", async () => {
      await page.mouse.move(50, 60);
      assert.match((await cur(".cur")).transform, /translate\(50px, 60px\)/);
      await page.mouse.move(150, 130);
      assert.match((await cur(".cur")).transform, /translate\(150px, 130px\)/);
    });

    await test("it presses and ripples when the button really goes down, and lets go with it", async () => {
      await page.mouse.down();
      assert.match((await cur(".cur")).cls, /down/);
      assert.match((await cur(".ring")).cls, /go/);
      await page.mouse.up();
      assert.doesNotMatch((await cur(".cur")).cls, /down/);
    });

    await test("it shows typing while keys are struck, then settles", async () => {
      await page.click("#f");
      await page.keyboard.type("hi");
      assert.match((await cur(".cur")).cls, /typing/);
      assert.equal(await page.inputValue("#f"), "hi");
      await page.waitForTimeout(1100);
      assert.doesNotMatch((await cur(".cur")).cls, /typing/);
    });

    await test("it says when the wheel turns", async () => {
      await page.mouse.wheel(0, 40);
      await page.waitForTimeout(50);
      assert.match((await cur(".tag")).text ?? "", /scrolling/);
    });
  } finally {
    await browser.close();
  }
  console.log(`${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
