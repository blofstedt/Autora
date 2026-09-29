/**
 * Dictation hands each spoken word over once, however the engine reports it.
 *
 *   npx tsx tests/voice.test.ts
 */
import assert from "node:assert/strict";
import {
  chooseVoice, commit, fetchSpeechStatus, newLedger, newSpeechLine, sentences, streamParts,
  turnPause,
} from "../src/lib/voice";

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

/** Feed finals through one ledger, `gap` ms apart, and join what went out. */
function run(finals: string[], gap = 300): string {
  const ledger = newLedger();
  let now = 1_000_000;
  const out: string[] = [];
  for (const text of finals) {
    now += gap;
    const fresh = commit(ledger, text, now);
    if (fresh) out.push(fresh);
  }
  return out.join(" ");
}

test("Android staircase: each step holds the whole utterance so far", () => {
  assert.equal(
    run(["this", "this is", "this is", "this is a", "this is a test",
      "this is a test to see", "this is a test to see what you can do"]),
    "this is a test to see what you can do",
  );
});

test("a final that re-punctuates what went out adds only the new words", () => {
  assert.equal(run(["this is just", "This is just a test."]), "this is just a test.");
});

test("a word walked back and restated is not said twice", () => {
  assert.equal(run(["testing 1 2", "testing 1", "testing 1 2 3"]), "testing 1 2 3");
});

test("a restart replaying the utterance from the top adds nothing", () => {
  assert.equal(run(["open the file", "open the file"]), "open the file");
});

test("two requests that start alike both go out whole", () => {
  assert.equal(run(["Open the file", "Open the folder"], 2500), "Open the file Open the folder");
});

test("separate phrases are kept", () => {
  assert.equal(run(["hello there", "how are you"], 2000), "hello there how are you");
});

test("the same word said again later is not swallowed", () => {
  assert.equal(run(["yes", "yes"], 6000), "yes yes");
});

test("live chat waits through a normal breath before sending", () => {
  assert.ok(turnPause("open my email", true) >= 2000);
  assert.ok(turnPause("open my email", false) > turnPause("open my email", true));
});

test("a reply that fits is one request, so one rendering holds the voice", () => {
  assert.deepEqual(streamParts("One sentence. And another, shorter one."), [
    "One sentence. And another, shorter one.",
  ]);
  assert.deepEqual(streamParts("   "), []);
});

test("only what one request cannot carry is split, and on sentence ends", () => {
  const long = Array.from({ length: 40 }, (_, i) => `Sentence number ${i} says something brief.`).join(" ");
  const parts = streamParts(long);
  assert.ok(parts.length > 1);
  assert.equal(parts.join(" "), long);
  for (const part of parts) {
    assert.ok(part.length <= 1200, `${part.length} characters in one request`);
    assert.match(part, /\.$/, "the break falls where a sentence ends");
  }
});

test("a sentence left hanging waits longer", () => {
  assert.ok(turnPause("open my email and", true) > turnPause("open my email", true));
  assert.ok(turnPause("find the", false) > turnPause("find it", false));
  assert.ok(turnPause("so first, um", true) > turnPause("so first done", true));
  assert.ok(turnPause("check the calendar,", true) > turnPause("check the calendar", true));
});

/**
 * The line every rendering speaks in.
 *
 * This is where the chopping and the two voices at once came from. The
 * streamed rendering is handed to one audio timeline, and a second rendering
 * started before the first had finished put its own words into the same
 * timeline in whatever order its chunks came back -- and the fallbacks (a clip
 * through the element, the browser's own voice) played on a timeline of their
 * own, on top of it. The line is the rule that only one of them is ever being
 * heard: whatever joins waits for what joined before it.
 *
 * Awaited here and the assertions handed to test() as plain values, because
 * test() is synchronous on purpose (see the top of this file).
 */
async function lineChecks() {
  const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

  // One at a time, in the order they joined.
  const order: string[] = [];
  const line = newSpeechLine();
  const first = line.join(async () => {
    order.push("first:start");
    await sleep(40);
    order.push("first:end");
  });
  const second = line.join(() => { order.push("second"); });
  const early = order.includes("second");
  await Promise.all([first, second]);
  const leftWaiting = line.waiting();

  // A rendering that fails is reported to its caller, and the line stays open.
  const afterFailure: string[] = [];
  const failing = newSpeechLine();
  const failure = await failing
    .join(() => { throw new Error("speech 500"); })
    .then(() => "said nothing about it", (err: Error) => err.message);
  await failing.join(() => { afterFailure.push("next"); });

  // A barge-in drops what was waiting, and does not hold the next rendering
  // behind words that are no longer wanted.
  const said: string[] = [];
  const hushed = newSpeechLine();
  let release = () => {};
  const inFlight = hushed.join(() => new Promise<void>((resolve) => {
    release = resolve;
    said.push("in flight");
  }));
  const dropped = hushed.join(() => { said.push("dropped"); });
  // Let the first one actually start: a barge-in drops what was waiting, and
  // a rendering that had not begun is waiting like any other.
  await sleep(10);
  hushed.reset();
  const next = await Promise.race([
    hushed.join(() => { said.push("new"); }).then(() => "ran"),
    sleep(60).then(() => "waited"),
  ]);
  release();
  await Promise.all([inFlight, dropped]);
  // The tally is written a microtask after the rendering finishes.
  await sleep(10);

  return {
    order: order.join(","), early, leftWaiting, failure,
    afterFailure: afterFailure.join(","), said: said.join(","), next,
    waitingAfterReset: hushed.waiting(),
    startedBeforeReset: said.includes("in flight"),
  };
}

const lineHop = await lineChecks();

test("renderings come out one at a time, in the order they joined", () => {
  assert.equal(lineHop.order, "first:start,first:end,second");
  assert.equal(lineHop.early, false);
  assert.equal(lineHop.leftWaiting, 0);
});

test("a rendering that fails reaches its caller and leaves the line open", () => {
  assert.equal(lineHop.failure, "speech 500");
  assert.equal(lineHop.afterFailure, "next");
});

test("a barge-in drops what was waiting and does not wait on the old words", () => {
  assert.equal(lineHop.said, "in flight,new");
  assert.equal(lineHop.next, "ran");
  assert.equal(lineHop.startedBeforeReset, true);
  assert.equal(lineHop.waitingAfterReset, 0);
});

/**
 * The panel's two calls into the console: which voice is there, and choosing
 * one. Both are answered by a stub -- the point is what the page does with a
 * refusal, which is the case that would otherwise be silent. The calls are
 * awaited here and the assertions handed to test() as plain values, because
 * test() is synchronous on purpose (see the top of this file).
 */
const realFetch = globalThis.fetch;

test("the service is handed a sentence at a time, not the whole reply", () => {
  assert.deepEqual(
    sentences("I opened the page. It has three results! Want the first one?"),
    ["I opened the page.", "It has three results!", "Want the first one?"],
  );
});

test("decimals, abbreviations and initials do not end a sentence", () => {
  assert.deepEqual(
    sentences("Version 3.5 is out, e.g. on the site. Ask J. Smith about it."),
    ["Version 3.5 is out, e.g. on the site.", "Ask J. Smith about it."],
  );
});

test("a word on its own rides along rather than costing a clip", () => {
  assert.deepEqual(sentences("Done. The file is saved in your notes."), ["Done. The file is saved in your notes."]);
  assert.deepEqual(sentences("The file is saved in your notes. Done."), ["The file is saved in your notes. Done."]);
  assert.deepEqual(sentences("OK."), ["OK."]);
});

test("a sentence that runs on is broken at a comma, not left to render whole", () => {
  const long = `${"word ".repeat(30).trim()}, ${"more ".repeat(30).trim()}, and the end.`;
  const pieces = sentences(long);
  assert.ok(pieces.length >= 2);
  assert.equal(pieces.join(" "), long);
});

test("line breaks end a piece, and nothing is lost or said twice", () => {
  const text = "First line with no stop\nSecond line here. Third one comes last";
  assert.deepEqual(sentences(text), ["First line with no stop", "Second line here.", "Third one comes last"]);
  assert.deepEqual(sentences("   "), []);
});

async function consoleCalls() {
  const paths: { url: string; body: any }[] = [];
  const reply = (status: number, body: any) => (async (input: any, init: any) => {
    paths.push({ url: String(input), body: init?.body ? JSON.parse(String(init.body)) : null });
    return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
  }) as typeof fetch;

  globalThis.fetch = reply(200, {
    available: true, voice: "af_heart", voices: [{ id: "af_heart", label: "af_heart — A" }],
    provider: "deepgram" as const, reason: null, url: "https://api.deepgram.com",
  });
  const status = await fetchSpeechStatus();
  const asked = paths[0];

  globalThis.fetch = reply(200, {});
  const saved = await chooseVoice("am_michael");
  const chosen = paths.at(-1);

  globalThis.fetch = reply(400, { detail: 'The service has no voice called "nope".' });
  const refused = await chooseVoice("nope");

  globalThis.fetch = (async () => { throw new Error("offline"); }) as typeof fetch;
  const offlineStatus = await fetchSpeechStatus();
  const offlineChoice = await chooseVoice("af_heart");

  test("the console is asked which voice it has", () => {
    assert.equal(status?.available, true);
    assert.equal(status?.voice, "af_heart");
    assert.equal(asked?.url, "/api/speech");
  });

  test("a voice is saved where every device can see it", () => {
    assert.equal(saved.ok, true);
    assert.equal(chosen?.url, "/api/settings");
    assert.deepEqual(chosen?.body, { speech: { voice: "am_michael" } });
  });

  test("a voice the console refuses comes back with the reason, not as a shrug", () => {
    assert.equal(refused.ok, false);
    assert.match(String(refused.detail), /no voice called/);
  });

  test("a console that cannot be reached answers nothing, without throwing", () => {
    assert.equal(offlineStatus, null);
    assert.equal(offlineChoice.ok, false);
  });

  console.log(`voice: ${passed} passed`);
}

void (async () => {
  await consoleCalls();
})().finally(() => { globalThis.fetch = realFetch; });
