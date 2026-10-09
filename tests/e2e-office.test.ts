/**
 * Word, Excel and PowerPoint through a whole turn: the tools come in when the
 * message calls for them, the file made appears in the thread as a card, an
 * edit lands in the same file, and a model that asks for something the tools
 * cannot do is told so plainly. A scripted model and the real engines (skipped
 * when they are not built: node scripts/build-office.mjs).
 *
 *   npx tsx tests/e2e-office.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp, type App, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const guardOk = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);
const told = (app: App) => app.seen.map((r) => JSON.stringify(r.messages)).join("\n");
const results = (ev: Ev[]) => ev.filter((e) => e.kind === "tool.result" || e.kind === "tool.error");

async function main() {
  if (!fs.existsSync(path.join(process.cwd(), "dist", "office", "cli", "genoffice.cjs"))) {
    console.log("office e2e: not built (node scripts/build-office.mjs) -- skipped");
    return;
  }
  const app: App = await startApp();
  try {
    console.log("a Word document through a turn");
    await test("the tools come in on the message, make a file, change it in place and read it back", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) {
          assert.ok(req.tools.includes("office_create"), "the Office tools are offered for a message about a Word document");
          return { tools: [{ name: "office_create", args: { type: "docx", name: "memo", markdown: "# Memo\n\nThe launch is on Friday.\n" } }] };
        }
        if (step === 2) return { tools: [{ name: "office_edit", args: { file: "memo.docx", ops: [{ op: "findReplace", find: "Friday", replace: "Monday" }] } }] };
        if (step === 3) return { tools: [{ name: "office_read", args: { file: "memo.docx" } }] };
        return { text: "The memo says Monday." };
      };
      const s = await app.newSession("office", "build");
      const ev = await app.turn(s, "write a short Word document announcing the launch, then move it to Monday", 120_000);
      const files = ev.filter((e) => e.kind === "media.file");
      assert.ok(files.some((e) => e.payload.name === "memo.docx"), "the file is a card in the thread");
      assert.ok(results(ev).every((e) => e.payload.ok !== false && !e.payload.error), JSON.stringify(results(ev).map((e) => e.payload)).slice(0, 400));
      assert.match(told(app), /Updated artifact/);
      assert.match(told(app), /The launch is on Monday/);
      app.decide = null;
    });

    console.log("pages, and PDFs for the PDF editor");
    await test("a model can see the pages of a Word document, and turn it into a PDF that opens in the PDF editor", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "office_look", args: { file: "memo.docx" } }] };
        if (step === 2) return { tools: [{ name: "office_pdf", args: { file: "memo.docx" } }] };
        return { text: "I looked at it, and the PDF is open in the editor." };
      };
      const s = await app.newSession("office2", "build");
      const ev = await app.turn(s, "show me the pages of memo.docx, then make it a PDF for the PDF editor", 120_000);
      assert.ok(ev.some((e) => e.kind === "media.image" && /memo\.docx/.test(String(e.payload.alt))), "the page is a picture in the thread");
      assert.ok(ev.some((e) => e.kind === "media.file" && e.payload.name === "memo.pdf"), "the PDF is a card in the thread");
      const desk = (await app.api("GET", `/api/pdfdesk/${s}`)).body;
      assert.equal(desk.open, true, "and it is open in the PDF editor");
      assert.equal(desk.name, "memo.pdf");
      assert.ok(told(app).includes("It is open in Autora PDF"));
      app.decide = null;
    });

    await test("a deck is drawn slide by slide, and the model is shown the slide", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "office_create", args: { type: "pptx", name: "deck2", spec: { pages: [{ title: "Hi", type: "cover", background: "#0E1A2B", elements: [{ type: "shape", shape: "rect", x: 80, y: 80, w: 400, h: 100, fill: "#1F3A5F", paragraphs: [{ align: "left", runs: [{ text: "Hi", sizePt: 32, color: "#FFFFFF" }] }] }] }] } } }] };
        if (step === 2) return { tools: [{ name: "office_look", args: { file: "deck2.pptx" } }] };
        return { text: "Understood." };
      };
      const s = await app.newSession("office3", "build");
      const ev = await app.turn(s, "make a one-slide PowerPoint deck and show me it", 120_000);
      const said = ev.filter((e) => e.kind === "tool.result" || e.kind === "tool.error").map((e) => JSON.stringify(e.payload).slice(0, 300)).join("\n");
      assert.match(said, /deck2\.pptx · page 1/);
      assert.doesNotMatch(told(app), /cannot be drawn/);
      app.decide = null;
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
