/**
 * Reading a part of a file, and knowing where a search hit lives.
 *
 *   npx tsx tests/readfile.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { declarations, enclosing, readFile } from "../server/readfile";
import { searchCode } from "../server/codesearch";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "readfile-"));
const put = (name: string, text: string) => { fs.mkdirSync(path.dirname(path.join(dir, name)), { recursive: true }); fs.writeFileSync(path.join(dir, name), text); };
const ts = [
  "import x from 'y';",
  "",
  "export interface User { id: string }",
  "",
  "export async function fetchUser(id: string) {",
  "  const res = await get(`/u/${id}`);",
  "  return res;",
  "}",
  "",
  "export class Store {",
  "  private items = new Map();",
  "  add(item: string) {",
  "    this.items.set(item, 1);",
  "  }",
  "  remove(item: string): boolean {",
  "    return this.items.delete(item);",
  "  }",
  "}",
  "",
  "export const slug = (s: string) => s.toLowerCase();",
  "",
].join("\n");
put("src/store.ts", ts);
put("notes.md", "# Title\n\ntext\n\n## Setup\n\nrun it\n\n## Usage\n\nuse it\n");
put("tool.py", "import os\n\nclass Tool:\n    def run(self):\n        return 1\n\ndef main():\n    pass\n");
put(".env", "SECRET=1\n");
put("bin.dat", "a\u0000b");
const read = (a: any) => readFile(a, { root: dir });

console.log("read_file");

test("a range comes back numbered, with how much more there is", () => {
  const r = read({ path: "src/store.ts", start: 5, end: 8 });
  assert.ok(r.ok);
  assert.match(r.text, /lines 5-8/);
  assert.match(r.text, /^5 {2}export async function fetchUser/m);
  assert.match(r.text, /more lines: read from 9/);
});

test("by default the head of the file, and a start past the end is refused", () => {
  assert.match(read({ path: "src/store.ts" }).text, /lines 1-20/);
  const bad = read({ path: "src/store.ts", start: 99 });
  assert.equal(bad.ok, false);
  assert.match(bad.text, /no line 99/);
});

test("an outline lists declarations and methods with their lines", () => {
  const r = read({ path: "src/store.ts", outline: true });
  assert.ok(r.ok);
  for (const want of [/ 3\s+interface User/, / 5\s+function fetchUser/, /10\s+class Store/, /12\s+method add/, /15\s+method remove/, /20\s+function slug/]) {
    assert.match(r.text, want);
  }
  assert.ok(!/method if/.test(r.text));
});

test("a symbol returns just its body", () => {
  const r = read({ path: "src/store.ts", symbol: "fetchUser" });
  assert.ok(r.ok);
  assert.match(r.text, /lines 5-8/);
  assert.ok(!/class Store/.test(r.text));
  const c = read({ path: "src/store.ts", symbol: "Store" });
  assert.match(c.text, /lines 10-18/);
  const m = read({ path: "src/store.ts", symbol: "remove" });
  assert.match(m.text, /lines 15-17/);
});

test("an unknown symbol names what is close", () => {
  const r = read({ path: "src/store.ts", symbol: "fetch" });
  assert.equal(r.ok, false);
  assert.match(r.text, /fetchUser \(line 5\)/);
});

test("python and markdown work by indentation and headings", () => {
  const py = read({ path: "tool.py", symbol: "Tool" });
  assert.match(py.text, /lines 3-5/);
  const md = read({ path: "notes.md", outline: true });
  assert.match(md.text, /# Title/);
  assert.match(md.text, /## Setup/);
  assert.match(read({ path: "notes.md", symbol: "Setup" }).text, /lines 5-7/);
});

test("secrets, binaries, folders and missing files are handled in words", () => {
  assert.match(read({ path: ".env" }).text, /secrets/);
  assert.match(read({ path: "bin.dat" }).text, /not a text file/);
  assert.match(read({ path: "src" }).text, /folder/);
  assert.match(read({ path: "nope.ts" }).text, /no file/);
  assert.equal(readFile({ path: "src/store.ts" }, { root: dir, protect: [path.join(dir, "src")] }).ok, false);
});

test("a search hit says what it is inside", () => {
  const ranked = searchCode({ root: dir, query: "items delete remove" });
  assert.match(ranked.text, /store\.ts:\d+-\d+ in method remove|store\.ts:\d+-\d+ in class Store|store\.ts:\d+-\d+ in method/);
  const exact = searchCode({ root: dir, query: "items.delete", mode: "exact" });
  assert.match(exact.text, /store\.ts:16: .*\[in method remove\]/);
  assert.match(exact.text, /read_file|1 line/);
});

test("enclosing finds the nearest declaration above", () => {
  const d = declarations(ts.split("\n"));
  assert.equal(enclosing(d, 6)?.name, "fetchUser");
  assert.equal(enclosing(d, 2), null);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed`);
