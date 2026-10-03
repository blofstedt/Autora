/**
 * The cursor's motion and typing in the PDF and Office windows: the same kind
 * of path the browser's pointer takes, and an uneven rhythm of keys.
 *
 *   npx tsx tests/humanpath.test.ts
 */
import assert from "node:assert/strict";
import { clearCursor, recentCursor, reportCursor } from "../src/lib/cursorPos";
import { glance } from "../src/components/ImmersiveChat";
import { along, ease, humanRoute, routeMs, typingDelays } from "../src/lib/humanPath";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

console.log("cursor motion");

test("a route ends exactly on the target and is not a straight line", () => {
  const from = { x: 0, y: 0 }, to = { x: 400, y: 300 };
  for (let n = 0; n < 20; n++) {
    const route = humanRoute(from, to);
    assert.deepEqual(route.at(-1), to);
    assert.ok(route.length >= 12);
    const off = Math.max(...route.map((p) => Math.abs(300 * p.x - 400 * p.y) / 500));
    assert.ok(off > 1, "it bends off the chord");
  }
});

test("two routes between the same points are not alike", () => {
  const a = humanRoute({ x: 0, y: 0 }, { x: 300, y: 100 }), b = humanRoute({ x: 0, y: 0 }, { x: 300, y: 100 });
  assert.notDeepEqual(a, b);
});

test("it eases: slow at the ends, quick in the middle", () => {
  assert.equal(ease(0), 0);
  assert.equal(ease(1), 1);
  assert.ok(ease(0.1) < 0.05 && ease(0.9) > 0.95 && ease(0.5) === 0.5);
});

test("a longer reach takes longer, but not in proportion", () => {
  const avg = (d: number) => Array.from({ length: 50 }, () => routeMs(d)).reduce((x, y) => x + y, 0) / 50;
  assert.ok(avg(800) > avg(50));
  assert.ok(avg(800) < avg(50) * 16);
  assert.ok(routeMs(5000) <= 1100 * 1.15 + 1);
});

test("along() reads a route by progress and never runs off either end", () => {
  const route = humanRoute({ x: 0, y: 0 }, { x: 100, y: 0 });
  assert.deepEqual(along(route, 1), { x: 100, y: 0 });
  assert.deepEqual(along(route, 2), { x: 100, y: 0 });
  assert.ok(Math.abs(along(route, 0).x) < 30);
});

console.log("typing");

test("keys come at uneven gaps, and all of it fits the budget", () => {
  const gaps = typingDelays("The quick brown fox jumps over the lazy dog. ".repeat(3), 2600);
  assert.equal(gaps.length, 135);
  assert.ok(gaps.reduce((a, b) => a + b, 0) <= 2600 + gaps.length, "within the budget, give or take rounding");
  assert.ok(new Set(gaps).size > 3, "not metronomic");
});

test("short words are typed at a person's pace, not squeezed", () => {
  const total = typingDelays("Hello", 2600).reduce((a, b) => a + b, 0);
  assert.ok(total > 150 && total < 1400, String(total));
});

console.log("the agent's line over a full-screen tool");

test("the cursor's place is known while it moves, and forgotten once it has gone", () => {
  assert.equal(recentCursor(), null);
  reportCursor(120, 340);
  assert.deepEqual(recentCursor(), { x: 120, y: 340 });
  assert.equal(recentCursor(-1), null, "an old position is no position");
  clearCursor();
  assert.equal(recentCursor(), null);
});

test("a reply is cut to a glance: its first sentence, plain, short", () => {
  assert.equal(glance("I'll **redraw** the chart. Then check it."), "I'll redraw the chart.");
  assert.equal(glance("```js\nlet x\n```\nDone with the [report](http://a.b)."), "Done with the report.");
  const long = glance("word ".repeat(80));
  assert.ok(long.length <= 110 && long.endsWith("…"));
  assert.equal(glance(""), "");
});

console.log(`${passed} passed`);
