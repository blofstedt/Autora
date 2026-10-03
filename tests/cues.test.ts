/**
 * What the PDF window shows the agent doing for each object it places.
 *
 *   npx tsx tests/cues.test.ts
 */
import assert from "node:assert/strict";
import { asPath, cueForItem, pathPoints } from "../server/pdf";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const at = { pageNumber: 2, x: 50, y: 60, width: 120, height: 20 };

console.log("cues for placed objects");

test("text is typed into a new box with the text tool", () => {
  const c = cueForItem({ id: "a1", type: "text", text: "Jane Tenant", ...at });
  assert.deepEqual([c?.act, c?.tool, c?.to, c?.itemId, c?.page], ["type", "text", "Jane Tenant", "a1", 2]);
});

test("a stamp, a signature, an image and a note are clicked into place", () => {
  assert.deepEqual(["stamp", "signature", "image", "note"].map((type) => {
    const c = cueForItem({ id: type, type, ...at });
    return [c?.act, c?.tool];
  }), [["place", "stamp"], ["place", "signature"], ["place", "image"], ["place", "note"]]);
});

test("a shape and a redaction are dragged out as boxes", () => {
  assert.deepEqual(["shape", "redact"].map((type) => {
    const c = cueForItem({ id: type, type, ...at });
    return [c?.act, c?.tool, c?.w, c?.h];
  }), [["drag", "shape", 120, 20], ["drag", "redact", 120, 20]]);
});

test("a stroke is traced along its points, thinned, with the box of the stroke", () => {
  const points = Array.from({ length: 300 }, (_, i) => ({ x: 10 + i, y: 100 + (i % 7) }));
  const c = cueForItem({ id: "s", type: "highlighter", drawingPoints: points, ...at })!;
  assert.equal(c.act, "draw");
  assert.equal(c.tool, "highlighter");
  assert.ok(c.points!.length <= 62 && c.points!.length > 10);
  assert.equal(c.points!.at(-1)!.x, 309, "the end of the stroke is kept");
  assert.deepEqual([c.x, c.w], [10, 299]);
  assert.equal(cueForItem({ id: "d", type: "drawing", drawingPoints: points, ...at })!.tool, "draw");
});

test("a stroke with no path is dragged as a box instead", () => {
  assert.equal(cueForItem({ id: "h", type: "highlighter", ...at })!.act, "drag");
});

test("something with nowhere to show gives nothing", () => {
  assert.equal(cueForItem({ id: "x", type: "text", pageNumber: 0, x: 1, y: 1, width: 1, height: 1 }), null);
  assert.equal(cueForItem({ id: "x", type: "text", pageNumber: 1, x: NaN, y: 1, width: 1, height: 1 }), null);
  assert.equal(cueForItem({ id: "x", type: "mystery", ...at }), null);
});

console.log("curves");

test("a cubic path is sampled along its bend, not read as numbers", () => {
  const pts = pathPoints("M 0 40 C 30 0, 90 80, 120 40", 10, 100);
  assert.ok(pts.length > 20, "sampled finely");
  assert.deepEqual(pts[0], { x: 10, y: 140 });
  assert.deepEqual(pts.at(-1), { x: 130, y: 140 });
  assert.ok(pts.some((p) => p.y < 135) && pts.some((p) => p.y > 145), "it swings both sides of the chord");
});

test("relative commands, H, V and arcs end where they say", () => {
  const pts = pathPoints("M 0 0 l 10 0 h 10 v 10 a 5 5 0 0 1 10 0 q 5 -10 10 0 z", 0, 0);
  assert.deepEqual(pts.at(-1), { x: 0, y: 0 }, "z closes to the start");
  assert.ok(pts.every((p) => Number.isFinite(p.x) && Number.isFinite(p.y)));
  assert.ok(pts.some((p) => p.x === 30 && p.y === 10), "the arc ends on its end point");
});

test("a curve item becomes a path from its start through its control point", () => {
  const p = asPath({ type: "curve", x: 50, y: 60, x2: 150, y2: 60, cx: 100, cy: 0 });
  assert.equal(p.type, "path");
  assert.equal(p.d, "M 0 0 Q 50 -60 100 0");
  assert.equal(asPath({ type: "curve", x: 0, y: 0, x2: 10, y2: 0, cx: 3, cy: 3, cx2: 6, cy2: -3 }).d, "M 0 0 C 3 3 6 -3 10 0");
  assert.throws(() => asPath({ type: "curve", x: 0, y: 0, x2: 1, y2: 1 }));
});

console.log(`${passed} passed`);
