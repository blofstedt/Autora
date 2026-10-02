/**
 * Code written out in the thread, in a real browser: the agent writes a file
 * with the terminal, and the card for it is typed as it is watched, can be
 * replayed, and is shown whole when the agent cursor is switched off.
 *
 * Needs the app built (npm run build); skips without a browser.
 *
 *   npx tsx tests/ui-code.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const LINES = Array.from({ length: 14 }, (_, i) => `const line${i + 1} = ${i + 1};`);

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    let step = 0;
    app.decide = (req) => {
      if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
      step += 1;
      return step === 1
        ? { tools: [{ name: "terminal", args: { command: `printf '${LINES.join("\\n")}\\n' > app.js` } }] }
        : { text: "Wrote it." };
    };
    const s = await app.newSession("Code", "build");
    await app.turn(s, "write app.js");

    const open = async (off: boolean) => {
      const ctx = await browser.newContext({ viewport: { width: 1200, height: 900 } });
      if (off) await ctx.addInitScript(() => localStorage.setItem("autora.agentCursor", "off"));
      const page = await ctx.newPage();
      await page.goto(`${app.base}/?session=${s}`);
      return { ctx, page };
    };
    const code = (page: import("playwright-core").Page) => page.locator(".cell.diff .diff-code");

    await test("a card that has just arrived is typed, with the cursor on the line, then settles whole", async () => {
      const { ctx, page } = await open(false);
      let sawWriting = false, sawCaret = false;
      let longest = 0;
      let last = "";
      for (let i = 0; i < 100; i++) {
        const state = await page.evaluate(() => ({
          writing: document.querySelector(".cell.diff[data-writing]") !== null,
          caret: document.querySelector("[data-typing]") !== null,
          text: document.querySelector(".cell.diff .diff-code")?.textContent ?? "",
        })).catch(() => ({ writing: false, caret: false, text: "" }));
        if (state.writing) sawWriting = true;
        if (state.caret) sawCaret = true;
        longest = Math.max(longest, state.text.length);
        if (sawWriting && !state.writing && state.text.length > 0) { last = state.text; break; }
        await sleep(50);
      }
      assert.ok(sawWriting, "the card said it was being written");
      assert.ok(sawCaret, "the cursor rode the line being typed");
      for (const l of LINES) assert.ok(last.includes(l), `${l} is there at the end`);
      assert.equal(await page.locator("[data-typing]").count(), 0, "and the cursor has gone");
      await ctx.close();
    });

    await test("it can be played again from the card", async () => {
      const { ctx, page } = await open(true);
      await page.waitForSelector(".cell.diff .diff-code");
      assert.equal(await page.locator(".cell.diff[data-writing]").count(), 0);
      await page.getByRole("button", { name: "Replay this change" }).click();
      await page.waitForSelector(".cell.diff[data-writing]", { timeout: 3000 });
      for (let i = 0; i < 60 && (await page.locator(".cell.diff[data-writing]").count()) > 0; i++) await sleep(60);
      assert.equal(await page.locator(".cell.diff[data-writing]").count(), 0);
      assert.ok((await code(page).textContent())!.includes(LINES[13]));
      await ctx.close();
    });

    await test("with the agent cursor off, the whole card is there at once", async () => {
      const { ctx, page } = await open(true);
      await page.waitForSelector(".cell.diff .diff-code");
      const text = (await code(page).textContent())!;
      for (const l of LINES) assert.ok(text.includes(l));
      assert.equal(await page.locator(".cell.diff[data-writing]").count(), 0);
      await ctx.close();
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
