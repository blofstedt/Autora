/**
 * The personality shape: five corners, the first straight up, each pulled out by
 * how much of that trait the agent has grown. Never a dot, never past its corner.
 *
 *   npx tsx tests/personalityshape.test.ts
 */
import assert from "node:assert/strict";
import { asPoints, corner, shapeCorners } from "../src/lib/personalityshape";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const keys = ["warmth", "humor", "curiosity", "candor", "initiative"] as const;
const near = (a: number, b: number) => Math.abs(a - b) < 1e-6;

test("the first corner is straight up and the rest follow clockwise", () => {
  const top = corner(0, 5, 100, 0, 0);
  assert.ok(near(top.x, 0) && near(top.y, -100));
  const second = corner(1, 5, 100, 0, 0);
  assert.ok(second.x > 0 && second.y < 0, "to the right of the top");
  assert.ok(near(Math.hypot(second.x, second.y), 100));
});

test("a trait at the top of the scale reaches its corner, and one at the bottom keeps a little shape", () => {
  const full = shapeCorners({ warmth: 100 }, keys, 100, 0, 0)[0];
  assert.ok(near(full.y, -100));
  const none = shapeCorners({ warmth: 0 }, keys, 100, 0, 0)[0];
  assert.ok(near(none.y, -10), "never quite the centre");
  const over = shapeCorners({ warmth: 900 }, keys, 100, 0, 0)[0];
  assert.ok(near(over.y, -100), "never past its corner");
});

test("a newborn's even traits make a rounded shape, and growth stretches it toward one point", () => {
  const even = shapeCorners({ warmth: 60, humor: 60, curiosity: 60, candor: 60, initiative: 60 }, keys, 100, 0, 0)
    .map((p) => Math.hypot(p.x, p.y));
  assert.ok(even.every((r) => near(r, even[0])), "equal reach in every direction");
  const grown = shapeCorners({ warmth: 60, humor: 90, curiosity: 60, candor: 60, initiative: 60 }, keys, 100, 0, 0)
    .map((p) => Math.hypot(p.x, p.y));
  assert.ok(grown[1] > grown[0] && grown[1] > grown[2], "toward humor");
});

test("a trait that is missing sits at the middle of the scale, and the points are one per corner", () => {
  const pts = shapeCorners(undefined, keys, 100, 50, 50);
  assert.equal(pts.length, 5);
  assert.equal(asPoints(pts).split(" ").length, 5);
});

console.log(`\n${passed} passed`);
