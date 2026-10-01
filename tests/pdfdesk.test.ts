/**
 * The PDF window (server/pdfdesk.ts): what pdf_edit places arrives as the
 * editor's own objects; the file is the pages with them drawn on, and stays
 * so whoever changes them; what the person does is told to the agent once;
 * the other tools read the window's file and start it over from their result.
 *
 *   npx tsx tests/pdfdesk.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-pdfdesk-"));
process.env.AUTORA_STATE_DIR = dir;
const linuxChrome = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.env.AUTORA_BROWSER_PATH && fs.existsSync(linuxChrome)) process.env.AUTORA_BROWSER_PATH = linuxChrome;

const { PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream } = await import("@cantoo/pdf-lib");
const { getArtifact, readArtifact, saveArtifact } = await import("../server/artifacts");
const { drawFor, runPdfTool } = await import("../server/pdf");
const desk = await import("../server/pdfdesk");
const { rendererMissing } = await import("../server/pdfrender");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function letter(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const page = doc.addPage([612, 792]);
  page.drawText("Lease agreement", { x: 50, y: 740, size: 20, font });
  page.drawText("Tenant signature:", { x: 50, y: 200, size: 12, font });
  doc.addPage([612, 792]);
  return Buffer.from(await doc.save());
}

/** Whether these words are drawn anywhere in the file. */
async function holds(bytes: Buffer, words: string): Promise<boolean> {
  const doc = await PDFDocument.load(bytes, { updateMetadata: false });
  const hex = Buffer.from(words, "latin1").toString("hex");
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let text = "";
    try { text = Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"); } catch { continue; }
    if (text.includes(words) || text.toLowerCase().includes(hex)) return true;
  }
  return false;
}

const told: string[] = [];
desk.onDeskChange((s) => told.push(s));
const SESSION = "s-desk";
const files: { id: string; name: string }[] = [];
const ctx = {
  session: SESSION, cwd: dir, room: 20_000,
  putBlob: () => "blob.jpg",
  showImage: () => undefined,
  showFile: (f: { id: string; name: string }) => { files.push(f); },
  cancelled: () => false,
  onCancel: () => undefined,
  desk: desk.deskHooks(SESSION),
};
const run = (name: string, args: Record<string, any>) => runPdfTool(name, args, ctx);
const upload = saveArtifact({ origin: "user", name: "lease.pdf", data: await letter() });
const state = () => desk.deskState(SESSION) as any;

let working = "";
await test("pdf_edit opens the file in the window, with what it placed as the editor's objects", async () => {
  const r = await run("pdf_edit", {
    file: upload.id,
    add: [
      { type: "text", text: "Jane Tenant", page: 1, x: 160, y: 580, size: 14, bold: true },
      { type: "stamp", stamp: "approved", page: 1, x: 400, y: 40 },
      { type: "rect", page: 2, x: 30, y: 30, width: 200, height: 30 },
      { type: "check", page: 1, x: 300, y: 170 },
      { type: "arrow", page: 1, x: 50, y: 50, x2: 150, y2: 120 },
      { type: "note", page: 1, x: 500, y: 500, text: "Check the date" },
    ],
  });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /open in the PDF window/);
  assert.match(r.summary, /move, resize, edit or remove/);
  const s = state();
  assert.equal(s.open, true);
  assert.equal(s.items.length, 6);
  assert.deepEqual(s.items.map((i: any) => i.type), ["text", "stamp", "shape", "stamp", "drawing", "note"]);
  assert.equal(s.items[0].text, "Jane Tenant");
  assert.equal(s.items[0].fontSize, 14);
  assert.equal(s.items[1].stampType, "APPROVED");
  assert.equal(s.items[2].pageNumber, 2);
  assert.equal(s.items[3].stampType, "CHECKMARK");
  assert.equal(s.items[5].noteComment, "Check the date");
  assert.ok(s.items.every((i: any) => i.autora?.draw), "each keeps the pdf_edit item it came from");
  working = s.working;
  assert.ok(working && working !== upload.id);
  assert.equal(files[files.length - 1].id, working, "the file is shown in the thread");
  const data = readArtifact(working)!;
  assert.ok(await holds(data, "Jane Tenant"), "the file has what was placed drawn on it");
  assert.ok(!(await holds(desk.deskBase(SESSION)!, "Jane Tenant")), "the pages underneath do not");
  assert.equal(getArtifact(upload.id)!.size, upload.size, "the person's file is untouched");
  assert.ok(told.includes(SESSION), "the page is told");
});

await test("unchanged, an object is drawn exactly as pdf_edit would; moved, the same, somewhere else", () => {
  const text = state().items[0];
  assert.deepEqual(drawFor(text), text.autora.draw);
  assert.equal(text.autora.draw.bold, true, "bold survives, though the editor cannot show it");
  const moved = drawFor({ ...text, x: text.x + 40, y: text.y - 10 }) as Record<string, any>;
  assert.equal(moved.x, text.autora.draw.x + 40);
  assert.equal(moved.y, text.autora.draw.y - 10);
  assert.equal(moved.bold, true);
  const arrow = state().items[4];
  const shifted = drawFor({ ...arrow, x: arrow.x + 5, y: arrow.y + 5, drawingPoints: arrow.drawingPoints.map((p: any) => ({ x: p.x + 5, y: p.y + 5 })) }) as Record<string, any>;
  assert.equal(shifted.type, "arrow");
  assert.equal(shifted.x2, 155, "a moved arrow keeps its head and its angle");
  const retyped = drawFor({ ...text, text: "J. Tenant" }) as Record<string, any>;
  assert.equal(retyped.text, "J. Tenant", "edited, it is drawn from what the editor says");
});

await test("what the person made in the editor is drawn from the editor's own fields", () => {
  const base = { id: "p1", pageNumber: 1, x: 10, y: 20, width: 100, height: 40 };
  assert.equal((drawFor({ ...base, type: "shape", shapeType: "circle", hasFill: true, shapeFillColor: "#ff0000" }) as any).type, "ellipse");
  assert.equal((drawFor({ ...base, type: "stamp", stampType: "CROSS" }) as any).type, "cross");
  const ink = drawFor({ ...base, type: "drawing", drawingPoints: [{ x: 1, y: 2 }, { x: 3, y: 4 }], isHighlighter: true }) as any;
  assert.equal(ink.type, "path");
  assert.equal(ink.d, "M 1 2 L 3 4");
  assert.equal(ink.opacity, 0.35);
  assert.deepEqual(drawFor({ ...base, type: "redact" }), { redact: { x: 10, y: 20, w: 100, h: 40 } });
  assert.equal(drawFor({ ...base, type: "text", text: "  " }), null, "an empty text box draws nothing");
});

await test("the person's changes reach the file and are told to the agent once", async () => {
  const items = state().items;
  const sig = items[0];
  assert.equal(desk.personChanges(SESSION, [
    { ...sig, x: sig.x + 30 },
    { id: "ann_text_1", type: "text", pageNumber: 1, x: 60, y: 300, width: 150, height: 24, text: "Signed in Leeds", fontSize: 12, fontColor: "#000000", fontFamily: "Helvetica" },
  ], [items[5].id], dir), true);
  const after = state().items;
  assert.equal(after.length, 6);
  assert.ok(after.find((i: any) => i.id === sig.id).autora, "an object the agent placed keeps what it came from");
  assert.ok(!after.find((i: any) => i.id === "ann_text_1").autora);
  await sleep(1500);
  const data = readArtifact(state().working)!;
  assert.equal(state().working, working, "the same file, updated in place");
  assert.ok(await holds(data, "Signed in Leeds"), "the person's text is in the file");
  const news = ctx.desk.news();
  assert.match(news, /moved your text "Jane Tenant" on page 1/);
  assert.match(news, /added text "Signed in Leeds" on page 1/);
  assert.match(news, /removed your note "Check the date" on page 1/);
  assert.equal(ctx.desk.news(), "", "said once");
});

await test("the agent carrying on keeps what is there movable, the person's marks included", async () => {
  const r = await run("pdf_edit", { file: working, add: [{ type: "text", text: "Witness: Bob", page: 1, x: 60, y: 340 }] });
  assert.equal(r.ok, true, r.summary);
  const s = state();
  assert.equal(s.items.length, 7);
  assert.equal(s.working, working);
  assert.ok(!(await holds(desk.deskBase(SESSION)!, "Signed in Leeds")), "nothing was baked into the pages");
  assert.ok(await holds(readArtifact(working)!, "Witness: Bob"));
  assert.ok(await holds(readArtifact(working)!, "Signed in Leeds"));
});

await test("other tools read the window's file and start it over from their result", async () => {
  // The person's original, named: the tools read what the window has now.
  const r = await run("pdf_read", { file: upload.id });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /lease-edited\.pdf/, "the window's file, not the original");
  const p = await run("pdf_pages", { file: working, pages: "1" });
  assert.equal(p.ok, true, p.summary);
  const s = state();
  assert.equal(s.items.length, 0, "what was on the pages is part of them now");
  assert.ok(await holds(desk.deskBase(SESSION)!, "Signed in Leeds"));
  assert.equal((await PDFDocument.load(desk.deskBase(SESSION)!)).getPageCount(), 1);
});

await test("a reference file worked on in the background does not replace the window's file", async () => {
  const ref = saveArtifact({ origin: "user", name: "reference.pdf", data: await letter() });
  const before = state();
  const r = await run("pdf_pages", { file: ref.id, pages: "1" });
  assert.equal(r.ok, true, r.summary);
  const after = state();
  assert.equal(after.name, before.name, "the window keeps the working file");
  assert.equal(after.working, before.working);
  assert.equal(after.baseRev, before.baseRev);
});

await test("the start of a turn says what is open and what the person did", () => {
  desk.personChanges(SESSION, [{ id: "ann_note_1", type: "note", pageNumber: 1, x: 5, y: 5, width: 20, height: 20, noteComment: "Is this right?" }], [], dir);
  const brief = desk.deskBriefing(SESSION)!;
  assert.match(brief, /is open in the PDF window/);
  assert.match(brief, /added note "Is this right\?" on page 1/);
  assert.doesNotMatch(desk.deskBriefing(SESSION)!, /Is this right/, "said once");
});

await test("the window refuses what is not a PDF, and closes", () => {
  assert.match(desk.personBase(SESSION, Buffer.from("hello"), [], dir)!, /not a PDF/);
  desk.closeDesk(SESSION);
  assert.equal(state().open, false);
});

await test("with no window (an incognito chat), the PDF tools work as before", async () => {
  const r = await runPdfTool("pdf_edit", { file: upload.id, add: [{ type: "text", text: "Plain", x: 10, y: 10 }] }, { ...ctx, desk: undefined });
  assert.equal(r.ok, true, r.summary);
  assert.doesNotMatch(r.summary, /PDF window/);
});

if (await rendererMissing()) {
  console.log("  --  redaction drawn in the window: no browser here to draw pages with");
} else {
  await test("a redaction box drawn in the window takes the words out of the file", async () => {
    const h = desk.deskHooks("s-redact");
    const file = saveArtifact({ origin: "user", name: "secret.pdf", data: await letter() });
    await runPdfTool("pdf_look", { file: file.id }, { ...ctx, session: "s-redact", desk: h });
    assert.equal((desk.deskState("s-redact") as any).open, true, "looking opens the window");
    desk.personChanges("s-redact", [{ id: "r1", type: "redact", pageNumber: 1, x: 40, y: 30, width: 300, height: 40 }], [], dir);
    for (let i = 0; i < 60 && !(desk.deskState("s-redact") as any).working; i++) await sleep(250);
    const out = (desk.deskState("s-redact") as any).working;
    assert.ok(out, "the file was written");
    assert.ok(!(await holds(readArtifact(out)!, "Lease agreement")), "the words under the box are gone");
    assert.ok(await holds(readArtifact(file.id)!, "Lease agreement"), "the person's own file is untouched");
  });
}

console.log(`\n${passed} passed`);
process.exit(0);
