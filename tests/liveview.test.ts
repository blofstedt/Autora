/**
 * Live view: one frame, in memory, and only while it is fresh.
 *
 * The interesting behaviour is all about what must NOT happen -- a frame kept
 * after the camera went away, a stale picture handed over as what is happening
 * now, a frame of the wrong kind or the wrong size accepted because it arrived
 * at the right URL. So most of this is about freshness and refusal.
 *
 *   npx tsx tests/liveview.test.ts
 */
import assert from "node:assert/strict";

const live = await import("../server/liveview");
const {
  FRAME_TTL_MS, MAX_FRAME_BYTES, clearFrame, forgetAll, frameImage, latestFrame,
  liveViewNote, liveViewOn, putFrame,
} = live;

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

const jpeg = (bytes = 64) => Buffer.alloc(bytes, 7);
const at = (ms: number) => 1_700_000_000_000 + ms;

test("a frame is the view, until it goes stale", () => {
  forgetAll();
  assert.equal(putFrame("s1", jpeg(), "image/jpeg", at(0)), true);
  assert.equal(liveViewOn("s1", at(500)), true);
  const frame = latestFrame("s1", at(500));
  assert.equal(frame?.mime, "image/jpeg");
  assert.equal(frame?.data.byteLength, 64);
  // A second of traffic keeps it alive indefinitely.
  putFrame("s1", jpeg(), "image/jpeg", at(1000));
  assert.equal(liveViewOn("s1", at(1000 + FRAME_TTL_MS - 1)), true);
});

test("past the grace window it is off, and the bytes are gone with it", () => {
  forgetAll();
  putFrame("s1", jpeg(), "image/jpeg", at(0));
  assert.equal(latestFrame("s1", at(FRAME_TTL_MS + 1)), null);
  // Dropped, not merely hidden: a device that comes back starts a new view.
  assert.equal(latestFrame("s1", at(10)), null);
});

test("the newest frame replaces the last, and there is never a second one", () => {
  forgetAll();
  putFrame("s1", jpeg(10), "image/jpeg", at(0));
  putFrame("s1", jpeg(99), "image/jpeg", at(100));
  assert.equal(latestFrame("s1", at(150))?.data.byteLength, 99);
});

test("one conversation's camera is not another's", () => {
  forgetAll();
  putFrame("s1", jpeg(), "image/jpeg", at(0));
  assert.equal(liveViewOn("s2", at(0)), false);
  assert.equal(latestFrame("s2", at(0)), null);
});

test("turning the view off ends it at once", () => {
  forgetAll();
  putFrame("s1", jpeg(), "image/jpeg", at(0));
  clearFrame("s1");
  assert.equal(liveViewOn("s1", at(0)), false, "not left to time out");
});

test("what is not a picture, or is not a frame, is refused", () => {
  forgetAll();
  assert.equal(putFrame("s1", jpeg(), "application/pdf", at(0)), false, "not a picture");
  assert.equal(putFrame("s1", Buffer.alloc(0), "image/jpeg", at(0)), false, "empty");
  assert.equal(putFrame("", jpeg(), "image/jpeg", at(0)), false, "no conversation");
  assert.equal(
    putFrame("s1", jpeg(MAX_FRAME_BYTES + 1), "image/jpeg", at(0)),
    false,
    "a stream that suddenly sends tens of megabytes is something else",
  );
  assert.equal(liveViewOn("s1", at(0)), false, "nothing kept from a refusal");
});

test("the frame travels as a picture the vendors accept", () => {
  forgetAll();
  putFrame("s1", jpeg(), "image/jpeg", at(0));
  const image = frameImage(latestFrame("s1", at(0))!);
  assert.equal(image?.mime, "image/jpeg");
  assert.equal(Buffer.from(image!.data, "base64").byteLength, 64);
});

test("the note says it is live, that it is the only frame, and how old", () => {
  forgetAll();
  putFrame("s1", jpeg(), "image/jpeg", at(0));
  const note = liveViewNote(latestFrame("s1", at(0))!, at(2500));
  assert.match(note, /live view is on/);
  assert.match(note, /newest frame from the person's camera/);
  assert.match(note, /3s old/);
  assert.match(note, /only frame/);
  assert.match(note, /camera_look/);
});

test("two conversations hold their own frame and neither leaks", () => {
  forgetAll();
  putFrame("s1", jpeg(11), "image/jpeg", at(0));
  putFrame("s2", jpeg(22), "image/jpeg", at(0));
  assert.equal(latestFrame("s1", at(0))?.data.byteLength, 11);
  assert.equal(latestFrame("s2", at(0))?.data.byteLength, 22);
  clearFrame("s1");
  assert.equal(liveViewOn("s1", at(0)), false);
  assert.equal(latestFrame("s2", at(0))?.data.byteLength, 22);
});

console.log(`\n${passed} passed`);
