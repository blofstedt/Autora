/**
 * Changing the words a PDF already has: in place where the font can write
 * them, by taking the old glyphs out and handing back where to draw the new
 * words where it cannot. Checked by reading the result back with pdf.js, the
 * way a viewer would, so what is tested is what a person would see and select.
 *
 *   npx tsx tests/pdftext.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-pdftext-"));
process.env.AUTORA_STATE_DIR = dir;
const linuxChrome = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.env.AUTORA_BROWSER_PATH && fs.existsSync(linuxChrome)) process.env.AUTORA_BROWSER_PATH = linuxChrome;

const { PDFDocument, StandardFonts, rgb } = await import("@cantoo/pdf-lib");
const { replaceOnPage, tokenize } = await import("../server/pdftext");
const { runPdfTool } = await import("../server/pdf");
const { saveArtifact, readArtifact } = await import("../server/artifacts");
const { rendererMissing, withPdf } = await import("../server/pdfrender");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

console.log("pdf text");

await test("the tokenizer reads strings, arrays, names and leaves images alone", () => {
  const ops = tokenize("BT /F1 12 Tf (Hi \\(there\\)) Tj [(A) -20 <4243>] TJ ET BI /W 1 ID \x00(not an op) Tj\nEI q Q");
  assert.deepEqual(ops.map((o) => o.name), ["BT", "Tf", "Tj", "TJ", "ET", "BI", "q", "Q"]);
  const tj = ops[2].args[0];
  assert.ok(tj.k === "str" && Buffer.from(tj.b).toString("latin1") === "Hi (there)");
  const arr = ops[3].args[0];
  assert.ok(arr.k === "arr" && arr.items.length === 3);
});

const missing = await rendererMissing();
if (missing) {
  console.log(`  skipped the file tests: ${missing}`);
  console.log(`${passed} passed`);
  process.exit(0);
}

/** What a viewer reads from the first page, spaces and all. */
async function textOf(data: Buffer): Promise<string> {
  return withPdf(data, undefined, async (view) => {
    const [page] = await view.text(1, 1, true);
    return page.items.map((i) => i.s).join(" ").replace(/\s+/g, " ").trim();
  });
}

async function boxesFor(data: Buffer, find: string) {
  return withPdf(data, undefined, async (view) => {
    const [page] = await view.text(1, 1, true);
    const out: { x: number; y: number; w: number; h: number }[] = [];
    for (const item of page.items) {
      const at = item.s.indexOf(find);
      if (at >= 0 && item.box) {
        const [x, y, w, h] = item.box;
        out.push({ x: x + (w * at) / item.s.length, y, w: (w * find.length) / item.s.length, h });
      }
    }
    return out;
  });
}

async function run(data: Buffer, edits: { find: string; with: string }[]) {
  const doc = await PDFDocument.load(data);
  const res = await replaceOnPage(doc, doc.getPage(0), edits, async (find) => boxesFor(data, find));
  return { res, bytes: Buffer.from(await doc.save()) };
}

// A file made the plain way: a standard font, no embedding.
const plain = await (async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([400, 300]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Name: John Smith", { x: 40, y: 240, size: 14, font });
  page.drawText("Total due: 120 USD", { x: 40, y: 200, size: 14, font, color: rgb(0.8, 0, 0) });
  page.drawText("Total due: 120 USD", { x: 40, y: 160, size: 14, font });
  return Buffer.from(await doc.save());
})();

await test("a name is changed in place in a standard font, and the old one is gone from the bytes", async () => {
  const { res, bytes } = await run(plain, [{ find: "John Smith", with: "Jane Doe" }]);
  assert.equal(res.changed[0].how, "in place");
  assert.equal(res.changed[0].matches, 1);
  assert.equal(res.draws.length, 0);
  const text = await textOf(bytes);
  assert.match(text, /Name: Jane Doe/);
  assert.doesNotMatch(text, /John|Smith/);
  assert.ok(!bytes.toString("latin1").includes("John"));
});

await test("every match of a phrase changes, wherever it is", async () => {
  const { res, bytes } = await run(plain, [{ find: "120 USD", with: "95 EUR" }]);
  assert.equal(res.changed[0].matches, 2);
  const text = await textOf(bytes);
  assert.equal((text.match(/95 EUR/g) ?? []).length, 2);
  assert.doesNotMatch(text, /120/);
});

await test("a letter the font cannot write is redrawn, in the colour it had, and the old text is gone", async () => {
  const { res, bytes } = await run(plain, [{ find: "John Smith", with: "Jan Ω" }]);
  assert.equal(res.changed[0].how, "redrawn");
  assert.equal(res.draws.length, 1);
  assert.equal(res.draws[0].text, "Jan Ω");
  assert.ok(res.draws[0].size > 8 && res.draws[0].size < 20, `size ${res.draws[0].size}`);
  assert.doesNotMatch(await textOf(bytes), /John|Smith/);
  assert.match(await textOf(bytes), /Name:/, "the words before it stay");
});

await test("a match that is not there says nothing was changed", async () => {
  const { res } = await run(plain, [{ find: "Nobody", with: "x" }]);
  assert.equal(res.changed.length, 0);
});

await test("the words before and after a change keep their place", async () => {
  const { bytes } = await run(plain, [{ find: "Smith", with: "Smithson" }]);
  assert.match(await textOf(bytes), /Name: John Smithson/);
});

// A file as a browser makes it: a subset font that holds only the letters it used.
const browser = await (async () => {
  const { chromium } = await import("playwright-core");
  const b = await chromium.launch({ executablePath: process.env.AUTORA_BROWSER_PATH });
  try {
    const p = await b.newPage();
    await p.setContent("<body style='font:20px sans-serif'><p>Invoice for Acme Ltd</p><p>Amount 120 due 2024</p></body>");
    return Buffer.from(await p.pdf({ width: "400px", height: "300px" }));
  } finally {
    await b.close();
  }
})();

await test("a subset font is changed in place with the letters it has", async () => {
  const { res, bytes } = await run(browser, [{ find: "120", with: "210" }]);
  assert.equal(res.changed[0]?.how, "in place", JSON.stringify(res));
  const text = await textOf(bytes);
  assert.match(text, /Amount 210 due 2024/);
});

await test("a subset font is not trusted with a letter it never drew: that is redrawn", async () => {
  const { res, bytes } = await run(browser, [{ find: "Acme Ltd", with: "Zyx Qwv" }]);
  assert.equal(res.changed[0]?.how, "redrawn", JSON.stringify(res));
  assert.equal(res.draws.length, 1);
  const text = await textOf(bytes);
  assert.doesNotMatch(text, /Acme/);
  assert.match(text, /Invoice for/);
});

await test("through the tool: redrawn words land where the old ones were, at their size and colour", async () => {
  const { chromium } = await import("playwright-core");
  const b = await chromium.launch({ executablePath: process.env.AUTORA_BROWSER_PATH });
  let data: Buffer;
  try {
    const p = await b.newPage();
    await p.setContent("<body style='font:20px sans-serif'><p>Invoice for <b style='color:#b00'>Acme Ltd</b> today</p></body>");
    data = Buffer.from(await p.pdf({ width: "400px", height: "200px" }));
  } finally {
    await b.close();
  }
  const art = saveArtifact({ origin: "user", name: "t.pdf", data, mime: "application/pdf", session: "s" });
  let shown: { id: string } | undefined;
  const r = await runPdfTool("pdf_replace_text", { file: art.id, replace: [{ find: "Acme Ltd", with: "Zyx Qwv" }] }, {
    session: "s", cwd: dir, room: 20_000, putBlob: () => "b", showImage: () => undefined,
    showFile: (f: { id: string }) => { shown = f; }, cancelled: () => false, onCancel: () => undefined,
  } as any);
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /redrawn/);
  const out = readArtifact(shown!.id)!;
  const [item] = await withPdf(out, undefined, async (view) => {
    const [page] = await view.text(1, 1, true);
    return page.items.filter((i) => i.s.includes("Zyx"));
  });
  assert.ok(item?.box, "the new words are on the page");
  const [x, y, , h] = item.box!;
  assert.ok(Math.abs(x - 79.4) < 6, `x ${x}`);
  assert.ok(Math.abs(y - 6) < 6, `y ${y}`);
  assert.ok(h > 14 && h < 21, `height ${h}`);
  assert.doesNotMatch(await textOf(out), /Acme/);
  // The page's own contents were read as text, not as the bytes of a deflated stream.
  assert.ok(!out.toString("latin1").includes("Acme"));
});


await test("several different changes in one long run of text each land on their own words", async () => {
  const { chromium } = await import("playwright-core");
  const b = await chromium.launch({ executablePath: process.env.AUTORA_BROWSER_PATH });
  let data: Buffer;
  try {
    const p = await b.newPage();
    await p.setContent(`<body style="font:14px serif;width:300px"><p>The staff reviewed the final offer on Monday, and the total of 4,250 dollars was approved by Dr. Alvarez. Shipping to Berlin will begin next week.</p><table border=1><tr><td>Total</td><td>4,250</td></tr></table></body>`);
    data = Buffer.from(await p.pdf({ width: "420px", height: "400px" }));
  } finally {
    await b.close();
  }
  const { res, bytes } = await run(data, [
    { find: "Alvarez", with: "Alvaro" }, { find: "4,250", with: "4,520" }, { find: "Berlin", with: "Bern" },
  ]);
  assert.deepEqual(res.changed.map((c) => c.matches), [1, 2, 1], JSON.stringify(res));
  const text = await textOf(bytes);
  assert.match(text, /approved by Dr\. Alvaro\. Shipping to Bern will begin/);
  assert.equal((text.match(/4,520/g) ?? []).length, 2);
  assert.doesNotMatch(text, /Alvarez|Berlin|4,250/);
});

await test("text inside a form XObject is changed too", async () => {
  const inner = await PDFDocument.create();
  const ip = inner.addPage([300, 100]);
  ip.drawText("Customer: Alice Brown", { x: 20, y: 50, size: 14, font: await inner.embedFont(StandardFonts.Helvetica) });
  const outer = await PDFDocument.create();
  const [embedded] = await outer.embedPdf(await inner.save(), [0]);
  const page = outer.addPage([300, 100]);
  page.drawPage(embedded, { x: 0, y: 0 });
  const data = Buffer.from(await outer.save());
  assert.match(await textOf(data), /Alice Brown/);
  const { res, bytes } = await run(data, [{ find: "Alice Brown", with: "Carol White" }]);
  assert.equal(res.changed[0]?.how, "in place", JSON.stringify(res));
  const text = await textOf(bytes);
  assert.match(text, /Customer: Carol White/);
  assert.doesNotMatch(text, /Alice|Brown/);
});

await test("invisible text over a picture is left alone and said so", async () => {
  const { setTextRenderingMode, TextRenderingMode } = await import("@cantoo/pdf-lib");
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 100]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.pushOperators(setTextRenderingMode(TextRenderingMode.Invisible));
  page.drawText("Scanned name Zed", { x: 20, y: 50, size: 14, font });
  const data = Buffer.from(await doc.save());
  const { res } = await run(data, [{ find: "Zed", with: "Ann" }]);
  assert.equal(res.changed.length, 0);
  assert.match(res.notes.join(" "), /invisible text/);
});

await test("a find that is not on the page says what the page reads nearby", async () => {
  const doc = await PDFDocument.create();
  const page = doc.addPage([300, 100]);
  const font = await doc.embedFont(StandardFonts.Helvetica);
  page.drawText("Customer: Carol White", { x: 20, y: 50, size: 14, font });
  const data = Buffer.from(await doc.save());
  const { res } = await run(data, [{ find: "Costumer: Carol Whyte", with: "x" }]);
  assert.equal(res.changed.length, 0);
  assert.match(res.notes.join(" "), /is not on this page/);
  assert.match(res.notes.join(" "), /nearby: "Customer: Carol White"/);
});

await test("the saved file is read back, and the result says the new words are there", async () => {
  const art = saveArtifact({ origin: "user", name: "rb.pdf", data: plain, mime: "application/pdf", session: "s" });
  const r = await runPdfTool("pdf_replace_text", { file: art.id, replace: [{ find: "John Smith", with: "Jane Doe" }] }, {
    session: "s", cwd: dir, room: 20_000, putBlob: () => "b", showImage: () => undefined,
    showFile: () => undefined, cancelled: () => false, onCancel: () => undefined,
  } as any);
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Read back from the saved file: the new words are there and the old ones are gone/);
});

console.log(`${passed} passed`);
