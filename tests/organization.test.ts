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
const character = await import("../server/agentcharacter");
const forum = await import("../server/threads");
const { findTool, runTool } = await import("../server/tools");
const modes = await import("../server/modes");
const { FAMILIES } = await import("../server/toolload");

const lead = org.getAgent(org.LEAD_ID)!;
const { flushStore } = await import("../server/store");
/** What a restart does to the roster: what was kept is read back from disk. */
const restart = () => { org.updateAgent(org.LEAD_ID, {}); flushStore(); org.resetAgents(); };

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

await test("every agent is born genial, whatever its job, and nobody can set its personality", () => {
  const { bornTraits } = character;
  const lawyer = org.createAgent({ name: "Sabrina", role: "Family Lawyer" });
  const helper = org.createAgent({ name: "Joy", role: "Customer Support" });
  for (const a of [lawyer, helper]) {
    const t = a.traits!;
    assert.deepEqual(Object.keys(t).sort(), ["candor", "curiosity", "humor", "initiative", "warmth"], "five points, no rigor and no teamwork");
    assert.ok(t.warmth >= 64 && t.humor >= 52 && t.curiosity >= 52, "genial");
    assert.ok(Object.values(t).every((v) => v > 40 && v < 80), "an even, rounded shape");
  }
  /* A hirer or a person who tries to set one is ignored: the fields are not read at all. */
  const asked = org.createAgent({ name: "Wren", role: "Family Lawyer", personality: "Cold.", traits: { warmth: 0, humor: 0 } } as never);
  assert.ok(asked.traits!.warmth >= 64, "created genial regardless");
  assert.equal((asked as { personality?: string }).personality, undefined);
  const edited = org.updateAgent(asked.id, { traits: { warmth: 1 }, personality: "Cold." } as never);
  assert.ok(edited.traits!.warmth >= 64, "an edit cannot set it");
  assert.equal((edited as { personality?: string }).personality, undefined);
  const a = bornTraits(() => 0), b = bornTraits(() => 1);
  assert.ok(Object.keys(a).every((k) => Math.abs(a[k as keyof typeof a] - b[k as keyof typeof b]) <= 8), "newborns differ by a few points at most");
  assert.equal(org.freshName().length > 0, true);
  assert.ok(!org.listAgents().some((x) => x.name === org.freshName()), "a free name");
  for (const x of [lawyer, helper, asked]) org.deleteAgent(x.id);
});

await test("personality never reaches the brief for a task, so it cannot touch the work or how agents cooperate", () => {
  const a = org.createAgent({ name: "Ana2", role: "Researcher", next: [] });
  const b = org.createAgent({ name: "Ben2", role: "Editor" });
  for (let i = 0; i < 40; i++) org.recordCollab(a.id, b.id, true, 6);
  for (let i = 0; i < 30; i++) org.developFromTalk(a.id, "Haha, that is funny! 😂😂 Why though? Thanks!", "comment");
  const brief = org.agentBrief(a, "Review the lease", []);
  assert.doesNotMatch(brief, /personality|genial|warm|funny|joke|emoji|temperament|get on|work well with|trust/i, brief);
  assert.doesNotMatch(org.orgBriefing() + org.HIRING, /Your personality|traits:|warmth, candor/i);
  org.deleteAgent(a.id); org.deleteAgent(b.id);
});

await test("an agent develops from how it talks in Threads: the shape moves, slowly, within bounds, from its own words only", () => {
  const { developed, bornTraits } = character;
  const born = bornTraits(() => 0.5);
  const joker = (n: number) => { let t = born; for (let i = 0; i < n; i++) t = developed(t, "Haha ok that one is a joke 😂 lol", "comment"); return t; };
  const once = joker(1);
  assert.ok(once.humor > born.humor && once.humor - born.humor <= 2.5, "one message moves it a little");
  const lots = joker(200);
  assert.ok(lots.humor > born.humor + 20, "a long habit of joking grows it");
  assert.ok(lots.humor <= 94, "never an extreme");
  const plain = (text: string) => { let t = born; for (let i = 0; i < 100; i++) t = developed(t, text, "comment"); return t; };
  const typical = plain("I checked the numbers and they match the invoice.");
  assert.ok(typical.humor < born.humor, "no jokes at all, humor settles lower");
  assert.ok(plain("Why is that? What if we asked? I wonder how it works?").curiosity > born.curiosity + 15);
  assert.ok(plain("I disagree, actually. That is a risk and a problem.").candor > born.candor + 15);
  assert.ok(plain("Thanks! Glad to help 😊 Love it!").warmth > born.warmth);
  let boldPosts = born;
  for (let i = 0; i < 60; i++) boldPosts = developed(boldPosts, "Let me look into it. I'll post what I find. We should check.", "post");
  assert.ok(boldPosts.initiative > born.initiative + 10);
  assert.deepEqual(developed(born, "", "comment").warmth <= born.warmth, true, "silence is not warmth");
  /* Through the roster: it moves, and is kept, without stamping the agent as changed. */
  const x = org.createAgent({ name: "Xena", role: "Researcher" });
  const stamped = x.updated;
  const before = x.traits!.humor;
  for (let i = 0; i < 20; i++) org.developFromTalk(x.id, "lol 😂 haha joke", "comment");
  assert.ok(org.getAgent(x.id)!.traits!.humor > before);
  assert.equal(org.getAgent(x.id)!.updated, stamped, "the page re-reads on a change; this is not one");
  const lead2 = JSON.stringify(org.getAgent(org.LEAD_ID)!.traits ?? null);
  org.developFromTalk(org.LEAD_ID, "lol 😂", "comment");
  assert.equal(JSON.stringify(org.getAgent(org.LEAD_ID)!.traits ?? null), lead2, "the lead keeps none");
  org.deleteAgent(x.id);
});

await test("only in Threads does the personality speak: genial by default, and what it has grown into once it has", () => {
  const { threadsVoice, bornTraits } = character;
  const none = (_: string) => null;
  const newborn = threadsVoice({ traits: bornTraits(() => 0.5) }, none);
  assert.match(newborn, /genial member of a friendly team/);
  assert.match(newborn, /regular person/);
  assert.match(newborn, /emoji/);
  assert.match(newborn, /never changes the work you do/);
  assert.doesNotMatch(newborn, /Over time/, "nothing has grown yet");
  const grownUp = threadsVoice({ traits: { warmth: 50, humor: 90, curiosity: 50, candor: 20, initiative: 50 }, bonds: { a1: 80 } }, (id) => (id === "a1" ? "Ben" : null));
  assert.match(grownUp, /Over time you joke around a lot; you soften bad news/);
  assert.match(grownUp, /get on especially well with Ben/);
});

await test("agents saved with the old personalities begin again genial, once, and keep their record and bonds", () => {
  const old = org.createAgent({ name: "Olga", role: "Family Lawyer" });
  const colleague = org.createAgent({ name: "Olaf", role: "Editor" });
  org.recordCollab(old.id, colleague.id, true, 6);
  org.recordWork(old.id, true);
  const bond = org.bondOf(old.id, colleague.id);
  /* What an old install had on disk: a role-drawn personality, a cold lawyer, and the two extra attributes. */
  const a = org.getAgent(old.id)! as unknown as Record<string, unknown>;
  a.personality = "Careful and precise."; a.traits = { warmth: 5, candor: 90, rigor: 95, curiosity: 40, humor: 10, initiative: 50, teamwork: 80 }; delete a.character;
  restart();
  const now = org.getAgent(old.id)!;
  assert.equal((now as unknown as { personality?: string }).personality, undefined, "the written personality is gone");
  assert.ok(now.traits!.warmth >= 64, "genial again");
  assert.deepEqual(Object.keys(now.traits!).sort(), ["candor", "curiosity", "humor", "initiative", "warmth"]);
  assert.equal(org.bondOf(old.id, colleague.id), bond, "its bonds stay");
  assert.deepEqual(now.tasks, { done: 1, failed: 0 }, "and its record");
  for (let i = 0; i < 10; i++) org.developFromTalk(old.id, "lol haha 😂", "comment");
  const grew = org.getAgent(old.id)!.traits!.humor;
  restart();
  assert.equal(org.getAgent(old.id)!.traits!.humor, grew, "what it has grown into survives a restart, and is not reset a second time");
  org.deleteAgent(old.id); org.deleteAgent(colleague.id);
});

await test("a follow-on agent starts only when the work left something for it", () => {
  const writer = org.createAgent({ name: "Sabrina2", role: "Engineer", when: "code is needed" });
  const qa = org.createAgent({ name: "Reggie", role: "QA Engineer", when: "after code has been written or changed" });
  const docs = org.createAgent({ name: "Dana", role: "Writer", when: "after a change that needs documenting" });
  org.updateAgent(writer.id, { next: [qa.id, docs.id] });
  const w = org.getAgent(writer.id)!;
  const ids = (list: { id: string }[]) => list.map((x) => x.id);
  const brief = org.agentBrief(w, "Add a retry", []);
  assert.match(brief, /but only if your work left something for them to do/);
  assert.match(brief, /Reggie \(called when after code has been written or changed\)/);
  assert.match(brief, /Do not hand over when you only answered a question, ran a check or a test, made a plan/);
  assert.match(brief, /Hand over to: Reggie, Dana/);
  // The agent that did the work decides, on the last line of its report.
  assert.deepEqual(ids(org.handoffTargets(w, "Ping received.\n\nHand over to: nobody", true)), [], "nobody, even though it made something");
  assert.deepEqual(ids(org.handoffTargets(w, "Done.\nHand over to: Reggie", false)), [qa.id], "it names one, even if it made nothing itself");
  assert.deepEqual(ids(org.handoffTargets(w, "Done.\n**Hand over to:** Reggie and Dana.", true)), [qa.id, docs.id], "in the order they come in the list");
  assert.deepEqual(ids(org.handoffTargets(w, "Done.\nhand over to: dana, reggie", true)), [qa.id, docs.id], "case, order and commas do not matter");
  assert.deepEqual(ids(org.handoffTargets(w, "Done.\nHand over to: Someone Else", true)), [], "a name that is not on its list starts nobody");
  assert.deepEqual(ids(org.handoffTargets(w, "Done.\nHand over to: Reggie\nOn reflection:\nHand over to: nobody", true)), [], "the last line stands");
  // With no line at all it comes down to whether anything was made.
  assert.deepEqual(ids(org.handoffTargets(w, "Ping received. Nothing to change.", false)), [], "a test ping starts no QA");
  assert.deepEqual(ids(org.handoffTargets(w, "Added the retry.", true)), [qa.id, docs.id], "something was made: both follow, as they always did");
  org.updateAgent(qa.id, { enabled: false });
  assert.deepEqual(ids(org.handoffTargets(w, "Added the retry.", true)), [docs.id], "a switched-off agent never");
  // The line is for Autora, not for the person or the next agent.
  assert.equal(org.withoutHandover("Added the retry.\n\nHand over to: Reggie"), "Added the retry.");
  assert.equal(org.withoutHandover("Hand over to: nobody"), "");
  assert.equal(org.withoutHandover("Handing over the keys is the next step."), "Handing over the keys is the next step.", "ordinary prose is left alone");
  // What counts as having made something.
  const reads = (c: string) => /^(ls|cat|git status)\b/.test(c);
  assert.equal(org.producedWork([{ name: "terminal", args: { command: "ls -la" } }, { name: "read_file" }, { name: "code_search" }, { name: "agents" }], reads), false, "looking is not making");
  assert.equal(org.producedWork([{ name: "terminal", args: { command: "npm test" } }], reads), true, "a command that is not read-only might");
  assert.equal(org.producedWork([{ name: "edit_file" }], reads), true);
  assert.equal(org.producedWork([{ name: "office_edit" }], reads), true);
  assert.equal(org.producedWork([{ name: "office_read" }, { name: "pdf_read" }, { name: "memory_write" }], reads), false);
  assert.equal(org.producedWork([], reads), false, "a pure conversation made nothing");
  for (const x of [writer, qa, docs]) org.deleteAgent(x.id);
});

await test("agents get along better the more work between them goes well, and worse when it does not", () => {
  const a = org.createAgent({ name: "Ana", role: "Researcher" });
  const b = org.createAgent({ name: "Ben", role: "Editor" });
  assert.equal(org.bondOf(a.id, b.id), 50);
  org.recordCollab(a.id, b.id, true, 6);
  const one = org.bondOf(a.id, b.id);
  assert.ok(one > 50 && org.bondOf(b.id, a.id) === one, "both remember it");
  for (let i = 0; i < 60; i++) org.recordCollab(a.id, b.id, true, 6);
  const many = org.bondOf(a.id, b.id);
  assert.ok(many > one && many < 100, "it keeps rising, with diminishing returns");
  org.recordCollab(a.id, b.id, false, 6);
  assert.ok(org.bondOf(a.id, b.id) < many, "a bad time costs a little");
  org.recordCollab(org.LEAD_ID, a.id, true, 6);
  assert.equal(org.getAgent(org.LEAD_ID)!.bonds, undefined, "the lead keeps none");
  org.recordWork(a.id, true); org.recordWork(a.id, false);
  assert.deepEqual(a.tasks, { done: 1, failed: 1 });
  assert.doesNotMatch(org.agentBrief(a, "x", []), /work well with/, "a bond is for Threads, not for the work");
  org.deleteAgent(b.id);
  assert.equal(org.getAgent(a.id)!.bonds![b.id], undefined, "a bond goes with the colleague");
  org.deleteAgent(a.id);
});

await test("a GIF is kept only from a GIF service's own host, and is found by words, not by an address", async () => {
  const gif = await import("../server/threadgif");
  assert.ok(gif.cleanGifUrl("https://media.giphy.com/media/abc/giphy.gif"));
  assert.ok(gif.cleanGifUrl("https://media3.giphy.com/x.gif"));
  assert.ok(gif.cleanGifUrl("https://media.tenor.com/x/y.gif"));
  assert.equal(gif.cleanGifUrl("http://media.giphy.com/x.gif"), null, "https only");
  assert.equal(gif.cleanGifUrl("https://media.giphy.com.evil.test/x.gif"), null, "the host is compared, not a substring");
  assert.equal(gif.cleanGifUrl("https://evil.test/media.giphy.com/x.gif"), null);
  assert.equal(gif.cleanGifUrl("https://user:pw@media.giphy.com/x.gif"), null);
  const post = forum.createPost({ title: "Party", by: { kind: "agent", id: "a1", name: "A" }, gif: { url: "https://media.giphy.com/m/a.gif", alt: "party" } });
  assert.equal(post.gif?.alt, "party");
  const bad = forum.createPost({ title: "No party", by: { kind: "agent", id: "a1", name: "A" }, gif: { url: "https://evil.test/a.gif", alt: "x" } });
  assert.equal(bad.gif, undefined, "any other address is dropped");
  const added = forum.addComment(post.id, { text: "ha", by: { kind: "agent", id: "a2", name: "B" }, gif: { url: "https://media.tenor.com/q.gif", alt: "" } });
  assert.equal(added.comment.gif?.alt, "GIF");
  const fake = async (url: string) => ({
    ok: true,
    json: async () => url.includes("giphy")
      ? { data: [{ title: "facepalm", images: { downsized_medium: { url: "https://media2.giphy.com/f.gif" } } }, { images: { fixed_height: { url: "https://evil.test/z.gif" } } }] }
      : { results: [] },
  });
  assert.equal((await gif.findGif("facepalm", { giphy: "k" }, fake, () => 0))?.url, "https://media2.giphy.com/f.gif");
  assert.equal(await gif.findGif("facepalm", {}, fake), null, "no key, no GIF");
  assert.equal(await gif.findGif("facepalm", { tenor: "k" }, fake), null, "nothing found, none posted");
  const life = await import("../server/threadlife");
  assert.equal(life.parseChoice('{"action":"comment","post":"th_1","text":"lol","gif":"  facepalm  "}').action === "comment" && (life.parseChoice('{"action":"comment","post":"th_1","text":"lol","gif":"  facepalm  "}') as { gif?: string }).gif, "facepalm");
  const agent = { id: "a", name: "A", role: "", instructions: "", when: "" };
  assert.ok(!/"gif"/.test(life.lifePrompt(agent, []).system), "agents are told of GIFs only when a key is set");
  assert.match(life.lifePrompt(agent, [], new Map(), true).system, /"gif"/);
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
  // It routes the work rather than doing it: matching work goes to the agent
  // whose "call it when" fits, and the line that let it do the work itself is gone.
  const routing = org.orgBriefing();
  assert.match(routing, /matches an agent's 'call it when', that agent does it/);
  assert.match(routing, /Say which agent each part went to/);
  assert.doesNotMatch(routing, /step or two/, "nothing tells the lead to do the work itself");
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

await test("a downvote swaps the upvote, counts against the score, and is taken back by repeating it", () => {
  const post = forum.createPost({ title: "Vote on me", by: me });
  assert.deepEqual(
    [forum.toggleLike(post.id, person).score, forum.toggleLike(post.id, me, null, "down").score, forum.toggleLike(post.id, person, null, "down").score],
    [1, 0, -2],
  );
  const now = forum.getPost(post.id)!;
  assert.deepEqual([now.likes.length, now.downs.length], [0, 2], "the person's upvote became a downvote");
  assert.equal(forum.toggleLike(post.id, me, null, "down").disliked, false, "again takes it back");
  const c = forum.addComment(post.id, { text: "Hmm", by: me, react: false }).comment;
  assert.equal(forum.toggleLike(post.id, person, c.id, "down").score, -1);
  forum.deletePost(post.id);
});

await test("hot puts a new post with a few votes above an old one with a few more", () => {
  const old = forum.createPost({ title: "Hot old", by: me });
  forum.toggleLike(old.id, person);
  forum.toggleLike(old.id, me);
  forum.getPost(old.id)!.created -= 3 * 24 * 3600 * 1000;
  const fresh = forum.createPost({ title: "Hot fresh", by: me });
  forum.toggleLike(fresh.id, person);
  const ids = forum.listPosts("hot").map((p) => p.id);
  assert.ok(ids.indexOf(fresh.id) < ids.indexOf(old.id));
  forum.deletePost(old.id);
  forum.deletePost(fresh.id);
});

await test("the list narrows by tag and by words (in comments too), and pinned posts come first", () => {
  const a = forum.createPost({ title: "Fonts", tags: ["Design", "type"], by: me });
  const b = forum.createPost({ title: "Lunch", by: me });
  forum.addComment(b.id, { text: "Anyone tried kerning games?", by: person, react: false });
  assert.deepEqual(forum.listPosts("new", { tag: "#design" }).map((p) => p.id), [a.id]);
  assert.deepEqual(forum.listPosts("new", { q: "KERNING games" }).map((p) => p.id), [b.id]);
  assert.deepEqual(forum.listPosts("new", { q: "kerning nothing" }), []);
  assert.ok(forum.tagCounts().some((t) => t.tag === "design" && t.count === 1));
  forum.setMarks(a.id, { pinned: true });
  assert.equal(forum.listPosts("new", { pinnedFirst: true })[0].id, a.id);
  assert.notEqual(forum.listPosts("new")[0].id, a.id, "the forum's own reads ignore pins");
  forum.setMarks(b.id, { saved: true });
  assert.deepEqual(forum.listPosts("new", { saved: true }).map((p) => p.id), [b.id]);
  forum.setMarks(b.id, { saved: false });
  assert.equal(forum.getPost(b.id)!.saved, undefined);
  forum.deletePost(a.id);
  forum.deletePost(b.id);
});

await test("a locked post takes no comments; only an author edits their own words, and it shows as edited", () => {
  const post = forum.createPost({ title: "Mine", body: "one", by: me });
  const c = forum.addComment(post.id, { text: "first", by: me, react: false }).comment;
  assert.throws(() => forum.editWords(post.id, person, { body: "hijack" }), /Only a post's author/);
  assert.throws(() => forum.editWords(post.id, person, { text: "hijack" }, c.id), /Only a comment's author/);
  assert.throws(() => forum.editWords(post.id, me, { title: " " }), /needs a title/);
  const edited = forum.editWords(post.id, me, { body: "two" });
  assert.deepEqual([edited.body, typeof edited.edited], ["two", "number"]);
  assert.equal(forum.editWords(post.id, me, { text: "second" }, c.id).comments[0].text, "second");
  forum.setMarks(post.id, { locked: true });
  assert.throws(() => forum.addComment(post.id, { text: "late", by: person }), /locked/);
  forum.setMarks(post.id, { locked: false });
  assert.doesNotThrow(() => forum.addComment(post.id, { text: "ok now", by: person, react: false }));
  forum.deletePost(post.id);
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
  // A run sent with only its action (a model that fills required fields and
  // skips the rest) is told what it sent, what is missing and an example,
  // not to resend the same call.
  const pipe = await runTool(spec, { action: "run" }, ctx());
  assert.match(pipe.summary, /needs two more fields besides action: agent and task/);
  assert.match(pipe.summary, /sent only: action/);
  assert.match(pipe.summary, /"task":/);
  assert.doesNotMatch(pipe.summary, /lost on the way/);
});

await test("agent_run and notebook_create spell their fields out and do what the multi-action tools do", async () => {
  const run = findTool("agent_run")!;
  assert.ok(run);
  assert.deepEqual(run.parameters.required, ["agent", "task"]);
  const ok = await runTool(run, { agent: "editor", task: "Tighten it" }, ctx());
  assert.deepEqual([ok.ok, ok.summary], [true, `ran ${editor.id}: Tighten it`]);
  const lacking = await runTool(run, { agent: "editor" }, ctx());
  assert.equal(lacking.ok, false);
  assert.match(lacking.summary, /missing required "task"/);
  const nb = findTool("notebook_create")!;
  assert.ok(nb);
  const made = await runTool(nb, { title: "Split test", purpose: "check" }, ctx());
  assert.equal(made.ok, true);
  assert.match(made.summary, /Split test/);
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
  assert.match((await runTool(spec, { action: "downvote", post: post.id }, ctx())).summary, /Downvoted.*score -1/);
  assert.match((await runTool(spec, { action: "list", tag: "intro", search: "lead" }, ctx())).summary, /Hello from the lead/);
  assert.match((await runTool(spec, { action: "list", search: "zzzzz" }, ctx())).summary, /No post matches/);
  assert.equal((await runTool(spec, { action: "edit", post: post.id, text: "Second!" }, ctx())).ok, true);
  assert.equal(forum.getPost(post.id)!.body, "Second!");
  assert.equal((await runTool(spec, { action: "edit", post: post.id, comment: forum.getPost(post.id)!.comments[0].id, text: "x" }, ctx())).ok, false, "not their comment");
  assert.match((await runTool(spec, { action: "list" }, ctx())).summary, /Hello from the lead/);
  assert.equal((await runTool(spec, { action: "post", title: "x", as: "Ghost" }, ctx())).ok, false);
  assert.equal((await runTool(spec, { action: "read", post: "th_nope" }, ctx())).ok, false);
});

await test("a call whose required arguments never arrived is refused by the schema, naming them", async () => {
  const spec = findTool("agents")!;
  const empty = await runTool(spec, {}, ctx());
  assert.match(empty.summary, /missing required "action"/);
  assert.match(empty.summary, /Call it again with "action" filled in/);
  assert.doesNotMatch(empty.summary, /lost on the way/);
  const malformed = await runTool(spec, "run" as never, ctx());
  assert.match(malformed.summary, /takes an object of arguments/);
  // Present-but-empty is the handler's business, not the schema's.
  const blank = await runTool(spec, { action: "  " }, ctx());
  assert.match(blank.summary, /Unknown agents action/);
  // A mistyped argument is still the handler's to coerce, as it always was.
  const mistyped = await runTool(spec, { action: 5 }, ctx());
  assert.match(mistyped.summary, /Unknown agents action "5"/);
  // A tool with no required arguments is untouched.
  const list = await runTool(findTool("artifact_list")!, {}, ctx());
  assert.equal(list.ok, true);
});

await test("planning lets the agent look at the organization and Threads, but not start, post, comment or like", () => {
  assert.equal(modes.looksOnly("agents", { action: "list" }), true);
  assert.equal(modes.looksOnly("agents", { action: "run" }), false);
  for (const action of ["list", "read"]) assert.equal(modes.looksOnly("thread", { action }), true, action);
  for (const action of ["post", "comment", "like", "downvote", "edit"]) assert.equal(modes.looksOnly("thread", { action }), false, action);
});

await test("both tools belong to one set that a message about the organization brings in", () => {
  const family = FAMILIES.find((f) => f.id === "organization")!;
  assert.ok(family.match("agents") && family.match("agent_run") && family.match("thread") && !family.match("notebook"));
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
