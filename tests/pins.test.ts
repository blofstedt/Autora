/**
 * The editors Autora ships (GenOffice for Pages, Sheets and Slides; Spectra for PDF; OpenCut for Video;
 * GDevelop for Games) are Autora's own forks: each is fetched at one exact commit and made Autora's by its
 * overlay and patches, and the commit never moves to follow upstream. A pin that is a branch or a tag would
 * let a rebuild take whatever upstream has now, so every pin must be a full commit sha.
 *
 *   npx tsx tests/pins.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

for (const dir of ["office", "spectra", "opencut", "gdevelop"]) {
  const pin = JSON.parse(fs.readFileSync(`${dir}/PIN.json`, "utf8")) as { repo?: string; sha?: string };
  test(`${dir}/PIN.json names one exact commit`, () => {
    assert.match(pin.sha ?? "", /^[0-9a-f]{40}$/, "sha must be a full 40-character commit, never a branch or tag");
    assert.match(pin.repo ?? "", /^https:\/\/github\.com\/[\w.-]+\/[\w.-]+$/);
  });
}

test("the Office patches are plain git diffs", () => {
  const dir = "office/patches";
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    assert.match(name, /^\d{4}-[a-z0-9-]+\.patch$/, `${name}: patches are numbered, so they apply in order`);
    assert.match(fs.readFileSync(`${dir}/${name}`, "utf8"), /^diff --git a\/(apps|packages)\//, `${name}: not a git diff of GenOffice's tree`);
  }
});

console.log(`${passed} passed`);
