/**
 * The game window, in a real browser with the real editor: GDevelop's own editor (gdevelop-editor/), served by Autora
 * and working on the game the agent's tools make.
 *
 * What this checks is the wire, end to end: the agent makes a game and the window opens beside the chat with that game
 * in it; the editor is GDevelop's with no AI in it and no way to reach GDevelop's servers; the agent's next edit lands
 * in the open editor without a reload; a change by hand is saved by itself (renaming an object, which GDevelop does not
 * count as an unsaved change) and is what the agent sees next; and Preview runs the game in a box with no origin.
 *
 * Needs the editor built (npm run build); skips without a browser.
 *
 *   npx tsx tests/ui-game.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const catalog = JSON.parse(fs.readFileSync("server/game-catalog.json", "utf8"));
const clone = <T>(v: T): T => JSON.parse(JSON.stringify(v));

async function waitFor(what: string, ok: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (await ok().catch(() => false)) return;
    await sleep(250);
  }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/gdevelop-editor/index.html")) { console.log("  skip  the editor is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe, args: ["--use-angle=swiftshader", "--enable-unsafe-swiftshader", "--ignore-gpu-blocklist"] });
  try {
    const s = await app.newSession("A game", "build");
    const hello = clone(catalog.templates.objects["TextObject::Text"]);
    hello.name = "Hello";
    hello.content.text = "Hello Autora";
    const sprite = clone(catalog.templates.objects.Sprite);
    sprite.name = "Cat";
    app.decide = (req) => req.messages.filter((m) => m.role === "tool").length === 0
      ? { tools: [
        { name: "game_open", args: { name: "Cat jump" } },
        { name: "game_edit", args: { ops: [
          { op: "insert", path: "layouts[Scene].objects", value: hello },
          { op: "insert", path: "layouts[Scene].objects", value: sprite },
          { op: "insert", path: "layouts[Scene].instances", value: { ...clone(catalog.templates.instance), name: "Hello", x: 100, y: 100 } },
        ] } },
      ] }
      : { text: "Started the game." };
    await app.turn(s, "make me a platformer game about a cat");
    app.decide = null;

    const context = await browser.newContext({ viewport: { width: 1500, height: 950 } });
    const page = await context.newPage();
    const errors: string[] = [];
    const answered = new Set<string>();
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("response", (r) => { try { answered.add(new URL(r.url()).host); } catch { /* not a URL */ } });
    let editorLoads = 0;
    page.on("framenavigated", (f) => { if (f.url().includes("/gdevelop-editor/")) editorLoads += 1; });
    await page.goto(`${app.base}/?session=${s}`);
    const editor = (): Frame => {
      const f = page.frames().find((fr) => fr.url().includes("/gdevelop-editor/"));
      if (!f) throw new Error("the editor's frame is not there");
      return f;
    };
    const editorText = () => editor().evaluate(() => document.body.innerText);

    await test("what the agent makes opens beside the chat, with the game in GDevelop's editor", async () => {
      await page.waitForSelector(".app-pane .pdf-window", { timeout: 20_000 });
      // Autora's own slim bar: the game's name, Load and Save (the editor's tab strip and toolbar are away behind the tool bar).
      assert.equal(await page.locator(".app-pane .pdf-window .pdf-bar button.win-save").count(), 2);
      await waitFor("the objects to be listed", async () => /Hello/.test(await editorText()) && /Cat/.test(await editorText()));
    });

    await test("it is GDevelop's editor with the AI taken out and no way to reach GDevelop's servers", async () => {
      const text = await editorText();
      assert.ok(!/\bAsk AI\b|Ask the AI|Edit with AI/i.test(text), "no AI to ask");
      assert.ok(!/Log in|Sign up|Get the app/i.test(text), "no account");
      const outside = [...answered].filter((h) => !/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(h));
      assert.deepEqual(outside, [], "nothing was answered by a host outside this app");
    });

    await test("the editor wears Autora's colours", async () => {
      const bg = await editor().evaluate(() => getComputedStyle(document.body).backgroundColor);
      const mine = await page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--bg").trim());
      assert.ok(mine.length > 0);
      const [r, g, b] = (mine.match(/\d+/g) ?? []).map(Number);
      assert.ok(Math.abs(r - 8) < 40 && Math.abs(g - 9) < 40 && Math.abs(b - 13) < 40, `the page behind the editor is dark like Autora's (${bg})`);
    });

    await test("the agent's next edit lands in the open editor, without a reload", async () => {
      const before = editorLoads;
      app.script.push({ tools: [{ name: "game_edit", args: { ops: [{ op: "insert", path: "layouts[Scene].objects", value: { ...clone(catalog.templates.objects.Sprite), name: "Dog" } }] } }] });
      app.script.push({ text: "Added a dog." });
      await app.turn(s, "add a dog");
      await waitFor("the dog to be listed", async () => /\bDog\b/.test(await editorText()));
      assert.equal(editorLoads, before, "the frame was not reloaded");
    });

    await test("what the person does by hand is saved by itself, and is what the agent sees next", async () => {
      await editor().getByText("Cat", { exact: true }).first().click();
      await sleep(300);
      await page.keyboard.press("F2");
      await sleep(300);
      await page.keyboard.press("F2");
      await sleep(300);
      await page.keyboard.type("Kitty");
      await page.keyboard.press("Enter");
      await waitFor("the rename to reach the server", async () => {
        const { body } = await app.api("GET", `/api/game/${s}/project`);
        return body.project.layouts[0].objects.some((o: any) => o.name === "Kitty");
      }, 20_000);
      assert.equal((await app.api("GET", `/api/game/${s}`)).body.by, "person");
      app.script.push({ tools: [{ name: "game_look", args: { what: "scene", scene: "Scene" } }] });
      app.script.push({ text: "Seen." });
      await app.turn(s, "what is in the scene?");
      assert.match(JSON.stringify(app.seen[app.seen.length - 1].messages), /Kitty \(Sprite\)/);
    });

    await test("Play runs the game in the window, in a box with no origin of Autora's, and Stop puts it away", async () => {
      await page.locator('.rail-bar button[aria-label="Play"]').click();
      let game: Frame | undefined;
      await waitFor("the game to start", async () => {
        game = page.frames().find((f) => /\/preview\/[0-9a-f]+\/preview\/index\.html$/.test(f.url()));
        return !!game && await game.evaluate(() => !!document.querySelector("canvas") && typeof (window as any).gdjs === "object");
      }, 60_000);
      assert.match(game!.url(), new RegExp(`/api/game/${s}/preview/[0-9a-f]+/preview/index\\.html$`));
      assert.equal(await game!.evaluate(() => String(origin)), "null", "the game has no origin to reach the app with");
      const reach = await game!.evaluate(async (u) => fetch(u).then((r) => r.status, () => "blocked"), `${app.base}/api/sessions`);
      assert.equal(reach, "blocked", "and it cannot read the app's API");
      assert.equal(await page.locator('.rail-bar button[aria-label="Play"]').getAttribute("aria-pressed"), "true", "Play is lit while it plays");
      assert.equal(await editor().locator("#autora-play").count(), 1, "in a box over the scene, not a pop-up window");
      await editor().getByRole("button", { name: "Stop" }).click();
      await waitFor("the box to go", async () => (await editor().locator("#autora-play").count()) === 0);
      await waitFor("Play to go dark", async () => (await page.locator('.rail-bar button[aria-label="Play"]').getAttribute("aria-pressed")) !== "true");
    });

    await test("Add object opens on objects from scratch, with no Asset Store and no error", async () => {
      await page.locator('.rail-bar button[aria-label="Add object"]').click();
      await waitFor("the dialog", async () => /All categories/.test(await editorText()), 20_000).catch(async (e) => { console.log((await editorText()).slice(0, 800)); throw e; });
      const said = await editorText();
      assert.ok(!/error fetching|Asset Store/i.test(said), "nothing about a store");
      await page.keyboard.press("Escape");
    });

    await test("Rules shows the events sheet and a Back to the scene chip returns", async () => {
      await page.locator('.rail-bar button[aria-label="All tools"]').click();
      await page.getByRole("dialog", { name: "All tools" }).getByText("Rules", { exact: true }).click();
      await page.getByRole("button", { name: /Back to the scene/ }).first().waitFor({ timeout: 15_000 });
      await page.getByRole("button", { name: /Back to the scene/ }).first().click();
      await waitFor("the chip to go", async () => (await page.getByRole("button", { name: /Back to the scene/ }).count()) === 0, 15_000);
    });

    await test("Scenes lists the scenes and New scene adds one", async () => {
      await page.locator('.rail-bar button[aria-label="Scenes"]').click();
      await page.getByRole("button", { name: "New scene" }).click();
      await waitFor("a second scene", async () => (await page.locator(".gm-chip:not(.is-new)").count()) >= 2, 15_000);
    });

    await test("Export web game, from All tools, makes a .zip with the page, the data and the runtime", async () => {
      await page.locator('.rail-bar button[aria-label="All tools"]').click();
      await page.getByRole("dialog", { name: "All tools" }).getByText("Export web game", { exact: true }).click();
      await editor().getByText("Export as a HTML5 game").first().click({ timeout: 20_000 });
      await waitFor("the export to be done", async () => /Done!/.test(await editorText()), 60_000);
      const download = page.waitForEvent("download", { timeout: 20_000 });
      await editor().getByText(/Download/i).first().click();
      const file = await (await download).createReadStream();
      const chunks: Buffer[] = [];
      for await (const c of file!) chunks.push(c as Buffer);
      const { unzipSync } = await import("fflate");
      const names = Object.keys(unzipSync(new Uint8Array(Buffer.concat(chunks))));
      for (const want of ["index.html", "data.js", "code0.js", "gd.js"]) assert.ok(names.includes(want), `${want} is in the export (${names.length} files)`);
      assert.ok(names.some((n) => n.startsWith("Extensions/")), "with the runtime's extensions");
    });

    assert.deepEqual(errors.filter((e) => !/Network Error|Failed to fetch/.test(e)), [], "no uncaught errors in the page");
    await context.close();

    await test("on a phone the tool bar is the dock: Play, Add object, Objects, Properties, Abilities, Undo, Delete; the editor's own toolbar and tabs are away", async () => {
      const ctx = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true, deviceScaleFactor: 1 });
      const phone = await ctx.newPage();
      await phone.goto(`${app.base}/?session=${s}`);
      await phone.waitForSelector(".stage .pdf-window", { timeout: 20_000 });
      await phone.locator('.pdf-bar button[aria-label="Full screen"]').click();
      let frame: Frame | undefined;
      await waitFor("the editor frame", async () => { frame = phone.frames().find((f) => f.url().includes("/gdevelop-editor/")); return !!frame; }, 20_000);
      assert.match(frame!.url(), /phone=1/);
      await phone.waitForSelector(".rail-bar.is-phone", { timeout: 90_000 });
      const names = await phone.locator(".rail-bar.is-phone .rail-btn").evaluateAll((b) => b.map((x) => x.getAttribute("aria-label")));
      assert.deepEqual(names, ["Play", "Add object", "Objects", "Properties", "Abilities", "Undo", "Delete", "All tools"]);
      const shown = (id: string) => frame!.evaluate((q) => { const el = document.querySelector(q); return !!el && el.getClientRects().length > 0; }, id);
      for (const gone of ["#toolbar-preview-button", "#toolbar-save-button", "#toolbar-publish-button", "#game-editor-toggle", "#toolbar-history-button", "#main-toolbar-project-manager-button"]) {
        assert.equal(await shown(gone), false, `${gone} is the tool bar's now`);
      }
      await ctx.close();
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
