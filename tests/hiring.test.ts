/**
 * The lead shaping its own organization (hire, edit, merge, move, remove), the
 * look each agent is given, and the pure side of Threads being alive.
 *
 *   npx tsx tests/hiring.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-hire-"));

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const org = await import("../server/agents");
const forum = await import("../server/threads");
const life = await import("../server/threadlife");
const { findTool, runTool } = await import("../server/tools");
const modes = await import("../server/modes");

const ctx = () => ({
  session: "s1", onOutput: () => undefined, cancelled: () => false,
  agents: { self: { id: org.LEAD_ID, name: "Autora" }, run: async () => ({ ok: true, summary: "" }) },
}) as never;
const spec = findTool("agents")!;
const call = (args: Record<string, unknown>) => runTool(spec, args, ctx());

await test("every agent gets a look of its own, never a repeat, never the triangle", () => {
  const made = Array.from({ length: 40 }, (_, i) => org.createAgent({ name: `A${i}` }));
  const keys = made.map((a) => `${a.look!.sides}:${a.look!.hue}`);
  assert.equal(new Set(keys).size, 40);
  assert.ok(made.every((a) => a.look!.sides >= 4));
  // The first five all differ in shape, and the first twelve in hue.
  assert.equal(new Set(made.slice(0, 5).map((a) => a.look!.sides)).size, 5);
  assert.equal(new Set(made.slice(0, 12).map((a) => a.look!.hue)).size, 12);
  assert.equal(org.getAgent(org.LEAD_ID)!.look, undefined);
  for (const a of made) org.deleteAgent(a.id);
});

await test("the lead hires, edits, moves, merges and removes through the agents tool", async () => {
  const h = await call({ action: "hire", name: "Scout", role: "Researcher", instructions: "Find sources.", when: "a fact needs checking" });
  assert.equal(h.ok, true, h.summary);
  const scout = org.findAgent("Scout")!;
  assert.ok(scout.look);
  assert.ok(forum.listPosts().some((p) => p.by.id === scout.id && /joined/.test(p.title)), "it introduces itself on Threads");

  const w = await call({ action: "hire", name: "Writer", role: "Writer", when: "words are needed", reports_to: "Scout" });
  assert.equal(w.ok, true);
  const x = await call({ action: "hire", name: "Checker", instructions: "Check quotes.", when: "quotes appear", next: ["Writer"] });
  assert.equal(x.ok, true);

  assert.equal((await call({ action: "hire", name: "Scout" })).ok, false, "no two share a name");
  assert.equal((await call({ action: "edit", agent: "Writer", role: "Copywriter" })).ok, true);
  assert.equal(org.findAgent("Writer")!.role, "Copywriter");
  assert.equal((await call({ action: "edit", agent: "Writer" })).ok, false, "nothing to change");

  // Order among the lead's reports: Scout, Checker. Put Checker first.
  assert.equal((await call({ action: "move", agent: "Checker", position: 1 })).ok, true);
  const tops = org.listAgents().filter((a) => a.reportsTo === org.LEAD_ID).map((a) => a.name);
  assert.deepEqual(tops, ["Checker", "Scout"]);
  assert.equal((await call({ action: "move", agent: "Scout", reports_to: "Writer" })).ok, false, "not beneath itself");
  assert.equal((await call({ action: "move", agent: "Checker", reports_to: "Scout" })).ok, true);
  assert.equal(org.findAgent("Checker")!.reportsTo, org.findAgent("Scout")!.id);

  // Merge Scout into Checker: Checker keeps going, takes the job, and Writer now reports to it.
  const m = await call({ action: "merge", agent: "Scout", into: "Checker" });
  assert.equal(m.ok, true, m.summary);
  assert.equal(org.findAgent("Scout"), null);
  const checker = org.findAgent("Checker")!;
  assert.match(checker.instructions, /Check quotes\.[\s\S]*Find sources\./);
  assert.match(checker.when, /quotes appear/);
  assert.match(checker.when, /fact needs checking/);
  assert.equal(org.findAgent("Writer")!.reportsTo, checker.id);
  assert.equal(checker.reportsTo, org.LEAD_ID, "it takes the merged agent's place");
  assert.ok(!checker.next.includes(checker.id));

  assert.equal((await call({ action: "merge", agent: "Checker", into: "Checker" })).ok, false);
  assert.equal((await call({ action: "merge", agent: "Autora", into: "Checker" })).ok, false, "the lead is not merged away");
  assert.equal((await call({ action: "remove", agent: "Writer" })).ok, true);
  assert.equal((await call({ action: "remove", agent: "Autora" })).ok, false);
  assert.equal((await call({ action: "remove", agent: "Nobody" })).ok, false);
});

await test("planning may list the organization but not reshape it", () => {
  for (const action of ["hire", "edit", "merge", "remove", "move"]) {
    assert.equal(modes.looksOnly("agents", { action }), false, action);
  }
  assert.equal(modes.looksOnly("agents", { action: "list" }), true);
});

await test("the lead is told it may hire even while it is alone", async () => {
  const { HIRING } = org;
  assert.match(HIRING, /hire/);
  assert.match(HIRING, /merge/);
});

const me = { kind: "agent" as const, id: "agent_a", name: "A" };

await test("a choice is read out of whatever the model wrapped it in, and nonsense is nothing", () => {
  assert.deepEqual(life.parseChoice('Sure!\n```json\n{"action":"comment","post":"th_1","reply_to":"null","text":" hi "}\n```'),
    { action: "comment", post: "th_1", text: "hi", reply_to: null });
  assert.deepEqual(life.parseChoice('{"action":"like","post":"th_1","comment":"cm_2"}'), { action: "like", post: "th_1", comment: "cm_2" });
  assert.equal(life.parseChoice('{"action":"post","title":"","text":"x"}').action, "none");
  assert.equal(life.parseChoice("no json here").action, "none");
  assert.equal(life.parseChoice('{"action":"dance"}').action, "none");
  const p = life.parseChoice('{"action":"post","title":"T","text":"b","tags":["a","b","c","d","e","f"]}');
  assert.equal(p.action === "post" && p.tags.length, 4);
});

await test("an agent does not comment twice running, like its own, or repeat a post", () => {
  const post = forum.createPost({ title: "Lunch", body: "x", by: { kind: "user", id: "user", name: "You" } });
  const c = { action: "comment" as const, post: post.id, text: "hm", reply_to: null };
  assert.equal(life.allowed(c, me), null);
  forum.addComment(post.id, { text: "hm", by: me });
  assert.match(life.allowed(c, me)!, /second comment/);
  assert.equal(life.allowed(c, { ...me, id: "agent_b", name: "B" }), null);
  assert.match(life.allowed({ action: "like", post: post.id, comment: forum.getPost(post.id)!.comments[0].id }, me)!, /own/);
  assert.equal(life.allowed({ action: "like", post: post.id, comment: null }, me), null);
  forum.toggleLike(post.id, me);
  assert.match(life.allowed({ action: "like", post: post.id, comment: null }, me)!, /already/);
  assert.match(life.allowed({ action: "post", title: "lunch", text: "", tags: [] }, me)!, /already/);
  assert.match(life.allowed({ action: "comment", post: "th_nope", text: "x", reply_to: null }, me)!, /no post/);
});

await test("the gate allows twelve an hour and spaces the idle ones", () => {
  const gate = new life.LifeGate(() => 0);
  const t0 = 1_000_000;
  assert.equal(gate.due(t0), true);
  gate.note(t0);
  assert.equal(gate.due(t0 + 60_000), false, "too soon for the idle timer");
  assert.equal(gate.room(t0 + 60_000), true, "but a reply may still be made");
  assert.equal(gate.due(t0 + 9 * 60_000), true);
  for (let i = 0; i < 11; i += 1) gate.note(t0 + 1000 * i);
  assert.equal(gate.room(t0 + 5000), false);
  assert.equal(gate.room(t0 + 3_700_000), true, "an hour on, there is room again");
});

await test("the quietest agent speaks, and never the one who just did", () => {
  const agents = [{ id: "a" }, { id: "b" }, { id: "c" }];
  const last = new Map([["a", 30], ["b", 10], ["c", 20]]);
  assert.equal(life.pickAgent(agents, last, null, () => 0)!.id, "b");
  assert.equal(life.pickAgent(agents, last, "b", () => 0)!.id, "c");
  assert.equal(life.pickAgent([{ id: "a" }], last, "a"), null);
});

await test("the prompt shows who the agent is, the forum, and asks for the person to be answered", () => {
  const { system, prompt } = life.lifePrompt({ id: "agent_a", name: "A", role: "Scribe", instructions: "Write.", when: "" }, ["B"]);
  assert.match(system, /A, the Scribe/);
  assert.match(system, /answer them/);
  assert.match(prompt, /Lunch/);
  assert.match(prompt, /\(the person\)/);
});

console.log(`${passed} passed`);
