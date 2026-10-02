/**
 * When the agent speaks up about what you did, and what it may say.
 *
 *   npx tsx tests/companion.test.ts
 */
import assert from "node:assert/strict";
import { cleanRemark, GAP_MS, MAX_REMARK, PER_HOUR, remarkPrompt, RemarkGate, worthRemarking } from "../server/companion";
import type { Touch } from "../server/presence";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const touch = (kind: string, tell = true): Touch => ({ at: 0, surface: "pdf", subject: "a", kind, detail: kind, tell, told: false });

console.log("companion");

test("what changes something is worth a word; looking around is not", () => {
  for (const kind of ["move", "edit", "add", "remove", "click", "type", "navigate"]) assert.equal(worthRemarking([touch(kind)]), true, kind);
  for (const kind of ["select", "scroll", "hover", "drag"]) assert.equal(worthRemarking([touch(kind)]), false, kind);
  assert.equal(worthRemarking([]), false);
  assert.equal(worthRemarking([touch("scroll"), touch("move")]), true);
});

test("remarks are spaced out, and capped by the hour", () => {
  let t = 1_000_000;
  const gate = new RemarkGate(() => t);
  assert.equal(gate.allowed(), true);
  gate.made();
  t += GAP_MS - 1;
  assert.equal(gate.allowed(), false, "too soon");
  t += 2;
  assert.equal(gate.allowed(), true);
  for (let i = 0; i < PER_HOUR; i++) { gate.made(); t += GAP_MS + 1; }
  assert.equal(gate.allowed(), false, "an hour's worth already");
  t += 3_600_000;
  assert.equal(gate.allowed(), true, "an hour later");
});

test("the model's reply becomes one plain remark, or nothing", () => {
  assert.equal(cleanRemark("SKIP"), null);
  assert.equal(cleanRemark("skip."), null);
  assert.equal(cleanRemark("   "), null);
  assert.equal(cleanRemark('"Nice, I\'ll leave the signature where you put it."'), "Nice, I'll leave the signature where you put it.");
  assert.equal(cleanRemark("*Good catch on the date.*\nAnd more words on another line."), "Good catch on the date.");
  assert.equal(cleanRemark("Got it. I'll go on with page two."), "Got it. I'll go on with page two.");
});

test("a long reply is cut, at a sentence if it has one", () => {
  const long = `${"Word ".repeat(12).trim()}. ${"More ".repeat(60).trim()}`;
  const out = cleanRemark(long)!;
  assert.ok(out.length <= MAX_REMARK);
  assert.equal(out, `${"Word ".repeat(12).trim()}.`);
  assert.ok(cleanRemark("x".repeat(500))!.length <= MAX_REMARK);
});

test("the prompt carries what they asked, what the agent said, and what they just did", () => {
  const p = remarkPrompt({ request: "sign the lease", lastSaid: "Placing the signature now.", actions: ["moved the signature on page 1", "typed \"Ada\" into the name field"] });
  assert.match(p, /What they last asked you to do: sign the lease/);
  assert.match(p, /What you last said you were doing: Placing the signature now\./);
  assert.match(p, /- moved the signature on page 1/);
  assert.match(p, /or SKIP/);
  assert.doesNotMatch(remarkPrompt({ request: "", lastSaid: "", actions: ["x"] }), /last asked/);
});

console.log(`${passed} passed`);
