/**
 * Whose cursor it is: Autora's own, or the agent of the Organization the chat belongs to -- read from the chat's log,
 * with the colours and the shape of that agent's mark.
 *
 *   npx tsx tests/cursorwho.test.ts
 */
import assert from "node:assert/strict";
import { glyphPoints, whoColors, whoFromEvents } from "../src/lib/cursorWho";
import { Kind, type AutoraEvent } from "../src/lib/types";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const ev = (seq: number, kind: string, payload: Record<string, any> = {}): AutoraEvent => ({ seq, ts: seq, kind, actor: "system", span: null, payload, blob: null });

test("a chat with no agent started in it is Autora's, in the theme's colours", () => {
  const w = whoFromEvents([ev(1, Kind.UserMessage, { text: "hi" })]);
  assert.equal(w.name, "Autora");
  assert.equal(w.look, null);
  assert.equal(whoColors(w), null, "no colours of its own: the page's accent variables carry it");
});

test("a chat an agent was started in is that agent's: its name, its shape, its colour", () => {
  const w = whoFromEvents([ev(1, Kind.Log, { event: "agent.started", name: "Sabrina", look: { sides: 5, hue: 200 } })]);
  assert.equal(w.name, "Sabrina");
  assert.deepEqual(w.look, { sides: 5, hue: 200 });
  const c = whoColors(w)!;
  assert.match(c.accent, /^#[0-9a-f]{6}$/);
  assert.match(c.rgb, /^\d+, \d+, \d+$/);
  assert.notEqual(whoColors({ name: "x", look: { sides: 5, hue: 20 } })!.accent, c.accent, "another hue is another colour");
});

test("a look that is not one is ignored rather than drawn badly", () => {
  assert.equal(whoFromEvents([ev(1, Kind.Log, { event: "agent.started", name: "Odd", look: { sides: 2, hue: "red" } })]).look, null);
});

test("the shape beside the name has as many corners as the agent's mark", () => {
  assert.equal(glyphPoints(3).split(" ").length, 3);
  assert.equal(glyphPoints(7).split(" ").length, 7);
  assert.equal(glyphPoints(1).split(" ").length, 3, "never fewer than a triangle");
});

console.log(`${passed} passed`);
