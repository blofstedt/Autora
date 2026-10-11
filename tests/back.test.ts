/**
 * What the back gesture does.
 *
 * Back steps back inside Autora -- a card closes, a page returns to the chat --
 * and at the chat itself it leaves the app. It does not go to the Umbrel
 * dashboard: back once meant "leave for https://<host>/", which took the person
 * out of the app and onto a page they had not asked for.
 *
 *   npm test
 */
import assert from "node:assert/strict";
import { backAction } from "../src/lib/back";

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL  ${name}`);
    throw err;
  }
}

test("a card or drawer on top closes first, whatever the app would do", () => {
  assert.equal(backAction(true, false), "close-layer");
  assert.equal(backAction(true, true), "close-layer");
});

test("with nothing on top, back steps back a screen", () => {
  assert.equal(backAction(false, true), "step-back");
});

test("at the chat there is nothing to step back to, so back leaves the app", () => {
  assert.equal(backAction(false, false), "leave-app");
});

test("there is no action that goes to the dashboard", () => {
  // Every combination: none of them is a navigation, so none of them is the
  // dashboard. A fourth action would have to be added here to bring it back.
  for (const layer of [true, false]) {
    for (const stepped of [true, false]) {
      assert.ok(["close-layer", "step-back", "leave-app"].includes(backAction(layer, stepped)));
    }
  }
});

console.log(`${passed} passed`);
