/**
 * What the person asked for, kept whole: listed asks are split, changes land
 * in place, nothing is lost, and the agent is told what is still open.
 *
 *   npx tsx tests/requirements.test.ts
 */
import assert from "node:assert/strict";
import {
  addRequirements, amendmentNote, applyRequirements, autoAsks, describeRequirements, finishAudit,
  latestRequirements, openRequirements, requirementsBriefing, splitAsks, type RequirementList,
} from "../server/requirements";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const empty: RequirementList = { items: [] };

console.log("requirements");

test("a numbered or bulleted message becomes its items, in the person's words", () => {
  const asks = splitAsks("Please do these:\n1. add a dark mode toggle\n2) fix the login redirect\n   when the session has expired\n- remove the old banner");
  assert.deepEqual(asks, ["add a dark mode toggle", "fix the login redirect when the session has expired", "remove the old banner"]);
});

test("prose, or a single item, is not split: asks are not made up", () => {
  assert.deepEqual(splitAsks("Add a toggle and also fix the redirect, then clean up"), []);
  assert.deepEqual(splitAsks("1. only one thing"), []);
});

test("a first plain request is left to the agent; a change during work is kept whole", () => {
  assert.deepEqual(autoAsks("build me a todo app", empty, false), []);
  assert.deepEqual(autoAsks("also make the header sticky", empty, true), ["also make the header sticky"]);
  const open = addRequirements(empty, ["build the app"], "request");
  assert.deepEqual(autoAsks("and use tabs, not spaces", open, false), ["and use tabs, not spaces"]);
  assert.deepEqual(autoAsks("thanks!", open, true), [], "chatter is not a requirement");
  assert.deepEqual(autoAsks("ok", open, true), []);
});

test("ids are never reused and the same open ask is not added twice", () => {
  let list = addRequirements(empty, ["a", "b"], "request");
  list = applyRequirements(list, { drop: [{ id: "R2", why: "changed mind" }] }).list!;
  list = addRequirements(list, ["c", "A"], "amend");
  assert.deepEqual(list.items.map((r) => r.id), ["R1", "R2", "R3"], "A repeats R1 while it is open");
});

test("the tool adds, edits, finishes, drops and reopens, and says what it could not do", () => {
  let list = applyRequirements(empty, { add: ["dark mode", "fix redirect", "remove banner"] }).list!;
  assert.equal(list.items.length, 3);
  const r = applyRequirements(list, {
    edit: [{ id: "R1", text: "dark mode, following the system setting" }],
    done: [{ id: "R2", how: "tested the redirect by hand" }],
    drop: [{ id: "R3", why: "the person no longer wants it" }],
  });
  list = r.list!;
  assert.equal(list.items[0].text, "dark mode, following the system setting");
  assert.equal(list.items[1].status, "done");
  assert.equal(list.items[1].note, "tested the redirect by hand");
  assert.equal(list.items[2].status, "dropped");
  assert.deepEqual(openRequirements(list).map((x) => x.id), ["R1"]);
  const bad = applyRequirements(list, { done: [{ id: "R9" }], reopen: ["R3"] });
  assert.match(bad.summary, /Not applied: done: no requirement "R9"/);
  assert.equal(bad.list!.items[2].status, "open");
  assert.match(applyRequirements(empty, {}).summary, /No requirements/);
});

test("it is read back from the log as the last update wrote it", () => {
  const list = addRequirements(empty, ["a thing"], "request");
  const read = latestRequirements([
    { kind: "requirements.update", payload: { items: [] } },
    { kind: "turn.user", payload: {} },
    { kind: "requirements.update", payload: list as any },
  ]);
  assert.equal(read.items[0].text, "a thing");
  assert.deepEqual(latestRequirements([]).items, []);
});

test("the briefing names what is open word for word, and counts the rest", () => {
  let list = addRequirements(empty, ["keep the exact wording: 'Save & close'", "second"], "request");
  list = addRequirements(list, ["third, added later"], "amend");
  list = applyRequirements(list, { done: [{ id: "R2", how: "ok" }] }).list!;
  const brief = requirementsBriefing(list)!;
  assert.match(brief, /R1: keep the exact wording: 'Save & close'/);
  assert.match(brief, /R3 \(added later\): third, added later/);
  assert.doesNotMatch(brief, /R2:/);
  assert.match(brief, /1 done, 0 dropped/);
  assert.equal(requirementsBriefing(empty), null);
});

test("the finish audit lists only what is open, and is silent when nothing is", () => {
  const list = applyRequirements(addRequirements(empty, ["one", "two"], "request"), { done: [{ id: "R1", how: "x" }] }).list!;
  const audit = finishAudit(list)!;
  assert.match(audit, /R2: two/);
  assert.doesNotMatch(audit, /R1: one/);
  assert.equal(finishAudit(applyRequirements(list, { drop: ["R2"] }).list!), null);
});

test("the note for a message sent mid-work says the agent was not stopped and what to do", () => {
  const note = amendmentNote(["also add tests", "and skip the docs"]);
  assert.match(note, /these while you were working -- you were not stopped/);
  assert.match(note, /"also add tests"/);
  assert.match(note, /requirements tool/);
  assert.match(describeRequirements(empty), /No requirements/);
});

test("a long list drops finished items first, never open ones", () => {
  let list = empty;
  for (let i = 0; i < 70; i += 1) list = addRequirements(list, [`ask number ${i}`], "request");
  assert.equal(list.items.length, 70, "all open: nothing may go");
  list = applyRequirements(list, { done: list.items.slice(0, 20).map((r) => ({ id: r.id, how: "x" })) }).list!;
  list = addRequirements(list, ["one more"], "amend");
  assert.ok(list.items.length <= 71);
  assert.ok(openRequirements(list).length >= 51);
});

console.log(`${passed} passed`);
