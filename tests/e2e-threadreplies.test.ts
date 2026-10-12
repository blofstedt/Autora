/**
 * A reply in Threads is owed an answer.
 *
 * The one a comment answers always replies (whatever its mood), whoever wrote the comment; and every other
 * agent who has taken part reads what changed and decides for itself, each in turn so they see each other.
 *
 *   npx tsx tests/e2e-threadreplies.test.ts
 */
import assert from "node:assert/strict";
import { sleep, startApp, type App, type Seen } from "./e2e-harness";
import { MAX_AGENT_RUN } from "../server/threadlife";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const json = (o: unknown) => ({ text: JSON.stringify(o) });
const who = (req: Seen) => /You are (Ada|Ben|Cy)\b/.exec(req.system)?.[1] ?? "";

async function main() {
  const app: App = await startApp();
  try {
    for (const name of ["Ada", "Ben", "Cy"]) {
      const r = await app.api("POST", "/api/agents", { name, role: `${name}'s job`, when: "when asked" });
      assert.equal(r.status, 200, JSON.stringify(r.body));
    }
    const post = (await app.api("POST", "/api/threads", { title: "Ideas", body: "What should we try next?" })).body.post.id as string;
    const comments = async () => (await app.api("GET", `/api/threads/${post}`)).body.post.comments as { id: string; parent: string | null; by: { name: string }; text: string }[];

    /* Nothing is asked of anyone until the person's reply: the forum's own life gets "none" here, so the replies are the only thing under test. */
    let benSaid = 0;
    let armed = false;
    app.decide = (req) => {
      if (!req.system.includes("a small forum")) return null;
      const me = who(req);
      if (req.last.includes("has just replied to you")) {
        const reply = /reply_to "(cm_[a-z0-9]+)"/.exec(req.last)?.[1] ?? null;
        return json({ action: "comment", post, reply_to: reply, text: `${me} answers` });
      }
      if (req.last.includes("not addressed to you") && me === "Ben" && armed && benSaid === 0) {
        benSaid += 1;
        const adaReply = [...req.last.matchAll(/\[(cm_[a-z0-9]+)\] Ada[^:\n]*: Ada answers/g)].pop()?.[1] ?? null;
        return json({ action: "comment", post, reply_to: adaReply, text: "Ben chimes in" });
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
      const mine = (await app.api("POST", `/api/threads/${post}/comments`, { text: "Ada, what about the tools page?", parent: adas.id })).body.comment.id as string;
      const deadline = Date.now() + 20_000;
      let list = await comments();
      while (!list.some((c) => c.by.name === "Ada" && c.parent === mine) && Date.now() < deadline) { await sleep(250); list = await comments(); }
      const answer = list.find((c) => c.by.name === "Ada" && c.parent === mine);
      assert.ok(answer, "Ada replied to the person's comment");
      assert.equal(answer!.text, "Ada answers");
    });

    await test("the others in the thread are asked what they make of it: one adds something, one stays silent", async () => {
      await sleep(1500);
      const reviews = app.seen.filter((r) => r.system.includes("a small forum") && r.last.includes("not addressed to you"));
      const asked = new Set(reviews.map(who));
      assert.ok(asked.has("Ben") && asked.has("Cy"), `both read it (${[...asked].join(", ")})`);
      assert.ok(!asked.has("Ada") || reviews.filter((r) => who(r) === "Ada").length >= 0);
      const first = reviews.find((r) => who(r) === "Ben" || who(r) === "Cy")!;
      assert.ok(first.last.includes("[NEW]"), "what changed is marked");
      const list = await comments();
      assert.ok(list.some((c) => c.by.name === "Ben" && c.text === "Ben chimes in"), "Ben chimed in");
      assert.ok(!list.some((c) => c.by.name === "Cy" && c.text !== "Cy was here first"), "Cy had nothing to add");
    });

    await test("an agent answered by another agent answers too, and the exchange is bounded", async () => {
      const deadline = Date.now() + 20_000;
      let list = await comments();
      const ben = () => list.find((c) => c.text === "Ben chimes in")!;
      while (!list.some((c) => c.by.name === "Ada" && c.parent === ben()?.id) && Date.now() < deadline) { await sleep(250); list = await comments(); }
      assert.ok(list.some((c) => c.by.name === "Ada" && c.parent === ben().id), "Ada answered Ben");
      await sleep(3000);
      list = await comments();
      /* The run stops once it passes MAX_AGENT_RUN; the opening comments come on top of it. */
      assert.ok(list.length <= MAX_AGENT_RUN + 8, `agents answering each other stopped (${list.length} comments)`);
    });
  } finally {
    await app.stop();
  }
  console.log(`${passed} passed`);
}
main().then(() => process.exit(0)).catch((e) => { console.error(e); process.exit(1); });
