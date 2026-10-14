/**
 * Roles: which model does which part of the work, and when the work goes back
 * to the planner.
 *
 * Checked here: with no planner named, every round is the main model's, as
 * before; with one, planning rounds are the planner's and building rounds the
 * main model's; background work keeps its old rule (talk mode's model, else the
 * main one) unless a background model or the environment says otherwise; the
 * context window counts every model that may answer the conversation; stuck
 * signals hand the work back only in Agent mode, only while building, only to a
 * planner that is a different model, never in a spoken turn, and at most
 * MAX_ESCALATIONS times a turn; a project check has to fail twice in a row to
 * count; the settings round-trip and the task ledger records the pair only when
 * the planner actually ran.
 *
 *   npx tsx tests/roles.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-roles-"));
process.env.AUTORA_STATE_DIR = dir;

const {
  Escalation, MAX_ESCALATIONS, backgroundModelOf, conversationModels, escalationNote, hasPlanner, workModel,
} = await import("../server/roles");
const { state, resolveProvider } = await import("../server/state");
const { openTask, withTask, noteRound, closeTask, taskSummary } = await import("../server/taskledger");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const roles = (over: Partial<{ model: string; plannerModel: string; fastModel: string; backgroundModel: string }> = {}) => ({
  model: "cheap", plannerModel: "", fastModel: "", backgroundModel: "", ...over,
});

await test("no planner: every round is the main model's, as before roles", () => {
  const r = roles();
  assert.equal(hasPlanner(r), false);
  assert.equal(workModel(r, "plan"), "cheap");
  assert.equal(workModel(r, "build"), "cheap");
  /* Naming the main model again is no planner either. */
  assert.equal(hasPlanner(roles({ plannerModel: "cheap" })), false);
});

await test("a planner plans and the main model builds", () => {
  const r = roles({ plannerModel: "smart" });
  assert.equal(hasPlanner(r), true);
  assert.equal(workModel(r, "plan"), "smart");
  assert.equal(workModel(r, "build"), "cheap");
});

await test("background work keeps its old rule unless told otherwise", () => {
  assert.equal(backgroundModelOf(roles()), "cheap");
  assert.equal(backgroundModelOf(roles({ fastModel: "fast" })), "fast");
  assert.equal(backgroundModelOf(roles({ fastModel: "fast", backgroundModel: "tiny" })), "tiny");
  assert.equal(backgroundModelOf(roles({ backgroundModel: "tiny" }), " env-model "), "env-model");
  assert.equal(backgroundModelOf(roles({ backgroundModel: "tiny" }), "  "), "tiny");
});

await test("the context window counts every model that may answer", () => {
  const r = roles({ plannerModel: "smart" });
  assert.deepEqual(conversationModels(r, "agent"), ["cheap", "smart"]);
  assert.deepEqual(conversationModels(r, "plan"), ["cheap", "smart"]);
  /* Build mode never plans, so the planner's window does not bind it. */
  assert.deepEqual(conversationModels(r, "build"), ["cheap"]);
  assert.deepEqual(conversationModels(r, "agent", "fast"), ["cheap", "smart", "fast"]);
  assert.deepEqual(conversationModels(roles(), "agent", "cheap"), ["cheap"]);
});

const building = { work: "agent" as const, phase: "build" as const, planner: true, spoken: false };

await test("a stuck signal hands the work to the planner, once per signal", () => {
  const e = new Escalation();
  assert.equal(e.take(building), null, "nothing raised, nothing handed");
  e.signal("the loop watch saw it repeating itself");
  e.signal("a second reason does not replace the first");
  assert.equal(e.take(building), "the loop watch saw it repeating itself");
  assert.equal(e.count, 1);
  assert.equal(e.take(building), null, "the signal was used up");
});

await test("only Agent mode, only while building, only with a different planner, never spoken", () => {
  for (const at of [
    { ...building, work: "build" as const },
    { ...building, work: "plan" as const },
    { ...building, phase: "plan" as const },
    { ...building, planner: false },
    { ...building, spoken: true },
  ]) {
    const e = new Escalation();
    e.signal("stuck");
    assert.equal(e.take(at), null, JSON.stringify(at));
    /* A signal that could not be acted on is dropped, not saved for later. */
    assert.equal(e.take(building), null);
    assert.equal(e.count, 0);
  }
});

await test("at most MAX_ESCALATIONS times a turn", () => {
  const e = new Escalation();
  for (let i = 0; i < MAX_ESCALATIONS + 2; i += 1) {
    e.signal("stuck");
    const got = e.take(building);
    assert.equal(got !== null, i < MAX_ESCALATIONS, `escalation ${i + 1}`);
  }
  assert.equal(e.count, MAX_ESCALATIONS);
});

await test("a project check counts only when it fails twice in a row", () => {
  const e = new Escalation();
  e.check(false);
  assert.equal(e.take(building), null, "one failure is the normal fix-and-retry");
  e.check(true);
  e.check(false);
  assert.equal(e.take(building), null, "a pass in between starts the count again");
  e.check(false);
  assert.match(e.take(building) ?? "", /failed 2 times in a row/);
});

await test("the note names the planner and says when it is the last hand-back", () => {
  const note = escalationNote("several rounds changed nothing", "smart", 1);
  assert.match(note, /smart/);
  assert.match(note, /set_mode/);
  assert.doesNotMatch(note, /last time/);
  assert.match(escalationNote("x", "smart", 0), /last time/);
});

await test("the settings carry the roles to the resolved provider", () => {
  state.provider = "deepseek";
  state.keys.deepseek = "sk-test";
  state.models.deepseek = "deepseek-flash";
  state.plannerModels.deepseek = "deepseek-v4-pro";
  state.backgroundModels.deepseek = "deepseek-flash";
  const r = resolveProvider();
  assert.equal(r.model, "deepseek-flash");
  assert.equal(r.plannerModel, "deepseek-v4-pro");
  assert.equal(r.backgroundModel, "deepseek-flash");
  assert.equal(workModel(r, "plan"), "deepseek-v4-pro");
  state.plannerModels.deepseek = "";
  assert.equal(workModel(resolveProvider(), "plan"), "deepseek-flash");
});

await test("the task ledger keeps the pair only when both models worked", () => {
  const task = (rounds: [string, boolean][]) => {
    const id = openTask({ session: "s1", provider: "deepseek", model: "cheap", version: "1.0.0", automated: false });
    withTask(id, () => { for (const [model, planner] of rounds) noteRound(model, planner); });
    closeTask(id, "finished", 1);
    return id;
  };
  const plain = task([["cheap", false], ["cheap", false]]);
  const paired = task([["smart", true], ["cheap", false], ["smart", true]]);
  const planned = task([["smart", true]]);
  const summary = taskSummary();
  const row = (id: string | null) => summary.recent.find((r) => r.id === id)!;
  assert.deepEqual([row(plain).model, row(plain).planner], ["cheap", null]);
  assert.deepEqual([row(paired).model, row(paired).planner], ["cheap", "smart"]);
  /* A Plan-mode chat: the planner did all of it, so it is the planner's task alone. */
  assert.deepEqual([row(planned).model, row(planned).planner], ["smart", null]);
  /* Three cells: the builder alone, the pair, and the planner alone. */
  const cells = summary.cells.map((c) => `${c.planner ?? "-"}>${c.model}`).sort();
  assert.deepEqual(cells, ["->cheap", "->smart", "smart>cheap"]);
});

console.log(`\n${passed} passed`);
