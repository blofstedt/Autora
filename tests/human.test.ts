/**
 * The pointer's path: curved and imperfect, and always arriving where it was
 * sent. Random by design, so each case runs many times and asserts what must
 * hold every time -- a click that lands off its target is the one failure.
 *
 *   npx tsx tests/human.test.ts
 */
import assert from "node:assert/strict";
import { humanPath, pointIn } from "../server/human";

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

test("every path ends exactly on its target and never has a bad point", () => {
  for (let i = 0; i < 400; i++) {
    const from = { x: Math.random() * 1280, y: Math.random() * 800 };
    const to = { x: Math.random() * 1280, y: Math.random() * 800 };
    const path = humanPath(from, to);
    assert.deepEqual(path[path.length - 1], to);
    assert.ok(path.length >= 1 && path.length <= 200);
    for (const p of path) assert.ok(Number.isFinite(p.x) && Number.isFinite(p.y));
  }
});

test("already there is one step, not a wander", () => {
  const to = { x: 100, y: 100 };
  assert.deepEqual(humanPath({ x: 100.2, y: 100.2 }, to), [to]);
});

test("a long move takes more steps than a short one, and is not a straight line", () => {
  let short = 0;
  let long = 0;
  let bent = 0;
  for (let i = 0; i < 100; i++) {
    short += humanPath({ x: 0, y: 0 }, { x: 40, y: 0 }).length;
    const path = humanPath({ x: 0, y: 0 }, { x: 1000, y: 0 });
    long += path.length;
    if (path.some((p) => Math.abs(p.y) > 3)) bent += 1;
  }
  assert.ok(long > short);
  assert.ok(bent > 90, `only ${bent} of 100 long paths left the line`);
});

test("a click is inside the middle of the box, never on its edge", () => {
  const box = { x: 100, y: 200, w: 80, h: 30 };
  for (let i = 0; i < 1000; i++) {
    const p = pointIn(box);
    assert.ok(p.x >= box.x + box.w * 0.2 - 1 && p.x <= box.x + box.w * 0.8 + 1, `x ${p.x}`);
    assert.ok(p.y >= box.y + box.h * 0.2 - 1 && p.y <= box.y + box.h * 0.8 + 1, `y ${p.y}`);
  }
});

test("a box with no size still gives a point, not NaN", () => {
  const p = pointIn({ x: 10, y: 10, w: 0, h: 0 });
  assert.deepEqual(p, { x: 10, y: 10 });
});
console.log(`\n${passed} human cases passed.`);
