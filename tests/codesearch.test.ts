/**
 * Searching a folder of code in plain code: exact, regex and ranked.
 *
 *   npx tsx tests/codesearch.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { globToRegExp, searchCode, words } from "../server/codesearch";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-search-"));
const put = (rel: string, text: string | Buffer) => {
  fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
  fs.writeFileSync(path.join(dir, rel), text);
};
put("src/users.ts", "export async function fetchUserById(id: string) {\n  return db.query('select * from users where id = ?', [id]);\n}\n");
put("src/billing.ts", "export function chargeCard(amount: number) {\n  return gateway.charge(amount);\n}\n" + "// filler\n".repeat(60) + "export function refund_payment_by_id(id: string) {}\n");
put("src/ui/Button.tsx", "export const Button = () => <button>Save</button>;\n");
put("README.md", "# Project\nThe billing module charges cards and issues refunds.\n");
put("node_modules/lib/index.js", "fetchUserById is also here but must never be searched\n");
put(".env", "SECRET_TOKEN=abc123 fetchUserById\n");
put("logo.png", Buffer.from([137, 80, 78, 71, 0, 0, 0, 1, 102, 101, 116, 99, 104, 85, 115, 101, 114]));

console.log("code search");

test("identifiers are split into their words", () => {
  assert.deepEqual(words("fetchUserById"), ["fetchuserbyid", "fetch", "user", "by", "id"]);
  assert.ok(words("refund_payment_by_id").includes("payment"));
  assert.ok(words("HTTPServerError").includes("server"));
});

test("globs match at any depth when they name no folder", () => {
  assert.ok(globToRegExp("*.ts").test("src/users.ts"));
  assert.ok(!globToRegExp("*.ts").test("src/users.tsx"));
  assert.ok(globToRegExp("src/**/*.tsx").test("src/ui/Button.tsx"));
  assert.ok(!globToRegExp("src/*.tsx").test("src/ui/Button.tsx"));
});

test("exact finds the lines, with their numbers, and skips node_modules, secrets and binaries", () => {
  const r = searchCode({ root: dir, query: "fetchUserById", mode: "exact" });
  assert.equal(r.ok, true);
  assert.match(r.text, /src\/users\.ts:1:/);
  assert.doesNotMatch(r.text, /node_modules/);
  assert.doesNotMatch(r.text, /\.env/);
  assert.doesNotMatch(r.text, /logo\.png/);
});

test("exact is case-insensitive unless asked, and a regex is a regex", () => {
  assert.match(searchCode({ root: dir, query: "FETCHUSERBYID", mode: "exact" }).text, /users\.ts/);
  assert.match(searchCode({ root: dir, query: "FETCHUSERBYID", mode: "exact", caseSensitive: true }).text, /No lines match/);
  assert.match(searchCode({ root: dir, query: "/charge\\w+\\(/", mode: "regex" }).text, /billing\.ts:1:/);
  assert.equal(searchCode({ root: dir, query: "(", mode: "regex" }).ok, false);
});

test("ranked finds a function by the words in its name", () => {
  const r = searchCode({ root: dir, query: "fetch user" });
  assert.match(r.text, /^Best matches/);
  assert.ok(r.text.indexOf("src/users.ts") > 0);
  assert.ok(r.text.indexOf("src/users.ts") < (r.text.indexOf("billing.ts") < 0 ? Infinity : r.text.indexOf("billing.ts")), "the user code ranks first");
  const refund = searchCode({ root: dir, query: "refund payment" });
  assert.match(refund.text, /billing\.ts:\d+-\d+/);
  assert.match(refund.text, /refund_payment_by_id/);
});

test("a glob narrows what is searched", () => {
  const r = searchCode({ root: dir, query: "export", mode: "exact", glob: "*.tsx" });
  assert.match(r.text, /Button\.tsx/);
  assert.doesNotMatch(r.text, /users\.ts/);
});

test("nothing matching is said, not an error", () => {
  const r = searchCode({ root: dir, query: "zzzqqq", mode: "exact" });
  assert.equal(r.ok, true);
  assert.match(r.text, /No lines match/);
  assert.match(searchCode({ root: dir, query: "zzzqqq" }).text, /Nothing ranks/);
});

test("a changed file is picked up on the next search", () => {
  put("src/new.ts", "export const brandNewThing = 1;\n");
  assert.match(searchCode({ root: dir, query: "brandNewThing", mode: "exact" }).text, /new\.ts/);
  fs.writeFileSync(path.join(dir, "src/new.ts"), "export const somethingElse = 2;\n");
  const r = searchCode({ root: dir, query: "brandNewThing", mode: "exact" });
  assert.match(r.text, /No lines match/);
});

test("a missing folder and an empty query are said plainly", () => {
  assert.match(searchCode({ root: path.join(dir, "nope"), query: "x" }).text, /no folder/);
  assert.match(searchCode({ root: dir, query: "  " }).text, /Say what to search for/);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed`);
