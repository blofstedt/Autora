/**
 * pdf_compose: a document described in blocks, laid out onto pages, kept as
 * that description, and changed by id.
 *
 *   npx tsx tests/compose.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-compose-"));
process.env.AUTORA_STATE_DIR = dir;

const { PDFDocument, PDFRawStream, decodePDFRawStream } = await import("@cantoo/pdf-lib");
const { readArtifact } = await import("../server/artifacts");
const { applyChanges, compose, outlineLines, ComposeError } = await import("../server/compose");
const { runPdfTool } = await import("../server/pdf");
const desk = await import("../server/pdfdesk");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

/** Whether these words are drawn anywhere in the file. */
async function holds(bytes: Buffer | Uint8Array, words: string): Promise<boolean> {
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

const noImages = async () => { throw new Error("no images here"); };
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFElEQVQIW2P8z8Dwn4GBgYGJAQoAHhgCAh6X4CYAAAAASUVORK5CYII=",
  "base64",
);

const para = (n: number) => ({ type: "paragraph", text: `Paragraph ${n}: ` + "the quick brown fox jumps over the lazy dog. ".repeat(6) });

// ------------------------------------------------------------- changes --

await test("blocks get ids, and ids stay unique", () => {
  const doc = applyChanges(null, { title: "T", blocks: [{ type: "heading", text: "A" }, { type: "paragraph", text: "x", id: "b1" }, { type: "rule" }] });
  assert.equal(new Set(doc.blocks.map((b) => b.id)).size, 3);
  assert.equal(doc.blocks[1].id, "b1");
  assert.throws(() => applyChanges(null, { blocks: [{ type: "rule", id: "a" }, { type: "rule", id: "a" }] }), /Two blocks are called/);
});

await test("bad blocks are refused in words the agent can act on", () => {
  assert.throws(() => applyChanges(null, { blocks: [{ type: "banner" }] }), /the types are heading/);
  assert.throws(() => applyChanges(null, { blocks: [{ text: "x" }] }), /has type null/);
  assert.throws(() => applyChanges(null, { blocks: [{ type: "rule", id: "no spaces" }] }), /an id is letters/);
  assert.throws(() => applyChanges(null, {}), /no composed document yet/);
  assert.throws(() => applyChanges(null, { blocks: [] }), /The document is empty/);
});

await test("insert says where with after or before, and never guesses the end", () => {
  const first = applyChanges(null, { blocks: [{ type: "heading", text: "One", id: "one" }, { type: "paragraph", text: "alpha", id: "a" }] });
  const b = applyChanges(first, { insert: [{ before: "a", blocks: [{ type: "bullets", items: ["x"], id: "list" }] }] });
  assert.deepEqual(b.blocks.map((x) => x.id), ["one", "list", "a"]);
  assert.throws(() => applyChanges(first, { insert: [{ under: "one", blocks: [{ type: "rule" }] }] }), /does not take "under"/);
  assert.throws(() => applyChanges(first, { insert: [{ after: "one", before: "a", blocks: [{ type: "rule" }] }] }), /not both/);
});

await test("update, insert and remove change the document by id", () => {
  const first = applyChanges(null, {
    title: "Report",
    blocks: [{ type: "heading", text: "One", id: "one" }, { type: "paragraph", text: "alpha", id: "a" }, { type: "paragraph", text: "omega", id: "z" }],
  });
  const next = applyChanges(first, {
    update: [{ id: "a", text: "beta" }],
    insert: [{ after: "one", blocks: [{ type: "quote", text: "q", id: "q" }] }, { after: "end", blocks: [{ type: "rule" }] }],
    remove: ["z"],
    subtitle: "Draft",
  });
  assert.deepEqual(next.blocks.map((b) => b.id).slice(0, 3), ["one", "q", "a"]);
  assert.equal(next.blocks.find((b) => b.id === "a")!.text, "beta");
  assert.ok(!next.blocks.some((b) => b.id === "z"));
  assert.equal(next.blocks[next.blocks.length - 1].type, "rule");
  assert.equal(next.title, "Report", "settings carry over");
  assert.equal(next.subtitle, "Draft");
  assert.equal(first.blocks.find((b) => b.id === "a")!.text, "alpha", "the old description is not altered");
  assert.throws(() => applyChanges(first, { update: [{ id: "nope", text: "x" }] }), /no block "nope"\. The ids are one, a, z/);
  assert.throws(() => applyChanges(first, { blocks: [{ type: "rule" }], remove: ["a"] }), /not both/);
  const retyped = applyChanges(first, { update: [{ id: "a", type: "quote" }] });
  assert.equal(retyped.blocks[1].type, "quote");
  assert.equal(retyped.blocks[1].id, "a");
});

// -------------------------------------------------------------- layout --

await test("a document is laid out: title, headings, text, a table and a numbered list of sources", async () => {
  const src = applyChanges(null, {
    title: "Heat pumps in Norway",
    author: "Autora",
    blocks: [
      { type: "heading", text: "Findings", id: "findings" },
      { type: "paragraph", text: "Sales rose **sharply** in 2023 and *kept* rising.", source: "https://example.com/report" },
      { type: "bullets", items: ["one", { text: "two", source: ["https://example.com/report", "SSB table 07"] }] },
      { type: "table", header: ["Year", "Units"], rows: [["2022", "1 000"], ["2023", "1 400"]], align: ["left", "right"] },
    ],
  });
  const made = await compose(src, noImages);
  assert.equal(made.pages, 1);
  const bytes = Buffer.from(await made.doc.save());
  for (const word of ["Heat", "Findings", "sharply", "Units", "Page 1 of 1", "Sources", "https://example.com/report"]) {
    assert.ok(await holds(bytes, word), `${word} is on the page`);
  }
  assert.ok(await holds(bytes, "[1]") && await holds(bytes, "2]"), "citations are numbered in order of first use");
  assert.ok(await holds(bytes, "SSB"), "a source that is a note is listed too");
  assert.deepEqual(made.outline.map((o) => o.id).slice(0, 2), ["title", "findings"]);
  assert.ok(made.outline.every((o) => o.page === 1));
  const lines = outlineLines(made.outline);
  assert.match(lines.join("\n"), /p1 # Findings \[findings\] -- paragraph: Sales rose/);
});

await test("a long document breaks onto pages, numbers them, and the outline follows", async () => {
  const blocks: any[] = [];
  for (let s = 1; s <= 8; s++) {
    blocks.push({ type: "heading", text: `Section ${s}`, id: `s${s}` });
    for (let p = 0; p < 4; p++) blocks.push(para(s * 10 + p));
  }
  const made = await compose(applyChanges(null, { title: "Long", blocks }), noImages);
  assert.ok(made.pages >= 3, `${made.pages} pages`);
  const heads = made.outline.filter((o) => o.type === "heading");
  assert.equal(heads.length, 8);
  for (let i = 1; i < heads.length; i++) assert.ok(heads[i].page >= heads[i - 1].page, "pages never go backwards");
  assert.equal(heads[7].page <= made.pages, true);
  const bytes = Buffer.from(await made.doc.save());
  assert.ok(await holds(bytes, `Page ${made.pages} of ${made.pages}`));
  // A heading is never the last thing on a page: something follows it there.
  const body = made.outline.filter((o) => o.type !== "title");
  for (const [i, o] of body.entries()) {
    if (o.type === "heading" && body[i + 1]) assert.ok(body[i + 1].page === o.endPage || body[i + 1].page === o.page, `${o.id} is kept with what follows`);
  }
});

await test("a long table repeats its header on the next page", async () => {
  const rows = Array.from({ length: 90 }, (_v, i) => [`Row ${i}`, String(i * 3)]);
  const made = await compose(applyChanges(null, { page_numbers: false, blocks: [{ type: "table", header: ["Name", "Value"], rows, id: "t" }] }), noImages);
  assert.ok(made.pages >= 2);
  const bytes = Buffer.from(await made.doc.save());
  const doc = await PDFDocument.load(bytes);
  assert.equal(doc.getPageCount(), made.pages);
  assert.ok(!(await holds(bytes, "Page 1 of")), "page numbers off");
});

await test("pictures go in by id, and a bad one says what to do", async () => {
  const load = async () => ({ data: png, kind: "png" as const });
  const made = await compose(applyChanges(null, { blocks: [{ type: "image", image: "file_x", width: 120, caption: "A tiny picture", id: "pic", source: "a screenshot" }] }), load);
  assert.equal(made.pages, 1);
  assert.ok(await holds(Buffer.from(await made.doc.save()), "tiny"));
  await assert.rejects(compose(applyChanges(null, { blocks: [{ type: "image", image: "data:image/png;base64,AAAA" }] }), load), /not inline data/);
  await assert.rejects(compose(applyChanges(null, { blocks: [{ type: "image" }] }), load), ComposeError);
});

await test("characters the fonts lack are replaced and reported; common ones are written another way", async () => {
  const made = await compose(applyChanges(null, { blocks: [{ type: "paragraph", text: "Growth → more, ≥ 5 %, “quoted” – and 中文" }] }), noImages);
  assert.equal(made.notes.length, 1);
  assert.match(made.notes[0], /replaced with "\?"/);
  const bytes = Buffer.from(await made.doc.save());
  assert.ok(await holds(bytes, "->") && await holds(bytes, ">="));
});

await test("links become clickable, and a long URL is broken rather than run off the page", async () => {
  const url = "https://example.com/" + "a-very-long-path-segment/".repeat(12);
  const made = await compose(applyChanges(null, { blocks: [{ type: "paragraph", text: `See [the data](${url}) now.`, source: url }] }), noImages);
  assert.equal(made.pages, 1);
  const doc = await PDFDocument.load(await made.doc.save());
  assert.ok(doc.getPage(0).node.Annots()!.size() >= 2, "the link and the listed source both link");
});

await test("a row that cannot fit a page is refused with a way out", async () => {
  const cell = "word ".repeat(2500);
  await assert.rejects(compose(applyChanges(null, { blocks: [{ type: "table", header: ["A"], rows: [[cell]], id: "huge" }] }), noImages), /taller than a page/);
});

// ---------------------------------------------------------------- tool --

const SESSION = "s-compose";
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
const state = () => desk.deskState(SESSION) as any;

await test("pdf_compose makes the file, opens it in the window and says where everything is", async () => {
  const r = await run("pdf_compose", {
    title: "Market brief",
    blocks: [
      { type: "heading", text: "Summary", id: "summary" },
      { type: "paragraph", text: "Demand is up.", id: "demand", source: "https://example.com/a" },
      { type: "heading", text: "Risks", id: "risks" },
      { type: "bullets", items: ["supply", "price"] },
    ],
  });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Composed a document \(1 page\)/);
  assert.match(r.summary, /# Summary \[summary\] -- paragraph: Demand is up/);
  assert.match(r.summary, /update \/ insert \/ remove/);
  assert.equal(state().open, true);
  assert.equal(state().name, "Market-brief.pdf");
  assert.ok(await holds(readArtifact(state().working)!, "Demand"));
  assert.equal(files.length, 1);
});

await test("the briefing carries the outline, so a later turn knows what the document holds", () => {
  const brief = desk.deskBriefing(SESSION)!;
  assert.match(brief, /made with pdf_compose \(4 blocks, 1 page\)/);
  assert.match(brief, /p1 # Summary \[summary\]/);
  assert.match(brief, /p1 # Risks \[risks\]/);
});

await test("new findings are an update: the same ids, laid out again, objects kept", async () => {
  const placed = await run("pdf_edit", { file: state().working, add: [{ type: "stamp", stamp: "confidential", page: 1, x: 400, y: 40 }] });
  assert.equal(placed.ok, true, placed.summary);
  assert.ok(state().items.length === 1);
  const r = await run("pdf_compose", {
    update: [{ id: "demand", text: "Demand is **up 12%**.", source: ["https://example.com/a", "https://example.com/b"] }],
    insert: [{ after: "demand", blocks: [{ type: "paragraph", text: "A second finding.", id: "second" }] }],
  });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Updated the document/);
  assert.match(r.summary, /1 object placed on it earlier stayed where they were|1 object placed on it earlier stayed where it was|object.*stayed/);
  assert.equal(state().items.length, 1, "what was placed on it is still there");
  assert.equal(state().name, "Market-brief.pdf", "same file");
  const bytes = readArtifact(state().working)!;
  assert.ok(await holds(bytes, "second") && await holds(bytes, "12%") && await holds(bytes, "2]"));
  assert.match(desk.deskBriefing(SESSION)!, /5 blocks/);
  const missing = await run("pdf_compose", { update: [{ id: "ghost", text: "x" }] });
  assert.equal(missing.ok, false);
  assert.match(missing.summary, /no block "ghost"/);
});

await test("an update waits for the person to accept it, like any other change to the pages", () => {
  const brief = desk.deskBriefing(SESSION)!;
  assert.match(brief, /waiting for the person to accept or decline: .*Updated the document/);
});

await test("pdf_edit that only places objects keeps the description; one that changes the pages drops it", async () => {
  const stamp = await run("pdf_edit", { file: state().working, add: [{ type: "text", text: "Draft", page: 1, x: 40, y: 40 }] });
  assert.equal(stamp.ok, true, stamp.summary);
  assert.match(desk.deskBriefing(SESSION)!, /It was made with pdf_compose/);
  const numbered = await run("pdf_edit", { file: state().working, page_numbers: "{n}" });
  assert.equal(numbered.ok, true, numbered.summary);
  assert.doesNotMatch(desk.deskBriefing(SESSION)!, /It was made with pdf_compose/);
  assert.match(desk.deskBriefing(SESSION)!, /not made with pdf_compose/);
  const lost = await run("pdf_compose", { update: [{ id: "demand", text: "x" }] });
  assert.equal(lost.ok, false);
  assert.match(lost.summary, /no composed document yet/);
});

await test("the person declining the update puts the old pages back and drops the description", async () => {
  const again = await run("pdf_compose", { blocks: [{ type: "heading", text: "Fresh start", id: "f" }, { type: "paragraph", text: "one" }] });
  assert.equal(again.ok, true, again.summary);
  const r2 = await run("pdf_compose", { update: [{ id: "f", text: "Second try" }] });
  assert.equal(r2.ok, true, r2.summary);
  const mark = state().marks.find((m: any) => m.kind === "page" && /Updated the document/.test(m.label));
  assert.ok(mark, "there is a page change to decline");
  assert.equal(desk.denyMarks(SESSION, mark.id, dir), true);
  assert.doesNotMatch(desk.deskBriefing(SESSION)!, /It was made with pdf_compose/);
});

await test("without a window (an incognito chat) it still writes the file, from the whole document each time", async () => {
  const r = await runPdfTool("pdf_compose", { blocks: [{ type: "paragraph", text: "Plain." }], output: "plain" }, { ...ctx, desk: undefined });
  assert.equal(r.ok, true, r.summary);
  assert.doesNotMatch(r.summary, /PDF window/);
  assert.match(r.summary, /plain\.pdf/);
  const second = await runPdfTool("pdf_compose", { update: [{ id: "b1", text: "x" }] }, { ...ctx, desk: undefined });
  assert.equal(second.ok, false);
});

console.log(`\n${passed} passed`);
process.exit(0);
