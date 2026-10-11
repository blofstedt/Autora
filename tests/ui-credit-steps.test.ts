/**
 * Two things, in the real app.
 *
 * The bar over the composer is what is LEFT of the provider's top-up, so it
 * drains as the money goes -- and the page is told that from the server's own
 * figure. And a to-do card can carry the steps it is made of, folded under it,
 * each saying which agent has it; a card without steps is unchanged.
 *
 *   npx tsx tests/ui-credit-steps.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const wanted = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  const exe = fs.existsSync(wanted) ? wanted : fs.existsSync("/usr/bin/chromium") ? "/usr/bin/chromium" : "";
  if (!exe) { console.log("  skip  no browser here"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe, args: ["--no-sandbox"] });
  const page = await (await browser.newContext({ viewport: { width: 1100, height: 900 } })).newPage();
  try {
    /* What one provider's till says: a $30 top-up with $2.64 of it left. The
       credit block is exactly what the server now puts on the line. */
    const usage = {
      month: { cost: 3.2, turns: 12 },
      today: { cost: 0.4, turns: 2 },
      lifetime: { cost: 27.36 },
      budget: { monthly_usd: null, spent: 3.2, remaining: null, over: false, near: false },
      vendors: [{
        provider: "deepseek",
        label: "DeepSeek",
        balance_usd: 2.64,
        topped_up_usd: 30,
        at: Math.floor(Date.now() / 1000),
        lifetime_usd: 27.36,
        headline: true,
        selected: true,
        spent_known: true,
        month_usd: 3.2,
        credit: { paid_usd: 30, spent_usd: 27.36, left_usd: 2.64, left_fraction: 2.64 / 30 },
      }],
    };
    await page.route("**/api/usage*", (route) =>
      route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(usage) }));

    const s = await app.newSession("Credit and steps");
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Task"]');

    await test("the bar says what is left of the top-up, and the fill is what is left", async () => {
      await page.waitForSelector(".spend", { timeout: 20_000 });
      const bar = await page.evaluate(() => {
        const b = document.querySelector(".spend") as HTMLElement;
        const track = b.querySelector(".spend-track") as HTMLElement;
        const fill = b.querySelector(".spend-used") as HTMLElement;
        return {
          said: b.innerText.replace(/\s+/g, " ").trim(),
          aria: b.getAttribute("aria-label") ?? "",
          pct: (fill.getBoundingClientRect().width / track.getBoundingClientRect().width) * 100,
        };
      });
      assert.match(bar.said, /left of \$30\.00 credit/);
      assert.match(bar.aria, /\$2\.64 left of \$30\.00 credit/);
      /* The month is no longer printed on the bar, and nothing has been spent
         in this session yet, so there is no session figure beside it either. */
      assert.doesNotMatch(bar.said, /this month/);
      assert.doesNotMatch(bar.said, /this session/);
      /* 8.8% of the bar is left; the old bar would have drawn 91.2% used. */
      assert.ok(Math.abs(bar.pct - 8.8) < 2, `the fill was ${bar.pct.toFixed(1)}% of the track`);
    });

    app.script.push(
      { tools: [{ name: "todo", args: { todos: [
        { title: "Ship the feature", status: "in-progress", subtasks: [
          { title: "read the ticket", agent: "Sabrina" },
          { title: "check it against the docs", agent: "Trevor", status: "done" },
          { title: "write it up" },
        ] },
        { title: "Tell the person", status: "not-started" },
      ] } }] },
      { text: "On it." },
    );
    await page.fill('textarea[aria-label="Task"]', "ship the feature");
    /* Enter writes a line in the composer; Ctrl+Enter is what sends. */
    await page.keyboard.press("Control+Enter");

    await test("the list carries the steps folded away, with how many there are", async () => {
      /* The to-do list lives in the dock above the message box, and its own
         list starts folded shut: open the dock the way a person does. */
      await page.waitForSelector(".todo-dock-bar", { timeout: 20_000 });
      if (!(await page.evaluate(() => document.querySelector(".todo-dock")!.classList.contains("is-open")))) {
        await page.click(".todo-dock-bar");
      }
      await page.waitForSelector(".todo-dock.is-open .todo-item.has-steps", { timeout: 10_000 });
      const before = await page.evaluate(() => {
        const d = document.querySelector(".todo-item.has-steps details.todo-steps") as HTMLDetailsElement;
        const list = d.querySelector(".todo-steps-list") as HTMLElement;
        return {
          open: d.open,
          head: (d.querySelector(".todo-steps-head") as HTMLElement).innerText.trim(),
          /* A child of a closed details still reports a box in Chrome, so ask
             the browser whether it is painted at all. */
          listShown: list.checkVisibility ? list.checkVisibility() : getComputedStyle(list).display !== "none",
          listHeight: Math.round(list.getBoundingClientRect().height),
        };
      });
      assert.equal(before.open, false, "the steps started open");
      assert.match(before.head, /^3 steps · 1 done$/);
      assert.equal(before.listShown, false, `the steps were on screen while folded: ${JSON.stringify(before)}`);
    });

    await test("opening it lists each step with the agent that has it", async () => {
      await page.click(".todo-item.has-steps .todo-steps-head");
      const rows = await page.evaluate(() => [...document.querySelectorAll(".todo-step")].map((li) => ({
        title: (li.querySelector(".todo-step-title") as HTMLElement).textContent?.trim(),
        agent: (li.querySelector(".todo-step-agent") as HTMLElement | null)?.textContent?.trim() ?? "",
        done: li.classList.contains("is-done"),
      })));
      assert.deepEqual(rows, [
        { title: "read the ticket", agent: "Sabrina", done: false },
        { title: "check it against the docs", agent: "Trevor", done: true },
        { title: "write it up", agent: "", done: false },
      ]);
      const shown = await page.evaluate(() => {
        const list = document.querySelector(".todo-item.has-steps .todo-steps-list") as HTMLElement;
        return {
          open: (list.closest("details") as HTMLDetailsElement).open,
          shown: list.checkVisibility ? list.checkVisibility() : true,
          height: Math.round(list.getBoundingClientRect().height),
        };
      });
      assert.equal(shown.open, true, "the expander did not open");
      assert.equal(shown.shown, true, `the steps stayed off screen: ${JSON.stringify(shown)}`);
      assert.ok(shown.height > 40, `the steps have no room on screen: ${JSON.stringify(shown)}`);
    });

    app.script.push(
      { tools: [{ name: "todo", args: { todos: ["A plain item, no steps"] } }] },
      { text: "Right." },
    );
    await page.fill('textarea[aria-label="Task"]', "and now a plain one");
    await page.keyboard.press("Control+Enter");


    await test("an item with no steps is the row it always was", async () => {
      /* The list in play is the dock's, above the message box: the turn before
         keeps its own card further up the transcript, so counting rows across
         the page would count that one too. A new list folds the dock shut and
         swaps what is inside it, so wait for it to land -- the bar counts it --
         before opening, or the opening is undone by the list arriving. A folded
         row is not painted (innerText reads empty), so open it first. */
      await page.waitForSelector(".todo-dock-bar", { timeout: 20_000 });
      await page.waitForFunction(
        () => (document.querySelector(".todo-dock-bar")?.getAttribute("aria-label") ?? "").includes("Show all 1 task"),
        undefined,
        { timeout: 20_000 },
      );
      if (!(await page.evaluate(() => document.querySelector(".todo-dock")!.classList.contains("is-open")))) {
        await page.click(".todo-dock-bar");
      }
      await page.waitForFunction(
        () => {
          const rows = [...document.querySelectorAll(".todo-dock .todo-item")];
          return rows.length === 1
            && !rows[0].classList.contains("has-steps")
            && (rows[0] as HTMLElement).innerText.includes("A plain item, no steps");
        },
        undefined,
        { timeout: 20_000 },
      );
      const row = await page.evaluate(() => {
        const li = document.querySelector(".todo-dock .todo-item") as HTMLElement;
        return {
          steps: li.querySelectorAll(".todo-steps").length,
          children: [...li.children].map((c) => c.getAttribute("class")),
          text: li.innerText.trim(),
        };
      });
      assert.equal(row.steps, 0, "an item with no steps grew an expander");
      assert.deepEqual(row.children, ["todo-box", "todo-title"]);
      assert.match(row.text, /A plain item, no steps/);
    });

    await page.screenshot({ path: process.env.STEPS_SHOT || "/tmp/todo-steps.png" });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`${passed} passed`);
}

main().catch((e) => { console.error(e); process.exit(1); });
