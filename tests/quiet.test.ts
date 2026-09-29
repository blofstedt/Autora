/**
 * Quiet hours: the one thing in this console whose whole job is to say
 * nothing.
 *
 * Therefore the tests are mostly about what it must NOT do -- block a turn,
 * swallow a briefing, mute a window that nobody meant to set -- plus the
 * boundary arithmetic, which is easy to get wrong in both directions.
 *
 *   npx tsx tests/quiet.test.ts
 */
import assert from "node:assert/strict";

const quiet = await import("../server/quiet");
const { inQuiet, quietBriefing, mergeProactivity, parseTime, clockTime, DEFAULT_PROACTIVITY } = quiet;
type Proactivity = import("../server/quiet").Proactivity;

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

/** A local timestamp at hh:mm on a fixed day, in the machine's own clock. */
const at = (hh: number, mm = 0) => new Date(2026, 8, 27, hh, mm, 0, 0).getTime();

/* Written out rather than spread: spreading a Partial leaves every field
   optional-and-undefined, which the exact-optional setting in tsconfig.test
   refuses. */
const night = (over: Partial<Proactivity> = {}): Proactivity => ({
  quiet: over.quiet ?? true,
  from: over.from ?? 23 * 60,
  to: over.to ?? 7 * 60,
  wake: over.wake ?? false,
});

test("a window that wraps midnight holds the small hours and not the evening", () => {
  assert.equal(inQuiet(at(23, 0), night()), true, "the start is inside");
  assert.equal(inQuiet(at(3, 40), night()), true);
  assert.equal(inQuiet(at(6, 59), night()), true);
  assert.equal(inQuiet(at(7, 0), night()), false, "the end is outside");
  assert.equal(inQuiet(at(12, 0), night()), false);
  assert.equal(inQuiet(at(22, 59), night()), false);
});

test("a window inside one day does not wrap", () => {
  const nap = night({ from: 13 * 60, to: 14 * 60 + 30 });
  assert.equal(inQuiet(at(13, 30), nap), true);
  assert.equal(inQuiet(at(12, 59), nap), false);
  assert.equal(inQuiet(at(14, 30), nap), false);
  assert.equal(inQuiet(at(1, 0), nap), false, "the small hours are not this window");
});

test("off is off, and two equal times are not a 24-hour mute", () => {
  assert.equal(inQuiet(at(3, 0), night({ quiet: false })), false);
  assert.equal(inQuiet(at(3, 0), night({ from: 540, to: 540 })), false);
  assert.equal(quietBriefing(at(3, 0), night({ from: 540, to: 540 })), "", "nothing said about a window that is not one");
  assert.match(quiet.describe(night({ from: 540, to: 540 })), /no window/);
});

test("the times it is told about are the times it was given, and survive nonsense", () => {
  assert.equal(parseTime("23:30"), 1410);
  assert.equal(parseTime(1410), 1410);
  assert.equal(parseTime("not a time"), null);
  assert.equal(parseTime(-5), null);
  assert.equal(parseTime(1440), null);
  assert.equal(clockTime(1410), "23:30");
  assert.equal(clockTime(0), "00:00");

  const p = { ...DEFAULT_PROACTIVITY };
  mergeProactivity(p, { quiet: true, from: "22:15", to: 420 });
  assert.deepEqual(p, { quiet: true, from: 1335, to: 420, wake: false }, "wake is untouched by a patch that does not name it");
  mergeProactivity(p, { from: "nonsense", to: 99999, quiet: "yes please" });
  assert.deepEqual(p, { quiet: true, from: 1335, to: 420, wake: false }, "nothing was changed by nonsense");
  mergeProactivity(p, { wake: true });
  assert.equal(p.wake, true, "wake is settable on its own");
  mergeProactivity(p, { wake: "yes please" });
  assert.equal(p.wake, true, "a non-boolean wake leaves it alone");
});

test("inside the window it is told plainly, and told to start nothing", () => {
  const inside = quietBriefing(at(3, 40), night());
  assert.match(inside, /inside them now/);
  assert.match(inside, /start nothing new/);
  assert.match(inside, /23:00-07:00/);
});

test("outside the window it is a thing to plan around, not a rule to obey", () => {
  const outside = quietBriefing(at(14, 0), night());
  assert.ok(outside.length > 0, "said every turn, so it can plan around it");
  assert.doesNotMatch(outside, /inside them now/);
  assert.match(outside, /do not set a schedule or a watch to speak in that window/);
  assert.equal(quietBriefing(at(14, 0), night({ quiet: false })), "", "off says nothing at all");
});

console.log(`\n${passed} passed`);
