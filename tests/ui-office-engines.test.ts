/**
 * The PowerPoint and Excel windows, in a real browser with the real editors: the
 * agent makes a deck and a workbook and each opens beside the chat in GenOffice's
 * own editor (their engines run on the server); what the person changes in the
 * editor reaches the file and the agent is told; what the agent changes arrives
 * in the window.
 *
 * Needs the app and the Office editors built (npm run build, then
 * node scripts/build-office.mjs); skips without a browser or the editors.
 *
 *   npx tsx tests/ui-office-engines.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame, type Page } from "playwright-core";
import { pptxParagraphs, xlsxCells } from "../server/officedesk";
import { sleep, startApp, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const guardOk = (req: { system: string; tools: string[] }) =>
  /You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' }
    : req.tools.length === 0 ? { text: "SKIP" }
      : null;

async function editorIn(page: Page, app: string): Promise<Frame> {
  for (let i = 0; i < 300; i++) {
    const frame = page.frames().find((f) => f.url().includes(`/office-app/${app}/`));
    if (frame) return frame;
    await sleep(100);
  }
  throw new Error("the editor's frame never appeared");
}
async function until(what: string, ok: () => Promise<boolean>, ms = 40_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
}
const bodyText = (frame: Frame) => frame.evaluate(() => document.body.innerText).catch(() => "");
/** Every piece of text in the page, shown or not (menus and lists that are closed). */
const allText = (frame: Frame) => frame.evaluate(() => [...document.querySelectorAll("*")].filter((e) => e.children.length === 0 && !["SCRIPT", "STYLE"].includes(e.tagName)).map((e) => e.textContent).join("\n")).catch(() => "");

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  for (const a of ["slides", "sheets"]) {
    if (!fs.existsSync(`dist/office/web/${a}/index.html`) || !fs.existsSync(`dist/office/host/${a}.cjs`)) { console.log(`  skip  the ${a} editor is not built (node scripts/build-office.mjs)`); return; }
  }
  if (!fs.existsSync("dist/office/native/xlsx-sidecar") && !fs.existsSync("dist/office/native/xlsx-sidecar-x64")) { console.log("  skip  the spreadsheet engine is not built"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built (npm run build)"); return; }
  const app: App = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const s = await app.newSession("Quarter", "build");
    const state = async () => (await app.api("GET", `/api/officedesk/${s}`)).body;
    const fileOf = async () => {
      const working = (await state()).working as string | null;
      return working ? Buffer.from(await (await fetch(`${app.base}/api/artifacts/${working}`)).arrayBuffer()) : null;
    };

    // ---- a deck
    let step = 0;
    app.decide = (req) => {
      const g = guardOk(req);
      if (g) return g;
      step += 1;
      if (step === 1) {
        return { tools: [{ name: "office_create", args: { type: "pptx", name: "pitch", spec: { pages: [{ title: "Hello", type: "cover", background: "#0E1A2B", elements: [
          { type: "shape", shape: "rect", x: 80, y: 80, w: 600, h: 120, fill: "#1F3A5F", paragraphs: [{ align: "left", runs: [{ text: "Quarterly review", sizePt: 40, color: "#FFFFFF" }] }] },
        ] }] } } }] };
      }
      return { text: "Made." };
    };
    await app.turn(s, "make a one-slide pitch deck", 120_000);

    const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${app.base}/?session=${s}`);

    let frame: Frame;
    await test("the deck opens beside the chat in the real PowerPoint editor, in English, with Autora's chat in place of its AI", async () => {
      frame = await editorIn(page, "slides");
      await until("the deck to open", async () => /Slide 1 (\/|of) 1/.test(await bodyText(frame)), 90_000).catch(async (err) => { console.log((await bodyText(frame)).slice(0, 600).replace(/\n/g, " | ")); throw err; });
      const text = await bodyText(frame);
      assert.doesNotMatch(text, /Genspark/);
      assert.doesNotMatch(text, /[\u3400-\u9fff]/, "no Chinese anywhere in the editor");
      const hidden = (await allText(frame)).match(/.{0,20}[\u3400-\u9fff]+.{0,20}/g);
      assert.equal(hidden, null, `Chinese in the page: ${hidden?.slice(0, 5).join(" | ")}`);
      assert.match(text, /Autora/);
      assert.equal(await page.locator(".pdf-bar-name").innerText(), "pitch.pptx");
      if (process.env.OFFICE_SHOT) { await sleep(1500); await page.screenshot({ path: `${process.env.OFFICE_SHOT}-deck.png` }); }
      assert.equal(errors.length, 0, errors.join("\n"));
    });

    await test("what the person types into a slide is saved, kept in the file, and told to the agent", async () => {
      const before = (await state()).rev;
      await sleep(1500);
      await page.mouse.dblclick(1060, 430);
      await sleep(800);
      if (process.env.OFFICE_SHOT) await page.screenshot({ path: `${process.env.OFFICE_SHOT}-editing.png` });
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" is moved to Monday");
      await sleep(500);
      await page.keyboard.press("Escape");
      await page.mouse.click(1100, 600);
      void before;
      let text = "";
      await until("the file to be kept current", async () => {
        const bytes = await fileOf();
        text = bytes ? (pptxParagraphs(bytes) ?? []).join("\n") : "";
        return /moved to Monday/.test(text);
      }, 90_000);
      assert.match(text, /Quarterly review.*moved to Monday/);
    });

    await test("the agent is told what they changed in the deck", async () => {
      app.seen.length = 0;
      app.decide = (req) => guardOk(req) ?? { text: "Noted." };
      await app.turn(s, "what do you see in the deck now?");
      const told = app.seen.map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n");
      assert.match(told, /in the PowerPoint window, the person/);
      assert.match(told, /moved to Monday/);
    });

    await test("the agent changes the deck while it is open and the window shows it, their change kept", async () => {
      let n = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        n += 1;
        if (n === 1) return { tools: [{ name: "office_edit", args: { file: "pitch.pptx", ops: [{ op: "findReplace", find: "Quarterly review", replace: "Annual review" }] } }] };
        return { text: "Renamed." };
      };
      // They were typing a moment ago, so the deck is theirs: wait out the lease.
      await frame.evaluate(() => { (window as any).__kept = "same page"; });
      await sleep(22_000);
      const ev = await app.turn(s, "rename the title to Annual review", 120_000);
      if (process.env.OFFICE_DEBUG) console.log("last events:", JSON.stringify(ev.slice(-10).map((e) => [e.kind, JSON.stringify(e.payload).slice(0, 200)])));
      const bytes = (await fileOf())!;
      const text = (pptxParagraphs(bytes) ?? []).join("\n");
      assert.match(text, /Annual review.*moved to Monday/);
      // The editor took the change where it stood: the same page, not a new one.
      await sleep(3000);
      assert.equal(await frame.evaluate(() => (window as any).__kept).catch(() => null), "same page", "the window was not reloaded");
      assert.equal(page.frames().filter((f) => f.url().includes("/office-app/slides/")).length, 1);
      if (process.env.OFFICE_SHOT) await page.screenshot({ path: `${process.env.OFFICE_SHOT}-deck-after.png` });
    });

    await test("File -> Export PDF for a deck opens the PDF in the PDF editor", async () => {
      const r = await fetch(`${app.base}/api/officedesk/${s}/pdf`, { method: "POST" });
      assert.equal(r.status, 200, await r.text());
      const desk = (await app.api("GET", `/api/pdfdesk/${s}`)).body;
      assert.equal(desk.open, true);
      assert.equal(desk.name, "pitch.pdf");
    });

    // ---- a workbook
    await test("a workbook opens in the real Excel editor, with its formulas worked out", async () => {
      step = 100;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 101) return { tools: [{ name: "office_create", args: { type: "xlsx", name: "budget", rows: [["Item", "Qty", "Price", "Total"], ["Widget", 3, 4.5, "=B2*C2"]] } }] };
        return { text: "Made." };
      };
      await app.turn(s, "make a small budget workbook", 120_000);
      assert.equal((await state()).kind, "xlsx");
      frame = await editorIn(page, "sheets");
      await until("the editor", async () => /Autora/.test(await bodyText(frame)) && /Formulas/.test(await bodyText(frame)), 120_000);
      await until("the formula's value", async () => /13\.5/.test(await bodyText(frame)), 90_000).catch(() => undefined);
      const text = await bodyText(frame);
      assert.doesNotMatch(text, /Genspark/);
      assert.doesNotMatch(text, /[\u3400-\u9fff]/, "no Chinese anywhere in the editor");
      assert.match(text, /Autora/);
      assert.equal(await page.locator(".pdf-bar-name").innerText(), "budget.xlsx");
      if (process.env.OFFICE_SHOT) { await sleep(1500); await page.screenshot({ path: `${process.env.OFFICE_SHOT}-book.png` }); }
    });

    await test("what the person types into a cell is saved, kept in the file, and told to the agent", async () => {
      await sleep(1500);
      await page.mouse.click(945, 290);
      await sleep(300);
      await page.keyboard.type("7");
      await page.keyboard.press("Enter");
      let cells = new Map<string, string>();
      await until("the file to be kept current", async () => {
        const bytes = await fileOf();
        cells = (bytes && xlsxCells(bytes)) || new Map();
        return cells.get("data!B2") === "7" || [...cells.entries()].some(([k, v]) => /B2$/.test(k) && v === "7");
      }, 90_000);
      app.seen.length = 0;
      app.decide = (req) => guardOk(req) ?? { text: "Noted." };
      await app.turn(s, "what do you see in the workbook now?");
      const told = app.seen.map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n");
      assert.match(told, /in the Excel window, the person/);
      assert.match(told, /B2/);
    });

    await test("the agent changes the workbook while it is open and the window loads it, their change kept", async () => {
      let n = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        n += 1;
        if (n === 1) return { tools: [{ name: "office_edit", args: { file: "budget.xlsx", cells: [{ cell: "A3", value: "Gadget" }, { cell: "B3", value: 2 }] } }] };
        return { text: "Added a row." };
      };
      await frame.evaluate(() => { (window as any).__kept = "same page"; });
      await sleep(22_000);
      await app.turn(s, "add a Gadget row with quantity 2", 120_000);
      const cells = xlsxCells((await fileOf())!)!;
      assert.ok([...cells.entries()].some(([k, v]) => /A3$/.test(k) && v === "Gadget"), JSON.stringify([...cells]));
      assert.ok([...cells.entries()].some(([k, v]) => /B2$/.test(k) && v === "7"), "their change is still there");
      await sleep(4000);
      assert.equal(await frame.evaluate(() => (window as any).__kept).catch(() => null), "same page", "the window was not reloaded");
      assert.equal(page.frames().filter((f) => f.url().includes("/office-app/sheets/")).length, 1);
      if (process.env.OFFICE_SHOT) await page.screenshot({ path: `${process.env.OFFICE_SHOT}-book-after.png` });
    });

    await test("with control taken, the agent's edit to the workbook is held", async () => {
      await page.getByRole("button", { name: "Take control" }).click();
      await sleep(500);
      let n = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        n += 1;
        if (n === 1) return { tools: [{ name: "office_edit", args: { file: "budget.xlsx", cells: [{ cell: "A9", value: "SHOULD NOT APPEAR" }] } }] };
        return { text: "Understood, I will leave it." };
      };
      app.seen.length = 0;
      await app.turn(s, "write something in A9", 120_000);
      const told = app.seen.map((r) => JSON.stringify(r.messages)).join("\n");
      assert.match(told, /taken control of the document in the Office window/);
      const cells = xlsxCells((await fileOf())!)!;
      assert.ok(![...cells.values()].includes("SHOULD NOT APPEAR"));
      await page.getByRole("button", { name: "Hand back" }).click();
    });

    await test("File -> Export PDF for a workbook opens the PDF in the PDF editor", async () => {
      const r = await fetch(`${app.base}/api/officedesk/${s}/pdf`, { method: "POST" });
      assert.equal(r.status, 200, await r.text());
      const desk = (await app.api("GET", `/api/pdfdesk/${s}`)).body;
      assert.equal(desk.name, "budget.pdf");
    });

    assert.equal(errors.length, 0, errors.join("\n"));
    console.log(`\n${passed} passed`);
  } finally {
    await browser.close();
    await app.stop();
  }
}
main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
