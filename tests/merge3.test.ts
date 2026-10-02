/**
 * Putting the agent's edit and the person's together.
 *
 *   npx tsx tests/merge3.test.ts
 */
import assert from "node:assert/strict";
import { merge3 } from "../server/merge3";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const text = (...lines: string[]) => lines.join("\n") + "\n";
const BASE = text("one", "two", "three", "four", "five", "six", "seven", "eight");

console.log("three-way merge");

test("an edit nobody else touched stands as it is", () => {
  const ours = text("one", "TWO", "three", "four", "five", "six", "seven", "eight");
  const r = merge3(BASE, ours, BASE);
  assert.equal(r.text, ours);
  assert.equal(r.withTheirs, false);
  assert.deepEqual(r.conflicts, []);
});

test("when only the person changed it, theirs stands", () => {
  const theirs = text("one", "two", "three", "FOUR", "five", "six", "seven", "eight");
  const r = merge3(BASE, BASE, theirs);
  assert.equal(r.text, theirs);
  assert.equal(r.withTheirs, true);
});

test("changes to different places are both kept", () => {
  const ours = text("one", "TWO", "three", "four", "five", "six", "seven", "eight");
  const theirs = text("one", "two", "three", "four", "five", "six", "SEVEN", "eight");
  const r = merge3(BASE, ours, theirs);
  assert.equal(r.text, text("one", "TWO", "three", "four", "five", "six", "SEVEN", "eight"));
  assert.deepEqual(r.conflicts, []);
  assert.equal(r.withTheirs, true);
});

test("edits on neighbouring lines both stay: neither overwrites the other", () => {
  const ours = text("one", "TWO", "three", "four", "five", "six", "seven", "eight");
  const theirs = text("one", "two", "THREE", "four", "five", "six", "seven", "eight");
  const r = merge3(BASE, ours, theirs);
  assert.equal(r.text, text("one", "TWO", "THREE", "four", "five", "six", "seven", "eight"));
  assert.deepEqual(r.conflicts, []);
});

test("an insertion and an edit elsewhere both stay, and a deletion with them", () => {
  const ours = text("one", "two", "three", "NEW LINE", "four", "five", "six", "seven", "eight");
  const theirs = text("one", "three", "four", "five", "six", "seven", "EIGHT");
  const r = merge3(BASE, ours, theirs);
  assert.equal(r.text, text("one", "three", "NEW LINE", "four", "five", "six", "seven", "EIGHT"));
  assert.deepEqual(r.conflicts, []);
});

test("the same line changed two ways is a conflict that names both, and is not resolved for them", () => {
  const ours = text("one", "two", "AGENT", "four", "five", "six", "seven", "eight");
  const theirs = text("one", "two", "PERSON", "four", "five", "six", "seven", "eight");
  const r = merge3(BASE, ours, theirs);
  assert.equal(r.conflicts.length, 1);
  assert.deepEqual(r.conflicts[0], { line: 3, base: ["three"], ours: ["AGENT"], theirs: ["PERSON"] });
});

test("the same change made by both is taken once", () => {
  const both = text("one", "two", "THREE", "four", "five", "six", "seven", "eight");
  const r = merge3(BASE, both, both.replace("THREE", "THREE"));
  assert.equal(r.text, both);
  assert.deepEqual(r.conflicts, []);
});

test("two insertions at the same place are a conflict; at different places they are not", () => {
  const a = text("one", "A", "two", "three", "four", "five", "six", "seven", "eight");
  const b = text("one", "B", "two", "three", "four", "five", "six", "seven", "eight");
  assert.equal(merge3(BASE, a, b).conflicts.length, 1);
  const c = text("one", "two", "three", "four", "five", "six", "C", "seven", "eight");
  assert.deepEqual(merge3(BASE, a, c).conflicts, []);
  assert.equal(merge3(BASE, a, c).text, text("one", "A", "two", "three", "four", "five", "six", "C", "seven", "eight"));
});

test("an edit inside a block the other side deleted is a conflict", () => {
  const ours = text("one", "two", "THREE", "four", "five", "six", "seven", "eight");
  const theirs = text("one", "two", "five", "six", "seven", "eight");
  assert.equal(merge3(BASE, ours, theirs).conflicts.length, 1);
});

test("several separate changes on each side all land, in order", () => {
  const ours = text("ONE", "two", "three", "four", "FIVE", "six", "seven", "eight");
  const theirs = text("one", "two", "THREE", "four", "five", "six", "SEVEN", "eight");
  const r = merge3(BASE, ours, theirs);
  assert.equal(r.text, text("ONE", "two", "THREE", "four", "FIVE", "six", "SEVEN", "eight"));
});

test("the end of the file keeps its newline, or its lack of one", () => {
  const r = merge3("a\nb", "a\nB", "a\nb");
  assert.equal(r.text, "a\nB");
  assert.equal(merge3("a\nb\n", "a\nB\n", "A\nb\n").text, "A\nB\n");
});

test("an empty file and a file that is all one side's are handled", () => {
  assert.equal(merge3("", "new\n", "").text, "new\n");
  assert.equal(merge3("", "agent\n", "person\n").conflicts.length, 1);
});

test("random edits to different lines always merge to both applied, and to the same line always clash", () => {
  let seed = 12345;
  const rnd = (n: number) => { seed = (seed * 1103515245 + 12345) & 0x7fffffff; return seed % n; };
  for (let round = 0; round < 400; round++) {
    const n = 5 + rnd(25);
    const base = Array.from({ length: n }, (_, i) => `line ${i}`);
    const mine = new Set<number>(), theirs = new Set<number>();
    for (let k = 0; k < 1 + rnd(4); k++) mine.add(rnd(n));
    for (let k = 0; k < 1 + rnd(4); k++) theirs.add(rnd(n));
    const shared = [...mine].filter((x) => theirs.has(x));
    const apply = (set: Set<number>, tag: string) => base.map((l, i) => (set.has(i) ? `${l} ${tag}` : l));
    const toText = (lines: string[]) => lines.join("\n") + "\n";
    const r = merge3(toText(base), toText(apply(mine, "A")), toText(apply(theirs, "B")));
    if (shared.length === 0) {
      const expected = base.map((l, i) => (mine.has(i) ? `${l} A` : theirs.has(i) ? `${l} B` : l));
      assert.deepEqual(r.conflicts, [], `round ${round}: ${[...mine]} vs ${[...theirs]}`);
      assert.equal(r.text, toText(expected), `round ${round}`);
    } else {
      assert.ok(r.conflicts.length >= 1, `round ${round}: a line both changed differently must clash (${shared})`);
    }
  }
});

console.log(`${passed} passed`);
