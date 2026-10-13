/**
 * A reply in Threads is owed an answer, and it is the only thing that is.
 *
 * The one a comment answers always replies (whatever its mood), whoever wrote the comment. A comment is also put
 * to anyone it names, and to nobody else: a thread where every arrival is read by everyone is a thread where the
 * same handful of near-identical replies keeps arriving. The one exception is the person speaking to the thread
 * itself, with nobody named: that is addressed to the room, and everyone in it answers, once each. And an agent
 * says a thing once - one comment of its own on a post, one answer to any one comment, for the life of the post.
 *
 *   npx tsx tests/e2e-threadreplies.test.ts
 */
import assert from "node:assert/strict";
import { sleep, startApp, type App, type Seen } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const json = (o: unknown) => ({ text: JSON.stringify(o) });
const who = (req: Seen) => /You are (Ada|Ben|Cy)\b/.exec(req.system)?.[1] ?? "";

async function main() {
  const app: App = await startApp({ env: { AUTORA_THREADS_PACE: "off" } });
  try {
    for (const name of ["Ada", "Ben", "Cy"]) {
      const r = await app.api("POST", "/api/agents", { name, role: `${name}'s job`, when: "when asked" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    assert.equal((await app.api("GET", "/api/collaboration")).body.unprompted, true, "agents may speak up unasked by default");
    assert.equal((await app.api("PATCH", "/api/collaboration", { unprompted: false })).body.unprompted, false);
    assert.equal((await app.api("PATCH", "/api/collaboration", { unprompted: true })).body.unprompted, true);
    const post = (await app.api("POST", "/api/threads", { title: "Ideas", body: "What should we try next?" })).body.post.id as string;
    const comments = async () => (await app.api("GET", `/api/threads/${post}`)).body.post.comments as { id: string; parent: string | null; by: { name: string }; text: string }[];

    /* Nothing is asked of anyone until the person's reply: the forum's own life gets "none" here, so the replies are the only thing under test. */
    let mine = "";
    let armed = false;
    /* When this is on, an owed answer comes back as words the agent has already used in the thread. */
    let echo = false;
    /* Each scripted answer is written in words of its own. The no-repeat rule is real, so a fixture that hands an
       agent the same phrase twice in one thread has that answer refused - which is how the room case below first
       failed - and the case then fails for a reason that has nothing to do with what it is testing. */
    let told = 0;
    const freshWords = (me: string) => {
      const lines = [
        "The tools page could be simpler, I think.",
        "I keep coming back to the docs, and they need work.",
        "Nothing much from me, only that the release looks fine.",
        "Worth saying: I read it the other way round.",
        "A short thought about the tools page and the docs.",
        "I have a question about the next release.",
      ];
      const line = lines[told % lines.length];
      told += 1;
      return `${me}: ${line}`;
    };
    app.decide = (req) => {
      if (!req.system.includes("a small forum")) return null;
      const me = who(req);
      if (req.last.includes("has just replied to you")) {
        const reply = /reply_to "(cm_[a-z0-9]+)"/.exec(req.last)?.[1] ?? null;
        return json({ action: "comment", post, reply_to: reply, text: echo ? `${me} was here first` : `${me} answers` });
      }
      /* Asked to read a change that is not addressed to it: answer the person's latest comment, the one that changed. */
      if (armed && req.last.includes("not addressed to you")) {
        const toPerson = [...req.last.matchAll(/\[(cm_[a-z0-9]+)\] [^\n]*?\(the person\)/g)].pop()?.[1] ?? null;
        return json({ action: "comment", post, reply_to: toPerson, text: freshWords(me) });
      }
      return json({ action: "none" });
    };

    const s = await app.newSession("forum", "build");
    for (const as of ["Ada", "Ben", "Cy"]) {
      app.script.push({ tools: [{ name: "thread", args: { action: "comment", post, text: `${as} was here first`, as } }] });
    }
    app.script.push({ text: "done" });
    await app.turn(s, "put the three of them in the thread");
    await sleep(2500);
    const before = await comments();
    assert.deepEqual(before.map((c) => c.by.name), ["Ada", "Ben", "Cy"], "the others read each arrival and chose silence");
    const adas = before[0];

    await test("a reply to an agent always makes that agent answer, as a reply to it", async () => {
      app.seen.length = 0;
      armed = true;
      mine = (await app.api("POST", `/api/threads/${post}/comments`, { text: "Ada, what about the tools page?", parent: adas.id })).body.comment.id as string;
      const deadline = Date.now() + 20_000;
      let list = await comments();
      while (!list.some((c) => c.by.name === "Ada" && c.parent === mine) && Date.now() < deadline) { await sleep(250); list = await comments(); }
      const answer = list.find((c) => c.by.name === "Ada" && c.parent === mine);
      assert.ok(answer, "Ada replied to the person's comment");
      assert.equal(answer!.text, "Ada answers");
    });

    await test("only the one it is addressed to is asked: the others are left in peace", async () => {
      const mark = app.seen.length;
      await sleep(2000);
      const reviews = app.seen.slice(mark).filter((r) => r.system.includes("a small forum") && r.last.includes("not addressed to you"));
      assert.deepEqual(reviews.map(who), [], "one agent was answered, so no one else was called in");
      const list = await comments();
      const answers = list.filter((c) => c.parent === mine);
      assert.equal(answers.length, 1, "exactly one answer to the person's comment");
      assert.equal(answers[0].by.name, "Ada", "from the one it was addressed to");
      for (const name of ["Ada", "Ben", "Cy"]) {
        assert.equal(list.filter((c) => c.by.name === name && !c.parent).length, 1, `${name} has one comment of its own on the post, no more`);
      }
    });

    await test("a comment naming an agent is put to it, and to nobody it does not name", async () => {
      app.seen.length = 0;
      const asked = (await app.api("POST", `/api/threads/${post}/comments`, { text: "Ben, and Ada: what about the tools page?" })).body.comment.id as string;
      const started = Date.now();
      const deadline = started + 45_000;
      let list = await comments();
      while (list.filter((c) => c.parent === asked).length < 2 && Date.now() < deadline) { await sleep(250); list = await comments(); }
      assert.deepEqual(
        list.filter((c) => c.parent === asked).map((c) => c.by.name).sort(),
        ["Ada", "Ben"],
        "both of the named agents answered the person's comment",
      );
      const reviews = app.seen.filter((r) => r.system.includes("a small forum") && r.last.includes("not addressed to you"));
      assert.ok(!reviews.some((r) => who(r) === "Cy"), "Cy was not asked: the comment is not about it");
      assert.ok(reviews.some((r) => r.last.includes("[NEW]")), "and what changed is marked in what they read");
      for (const name of ["Ada", "Ben", "Cy"]) {
        const said = list.filter((c) => c.by.name === name).map((c) => c.text);
        assert.equal(new Set(said).size, said.length, `${name} never says the same thing twice`);
      }
    });

    await test("the agent a comment answers is owed an answer even now, and answers it once", async () => {
      const list0 = await comments();
      const bens = list0.find((c) => c.by.name === "Ben" && c.parent)!;
      const back = (await app.api("POST", `/api/threads/${post}/comments`, { text: "Ben, is that settled?", parent: bens.id })).body.comment.id as string;
      const deadline = Date.now() + 25_000;
      let list = await comments();
      while (!list.some((c) => c.by.name === "Ben" && c.parent === back) && Date.now() < deadline) { await sleep(250); list = await comments(); }
      assert.equal(list.filter((c) => c.by.name === "Ben" && c.parent === back).length, 1, "Ben answered the reply to him, once");
      await sleep(2000);
      list = await comments();
      assert.equal(list.filter((c) => c.parent === back).length, 1, "and no one else piled in");
    });
    await test("a word to the room, naming nobody, is put to everyone in it, once each", async () => {
      app.seen.length = 0;
      const opening = (await comments()).length;
      const room = (await app.api("POST", `/api/threads/${post}/comments`, { text: "What should we all be thinking about?" })).body.comment.id as string;
      /* Three agents are asked in turn, so the wait has to survive a loaded machine: 60s was not enough when a
         typecheck ran beside this test, and the case then failed with the third agent still mid-turn. */
      const deadline = Date.now() + 90_000;
      let list = await comments();
      while (new Set(list.filter((c) => c.parent === room).map((c) => c.by.name)).size < 3 && Date.now() < deadline) { await sleep(250); list = await comments(); }
      const answers = list.filter((c) => c.parent === room);
      assert.deepEqual([...answers.map((c) => c.by.name)].sort(), ["Ada", "Ben", "Cy"], "everyone in it answered the person's remark, and nobody from outside did");
      const asked = app.seen.filter((r) => r.system.includes("a small forum") && r.last.includes("not addressed to you"));
      assert.deepEqual(asked.map(who).sort(), ["Ada", "Ben", "Cy"], "each of them was asked once, and nobody twice");
      await sleep(2500);
      list = await comments();
      /* Exactly the person's remark and one answer from each of the three: nothing added by an agent
         answering another agent, and nothing said twice. */
      assert.equal(list.length, opening + 4, `the remark and three answers, and nothing else (${list.length - opening} comments added)`);
      assert.equal(list.filter((c) => c.parent === room).length, 3, "and nobody answered a second time");
    });

    await test("an owed answer that would only repeat the agent is refused, and nothing is posted in its place", async () => {
      const list0 = await comments();
      const asks = list0.filter((c) => c.by.name === "Ada" && c.parent).pop()!;
      const mark = app.seen.length;
      echo = true;
      const said = (await app.api("POST", `/api/threads/${post}/comments`, { text: "Ada, one more thing?", parent: asks.id })).body.comment.id as string;
      /* Wait for the ask, so that what follows is about a refusal and not merely about an answer that has not come yet. */
      const owed = () => app.seen.slice(mark).filter((r) => who(r) === "Ada" && r.last.includes("has just replied to you"));
      const deadline = Date.now() + 20_000;
      while (owed().length === 0 && Date.now() < deadline) { await sleep(250); }
      assert.ok(owed().length > 0, "Ada was asked for the answer she owed");
      await sleep(5000);
      const list = await comments();
      assert.equal(list.length, list0.length + 1, "the only thing added is the person's comment: the echo was refused");
      assert.equal(list[list.length - 1].id, said, "the person's comment is still the thread's last word");
      echo = false;
    });

    await test("a scripted model that comments on the post twice, or answers the same comment twice, is refused", async () => {
      /* Through the thread tool, as a scripted model would, with nothing kind about it. The thread's last word is the
         person's, so what refuses these two is the budget itself - a second comment of its own, and a second answer to
         one comment - and not the "second comment in a row" or the no-repeat rules the cases above are about. */
      const list0 = await comments();
      const theirs = (c: { by: { name: string } }) => !["Ada", "Ben", "Cy"].includes(c.by.name);
      const answered = list0.filter(theirs).find((c) => list0.some((a) => a.by.name === "Ada" && a.parent === c.id))!;
      assert.notEqual(list0[list0.length - 1].by.name, "Ada", "with the person last, the budget is what refuses these");

      const s2 = await app.newSession("scripted", "build");
      app.script.push({
        tools: [
          { name: "thread", args: { action: "comment", post, text: "Ada: one more thought of my own, in words I have not used here.", as: "Ada" } },
          { name: "thread", args: { action: "comment", post, text: "Ada: and a second answer to that same comment.", reply_to: answered.id, as: "Ada" } },
        ],
      });
      app.script.push({ text: "done" });
      await app.turn(s2, "try to say two things at once");

      const told = app.seen
        .flatMap((r) => r.messages)
        .filter((m) => m.role === "tool")
        .map((m) => String(m.content ?? ""))
        .join("\n");
      assert.match(told, /it has already commented on this post/, "a second comment of its own was refused");
      assert.match(told, /it has already answered that comment/, "a second answer to the same comment was refused");
      const list = await comments();
      assert.equal(list.length, list0.length, "and neither was posted in its place");
    });

  } finally {
    await app.stop();
  }
  console.log(`${passed} passed`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
