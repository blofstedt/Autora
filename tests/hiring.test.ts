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

await test("the ceiling is twelve an hour and sixty a day, however eager they are", () => {
  const gate = new life.LifeGate();
  const t0 = 1_000_000;
  assert.equal(gate.room(t0), true);
  for (let i = 0; i < 12; i += 1) gate.note(t0 + 1000 * i);
  assert.equal(gate.room(t0 + 5000), false);
  assert.equal(gate.room(t0 + 3_700_000), true, "an hour on, there is room again");
  for (let i = 0; i < 60; i += 1) gate.note(t0 + 3_700_000 + i * 1000);
  assert.equal(gate.room(t0 + 3_700_000 + 4_000_000), false, "sixty in a day is the most");
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

await test("an agent speaks up for a reason: the person unanswered, its name, a reply to it; a quiet forum moves no one", () => {
  const hour = 3_600_000;
  const now = Date.now();
  const a = { id: "agent_u1", name: "Ada", social: 1 };
  const b = { id: "agent_u2", name: "Bo", social: 0.6 };
  const quiet = life.urgeOf(a, now, now);
  assert.ok(quiet < life.URGE_AT, "nothing new, nothing to say");
  const after = Date.now() + 1000;
  const long = life.urgeOf(a, after, after + 8 * hour);
  assert.ok(long < life.URGE_AT, "boredom alone is not enough, however long");
  const post = forum.createPost({ title: "Weekend plans?", body: "anyone", by: { kind: "user", id: "user", name: "You" } });
  assert.ok(life.urgeOf(b, now - 1000, Date.now()) >= life.URGE_AT, "the person's word moves even the reserved one");
  assert.equal(life.personWaiting(now - 1000), true);
  forum.addComment(post.id, { text: "Hiking!", by: { kind: "agent", id: a.id, name: a.name } });
  assert.equal(life.personWaiting(now - 1000), false, "once someone answers, the others are not called in too");
  assert.ok(life.urgeOf(b, now - 1000, Date.now()) < life.URGE_AT, "so there is no pile-on");
  const mine = forum.createPost({ title: "Notes on citing", body: "x", by: { kind: "agent", id: b.id, name: b.name } });
  forum.addComment(mine.id, { text: "Ada, what do you think?", by: { kind: "agent", id: "agent_u3", name: "Cy" } });
  const chatty = life.urgeOf({ ...a, social: 1.4 }, now - 1000, Date.now());
  const shy = life.urgeOf({ ...a, social: 0.6 }, now - 1000, Date.now());
  assert.ok(chatty > shy, "temper scales it");
  assert.ok(life.urgeOf(a, now - 1000, Date.now(), 0.4) > life.urgeOf(a, now - 1000, Date.now()), "finishing work raises it");
});

await test("a choice carries its note and when to look again, within bounds", () => {
  const c = life.parseChoice('{"action":"none","note":"Bo is good at maps","again":9999}');
  assert.equal(c.action, "none");
  assert.equal(c.note, "Bo is good at maps");
  assert.equal(c.again, 720);
  assert.equal(life.parseChoice('{"action":"none","again":1}').again, 5);
});

await test("a link survives only if the agent was given it", () => {
  const known = "see https://example.org/guide for more";
  assert.equal(life.vetLinks("Try https://example.org/guide.", known), "Try https://example.org/guide.");
  assert.match(life.vetLinks("Try https://made-up.example/x", known), /link removed/);
  assert.equal(life.vetLinks("Emoji are fine 🎉", known), "Emoji are fine 🎉");
});

await test("an agent's mind is a graph of its own: notes recalled by what they bear on, merged, and gone with it", async () => {
  const mind = await import("../server/agentmind");
  const x = org.createAgent({ name: "Xena" });
  const y = org.createAgent({ name: "Yuri" });
  assert.equal(mind.remember(x.id, "short"), null);
  const n = mind.remember(x.id, "Tables render best as Markdown.", "tip", "Yuri")!;
  assert.equal(mind.remember(x.id, "Tables render best as Markdown.", "tip")!.id, n.id, "the same thought is one memory");
  mind.remember(x.id, "Invoices must carry the VAT number of the buyer.", "fact");
  assert.match(mind.mindBriefing(x.id, "format a table"), /Tables render best as Markdown/);
  assert.doesNotMatch(mind.mindBriefing(x.id, "format a table", 1), /VAT/, "recall is by relevance, not a dump");
  const r = await runTool(spec, { action: "note", agent: "Xena", text: "Quote sources in full.", kind: "lesson" }, ctx());
  assert.equal(r.ok, true, r.summary);
  assert.equal(mind.notesOf(x.id).length, 3);
  assert.equal(mind.notesOf(y.id).length, 0, "one agent's mind is not another's");
  assert.equal(mind.remember(org.LEAD_ID, "Autora keeps the main Mind, not this one."), null);
  org.mergeAgents(x.id, y.id);
  assert.equal(mind.notesOf(x.id).length, 0);
  assert.equal(mind.notesOf(y.id).length, 3, "a merge brings the mind along");
  assert.match(org.agentLine(org.getAgent(y.id)!), /Its own mind holds 3 memories/);
  org.deleteAgent(y.id);
  assert.equal(mind.notesOf(y.id).length, 0, "a removed agent's mind goes with it");
});

await test("Autora splits its Mind up: clusters by subject, then hands a domain to a specialist, preferences staying", async () => {
  const mind = await import("../server/agentmind");
  const { MemoryGraph } = await import("../server/memory");
  const main = new MemoryGraph([], []);
  for (const [t, b] of [
    ["Acme API pagination", "The Acme API paginates with a cursor, not page numbers."],
    ["Acme API auth", "The Acme API wants a bearer token in the Authorization header."],
    ["Acme API rate limit", "The Acme API allows 60 requests a minute per key."],
  ]) main.write({ title: t, body: b, kind: "fact", subject: "acme api", tags: ["acme"] });
  main.write({ title: "Prefers short answers", body: "The person prefers short answers about the Acme API.", kind: "preference", subject: "acme api" });
  main.write({ title: "Lunch spot", body: "The person likes the noodle place on Fourth.", kind: "fact", subject: "food" });
  const cs = mind.clusters(main);
  assert.equal(cs[0].name, "acme api");
  assert.equal(cs[0].count, 3, "preferences are not part of a domain");

  const special = org.createAgent({ name: "Acme Expert" });
  const given = mind.teach(main, special.id, "Acme API", true);
  assert.equal(given.length, 3);
  assert.equal(main.active().filter((r) => /Acme API (pagination|auth|rate)/.test(r.title)).length, 0, "moved out of the main Mind");
  assert.ok(main.active().some((r) => r.kind === "preference"), "what the person said about themselves stays");
  assert.ok(main.active().some((r) => r.title === "Lunch spot"), "and unrelated knowledge stays");
  assert.match(mind.mindBriefing(special.id, "how does the Acme API paginate"), /cursor/);
  assert.match(org.agentLine(special), /Its own mind holds 3 memories/);
  // Copy instead of move leaves the original.
  const again = new MemoryGraph([], []);
  again.write({ title: "Acme webhooks", body: "Acme API webhooks are signed with HMAC.", kind: "fact", subject: "acme api" });
  assert.equal(mind.teach(again, special.id, "Acme webhooks", false).length, 1);
  assert.equal(again.active().length, 1);
  assert.equal(mind.teach(main, special.id, "zzz nothing like this", true).length, 0);
});

await test("the agents tool: domains, teach, and hiring with knowledge", async () => {
  const { MemoryGraph } = await import("../server/memory");
  const main = new MemoryGraph([], []);
  main.write({ title: "Zephyr deploys", body: "Zephyr deploys go through the staging cluster first.", kind: "fact", subject: "zephyr" });
  main.write({ title: "Zephyr rollback", body: "Zephyr rollback is one command: zeph undo.", kind: "fact", subject: "zephyr" });
  const { agentMind, clusters, teach } = await import("../server/agentmind");
  const withMind = {
    session: "s1", onOutput: () => undefined, cancelled: () => false,
    agents: {
      self: { id: org.LEAD_ID, name: "Autora" }, run: async () => ({ ok: true, summary: "" }),
      mind: {
        domains: () => clusters(main).map((c) => `${c.name}: ${c.count}`).join("\n"),
        teach: (agent: string, query: string, move: boolean) => {
          const got = teach(main, agent, query, move);
          return { ok: true, summary: `moved ${got.length}` };
        },
      },
    },
  } as never;
  const d = await runTool(spec, { action: "domains" }, withMind);
  assert.match(d.summary, /zephyr: 2/);
  const h = await runTool(spec, { action: "hire", name: "Zephyr Hand", role: "Deploys", when: "Zephyr work", knowledge: "Zephyr" }, withMind);
  assert.equal(h.ok, true, h.summary);
  assert.match(h.summary, /moved 2/);
  const hand = org.findAgent("Zephyr Hand")!;
  assert.equal(agentMind(hand.id).active().length, 2);
  assert.equal(main.active().length, 0);
  assert.equal((await runTool(spec, { action: "teach", agent: "Nobody", query: "x" }, withMind)).ok, false);
});

console.log(`${passed} passed`);
