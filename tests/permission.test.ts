/**
 * One approval, one card.
 *
 * The request was rendered twice -- a cell in the thread where the call
 * happened, and the strip above the message box -- and each of them carried
 * Deny and Allow. Two cards with two sets of buttons for one question read as
 * the console asking twice, which is what the person saw.
 *
 * So the thread cell is the record: it says what was asked, shows the exact
 * command, and points at the card that answers it. These tests hold that line
 * -- and hold the exception, a prompt that wants a value, which the strip has
 * nowhere to type and so is still answered in the thread.
 *
 *   npx tsx tests/permission.test.ts
 */
import assert from "node:assert/strict";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { PermissionCell } from "../src/components/PermissionCell";
import type { PermissionPrompt } from "../src/lib/derive";

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

function draw(prompt: PermissionPrompt): string {
  return renderToStaticMarkup(
    createElement(PermissionCell, { prompt, onDecide: () => {}, readOnly: false }),
  );
}

/** A plain yes/no request, which is everything the server raises today. */
const asked = (over: Partial<PermissionPrompt> = {}): PermissionPrompt => ({
  requestId: over.requestId ?? "req-1",
  tool: over.tool ?? "terminal",
  rendered: over.rendered ?? "rm -rf build",
  reason: over.reason ?? "This chat is in Ask mode: looking is free, and anything that changes something waits for you.",
  settled: over.settled ?? false,
  ...(over.inputType ? { inputType: over.inputType } : {}),
  ...(over.choices ? { choices: over.choices } : {}),
  ...(over.approved === undefined ? {} : { approved: over.approved }),
  ...(over.response === undefined ? {} : { response: over.response }),
});

test("a plain request in the thread carries no buttons of its own", () => {
  const html = draw(asked());
  /* The words on it do name the buttons above -- that is the pointer. What it
     must not have is controls of its own. */
  assert.equal(html.includes("<button"), false, "the record must not be a second set of controls");
  assert.equal(html.includes("btn allow"), false);
  assert.equal(html.includes("btn deny"), false);
});

test("it still shows what was asked, and points at the card that answers it", () => {
  const html = draw(asked({ tool: "terminal", rendered: "rm -rf build" }));
  assert.ok(html.includes("Approval needed"));
  assert.ok(html.includes("rm -rf build"), "the exact command is the point of the record");
  assert.ok(html.includes("above the message box"));
});

test("the reason is kept, so the record reads on its own", () => {
  const html = draw(asked({ reason: "This is irreversible. Nothing else in this console waits for an answer." }));
  assert.ok(html.includes("Nothing else in this console waits for an answer."));
});

test("a prompt that wants a value is still answered in the thread", () => {
  // The strip has Deny and Run it and nowhere to type, so this kind stays here.
  const text = draw(asked({ inputType: "text" }));
  assert.ok(text.includes("<button"), "a text prompt keeps its own controls");
  assert.ok(text.includes("<input"));

  const choice = draw(asked({ inputType: "choice", choices: ["yes", "no"] }));
  assert.ok(choice.includes("<button"));
  assert.ok(choice.includes("yes"));
});

test("once answered it is the outcome, and only the outcome", () => {
  const allowed = draw(asked({ settled: true, approved: true }));
  assert.equal(allowed.includes("<button"), false);
  assert.ok(allowed.includes("You allowed it"));

  const denied = draw(asked({ settled: true, approved: false }));
  assert.ok(denied.includes("You declined it"));
  assert.equal(denied.includes("You allowed it"), false);
});

console.log(`\n${passed} passed`);
