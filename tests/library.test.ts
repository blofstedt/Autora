/**
 * The library: sources added once, searched by plain code, answers that carry
 * where they came from.
 *
 *   npx tsx tests/library.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-library-"));
process.env.AUTORA_STATE_DIR = dir;
const linuxChrome = "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
if (!process.env.AUTORA_BROWSER_PATH && fs.existsSync(linuxChrome)) process.env.AUTORA_BROWSER_PATH = linuxChrome;

const { PDFDocument, StandardFonts } = await import("@cantoo/pdf-lib");
const { saveArtifact } = await import("../server/artifacts");
const lib = await import("../server/library");
const { rendererMissing } = await import("../server/pdfrender");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const work = fs.mkdtempSync(path.join(os.tmpdir(), "autora-library-files-"));
fs.mkdirSync(path.join(work, "notes"));
fs.writeFileSync(path.join(work, "notes", "lease.md"),
  "# Lease notes\n\nThe tenant pays rent on the first of each month.\n\nA late fee of 5 percent applies after ten days.\n\nThe landlord must return the security deposit within thirty days of move out.\n");
fs.writeFileSync(path.join(work, "notes", "recipes.txt"), "Pancakes need flour, eggs and milk.\n\nWhisk the batter until smooth, then rest it.\n");
fs.writeFileSync(path.join(work, "notes", "binary.bin"), Buffer.from([0, 1, 2, 3, 0, 0, 0]));
const run = (args: Record<string, any>) => lib.runLibrary({ cwd: work, args });

await test("an empty library says so", async () => {
  assert.match((await run({ action: "list" })).summary, /empty/);
  assert.match((await run({ action: "search", query: "rent" })).summary, /empty/);
});

await test("a folder is added file by file; binaries and repeats are not", async () => {
  const r = await run({ action: "add", path: "notes", tags: ["Home"] });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Added 2/);
  const again = await run({ action: "add", path: "notes" });
  assert.match(again.summary, /Already in the library/);
  assert.match((await run({ action: "list" })).summary, /2 sources/);
  assert.match((await run({ action: "list", tag: "home" })).summary, /lease\.md/);
});

await test("search ranks the passage that is about the question and cites its place", async () => {
  const r = await run({ action: "search", query: "when is the security deposit returned" });
  assert.equal(r.ok, true);
  const first = r.summary.split(/\n\n(?=\d+\. \[)/)[0];
  assert.match(first, /\[lease\.md, lines? \d+/);
  assert.match(first, /security deposit/);
  assert.doesNotMatch(first, /Pancakes/);
  const other = await run({ action: "search", query: "batter whisk" });
  assert.match(other.summary.split(/\n\n(?=\d+\. \[)/)[0], /recipes\.txt/);
});

await test("plurals match, the phrase wins, and a source can be searched alone", async () => {
  assert.match((await run({ action: "search", query: "late fees" })).summary, /late fee of 5 percent/);
  const only = await run({ action: "search", query: "flour", source: "lease.md" });
  assert.match(only.summary, /Nothing in the library matches/);
  assert.match((await run({ action: "search", query: "x", source: "nope" })).summary, /no source/);
});

await test("an unrelated question finds nothing rather than a guess", async () => {
  assert.match((await run({ action: "search", query: "quantum chromodynamics" })).summary, /Nothing in the library matches/);
});

await test("read gives a whole passage by its place", async () => {
  const hits = lib.searchLibrary("security deposit");
  const r = await run({ action: "read", source: "lease.md", loc: hits[0].loc });
  assert.match(r.summary, /thirty days/);
  assert.equal((await run({ action: "read", source: "lease.md", loc: "p.99" })).ok, false);
});

await test("an artifact and a web page can be added, and what is saved survives a restart", async () => {
  const art = saveArtifact({ origin: "user", name: "minutes.txt", data: Buffer.from("The board approved the budget for the new roof.\n") });
  assert.equal((await run({ action: "add", artifact: art.id })).ok, true);
  const r = await lib.runLibrary({
    cwd: work, args: { action: "add", url: "https://example.com/page" },
    fetchPage: async () => ({ name: "page.html", data: Buffer.from("<html><body><h1>Gardening</h1><p>Tomatoes need full sun and regular water.</p></body></html>") }),
  });
  assert.equal(r.ok, true, r.summary);
  lib.resetLibraryCache();
  assert.match((await run({ action: "search", query: "tomatoes sun" })).summary, /page\.html/);
  assert.match((await run({ action: "search", query: "roof budget" })).summary, /minutes\.txt/);
});

await test("a protected folder is never added, and a missing path says so", async () => {
  const r = await lib.runLibrary({ cwd: work, args: { action: "add", path: "notes" }, protect: [path.join(work, "notes")] });
  assert.equal(r.ok, false);
  assert.match(r.summary, /own data/);
  assert.match((await run({ action: "add", path: "nowhere" })).summary, /not there/);
  assert.match((await run({ action: "add" })).summary, /needs one of/);
});

await test("remove forgets a source and leaves the file alone", async () => {
  const r = await run({ action: "remove", source: "recipes.txt" });
  assert.equal(r.ok, true);
  assert.ok(fs.existsSync(path.join(work, "notes", "recipes.txt")));
  assert.match((await run({ action: "search", query: "batter whisk" })).summary, /Nothing in the library matches/);
});

await test("only search, list and read count as looking", () => {
  for (const action of ["search", "list", "read"]) assert.equal(lib.libraryReadOnly({ action }), true);
  for (const action of ["add", "remove", ""]) assert.equal(lib.libraryReadOnly({ action }), false);
});

if (await rendererMissing()) {
  console.log("  --  PDF pages: no browser here to read them with");
} else {
  await test("a PDF is read page by page, and a hit names its page", async () => {
    const doc = await PDFDocument.create();
    const font = await doc.embedFont(StandardFonts.Helvetica);
    for (const text of ["Cover page of the manual", "Installation: mount the bracket with four screws.", "Warranty covers parts for two years."]) {
      doc.addPage([400, 300]).drawText(text, { x: 20, y: 150, size: 12, font });
    }
    const art = saveArtifact({ origin: "user", name: "manual.pdf", data: Buffer.from(await doc.save()) });
    const add = await run({ action: "add", artifact: art.id });
    assert.equal(add.ok, true, add.summary);
    const r = await run({ action: "search", query: "how long is the warranty" });
    assert.match(r.summary.split(/\n\n(?=\d+\. \[)/)[0], /\[manual\.pdf, p\.3\]/);
  });
}

console.log(`\n${passed} library cases passed.`);
process.exit(0);
