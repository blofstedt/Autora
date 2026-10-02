/**
 * Where a cursor goes when the page changes.
 *
 *   npx tsx tests/domdiff.test.ts
 */
import assert from "node:assert/strict";
import { diffDom, type DomItem } from "../server/domdiff";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const view = { width: 1000, height: 700 };
const el = (tag: string, text: string, y: number, over: Partial<DomItem> = {}): DomItem => ({
  k: `${tag}|${text}|`, s: "color:#000;size:16", tag, x: 20, y, w: 300, h: 30, ...over,
});

console.log("dom diff");

test("a new element is where the cursor goes, and says what it is", () => {
  const before = [el("h1", "Welcome", 20), el("p", "Intro", 80)];
  const after = [el("h1", "Welcome", 20), el("button", "Sign up", 80), el("p", "Intro", 130)];
  const cues = diffDom(before, after, view);
  assert.deepEqual(cues.map((c) => [c.kind, c.label, c.y]), [["added", "New button", 80]]);
});

test("things pushed down by an insertion above them are not changed", () => {
  const before = [el("h1", "Title", 20), el("p", "A", 100), el("p", "B", 150)];
  const after = [el("h1", "Title", 20), el("p", "Banner", 70), el("p", "A", 120), el("p", "B", 170)];
  assert.deepEqual(diffDom(before, after, view).map((c) => c.label), ["New text"]);
});

test("edited words are a new element at the spot, and the old words are gone", () => {
  const cues = diffDom([el("h1", "Hello", 20)], [el("h1", "Hello there", 20)], view);
  assert.deepEqual(cues.map((c) => [c.kind, c.label]), [["added", "New heading"]]);
});

test("the same element looking different is changed", () => {
  const cues = diffDom([el("button", "Go", 40)], [el("button", "Go", 40, { s: "color:#fff;size:18" })], view);
  assert.deepEqual(cues.map((c) => [c.kind, c.label]), [["changed", "Changed button"]]);
});

test("a second copy of the same thing is the new one", () => {
  const cues = diffDom([el("li", "Item", 20)], [el("li", "Item", 20), el("li", "Item", 60)], view);
  assert.deepEqual(cues.map((c) => c.y), [60]);
});

test("nothing changed gives nothing", () => {
  const same = [el("h1", "A", 10), el("p", "B", 60)];
  assert.deepEqual(diffDom(same, same.map((i) => ({ ...i })), view), []);
});

test("only what is in view, tiny things aside, in reading order, at most five", () => {
  const after = [
    ...[600, 40, 300, 120, 200, 500, 90, 450].map((y) => el("p", `row${y}`, y)),
    el("p", "offscreen", 2000),
    el("p", "tiny", 10, { w: 2, h: 2 }),
  ];
  const cues = diffDom([], after, view);
  assert.deepEqual(cues.map((c) => c.y), [40, 90, 120, 200, 300]);
});

test("neighbours inside the one just marked share its mark", () => {
  const after = [el("div", "card", 100, { w: 400, h: 200 }), el("p", "inside", 120, { x: 40, w: 200, h: 30 })];
  assert.equal(diffDom([], after, view).length, 1);
});

console.log(`${passed} passed`);
