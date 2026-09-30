/**
 * Tools the agent saves for itself: what it may write them as, and that a
 * script reading an argument nobody declared is said, not silently empty.
 *
 *   npx tsx tests/customtools.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-customtools-"));
let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const { defineCustomTool, readParams, undeclaredArgs } = await import("../server/customtools");
const names = (raw: unknown) => readParams(raw).map((p) => p.name);

test("arguments are read from a list, a JSON Schema, a map, or bare names", () => {
  assert.deepEqual(names([{ name: "word", description: "a word" }, { name: "n" }]), ["word", "n"]);
  assert.deepEqual(names(["word", "count"]), ["word", "count"]);
  assert.deepEqual(names({ type: "object", properties: { word: { type: "string", description: "w" }, n: { type: "number" } }, required: ["word"] }), ["word", "n"]);
  assert.deepEqual(names({ word: "the word to shout", n: { description: "how many" } }), ["word", "n"]);
  assert.deepEqual(names(undefined), []);
  assert.deepEqual(names("nonsense"), []);
  assert.deepEqual(names(null), []);
});

test("a JSON Schema's required list decides which are required, and its own keys are not arguments", () => {
  const got = readParams({ type: "object", required: ["a"], properties: { a: { description: "x" }, b: {} } });
  assert.deepEqual(got.map((p) => [p.name, p.required]), [["a", true], ["b", false]]);
  assert.deepEqual(names({ type: "object", description: "shouts", required: [], additionalProperties: false }), []);
});

test("a tool saved with a schema keeps its arguments", () => {
  const { tool, warnings } = defineCustomTool({
    name: "shout", description: "Shout it.", script: 'echo "$ARG_WORD" | tr a-z A-Z',
    params: { type: "object", properties: { word: { type: "string" } }, required: ["word"] },
  });
  assert.deepEqual(tool.params.map((p) => [p.name, p.required]), [["word", true]]);
  assert.deepEqual(warnings, []);
});

test("a script that reads an argument nobody declared is warned about", () => {
  const { warnings } = defineCustomTool({ name: "oops", description: "x", script: 'echo "$ARG_WORD ${ARG_COUNT}"', params: [] });
  assert.equal(warnings.length, 1);
  assert.match(warnings[0], /\$ARG_WORD, \$ARG_COUNT|\$ARG_COUNT, \$ARG_WORD/);
  assert.match(warnings[0], /always be empty/);
  assert.deepEqual(undeclaredArgs('echo $ARG_A', [{ name: "a", description: "", required: true }]), []);
});

test("bad names still fail, with the reason", () => {
  assert.throws(() => defineCustomTool({ name: "x", description: "d", script: "s" }), /tool name/);
  assert.throws(() => defineCustomTool({ name: "fine", description: "d", script: "s", params: ["Bad Name"] }), /not a usable parameter name/);
  assert.throws(() => defineCustomTool({ name: "fine", description: "d", script: "s", params: ["a", "a"] }), /named twice/);
});
console.log(`\n${passed} customtools cases passed.`);
