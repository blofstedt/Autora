/**
 * The Office tools, on real documents: a Word file made, read, changed and
 * checked; a workbook with formulas that really calculate; a deck read by its
 * element ids and fixed through them. The real engines run, as a child process,
 * so this needs the build (`node scripts/build-office.mjs`); without it the
 * tests say so and pass, as the tools are not offered then either.
 *
 *   npx tsx tests/office.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-office-test-"));
const office = await import("../server/office");
const artifacts = await import("../server/artifacts");
const modes = await import("../server/modes");
const toolload = await import("../server/toolload");
const render = await import("../server/officerender");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const shown: { id: string; name: string }[] = [];
const pictures: { alt: string; caption: string | null }[] = [];
const opened: { name: string; working: string | null }[] = [];
const ctx = {
  session: "s-test",
  cwd: os.tmpdir(),
  room: 12_000,
  showFile: (f: { id: string; name: string }) => { shown.push(f); },
  putBlob: () => "blob",
  showImage: (_blob: string, alt: string, caption: string | null) => { pictures.push({ alt, caption }); },
  // The PDF window, as far as these tools use it.
  desk: {
    current: () => null,
    open: (next: { name: string; working: string | null }) => { opened.push({ name: next.name, working: next.working }); },
    show: () => undefined,
    news: () => "",
  } as any,
  cancelled: () => false,
  onCancel: () => undefined,
};
const run = (name: string, args: Record<string, any>) => office.runOfficeTool(name, args, ctx);

console.log("office tools");

await test("the Tools page can switch them off, and they are then not offered", async () => {
  const tools = await import("../server/tools");
  const on = tools.toolSettings();
  assert.equal(tools.windowOff("office_read", on), false);
  assert.equal(tools.windowOff("office_read", { ...on, office: { enabled: false } }), true);
  assert.equal(tools.windowOff("pdf_read", { ...on, office: { enabled: false } }), false, "the PDF tools are a switch of their own");
});

await test("they are registered, held in planning only where they change something, and loaded on demand", () => {
  const family = toolload.FAMILIES.find((f) => f.id === "office")!;
  for (const n of ["office_guide", "office_read", "office_edit", "office_check", "office_look", "office_pdf", "office_create", "office_convert"]) assert.ok(family.match(n), n);
  assert.ok(family.words.test("make me a PowerPoint deck") && family.words.test("fix report.docx") && family.words.test("the budget spreadsheet"));
  assert.ok(!family.words.test("what time is it"));
  assert.ok(modes.looksOnly("office_read") && modes.looksOnly("office_check") && modes.looksOnly("office_guide") && modes.looksOnly("office_look"));
  assert.ok(!modes.looksOnly("office_edit", {}) && modes.looksOnly("office_edit", { dry_run: true }));
  assert.ok(!modes.looksOnly("office_create", {}) && !modes.looksOnly("office_convert", {}));
});

if (!office.officeDir()) {
  console.log("  (not built: node scripts/build-office.mjs -- the rest is skipped)");
  console.log(`\n${passed} passed`);
  process.exit(0);
}

await test("the guide lists the operations, and asks for a domain it knows", async () => {
  const g = await run("office_guide", { domain: "docs" });
  assert.ok(g.ok && /findReplace/.test(g.summary), g.summary.slice(0, 200));
  assert.ok((await run("office_guide", { domain: "slides" })).ok);
  assert.equal((await run("office_guide", { domain: "nope" })).ok, false);
  assert.equal((await run("office_guide", { domain: "docs", topic: "../etc" })).ok, false);
});

let docId = "";
await test("a Word file is made from Markdown, saved as an artifact and shown in the thread", async () => {
  const r = await run("office_create", { type: "docx", name: "report", markdown: "# Quarterly report\n\nRevenue grew by twelve percent.\n\n- North\n- South\n" });
  assert.ok(r.ok, r.summary);
  const art = artifacts.listArtifacts().find((a) => a.name === "report.docx")!;
  assert.ok(art && art.origin === "agent" && art.size > 1000);
  assert.equal(shown.at(-1)?.id, art.id);
  docId = art.id;
});

await test("it reads back as blocks with the indexes edits aim at", async () => {
  const r = await run("office_read", { file: docId });
  assert.ok(r.ok, r.summary);
  assert.match(r.summary, /\[0\] heading h1: Quarterly report/);
  assert.match(r.summary, /Revenue grew by twelve percent/);
});

await test("an edit of the agent's own file updates it in place; a dry run writes nothing", async () => {
  const before = artifacts.listArtifacts().length;
  const ops = [{ op: "findReplace", find: "twelve percent", replace: "fourteen percent" }];
  const dry = await run("office_edit", { file: docId, ops, dry_run: true });
  assert.ok(dry.ok && /Dry run/.test(dry.summary), dry.summary);
  assert.equal(artifacts.listArtifacts().length, before);
  assert.match((await run("office_read", { file: docId })).summary, /twelve percent/, "still unchanged");
  const r = await run("office_edit", { file: docId, ops });
  assert.ok(r.ok && /Updated artifact/.test(r.summary), r.summary);
  assert.equal(artifacts.listArtifacts().length, before, "no second copy");
  assert.match((await run("office_read", { file: docId })).summary, /fourteen percent/);
});

await test("the person's own file is never overwritten: the edit lands beside it", async () => {
  const bytes = fs.readFileSync(artifactPathOf(docId));
  const mine = artifacts.saveArtifact({ origin: "user", name: "mine.docx", data: bytes, mime: "application/vnd.openxmlformats-officedocument.wordprocessingml.document" });
  const r = await run("office_edit", { file: mine.id, ops: [{ op: "findReplace", find: "fourteen", replace: "fifteen" }] });
  assert.ok(r.ok && /Saved as artifact/.test(r.summary) && /mine-edited\.docx/.test(r.summary), r.summary);
  assert.deepEqual(fs.readFileSync(artifactPathOf(mine.id)), bytes, "the original is byte for byte what it was");
});

await test("tracked changes are recorded when asked, and a Word file is checked", async () => {
  const r = await run("office_edit", { file: docId, ops: [{ op: "findReplace", find: "North", replace: "Nordic" }], track: true, author: "Autora" });
  assert.ok(r.ok, r.summary);
  const revs = await run("office_read", { file: docId, include: ["revisions"] });
  assert.match(revs.summary, /revisions/i);
  const c = await run("office_check", { file: docId });
  assert.ok(c.ok, c.summary);
});

await test("a bad operation is refused with the engine's reason, and nothing is saved", async () => {
  const before = artifacts.listArtifacts().length;
  const r = await run("office_edit", { file: docId, ops: [{ op: "noSuchOp" }] });
  assert.equal(r.ok, false);
  assert.match(r.summary, /noSuchOp|unknown/i);
  assert.equal(artifacts.listArtifacts().length, before);
  assert.equal((await run("office_edit", { file: docId, ops: "not json" })).ok, false);
  assert.equal((await run("office_edit", { file: docId })).ok, false);
});

await test("files that are not Office files, or are not there, are said so", async () => {
  const txt = artifacts.saveArtifact({ origin: "user", name: "notes.txt", data: Buffer.from("hi") });
  assert.match((await run("office_read", { file: txt.id })).summary, /not a Word, Excel or PowerPoint file/);
  assert.match((await run("office_read", { file: "file_0000000000000000" })).summary, /There is no document/);
});

await test("a PowerPoint deck is built from a spec, read by element id, edited through those ids and checked", async () => {
  const spec = { pages: [{ title: "Hello", type: "cover", background: "#0E1A2B", elements: [
    { type: "shape", shape: "rect", x: 80, y: 80, w: 600, h: 120, fill: "#1F3A5F", paragraphs: [{ align: "left", runs: [{ text: "Quarterly review", sizePt: 40, color: "#FFFFFF" }] }] },
  ] }] };
  const made = await run("office_create", { type: "pptx", name: "deck", spec });
  assert.ok(made.ok, made.summary);
  const deck = artifacts.listArtifacts().find((a) => a.name === "deck.pptx")!;
  const read = await run("office_read", { file: deck.id });
  assert.ok(read.ok, read.summary);
  const el = /(e_[0-9a-f]+) shape/.exec(read.summary)?.[1];
  assert.ok(el, read.summary);
  assert.match(read.summary, /Slide 0 \(s_1\)/);
  assert.match(read.summary, /"Quarterly review"/);
  const edit = await run("office_edit", {
    file: deck.id,
    ops: [{ op: "setText", target: { slide: 0, el }, paragraphs: [{ runs: [{ text: "Q3 review" }] }] }],
  });
  assert.ok(edit.ok, edit.summary);
  assert.match((await run("office_read", { file: deck.id })).summary, /"Q3 review"/);
  const audit = await run("office_check", { file: deck.id });
  assert.ok(audit.ok, audit.summary);
});

if (!office.sidecarPath()) {
  console.log("  (no spreadsheet engine built -- the Excel tests are skipped)");
} else {
  let bookId = "";
  await test("a workbook is made with formulas that really calculate, and read back with values and formulas", async () => {
    const r = await run("office_create", { type: "xlsx", name: "budget", rows: [["Item", "Qty", "Price", "Total"], ["Widget", 3, 4.5, "=B2*C2"], ["Gadget", 2, 10, "=B3*C3"]] });
    assert.ok(r.ok, r.summary);
    bookId = artifacts.listArtifacts().find((a) => a.name === "budget.xlsx")!.id;
    const read = await run("office_read", { file: bookId, range: "A1:D3" });
    assert.ok(read.ok, read.summary);
    assert.match(read.summary, /2: .*D=13\.5/);
    assert.match(read.summary, /3: .*D=20/);
    assert.match(read.summary, /formulas: .*D2=B2\*C2/);
  });

  await test("cells are changed and the dependent formulas follow", async () => {
    const r = await run("office_edit", { file: bookId, cells: [{ cell: "B2", value: 10 }, { cell: "A5", value: "Sum" }, { cell: "D5", formula: "=SUM(D2:D3)" }] });
    assert.ok(r.ok, r.summary);
    const read = await run("office_read", { file: bookId, range: "A1:D5" });
    assert.match(read.summary, /2: .*D=45/, read.summary);
    assert.match(read.summary, /5: .*D=65/, read.summary);
    const c = await run("office_check", { file: bookId });
    assert.ok(c.ok, c.summary);
  });

  await test("a sheet converts to CSV and back", async () => {
    const csv = await run("office_convert", { file: bookId, to: "csv" });
    assert.ok(csv.ok, csv.summary);
    const art = artifacts.listArtifacts().find((a) => a.name === "budget.csv")!;
    assert.match(fs.readFileSync(artifactPathOf(art.id), "utf8"), /Widget,10,4\.5,45/);
    const back = await run("office_convert", { file: art.id, to: "xlsx", output: "budget-again.xlsx" });
    assert.ok(back.ok, back.summary);
  });
}

await test("Word converts to Markdown and HTML, and other formats it cannot make are said so", async () => {
  const md = await run("office_convert", { file: docId, to: "md" });
  assert.ok(md.ok, md.summary);
  assert.match(fs.readFileSync(artifactPathOf(artifacts.listArtifacts().find((a) => a.name === "report.md")!.id), "utf8"), /# Quarterly report/);
  const odt = await run("office_convert", { file: docId, to: "odt" });
  assert.equal(odt.ok, false);
  assert.match(odt.summary, /converts to md or html/);
});

if (!render.editorBuilt("docs")) {
  console.log("  (the Word editor is not built -- the page and PDF tests are skipped)");
} else {
  await test("a Word document is drawn as pages, by the editor's own layout", async () => {
    const r = await run("office_look", { file: docId, pages: "1" });
    assert.ok(r.ok, r.summary);
    assert.equal(r.images?.length, 1, "the picture is in the result for the model");
    assert.match(r.summary, /report\.docx, page 1/);
    assert.equal(pictures.length, 1, "and in the conversation");
    assert.match(pictures[0].caption ?? "", /report\.docx · page 1 of \d+/);
  });

  await test("Word to PDF is a PDF artifact that opens in the PDF editor", async () => {
    const r = await run("office_pdf", { file: docId });
    assert.ok(r.ok, r.summary);
    const pdf = artifacts.listArtifacts().find((a) => a.name === "report.pdf")!;
    assert.ok(pdf && pdf.mime === "application/pdf");
    assert.equal(fs.readFileSync(artifactPathOf(pdf.id)).subarray(0, 5).toString(), "%PDF-");
    assert.deepEqual(opened.at(-1), { name: "report.pdf", working: pdf.id });
    // The same through convert.
    const again = await run("office_convert", { file: docId, to: "pdf", output: "second.pdf" });
    assert.ok(again.ok, again.summary);
    assert.equal(opened.at(-1)?.name, "second.pdf");
  });
}

if (!render.editorBuilt("slides")) {
  console.log("  (the PowerPoint editor is not built -- the deck page tests are skipped)");
} else {
  await test("a deck is drawn slide by slide, by the PowerPoint editor itself, and goes to the PDF editor as a PDF", async () => {
    const deck = artifacts.listArtifacts().find((a) => a.name === "deck.pptx")!;
    const r = await run("office_look", { file: deck.id, pages: "1" });
    assert.ok(r.ok, r.summary);
    assert.equal(r.images?.length, 1);
    assert.match(r.summary, /deck\.pptx, page 1/);
    const pdf = await run("office_pdf", { file: deck.id });
    assert.ok(pdf.ok, pdf.summary);
    assert.equal(opened.at(-1)?.name, "deck.pdf");
  });
}

if (!render.editorBuilt("sheets") || !office.sidecarPath()) {
  console.log("  (the Excel editor or its engine is not built -- the workbook page tests are skipped)");
} else {
  await test("a workbook is drawn as printed, with its formulas worked out", async () => {
    const book = artifacts.listArtifacts().find((a) => a.name === "budget.xlsx")!;
    const r = await run("office_look", { file: book.id, pages: "1" });
    assert.ok(r.ok, r.summary);
    assert.equal(r.images?.length, 1);
    const pdf = await run("office_pdf", { file: book.id });
    assert.ok(pdf.ok, pdf.summary);
    assert.equal(opened.at(-1)?.name, "budget.pdf");
  });
}

function artifactPathOf(id: string): string {
  return artifacts.artifactPath(id);
}

console.log(`\n${passed} passed`);
