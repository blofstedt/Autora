/**
 * The PDF window, in a real browser with the real editor: Spectra-PDF's own
 * renderer (spectra-editor/), served by Autora and driven by Spectra's own
 * Python engine through the server.
 *
 * What this checks is the wire, end to end: the agent signs a file and the
 * window opens beside the chat with the document drawn from the file on disk;
 * the editor runs sandboxed with no origin of its own, so every command it makes
 * is relayed through the window that holds it; the agent's next edit lands in
 * the editor without the person doing anything; put away, it stays away; and on
 * a phone it is a tab in the pinned view that can go full screen.
 *
 * Needs the editor and the engine built (npm run build, node
 * scripts/build-spectra.mjs); skips without a browser.
 *
 *   npx tsx tests/ui-pdfwindow.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame, type Page } from "playwright-core";
import { PDFDocument, StandardFonts } from "@cantoo/pdf-lib";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function lease(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p = doc.addPage([612, 792]);
  p.drawText("Lease agreement", { x: 50, y: 740, size: 22, font });
  p.drawText("Tenant signature: ____________________", { x: 50, y: 200, size: 12, font });
  return Buffer.from(await doc.save());
}

/** The editor's frame: the only one served from the editor's own directory. */
async function editorIn(page: Page): Promise<Frame> {
  for (let i = 0; i < 150; i++) {
    const frame = page.frames().find((f) => f.url().includes("/spectra-editor/"));
    if (frame) return frame;
    await sleep(100);
  }
  throw new Error("the editor's frame never appeared");
}

/** Whether a page has been drawn: dark pixels on a canvas the size of a page. */
async function drawn(frame: Frame): Promise<boolean> {
  return frame.evaluate(() => [...document.querySelectorAll("canvas")].some((c) => {
    if (c.width < 100) return false;
    const data = c.getContext("2d")!.getImageData(0, 0, c.width, c.height).data;
    let ink = 0;
    for (let i = 0; i < data.length; i += 4 * 13) if (data[i] < 120) ink++;
    return ink > 20;
  }));
}

async function waitDrawn(frame: Frame): Promise<boolean> {
  for (let i = 0; i < 60; i++) {
    if (await drawn(frame)) return true;
    await sleep(250);
  }
  return false;
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/spectra-editor/index.html")) { console.log("  skip  the editor is not built (npm run build)"); return; }
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const up = await fetch(`${app.base}/api/artifacts`, {
      method: "POST", headers: { "Content-Type": "application/octet-stream", "X-File-Name": "lease.pdf" }, body: new Uint8Array(await lease()),
    });
    const file = (await up.json()).artifact.id;
    const s = await app.newSession("Lease");
    let n = 0;
    app.decide = () => n++ === 0
      ? { tools: [{ name: "pdf_edit", args: { file, add: [
        { type: "text", text: "Jane Tenant", page: 1, x: 170, y: 520, size: 16 },
        { type: "signature", text: "Jane Tenant", page: 1, x: 160, y: 560 },
        { type: "stamp", stamp: "approved", page: 1, x: 420, y: 120 },
      ] } }] }
      : { text: "Signed and stamped." };
    await app.turn(s, "sign the lease as Jane Tenant");

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    page.on("console", (m) => { if (m.type() === "error" && !/WebSocket|ws:\/\//.test(m.text())) errors.push(m.text()); });
    /* Every load of the editor's frame, counted from the page's own event:
       the window reloads it onto the file the agent has just written, and that
       reload is how the edit is seen to arrive. */
    let editorLoads = 0;
    page.on("framenavigated", (f) => { if (f.url().includes("/spectra-editor/")) editorLoads += 1; });
    await page.goto(`${app.base}/?session=${s}`);
    let editor!: Frame;

    await test("what the agent signs opens beside the chat, drawn by the engine", async () => {
      await page.waitForSelector(".app-pane .pdf-window", { timeout: 20_000 });
      assert.equal(await page.locator(".pdf-bar-app").innerText(), "Autora PDF");
      editor = await editorIn(page);
      if (!(await waitDrawn(editor))) {
        /* Why it did not draw: what the frame has, and what the server said
           while it was starting. A frame that is up but empty is a bridge
           problem, and this is the line that says which one. */
        const inside = await editor.evaluate(() => ({
          href: location.href,
          ready: document.readyState,
          html: document.documentElement.outerHTML.slice(0, 200),
          text: document.body?.innerText.replace(/\s+/g, " ").slice(0, 200) ?? "",
          tabs: [...document.querySelectorAll("[data-tab-path]")].length,
          canvases: [...document.querySelectorAll("canvas")].map((c) => `${c.width}x${c.height}`),
          resources: performance.getEntriesByType("resource").map((r) => r.name.split("/").pop()),
        }));
        const direct = await page.evaluate(async (u) => {
          const r = await fetch(u);
          return { status: r.status, type: r.headers.get("content-type"), length: (await r.text()).length };
        }, new URL(editor.url()).pathname);
        throw new Error(`the page was not drawn: ${JSON.stringify(inside)} served: ${JSON.stringify(direct)}\nerrors: ${errors.join("\n")}\n${app.log().slice(-600)}`);
      }
      const tabs = await editor.evaluate(() => [...document.querySelectorAll("[data-tab-path]")].map((t) => t.getAttribute("data-tab-path")));
      assert.equal(tabs.length, 1, "one document is open");
      assert.match(String(tabs[0]), /lease/i);
    });

    await test("the editor runs without an origin of its own, on Autora's side of the wire", async () => {
      assert.equal(await editor.evaluate(() => String(origin)), "null", "the frame has no origin to reach the app with");
      // The page counter is the engine's own answer (get_page_count) relayed in:
      // nothing would be open at all if the commands were not arriving.
      const counter = editor.locator('input[aria-label="Current page"]').first();
      assert.equal(await counter.inputValue(), "1", "the engine's page count reached the editor");
    });

    await test("the agent's next edit reaches the open editor", async () => {
      await editorIn(page);
      const before = editorLoads;
      let k = 0;
      app.decide = () => k++ === 0
        ? { tools: [{ name: "pdf_edit", args: { file, add: [{ type: "text", text: "Witness: Bob Smith", page: 1, x: 60, y: 640, size: 13 }] } }] }
        : { text: "Added the witness." };
      await app.turn(s, "add Bob as witness");
      for (let i = 0; i < 100 && editorLoads === before; i++) await sleep(200);
      assert.ok(editorLoads > before, "the window took the editor back to the file as it is now");
      const again = await editorIn(page);
      assert.ok(await waitDrawn(again), "and draws it");
    });

    await test("put away, it stays away until the agent works on a PDF again", async () => {
      await page.click('.pane-pick-x[aria-label="Close PDF"]');
      await page.waitForSelector(".pdf-window", { state: "detached", timeout: 5_000 });
      assert.equal((await app.api("GET", `/api/pdfdesk/${s}`)).body.open, false);
    });
    /* The 400s are the port's own refusals: the renderer asks on the way up for
       desktop things Autora has no answer for (the Windows ICC assent, the
       startup notice), and each is refused by name rather than faked -- the
       server's answer says which, and `That is not available in Autora's PDF
       window.` is what the editor shows. Anything else on the page is a bug. */
    const unexpected = errors.filter((e) => !/status of 400/.test(e));
    assert.deepEqual(unexpected, [], "the page threw");
    await page.close();

    await test("on a phone it is a tab in the pinned view, and goes full screen", async () => {
      let k = 0;
      app.decide = () => k++ === 0 ? { tools: [{ name: "pdf_look", args: { file } }] } : { text: "Here it is." };
      await app.turn(s, "show me the lease");
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await phone.goto(`${app.base}/?session=${s}`);
      await phone.waitForSelector(".stage .pdf-window", { timeout: 20_000 });
      assert.match(await phone.locator(".stage-tab.is-on").innerText(), /PDF/);
      await phone.tap('.pdf-bar button[aria-label="Full screen"]');
      const full = await phone.locator(".pdf-window.is-full").boundingBox();
      assert.ok(full && full.width >= 389 && full.height >= 840, "it covers the screen");
      await phone.tap('.pdf-bar button[aria-label="Back to the conversation"]');
      assert.equal(await phone.locator(".pdf-window.is-full").count(), 0);
      await phone.close();
    });

    await test("on a phone the editor is the paired-down one: a bar of coloured tools that fits without scrolling, the desktop chrome put away", async () => {
      const phone = await browser.newPage({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 });
      await phone.goto(`${app.base}/?session=${s}`);
      await phone.waitForSelector(".stage .pdf-window", { timeout: 20_000 });
      await phone.tap('.pdf-bar button[aria-label="Full screen"]');
      // The window's own bar: the name and round buttons, not a row of text pills.
      assert.equal(await phone.locator(".pdf-bar .pdf-pill").count(), 0);
      // One set of measurements for every window's bar (styles.css, "Tool windows on a phone"): 48px tall, 40px soft-square buttons.
      const sizes = await phone.evaluate(() => ({
        bar: Math.round(document.querySelector(".pdf-bar")!.getBoundingClientRect().height),
        buttons: [...document.querySelectorAll(".pdf-bar button")].map((b) => { const r = b.getBoundingClientRect(); return `${Math.round(r.width)}x${Math.round(r.height)} ${getComputedStyle(b).borderRadius}`; }),
      }));
      assert.equal(sizes.bar, 48, JSON.stringify(sizes));
      assert.ok(sizes.buttons.length >= 2 && sizes.buttons.every((b) => b === "40x40 12px"), `bar buttons: ${sizes.buttons.join(", ")}`);
      assert.equal(await phone.locator('.pdf-bar button[aria-label="Take control"]').count(), 1);
      const frame = await editorIn(phone);
      assert.ok(await waitDrawn(frame), "the page is still drawn");
      await frame.waitForSelector('[data-testid="phone-bar"]', { timeout: 10_000 });
      const shown = (testid: string) => frame.evaluate((id) => {
        const el = document.querySelector(`[data-testid="${id}"]`);
        return !!el && getComputedStyle(el).display !== "none";
      }, testid);
      assert.equal(await shown("menubar"), false, "no menu bar");
      assert.equal(await shown("main-toolbar"), false, "no desktop toolbar");
      assert.equal(await shown("tab-strip"), false, "no tab strip");
      assert.equal(await shown("phone-bar"), true);

      // The bar: the default tools that fit, then the grid button, in round buttons that all sit on screen and never scroll.
      const bar = await frame.evaluate(() => {
        const nav = document.querySelector('[data-testid="phone-bar"]') as HTMLElement;
        const buttons = [...nav.querySelectorAll("button")];
        return {
          ids: buttons.map((b) => b.getAttribute("data-phone")),
          scrolls: nav.scrollWidth > nav.clientWidth,
          onScreen: buttons.every((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= innerWidth && r.width === r.height && r.width >= 40; }),
          round: buttons.every((b) => getComputedStyle(b).borderRadius === "50%"),
          colours: new Set(buttons.map((b) => getComputedStyle(b).getPropertyValue("--tc").trim())).size,
        };
      });
      assert.deepEqual(bar.ids, ["select", "text", "highlight", "draw", "shape", "redact", "sign", "grid"], "the defaults, and the grid last");
      assert.equal(bar.scrolls, false, "it never scrolls");
      assert.ok(bar.onScreen && bar.round, "round, thumb-sized, all on screen");
      assert.ok(bar.colours >= 7, "each tool wears its own colour");
      // A narrower phone shows fewer, not a scrolling bar.
      await phone.setViewportSize({ width: 320, height: 700 });
      await sleep(300);
      const narrow = await frame.evaluate(() => { const nav = document.querySelector('[data-testid="phone-bar"]') as HTMLElement; return { n: nav.querySelectorAll("button").length, scrolls: nav.scrollWidth > nav.clientWidth, last: nav.querySelector("button:last-child")?.getAttribute("data-phone") }; });
      assert.ok(narrow.n < 8 && !narrow.scrolls && narrow.last === "grid", JSON.stringify(narrow));
      await phone.setViewportSize({ width: 390, height: 844 });
      await sleep(300);

      // Draw: one 46px row of three colours, a wheel and a thickness slider; the choices reach the mark.
      await frame.click('[data-phone="draw"]');
      await frame.waitForSelector('[data-testid="phone-tray"][data-mode="ink"]', { timeout: 10_000 });
      assert.equal(await frame.locator('[data-testid="secondary-toolbar"]:visible').count(), 0, "Spectra's own strip steps aside");
      const tray = await frame.evaluate(() => {
        const t = document.querySelector('[data-testid="phone-tray"]') as HTMLElement;
        return { h: Math.round(t.getBoundingClientRect().height), swatches: t.querySelectorAll(".autora-swatch").length, wheel: !!t.querySelector('[data-testid="phone-wheel"]'), slider: !!t.querySelector('[data-testid="phone-width"]') };
      });
      assert.ok(tray.h <= 52 && tray.swatches === 3 && tray.wheel && tray.slider, JSON.stringify(tray));
      const box = (await (await frame.frameElement()).boundingBox())!;
      const stroke = async (dy: number) => {
        await phone.mouse.move(box.x + 80, box.y + dy); await phone.mouse.down();
        await phone.mouse.move(box.x + 160, box.y + dy + 40, { steps: 6 }); await phone.mouse.move(box.x + 240, box.y + dy, { steps: 6 }); await phone.mouse.up();
        await sleep(300);
      };
      await frame.click('.autora-tray .autora-swatch >> nth=0');
      await frame.$eval('[data-testid="phone-width"]', (el) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(el, "9"); el.dispatchEvent(new Event("input", { bubbles: true })); });
      await stroke(330);
      const inks = () => frame.evaluate(() => [...document.querySelectorAll("svg polyline")].map((p) => [p.getAttribute("stroke"), Number(p.getAttribute("stroke-width") ?? 0)]).filter(([, w]) => (w as number) > 0));
      const first = await inks();
      assert.ok(first.some(([c, w]) => c === "#e0393e" && (w as number) > 5), `the red, thick stroke: ${JSON.stringify(first)}`);

      // Shapes: the left button steps through the figures, and the wheel colours what is drawn.
      await frame.click('[data-phone="shape"]');
      await frame.waitForSelector('[data-testid="phone-shape"]', { timeout: 10_000 });
      const figure = () => frame.evaluate(() => document.querySelector('[data-testid="phone-shape"]')!.getAttribute("aria-label"));
      assert.match((await figure())!, /Box/);
      await frame.click('[data-testid="phone-shape"]');
      assert.match((await figure())!, /Circle/);
      await frame.click('[data-testid="phone-shape"]');
      await frame.click('[data-testid="phone-shape"]');
      await frame.click('[data-testid="phone-shape"]');
      await frame.click('[data-testid="phone-shape"]');
      await frame.click('[data-testid="phone-shape"]');
      await frame.click('[data-testid="phone-shape"]');
      assert.match((await figure())!, /Box/, "seven figures, then round to the first");
      await frame.$eval('[data-testid="phone-wheel"]', (el) => { const set = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value")!.set!; set.call(el, "#10b981"); el.dispatchEvent(new Event("input", { bubbles: true })); });
      await sleep(200);
      await phone.mouse.move(box.x + 80, box.y + 460); await phone.mouse.down(); await phone.mouse.move(box.x + 220, box.y + 540, { steps: 6 }); await phone.mouse.up();
      await sleep(500);
      assert.ok(await frame.evaluate(() => [...document.querySelectorAll("rect,ellipse")].some((e) => e.getAttribute("stroke") === "#10b981")), "a green box was drawn");
      await frame.click('.autora-tray-x');
      await frame.waitForSelector('[data-testid="phone-tray"]', { state: "detached", timeout: 10_000 });

      // Redact: a tap on a word marks that word, with handles to change it.
      await frame.click('[data-phone="redact"]');
      await frame.waitForSelector('[data-testid="phone-tray"][data-mode="redact"]', { timeout: 10_000 });
      const word = await frame.evaluate(() => {
        const span = [...document.querySelectorAll(".textLayer span")].find((x) => x.textContent?.includes("Lease"));
        const node = span!.firstChild!;
        const at = node.textContent!.indexOf("agreement");
        const r = document.createRange(); r.setStart(node, at); r.setEnd(node, at + 9);
        const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2, w: b.width };
      });
      await phone.touchscreen.tap(box.x + word.x, box.y + word.y);
      await frame.waitForSelector(".page-redact", { timeout: 10_000 });
      const mark = await frame.evaluate(() => { const m = document.querySelector(".page-redact")!.getBoundingClientRect(); return { w: m.width, handles: document.querySelectorAll(".autora-redact-handle").length }; });
      assert.equal(mark.handles, 4, "a handle on each side");
      assert.ok(mark.w > word.w * 0.8 && mark.w < word.w * 1.6, `the mark is about the word (${mark.w} vs ${word.w})`);
      await frame.click('.autora-tray-x');

      // Sign: Draw or Type, never an image.
      await frame.click('[data-phone="sign"]');
      await frame.waitForSelector('[data-testid="signature-door-draw"]', { timeout: 10_000 });
      assert.equal(await frame.locator('[data-testid="signature-door-type"]:visible').count(), 1);
      assert.equal(await frame.locator('[data-testid="signature-door-import"]:visible').count(), 0, "no image door on a phone");
      const fits = await frame.evaluate(() => { const d = document.querySelector('[role="dialog"]')!.getBoundingClientRect(); return d.left >= 0 && d.right <= innerWidth; });
      assert.ok(fits, "the dialog fits the screen");
      await phone.keyboard.press("Escape");
      await frame.waitForSelector('[role="dialog"]', { state: "detached", timeout: 10_000 });

      // The grid: every tool, in the middle of the screen, with a close button.
      await frame.click('[data-phone="grid"]');
      await frame.waitForSelector('[data-testid="phone-grid"]', { timeout: 10_000 });
      const grid = await frame.evaluate(() => {
        const g = document.querySelector('[data-testid="phone-grid"]')!.getBoundingClientRect();
        const x = document.querySelector('[data-testid="phone-grid-close"]')!.getBoundingClientRect();
        return { centred: Math.abs(g.left + g.width / 2 - innerWidth / 2) < 2, closeAtRight: x.right > g.right - 40 && x.top < g.top + 50, tiles: document.querySelectorAll("[data-tile]").length };
      });
      assert.ok(grid.centred, "centred");
      assert.ok(grid.closeAtRight, "a close button at the top right");
      assert.ok(grid.tiles >= 40, `every tool is in it (${grid.tiles})`);
      for (const id of ["note", "stamp", "callout", "organize", "protect", "measure"]) assert.equal(await frame.locator(`[data-tile="${id}"]`).count(), 1, id);
      await frame.click('[data-testid="phone-grid-close"]');
      await frame.waitForSelector('[data-testid="phone-grid"]', { state: "detached", timeout: 10_000 });
      // A tile from the grid arms the tool: Note brings its own tray.
      await frame.click('[data-phone="grid"]');
      await frame.click('[data-tile="note"]');
      await frame.waitForSelector('[data-testid="phone-tray"][data-mode="note"]', { timeout: 10_000 });
      await frame.click('.autora-tray-x');

      // Find is Spectra's own find bar, one row.
      await frame.click('[data-phone="find"]');
      await frame.waitForSelector('[data-testid="find-bar"]', { timeout: 10_000 });
      assert.equal(await frame.evaluate(() => [...document.querySelectorAll('[data-testid="find-bar"] button')].filter((b) => b.getClientRects().length > 0).length), 1, "only the close button");
      await phone.close();
    });

    await test("on a desktop it is the same bar, down the right side: more tools, a grid with pins, a card for the open tool, a menu", async () => {
      const wide = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await wide.goto(`${app.base}/?session=${s}`);
      await wide.waitForSelector(".app-pane .pdf-window", { timeout: 20_000 });
      const frame = await editorIn(wide);
      await frame.waitForSelector('[data-testid="phone-bar"]', { timeout: 10_000 });
      assert.equal(await frame.evaluate(() => document.documentElement.classList.contains("autora-desktop")), true);
      assert.equal(await frame.evaluate(() => document.documentElement.classList.contains("autora-phone")), false);
      const visible = (id: string) => frame.evaluate((t) => { const el = document.querySelector(`[data-testid="${t}"]`); return !!el && getComputedStyle(el).display !== "none" && el.getClientRects().length > 0; }, id);
      assert.equal(await visible("menubar"), false, "Spectra's menu bar is put away");
      assert.equal(await visible("main-toolbar"), false, "and its toolbar");
      assert.equal(await visible("tab-strip"), false, "and its tab strip");

      // The bar: vertical, on the right, never scrolling, with more tools than a phone can hold.
      const bar = await frame.evaluate(() => {
        const nav = document.querySelector('[data-testid="phone-bar"]') as HTMLElement;
        const r = nav.getBoundingClientRect();
        const buttons = [...nav.querySelectorAll("button")];
        return {
          ids: buttons.map((b) => b.getAttribute("data-phone")),
          onRight: r.right > innerWidth - 24 && r.width < 80,
          vertical: r.height > r.width * 3,
          scrolls: nav.scrollHeight > nav.clientHeight,
          inside: r.top >= 40 && r.bottom <= innerHeight,
        };
      });
      assert.ok(bar.onRight && bar.vertical && bar.inside && !bar.scrolls, JSON.stringify(bar));
      assert.equal(bar.ids.at(-1), "grid");
      assert.ok(bar.ids.length >= 12, `more tools than a phone's seven (${bar.ids.length - 1})`);
      for (const id of ["select", "text", "highlight", "draw", "shape", "note", "stamp", "redact", "sign"]) assert.ok(bar.ids.includes(id), `${id} is on the bar`);

      // A short window shows fewer, not a scrolling bar.
      await wide.setViewportSize({ width: 1440, height: 560 });
      await sleep(400);
      const short = await frame.evaluate(() => { const nav = document.querySelector('[data-testid="phone-bar"]') as HTMLElement; return { n: nav.querySelectorAll("button").length, scrolls: nav.scrollHeight > nav.clientHeight }; });
      assert.ok(short.n < bar.ids.length && !short.scrolls, JSON.stringify(short));
      await wide.setViewportSize({ width: 1440, height: 900 });
      await sleep(400);

      // The open tool's settings are a card beside the bar, with labels (there is room for them).
      await frame.click('[data-phone="draw"]');
      await frame.waitForSelector('[data-testid="phone-tray"][data-mode="ink"]', { timeout: 10_000 });
      await sleep(450); // it slides in
      const card = await frame.evaluate(() => {
        const t = document.querySelector('[data-testid="phone-tray"]') as HTMLElement; const b = (document.querySelector('[data-testid="phone-bar"]') as HTMLElement).getBoundingClientRect(); const r = t.getBoundingClientRect();
        return { besideBar: r.right < b.left, labels: t.innerText.includes("Colour") && t.innerText.includes("Thickness"), swatches: t.querySelectorAll(".autora-swatch").length };
      });
      assert.ok(card.besideBar && card.labels && card.swatches === 3, JSON.stringify(card));
      await frame.click('.autora-tray-x');

      // Shapes: every figure is a button on a desktop.
      await frame.click('[data-phone="shape"]');
      await frame.waitForSelector(".autora-shapes", { timeout: 10_000 });
      assert.equal(await frame.locator(".autora-shapes button").count(), 7);
      await frame.click('.autora-shapes [data-shape="arrow"]');
      assert.equal(await frame.getAttribute('[data-testid="shape-type-arrow"]', "aria-pressed"), "true");
      await frame.click('.autora-tray-x');

      // Redact: a click on a word marks it, as a tap does on a phone.
      await frame.click('[data-phone="redact"]');
      await frame.waitForSelector('[data-testid="phone-tray"][data-mode="redact"]', { timeout: 10_000 });
      const at = await frame.evaluate(() => {
        const span = [...document.querySelectorAll(".textLayer span")].find((x) => x.textContent?.includes("Lease"))!;
        const node = span.firstChild!; const i = node.textContent!.indexOf("agreement");
        const r = document.createRange(); r.setStart(node, i); r.setEnd(node, i + 9);
        const b = r.getBoundingClientRect(); return { x: b.left + b.width / 2, y: b.top + b.height / 2 };
      });
      const wbox = (await (await frame.frameElement()).boundingBox())!;
      await wide.mouse.click(wbox.x + at.x, wbox.y + at.y);
      await frame.waitForSelector(".page-redact", { timeout: 10_000 });
      assert.equal(await frame.locator(".autora-redact-handle").count(), 4);
      await frame.click('.autora-tray-x');

      // The grid: every tool, with a pin on each; pinning and unpinning changes the bar, and Reset puts it back.
      await frame.click('[data-phone="grid"]');
      await frame.waitForSelector('[data-testid="phone-grid"]', { timeout: 10_000 });
      assert.ok((await frame.locator("[data-tile]").count()) >= 40);
      assert.ok((await frame.locator("[data-pin]").count()) >= 40, "a pin on every tile");
      await frame.click('[data-pin="stamp"]');
      await frame.click('[data-pin="compare"]');
      await frame.click('[data-testid="phone-grid-close"]');
      const barIds = () => frame.evaluate(() => [...document.querySelectorAll('[data-testid="phone-bar"] button')].map((b) => b.getAttribute("data-phone")));
      let ids = await barIds();
      assert.ok(!ids.includes("stamp") && ids.includes("compare"), `unpinned Stamps, pinned Compare: ${ids.join(",")}`);
      await frame.click('[data-phone="grid"]');
      await frame.click('[data-testid="phone-grid-reset"]');
      await frame.click('[data-testid="phone-grid-close"]');
      ids = await barIds();
      assert.ok(ids.includes("stamp") && !ids.includes("compare"), "Reset bar");

      // A tool with a pane (Protect) opens it as a window in the middle; a tool with no tray keeps Spectra's own options, as a card.
      await frame.click('[data-phone="grid"]');
      await frame.click('[data-tile="protect"]');
      await frame.waitForSelector(".tool-dock", { timeout: 10_000 });
      const dock = await frame.evaluate(() => { const d = document.querySelector(".tool-dock")!.getBoundingClientRect(); return Math.abs(d.left + d.width / 2 - innerWidth / 2) < 4 && Math.abs(d.top + d.height / 2 - innerHeight / 2) < 4; });
      assert.ok(dock, "the pane is a window in the middle");
      await frame.click('[data-testid="tool-dock-close"]');
      await frame.click('[data-phone="grid"]');
      await frame.click('[data-tile="measure"]');
      await frame.waitForSelector('[data-testid="secondary-toolbar"]', { timeout: 10_000 });
      assert.ok(await frame.evaluate(() => { const c = document.querySelector('[data-testid="secondary-toolbar"]')!.getBoundingClientRect(); const b = document.querySelector('[data-testid="phone-bar"]')!.getBoundingClientRect(); return c.right < b.left; }), "Spectra's own strip is a card beside the bar");
      await frame.click('[data-testid="secondary-action-tools.close"]');

      // The left side: the file basics, a switcher for Spectra's panels, and the pages (not Spectra's icon strip).
      await frame.waitForSelector('.autora-left [data-file="merge"]', { timeout: 10_000 });
      assert.equal(await visible("nav-icon-strip"), false, "Spectra's icon strip is the switcher now");
      const left = await frame.evaluate(() => ({
        tiles: [...document.querySelectorAll(".autora-left [data-file]")].map((b) => b.getAttribute("data-file")),
        panels: [...document.querySelectorAll(".autora-left [data-panel]")].map((b) => b.getAttribute("data-panel")),
        title: document.querySelector('[data-testid="nav-panel-title"]')?.textContent?.trim(),
        mergeEnabled: !(document.querySelector('.autora-left [data-file="merge"]') as HTMLButtonElement).disabled,
        above: document.querySelector(".autora-left")!.getBoundingClientRect().bottom <= document.querySelector('[data-testid="nav-panel-title"]')!.getBoundingClientRect().top + 1,
      }));
      assert.deepEqual(left.tiles, ["open", "save", "saveas", "merge", "insert", "split", "compress", "password", "export"]);
      assert.equal(left.panels.length, 8);
      assert.match(left.title ?? "", /pages/i, "the pages are what it shows");
      assert.ok(left.mergeEnabled && left.above);
      await frame.click('.autora-left [data-panel="bookmarks"]');
      await frame.waitForFunction(() => /bookmarks/i.test(document.querySelector('[data-testid="nav-panel-title"]')?.textContent ?? ""), null, { timeout: 10_000 });
      await frame.click('.autora-left [data-panel="pages"]');
      await frame.waitForFunction(() => /pages/i.test(document.querySelector('[data-testid="nav-panel-title"]')?.textContent ?? ""), null, { timeout: 10_000 });
      await frame.click('.autora-left [data-file="compress"]');
      await frame.waitForSelector(".tool-dock", { timeout: 10_000 });
      await frame.click('[data-testid="tool-dock-close"]');
      await frame.click('[data-testid="phone-pane-button"]');
      await frame.waitForSelector(".autora-left", { state: "detached", timeout: 10_000 });
      await frame.click('[data-testid="phone-pane-button"]');
      await frame.waitForSelector(".autora-left", { timeout: 10_000 });

      // The menu holds what the menu bar did.
      await frame.click('[data-testid="phone-menu-button"]');
      await frame.waitForSelector('[data-testid="phone-menu"]', { timeout: 10_000 });
      const heads = await frame.evaluate(() => [...document.querySelectorAll(".autora-menu-head")].map((h) => h.textContent?.trim()));
      for (const name of ["File", "Edit", "View", "Document", "Tools", "Window", "Help"]) assert.ok(heads.includes(name), `the menu has ${name}`);
      assert.ok((await frame.locator(".autora-menu-item").count()) > 3, "File's items are shown");
      await wide.keyboard.press("Escape");
      await frame.waitForSelector('[data-testid="phone-menu"]', { state: "detached", timeout: 10_000 });
      await wide.close();
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
