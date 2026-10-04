/**
 * Saying what is nearby when a name is a little off.
 *
 *   npx tsx tests/hints.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { didYouMean, likeness, missingPathIn, nearest, nearestPaths, pathHint, similarText } from "../server/hints";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "hints-"));
for (const f of ["src/lib/userStore.ts", "src/components/Button.tsx", "docs/README.md", "node_modules/x/userStore.ts", ".env"]) {
  fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
  fs.writeFileSync(path.join(dir, f), "x");
}

console.log("hints");

test("likeness ignores case, spaces and separators", () => {
  assert.equal(likeness("user_store", "UserStore"), 1);
  assert.ok(likeness("button.tsx", "Buton.tsx") > 0.7);
  assert.ok(likeness("abc", "xyz") < 0.2);
});

test("a file in the wrong folder is found by its name", () => {
  assert.deepEqual(nearestPaths(dir, "src/userStore.ts"), ["src/lib/userStore.ts"]);
  assert.match(pathHint(dir, "lib/userstore.ts"), /Nearby: src\/lib\/userStore\.ts/);
});

test("a misspelt name is found, and node_modules and .env are not offered", () => {
  const near = nearestPaths(dir, "src/components/Buton.tsx");
  assert.equal(near[0], "src/components/Button.tsx");
  assert.ok(!near.some((n) => /node_modules|\.env/.test(n)));
  assert.equal(pathHint(dir, "zzzzzzzz.qq"), "");
});

test("the missing path is read out of the shell's own words", () => {
  assert.equal(missingPathIn("cat: src/userStore.ts: No such file or directory"), "src/userStore.ts");
  assert.equal(missingPathIn("ls: cannot access 'docs/readme.md': No such file or directory"), "docs/readme.md");
  assert.equal(missingPathIn("python: can't open file 'run.py': [Errno 2]"), "run.py");
  assert.equal(missingPathIn("cat: can't open 'userStore.ts': No such file or directory"), "userStore.ts");
  assert.equal(missingPathIn("cat: can't open 'hint-lib/userStore.ts': No such file or directory"), "hint-lib/userStore.ts");
  assert.equal(missingPathIn("everything is fine"), null);
});

test("nearest text and options", () => {
  assert.deepEqual(nearest(["Submit", "Cancel", "Sign in"], "Submitt", 1), ["Submit"]);
  assert.match(didYouMean(["Sign in", "Sign up"], "signin"), /Did you mean "Sign in"/);
  assert.equal(didYouMean(["a"], "zzzz"), "");
});

test("a page's words are compared by window, so a long line still matches", () => {
  const page = ["Invoice total: 1,240.00 EUR", "Customer: Carol White", "Thank you for your business and see you again soon"];
  assert.equal(similarText(page, "Costumer Carol Whyte")[0], "Customer: Carol White");
  assert.deepEqual(similarText(page, "qqqq wwww"), []);
});

fs.rmSync(dir, { recursive: true, force: true });
console.log(`${passed} passed`);
