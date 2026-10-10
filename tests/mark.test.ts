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
  MORPH,
  MORPH_CLOSE_MS,
  MORPH_CLOSE_STEPS,
  SETTLE_MS,
  caughtIn,
  MORPH_MS,
  REST,
  buildWait,
  morphClose,
  morphCloseMs,
  morphFrame,
  morphFrames,
  morphPhase,
  morphSharp,
  settleHome,
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

/** A drawing's points, in the order its path names them. */
function pointsOf(d: string) {
  const n = (d.match(/-?[\d.]+/g) ?? []).map(Number);
  const out: [number, number][] = [];
  for (let i = 0; i + 1 < n.length; i += 2) out.push([n[i], n[i + 1]]);
  return out;
}

/** The same points, sorted, so two drawings can be compared as pictures rather
    than as lists: the same outline written from a different corner, or with its
    corners renamed, compares equal -- which is what the morph's whole loop
    rests on. */
function sorted(d: string) {
  return pointsOf(d).sort((p, q) => p[0] - q[0] || p[1] - q[1]);
}

/** How far a drawing moves between two frames, as the furthest any of its
    points travels to the nearest point of the next one. Identical pictures are
    0 however their points are ordered. */
function stepOf(a: string, b: string) {
  const B = pointsOf(b);
  return Math.max(...pointsOf(a).map(([x, y]) => Math.min(...B.map(([u, v]) => Math.hypot(x - u, y - v)))));
}

/** The furthest the mark ever moves between two frames of its own morph: the
    speed the drawing under its own steam already has, which a close is held to. */
function morphStep() {
  const frames = morphFrames();
  let most = 0;
  for (let i = 1; i < frames.length; i += 1) most = Math.max(most, stepOf(frames[i - 1], frames[i]));
  return most;
}

/** The same outline, whatever order its points are written in and wherever the
    path starts: a triangle showing its next corner is the mark. */
function sameShape(a: string, b: string, tol = 0.02) {
  const A = sorted(a);
  const B = sorted(b);
  return A.length === B.length && A.every((p, i) => Math.hypot(p[0] - B[i][0], p[1] - B[i][1]) < tol);
}

/** How far apart two drawings are, as the furthest pair of their points. */
function spread(a: string, b: string) {
  const A = sorted(a);
  const B = sorted(b);
  return Math.max(...A.map((p, i) => Math.hypot(p[0] - B[i][0], p[1] - B[i][1])));
}

test("the morph is the mark at both ends of every pulse, and centred between them", () => {
  const frames = morphFrames();
  assert.equal(frames.length, 31, "the cycle's frames");
  assert.equal(MORPH, frames.join(";"), "the string the app draws is not these frames");

  // Sharp at the start, the middle and the end of the cycle -- and those three
  // are the same picture, which is what makes the loop seamless.
  for (const p of [0, 0.5, 1]) {
    assert.ok(sameShape(morphFrame(p), REST), `phase ${p} is not the mark`);
  }
  assert.ok(sameShape(frames[30], frames[0]), "the loop has a seam");

  // A quarter of the way through a pulse it is out at the circle: as wide as
  // it is tall.
  const open = box(morphFrame(0.25), 0, 0);
  assert.ok(Math.abs(open.x1 - open.x0 - (open.y1 - open.y0)) < MARK.fillet / 2, "the open mark is not round");

  // And it never leaves its own centre on the way, however open it is.
  for (const d of frames) {
    const b = box(d, 0, 0);
    assert.ok(Math.abs((b.x0 + b.x1) / 2 - MARK.cx) < 0.01, "the mark drifts sideways as it morphs");
    assert.ok(Math.abs((b.y0 + b.y1) / 2 - MARK.cy) < 0.01, "the mark drifts up or down as it morphs");
  }
});

test("the way home takes as long as the mark has to travel, and no longer", () => {
  // A quarter of a cycle away -- the most there ever is -- takes the whole of
  // MORPH_CLOSE_MS, at the circle and at either point the cycle is sharp.
  for (const p of [0.25, 0.75]) {
    assert.ok(Math.abs(morphCloseMs(p) - MORPH_CLOSE_MS) < 1e-9, `phase ${p} is not a whole close`);
  }
  // A mark already on the triangle has nothing to come home from.
  for (const p of [0, 0.5, 1]) {
    assert.ok(morphCloseMs(p) < 1e-9, `phase ${p} is not already home`);
  }
  // Half way out takes half as long: one speed, whatever it is coming from.
  assert.ok(Math.abs(morphCloseMs(0.125) - MORPH_CLOSE_MS / 2) < 1e-9, "the close is not at one speed");

  // Never longer than a quarter of the cycle's worth of travel, and never
  // negative, wherever it is caught.
  for (let i = 0; i <= 100; i += 1) {
    const ms = morphCloseMs(i / 100);
    assert.ok(ms >= 0 && ms <= MORPH_CLOSE_MS + 1e-9, `phase ${i / 100} takes ${ms.toFixed(0)}ms to come home`);
  }
});

test("a settle that follows a morph comes home rather than cutting", () => {
  // The fastest the mark moves under its own steam, which a close is held to:
  // coming home is a settle, not a whip.
  const fastest = morphStep();
  const caught = [0.02, 0.12, 0.25, 0.31, 0.46, 0.5, 0.62, 0.75, 0.98];

  for (const p of caught) {
    const close = morphClose(p);
    assert.equal(close.length, MORPH_CLOSE_STEPS + 2, "the way home's frames");
    // It begins on the pose that was on screen, not near it.
    assert.equal(close[0], morphFrame(p), `the close does not start where the morph was (${p})`);
    // It ends on the mark, twice: as the cycle draws it there, and as REST,
    // which is the frame the bloom starts from. So there is no jump into it.
    assert.ok(sameShape(close[MORPH_CLOSE_STEPS], REST), `the way home does not arrive at the mark (${p})`);
    assert.equal(close[MORPH_CLOSE_STEPS + 1], REST, `the way home does not end on the resting mark (${p})`);

    let most = 0;
    for (let i = 1; i < close.length; i += 1) most = Math.max(most, stepOf(close[i - 1], close[i]));
    assert.ok(most <= fastest, `the way home from ${p} moves ${most.toFixed(2)} units in a frame, past the ${fastest.toFixed(2)} the morph itself moves`);
    for (const d of close) {
      const b = box(d, 0, 0);
      assert.ok(Math.abs((b.x0 + b.x1) / 2 - MARK.cx) < 0.01, "the mark drifts sideways coming home");
      assert.ok(Math.abs((b.y0 + b.y1) / 2 - MARK.cy) < 0.01, "the mark drifts up or down coming home");
    }
  }

  // Caught at the circle, there is a real distance to come home from; caught
  // at the mark, there is nothing to do.
  assert.ok(spread(morphClose(0.25)[0], REST) > 5, "the way home starts too close to the mark to be seen");
  assert.ok(spread(morphClose(0.5)[0], REST) < 0.02, "a mark already home is moved about");
});

test("the way home is never longer than a quarter of the cycle", () => {
  for (let i = 0; i <= 40; i += 1) {
    const p = i / 40;
    const sharp = morphSharp(p);
    assert.ok(Math.abs(sharp - p) <= 0.25 + 1e-9, `phase ${p} has ${Math.abs(sharp - p)} of cycle to come home`);
    assert.ok(sameShape(morphFrame(sharp), REST), `phase ${sharp} is not the mark`);
  }
});

test("the drawing's clock reads the phase the animation is at", () => {
  assert.equal(morphPhase(1000, 1000), 0);
  assert.ok(Math.abs(morphPhase(1000, 1000 + MORPH_MS / 4) - 0.25) < 1e-9);
  assert.ok(Math.abs(morphPhase(1000, 1000 + MORPH_MS) - 0) < 1e-9, "a whole cycle is not back where it started");
  assert.equal(morphPhase(2000, 1000), 0, "a clock that has not started is at the mark");
  assert.equal(MORPH_MS, 9000, "the cycle's length moved");
});

test("the ending's animation is one an SVG will read, however far it has to come home", () => {
  let drawn = 0;
  for (let i = 0; i <= 200; i += 1) {
    const close = caughtIn(i / 200);
    if (close === null) continue;
    drawn += 1;
    const { values, keyTimes, keySplines, dur } = settleHome(close);
    const frames = values.split(";");
    const keys = keyTimes.split(";").map(Number);
    const splines = keySplines.split("; ");

    // The run is the close's frames and then the bloom's, with one keyTime per
    // frame and one easing per step between them: three lists that an SVG
    // checks against each other, and silently drops the animation over.
    assert.equal(keys.length, frames.length, `keyTimes and frames disagree at ${close.at}`);
    assert.equal(splines.length, frames.length - 1, `keySplines and frames disagree at ${close.at}`);
    assert.equal(dur, `${close.ms + SETTLE_MS}ms`, "the run is not the close plus the bloom");

    // KeyTimes have to be in order and inside the run, and must not round onto
    // one another -- a repeated time is one frame that never gets drawn.
    assert.equal(keys[0], 0, `the run does not start at once (${close.at})`);
    assert.equal(keys[keys.length - 1], 1, `the run does not end on time (${close.at})`);
    for (let k = 0; k < keys.length; k += 1) {
      assert.ok(keys[k] >= 0 && keys[k] <= 1, `keyTime ${keys[k]} is off the run at ${close.at}`);
      if (k > 0) assert.ok(keys[k] > keys[k - 1], `frames ${k - 1} and ${k} land on the same moment at ${close.at}`);
    }

    // It starts on the pose that was on screen, and ends on the mark.
    assert.equal(frames[0], morphFrame(close.at), "the ending does not start where the morph was");
    assert.equal(frames[frames.length - 1], REST, "the ending does not finish on the resting mark");
  }
  assert.ok(drawn > 150, `only ${drawn} of 201 phases had a way home worth drawing`);
  // A mark caught all but on the triangle is left to the bloom.
  assert.equal(caughtIn(0), null, "a mark already home is made to come home");
  assert.equal(caughtIn(0.5), null, "a mark already home is made to come home");
  assert.ok(caughtIn(0.25) !== null, "a mark caught at the circle is left to cut");
});

test("the component comes home before it blooms", () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "components", "AutoraMark.tsx"), "utf8");
  assert.ok(src.includes("caughtIn(morphPhase(turning.current, performance.now()))"), "the settle no longer asks where the morph was");
  assert.ok(src.includes("settleHome(close, sides)"), "the way home is not drawn");
  assert.ok(src.includes("close.ms + SETTLE_MS"), "the settle is not the close plus the bloom");
  assert.ok(src.includes('"settle-home"'), "the settle's animation is not keyed by the way home");
  assert.ok(src.includes("is-closing"), "the wash is not told the close is happening");
  assert.ok(src.includes('"--morph-close-ms"'), "the bloom is not told how long to wait");
  assert.ok(!/const MORPH_MS/.test(src), "the morph's clock is written out by hand in the component again");

  // The wash waits for the mark: styles.css and lib/mark.ts have to agree on
  // how long the longest close is and how long the bloom runs, and each pair is
  // one number away from drifting apart.
  const css = fs.readFileSync(path.join(import.meta.dirname, "..", "src", "styles.css"), "utf8");
  assert.ok(css.includes(`--morph-close-ms: ${MORPH_CLOSE_MS}ms`), "styles.css no longer knows how long a close is");
  assert.ok(css.includes(`--settle-ms: ${SETTLE_MS}ms`), "styles.css no longer knows how long the bloom is");
  assert.ok(
    /\.amark\.is-settle\.is-closing[^{]*\{[^}]*animation-delay: var\(--morph-close-ms\)/.test(css),
    "the bloom is not held back for the close",
  );
});

test("an agent's shape moves the way the mark does: same points at every frame, the circle at the open moments", async () => {
  const m = await import("../src/lib/mark");
  const count = (d: string) => (d.match(/[ML]/g) ?? []).length;
  for (const sides of [4, 5, 6, 7, 8]) {
    const rest = m.restOf(sides);
    assert.equal(count(rest), sides * 8, `${sides} sides: eight points a corner`);
    const frames = m.morphFrames(30, { sides });
    assert.ok(frames.every((f) => count(f) === sides * 8), `${sides} sides: every frame has the rest's points`);
    assert.equal(frames[0], rest, `${sides} sides: the cycle starts on the shape`);
    assert.ok(m.bloomOf(sides).every((f) => count(f) === sides * 8));
    assert.equal(m.stackUnits(sides).length, sides);
    // At the open moment the shape is a circle: every point the same distance from the middle.
    const open = m.morphFrame(0.25, { sides, breath: 0 });
    const pts = open.replace(/[MZ]/g, "").split("L").map((p) => p.trim().split(" ").map(Number));
    const cx = pts.reduce((a, p) => a + p[0], 0) / pts.length;
    const cy = pts.reduce((a, p) => a + p[1], 0) / pts.length;
    const radii = pts.map((p) => Math.hypot(p[0] - cx, p[1] - cy));
    assert.ok(Math.max(...radii) - Math.min(...radii) < 0.05, `${sides} sides: opens out to a circle`);
  }
  assert.equal(m.restOf(3), m.REST, "the triangle is untouched");
  assert.equal(m.morphOf(3), m.MORPH);
});

console.log(`\n${passed} passed`);
