/**
 * The dot beside a chat in the list.
 *
 * It has meant three things, and only the last is right. It was green for
 * every chat, because "live" was set true when the chat was made and never
 * cleared. Then it was green for a chat a window had open, which is true of
 * whichever chat you are looking at and says nothing about the one you are
 * not. It now says the one thing worth reading at a glance in a list: the
 * agent is working in this chat. This test holds that line, because the rule
 * has drifted twice already -- and it is a rule the person stated, not a
 * preference of the code.
 *
 *   npx tsx tests/dot.test.ts
 */
import assert from "node:assert/strict";

const { sessionDot } = await import("../src/lib/derive");

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

console.log("the chat list dot");

test("a chat the agent is working in is green", () => {
  const dot = sessionDot({ busy: true });
  assert.equal(dot.className, "is-busy");
  assert.equal(dot.title, "Working now");
});

test("a chat nobody is working in is grey, however recently it was used", () => {
  for (const row of [{ busy: false }, { busy: false, live: true } as any, {}]) {
    const dot = sessionDot(row);
    assert.equal(dot.className, "is-idle", "not green");
    assert.equal(dot.title, "Nothing running");
  }
});

test("green means working and nothing else -- being open in a window is not enough", () => {
  // The exact row shape the server sends for a chat a window has open but no
  // turn is running in: live true, busy false. It must not be green.
  // A variable, not a literal: the call sites pass whole session rows, which
  // carry fields this helper does not read.
  const open: { busy?: boolean; live?: boolean } = { busy: false, live: true };
  assert.equal(sessionDot(open).className, "is-idle");
  // ...and the busy chat with no window on it is still green: the work is what
  // the colour reports.
  const workingNoWindow: { busy?: boolean; live?: boolean } = { busy: true, live: false };
  assert.equal(sessionDot(workingNoWindow).className, "is-busy");
});

console.log(`\n${passed} passed`);
