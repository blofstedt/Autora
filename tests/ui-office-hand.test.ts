/**
 * Pages, Sheets and Slides with Visible work on: the agent's office_edit is typed into the open editor by its hand,
 * live, while the call waits -- the words that change selected and typed over in Pages, cells gone to and typed into
 * in Sheets, a slide's box opened and typed into in Slides -- and then the file the operations made is in the window.
 * With Visible work off it simply appears.
 *
 * Needs the app and the Office editors built (npm run build, then node scripts/build-office.mjs).
 *
 *   npx tsx tests/ui-office-hand.test.ts [docs|sheets|slides]
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Frame, type Page } from "playwright-core";
import { docxParagraphs, pptxParagraphs, xlsxCells } from "../server/officedesk";
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
async function until(what: string, ok: () => Promise<boolean>, ms = 60_000) {
  const end = Date.now() + ms;
  while (Date.now() < end) { if (await ok().catch(() => false)) return; await sleep(300); }
  throw new Error(`timed out waiting for ${what}`);
}
const bodyText = (frame: Frame) => frame.evaluate(() => document.body.innerText).catch(() => "");

/** One turn whose only tool call is `call`; what the model was told back. */
async function agentDoes(app: App, s: string, said: string, call: { name: string; args: Record<string, unknown> }, ms = 180_000): Promise<string> {
  let n = 0;
  app.decide = (req) => guardOk(req) ?? (++n === 1 ? { tools: [call] } : { text: "Done." });
  await app.turn(s, said, ms);
  return JSON.stringify(app.seen.flatMap((r) => r.messages).filter((m: { role: string }) => m.role === "tool").slice(-1));
}

/** Watch what the editor tells the window: the hand's cursor and its answer. */
async function watch(page: Page): Promise<() => Promise<string[]>> {
  await page.evaluate(() => {
    (window as unknown as { __said: string[] }).__said = [];
    window.addEventListener("message", (e) => {
      const d = e.data as { type?: unknown; op?: unknown } | null;
      if (d && d.type === "autora:office" && typeof d.op === "string" && /^hand/.test(d.op)) (window as unknown as { __said: string[] }).__said.push(d.op);
    });
  });
  return () => page.evaluate(() => (window as unknown as { __said: string[] }).__said.slice());
}

async function main() {
  const only = process.argv[2];
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  if (!fs.existsSync("dist/office/web/docs/index.html")) { console.log("  skip  the Office editors are not built (node scripts/build-office.mjs)"); return; }
  if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built (npm run build)"); return; }
  const app: App = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const shots = process.env.OFFICE_HAND_SHOT;
  const shoot = (page: Page, tag: string, n = 10, every = 1200) => (async () => {
    for (let i = 0; i < n && shots; i++) { await sleep(every); await page.screenshot({ path: `${shots}-${tag}-${i}.png` }).catch(() => undefined); }
  })();
  try {
    if (!only || only === "docs") {
      const s = await app.newSession("Memo", "build");
      await agentDoes(app, s, "write a memo", { name: "office_create", args: { type: "docx", name: "memo", markdown: "# Launch memo\n\nThe launch is on Friday at noon.\n\nBring the slides.\n" } });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${app.base}/?session=${s}`);
      const frame = await editorIn(page, "docs");
      await until("the memo in the editor", async () => /Bring the slides/.test(await bodyText(frame)));
      const said = await watch(page);
      await sleep(2000);

      await test("Pages: the agent's edit is typed in the open document by its hand, and the file is what the operations made", async () => {
        const seen: string[] = [];
        let watching = true;
        void (async () => { while (watching) { seen.push(await bodyText(frame)); await sleep(80); } })();
        const shot = shoot(page, "docs");
        const told = await agentDoes(app, s, "move it to Monday", { name: "office_edit", args: { file: "memo.docx", ops: [{ op: "findReplace", find: "Friday", replace: "Monday" }], track: false } });
        watching = false;
        await shot;
        assert.match(told, /Typed by hand in the Autora Pages window/, told.slice(-1500));
        const ops = await said();
        assert.ok(ops.filter((o) => o === "hand-cursor").length > 10, "the hand's cursor moved in the editor");
        assert.ok(ops.includes("handed"));
        // Typed a key at a time: in between, the word was part typed.
        assert.ok(seen.some((t) => /on (M|Mo)?day at noon/.test(t)), "the word was typed in steps: only the letters that differ, over the old ones");
        await until("the finished document", async () => /The launch is on Monday at noon/.test(await bodyText(frame)));
        const st = (await app.api("GET", `/api/officedesk/${s}`)).body;
        const win = (st.windows as Array<{ kind: string; working?: string }>).find((w) => w.kind === "docx")!;
        const bytes = Buffer.from(await (await fetch(`${app.base}/api/artifacts/${win.working}`)).arrayBuffer());
        assert.match((docxParagraphs(bytes) ?? []).join("\n"), /on Monday at noon/);
      });

      await test("Pages: a new paragraph is typed after the one it follows (tracked: the one taken out stays, struck through)", async () => {
        await sleep(5000);
        const shot = shoot(page, "docs-insert");
        const told = await agentDoes(app, s, "add a line and drop the last one", { name: "office_edit", args: { file: "memo.docx", ops: [
          // Ops apply in order: the last paragraph goes first, so the new one's index is not shifted under it.
          { op: "deleteBlocks", target: { blockIndexes: [2] } },
          { op: "insert_content", html: "<p>Lunch is on the house.</p>", afterBlockIndex: 1 },
        ] } });
        await shot;
        assert.match(told, /Typed by hand in the Autora Pages window/, told.slice(-1500));
        assert.match(told, /typed in a new paragraph/);
        // Tracked (the window's default for a document): the paragraph taken out stays, struck through, for the person
        // to accept or reject, so there is nothing to delete by hand.
        assert.doesNotMatch(told, /Not typed/, told.slice(-1500));
        await until("the finished document", async () => /Lunch is on the house/.test(await bodyText(frame)));
      });

      await test("Pages, untracked: a paragraph taken out is selected and deleted by hand", async () => {
        await sleep(5000);
        const told = await agentDoes(app, s, "drop the lunch line", { name: "office_edit", args: { file: "memo.docx", ops: [
          { op: "findReplace", find: "Lunch is on the house.", replace: "" },
        ], track: false } });
        assert.match(told, /Typed by hand in the Autora Pages window/, told.slice(-1500));
        assert.doesNotMatch(told, /Not typed/, told.slice(-1500));
        await until("the line gone", async () => !/Lunch is on the house/.test(await bodyText(frame)));
      });
      await page.close();
    }
    if (!only || only === "sheets") {
      const s = await app.newSession("Budget", "build");
      await agentDoes(app, s, "make a budget", { name: "office_create", args: { type: "xlsx", name: "budget", rows: [["Item", "Cost"], ["Rent", 10], ["Food", 20]] } });
      const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
      await page.goto(`${app.base}/?session=${s}`);
      const frame = await editorIn(page, "sheets");
      await until("the workbook in the editor", async () => /fully loaded/i.test(await bodyText(frame)), 120_000);
      const said = await watch(page);
      await sleep(4000);

      await test("Sheets: each cell is gone to by the name box, typed into and confirmed by hand, and the file is what the operations made", async () => {
        const shot = shoot(page, "sheets", 14, 1500);
        const told = await agentDoes(app, s, "rent is 15 and add a total", { name: "office_edit", args: { file: "budget.xlsx", cells: [
          { cell: "B2", value: 15 },
          { cell: "A4", value: "Total" },
          { cell: "B4", formula: "SUM(B2:B3)" },
        ] } });
        await shot;
        assert.match(told, /Typed by hand in the Autora Sheets window/, told.slice(-1500));
        assert.doesNotMatch(told, /Not typed/, told.slice(-1500));
        const ops = await said();
        assert.ok(ops.filter((o) => o === "hand-cursor").length > 10, "the hand's cursor moved in the editor");
        const st = (await app.api("GET", `/api/officedesk/${s}`)).body;
        const win = (st.windows as Array<{ kind: string; working?: string }>).find((w) => w.kind === "xlsx")!;
        const cells = xlsxCells(Buffer.from(await (await fetch(`${app.base}/api/artifacts/${win.working}`)).arrayBuffer())) ?? new Map();
        const at = (ref: string) => [...cells.entries()].find(([k]) => k.endsWith(`!${ref}`))?.[1];
        assert.equal(at("B2"), "15");
        assert.match(String(at("B4")), /SUM\(B2:B3\).*35/);
        await until("the total in the editor", async () => /35/.test(await bodyText(frame)), 30_000).catch(() => undefined);
      });
      await page.close();
    }
    if (!only || only === "slides") {
      const s = await app.newSession("Pitch", "build");
      await agentDoes(app, s, "make a deck", { name: "office_create", args: { type: "pptx", name: "pitch", spec: { pages: [{ title: "Hello", type: "cover", background: "#0E1A2B", elements: [
        { type: "shape", shape: "rect", x: 80, y: 80, w: 600, h: 120, fill: "#1F3A5F", paragraphs: [{ align: "left", runs: [{ text: "Quarterly review", sizePt: 40, color: "#FFFFFF" }] }] },
      ] }] } } });
      const page = await browser.newPage({ viewport: { width: 1600, height: 950 } });
      await page.goto(`${app.base}/?session=${s}`);
      const frame = await editorIn(page, "slides");
      await until("the deck in the editor", async () => /Slide 1 (\/|of) 1/.test(await bodyText(frame)), 120_000);
      const said = await watch(page);
      await sleep(4000);

      await test("Slides: the box is opened on the slide and its words typed over by hand, and the file is what the operations made", async () => {
        const shot = shoot(page, "slides", 12, 1200);
        const told = await agentDoes(app, s, "make it the annual review", { name: "office_edit", args: { file: "pitch.pptx", ops: [{ op: "findReplace", find: "Quarterly review", replace: "Annual review" }] } });
        await shot;
        assert.match(told, /Typed by hand in the Autora Slides window/, told.slice(-1500));
        assert.doesNotMatch(told, /Not typed/, told.slice(-1500));
        const ops = await said();
        assert.ok(ops.filter((o) => o === "hand-cursor").length > 10, "the hand's cursor moved in the editor");
        const st = (await app.api("GET", `/api/officedesk/${s}`)).body;
        const win = (st.windows as Array<{ kind: string; working?: string }>).find((w) => w.kind === "pptx")!;
        const text = (pptxParagraphs(Buffer.from(await (await fetch(`${app.base}/api/artifacts/${win.working}`)).arrayBuffer())) ?? []).join("\n");
        assert.match(text, /Annual review/);
        assert.doesNotMatch(text, /Quarterly/);
      });
      await page.close();
    }
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}

void main().catch((err) => { console.error(err); process.exit(1); });
