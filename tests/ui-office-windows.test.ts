/**
 * Two Office windows at once beside the conversation, each with its own tab, and the agent's cursor working in the
 * editor rather than over it: it really clicks, and where the editor cannot say where a thing is it stays away.
 *
 * Needs the app and the Office editors built (npm run build, and node scripts/build-office.mjs). Skips without a
 * browser or the editors.
 *
 *   npx tsx tests/ui-office-windows.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium, type Browser, type Frame, type Page } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/* Only the agent's own calls are scripted: the guard's check and the look back are model calls too. */
const guardOk = (req: { system: string; tools: string[] }) =>
  /You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' }
    : req.tools.length === 0 ? { text: "SKIP" }
      : null;

async function editorIn(page: Page, app: string): Promise<Frame> {
  for (let i = 0; i < 200; i++) {
    const frame = page.frames().find((f) => f.url().includes(`/office-app/${app}/`));
    if (frame) return frame;
    await sleep(100);
  }
  throw new Error(`the ${app} editor's frame never appeared`);
}


async function until<T>(what: string, fn: () => Promise<T | null | false>, ms = 30_000): Promise<T> {
  const end = Date.now() + ms;
  for (;;) {
    const got = await fn().catch(() => null);
    if (got) return got as T;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await sleep(250);
  }
}

let browser: Browser;
if (!fs.existsSync(process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome")) { console.log("  skip  no browser here"); process.exit(0); }
if (!fs.existsSync("dist/office/web/docs/index.html") || !fs.existsSync("dist/office/web/sheets/index.html")) { console.log("  skip  the Office editors are not built (node scripts/build-office.mjs)"); process.exit(0); }
if (!fs.existsSync("dist/index.html")) { console.log("  skip  the app is not built (npm run build)"); process.exit(0); }
try {
  browser = await chromium.launch({ executablePath: process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome" });
} catch {
  console.log("  skip  no browser");
  process.exit(0);
}
const app = await startApp();

try {
  const s = await app.newSession("Windows", "build");
  /* The answers, in order, one turn each: the guard's check and the tool-less calls (the look back, the companion's
     remark) are answered here instead, so the queue is never shifted by them. Content matching is no good: what the
     agent is asked includes an instruction block that mentions decks and spreadsheets of its own. */
  const createDocx = { name: "office_create", args: { type: "docx", name: "memo", markdown: "# Memo\n\nThe launch is on Friday.\n" } };
  const createXlsx = { name: "office_create", args: { type: "xlsx", name: "pets", rows: [["Breed", "Weight"], ["Beagle", 10.5]] } };
  const editDocx = { name: "office_edit", args: { file: "memo.docx", ops: [{ op: "findReplace", find: "Friday", replace: "Monday" }] } };
  const editXlsx = { name: "office_edit", args: { file: "pets.xlsx", cells: [{ cell: "B2", value: 11 }] } };
  app.decide = (req) => guardOk(req);
  app.script = [
    { tools: [createDocx] }, { text: "Made memo.docx." },
    { tools: [createXlsx] }, { text: "Made pets.xlsx." },
    { tools: [editDocx] }, { text: "Moved the launch to Monday." },
    { tools: [editXlsx] }, { text: "Changed the weight." },
    { text: "Done." }, { text: "Done." }, { text: "Done." },
  ];

  await app.turn(s, "make a document about dogs");
  await app.turn(s, "and a spreadsheet about dogs");

  const page = await browser.newPage({ viewport: { width: 1500, height: 900 } });
  await page.goto(`${app.base}/?session=${s}`);

  await test("both windows are open at once, each with a tab named for its app", async () => {
    try {
      await until("the tabs", async () => (await page.locator(".pane-pick-tab").count()) >= 2, 120_000);
    } catch (err) {
      const state = JSON.stringify((await app.api("GET", `/api/officedesk/${s}`)).body).slice(0, 300);
      const seen = await page.evaluate(() => ({
        stack: document.querySelectorAll(".side-stack").length,
        panes: document.querySelectorAll(".app-pane").length,
        tabs: document.querySelectorAll(".pane-pick-tab").length,
        rail: document.querySelectorAll(".rail-slot").length,
        text: document.body.innerText.replace(/\s+/g, " ").slice(0, 160),
      }));
      console.log("DIAG state=" + state);
      console.log("DIAG page=" + JSON.stringify(seen));
      throw err;
    }
    const tabs = await page.locator(".pane-pick-tab").allInnerTexts();
    // Activity is where the agent's tool calls are shown; the rest say which app each window is, not the file in it.
    assert.deepEqual(tabs.filter((t) => t !== "Activity"), ["Pages", "Sheets"], "the tabs say which app each window is, not the file in it");
    const state = (await app.api("GET", `/api/officedesk/${s}`)).body as { windows: { kind: string; name: string }[] };
    assert.deepEqual(state.windows.map((w) => w.kind).sort(), ["docx", "xlsx"], "two documents are open, one per app");
  });

  await test("switching tabs shows a window and puts nothing away", async () => {
    assert.equal(await page.locator('.side-stack .app-pane:not([data-pane="work"])').count(), 2, "both windows stay mounted");
    assert.equal(await page.locator('.side-stack .app-pane:not([data-pane="work"]):not([hidden])').count(), 1, "one window is shown");
    await page.locator('.pane-pick-tab[data-pane="pages"]').click();
    await sleep(400);
    assert.equal(await page.locator('.side-stack .app-pane:not([data-pane="work"])').count(), 2, "picking a tab closes nothing");
    assert.equal(await page.locator('.app-pane[data-pane="pages"]:not([hidden])').count(), 1, "the Pages window is the one shown");
    assert.equal(await page.locator('.pane-pick-tab:not([data-pane="work"])').count(), 2, "both tabs are still there");
  });

  await test("the tab strip runs to the very top of the screen", async () => {
    const strip = await page.locator(".pane-pick").boundingBox();
    const pane = await page.locator('.app-pane:not([hidden]):not([data-pane="work"])').boundingBox();
    assert.ok(strip && pane, "the strip and a window are on screen");
    assert.equal(Math.round(strip!.y), 0, "the tabs are the top of the window");
    assert.ok(strip!.height < 40, "and the strip is a strip (it covers about two thirds of the header behind it)");
    assert.ok(pane!.y >= strip!.height, "the window starts below the tabs");
  });

  /** What the agent was told by its last tool call. */
  const lastTold = () => JSON.stringify(app.seen.flatMap((r) => r.messages).filter((m: { role: string }) => m.role === "tool").slice(-1));

  await test("with Visible work on, the agent's change is typed by its hand in the Pages window, where the document is open", async () => {
    await app.turn(s, "move the launch to Monday in the document", 120_000);
    assert.match(lastTold(), /Typed by hand in the Autora Pages window/, lastTold().slice(-800));
    const docs = await editorIn(page, "docs");
    await until("the new day in the editor", async () => /Monday/.test(await docs.evaluate(() => document.body.innerText)), 30_000);
  });

  await test("each window's change is typed in that window: the cell goes to the Sheets window, not the Pages one", async () => {
    await page.locator('.pane-pick-tab[data-pane="sheets"]').click();
    await sleep(400);
    const shots = process.env.OFFICE_SHOT;
    const shooting = (async () => { for (let i = 0; i < 8 && shots; i++) { await sleep(1500); await page.screenshot({ path: `${shots}-win-${i}.png` }); } })();
    await app.turn(s, "change the weight in the spreadsheet", 120_000);
    await shooting;
    assert.match(lastTold(), /Typed by hand in the Autora Sheets window/, lastTold().slice(-800));
    assert.match(lastTold(), /B2 = 11/);
  });

  console.log(`\n  ${passed} passed`);
} finally {
  await browser.close();
  await app.stop();
}
