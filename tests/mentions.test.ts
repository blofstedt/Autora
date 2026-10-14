/**
 * @-mentions: finding the "@word" being typed, offering agents for it, putting the pick in the text, and the
 * server reading which agents a finished message addresses.
 *
 *   npx tsx tests/mentions.test.ts
 */
import assert from "node:assert/strict";
import { applyMention, mentionAt, mentionMatches } from "../src/lib/mentions";
import { mentionedAgents } from "../server/agents";

let passed = 0;
function test(name: string, fn: () => void) { fn(); passed += 1; console.log(`  ok  ${name}`); }

const agents = [
  { id: "agent_autora", name: "Autora", role: "Lead", enabled: true },
  { id: "agent_1", name: "Sabrina", role: "Family Lawyer", enabled: true },
  { id: "agent_2", name: "Tom", role: "Accountant", enabled: true },
  { id: "agent_3", name: "Tomas", role: "Translator", enabled: true },
  { id: "agent_4", name: "Ghost", role: "Retired", enabled: false },
];

test("the word after an @ just before the caret is the one being typed", () => {
  assert.deepEqual(mentionAt("hi @Sa", 6), { from: 3, query: "Sa" });
  assert.deepEqual(mentionAt("@", 1), { from: 0, query: "" });
  assert.deepEqual(mentionAt("line one\n@To", 12), { from: 9, query: "To" });
  assert.equal(mentionAt("hi @Sa and more", 15), null, "the caret has moved on");
  assert.deepEqual(mentionAt("hi @Sa and more", 6), { from: 3, query: "Sa" }, "but a caret in the middle still counts");
});

test("an address or a doubled @ is not a mention", () => {
  assert.equal(mentionAt("bob@Tom", 7), null);
  assert.equal(mentionAt("a.b@Tom", 7), null);
  assert.equal(mentionAt("@@To", 4), null);
  assert.equal(mentionAt("no at sign", 5), null);
});

test("names that start with it come first, then names and roles that contain it", () => {
  const offered = agents.filter((a) => a.enabled && a.id !== "agent_autora");
  assert.deepEqual(mentionMatches(offered, "to").map((a) => a.name), ["Tom", "Tomas"]);
  assert.deepEqual(mentionMatches(offered, "law").map((a) => a.name), ["Sabrina"], "a role finds it too");
  assert.deepEqual(mentionMatches(offered, "").map((a) => a.name), ["Sabrina", "Tom", "Tomas"], "a bare @ lists everyone");
  assert.deepEqual(mentionMatches(offered, "zzz"), []);
});

test("picking replaces the typed word with the whole name and a space", () => {
  assert.deepEqual(applyMention("hi @Sa", 6, 3, "Sabrina"), { text: "hi @Sabrina ", caret: 12 });
  assert.deepEqual(applyMention("hi @Sa there", 6, 3, "Sabrina"), { text: "hi @Sabrina there", caret: 12 }, "no double space");
});

test("the server reads who a message addresses: whole names only, enabled ones, never the lead", () => {
  const names = (t: string) => mentionedAgents(t, agents).map((a) => a.name);
  assert.deepEqual(names("@Sabrina, can you look at this lease?"), ["Sabrina"]);
  assert.deepEqual(names("ask @tom about tax, and @SABRINA about the lease"), ["Tom", "Sabrina"], "in the order named, whatever the case");
  assert.deepEqual(names("hey @Tomas"), ["Tomas"], "Tom is not Tomas");
  assert.deepEqual(names("hey @Tomasz"), [], "and not a longer word");
  assert.deepEqual(names("mail bob@Tom.com"), [], "an address is not a mention");
  assert.deepEqual(names("@Ghost are you there"), [], "a switched-off agent is not addressed");
  assert.deepEqual(names("@Autora do it"), [], "the lead is who is already being talked to");
  assert.deepEqual(names("no mention"), []);
});

console.log(`${passed} passed`);
