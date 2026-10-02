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
const { describeChange, fragment, docxParagraphs, isDocx } = await import("../server/officedesk");

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
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

console.log(`${passed} passed`);
