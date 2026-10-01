/**
 * The page as a person uses it: typing and sending, watching a reply stream,
 * stopping it, a server that goes away and comes back with the page open,
 * settings that stick, and the slash menu. The real app and a scripted model,
 * driven through a real browser at phone width, where things break first.
 *
 *   npx tsx tests/ui-flows.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Page } from "playwright-core";
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
  const ctx = await browser.newContext({ viewport: { width: 390, height: 780 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
  const errors: string[] = [];
  const page: Page = await ctx.newPage();
  page.on("pageerror", (e) => errors.push(e.message));
  page.on("console", (m) => { if (m.type() === "error") errors.push(m.text()); });
  const bodyText = () => page.evaluate(() => document.body.innerText);
  const say = async (text: string) => {
    await page.fill('textarea[aria-label="Task"]', text);
    await page.tap('button[aria-label="Send"], button[aria-label="Interrupt & send"]');
  };
  try {
    const s = await app.newSession("Flows");
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector('textarea[aria-label="Task"]');

    console.log("sending");
    await test("a message typed and sent appears, the reply streams in, and the box is cleared", async () => {
      app.decide = () => ({ text: "The reply is here, and it is complete." });
      await say("hello there");
      await page.waitForFunction(() => document.body.innerText.includes("The reply is here, and it is complete."), null, { timeout: 15_000 });
      const text = await bodyText();
      assert.match(text, /hello there/);
      assert.equal(await page.inputValue('textarea[aria-label="Task"]'), "");
    });
    await test("Enter sends and Shift+Enter makes a new line", async () => {
      app.decide = () => ({ text: "Second reply." });
      await page.fill('textarea[aria-label="Task"]', "line one");
      await page.press('textarea[aria-label="Task"]', "Shift+Enter");
      await page.type('textarea[aria-label="Task"]', "line two");
      assert.equal(await page.inputValue('textarea[aria-label="Task"]'), "line one\nline two");
      await page.press('textarea[aria-label="Task"]', "Enter");
      await page.waitForFunction(() => document.body.innerText.includes("Second reply."), null, { timeout: 15_000 });
      assert.match(await bodyText(), /line one\s+line two/);
    });
    await test("a reply that is still streaming can be stopped from the page", async () => {
      app.decide = () => ({ text: "slowword ".repeat(200), slow: true });
      await say("talk for ages");
      await page.waitForFunction(() => document.body.innerText.includes("slowword"), null, { timeout: 15_000 });
      const stop = page.locator('button.composer-send[aria-label="Stop"]');
      await stop.waitFor({ timeout: 5000 });
      const size = await stop.boundingBox();
      assert.ok(size && size.width >= 36 && size.height >= 36, "a Stop a thumb can hit");
      await stop.tap({ timeout: 5000 });
      await page.waitForFunction(() => !document.querySelector(".working"), null, { timeout: 15_000 });
      const count = (await bodyText()).split("slowword").length - 1;
      assert.ok(count < 190, `it went on to the end (${count} words)`);
      app.decide = () => ({ text: "Ready again." });
      await say("are you there");
      await page.waitForFunction(() => document.body.innerText.includes("Ready again."), null, { timeout: 15_000 });
    });

    console.log("the slash menu");
    await test("typing / offers the commands, and Escape closes it without sending anything", async () => {
      await page.fill('textarea[aria-label="Task"]', "/");
      await page.waitForSelector(".slash-menu, [role=listbox]", { timeout: 5000 });
      await page.press('textarea[aria-label="Task"]', "Escape");
      await page.waitForFunction(() => !document.querySelector(".slash-menu"), null, { timeout: 5000 });
      assert.equal(await page.inputValue('textarea[aria-label="Task"]'), "/");
      await page.fill('textarea[aria-label="Task"]', "");
    });

    console.log("the connection");
    await test("a server that restarts under an open page comes back without the thread doubling", async () => {
      app.decide = () => ({ text: "Before the restart." });
      await say("one more");
      await page.waitForFunction(() => document.body.innerText.includes("Before the restart."), null, { timeout: 15_000 });
      const before = (await bodyText()).split("Before the restart.").length - 1;
      await sleep(900);
      await app.restart();
      // The page reconnects by itself; then a message goes through as before.
      app.decide = () => ({ text: "After the restart." });
      await page.waitForFunction(() => !document.querySelector('[data-state="closed"]'), null, { timeout: 30_000 }).catch(() => undefined);
      await sleep(3000);
      await say("and again");
      await page.waitForFunction(() => document.body.innerText.includes("After the restart."), null, { timeout: 40_000 });
      const after = (await bodyText()).split("Before the restart.").length - 1;
      assert.equal(after, before, "events were shown twice after the reconnect");
    });

    console.log("how it works, and what it may do");
    const centred = (sel: string) => page.evaluate((q) => {
      const r = document.querySelector(q)!.getBoundingClientRect();
      return { x: Math.abs(r.left + r.width / 2 - innerWidth / 2) < 2, y: Math.abs(r.top + r.height / 2 - innerHeight / 2) < 2 };
    }, sel);
    const row = async () => (await app.api("GET", "/api/sessions")).body.find((x: any) => x.id === s);
    await test("the mode pill in the message box opens a list; choosing Agent is saved with the chat", async () => {
      await page.goto(`${app.base}/?session=${s}`);
      const pill = page.locator(".mode-sel-pill");
      await pill.waitFor();
      assert.match(await pill.innerText(), /Build/);
      const box = await pill.boundingBox();
      assert.ok(box && box.height >= 32, "a thumb-sized target");
      await pill.tap();
      assert.deepEqual(await centred(".mode-sel-sheet"), { x: true, y: true }, "centred on a phone");
      await page.locator(".mode-sel-opt", { hasText: "Agent" }).tap();
      await page.waitForFunction(() => /Agent/.test(document.querySelector(".mode-sel-pill")?.textContent ?? ""));
      await sleep(400);
      assert.equal((await row()).mode, "agent");
      await page.reload();
      await page.locator(".mode-sel-pill").waitFor();
      assert.match(await page.locator(".mode-sel-pill").innerText(), /Agent/);
    });
    await test("the permissions pill in the header: Ask shows when to ask, with ideas to tap, and it is saved", async () => {
      const pill = page.locator(".badge.mode-pill");
      assert.match(await pill.innerText(), /Yolo/);
      await pill.tap();
      await page.locator(".mode-option-label:text-is(\"Ask\")").tap();
      const words = page.locator(".ask-when-text");
      await words.waitFor();
      await page.locator(".ask-chip", { hasText: "Deleting anything" }).tap();
      await page.locator(".ask-chip", { hasText: "Sending messages" }).tap();
      assert.match(await words.inputValue(), /deleting.*; sending an email/);
      const inside = await page.evaluate(() => {
        const r = document.querySelector(".mode-menu")!.getBoundingClientRect();
        return r.left >= 0 && r.right <= innerWidth && r.top >= 0 && r.bottom <= innerHeight;
      });
      assert.ok(inside, "the menu is inside the window");
      assert.deepEqual(await centred(".mode-menu"), { x: true, y: true }, "centred on a phone");
      await page.locator(".ask-when .btn", { hasText: "Done" }).tap();
      await sleep(500);
      const saved = await row();
      assert.equal(saved.permissions, "ask");
      assert.match(saved.ask_when, /deleting.*sending an email/);
      assert.match(await page.locator(".badge.mode-pill").innerText(), /Ask · custom/);
    });
    await test("on a wide screen the three modes are a switch you can see", async () => {
      const wide = await browser.newContext({ viewport: { width: 1280, height: 800 } });
      const p = await wide.newPage();
      await p.goto(`${app.base}/?session=${s}`);
      await p.locator(".mode-seg").waitFor();
      assert.equal(await p.locator(".mode-seg-btn").count(), 3);
      assert.match(await p.locator(".mode-seg-btn.on").innerText(), /Agent/);
      await p.locator(".mode-seg-btn", { hasText: "Plan" }).click();
      await sleep(500);
      assert.equal((await row()).mode, "plan");
      await wide.close();
    });
    await test("Agent's switches are said in the thread as they happen", async () => {
      await app.api("PATCH", `/api/sessions/${s}`, { mode: "agent", permissions: "yolo" });
      app.decide = (req) => req.messages.filter((m) => m.role === "tool").length === 0
        ? { tools: [{ name: "set_mode", args: { to: "build", reason: "the plan is set" } }] } : { text: "All done here." };
      await page.goto(`${app.base}/?session=${s}`);
      await say("do the thing");
      await page.waitForFunction(() => document.body.innerText.includes("All done here."), null, { timeout: 15_000 });
      const chips = await page.locator(".mode-chip").allInnerTexts();
      assert.ok(chips.some((c) => /Planning/.test(c)), chips.join("|"));
      assert.ok(chips.some((c) => /Building[\s\S]*the plan is set/.test(c)), chips.join("|"));
      assert.match(await page.locator(".mode-sel-pill").innerText(), /Agent/, "the selector stays on Agent");
    });

    console.log("the to-do list");
    await test("finished items have a filled box with a drawn tick and a struck title; the tick animates in", async () => {
      app.decide = (req) => req.messages.filter((m) => m.role === "tool").length === 0
        ? { tools: [{ name: "todo", args: { todos: [{ title: "Read it", status: "completed" }, { title: "Write it", status: "in-progress" }, "Send it"] } }] }
        : { text: "On it." };
      await page.goto(`${app.base}/?session=${s}`);
      await say("make a list");
      // Docked above the message box, folded to the task being worked; a tap
      // opens every task.
      await page.waitForSelector(".todo-dock", { timeout: 15_000 });
      assert.match(await page.locator(".todo-dock-now").innerText(), /Write it/, "folded, it shows the task in progress");
      assert.match(await page.locator(".todo-dock-count").innerText(), /1\/3/);
      await page.locator(".todo-dock-bar").tap();
      await page.waitForSelector(".todo-dock .todo-item", { timeout: 5_000 });
      const look = await page.evaluate(() => [...document.querySelectorAll(".todo-item")].map((li) => ({
        tick: getComputedStyle(li.querySelector(".todo-tick")!).strokeDashoffset,
        fill: getComputedStyle(li.querySelector(".todo-rect")!).fill,
        motion: getComputedStyle(li.querySelector(".todo-tick")!).transitionDuration,
        marching: getComputedStyle(li.querySelector(".todo-rect")!).animationName,
      })));
      assert.equal(look[0].tick, "0px", "the tick is drawn");
      assert.match(look[0].fill, /52, 211, 153/, "the box is filled");
      assert.equal(look[1].tick, "1px", "an unfinished item has no tick");
      assert.equal(look[1].marching, "todoMarch", "the item in progress is marching");
      assert.notEqual(look[2].fill, look[0].fill);
      assert.match(look[0].motion, /0\.3/, "the tick is a transition, not a jump");
    });

    console.log("settings");
    await test("a standing instruction typed in Settings is saved when you leave the field, and is there after a reload", async () => {
      await page.goto(`${app.base}/?page=config`);
      const box = page.locator("textarea").first();
      await box.waitFor();
      await box.fill("Always answer in exactly three words.");
      await page.locator("body").tap({ position: { x: 5, y: 5 } });
      await sleep(1500);
      const saved = (await app.api("GET", "/api/settings")).body.system_prompt;
      assert.match(saved, /exactly three words/);
      await page.reload();
      await page.locator("textarea").first().waitFor();
      assert.match(await page.locator("textarea").first().inputValue(), /exactly three words/);
      await app.api("PATCH", "/api/settings", { system_prompt: "" });
    });
    assert.deepEqual(errors.filter((e) => !/WebSocket|ws:\/\/|Failed to load resource|net::ERR|502|503/.test(e)), [], "the page threw");
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
