/**
 * The app window as a person uses it, in a real browser: it opens beside the
 * conversation, fits, can be used, selected from (one element, several, a
 * region, stepping outwards and inwards), changed on the page, reviewed and
 * sent -- on a wide screen and on a phone.
 *
 *   npx tsx tests/ui-app.test.ts
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
  const errors: string[] = [];
  try {
    fs.mkdirSync(`${app.home}/site`, { recursive: true });
    fs.writeFileSync(`${app.home}/site/index.html`, fs.readFileSync("tests/fixtures/bike-site.html", "utf8"));
    const s = await app.newSession("Bike shop", "build");
    app.decide = (req) => req.messages.some((m) => m.role === "tool")
      ? { text: "Open." } : { tools: [{ name: "app_preview", args: { action: "start", dir: "site" } }] };
    await app.turn(s, "build the site", 60_000);
    app.decide = null;
    const api = (method: string, url: string, body?: unknown) => app.api(method, `/api/sessions/${s}/preview${url}`, body);
    const info = async (selector: string) => (await api("POST", "/inspect", { selector })).body.info;
    const rect = async (selector: string) => (await api("POST", "/rects", { selectors: [selector] })).body.rects[0];

    const ctx = await browser.newContext({ viewport: { width: 1440, height: 860 } });
    const page: Page = await ctx.newPage();
    page.on("pageerror", (e) => errors.push(e.message));
    page.on("console", (m) => { if (m.type() === "error" && !/WebSocket|Failed to load resource|net::ERR/.test(m.text())) errors.push(m.text()); });
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".app-frame", { timeout: 20_000 });
    await sleep(800);

    /** Where a point of the page is on screen. */
    const screen = async () => (await page.locator(".app-screen").boundingBox())!;
    const onScreen = async (selector: string, fx = 0.5, fy = 0.5) => {
      const b = await screen(); const r = await rect(selector); const k = b.width / 1280;
      return { x: b.x + (r.x + r.w * fx) * k, y: b.y + (r.y + r.h * fy) * k, k, b };
    };
    const tool = (name: string) => page.locator(".app-tools button", { hasText: name });

    console.log("opening");
    await test("the app opens beside the conversation and fits inside its window", async () => {
      const chat = await page.locator(".chat-view > .page").boundingBox();
      const pane = await page.locator(".app-pane").boundingBox();
      assert.ok(chat && pane && pane.x >= chat.x + chat.width - 2, "to the right of the chat");
      assert.ok(pane.width > 500, "a usable width");
      const canvas = await page.locator(".app-canvas").boundingBox();
      const area = await page.locator(".app-area").boundingBox();
      assert.ok(canvas!.x >= area!.x - 1 && canvas!.x + canvas!.width <= area!.x + area!.width + 1, "inside it, side to side");
      assert.ok(canvas!.y >= area!.y - 1 && canvas!.y + canvas!.height <= area!.y + area!.height + 1, "and top to bottom");
      assert.match(await page.locator(".app-url").innerText(), /localhost:\d+/);
      assert.ok(await page.locator(".app-frame").evaluate((i: any) => i.naturalWidth > 100), "video is arriving");
    });
    await test("the message box stays usable beside it: the mode is a pill, and nothing overlaps", async () => {
      assert.equal(await page.locator(".mode-seg").count(), 0);
      const send = await page.locator(".composer-send").boundingBox();
      const cam = page.locator(".composer-tools button").last();
      const camBox = await cam.boundingBox();
      assert.ok(send!.x >= camBox!.x + camBox!.width - 1, "Send clear of the tools");
    });

    console.log("using it");
    await test("Use: typing into the page's own field reaches it", async () => {
      const t = await onScreen("#q");
      await page.mouse.click(t.x, t.y);
      await sleep(500);
      await page.keyboard.type("gravel");
      await sleep(900);
      assert.equal((await info("#echo")).text, "gravel");
    });

    console.log("selecting");
    await test("Select: hover outlines what is under the pointer, with its name; a click picks it", async () => {
      await tool("Select").click();
      const t = await onScreen("a.cta");
      await page.mouse.move(t.x, t.y);
      await page.waitForSelector(".app-box.is-hover", { timeout: 4000 });
      assert.match(await page.locator(".app-tag").innerText(), /^a\.cta · 1\d\d×\d\d/);
      await page.mouse.click(t.x, t.y);
      await page.waitForSelector(".app-pop");
      assert.match(await page.locator(".app-pop-head b").innerText(), /^a\.cta/);
      assert.equal(await page.locator(".app-box.is-picked").count(), 1);
      assert.match(await page.locator(".app-said").innerText(), /Shop bikes/);
    });
    await test("the arrow keys step outwards, inwards and sideways; the box follows", async () => {
      await page.locator(".app-window").focus();
      await page.keyboard.press("ArrowUp");
      await page.waitForFunction(() => /^section/.test(document.querySelector(".app-pop-head b")?.textContent ?? ""));
      await page.keyboard.press("ArrowDown");
      await page.waitForFunction(() => /^(h1|p|a)/.test(document.querySelector(".app-pop-head b")?.textContent ?? ""));
      await page.locator(".app-nav button", { hasText: "Outer" }).click();
      await page.locator(".app-nav button", { hasText: "Inner" }).click();
      await sleep(400);
      assert.equal(await page.locator(".app-box.is-picked").count(), 1);
    });
    await test("shift adds a second element and the popover says so; a chip leaves one out; Escape clears", async () => {
      await page.keyboard.press("Escape");
      await page.waitForSelector(".app-pop", { state: "detached" });
      const a = await onScreen("a.cta");
      await page.mouse.click(a.x, a.y);
      await page.waitForSelector(".app-pop");
      const b = await onScreen("h1");
      await page.keyboard.down("Shift");
      await page.mouse.click(b.x, b.y);
      await page.keyboard.up("Shift");
      await page.waitForFunction(() => /2 elements/.test(document.querySelector(".app-pop-head b")?.textContent ?? ""));
      assert.equal(await page.locator(".app-box.is-picked").count(), 2);
      await page.locator(".app-chip button").first().click();
      await page.waitForFunction(() => !/2 elements/.test(document.querySelector(".app-pop-head b")?.textContent ?? "2 elements"));
      await page.keyboard.press("Escape");
      assert.equal(await page.locator(".app-pop").count(), 0);
    });

    console.log("trying a change");
    await test("a style is tried on the page as it is changed, and undone", async () => {
      const t = await onScreen("a.cta");
      await page.mouse.click(t.x, t.y);
      await page.waitForSelector(".app-pop");
      await page.locator(".app-edit-toggle").click();
      const size = page.locator('.app-row:has(> span:text-is("Size")) input');
      await size.fill("26");
      await page.waitForFunction(async () => true);
      await sleep(700);
      assert.equal((await info("a.cta")).styles.fontSize, "26px");
      assert.match(await page.locator(".app-tried").innerText(), /1 style changed/);
      await page.locator(".app-tried button", { hasText: "Undo" }).click();
      await sleep(500);
      assert.equal((await info("a.cta")).styles.fontSize, "14px");
    });
    await test("text is retyped right on the page", async () => {
      const t = await onScreen("h1");
      await page.mouse.click(t.x, t.y);
      await page.waitForSelector(".app-pop");
      // The editor opens by itself for a text target a moment after the popover: look before toggling, or the click closes it.
      await sleep(400);
      if (!(await page.locator(".app-edit-body").count())) await page.locator(".app-edit-toggle").click();
      await page.waitForSelector(".app-edit-body textarea", { timeout: 5000 });
      await page.locator(".app-edit-body textarea").fill("Ride far.");
      // The edit reaches the page through the server and back: wait for it, not a fixed beat.
      for (let waited = 0; waited < 8000 && (await info("h1")).text !== "Ride far."; waited += 250) await sleep(250);
      assert.equal((await info("h1")).text, "Ride far.");
    });

    console.log("the review");
    await test("a comment is added with what was tried, leaves a pin and a picture in the review", async () => {
      await page.locator(".app-say").fill("Shorter headline");
      await page.locator(".app-pop-foot .btn.primary").click();
      await page.waitForSelector(".app-comment");
      assert.equal(await page.locator(".app-pin").count(), 1);
      assert.match(await page.locator(".app-review-count").innerText(), /1 comment/);
      assert.ok(await page.locator(".app-comment-pic").evaluate((i: any) => i.complete && i.naturalWidth > 10), "a picture of it");
      const c = (await api("GET", "")).body.comments[0];
      assert.deepEqual(c.textEdit, { from: "Ride further.", to: "Ride far." });
    });
    await test("Region: drag a box round anything, say what it needs, add it", async () => {
      await tool("Region").click();
      const b = await screen(); const r = await rect(".cards"); const k = b.width / 1280;
      await page.mouse.move(b.x + 20 * k, b.y + r.y * k);
      await page.mouse.down();
      await page.mouse.move(b.x + 700 * k, b.y + (r.y + 100) * k, { steps: 8 });
      await page.mouse.up();
      await page.waitForSelector(".app-pop");
      assert.match(await page.locator(".app-pop-head b").innerText(), /^Region/);
      assert.equal(await page.locator(".app-nav").count(), 0, "no stepping for a box");
      await page.locator(".app-say").fill("Too cramped");
      await page.locator(".app-pop-foot .btn.primary").click();
      await page.waitForFunction(() => document.querySelectorAll(".app-comment").length === 2);
      assert.equal(await page.locator(".app-pin").count(), 2);
    });
    await test("a comment is reworded in the review, and dropped", async () => {
      await page.locator(".app-comment-text").nth(1).click();
      await page.locator(".app-comment-edit").fill("Much too cramped");
      await page.locator(".app-comment-edit").press("Enter");
      await sleep(500);
      assert.equal((await api("GET", "")).body.comments[1].text, "Much too cramped");
      await page.locator(".app-comment .app-x").nth(1).click();
      await page.waitForFunction(() => document.querySelectorAll(".app-comment").length === 1);
      assert.equal((await api("GET", "")).body.comments.length, 1);
    });
    await test("pins stay on their element when the page scrolls", async () => {
      await tool("Use").click();
      await sleep(900);
      const before = await page.locator(".app-pin").boundingBox();
      const b = await screen();
      await page.mouse.move(b.x + 200, b.y + 200);
      await page.mouse.wheel(0, 200);
      await sleep(1800);
      const during = await page.locator(".app-pin").boundingBox();
      assert.ok(during!.y < before!.y - 8, `it went up with the page (${before!.y} -> ${during!.y})`);
      await page.mouse.wheel(0, -400);
      await sleep(1800);
      const back = await page.locator(".app-pin").boundingBox();
      assert.ok(Math.abs(back!.y - before!.y) < 4, `and came back (${back!.y} vs ${before!.y})`);
    });
    await test("the device switch re-lays the page out at that size and the window says so", async () => {
      await page.locator('.app-seg button[title="Phone size"]').click();
      await page.waitForFunction(() => { const c = document.querySelector(".app-canvas") as HTMLElement | null; return !!c && c.offsetWidth < c.offsetHeight; }, null, { timeout: 8000 });
      assert.deepEqual((await api("GET", "")).body.viewport, { width: 390, height: 844 });
      await sleep(800);
      assert.ok(await page.locator(".app-frame").evaluate((i: any) => i.naturalWidth > 0));
      await page.locator('.app-seg button[title="Desktop size"]').click();
      await page.waitForFunction(() => { const c = document.querySelector(".app-canvas") as HTMLElement | null; return !!c && c.offsetWidth > c.offsetHeight; }, null, { timeout: 8000 });
    });
    await test("sending the review: one turn, the thread says so, the window starts over", async () => {
      app.decide = () => ({ text: "Changing it now." });
      await page.locator(".app-note").fill("Looking good.");
      await page.locator(".app-send").click();
      await page.waitForFunction(() => document.body.innerText.includes("Reviewed the app: 1 comment"), null, { timeout: 15_000 });
      await page.waitForFunction(() => document.body.innerText.includes("Changing it now."), null, { timeout: 15_000 });
      assert.equal((await api("GET", "")).body.comments.length, 0);
      assert.equal(await page.locator(".app-comment").count(), 0);
      assert.ok(app.seen.some((v) => /reviewed the app preview[\s\S]*Shorter headline[\s\S]*Ride far\./.test(v.last)), "the agent had the review");
      await page.waitForFunction(() => document.body.innerText.includes("Sent. Autora is on it."));
      app.decide = null;
    });

    console.log("on a phone");
    const phone = await browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
    const p: Page = await phone.newPage();
    p.on("pageerror", (e) => errors.push(e.message));
    await p.goto(`${app.base}/?session=${s}`);
    await p.waitForSelector(".app-frame", { timeout: 20_000 });
    await sleep(800);
    await test("the app is a tab in the pinned view, inside the screen, with thumb-sized tools", async () => {
      assert.equal(await p.locator(".app-pane").count(), 0, "no side pane on a phone");
      assert.match(await p.locator(".stage-tab.is-on").innerText(), /Creator/);
      const box = await p.locator(".app-canvas").boundingBox();
      assert.ok(box!.x >= 0 && box!.x + box!.width <= 390, "within the width");
      for (const t of ["Use", "Select", "Region"]) assert.ok((await p.locator(".app-tools button", { hasText: t }).boundingBox())!.height >= 34, t);
    });
    await test("a tap selects, and the comment box is a centred sheet over a dimmed page", async () => {
      await p.locator('.app-seg button[title="Phone size"]').tap();
      await p.waitForFunction(() => { const c = document.querySelector(".app-canvas") as HTMLElement | null; return !!c && c.offsetWidth < c.offsetHeight; });
      await sleep(900);
      await p.locator(".app-tools button", { hasText: "Select" }).tap();
      const b = (await p.locator(".app-screen").boundingBox())!; const r = await rect("a.cta"); const k = b.width / 390;
      await p.touchscreen.tap(b.x + (r.x + r.w / 2) * k, b.y + (r.y + r.h / 2) * k);
      await p.waitForSelector(".app-pop.is-modal");
      await sleep(450); // past its opening animation
      const c = await p.evaluate(() => {
        const e = document.querySelector(".app-pop")!.getBoundingClientRect();
        const dim = document.querySelector(".app-sheet-dim")!.getBoundingClientRect();
        return { x: Math.abs(e.left + e.width / 2 - innerWidth / 2) < 2, y: Math.abs(e.top + e.height / 2 - innerHeight / 2) < 2, dimFull: dim.width >= innerWidth - 1 && dim.height >= innerHeight - 1 };
      });
      assert.deepEqual(c, { x: true, y: true, dimFull: true });
      await p.locator(".app-say").fill("Bigger");
      await p.locator(".app-pop-foot .btn.primary").tap();
      await p.waitForSelector(".app-pin");
      assert.match(await p.locator(".app-review-count").innerText(), /comment/);
    });
    await test("closing the app window closes it everywhere and stops what it started", async () => {
      await p.locator('.app-icon[aria-label="Close the app window"]').tap();
      await p.waitForSelector(".app-window", { state: "detached" });
      await page.waitForSelector(".app-pane", { state: "detached", timeout: 8000 });
      assert.equal((await api("GET", "")).body.open, false);
    });
    assert.deepEqual(errors, [], "the page threw");
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
