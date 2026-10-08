/**
 * The agent's change shown in steps: the in-between files a window is handed so the typing is the change itself.
 *
 *   npx tsx tests/officestage.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { strToU8, zipSync } from "fflate";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-officestage-test-"));
const { stagePlan, blankOf } = await import("../server/officestage");
const { docxParagraphs, pptxParagraphs, xlsxCells } = await import("../server/officedesk");

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const zip = (entries: Record<string, string>) => Buffer.from(zipSync(Object.fromEntries(Object.entries(entries).map(([k, v]) => [k, strToU8(v)]))));
const p = (t: string) => `<w:p><w:pPr><w:pStyle w:val="Normal"/></w:pPr><w:r><w:t xml:space="preserve">${t}</w:t></w:r></w:p>`;
const docx = (lines: string[]) => zip({
  "[Content_Types].xml": "<Types/>",
  "word/document.xml": `<?xml version="1.0"?><w:document><w:body>${lines.map(p).join("")}<w:sectPr/></w:body></w:document>`,
});

test("a paragraph is typed a run of words at a time and the last step is the finished file", () => {
  const before = docx(["Intro", "Closing"]);
  const after = docx(["Intro", "The quick brown fox jumps over the lazy dog", "Closing"]);
  const plan = stagePlan("docx", before, after)!;
  assert.ok(plan);
  assert.equal(plan.cues.length, 1);
  assert.equal(plan.cues[0].near, "Intro");
  assert.equal(plan.cues[0].steps, 9);
  assert.equal(plan.count, 9 + 2);
  assert.deepEqual(docxParagraphs(plan.frame(0)), ["Intro", "Closing"]);
  assert.deepEqual(docxParagraphs(plan.frame(1)), ["Intro", "The ", "Closing"]);
  assert.deepEqual(docxParagraphs(plan.frame(3)), ["Intro", "The quick brown ", "Closing"]);
  assert.deepEqual(docxParagraphs(plan.frame(9)), ["Intro", "The quick brown fox jumps over the lazy dog", "Closing"]);
  assert.equal(plan.frame(plan.count - 1), after);
  assert.ok(plan.cues[0].lead && "The quick brown fox".includes(plan.cues[0].lead.trim()));
});

test("several new paragraphs come in order, each typed after the one before is whole", () => {
  const before = docx(["Intro"]);
  const after = docx(["Intro", "First new line here", "Second new line there"]);
  const plan = stagePlan("docx", before, after)!;
  assert.equal(plan.cues.length, 2);
  const second = plan.cues[1].step;
  assert.deepEqual(docxParagraphs(plan.frame(second)), ["Intro", "First new line here", "Second "]);
});

test("a paragraph the agent rewrote is replaced by the typing", () => {
  const plan = stagePlan("docx", docx(["Intro", "Old words"]), docx(["Intro", "New words entirely"]))!;
  assert.deepEqual(docxParagraphs(plan.frame(1)), ["Intro", "New "]);
});

test("a change in a table is not cut into steps", () => {
  const tbl = (t: string) => zip({ "word/document.xml": `<w:document><w:body><w:tbl><w:tr><w:tc>${p(t)}</w:tc></w:tr></w:tbl></w:body></w:document>` });
  assert.equal(stagePlan("docx", tbl("a"), tbl("b longer words")), null);
});

test("only deletions, or nothing changed, are not typed", () => {
  assert.equal(stagePlan("docx", docx(["a", "b"]), docx(["a"])), null);
  assert.equal(stagePlan("docx", docx(["a"]), docx(["a"])), null);
});

const slide = (...t: string[]) => `<p:sld><p:cSld><p:spTree>${t.map((x) => `<p:sp><p:txBody><a:p><a:r><a:t>${x}</a:t></a:r></a:p></p:txBody></p:sp>`).join("")}</p:spTree></p:cSld></p:sld>`;
const deck = (slides: string[][]) => zip({
  "ppt/presentation.xml": '<p:presentation><p:sldSz cx="9144000" cy="5143500"/></p:presentation>',
  ...Object.fromEntries(slides.map((s, i) => [`ppt/slides/slide${i + 1}.xml`, slide(...s)])),
});

test("a deck's words are typed into their boxes and the rest of the new words wait", () => {
  const before = deck([["Title"]]);
  const after = deck([["Title", "Quarterly results look strong"], ["Next steps for everyone"]]);
  const plan = stagePlan("pptx", before, after)!;
  assert.ok(plan);
  assert.equal(plan.cues.length, 2);
  assert.deepEqual(pptxParagraphs(plan.frame(1)), ["Slide 1: Title", "Slide 1: Quarterly "]);
  assert.equal(plan.cues[0].steps, 4);
  const second = plan.cues[1].step;
  assert.deepEqual(pptxParagraphs(plan.frame(second)), ["Slide 1: Title", "Slide 1: Quarterly results look strong", "Slide 2: Next "]);
  assert.equal(plan.frame(plan.count - 1), after);
});

const sheet = (cells: Record<string, string | number>) => `<worksheet><sheetData><row r="1">${Object.entries(cells).map(([r, v]) => typeof v === "number" ? `<c r="${r}"><v>${v}</v></c>` : `<c r="${r}" t="inlineStr"><is><t>${v}</t></is></c>`).join("")}</row></sheetData></worksheet>`;
const book = (cells: Record<string, string | number>) => zip({
  "xl/workbook.xml": '<workbook><sheets><sheet name="Data" sheetId="1"/></sheets></workbook>',
  "xl/worksheets/sheet1.xml": sheet(cells),
});

test("a workbook fills in its new cells one by one and puts back what they held", () => {
  const before = book({ A1: "Name", B1: 1 });
  const after = book({ A1: "Name", B1: 2, C1: "Total" });
  const plan = stagePlan("xlsx", before, after, { then: xlsxCells(before)!, now: xlsxCells(after)! })!;
  assert.ok(plan);
  assert.deepEqual(plan.cues.map((c) => c.cell), ["B1", "C1"]);
  const at = (n: number) => Object.fromEntries(xlsxCells(plan.frame(n))!);
  assert.deepEqual(at(1), { "Data!A1": "Name", "Data!B1": "2" });
  assert.deepEqual(at(2), { "Data!A1": "Name", "Data!B1": "2", "Data!C1": "Total" });
  assert.equal(plan.frame(plan.count - 1), after);
});

test("a new document starts empty and is typed into, the last step the finished file", () => {
  const after = docx(["Title here", "Some body words go here"]);
  const empty = blankOf("docx", after)!;
  assert.deepEqual(docxParagraphs(empty), [""]);
  const plan = stagePlan("docx", empty, after)!;
  assert.equal(plan.cues.length, 2);
  assert.equal(plan.cues[0].near, undefined);
  assert.deepEqual(docxParagraphs(plan.frame(1)), ["Title "]);
  assert.equal(plan.frame(plan.count - 1), after);
});

test("a new deck and a new workbook start empty", () => {
  const d = deck([["Title", "Words here"]]);
  assert.deepEqual(pptxParagraphs(blankOf("pptx", d)!), []);
  const w = book({ A1: "x", B1: 2 });
  assert.equal(xlsxCells(blankOf("xlsx", w)!)!.size, 0);
  const plan = stagePlan("xlsx", blankOf("xlsx", w)!, w, { then: new Map(), now: xlsxCells(w)! })!;
  assert.equal(plan.cues.length, 2);
  assert.equal(xlsxCells(plan.frame(1))!.size, 1);
});

test("a long run of new paragraphs is shown in a bounded number of steps", () => {
  const lines = Array.from({ length: 6 }, (_, i) => `Paragraph ${i} with quite a few words in it to type out`);
  const plan = stagePlan("docx", blankOf("docx", docx(lines))!, docx(lines))!;
  assert.ok(plan.count <= 24 + 2 + 6, String(plan.count));
});

console.log(`${passed} passed`);
