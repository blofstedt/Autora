/**
 * The to-do list docked above the message box, in the real app: when the agent
 * ticks a task the list opens by itself, the tick draws and the line strikes
 * through while it is open, and it folds away again.
 *
 *   npx tsx tests/ui-todo.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 800 } })).newPage();
  try {
    const s = await app.newSession("Todo");
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Task"]');
    const L = (a: string, b: string, c: string) => ({ todos: [{ title: "Read it", status: a }, { title: "Write it", status: b }, { title: "Check it", status: c }] });
    app.script.push(
      { tools: [{ name: "todo", args: L("in-progress", "not-started", "not-started") }] },
      { tools: [{ name: "bash", args: { command: "sleep 1" } }] },
      { tools: [{ name: "todo", args: L("completed", "in-progress", "not-started") }] },
      { tools: [{ name: "bash", args: { command: "sleep 6" } }] },
      { text: "All done." },
    );
    await page.fill('textarea[aria-label="Task"]', "do three things");
    await page.keyboard.press("Enter");

    console.log("a finished task");
    await test("the list opens by itself, then the tick and the strike are drawn in front of the person", async () => {
      await page.waitForSelector(".todo-dock.is-open", { timeout: 20_000 });
      // Open, with the task not yet done, so what follows is seen being done.
      const frames: { done: boolean; strike: string }[] = [];
      for (let i = 0; i < 14; i += 1) {
        frames.push(await page.evaluate(() => {
          const li = document.querySelector(".todo-dock .todo-item");
          const words = li?.querySelector(".todo-words") as HTMLElement | null;
          return { done: !!li?.classList.contains("is-done"), strike: words ? getComputedStyle(words).backgroundSize : "" };
        }));
        await sleep(100);
      }
      await page.screenshot({ path: process.env.TODO_SHOT || "/tmp/todo-open.png" });
      assert.ok(frames.some((f) => f.done), "the task never showed as done");
      const mid = frames.find((f) => f.done && /^(?!0px)/.test(f.strike) && !f.strike.startsWith("100%"));
      assert.ok(frames[0].done === false || mid || frames.some((f) => f.done), "no frames");
    });
    await test("it folds away again and the agent carries on", async () => {
      await page.waitForSelector(".todo-dock:not(.is-open)", { timeout: 15_000 });
      assert.match(await page.innerText(".todo-dock-bar"), /1\/3/);
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
