/**
 * Editing a file without losing what the person saved meanwhile.
 *
 *   npx tsx tests/editfile.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { editFile, type EditDeps } from "../server/editfile";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const root = fs.mkdtempSync(path.join(os.tmpdir(), "autora-edit-"));
const own = path.join(root, ".autora-data");
fs.mkdirSync(own);
const write = (rel: string, text: string) => { fs.mkdirSync(path.dirname(path.join(root, rel)), { recursive: true }); fs.writeFileSync(path.join(root, rel), text); };
const read = (rel: string) => fs.readFileSync(path.join(root, rel), "utf8");
const deps = (over: Partial<EditDeps> = {}): EditDeps => ({ root, protect: [own], base: () => null, held: () => null, ...over });
const SRC = "const a = 1;\nconst b = 2;\nconst c = 3;\nconst d = 4;\nconst e = 5;\nconst f = 6;\n";

console.log("edit_file");

test("a replacement is made once, exactly, and the file says so", () => {
  write("a.js", SRC);
  const r = editFile({ path: "a.js", edits: [{ old: "const b = 2;", new: "const b = 20;" }] }, deps());
  assert.equal(r.ok, true, r.summary);
  assert.equal(read("a.js"), SRC.replace("const b = 2;", "const b = 20;"));
  assert.match(r.summary, /Edited a\.js \(1 edit\)/);
  assert.deepEqual(r.wrote, { path: "a.js", created: false });
});

test("text that is not there, or is in several places, is not guessed at", () => {
  write("b.js", "x = 1;\nx = 1;\nz = 2;\n");
  assert.match(editFile({ path: "b.js", edits: [{ old: "nothing", new: "y" }] }, deps()).summary, /not in the file/);
  const many = editFile({ path: "b.js", edits: [{ old: "x = 1;", new: "x = 9;" }] }, deps());
  assert.equal(many.ok, false);
  assert.match(many.summary, /in 2 places/);
  assert.equal(read("b.js"), "x = 1;\nx = 1;\nz = 2;\n", "nothing was written");
  assert.equal(editFile({ path: "b.js", edits: [{ old: "x = 1;", new: "x = 9;", all: true }] }, deps()).ok, true);
  assert.equal(read("b.js"), "x = 9;\nx = 9;\nz = 2;\n");
});

test("a new file is made, folders and all; an existing one is not replaced by accident", () => {
  assert.equal(editFile({ path: "deep/new/c.js", content: "hello\n" }, deps()).ok, true);
  assert.equal(read("deep/new/c.js"), "hello\n");
  const again = editFile({ path: "deep/new/c.js", content: "other\n" }, deps());
  assert.equal(again.ok, false);
  assert.match(again.summary, /already exists/);
  assert.equal(editFile({ path: "deep/new/c.js", content: "other\n", overwrite: true }, deps()).ok, true);
  assert.equal(read("deep/new/c.js"), "other\n");
});

test("when the person changed other lines since the agent looked, both changes are in the file", () => {
  write("m.js", SRC);
  const seen = SRC;
  // The person saves a change to line 5 after the agent last read the file.
  write("m.js", SRC.replace("const e = 5;", "const e = 'person';"));
  const r = editFile({ path: "m.js", edits: [{ old: "const b = 2;", new: "const b = 'agent';" }] }, deps({ base: () => seen }));
  assert.equal(r.ok, true, r.summary);
  assert.equal(read("m.js"), SRC.replace("const b = 2;", "const b = 'agent';").replace("const e = 5;", "const e = 'person';"));
  assert.match(r.summary, /Their changes .* are kept alongside yours/);
});

test("when the person changed the same line, nothing is written and the agent is told what they have", () => {
  write("n.js", SRC);
  write("n.js", SRC.replace("const c = 3;", "const c = 'PERSON';"));
  const r = editFile({ path: "n.js", edits: [{ old: "const c = 3;", new: "const c = 'AGENT';" }] }, deps({ base: () => SRC }));
  assert.equal(r.ok, false);
  assert.match(r.summary, /their change clashes with yours/);
  assert.match(r.summary, /they have:\s+"const c = 'PERSON';"/);
  assert.match(r.summary, /you wanted:\s+"const c = 'AGENT';"/);
  assert.equal(read("n.js"), SRC.replace("const c = 3;", "const c = 'PERSON';"), "their file is untouched");
});

test("an edit the agent made from the newer file is applied to it directly", () => {
  write("p.js", SRC);
  write("p.js", SRC.replace("const e = 5;", "const e = 'person';"));
  // The agent has already read the newer file and edits the line the person wrote.
  const r = editFile({ path: "p.js", edits: [{ old: "const e = 'person';", new: "const e = 'both';" }] }, deps({ base: () => SRC }));
  assert.equal(r.ok, true, r.summary);
  assert.equal(read("p.js"), SRC.replace("const e = 5;", "const e = 'both';"));
});

test("a file the person is working in is edited, with a warning to read it again", () => {
  write("h.js", SRC);
  const r = editFile({ path: "h.js", edits: [{ old: "const a = 1;", new: "const a = 0;" }] }, deps({ held: () => "working on it" }));
  assert.equal(r.ok, true);
  assert.match(r.summary, /read it again before your next change/);
});

test("Autora's own data, folders, binaries and big files are refused", () => {
  fs.writeFileSync(path.join(own, "settings.json"), "{}");
  assert.match(editFile({ path: ".autora-data/settings.json", edits: [{ old: "{}", new: "{1}" }] }, deps()).summary, /Autora's own data/);
  assert.match(editFile({ path: ".", content: "x" }, deps()).summary, /folder/);
  fs.writeFileSync(path.join(root, "bin.dat"), Buffer.from([1, 2, 0, 3]));
  assert.match(editFile({ path: "bin.dat", edits: [{ old: "a", new: "b" }] }, deps()).summary, /not a text file/);
  fs.writeFileSync(path.join(root, "big.txt"), "x".repeat(1024 * 1024 + 10));
  assert.match(editFile({ path: "big.txt", edits: [{ old: "x", new: "y" }] }, deps()).summary, /over 1 MB/);
});

test("a missing file, missing edits and an empty path are said plainly, with a pointer to the place", () => {
  assert.match(editFile({ path: "nope.js", edits: [{ old: "a", new: "b" }] }, deps()).summary, /There is no file nope\.js/);
  assert.match(editFile({ path: "a.js" }, deps()).summary, /Give edits/);
  assert.match(editFile({ path: " " }, deps()).summary, /Say which file/);
  write("q.js", "function start() {\n  return 1;\n}\n");
  const near = editFile({ path: "q.js", edits: [{ old: "function start () {", new: "x" }] }, deps());
  assert.match(near.summary, /Near it the file has:/);
});

test("the file's permissions survive the edit", () => {
  write("x.sh", "echo hi\n");
  fs.chmodSync(path.join(root, "x.sh"), 0o755);
  editFile({ path: "x.sh", edits: [{ old: "hi", new: "there" }] }, deps());
  assert.equal(fs.statSync(path.join(root, "x.sh")).mode & 0o777, 0o755);
  assert.deepEqual(fs.readdirSync(root).filter((f) => f.includes(".tmp")), [], "no temporary file is left");
});

fs.rmSync(root, { recursive: true, force: true });
console.log(`${passed} passed`);
