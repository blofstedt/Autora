/**
 * The mark's own numbers, and the one rule about time that lives among them.
 *
 * The geometry here is what the app, the favicon, the Umbrel tile and the
 * icon script all draw from, so a change to it is a change to the brand; and
 * the building animation is a loop that the caller can ask to stop at any
 * moment, which is what `buildWait` exists to make safe. The timer around it
 * is ten lines of React in the component and is checked by watching the mark;
 * the decision it makes is checked here.
 *
 *   npx tsx tests/mark.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import {
  BUILD_MS,
  CLOSE_AT,
  CLOSE_FADE,
  CLOSE_IN,
  CLOSE_ON,
  DRAWN_BOX,
  MARK,
  REST,
  buildWait,
  stackUnits,
} from "../src/lib/mark";

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

/** The box a placed piece actually covers, from its path and its offset. */
function box(d: string, x: number, y: number) {
  const n = (d.match(/-?[\d.]+/g) ?? []).map(Number);
  const xs = n.filter((_, i) => i % 2 === 0);
  const ys = n.filter((_, i) => i % 2 === 1);
  return {
    x0: Math.min(...xs) + x,
    y0: Math.min(...ys) + y,
    x1: Math.max(...xs) + x,
    y1: Math.max(...ys) + y,
  };
}

console.log("the mark, and the turn the build takes");

test("the mark at rest is one closed outline of the same points as a frame", () => {
  assert.ok(REST.startsWith("M") && REST.endsWith("Z"));
  const points = REST.match(/-?[\d.]+/g) ?? [];
  assert.equal(points.length % 2, 0);
  // Each corner is walked as eight points, so every shape is 24 numbers deep
  // and a morph between two of them is a plain interpolation.
  assert.equal(points.length / 2, 24);
});

test("the drawn box is the mark's, and the mark sits centred on it", () => {
  assert.ok(Math.abs((DRAWN_BOX.x0 + DRAWN_BOX.x1) / 2 - MARK.cx) < 0.01);
  assert.ok(Math.abs((DRAWN_BOX.y0 + DRAWN_BOX.y1) / 2 - MARK.cy) < 0.01);
  // A filleted triangle is half a fillet lower than its own box, which is the
  // bug 0.9.79 shipped; the drawn box is where it really is.
  assert.ok(DRAWN_BOX.y0 > MARK.cy - MARK.R * 0.75 - 0.01);
});

test("the close comes in order, and inside one turn", () => {
  assert.ok(CLOSE_AT < CLOSE_IN && CLOSE_IN < CLOSE_ON && CLOSE_ON < CLOSE_FADE && CLOSE_FADE < 1);
  assert.ok(CLOSE_ON > 0.5, "the mark must be made well before the loop restarts");
});

test("a build is held until the turn reaches its close", () => {
  // Asked to stop anywhere in a turn: the answer is the wait to the close.
  for (const at of [0, 0.02, 0.1, 0.25, 0.5, 0.75, 0.79, 0.9, 0.93, 0.95, 0.999, 1.4, 2.6]) {
    const now = at * BUILD_MS;
    const wait = buildWait(0, now);
    const turn = (now + wait) / BUILD_MS;
    const phase = turn % 1;
    assert.ok(
      phase >= CLOSE_ON - 1e-9 && phase <= CLOSE_FADE + 1e-9,
      `asked at turn ${at}: lands at ${phase.toFixed(4)}, outside the close`,
    );
  }
});

test("nothing is held once the close is on screen", () => {
  for (const at of [CLOSE_ON, 0.85, CLOSE_FADE]) {
    assert.equal(buildWait(0, at * BUILD_MS), 0);
  }
});

test("a step that comes back at once still plays the build out", () => {
  // The case that started this: a tool call of 300ms, which is a tenth of the
  // way round -- a quarter in the air and the gap open.
  const started = 12_345;
  const wait = buildWait(started, started + 300);
  assert.ok(wait > 2_000, `held only ${Math.round(wait)}ms`);
  assert.equal((started + 300 + wait - started) / BUILD_MS, CLOSE_ON);
  // And the hold is the rest of the turn, not another one on top.
  assert.ok(wait < BUILD_MS);
});

test("the hold is never longer than a turn", () => {
  for (let at = 0; at < 3; at += 0.01) {
    const wait = buildWait(0, at * BUILD_MS);
    assert.ok(wait >= 0 && wait <= BUILD_MS, `hold of ${Math.round(wait)}ms at turn ${at.toFixed(2)}`);
  }
});

test("a build that already outlasts a turn hands over at its next close", () => {
  // Two whole turns and a quarter: the pieces are coming back round, so the
  // close is nearly a turn away rather than immediate.
  const at = 2.25 * BUILD_MS;
  const wait = buildWait(0, at);
  assert.ok(wait > BUILD_MS * 0.5, `held only ${Math.round(wait)}ms`);
  assert.ok(Math.abs((at + wait) / BUILD_MS - 2.8) < 1e-9, "must land on 2.8 turns -- CLOSE_ON of the third");
});

test("the component draws its close from these numbers", () => {
  // The rule above is only true while the drawing agrees with it, and the
  // drawing's keyTimes are one string away from drifting.
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "components", "AutoraMark.tsx"), "utf8");
  assert.ok(src.includes("times([0, CLOSE_AT, CLOSE_IN, CLOSE_FADE, 1])"), "the close's opacity keyTimes");
  assert.ok(src.includes("times([0, CLOSE_AT, CLOSE_ON, 1])"), "the close's transform keyTimes");
  assert.ok(!/keyTimes="[^"]*0\.93/.test(src), "a close keyTime is written out by hand again");
  assert.ok(src.includes("buildWait(started, performance.now())"), "the hold is not wired to buildWait");
  // What is on screen at CLOSE_ON is the resting mark itself: the close draws
  // REST, its opacity is 1 from CLOSE_IN and its offset has arrived (0 0) by
  // CLOSE_ON. So the morph's first frame and this frame are the same drawing.
  assert.ok(src.includes("d={REST}"), "the close no longer draws the mark at rest");
  assert.ok(src.includes(`values="0 0.35;0 0.35;0 0;0 0"`), "the close's offset keyframes moved");
});

test("the three quarters stack into the mark", () => {
  const pieces = stackUnits();
  assert.equal(pieces.length, 3);
  const boxes = pieces.map((p) => box(p.d, p.x, p.y));

  // The same quarter three times, so nothing is stretched to fit.
  const width = boxes[0].x1 - boxes[0].x0;
  for (const b of boxes) {
    assert.ok(Math.abs(b.x1 - b.x0 - width) < 0.01, "the quarters are not the same size");
  }

  // Two along the mark's own base, level with it and each other, together
  // centred; the third one row above and centred on its own.
  assert.ok(Math.abs(boxes[0].y1 - DRAWN_BOX.y1) < 0.01, "the base row is not on the base");
  assert.ok(Math.abs(boxes[1].y1 - boxes[0].y1) < 0.01, "the base row is not level");
  assert.ok(Math.abs((boxes[0].x0 + boxes[1].x1) / 2 - MARK.cx) < 0.01, "the base row is not centred");
  assert.ok(Math.abs((boxes[2].x0 + boxes[2].x1) / 2 - MARK.cx) < 0.01, "the top quarter is not centred");
  // One row is three quarters of the mark's radius, which is what makes three
  // of them the mark's own height.
  assert.ok(Math.abs(boxes[0].y1 - boxes[2].y1 - MARK.R * 0.75) < 0.01, "the top quarter is not one row up");
  // And the row above starts where the fillet of the one below has already
  // begun, so the pieces read as pieces rather than as a shape being filled in.
  assert.ok(boxes[2].y1 < boxes[0].y0, "the top quarter is not above the base row");

  // And between them they are the mark: the width of its own drawn box, and
  // as tall -- a corner of a quarter is half the fillet of the whole mark, so
  // the pieces reach a shade past it, less than one fillet.
  const x0 = Math.min(...boxes.map((b) => b.x0));
  const x1 = Math.max(...boxes.map((b) => b.x1));
  const y0 = Math.min(...boxes.map((b) => b.y0));
  const y1 = Math.max(...boxes.map((b) => b.y1));
  assert.ok(Math.abs(x1 - x0 - (DRAWN_BOX.x1 - DRAWN_BOX.x0)) < MARK.fillet);
  assert.ok(Math.abs(y1 - y0 - (DRAWN_BOX.y1 - DRAWN_BOX.y0)) < MARK.fillet * 2);
  assert.ok(y0 < DRAWN_BOX.y0 && y0 > DRAWN_BOX.y0 - MARK.fillet, "the stack does not reach the apex");
});

console.log(`\n${passed} passed`);
