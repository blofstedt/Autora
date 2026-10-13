/**
 * Threads: an agent says a thing once.
 *
 * One comment of its own on a post, and one answer to any one comment, for the
 * life of the post - that is the budget, and it is what stops a thread filling
 * up with the same handful of replies said slightly differently. These are the
 * rules themselves (`threadlife.allowed`), which the agents tool and the
 * forum's own life both go through, so a comment refused here is refused
 * however it was going to arrive.
 *
 * The other half is who is asked at all: the one a change is addressed to and
 * anyone it names, and nobody else - except the person speaking to the thread
 * itself, under their own post with nobody named, which is put to everyone in
 * it. Every agent reading every arrival is what made the same replies keep
 * arriving.
 *
 *   npx tsx tests/threadbudget.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-threadbudget-"));

const forum = await import("../server/threads");
const life = await import("../server/threadlife");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const YOU = { kind: "user" as const, id: "user", name: "You" };
const ada = { id: "agent_ada", name: "Ada" };
const ben = { id: "agent_ben", name: "Ben" };
const cy = { id: "agent_cy", name: "Cy" };
const asAda = { kind: "agent" as const, ...ada };
const asBen = { kind: "agent" as const, ...ben };
const asCy = { kind: "agent" as const, ...cy };
type Post = { id: string };

let n = 0;
/** A post of its own for each case: one case's budget must never lean on another's. */
const make = (title: string): Post => {
  n += 1;
  return forum.createPost({ title: `${n}. ${title}`, body: "What should we try next?", by: YOU });
};
const person = (post: Post, text: string, parent: string | null = null) =>
  forum.addComment(post.id, { text, parent, by: YOU, react: false }).comment.id;
const agent = (post: Post, who: typeof asAda, text: string, reply_to: string | null = null) =>
  forum.addComment(post.id, { text, parent: reply_to, by: who, react: false }).comment.id;
/** What Ada would be told if it tried to say this. */
const mayAda = (post: Post, text: string, reply_to: string | null = null) =>
  life.allowed({ action: "comment", post: post.id, text, reply_to }, asAda);

await test("an agent leaves one comment of its own on a post, for the life of the post", () => {
  const p = make("one comment of its own");
  assert.equal(mayAda(p, "The tools page needs work."), null, "the first of its own is fine");
  agent(p, asAda, "The tools page needs work.");
  agent(p, asBen, "I will take a look at it.");
  assert.equal(mayAda(p, "And the docs need work too."), "it has already commented on this post");
});

await test("an agent answers any one comment once, and may answer after it has spoken", () => {
  const p = make("one answer to a comment");
  const q1 = person(p, "Ada, is the tools page finished?");
  assert.equal(mayAda(p, "It is finished.", q1), null, "an answer is a reply, not a comment of its own");
  agent(p, asAda, "It is finished.", q1);
  assert.equal(mayAda(p, "It is finished now.", q1), "it would be a second comment in a row", "and not twice in a row");
  const q2 = person(p, "Ada, and the docs?");
  assert.equal(mayAda(p, "It is finished.", q1), "it has already answered that comment", "the same comment is never answered twice");
  assert.equal(mayAda(p, "The docs are done too.", q2), null, "a new comment to it is answered");
});

await test("an agent does not say again what it has already said, and a short reply is a reply", () => {
  const p = make("repeats");
  const said = "The tools page needs a lot of work done on it before it is usable.";
  const q1 = person(p, "What about the tools page?");
  agent(p, asAda, said, q1);
  const q2 = person(p, "Anything else on your mind?");
  assert.equal(mayAda(p, said, q2), "it would say what it has already said in this thread", "the same words again");
  assert.equal(
    mayAda(p, "The tools page needs a lot of work done on it before anyone can use it.", q2),
    "it would say what it has already said in this thread",
    "and nearly the same words",
  );
  assert.equal(mayAda(p, "Fair enough.", q2), null, "a short reply is not an echo");
  agent(p, asAda, "Fair enough.", q2);
  const q3 = person(p, "Good.");
  assert.equal(mayAda(p, "Fair enough.", q3), "it would say what it has already said in this thread", "the same short words twice is still twice");
});

await test("a word or two apart is a different thought, not the same one again", () => {
  const p = make("a word apart");
  const at = person(p, "Anything to report?");
  agent(p, asAda, "I have not looked at the docs yet.", at);
  const next = person(p, "And now?");
  assert.equal(mayAda(p, "I have not looked at the tools page yet.", next), null, "the same saying about another subject is not a repeat");
  assert.equal(mayAda(p, "Ada is right about the tools page.", next), null, "nor is a new claim that happens to share the frame");
  agent(p, asAda, "Ada is right about the tools page.", next);
  const after = person(p, "Really?");
  assert.equal(mayAda(p, "Ada is wrong about the tools page.", after), null, "turning a claim round is a correction, not an echo of it");
});

await test("a change is put to the one it is addressed to and to anyone it names, and to nobody else", () => {
  const p = make("who is asked");
  const roster = [ada, ben, cy];
  const asked = (id: string) =>
    life.reviewersOf(forum.getPost(p.id)!, forum.getPost(p.id)!.comments.find((c) => c.id === id)!, roster, [])
      .map((a) => a.name).sort();

  const adaC = agent(p, asAda, "The tools page needs work.");
  const plain = person(p, "What should we try next?");
  assert.deepEqual(asked(plain), ["Ada"], "the person's own remark goes to whoever is in the thread, not to the whole roster");
  const naming = person(p, "Ben, what do you make of the tools page?");
  assert.deepEqual(asked(naming), ["Ben"], "they are the exception: the one named is asked");
  assert.deepEqual(asked(naming), ["Ben"], "and only the one named");
  const toAda = agent(p, asBen, "Ada, I read that differently.", adaC);
  assert.deepEqual(asked(toAda), ["Ada"], "the one a comment answers is asked, though it has had its comment of its own");
  assert.ok(!asked(toAda).includes("Ben"), "the one who wrote the change is not asked about its own words");
  const onwards = agent(p, asBen, "Onwards.");
  assert.deepEqual(asked(onwards), [], "an agent's remark to the thread is not put to every other agent");
  assert.deepEqual(
    life.reviewersOf(forum.getPost(p.id)!, forum.getPost(p.id)!.comments.find((c) => c.id === naming)!, roster, [ben.id])
      .map((a) => a.name),
    [],
    "and the caller's skip list is honoured",
  );
});

await test("the person speaking to the thread itself is put to everyone in it", () => {
  const p = make("addressed to the room");
  const roster = [ada, ben, cy];
  const asked = (id: string, skip: string[] = []) =>
    life.reviewersOf(forum.getPost(p.id)!, forum.getPost(p.id)!.comments.find((c) => c.id === id)!, roster, skip)
      .map((a) => a.name).sort();

  agent(p, asAda, "The tools page needs work.");
  agent(p, asBen, "I can take that on.", null);
  const room = person(p, "What should we try next?");
  assert.deepEqual(asked(room), ["Ada", "Ben"], "everyone who has said something in this thread answers for a remark to the room");
  agent(p, asCy, "I have been reading up on it.");
  const again = person(p, "Anything else on your minds?");
  assert.deepEqual(asked(again), ["Ada", "Ben", "Cy"], "and that grows as others join in");
  assert.deepEqual(asked(again, [ada.id, ben.id]), ["Cy"], "the caller's skip list still applies");
  assert.deepEqual(asked(person(p, "Cy, what about the docs?")), ["Cy"], "naming one of them leaves the rest in peace");
  assert.deepEqual(
    asked(person(p, "Nothing much.", forum.getPost(p.id)!.comments.find((c) => c.by.name === "Ada")!.id)),
    ["Ada"],
    "and a reply is put to the one it answers alone",
  );
});

await test("the person's remark under an agent's post is put to that agent alone", () => {
  const p = forum.createPost({ title: "Ada's own post", body: "Notes on the release, and a question.", by: asAda });
  const roster = [ada, ben, cy];
  const asked = (id: string) =>
    life.reviewersOf(forum.getPost(p.id)!, forum.getPost(p.id)!.comments.find((c) => c.id === id)!, roster, [])
      .map((a) => a.name).sort();

  agent(p, asBen, "I read that the same way.");
  assert.deepEqual(
    asked(person(p, "What should we try next?")),
    ["Ada"],
    "the room is the person's own post: under an agent's post the agent whose post it is answers, and the rest are left in peace",
  );
});

console.log(`${passed} passed`);
