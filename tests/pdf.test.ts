/**
 * The PDF tools: page specs, colours, where things are on a turned page, what
 * the presets find and where, XFA data, and each tool run on a real file --
 * filled, marked up, rearranged, merged, split, redacted, shrunk, opened with
 * a password. What needs the page as it looks (text, pictures, redaction)
 * runs only where there is a Chromium to draw it with.
 *
 *   npx tsx tests/pdf.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-pdf-"));
process.env.AUTORA_STATE_DIR = dir;
const linuxChrome = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.env.AUTORA_BROWSER_PATH && fs.existsSync(linuxChrome)) process.env.AUTORA_BROWSER_PATH = linuxChrome;

const { PDFDocument, PDFRawStream, StandardFonts, decodePDFRawStream, degrees } = await import("@cantoo/pdf-lib");
const { getArtifact, readArtifact, saveArtifact } = await import("../server/artifacts");
const {
  findOnPage, fromView, paperName, parseColor, parsePages, patternsFor, rangeText, runPdfTool, toView, viewOf, xfaValues,
} = await import("../server/pdf");
const { rendererMissing } = await import("../server/pdfrender");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

// --------------------------------------------------------------- pieces --

await test("pages are named the ways people name them", () => {
  assert.deepEqual(parsePages("1-3, 5", 6), [0, 1, 2, 4]);
  assert.deepEqual(parsePages("last", 6), [5]);
  assert.deepEqual(parsePages("5-", 6), [4, 5]);
  assert.deepEqual(parsePages("-2", 6), [0, 1]);
  assert.deepEqual(parsePages("3-1", 6), [2, 1, 0], "backwards is backwards");
  assert.deepEqual(parsePages("odd", 5), [0, 2, 4]);
  assert.deepEqual(parsePages("even", 5), [1, 3]);
  assert.deepEqual(parsePages("", 3), [0, 1, 2]);
  assert.deepEqual(parsePages("2,1,blank,1", 2, true), [1, 0, "blank", 0], "repeats kept, blank where allowed");
  assert.throws(() => parsePages("blank", 2), /only a page in pdf_pages/);
  assert.throws(() => parsePages("7", 6), /There is no page 7: it has 6 pages/);
  assert.throws(() => parsePages("one", 6), /is not a page/);
  assert.equal(rangeText([0, 1, 2, 4, 6, 7]), "1-3, 5, 7-8");
});

await test("colours by name, hex and rgb(), and none", () => {
  const near = (a: number, b: number) => Math.abs(a - b) < 0.01;
  const red = parseColor("#ff0000", "black")!;
  assert.ok(near(red.red, 1) && near(red.green, 0) && near(red.blue, 0));
  const white = parseColor("#fff", "black")!;
  assert.ok(near(white.red, 1) && near(white.blue, 1));
  const rgbc = parseColor("rgb(0, 128, 255)", "black")!;
  assert.ok(near(rgbc.green, 128 / 255) && near(rgbc.blue, 1));
  assert.ok(parseColor("navy", "black"), "a name");
  assert.ok(parseColor("", "blue"), "the fallback");
  assert.equal(parseColor("none", "black"), null);
  assert.throws(() => parseColor("sparkly", "black"), /is not a colour/);
});

await test("paper sizes are named, either way up", () => {
  assert.equal(paperName(612, 792), "Letter");
  assert.equal(paperName(595.28, 841.89), "A4");
  assert.equal(paperName(842, 595), "A4, landscape");
  assert.equal(paperName(500, 500), "");
});

await test("a point means the same place on the page as shown, however it is turned or cropped", async () => {
  const doc = await PDFDocument.create();
  for (const angle of [0, 90, 180, 270]) {
    const page = doc.addPage([600, 800]);
    page.setCropBox(20, 30, 500, 700);
    page.setRotation(degrees(angle));
    const view = viewOf(page);
    const turned = angle === 90 || angle === 270;
    assert.equal(view.width, turned ? 700 : 500, `width at ${angle}`);
    assert.equal(view.height, turned ? 500 : 700, `height at ${angle}`);
    for (const [vx, vy] of [[0, 0], [10, 25], [view.width, view.height], [123.5, 67.25]]) {
      const [px, py] = fromView(view, vx, vy);
      const [bx, by] = toView(view, px, py);
      assert.ok(Math.abs(bx - vx) < 1e-6 && Math.abs(by - vy) < 1e-6, `round trip at ${angle}: ${vx},${vy} -> ${bx},${by}`);
    }
    // The top-left corner as shown is always a corner of the crop box.
    const [cx, cy] = fromView(view, 0, 0);
    assert.ok([20, 520].includes(Math.round(cx)) && [30, 730].includes(Math.round(cy)), `corner at ${angle}: ${cx},${cy}`);
  }
  const plain = viewOf(doc.getPage(0));
  assert.deepEqual(fromView(plain, 0, 0).map(Math.round), [20, 730], "unturned: top-left is the crop's top-left");
});

await test("the presets find what they say, and a match is boxed where it sits", () => {
  const page = {
    page: 1, width: 612, height: 792,
    items: [
      { s: "Contact: jane.doe@example.com", eol: true, box: [50, 100, 290, 12] as [number, number, number, number], dir: "r" as const },
      { s: "SSN 123-45-6789 and phone (555) 123-4567", eol: true, box: [50, 120, 400, 12] as [number, number, number, number], dir: "r" as const },
      { s: "Total due", eol: false, box: [50, 140, 60, 12] as [number, number, number, number], dir: "r" as const },
      { s: "   INV-2041", eol: true, box: [110, 140, 70, 12] as [number, number, number, number], dir: "r" as const },
    ],
  };
  const hits = findOnPage(page, patternsFor(["email", "SSN", "phones", "/inv-\\d+/i", "total   due"]));
  const by = (label: string) => hits.filter((h) => h.label === label);
  assert.deepEqual(by("email").map((h) => h.text), ["jane.doe@example.com"]);
  assert.deepEqual(by("ssn").map((h) => h.text), ["123-45-6789"]);
  assert.ok(by("phones").some((h) => /555\) 123-4567/.test(h.text)), JSON.stringify(by("phones")));
  assert.deepEqual(by("/inv-\\d+/i").map((h) => h.text), ["INV-2041"]);
  assert.deepEqual(by('"total   due"').map((h) => h.text), ["Total due"], "plain text: any case, any spacing");
  const email = by("email")[0].boxes[0];
  assert.ok(email.x > 80 && email.x + email.w <= 343, `the address, not the whole line: ${JSON.stringify(email)}`);
  assert.throws(() => patternsFor("/(unclosed/"), /is not a regular expression/);
});

await test("XFA data is read leaf by leaf, entities and CDATA included", () => {
  const xml = `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><page1>` +
    `<fullName>Jane &amp; Co</fullName><empty/><note><![CDATA[a < b]]></note><amount>12&#46;50</amount></page1></form1></xfa:data></xfa:datasets>`;
  assert.deepEqual(xfaValues(xml), [
    { path: "form1.page1.fullName", value: "Jane & Co" },
    { path: "form1.page1.note", value: "a < b" },
    { path: "form1.page1.amount", value: "12.50" },
  ]);
});

// ---------------------------------------------------------------- tools --

async function applicationPdf(): Promise<Buffer> {
  const doc = await PDFDocument.create();
  const font = await doc.embedFont(StandardFonts.Helvetica);
  const p1 = doc.addPage([612, 792]);
  p1.drawText("Application form", { x: 50, y: 740, size: 20, font });
  p1.drawText("Name:", { x: 50, y: 700, size: 12, font });
  p1.drawText("Contact: jane.doe@example.com, SSN 123-45-6789", { x: 50, y: 660, size: 12, font });
  p1.drawText("I agree to the terms", { x: 80, y: 620, size: 12, font });
  const form = doc.getForm();
  form.createTextField("applicant.name").addToPage(p1, { x: 100, y: 692, width: 200, height: 20 });
  form.createCheckBox("agree").addToPage(p1, { x: 50, y: 616, width: 16, height: 16 });
  const color = form.createDropdown("color");
  color.addOptions(["Red", "Green", "Blue"]);
  color.addToPage(p1, { x: 100, y: 560, width: 120, height: 20 });
  const p2 = doc.addPage([612, 792]);
  p2.drawText("Second page, turned: contact jane.doe@example.com", { x: 50, y: 700, size: 14, font });
  p2.setRotation(degrees(90));
  await doc.attach(Buffer.from("<invoice><total>42.00</total></invoice>"), "factur-x.xml", { mimeType: "application/xml" });
  doc.setTitle("Test form");
  return Buffer.from(await doc.save());
}

/** Every decoded content stream in a file, to look for words that should be gone. */
function holds(bytes: Buffer, words: string, doc: Awaited<ReturnType<typeof PDFDocument.load>>): boolean {
  const hex = Buffer.from(words, "latin1").toString("hex");
  for (const [, obj] of doc.context.enumerateIndirectObjects()) {
    if (!(obj instanceof PDFRawStream)) continue;
    let text = "";
    try { text = Buffer.from(decodePDFRawStream(obj).decode()).toString("latin1"); } catch { continue; }
    if (text.includes(words) || text.toLowerCase().includes(hex)) return true;
  }
  return bytes.includes(Buffer.from(words, "latin1"));
}

const upload = saveArtifact({ origin: "user", name: "application.pdf", data: await applicationPdf() });
const files: { id: string; name: string; mime: string; size: number }[] = [];
const pictures: string[] = [];
const ctx = {
  session: "s1", cwd: dir, room: 20_000,
  putBlob: (_data: Buffer, mime: string) => `blob-${pictures.length + 1}.${mime === "image/png" ? "png" : "jpg"}`,
  showImage: (blob: string) => { pictures.push(blob); },
  showFile: (f: { id: string; name: string; mime: string; size: number }) => { files.push(f); },
  cancelled: () => false,
  onCancel: () => undefined,
};
const run = (name: string, args: Record<string, any>) => runPdfTool(name, args, ctx);
const newest = () => files[files.length - 1];
const load = async (id: string) => PDFDocument.load(readArtifact(id)!, { updateMetadata: false });

await test("pdf_read says what the file is: pages, properties, fields and attachments", async () => {
  const r = await run("pdf_read", { file: upload.id });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /application\.pdf: 2 pages/);
  assert.match(r.summary, /Title: Test form/);
  assert.match(r.summary, /page 1: 612 × 792 pt \(Letter\)/);
  assert.match(r.summary, /page 2: .*turned 90°/);
  assert.match(r.summary, /- applicant\.name \(text\)/);
  assert.match(r.summary, /- agree \(checkbox/);
  assert.match(r.summary, /- color \(dropdown: "Red", "Green", "Blue"\)/);
  assert.match(r.summary, /factur-x\.xml \(application\/xml/);
});

await test("an attachment is extracted as an artifact, byte for byte", async () => {
  const before = files.length;
  const r = await run("pdf_read", { file: upload.id, extract: ["factur-x.xml"] });
  assert.equal(r.ok, true, r.summary);
  assert.equal(files.length, before + 1);
  assert.equal(readArtifact(newest().id)!.toString("utf8"), "<invoice><total>42.00</total></invoice>");
});

let edited = "";
await test("pdf_edit fills fields by the names people use, and never touches the original", async () => {
  const r = await run("pdf_edit", {
    file: upload.id,
    fields: { name: "Jane Doe", agree: true, color: "green" },
    metadata: { title: "Filled form", author: "Autora" },
  });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Filled 3 fields \(applicant\.name, agree, color\)/);
  edited = newest().id;
  const out = await load(edited);
  const form = out.getForm();
  assert.equal(form.getTextField("applicant.name").getText(), "Jane Doe");
  assert.equal(form.getCheckBox("agree").isChecked(), true);
  assert.deepEqual(form.getDropdown("color").getSelected(), ["Green"]);
  assert.equal(out.getTitle(), "Filled form");
  assert.equal(out.getAuthor(), "Autora");
  assert.equal(getArtifact(upload.id)!.size, upload.size, "the upload is as it was");
  assert.equal((await load(upload.id)).getForm().getTextField("applicant.name").getText(), undefined);
});

await test("pdf_edit writes text, shapes, a stamp, a watermark and page numbers", async () => {
  const r = await run("pdf_edit", {
    file: upload.id,
    add: [
      { type: "text", text: "Reviewed 1 June", page: 1, x: 400, y: 150, size: 11, color: "blue" },
      { type: "rect", page: 2, x: 30, y: 30, width: 200, height: 30 },
      { type: "stamp", stamp: "approved", page: 1, x: 400, y: 40 },
      { type: "check", page: 1, x: 300, y: 170 },
    ],
    watermark: { text: "DRAFT" },
    page_numbers: { format: "Page {n} of {total}" },
  });
  assert.equal(r.ok, true, r.summary);
  const out = await load(newest().id);
  assert.equal(out.getPageCount(), 2);
  assert.ok(holds(readArtifact(newest().id)!, "Page 2 of 2", out), "the page number is written");
});

await test("pdf_edit refuses what it cannot do, and saves nothing", async () => {
  const before = files.length;
  const unknown = await run("pdf_edit", { file: upload.id, fields: { nope: "x" } });
  assert.equal(unknown.ok, false);
  assert.match(unknown.summary, /there is no field "nope"/);
  const cyrillic = await run("pdf_edit", { file: upload.id, add: [{ type: "text", text: "Привет", x: 10, y: 10 }] });
  assert.equal(cyrillic.ok, false);
  assert.match(cyrillic.summary, /only cover Western European letters/);
  assert.equal(files.length, before);
});

await test("pdf_pages reorders, repeats, adds blanks and turns pages", async () => {
  const r = await run("pdf_pages", { file: upload.id, pages: "2,1,blank,1", rotate: [{ pages: "2", degrees: 90 }] });
  assert.equal(r.ok, true, r.summary);
  const out = await load(newest().id);
  assert.equal(out.getPageCount(), 4);
  assert.equal(out.getPage(0).getRotation().angle % 360, 180, "the turned page, turned 90 more");
  assert.equal(out.getPage(1).getRotation().angle % 360, 0);
});

await test("a dropped page is gone from the file, not just from the page list", async () => {
  const original = await load(upload.id);
  assert.ok(holds(readArtifact(upload.id)!, "Second page", original), "the words are there to begin with");
  const r = await run("pdf_pages", { file: upload.id, pages: "1" });
  assert.equal(r.ok, true, r.summary);
  const out = await load(newest().id);
  assert.equal(out.getPageCount(), 1);
  assert.equal(holds(readArtifact(newest().id)!, "Second page", out), false);
});

await test("pdf_pages merges files and splits one", async () => {
  const merged = await run("pdf_pages", { file: upload.id, merge: [edited] });
  assert.equal(merged.ok, true, merged.summary);
  assert.equal((await load(newest().id)).getPageCount(), 4);
  const before = files.length;
  const split = await run("pdf_pages", { file: upload.id, split: ["each"] });
  assert.equal(split.ok, true, split.summary);
  assert.equal(files.length, before + 2);
  for (const f of files.slice(before)) assert.equal((await load(f.id)).getPageCount(), 1, f.name);
});

await test("lossless compression never hands back a bigger file", async () => {
  const before = files.length;
  const r = await run("pdf_compress", { file: upload.id });
  assert.equal(r.ok, true, r.summary);
  if (files.length > before) assert.ok(newest().size < upload.size, "smaller, or nothing saved");
  else assert.match(r.summary, /did not get smaller/);
});

await test("a password-protected PDF asks for it, refuses a wrong one, and opens with the right one", async () => {
  const locked = path.join(dir, "locked.pdf");
  fs.copyFileSync(path.join("tests", "fixtures", "locked-form.pdf"), locked);
  const asked = await run("pdf_read", { file: locked });
  assert.equal(asked.ok, false);
  assert.match(asked.summary, /password-protected/);
  const wrong = await run("pdf_read", { file: locked, password: "wrong" });
  assert.equal(wrong.ok, false);
  assert.match(wrong.summary, /not the right one/);
  const filled = await run("pdf_edit", { file: "locked.pdf", password: "open", fields: { "applicant.name": "Locked Jane" } });
  assert.equal(filled.ok, true, filled.summary);
  assert.match(filled.summary, /this copy is not/);
  const out = await load(newest().id);
  assert.equal(out.isEncrypted, false, "the copy opens without a password");
  assert.equal(out.getTitle(), "Test form", "its properties survive the decryption");
  assert.equal(out.getForm().getTextField("applicant.name").getText(), "Locked Jane");
});

await test("a dynamic XFA form lists its data, extracts its XML, and is not filled as if it were ordinary", async () => {
  const { PDFName, PDFBool } = await import("@cantoo/pdf-lib");
  const doc = await PDFDocument.create();
  doc.addPage([612, 792]);
  const xdp = `<xdp:xdp xmlns:xdp="http://ns.adobe.com/xdp/"><template xmlns="http://www.xfa.org/schema/xfa-template/3.3/">` +
    `<subform name="form1"><subform name="page1"><field name="fullName"><ui><textEdit/></ui></field></subform></subform></template>` +
    `<xfa:datasets xmlns:xfa="http://www.xfa.org/schema/xfa-data/1.0/"><xfa:data><form1><page1><fullName>Jane Xfa</fullName></page1></form1></xfa:data></xfa:datasets></xdp:xdp>`;
  doc.catalog.set(PDFName.of("AcroForm"), doc.context.obj({ Fields: [], XFA: doc.context.register(doc.context.flateStream(xdp)) }));
  doc.catalog.set(PDFName.of("NeedsRendering"), PDFBool.True);
  const xfa = saveArtifact({ origin: "user", name: "xfa-form.pdf", data: Buffer.from(await doc.save()) });
  const read = await run("pdf_read", { file: xfa.id, extract: ["xfa"] });
  assert.equal(read.ok, true, read.summary);
  assert.match(read.summary, /dynamic XFA form/);
  assert.match(read.summary, /form1\.page1\.fullName = "Jane Xfa"/);
  assert.match(readArtifact(files[files.length - 2].id)!.toString("utf8"), /<xfa:data>/, "the whole XFA");
  assert.match(readArtifact(newest().id)!.toString("utf8"), /Jane Xfa/, "its data");
  const fill = await run("pdf_edit", { file: xfa.id, fields: { fullName: "x" } });
  assert.equal(fill.ok, false);
  assert.match(fill.summary, /dynamic XFA form/);
});

await test("what is not there, or not a PDF, is said so", async () => {
  const missing = await run("pdf_read", { file: "missing.pdf" });
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /There is no PDF "missing\.pdf"/);
  const text = saveArtifact({ origin: "user", name: "notes.txt", data: Buffer.from("just words") });
  const notPdf = await run("pdf_read", { file: text.id });
  assert.equal(notPdf.ok, false);
  assert.match(notPdf.summary, /notes\.txt is not a PDF/);
  const unknown = await run("pdf_frobnicate", { file: upload.id });
  assert.equal(unknown.ok, false);
});

// ------------------------------------------------------ with a renderer --

const missing = await rendererMissing();
if (missing) {
  console.log(`  skip  the renderer's tests: ${missing}`);
} else {
  await test("pdf_read reads the words, and finds presets with where they are", async () => {
    const r = await run("pdf_read", { file: upload.id });
    assert.match(r.summary, /--- page 1 ---\n[\s\S]*Application form/);
    const found = await run("pdf_read", { file: upload.id, find: ["email", "ssn"] });
    assert.match(found.summary, /3 matches/);
    assert.match(found.summary, /page 1: "jane\.doe@example\.com" at x \d/);
    assert.match(found.summary, /page 2: "jane\.doe@example\.com"/);
  });

  await test("pdf_look shows pages as pictures, to the agent and in the conversation", async () => {
    const before = pictures.length;
    const r = await run("pdf_look", { file: upload.id, pages: "1-2", grid: true });
    assert.equal(r.ok, true, r.summary);
    assert.equal(r.images?.length, 2);
    assert.equal(pictures.length, before + 2);
    assert.match(r.summary, /ruled every \d+ pt/);
  });

  await test("a typed signature and a highlight found by its words", async () => {
    const r = await run("pdf_edit", {
      file: upload.id,
      add: [
        { type: "signature", text: "Jane Doe", page: 1, x: 120, y: 245, width: 160 },
        { type: "highlight", text: "terms", page: 1 },
      ],
    });
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /signature "Jane Doe" on page 1/);
    assert.match(r.summary, /highlight of terms on page 1/);
  });

  await test("redaction takes the words out of the file, on every page they are on", async () => {
    const r = await run("pdf_redact", { file: upload.id, find: ["email", "ssn"] });
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /Redacted 3 matches on pages 1-2/);
    const bytes = readArtifact(newest().id)!;
    const out = await PDFDocument.load(bytes);
    for (const gone of ["jane.doe", "123-45-6789"]) assert.equal(holds(bytes, gone, out), false, `${gone} is still in the file`);
    const again = await run("pdf_read", { file: newest().id, find: ["email"] });
    assert.match(again.summary, /Nothing matched/);
  });

  await test("pdf_replace_text changes the words the file holds, and the old ones are gone", async () => {
    const r = await run("pdf_replace_text", {
      file: upload.id,
      replace: [{ find: "jane.doe@example.com", with: "sam@example.org" }, { find: "I agree to the terms", with: "I do not agree" }],
    });
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /"jane.doe@example.com" -> "sam@example.org": 2 changes on pages 1-2 \(in place\)/);
    const bytes = readArtifact(newest().id)!;
    const out = await PDFDocument.load(bytes);
    assert.equal(holds(bytes, "jane.doe", out), false, "the old address is still in the file");
    assert.equal(holds(bytes, "agree to the terms", out), false);
    const again = await run("pdf_read", { file: newest().id, find: ["sam@example.org", "I do not agree"] });
    assert.doesNotMatch(again.summary, /Nothing matched/);
    assert.match(again.summary, /sam@example\.org/);
    const none = await run("pdf_replace_text", { file: upload.id, replace: [{ find: "no such words", with: "x" }] });
    assert.equal(none.ok, true);
    assert.match(none.summary, /Nothing was changed/);
    const bad = await run("pdf_replace_text", { file: upload.id, replace: [] });
    assert.equal(bad.ok, false);
    assert.match(bad.summary, /Say what to change/);
  });

  await test("image compression redraws the pages, or says it would not help", async () => {
    const r = await run("pdf_compress", { file: upload.id, mode: "images", dpi: 60 });
    assert.equal(r.ok, true, r.summary);
    assert.match(r.summary, /did not get smaller|every page redrawn/);
  });
}

console.log(`\n${passed} passed`);
fs.rmSync(dir, { recursive: true, force: true });
process.exit(0);
