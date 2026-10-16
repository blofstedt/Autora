/**
 * Folders on the Artifacts page, one per project.
 *
 * A chat's files are in its own folder; another chat working on one of them
 * makes the two one project; a chat already in a folder stays there; and two
 * projects each saving report.md keep two reports instead of one overwriting
 * the other.
 *
 *   npx tsx tests/folders.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-folders-"));
process.env.AUTORA_STATE_DIR = dir;

const { saveArtifact, getArtifact, sameArtifact, moveArtifact } = await import("../server/artifacts");
const {
  chatTitles, folderOfChat, folderOfFile, getFolder, joinWork, createFolder, deleteFolder,
  reloadFolders, renameFolder,
} = await import("../server/folders");
const { joinProjects } = await import("../server/tools");

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const titles: Record<string, string> = { a: "My novel", b: "Novel, chapter two", c: "Taxes" };
chatTitles((id) => titles[id] ?? null);
const save = (name: string, session?: string, text = name) =>
  saveArtifact({ origin: "agent", name, data: Buffer.from(text), session });

test("a chat's files start in its own folder, with nothing written", () => {
  const draft = save("draft.md", "a");
  assert.equal(folderOfFile(draft), null);
  assert.equal(folderOfChat("a"), null);
});

test("another chat working on a file makes one project folder, named after the first chat", () => {
  const draft = sameArtifact("draft.md", "a")!;
  joinProjects("b", { file: draft.id });
  const folder = folderOfChat("b");
  assert.ok(folder);
  assert.equal(folderOfChat("a"), folder);
  assert.equal(getFolder(folder!)!.name, "My novel");
  assert.equal(folderOfFile(getArtifact(draft.id)!), folder);
});

test("what the second chat makes next goes in the same folder", () => {
  const next = save("chapter-2.md", "b");
  assert.equal(folderOfFile(next), folderOfChat("a"));
});

test("one name is one file inside a project, two files in two projects", () => {
  const first = save("report.md", "a", "one");
  const again = save("report.md", "b", "two");
  assert.equal(again.id, first.id, "the same project rewrites its report");
  const other = save("report.md", "c", "taxes");
  assert.notEqual(other.id, first.id, "another project keeps its own");
});

test("a chat already in a folder stays there", () => {
  joinWork("c", { session: "x" });
  const pinned = folderOfChat("c");
  assert.ok(pinned);
  assert.equal(getFolder(pinned!)!.name, "Taxes", "a chat with no title is named after this one");
  joinWork("c", { session: "a" });
  assert.equal(folderOfChat("c"), pinned);
});

test("an upload a chat works on becomes that chat's", () => {
  const up = saveArtifact({ origin: "user", name: "scan.pdf", data: Buffer.from("%PDF") });
  assert.equal(up.session, undefined);
  joinProjects("c", [up.id]);
  assert.equal(getArtifact(up.id)!.session, "c");
});

test("a file moved by hand, a renamed folder, and a removed one", () => {
  const f = createFolder("Misc");
  const loose = save("note.txt", "z");
  moveArtifact(loose.id, f.id);
  assert.equal(folderOfFile(getArtifact(loose.id)!), f.id);
  renameFolder(f.id, "  Odds\nand ends ");
  assert.equal(getFolder(f.id)!.name, "Odds and ends");
  deleteFolder(f.id);
  assert.equal(folderOfFile(getArtifact(loose.id)!), null, "back in its chat's folder");
});

test("the folders are read back from disk", () => {
  const before = folderOfChat("a");
  reloadFolders();
  assert.equal(folderOfChat("a"), before);
});

console.log(`folders: ${passed} passed`);
