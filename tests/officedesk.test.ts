/**
 * How the Word window tells the agent what the person changed: paragraphs
 * compared, the difference said in words, and a real .docx read in-process.
 *
 *   npx tsx tests/officedesk.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-officedesk-test-"));
const { cuesFor, describeChange, fragment, docxParagraphs, isDocx, pptxParagraphs, xlsxCells, describeCells, isOffice } = await import("../server/officedesk");

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/** A zip of several deflated entries. */
function zipMany(entries: [string, string][]): Buffer {
  const parts: Buffer[] = [], central: Buffer[] = [];
  let offset = 0;
  for (const [name, body] of entries) {
    const raw = Buffer.from(body), data = zlib.deflateRawSync(raw), n = Buffer.from(name);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
    local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
    const c = Buffer.alloc(46);
    c.writeUInt32LE(0x02014b50, 0); c.writeUInt16LE(20, 4); c.writeUInt16LE(20, 6); c.writeUInt16LE(8, 10);
    c.writeUInt32LE(data.length, 20); c.writeUInt32LE(raw.length, 24); c.writeUInt16LE(n.length, 28); c.writeUInt32LE(offset, 42);
    parts.push(local, n, data); central.push(c, n);
    offset += local.length + n.length + data.length;
  }
  const cd = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(entries.length, 8); end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(cd.length, 12); end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, cd, end]);
}

/** A minimal zip with one deflated entry: enough for the reader. */
function zip(name: string, body: string): Buffer {
  const raw = Buffer.from(body), data = zlib.deflateRawSync(raw);
  const n = Buffer.from(name);
  const local = Buffer.alloc(30);
  local.writeUInt32LE(0x04034b50, 0); local.writeUInt16LE(20, 4); local.writeUInt16LE(8, 8);
  local.writeUInt32LE(data.length, 18); local.writeUInt32LE(raw.length, 22); local.writeUInt16LE(n.length, 26);
  const central = Buffer.alloc(46);
  central.writeUInt32LE(0x02014b50, 0); central.writeUInt16LE(20, 4); central.writeUInt16LE(20, 6); central.writeUInt16LE(8, 10);
  central.writeUInt32LE(data.length, 20); central.writeUInt32LE(raw.length, 24); central.writeUInt16LE(n.length, 28);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0); end.writeUInt16LE(1, 8); end.writeUInt16LE(1, 10);
  end.writeUInt32LE(central.length + n.length, 12); end.writeUInt32LE(local.length + n.length + data.length, 16);
  return Buffer.concat([local, n, data, central, n, end]);
}

test("a reworded word is quoted whole, with where it is", () => {
  const out = fragment("Meet on Friday.", "Meet on Monday.");
  assert.match(out, /changed "Friday\." to "Monday\."/);
  assert.match(out, /paragraph starting "Meet on Friday\."/);
});

test("an insertion and a deletion are said as such", () => {
  assert.match(fragment("Hello world", "Hello big world"), /^added "big /);
  assert.match(fragment("Hello big world", "Hello world"), /^deleted "big /);
});

test("identical documents have nothing to tell", () => {
  assert.deepEqual(describeChange(["a", "b"], ["a", "b"]), []);
});

test("moved paragraphs are not reported as rewording", () => {
  const out = describeChange(["one", "two", "three"], ["three", "one", "two"]).join(" ");
  assert.doesNotMatch(out, /changed "|added|deleted/);
});

test("added and removed paragraphs are counted", () => {
  const added = describeChange(["intro"], ["intro", "second", "third"]).join(" ");
  assert.match(added, /added 2 paragraphs \(starting "second"\)/);
  const gone = describeChange(["intro", "second"], ["intro"]).join(" ");
  assert.match(gone, /second/);
});

test("a .docx is read in-process, entities and tabs included", () => {
  const xml = `<w:document><w:body><w:p><w:r><w:t>Tom &amp; Jerry</w:t></w:r></w:p><w:p><w:r><w:t>a</w:t><w:tab/><w:t>b</w:t></w:r></w:p></w:body></w:document>`;
  const data = zip("word/document.xml", xml);
  assert.equal(isDocx(Buffer.concat([data, Buffer.alloc(100)])), true);
  assert.deepEqual(docxParagraphs(data), ["Tom & Jerry", "a\tb"]);
  assert.equal(docxParagraphs(Buffer.from("not a zip")), null);
});

test("a deck is read slide by slide, in order", () => {
  const slide = (t: string) => `<p:sld><a:p><a:r><a:t>${t}</a:t></a:r></a:p></p:sld>`;
  const entries: [string, string][] = [["ppt/presentation.xml", "<p:presentation/>"], ["ppt/slides/slide2.xml", slide("Second")], ["ppt/slides/slide1.xml", slide("First &amp; best")]];
  const data = zipMany(entries);
  assert.deepEqual(pptxParagraphs(data), ["Slide 1: First & best", "Slide 2: Second"]);
  assert.ok(isOffice(data, "pptx") && !isOffice(data, "docx") && !isOffice(data, "xlsx"));
  assert.match(describeChange(pptxParagraphs(data)!, ["Slide 1: First & better", "Slide 2: Second"]).join(" "), /changed "best" to "better".*Slide 1/);
});

test("a workbook is read cell by cell, shared strings, formulas and values included, and changes are said as cells", () => {
  const book = '<workbook><sheets><sheet name="Data" sheetId="1"/></sheets></workbook>';
  const sheet = (b2: string) => `<worksheet><sheetData><row r="1"><c r="A1" t="s"><v>0</v></c></row><row r="2"><c r="B2"><v>${b2}</v></c><c r="C2"><f>B2*2</f><v>${Number(b2) * 2}</v></c></row></sheetData></worksheet>`;
  const make = (b2: string) => zipMany([["xl/workbook.xml", book], ["xl/sharedStrings.xml", "<sst><si><t>Item</t></si></sst>"], ["xl/worksheets/sheet1.xml", sheet(b2)]]);
  const a = xlsxCells(make("3"))!, b = xlsxCells(make("4"))!;
  assert.equal(a.get("Data!A1"), "Item");
  assert.equal(a.get("Data!C2"), "=B2*2 (6)");
  assert.deepEqual(describeCells(a, a), ["changed the formatting or the structure"]);
  const said = describeCells(a, b).join("; ");
  assert.match(said, /changed Data!B2 from "3" to "4"/);
  assert.match(said, /Data!C2/);
  const gone = new Map(b); gone.delete("Data!A1"); gone.set("Data!D9", "new");
  assert.match(describeCells(b, gone).join("; "), /filled in Data!D9.*cleared Data!A1/);
});

const docx = (...paras: string[]) => zip("word/document.xml", `<w:document><w:body>${paras.map((t) => `<w:p><w:r><w:t>${t}</w:t></w:r></w:p>`).join("")}</w:body></w:document>`);

test("the cursor is sent to the paragraphs the agent changed or added, in order", () => {
  const was = docx("Intro", "Meet on Friday.", "Thanks");
  const now = docx("Intro", "Meet on Monday at noon.", "A new line", "Thanks");
  assert.deepEqual(cuesFor("docx", was, now), [
    { act: "type", text: "Meet on Monday at noon." },
    { act: "type", text: "A new line" },
  ]);
});

test("a document the agent made is typed in from its first lines, and a deletion is only pointed at", () => {
  assert.equal(cuesFor("docx", null, docx("One", "Two", "Three")).length, 3);
  assert.deepEqual(cuesFor("docx", docx("Keep", "Drop me", "End"), docx("Keep", "End")), [{ act: "point", text: "Keep" }]);
  assert.deepEqual(cuesFor("docx", docx("Same"), docx("Same")), []);
});

test("a workbook's cues name the cell and sheet, and type a formula as the formula", () => {
  const book = (cell: string) => zipMany([
    ["xl/workbook.xml", `<workbook><sheets><sheet name="Data" sheetId="1" r:id="rId1"/></sheets></workbook>`],
    ["xl/_rels/workbook.xml.rels", `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`],
    ["xl/worksheets/sheet1.xml", `<worksheet><sheetData><row r="1"><c r="A1" t="inlineStr"><is><t>Total</t></is></c>${cell}</row></sheetData></worksheet>`],
  ]);
  const cues = cuesFor("xlsx", book(""), book(`<c r="B1"><f>SUM(A2:A9)</f><v>42</v></c>`));
  assert.deepEqual(cues, [{ act: "type", text: "=SUM(A2:A9)", sheet: "Data", cell: "B1" }]);
});

console.log(`${passed} passed`);
