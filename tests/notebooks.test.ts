/**
 * Notebooks: grouping artifacts by purpose, what the agent and a chat are
 * told about one, and that retention never takes a filed file.
 *
 *   npx tsx tests/notebooks.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-notebooks-"));

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const nb = await import("../server/notebooks");
const { saveArtifact, getArtifact } = await import("../server/artifacts");
const { notebookNote, notebookRefs } = await import("../server/attach");
const { prune } = await import("../server/retention");
const { windowOff } = await import("../server/tools");
const { defaultTools, mergeTools } = await import("../server/state");

const email = saveArtifact({ origin: "user", name: "email-03-14.eml", data: Buffer.from("From: a\n\nWe never agreed.") });
const contract = saveArtifact({ origin: "user", name: "Contract.pdf", data: Buffer.from("%PDF-1.4 fake"), mime: "application/pdf" });
const shot = saveArtifact({ origin: "agent", name: "invoice.png", data: Buffer.from("png"), mime: "image/png" });
const loose = saveArtifact({ origin: "agent", name: "scratch.txt", data: Buffer.from("x") });

test("a notebook needs a title, and is found by id or by title in any case", () => {
  assert.throws(() => nb.createNotebook({ title: "  ", by: "user" }), /needs a title/);
  const book = nb.createNotebook({ title: "Dispute with Acme", purpose: "Refute the contract claims", by: "agent" });
  assert.match(book.id, /^nb_[0-9a-f]{12}$/);
  assert.equal(nb.findNotebook(book.id)?.id, book.id);
  assert.equal(nb.findNotebook("dispute WITH acme")?.id, book.id);
  assert.equal(nb.findNotebook("nope"), null);
  assert.equal(nb.listNotebooks()[0].id, book.id);
});

test("files go in by id or name, unknown ones are reported, and a file is not filed twice", () => {
  const book = nb.findNotebook("Dispute with Acme")!;
  const r = nb.addEntries(book.id, [
    { artifact: email.id, text: "Shows no agreement on 14 March." },
    { artifact: "contract.PDF" },
    { artifact: "missing.doc" },
  ], "agent");
  assert.equal(r.added.length, 2);
  assert.deepEqual(r.unknown, ["missing.doc"]);
  assert.equal(r.notebook.entries[1].artifact, contract.id);
  const again = nb.addEntries(book.id, [{ artifact: email.id, text: "Better annotation." }], "agent");
  assert.equal(again.added.length, 0);
  assert.equal(again.updated.length, 1);
  assert.equal(nb.getNotebook(book.id)!.entries.filter((e) => e.artifact === email.id).length, 1);
  assert.equal(nb.getNotebook(book.id)!.entries[0].text, "Better annotation.");
});

test("a note cites the files it rests on, and can be placed, edited, moved and removed", () => {
  const book = nb.findNotebook("Dispute with Acme")!;
  const r = nb.addEntries(book.id, [{ title: "Claim 1 is false", text: "Clause 4 says **30 days**.", cites: [contract.id, "email-03-14.eml"] }], "agent", 1);
  const note = r.added[0];
  assert.equal(nb.getNotebook(book.id)!.entries[0].id, note.id);
  assert.deepEqual(note.cites, [contract.id, email.id]);
  nb.updateEntry(book.id, note.id, { text: "Clause 4 says 30 days, not 10." });
  assert.equal(nb.getNotebook(book.id)!.entries[0].text, "Clause 4 says 30 days, not 10.");
  assert.throws(() => nb.updateEntry(book.id, note.id, { title: "", text: "" }), /needs a title or some text/);
  nb.moveEntry(book.id, note.id, 99);
  const entries = nb.getNotebook(book.id)!.entries;
  assert.equal(entries[entries.length - 1].id, note.id);
  const blank = nb.addEntries(book.id, [{ title: " ", text: "" }], "user");
  assert.equal(blank.added.length, 0);
});

test("the agent reads every entry with its id; a chat gets an index with the way to read the rest", () => {
  const book = nb.findNotebook("Dispute with Acme")!;
  const text = nb.describeNotebook(book);
  for (const e of book.entries) assert.ok(text.includes(e.id), e.id);
  assert.match(text, /Purpose: Refute the contract claims/);
  assert.match(text, /Contract\.pdf/);
  const refs = notebookRefs([book.id, "nb_000000000000", book.id]);
  assert.deepEqual(refs, [{ id: book.id, title: book.title }]);
  const note = notebookNote(refs);
  assert.match(note, /a notebook is attached/);
  assert.match(note, /notebook read/);
  assert.match(notebookNote(notebookRefs([{ id: "nb_gone", title: "Old" }], true)), /since been deleted/);
});

test("export is one document: notes in order, files as numbered exhibits", () => {
  const md = nb.notebookMarkdown(nb.findNotebook("Dispute with Acme")!);
  assert.match(md, /^# Dispute with Acme/);
  assert.match(md, /### Exhibit 1: email-03-14\.eml/);
  assert.match(md, /## Claim 1 is false/);
  assert.match(md, /Supporting: Exhibit 2 \(Contract\.pdf\), Exhibit 1 \(email-03-14\.eml\)/);
  assert.match(md, /## Exhibits/);
});

test("retention keeps what a notebook holds or cites, and a deleted file leaves every notebook", () => {
  const other = nb.createNotebook({ title: "Screens", by: "user" });
  nb.addEntries(other.id, [{ title: "See", text: "x", cites: [shot.id] }], "user");
  const result = prune({ sessionDays: 0, keepSessions: 0, artifactDays: 0, keepArtifacts: 0 });
  assert.deepEqual(result.artifacts.ids, [loose.id]);
  for (const kept of [email, contract, shot]) assert.ok(getArtifact(kept.id), kept.name);
  nb.forgetArtifact(email.id);
  const book = nb.findNotebook("Dispute with Acme")!;
  assert.ok(!book.entries.some((e) => e.artifact === email.id || e.cites?.includes(email.id)));
  assert.ok(!nb.notebookArtifacts().has(email.id));
});

test("deleting a notebook leaves its files", () => {
  const book = nb.findNotebook("Screens")!;
  assert.equal(nb.deleteNotebook(book.id), true);
  assert.equal(nb.deleteNotebook(book.id), false);
  assert.ok(getArtifact(shot.id));
});

test("the Tools page's windows are on by default, and switching one off takes its tools away", () => {
  const settings = defaultTools();
  for (const name of ["widget_show", "app_preview", "pdf_read", "pdf_edit", "notebook", "browser_open"]) {
    assert.equal(windowOff(name, settings), false, name);
  }
  mergeTools(settings, { widgets: { enabled: false }, app: { enabled: "no" }, pdf: { enabled: false } });
  assert.equal(windowOff("widget_show", settings), true);
  assert.equal(windowOff("app_preview", settings), false, "a non-boolean leaves it as it was");
  assert.equal(windowOff("pdf_redact", settings), true);
  assert.equal(windowOff("notebook", settings), false);
  const fresh = mergeTools(defaultTools(), { terminal: { enabled: false } });
  assert.equal(fresh.widgets.enabled && fresh.app.enabled && fresh.pdf.enabled, true);
});

console.log(`\n${passed} notebooks cases passed.`);
