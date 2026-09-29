/**
 * The recurrence picker's arithmetic: cron read as one of the four shapes a
 * person actually sets, and written back.
 *
 * This is worth its own test because a mistake here is not a visible one. A
 * schedule that comes back as "0 8 * * 1" instead of "0 8 * * 1-5" runs on a
 * Monday and looks fine; the only sign is the silence on Tuesday. So the round
 * trip is checked for each shape, and anything the picker cannot express must
 * come back as custom with its cron untouched rather than be quietly
 * flattened into the nearest shape it does understand.
 *
 *   npx tsx tests/recur.test.ts
 */
import assert from "node:assert/strict";
import type { Recur } from "../src/lib/recur";

const recur = await import("../src/lib/recur");
const { cronOf, parseRecur, clock, FREQS } = recur;

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

test("every hour keeps its minute", () => {
  assert.deepEqual(parseRecur("30 * * * *"), { kind: "hourly", minute: 30 });
  assert.equal(cronOf(parseRecur("30 * * * *"), ""), "30 * * * *");
});

test("a daily time survives the round trip", () => {
  assert.deepEqual(parseRecur("0 8 * * *"), { kind: "daily", hour: 8, minute: 0 });
  assert.equal(cronOf(parseRecur("5 23 * * *"), ""), "5 23 * * *");
});

test("weekdays come back as weekdays, not as five separate days", () => {
  assert.deepEqual(parseRecur("0 8 * * 1-5"), { kind: "weekly", days: [1, 2, 3, 4, 5], hour: 8, minute: 0 });
  assert.equal(cronOf(parseRecur("0 8 * * 1-5"), ""), "0 8 * * 1-5");
});

test("a list of days keeps its days and is written in order", () => {
  assert.deepEqual(parseRecur("0 7 * * 0,6"), { kind: "weekly", days: [0, 6], hour: 7, minute: 0 });
  assert.equal(cronOf({ kind: "weekly", days: [6, 0], hour: 7, minute: 0 }, ""), "0 7 * * 0,6");
  assert.equal(cronOf({ kind: "weekly", days: [3, 1, 3], hour: 7, minute: 0 }, ""), "0 7 * * 1,3");
});

test("a week with no day picked is Monday, not never", () => {
  assert.equal(cronOf({ kind: "weekly", days: [], hour: 8, minute: 0 }, ""), "0 8 * * 1");
});

test("a day of the month survives the round trip", () => {
  assert.deepEqual(parseRecur("0 9 15 * *"), { kind: "monthly", day: 15, hour: 9, minute: 0 });
  assert.equal(cronOf(parseRecur("0 9 15 * *"), ""), "0 9 15 * *");
});

test("anything the picker cannot say stays custom, cron and all", () => {
  for (const odd of ["*/7 2-5 * * *", "@daily", "0 8 * 1 *", "0 8 * * 1#2", "0 8 32 * *", "90 8 * * *"]) {
    assert.equal(parseRecur(odd).kind, "custom", `${odd} is not one of the four shapes`);
    assert.equal(cronOf(parseRecur(odd), odd), odd, `${odd} is handed back unchanged`);
  }
});

test("every frequency the picker offers has a shape behind it", () => {
  const kinds = FREQS.map((f) => f.kind);
  assert.deepEqual(kinds, ["hourly", "daily", "weekly", "monthly", "custom"]);
  for (const kind of kinds) {
    if (kind === "custom") continue;
    /* Typed as Recur rather than const-asserted: a readonly day list is not a
       number[], and the shape has to be one the picker could really hold. */
    const shape: Recur =
      kind === "hourly" ? { kind, minute: 0 }
        : kind === "weekly" ? { kind, days: [1], hour: 8, minute: 0 }
          : kind === "monthly" ? { kind, day: 1, hour: 8, minute: 0 }
            : { kind, hour: 8, minute: 0 };
    const cron = cronOf(shape, "");
    assert.equal(parseRecur(cron).kind, kind, `${kind} -> ${cron} -> ${kind}`);
  }
});

test("a time is written the way a time field wants it", () => {
  assert.equal(clock(8, 5), "08:05");
  assert.equal(clock(0, 0), "00:00");
  assert.equal(clock(23, 59), "23:59");
});

console.log(`\n${passed} passed`);
