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
 * the planner actually ran. A planner or background model may be another
 * provider's, reached with that provider's own key, and falls back to the main
 * model (saying why) when that key is gone. An Organization agent's own model
 * replaces the main model for its chat, on its own provider when that can be
 * reached, says why when it cannot, and is never set on the lead. Anthropic is
 * sent tool ids it accepts, unique and paired, whoever made the calls.
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
  Escalation, MAX_ESCALATIONS, agentModelFor, backgroundTarget, conversationTargets, escalationNote, hasPlanner,
  targetName, workTarget,
} = await import("../server/roles");
const { state, resolveProvider } = await import("../server/state");
const { openTask, withTask, noteRound, closeTask, taskSummary } = await import("../server/taskledger");
const { anthropicMessages } = await import("../server/llm");
const { createAgent, updateAgent, getAgent, agentLine, LEAD_ID } = await import("../server/agents");

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

const main = { provider: "deepseek", key: "k-ds", baseUrl: "https://ds" };
const at = (model: string, provider = "deepseek") =>
  ({ provider, model, key: `k-${provider}`, baseUrl: `https://${provider}` });
const roles = (over: Partial<{ model: string; fastModel: string; planner: ReturnType<typeof at> | null; background: ReturnType<typeof at> | null }> = {}) => ({
  ...main, model: "cheap", fastModel: "", planner: null, background: null, ...over,
});
const model = (t: { model: string }) => t.model;

await test("no planner: every round is the main model's, as before roles", () => {
  const r = roles();
  assert.equal(hasPlanner(r), false);
  assert.equal(model(workTarget(r, "plan")), "cheap");
  assert.equal(model(workTarget(r, "build")), "cheap");
  /* Naming the main model again is no planner either. */
  assert.equal(hasPlanner(roles({ planner: at("cheap") })), false);
  /* The same id on another vendor is another model. */
  assert.equal(hasPlanner(roles({ planner: at("cheap", "openrouter") })), true);
});

await test("a planner plans and the main model builds, each with its own key", () => {
  const r = roles({ planner: at("claude-sonnet-4-5", "anthropic") });
  assert.equal(hasPlanner(r), true);
  assert.deepEqual(workTarget(r, "plan"), at("claude-sonnet-4-5", "anthropic"));
  assert.deepEqual(workTarget(r, "build"), { ...main, model: "cheap" });
  assert.equal(targetName(workTarget(r, "plan"), "deepseek", (id) => id.toUpperCase()), "claude-sonnet-4-5 (ANTHROPIC)");
  assert.equal(targetName(workTarget(r, "build"), "deepseek"), "cheap");
});

await test("background work keeps its old rule unless told otherwise", () => {
  assert.equal(model(backgroundTarget(roles())), "cheap");
  assert.equal(model(backgroundTarget(roles({ fastModel: "fast" }))), "fast");
  assert.deepEqual(backgroundTarget(roles({ fastModel: "fast", background: at("tiny", "openai") })), at("tiny", "openai"));
  /* The environment's override is a model of the main provider. */
  assert.deepEqual(backgroundTarget(roles({ background: at("tiny", "openai") }), " env-model "), { ...main, model: "env-model" });
  assert.equal(model(backgroundTarget(roles({ background: at("tiny") }), "  ")), "tiny");
});

await test("the context window counts every model that may answer, on its own provider", () => {
  const r = roles({ planner: at("smart", "anthropic") });
  const names = (list: { provider: string; model: string }[]) => list.map((t) => `${t.provider}/${t.model}`);
  assert.deepEqual(names(conversationTargets(r, "agent")), ["deepseek/cheap", "anthropic/smart"]);
  assert.deepEqual(names(conversationTargets(r, "plan")), ["deepseek/cheap", "anthropic/smart"]);
  /* Build mode never plans, so the planner's window does not bind it. */
  assert.deepEqual(names(conversationTargets(r, "build")), ["deepseek/cheap"]);
  assert.deepEqual(names(conversationTargets(r, "agent", "fast")), ["deepseek/cheap", "anthropic/smart", "deepseek/fast"]);
  assert.deepEqual(names(conversationTargets(roles(), "agent", "cheap")), ["deepseek/cheap"]);
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

await test("the settings carry the roles to the resolved provider, on any provider with a key", () => {
  state.provider = "deepseek";
  state.keys.deepseek = "sk-test";
  state.models.deepseek = "deepseek-flash";
  state.plannerModels.deepseek = "deepseek-v4-pro";
  state.backgroundModels.deepseek = "deepseek-flash";
  let r = resolveProvider();
  assert.equal(r.model, "deepseek-flash");
  assert.deepEqual(workTarget(r, "plan"), { provider: "deepseek", model: "deepseek-v4-pro", key: "sk-test", baseUrl: r.baseUrl });
  assert.equal(r.background?.model, "deepseek-flash");
  assert.deepEqual(r.roleProblems, []);

  /* The planner on Anthropic: reached with Anthropic's own key and address. */
  state.plannerProviders.deepseek = "anthropic";
  state.plannerModels.deepseek = "claude-sonnet-4-5";
  state.keys.anthropic = "sk-ant-test";
  r = resolveProvider();
  const plan = workTarget(r, "plan");
  assert.equal(plan.provider, "anthropic");
  assert.equal(plan.key, "sk-ant-test");
  assert.match(plan.baseUrl, /anthropic/);
  assert.equal(workTarget(r, "build").key, "sk-test", "the builder keeps DeepSeek's key");

  /* Anthropic's key removed: the main model plans, and Settings says why. */
  delete state.keys.anthropic;
  const before = { ...process.env };
  delete process.env.ANTHROPIC_API_KEY;
  r = resolveProvider();
  Object.assign(process.env, before);
  assert.equal(hasPlanner(r), false);
  assert.equal(workTarget(r, "plan").model, "deepseek-flash");
  assert.match(r.roleProblems.join(" "), /planner \(claude-sonnet-4-5\) is on Anthropic[^,]*, which has no key/);

  state.plannerProviders.deepseek = "";
  state.plannerModels.deepseek = "";
  assert.equal(workTarget(resolveProvider(), "plan").model, "deepseek-flash");
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

await test("an agent's own model builds its chat, on its own provider when it can be reached", () => {
  const active = roles({ model: "deepseek-flash", fastModel: "deepseek-flash", planner: at("deepseek-v4-pro") });
  const reach = (id: string) => (id === "openrouter" ? { key: "k-or", baseUrl: "https://or" } : null);
  const none = agentModelFor(active, { name: "Ada" }, reach);
  assert.equal(none.active, active, "no model of its own: Settings' choice, untouched");
  assert.equal(none.note, null);
  const own = agentModelFor(active, { name: "Ada", model: { provider: "deepseek", model: "deepseek-v4-pro" } }, reach);
  assert.equal(own.active.model, "deepseek-v4-pro");
  assert.equal(own.active.key, "k-ds");
  assert.deepEqual(own.active.planner, active.planner, "the planner stays Settings' own");
  const there = agentModelFor(active, { name: "Ada", model: { provider: "openrouter", model: "z-ai/glm" } }, reach);
  assert.deepEqual(
    [there.active.provider, there.active.model, there.active.key, there.active.baseUrl, there.active.fastModel],
    ["openrouter", "z-ai/glm", "k-or", "https://or", ""],
    "another provider's model, reached with that provider's key",
  );
  assert.equal(there.note, null);
  const lost = agentModelFor(active, { name: "Ada", model: { provider: "anthropic", model: "claude" } }, reach, (id) => id.toUpperCase());
  assert.equal(lost.active.model, "deepseek-flash", "a provider with no key is never called");
  assert.match(lost.note ?? "", /Ada's model \(claude\) is on ANTHROPIC, which has no key now, so it runs on deepseek-flash/);
  assert.equal(agentModelFor({ ...roles(), provider: "" }, { name: "Ada", model: { provider: "x", model: "y" } }, reach).note, null);
});

await test("Anthropic is sent tool ids it accepts: safe, unique, and paired with their results", () => {
  /* A history another vendor wrote: Gemini's ids repeat every round, and a gateway's carry a colon. */
  const messages = [
    { role: "user" as const, text: "go" },
    { role: "assistant" as const, calls: [{ id: "read_file-0", name: "read_file", args: { path: "a" } }] },
    { role: "tool" as const, replies: [{ id: "read_file-0", name: "read_file", result: "A", ok: true }] },
    { role: "assistant" as const, calls: [
      { id: "read_file-0", name: "read_file", args: { path: "b" } },
      { id: "functions.terminal:1", name: "terminal", args: { command: "ls" } },
    ] },
    { role: "tool" as const, replies: [
      { id: "functions.terminal:1", name: "terminal", result: "ls out", ok: true },
      { id: "read_file-0", name: "read_file", result: "B", ok: true },
    ] },
    { role: "assistant" as const, calls: [{ id: "toolu_01AbC", name: "read_file", args: {} }] },
    { role: "tool" as const, replies: [{ id: "toolu_01AbC", name: "read_file", result: "C", ok: true }] },
  ];
  const out = anthropicMessages({ provider: "anthropic", model: "m", key: "", baseUrl: "", system: "", messages });
  const uses = out.flatMap((m: any) => m.content.filter((b: any) => b.type === "tool_use"));
  const results = out.flatMap((m: any) => m.content.filter((b: any) => b.type === "tool_result"));
  const ids = uses.map((b: any) => b.id);
  assert.equal(new Set(ids).size, ids.length, "every id once");
  for (const id of ids) assert.match(id, /^[a-zA-Z0-9_-]+$/);
  assert.ok(ids.includes("toolu_01AbC"), "an id Anthropic made itself is left as it was");
  /* Each result answers the call it was made for. */
  const byId = new Map(uses.map((b: any) => [b.id, b]));
  const path = (r: any) => (byId.get(r.tool_use_id) as any)?.input?.path ?? (byId.get(r.tool_use_id) as any)?.input?.command;
  assert.deepEqual(results.map((r: any) => [r.content, path(r)]), [["A", "a"], ["ls out", "ls"], ["B", "b"], ["C", undefined]]);
});

await test("an agent's model is saved, cleared, checked, and never the lead's", () => {
  const ada = createAgent({ name: "Ada", role: "Coder", model: { provider: "deepseek", model: "deepseek-v4-pro" } });
  assert.deepEqual(getAgent(ada.id)?.model, { provider: "deepseek", model: "deepseek-v4-pro" });
  assert.match(agentLine(getAgent(ada.id)!), /Builds on deepseek-v4-pro\./, "the lead is told, to route work");
  updateAgent(ada.id, { role: "Senior coder" });
  assert.equal(getAgent(ada.id)?.model?.model, "deepseek-v4-pro", "an edit that does not mention it keeps it");
  updateAgent(ada.id, { model: null });
  assert.equal(getAgent(ada.id)?.model, undefined);
  assert.doesNotMatch(agentLine(getAgent(ada.id)!), /Builds on/);
  updateAgent(ada.id, { model: { provider: "deepseek", model: "  " } });
  assert.equal(getAgent(ada.id)?.model, undefined, "a blank model is the main model");
  assert.throws(() => updateAgent(ada.id, { model: "deepseek-v4-pro" }), /provider, model/);
  assert.throws(() => updateAgent(ada.id, { model: { provider: "", model: "m" } }), /which provider/);
  updateAgent(LEAD_ID, { model: { provider: "deepseek", model: "deepseek-v4-pro" } });
  assert.equal(getAgent(LEAD_ID)?.model, undefined, "the lead's model is Settings'");
});

console.log(`\n${passed} passed`);
