/**
 * The video window, in a real browser with the real editor: OpenCut's own
 * (opencut-editor/), served by Autora, driven by the agent's video_* tools
 * through the window that holds it.
 *
 * What this checks is the wire, end to end: the agent opens a project, brings a
 * picture in, puts it on the timeline and types a title, and the editor really
 * has them (read back through the editor, not the tool's say-so); the editor
 * runs sandboxed with no origin, keeps its project on the server, and takes
 * Autora's theme; the agent's cursor plays; a reload finds the work again; and
 * put away, it stays away.
 *
 * Needs the editor built (npm run build); skips without a browser.
 *
 *   npx tsx tests/ui-video.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import zlib from "node:zlib";
import { chromium, type Frame, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/** A 64x36 PNG, solid violet, made here so there is no file to carry. */
function png(): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const head = Buffer.alloc(4);
    head.writeUInt32BE(data.length);
    const body = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(zlib.crc32(body));
    return Buffer.concat([head, body, crc]);
  };
  const w = 64;
  const h = 36;
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // RGB
  const row = Buffer.concat([Buffer.from([0]), Buffer.concat(Array.from({ length: w }, () => Buffer.from([110, 91, 255])))]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk("IHDR", ihdr), chunk("IDAT", zlib.deflateSync(raw)), chunk("IEND", Buffer.alloc(0))]);
}

async function editorIn(page: Page): Promise<Frame> {
  for (let i = 0; i < 200; i++) {
    const frame = page.frames().find((f) => f.url().includes("/opencut-editor/"));
    if (frame) return frame;
    await sleep(100);
  }
  throw new Error("the editor's frame never appeared");
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/opencut-editor/index.html")) { console.log("  skip  the editor is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "violet.png" }, body: new Uint8Array(png()),
    });
    const picture = (await up.json()).artifact.id as string;
    const s = await app.newSession("Cut");

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${app.base}/?session=${s}`);
    await page.waitForSelector(".composer", { timeout: 20_000 });

    const sawCursor: string[] = [];
    const watch = setInterval(() => {
      void page.locator(".app-pane[data-pane=video] .office-cursor-name").count().then((n) => { if (n) sawCursor.push("seen"); }).catch(() => undefined);
    }, 120);

    const said = () => app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n").replace(/\\"/g, '"').replace(/\\n/g, "\n");
    const steps = [
      { name: "video_open", args: { new: "Test cut" } },
      { name: "video_import", args: { file: picture } },
      { name: "video_edit", args: { action: "add_clip", mediaId: "@media" } },
      { name: "video_edit", args: { action: "add_text", text: "Hello from Autora", start: 1, duration: 2 } },
      { name: "video_look", args: {} },
    ];
    let n = 0;

    await test("the agent opens a project, imports a picture, places it and types a title", async () => {
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (n >= steps.length) return { text: "The cut is ready." };
        const step = steps[n++];
        if (step.args.mediaId === "@media") {
          const id = /\b([0-9a-f]{8}-[0-9a-f-]{27}|[0-9a-f-]{36})\s+image "violet/.exec(req.last)?.[1] ?? /imported image "violet.png" as ([0-9a-f-]+)/i.exec(said())?.[1];
          return { tools: [{ name: step.name, args: { ...step.args, mediaId: id } }] };
        }
        return { tools: [{ name: step.name, args: step.args }] };
      };
      const events = await app.turn(s, "make a short cut from the picture with a title", 120_000);
      const errs = events.filter((e) => e.kind === "tool.error");
      assert.deepEqual(errs.map((e) => e.payload.error), [], "no tool failed");
      const text = said();
      assert.match(text, /Project "Test cut"/);
      assert.match(text, /Imported image "violet.png"/);
      assert.match(text, /image "violet.png"/, "the picture is on the timeline");
      assert.match(text, /text "Hello from Autora"/, "and so is the title, in full");
    });

    await test("it is beside the chat, named for the app, and the cursor played", async () => {
      assert.equal(await page.locator(".app-pane[data-pane=video] .pdf-bar-app").innerText(), "Autora Video");
      assert.equal(await page.locator(".app-pane[data-pane=video] .pdf-bar-name").innerText(), "Test cut");
      assert.ok(sawCursor.length > 0, "the agent's cursor was shown");
    });

    const editor = await editorIn(page);
    await test("the editor has no origin of its own, and keeps its project on the server", async () => {
      assert.equal(await editor.evaluate(() => String(origin)), "null");
      const projects = (await app.api("GET", "/api/opencut/projects")).body.projects as { name: string }[];
      assert.ok(projects.some((p) => p.name === "Test cut"), "the project is on the server");
    });

    await test("the editor wears Autora's theme", async () => {
      const [mine, theirs] = await Promise.all([
        page.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--accent").trim()),
        editor.evaluate(() => getComputedStyle(document.documentElement).getPropertyValue("--a-accent").trim()),
      ]);
      assert.ok(mine.length > 0);
      assert.equal(theirs, mine, "the accent is Autora's");
      const font = await editor.evaluate(() => getComputedStyle(document.body).fontFamily);
      assert.match(font, /Inter/);
    });

    await test("a person's edits are the editor's own, and the agent reads them back", async () => {
      // Undo is the editor's: the title the agent typed goes, and video_look shows it gone.
      await page.locator(".app-pane[data-pane=video] iframe").focus();
      await page.keyboard.press("Control+z");
      await sleep(400);
      n = steps.length - 1; // only video_look again
      app.seen.length = 0;
      await app.turn(s, "what is on the timeline now?", 60_000);
      assert.doesNotMatch(said(), /text "Hello from Autora"/);
    });

    clearInterval(watch);
    await page.close();

    await test("on a phone the editor is the paired-down one: the picture, the timeline, and Media and Edit as sheets", async () => {
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await phone.goto(`${app.base}/?session=${s}`);
      await phone.waitForSelector(".stage .pdf-window", { timeout: 20_000 });
      assert.equal(await phone.locator(".pdf-bar .pdf-pill").count(), 0, "round buttons, not text pills");
      await phone.tap('.pdf-bar button[aria-label="Full screen"]');
      const frame = await editorIn(phone);
      await frame.waitForSelector("[data-autora-phone]", { timeout: 30_000 });
      assert.equal(await frame.locator('[data-phone-sheet="media"]').count(), 1);
      assert.equal(await frame.locator("[data-phone-panel]").count(), 0, "no sheet until asked for");
      await frame.click('[data-phone-sheet="media"]');
      await frame.waitForSelector('[data-phone-panel="media"]', { timeout: 5_000 });
      await frame.click('[data-phone-sheet="media"]');
      assert.equal(await frame.locator("[data-phone-panel]").count(), 0, "the same button puts it away");
      await phone.close();
    });

    await test("a reload finds the project again", async () => {
      const again = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await again.goto(`${app.base}/?session=${s}`);
      await again.waitForSelector(".app-pane[data-pane=video]", { timeout: 20_000 });
      n = steps.length - 1;
      app.seen.length = 0;
      await app.turn(s, "look at the timeline again", 90_000);
      assert.match(said(), /image "violet.png"/, "the picture is still on the timeline");

      await again.click('.pane-pick-x[aria-label="Close Video"]');
      await again.waitForSelector(".app-pane[data-pane=video]", { state: "detached", timeout: 5_000 });
      await again.close();
    });

    const unexpected = errors.filter((e) => !/WebSocket|wasm|unreachable|GPU|WebGPU/i.test(e));
    assert.deepEqual(unexpected, [], "the page threw");
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
