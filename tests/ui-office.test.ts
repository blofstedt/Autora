/**
 * The Word window, in a real browser with the real editor: the agent writes a
 * document and it opens beside the chat in GenOffice's Word editor; the person
 * types in it and the file is kept current and the agent is told; the agent
 * changes it while it is open and it arrives without a reload; the person can
 * take control and the agent leaves it alone.
 *
 * Needs the app and the Office editors built (npm run build, then
 * node scripts/build-office.mjs); skips without a browser or the editor.
 *
 *   npx tsx tests/ui-office.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame, type Page } from "playwright-core";
import { docxParagraphs } from "../server/officedesk";
import { sleep, startApp, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
/* Only the agent's own calls are scripted -- the ones that carry its tools. The guard's check, the look back after a
   turn and the companion's remark on what the person did are model calls too, and must not use up the script. */
const guardOk = (req: { system: string; tools: string[] }) =>
  /You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' }
    : req.tools.length === 0 ? { text: "SKIP" }
      : null;

async function editorIn(page: Page): Promise<Frame> {
  for (let i = 0; i < 200; i++) {
    const frame = page.frames().find((f) => f.url().includes("/office-app/docs/"));
    if (frame) return frame;
    await sleep(100);
  }
  throw new Error("the editor's frame never appeared");
}

/** Whether the editor has laid the document out: it publishes its pages once it has. */
async function laidOut(frame: Frame): Promise<boolean> {
  for (let i = 0; i < 120; i++) {
    const n = await frame.evaluate(() => (window as any).__pageDebug?.slices?.length ?? 0).catch(() => 0);
    if (n > 0) return true;
    await sleep(250);
  }
  return false;
}

const bodyText = (frame: Frame) => frame.evaluate(() => document.body.innerText).catch(() => "");

async function until(what: string, ok: () => Promise<boolean>, ms = 30_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok()) return; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/office/web/docs/index.html")) { console.log("  skip  the Word editor is not built (node scripts/build-office.mjs)"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built (npm run build)"); return; }
  const app: App = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  try {
    const s = await app.newSession("Memo", "build");
    let step = 0;
    app.decide = (req) => {
      const g = guardOk(req);
      if (g) return g;
      step += 1;
      if (step === 1) return { tools: [{ name: "office_create", args: { type: "docx", name: "memo", markdown: "# Launch memo\n\nThe launch is on Friday.\n" } }] };
      return { text: "Written." };
    };
    await app.turn(s, "write a short Word memo about the launch", 120_000);

    const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
    const errors: string[] = [];
    page.on("pageerror", (e) => errors.push(String(e)));
    await page.goto(`${app.base}/?session=${s}`);

    let frame: Frame;
    await test("the memo opens beside the chat in the real Word editor, laid out", async () => {
      frame = await editorIn(page);
      assert.ok(await laidOut(frame), "the editor never laid the document out");
      await until("the heading", async () => /Launch memo/.test(await bodyText(frame)));
      assert.match(await bodyText(frame), /The launch is on Friday/);
      // Calibri is drawn in its metric twin, so the pages are the same: no warning about it.
      assert.doesNotMatch(await bodyText(frame), /Missing document fonts/);
      assert.equal(await page.locator(".pdf-bar-name").innerText(), "memo.docx");
      if (process.env.OFFICE_SHOT) { await sleep(1500); await page.screenshot({ path: process.env.OFFICE_SHOT }); }
      assert.equal(errors.length, 0, errors.join("\n"));
    });

    await test("what the person types is saved as they go, kept in the file, and told to the agent", async () => {
      const state = async () => (await app.api("GET", `/api/officedesk/${s}`)).body;
      const before = (await state()).rev;
      const box = frame.locator('[contenteditable="true"]').first();
      await box.click();
      await page.keyboard.press("Control+End");
      await page.keyboard.type(" Moved by the person to Monday.");
      await until("the save", async () => (await state()).rev > before, 40_000);
      // The file everyone else sees is rewritten shortly after: typing sends a few saves in a row.
      let text = "";
      await until("the file to be kept current", async () => {
        const working = (await state()).working as string | null;
        if (!working) return false;
        const bytes = Buffer.from(await (await fetch(`${app.base}/api/artifacts/${working}`)).arrayBuffer());
        text = (docxParagraphs(bytes) ?? []).join("\n");
        return /Moved by the person to Monday/.test(text);
      }, 15_000);
      assert.match(text, /Moved by the person to Monday/);
      // Told on the agent's next turn.
      app.seen.length = 0;
      app.decide = (req) => guardOk(req) ?? { text: "Noted." };
      await app.turn(s, "what do you see in the memo now?");
      const told = app.seen.map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n");
      assert.match(told, /in the Word window, the person/);
      assert.match(told, /Moved by the person to Monday/);
    });

    await test("the agent changes it while it is open and the editor shows it without a reload", async () => {
      let n = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        n += 1;
        if (n === 1) return { tools: [{ name: "office_edit", args: { file: "memo.docx", ops: [{ op: "findReplace", find: "Launch memo", replace: "Launch notes" }] } }] };
        return { text: "Renamed." };
      };
      // They were typing a moment ago, so the document is theirs: the agent is told to come back later (next test).
      // Wait out the lease, as the agent would by working on something else.
      await sleep(22_000);
      const frameBefore = frame;
      const ev = await app.turn(s, "rename the heading to Launch notes", 120_000);
      if (process.env.OFFICE_DEBUG) {
        console.log("last events:", JSON.stringify(ev.slice(-14).map((e) => [e.kind, JSON.stringify(e.payload).slice(0, 160)])));
        console.log("desk:", JSON.stringify((await app.api("GET", `/api/officedesk/${s}`)).body).slice(0, 400));
        await sleep(3000);
        console.log("frame text:", (await bodyText(frame)).slice(0, 300).replace(/\n/g, " | "));
      }
      await until("the new heading", async () => /Launch notes/.test(await bodyText(frame)), 40_000);
      assert.equal(page.frames().filter((f) => f.url().includes("/office-app/docs/")).length, 1);
      assert.strictEqual(frameBefore, frame);
      // Their typing survived the agent's change.
      assert.match(await bodyText(frame), /Moved by the person to Monday/);
    });

    await test("with control taken, the agent's edit is held and the document is left alone", async () => {
      await page.getByRole("button", { name: "Take control" }).click();
      await sleep(500);
      let n = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        n += 1;
        if (n === 1) return { tools: [{ name: "office_edit", args: { file: "memo.docx", ops: [{ op: "findReplace", find: "Launch notes", replace: "SHOULD NOT APPEAR" }] } }] };
        return { text: "Understood, I will leave it." };
      };
      app.seen.length = 0;
      await app.turn(s, "change the heading again", 120_000);
      const told = app.seen.map((r) => JSON.stringify(r.messages)).join("\n");
      assert.match(told, /taken control of the document in the Office window/);
      assert.doesNotMatch(await bodyText(frame), /SHOULD NOT APPEAR/);
      await page.getByRole("button", { name: "Hand back" }).click();
    });

    await test("File -> Export PDF in the window opens the PDF in the PDF editor", async () => {
      const r = await fetch(`${app.base}/api/officedesk/${s}/pdf`, { method: "POST" });
      assert.equal(r.status, 200, await r.text());
      const desk = (await app.api("GET", `/api/pdfdesk/${s}`)).body;
      assert.equal(desk.open, true);
      assert.equal(desk.name, "memo.pdf");
    });

    assert.equal(errors.length, 0, errors.join("\n"));
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
