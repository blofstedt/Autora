/**
 * Folding a turn's commands into one line.
 *
 * A turn that read a dozen files and ran six commands used to be eighteen
 * cards tall, which pushed the answer a screen away from the question. The
 * rule that decides what folds is here; what matters is that nothing is
 * dropped, the order survives, and a run stops at anything that is not a
 * command so a page the agent looked at is not buried among the commands.
 *
 *   npx tsx tests/steps.test.ts
 */
import assert from "node:assert/strict";
import { turnItems, STEP_KINDS } from "../src/lib/steps";
import type { Cell } from "../src/lib/derive";

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

/** Only the two fields the rule looks at. */
const cell = (kind: string, seq: number) => ({ kind, seq } as unknown as Cell);
const kinds = (cells: Cell[]) =>
  turnItems(cells).map((item) => (item.kind === "steps" ? `steps(${item.cells.map((c) => c.kind).join("+")})` : item.cell.kind));

test("commands and small tools between two answers become one line", () => {
  const cells = [cell("terminal", 1), cell("tool", 2), cell("terminal", 3)];
  assert.deepEqual(kinds(cells), ["steps(terminal+tool+terminal)"]);
  const items = turnItems(cells);
  assert.equal(items.length, 1);
  assert.deepEqual(items[0].kind === "steps" ? items[0].cells.map((c) => c.seq) : [], [1, 2, 3]);
});

test("anything that is not a command breaks the run", () => {
  const cells = [cell("terminal", 1), cell("screencast", 2), cell("tool", 3)];
  assert.deepEqual(kinds(cells), ["steps(terminal)", "screencast", "steps(tool)"]);
});

test("a single command still folds, so a one-command turn is one line", () => {
  assert.deepEqual(kinds([cell("terminal", 7)]), ["steps(terminal)"]);
});

test("nothing is dropped and the order is kept", () => {
  const cells = [
    cell("terminal", 1), cell("diff", 2), cell("terminal", 3), cell("tool", 4),
    cell("ask", 5), cell("widget", 6), cell("tool", 7),
  ];
  const items = turnItems(cells);
  const seen = items.flatMap((item) => (item.kind === "steps" ? item.cells : [item.cell]));
  assert.deepEqual(seen.map((c) => c.seq), cells.map((c) => c.seq));
  assert.equal(seen.length, cells.length);
});

test("the keys do not move when the same cells are folded again", () => {
  const cells = [cell("terminal", 1), cell("tool", 2), cell("memory", 3)];
  assert.deepEqual(turnItems(cells).map((i) => i.key), turnItems([...cells]).map((i) => i.key));
});

test("an empty turn folds to nothing", () => {
  assert.deepEqual(turnItems([]), []);
});

test("the kinds that fold are only commands and the small tools", () => {
  assert.deepEqual([...STEP_KINDS].sort(), ["terminal", "tool"]);
});

console.log(`${passed} passed`);
