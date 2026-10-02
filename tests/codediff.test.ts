/**
 * What a command changed in the project, as lines.
 *
 *   npx tsx tests/codediff.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { diffLines, linesOf, MAX_TRACKED, Workspace } from "../server/codediff";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-diff-"));
const put = (rel: string, text: string) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
  // A write in the same millisecond as the last would look unchanged.
  const t = new Date(Date.now() + put.n++ * 1000);
  fs.utimesSync(path.join(dir, rel), t, t);
};
put.n = 1;

console.log("code diff");

test("lines are split without the newline that ends the file", () => {
  assert.deepEqual(linesOf("a\nb\n"), ["a", "b"]);
  assert.deepEqual(linesOf("a\r\nb"), ["a", "b"]);
  assert.deepEqual(linesOf(""), [""]);
});

test("a diff keeps what is shared and marks what moved", () => {
  const ops = diffLines(["a", "b", "c", "d"], ["a", "x", "c", "d", "e"]);
  assert.deepEqual(ops.map((o) => o.t + o.s), [" a", "-b", "+x", " c", " d", "+e"]);
  assert.deepEqual(diffLines([], ["a"]).map((o) => o.t), ["+"]);
  assert.deepEqual(diffLines(["a"], []).map((o) => o.t), ["-"]);
});

test("a huge middle becomes one block out and one in, instead of a table that big", () => {
  const a = Array.from({ length: 1500 }, (_, i) => `a${i}`);
  const b = Array.from({ length: 1500 }, (_, i) => `b${i}`);
  const ops = diffLines(a, b);
  assert.equal(ops.filter((o) => o.t === "-").length, 1500);
  assert.equal(ops.filter((o) => o.t === "+").length, 1500);
});

test("the first scan is a baseline and says nothing; later ones say what changed", () => {
  put("index.html", "<h1>Hello</h1>\n<p>One</p>\n");
  put("src/app.js", "const a = 1;\nconst b = 2;\nconsole.log(a + b);\n");
  const ws = new Workspace(dir);
  assert.deepEqual(ws.scan(), []);
  assert.deepEqual(ws.scan(), [], "nothing changed since");

  put("src/app.js", "const a = 1;\nconst b = 3;\nconst c = 4;\nconsole.log(a + b + c);\n");
  put("src/new.js", "export const x = 1;\nexport const y = 2;\n");
  fs.rmSync(path.join(dir, "index.html"));
  const changes = ws.scan();
  assert.deepEqual(changes.map((c) => [c.path, c.kind]), [["src/new.js", "added"], ["src/app.js", "changed"], ["index.html", "removed"]]);
  const added = changes[0];
  assert.deepEqual([added.added, added.lines.map((l) => l.s)], [2, ["export const x = 1;", "export const y = 2;"]]);
  const edited = changes[1];
  assert.deepEqual([edited.added, edited.removed], [3, 2]);
  assert.deepEqual(edited.lines.filter((l) => l.t !== " ").map((l) => l.t + l.s), ["-const b = 2;", "-console.log(a + b);", "+const b = 3;", "+const c = 4;", "+console.log(a + b + c);"]);
  assert.equal(edited.lines.find((l) => l.t === "+" && l.s === "const c = 4;")!.n, 3, "new lines are numbered in the new file");
  assert.equal(changes[2].removed, 2);
});

test("only the changed lines and a little around them are kept", () => {
  const body = Array.from({ length: 100 }, (_, i) => `line ${i + 1}`);
  put("big.txt", body.join("\n") + "\n");
  const ws = new Workspace(dir);
  ws.prime();
  put("big.txt", body.map((l, i) => (i === 50 ? "CHANGED" : l)).join("\n") + "\n");
  const [c] = ws.scan();
  assert.deepEqual(c.lines.map((l) => l.t + l.s), [" line 49", " line 50", "-line 51", "+CHANGED", " line 52", " line 53"]);
});

test("a gap between two edits is marked, not filled", () => {
  const body = Array.from({ length: 60 }, (_, i) => `row ${i + 1}`);
  put("gap.txt", body.join("\n") + "\n");
  const ws = new Workspace(dir);
  ws.prime();
  put("gap.txt", body.map((l, i) => (i === 5 || i === 50 ? l.toUpperCase() : l)).join("\n") + "\n");
  const [c] = ws.scan();
  assert.ok(c.lines.some((l) => l.t === "~"));
  assert.equal(c.added, 2);
});

test("lock files, environment files and the usual output folders are not shown", () => {
  const ws = new Workspace(dir);
  ws.prime();
  put("package-lock.json", '{"a":1}\n');
  put(".env", "SECRET=abc\n");
  put("node_modules/x/index.js", "x\n");
  put("dist/out.js", "x\n");
  const changes = ws.scan();
  assert.deepEqual(changes.map((c) => c.path), ["package-lock.json"]);
  assert.equal(changes[0].quiet, "generated or lock file");
  assert.deepEqual(changes[0].lines, []);
});

test("a folder with too many files is not followed", () => {
  const big = fs.mkdtempSync(path.join(os.tmpdir(), "autora-many-"));
  for (let i = 0; i < MAX_TRACKED + 5; i += 1) fs.writeFileSync(path.join(big, `f${i}.txt`), "x");
  const ws = new Workspace(big);
  assert.deepEqual(ws.scan(), []);
  assert.equal(ws.tooMany, true);
  fs.rmSync(big, { recursive: true, force: true });
});

test("a binary file is said to have changed and is not read", () => {
  const ws = new Workspace(dir);
  ws.prime();
  fs.writeFileSync(path.join(dir, "pic.bin"), Buffer.from([1, 2, 0, 3, 4]));
  const t = new Date(Date.now() + 99_000);
  fs.utimesSync(path.join(dir, "pic.bin"), t, t);
  const [c] = ws.scan();
  assert.deepEqual([c.path, c.kind, c.quiet], ["pic.bin", "added", "not text"]);
});

fs.rmSync(dir, { recursive: true, force: true });
test("a folder that is skipped is not looked in", () => {
  put("own/state.json", "{}\n");
  const ws = new Workspace(dir, [path.join(dir, "own")]);
  ws.prime();
  put("own/state.json", '{"a":1}\n');
  put("mine.txt", "x\n");
  assert.deepEqual(ws.scan().map((c) => c.path), ["mine.txt"]);
});

console.log(`${passed} passed`);
