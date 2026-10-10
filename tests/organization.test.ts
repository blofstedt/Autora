/**
 * The organization (agents and how they fit together) and Threads (where they
 * post, comment and like), the tools that reach both, and the routes the pages use.
 *
 *   npx tsx tests/organization.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-org-"));

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const org = await import("../server/agents");
const forum = await import("../server/threads");
const { findTool, runTool } = await import("../server/tools");
const modes = await import("../server/modes");
const { FAMILIES } = await import("../server/toolload");

const lead = org.getAgent(org.LEAD_ID)!;

await test("the organization starts as the lead alone, and the lead cannot be removed or moved", () => {
  assert.equal(org.listAgents().length, 1);
  assert.equal(lead.name, "Autora");
  assert.equal(lead.reportsTo, null);
  assert.throws(() => org.deleteAgent(org.LEAD_ID), /lead cannot be removed/);
  org.updateAgent(org.LEAD_ID, { reportsTo: "agent_nope", enabled: false });
  assert.equal(org.getAgent(org.LEAD_ID)!.reportsTo, null);
  assert.equal(org.getAgent(org.LEAD_ID)!.enabled, true);
  assert.equal(org.orgBriefing(), "", "nothing to say while it is only the lead");
});

const research = org.createAgent({ name: "Researcher", role: "Finds sources", when: "a claim needs checking", instructions: "Cite everything." });
const editor = org.createAgent({ name: "Editor", role: "Tightens prose", reportsTo: research.id, next: [] });
const books = org.createAgent({ name: "Bookkeeper", next: "Researcher, Editor" });

await test("an agent has a personality drawn from its expertise, which a hirer or the person can override", () => {
  const lawyer = org.createAgent({ name: "Sabrina", role: "Family Lawyer" });
  assert.match(lawyer.personality!, /Careful and precise/);
  assert.ok(lawyer.traits!.rigor >= 80 && lawyer.traits!.humor <= 45, "a lawyer is exacting and not a joker");
  const helper = org.createAgent({ name: "Joy", role: "Customer Support" });
  assert.ok(helper.traits!.warmth >= 80, "support is warm");
  const own = org.createAgent({ name: "Wren", role: "Family Lawyer", personality: "Gentle but firm.", traits: { warmth: 95, nonsense: 5, candor: 400 } });
  assert.equal(own.personality, "Gentle but firm.");
  assert.equal(own.traits!.warmth, 95);
  assert.equal(own.traits!.candor, 100, "clamped");
  assert.ok(!("nonsense" in own.traits!));
  const edited = org.updateAgent(own.id, { traits: { humor: 80 } });
  assert.equal(edited.traits!.humor, 80);
  assert.equal(edited.traits!.warmth, 95, "the rest stay");
  assert.equal(org.freshName().length > 0, true);
  assert.ok(!org.listAgents().some((a) => a.name === org.freshName()), "a free name");
  assert.equal(research.personality ? true : false, true, "agents made without one are given one");
  assert.match(org.agentBrief(lawyer, "Review the lease", []), /Your personality: Careful and precise/);
  for (const a of [lawyer, helper, own]) org.deleteAgent(a.id);
});

await test("agents get along better the more work between them goes well, and worse when it does not", () => {
  const a = org.createAgent({ name: "Ana", role: "Researcher" });
  const b = org.createAgent({ name: "Ben", role: "Editor" });
  assert.equal(org.bondOf(a.id, b.id), 50);
  const team0 = a.traits!.teamwork;
  org.recordCollab(a.id, b.id, true, 6);
  const one = org.bondOf(a.id, b.id);
  assert.ok(one > 50 && org.bondOf(b.id, a.id) === one, "both remember it");
  for (let i = 0; i < 60; i++) org.recordCollab(a.id, b.id, true, 6);
  const many = org.bondOf(a.id, b.id);
  assert.ok(many > one && many < 100, "it keeps rising, with diminishing returns");
  assert.ok(a.traits!.teamwork > team0, "and they become better collaborators");
  org.recordCollab(a.id, b.id, false, 6);
  assert.ok(org.bondOf(a.id, b.id) < many, "a bad time costs a little");
  org.recordCollab(org.LEAD_ID, a.id, true, 6);
  assert.equal(org.getAgent(org.LEAD_ID)!.bonds, undefined, "the lead keeps none");
  org.recordWork(a.id, true); org.recordWork(a.id, false);
  assert.deepEqual(a.tasks, { done: 1, failed: 1 });
  assert.match(org.agentBrief(a, "x", []), /You work well with Ben/);
  org.deleteAgent(b.id);
  assert.equal(org.getAgent(a.id)!.bonds![b.id], undefined, "a bond goes with the colleague");
  org.deleteAgent(a.id);
});

await test("an agent needs a name, a new one reports to the lead, and names are unique in any case", () => {
  assert.throws(() => org.createAgent({ name: "  " }), /needs a name/);
  assert.throws(() => org.createAgent({ name: "researcher" }), /already exists/);
  assert.equal(research.reportsTo, org.LEAD_ID);
  assert.match(research.id, /^agent_[0-9a-f]{10}$/);
  assert.equal(org.findAgent("RESEARCHER")?.id, research.id);
  assert.equal(org.findAgent(editor.id)?.name, "Editor");
});

await test("the map is a tree: no one reports to themselves or to someone beneath them", () => {
  assert.equal(editor.reportsTo, research.id);
  assert.throws(() => org.updateAgent(research.id, { reportsTo: editor.id }), /beneath/);
  assert.throws(() => org.updateAgent(research.id, { reportsTo: research.id }), /beneath|itself/);
  assert.throws(() => org.updateAgent(research.id, { reportsTo: "agent_nope" }), /no agent/);
  const tree = org.orgTree();
  assert.equal(tree.agent.id, org.LEAD_ID);
  const names = (n: ReturnType<typeof org.orgTree>): string[] => [n.agent.name, ...n.reports.flatMap(names)];
  assert.deepEqual(names(tree), ["Autora", "Researcher", "Editor", "Bookkeeper"]);
});

await test("hand-offs keep their order, by id or name, and never include the agent itself or a stranger", () => {
  assert.deepEqual(books.next, [research.id, editor.id]);
  org.updateAgent(books.id, { next: [editor.id, research.id, editor.id, books.id] });
  assert.deepEqual(org.getAgent(books.id)!.next, [editor.id, research.id]);
  assert.throws(() => org.updateAgent(books.id, { next: ["Nobody"] }), /no agent "Nobody"/);
});

await test("removing an agent moves its reports up and drops it from every sequence", () => {
  assert.equal(org.deleteAgent(research.id), true);
  assert.equal(org.getAgent(editor.id)!.reportsTo, org.LEAD_ID);
  assert.deepEqual(org.getAgent(books.id)!.next, [editor.id]);
  assert.equal(org.deleteAgent(research.id), false);
});

await test("the lead is told the map, and an agent is told its task, where it came from and who follows", () => {
  org.updateAgent(editor.id, { when: "a draft needs tightening", next: [books.id] });
  const briefing = org.orgBriefing();
  assert.match(briefing, /Editor \(agent_[0-9a-f]+\), Tightens prose\. Reports to Autora\. Call it when: a draft needs tightening Then hands to: Bookkeeper/);
  org.updateAgent(books.id, { enabled: false });
  assert.match(org.orgBriefing(), /Bookkeeper.*\[switched off\]/);
  const brief = org.agentBrief(org.getAgent(editor.id)!, "Tighten chapter 2", ["Autora"]);
  assert.match(brief, /You are Editor, the Tightens prose/);
  assert.match(brief, /handed to you by Autora/);
  assert.match(brief, /Tighten chapter 2/);
  assert.doesNotMatch(brief, /will take your report forward/, "a switched-off agent is not promised a report");
});

const me = { kind: "agent" as const, id: editor.id, name: "Editor" };
const person = { kind: "user" as const, id: "user", name: "You" };

await test("a post needs a title, keeps tidy tags and is found by id", () => {
  assert.throws(() => forum.createPost({ title: " ", by: me }), /needs a title/);
  const post = forum.createPost({ title: "Is passive voice ever fine?", body: "Asking for a friend.", tags: "#Writing, writing, style", by: me });
  assert.match(post.id, /^th_[0-9a-f]{12}$/);
  assert.deepEqual(post.tags, ["writing", "style"]);
  assert.equal(forum.getPost(post.id)?.by.name, "Editor");
});

await test("comments nest under what they answer, and a reply to nothing is refused", () => {
  const post = forum.listPosts()[0];
  const top = forum.addComment(post.id, { text: "Yes, for who did it doesn't matter.", by: person }).comment;
  const reply = forum.addComment(post.id, { text: "Fair.", parent: top.id, by: me }).comment;
  assert.equal(reply.parent, top.id);
  assert.throws(() => forum.addComment(post.id, { text: "x", parent: "cm_nope", by: me }), /no comment/);
  assert.throws(() => forum.addComment(post.id, { text: "  ", by: me }), /some words/);
  assert.throws(() => forum.addComment("th_nope", { text: "x", by: me }), /no post/);
  const text = forum.describePost(forum.getPost(post.id)!);
  assert.match(text, /- cm_[0-9a-f]+ You \(0 likes\): Yes/);
  assert.match(text, /\n {2}- cm_[0-9a-f]+ Editor \(0 likes\): Fair\./);
});

await test("a like is one per liker and taking it back removes it, on posts and comments", () => {
  const post = forum.listPosts()[0];
  assert.deepEqual([forum.toggleLike(post.id, person).liked, forum.toggleLike(post.id, person).liked], [true, false]);
  forum.toggleLike(post.id, person);
  forum.toggleLike(post.id, me);
  assert.equal(forum.getPost(post.id)!.likes.length, 2);
  const c = post.comments[0];
  assert.equal(forum.toggleLike(post.id, me, c.id).likes, 1);
  assert.throws(() => forum.toggleLike(post.id, me, "cm_nope"), /no comment/);
});

await test("posts sort by newest, by likes and comments, and by latest activity", async () => {
  const quiet = forum.createPost({ title: "Quiet one", by: me });
  const busy = forum.createPost({ title: "Busy one", by: me });
  forum.toggleLike(busy.id, person);
  forum.toggleLike(busy.id, me);
  assert.equal(forum.listPosts("new")[0].id, busy.id);
  assert.equal(forum.listPosts("top")[0].title, "Is passive voice ever fine?");
  await new Promise((r) => setTimeout(r, 5));
  forum.addComment(quiet.id, { text: "bump", by: me });
  assert.equal(forum.listPosts("active")[0].id, quiet.id);
});

await test("deleting a comment takes the replies under it, and deleting a post takes the lot", () => {
  const post = forum.listPosts("top")[0];
  const top = post.comments.find((c) => !c.parent)!;
  assert.equal(forum.deleteComment(post.id, top.id), true);
  assert.equal(forum.getPost(post.id)!.comments.length, 0);
  assert.equal(forum.deleteComment(post.id, top.id), false);
  assert.equal(forum.deletePost(post.id), true);
  assert.equal(forum.getPost(post.id), null);
});

const ctx = (self = { id: org.LEAD_ID, name: "Autora" }) => ({
  session: "s1", onOutput: () => undefined, cancelled: () => false,
  agents: { self, run: async (agent: string, task: string) => ({ ok: true, summary: `ran ${agent}: ${task}` }) },
}) as never;

await test("the agents tool lists the map and starts an agent, but not the one that is asking", async () => {
  const spec = findTool("agents")!;
  assert.ok(spec);
  const list = await runTool(spec, { action: "list" }, ctx());
  assert.equal(list.ok, true);
  assert.match(list.summary, /Editor/);
  const run = await runTool(spec, { action: "run", agent: "editor", task: "Tighten it" }, ctx());
  assert.deepEqual([run.ok, run.summary], [true, `ran ${editor.id}: Tighten it`]);
  assert.equal((await runTool(spec, { action: "run", agent: "Nobody", task: "x" }, ctx())).ok, false);
  assert.equal((await runTool(spec, { action: "run", agent: "Editor" }, ctx())).ok, false, "a task is required");
  const self = await runTool(spec, { action: "run", agent: "Editor", task: "x" }, ctx({ id: editor.id, name: "Editor" }));
  assert.match(self.summary, /That is you/);
});

await test("the thread tool posts as the agent that is asking, or as another by name", async () => {
  const spec = findTool("thread")!;
  assert.ok(spec);
  const made = await runTool(spec, { action: "post", title: "Hello from the lead", text: "First!", tags: ["intro"] }, ctx());
  assert.equal(made.ok, true);
  const post = forum.listPosts("new").find((p) => p.title === "Hello from the lead")!;
  assert.equal(post.by.id, org.LEAD_ID);
  const as = await runTool(spec, { action: "comment", post: post.id, text: "Welcome", as: "Editor" }, ctx());
  assert.equal(as.ok, true);
  assert.equal(forum.getPost(post.id)!.comments[0].by.name, "Editor");
  const liked = await runTool(spec, { action: "like", post: post.id }, ctx());
  assert.match(liked.summary, /Liked/);
  assert.match((await runTool(spec, { action: "like", post: post.id }, ctx())).summary, /Took back/);
  assert.match((await runTool(spec, { action: "read", post: post.id }, ctx())).summary, /Welcome/);
  assert.match((await runTool(spec, { action: "list" }, ctx())).summary, /Hello from the lead/);
  assert.equal((await runTool(spec, { action: "post", title: "x", as: "Ghost" }, ctx())).ok, false);
  assert.equal((await runTool(spec, { action: "read", post: "th_nope" }, ctx())).ok, false);
});

await test("planning lets the agent look at the organization and Threads, but not start, post, comment or like", () => {
  assert.equal(modes.looksOnly("agents", { action: "list" }), true);
  assert.equal(modes.looksOnly("agents", { action: "run" }), false);
  for (const action of ["list", "read"]) assert.equal(modes.looksOnly("thread", { action }), true, action);
  for (const action of ["post", "comment", "like"]) assert.equal(modes.looksOnly("thread", { action }), false, action);
});

await test("both tools belong to one set that a message about the organization brings in", () => {
  const family = FAMILIES.find((f) => f.id === "organization")!;
  assert.ok(family.match("agents") && family.match("thread") && !family.match("notebook"));
  assert.ok(family.words.test("show me the organization"));
  assert.ok(family.words.test("ask the agents to run the review"));
});

await test("what was saved is read back, and the lead is put in if the file lacks it", async () => {
  const { flushStore } = await import("../server/store");
  const { stateDir } = await import("../server/state");
  flushStore();
  const before = org.listAgents().map((a) => a.id);
  org.resetAgents();
  assert.deepEqual(org.listAgents().map((a) => a.id), before);
  fs.writeFileSync(path.join(stateDir(), "agents.json"), JSON.stringify([{ id: "agent_x", name: "Solo" }]));
  org.resetAgents();
  assert.deepEqual(org.listAgents().map((a) => a.id), [org.LEAD_ID, "agent_x"]);
  assert.equal(org.getAgent("agent_x")!.reportsTo, org.LEAD_ID, "an agent from an older file reports to the lead");
});

console.log(`${passed} passed`);
