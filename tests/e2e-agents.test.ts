/**
 * The Organization and Threads in a whole Autora: the lead is told the map,
 * starts an agent that hands its report to the next, and the forum routes work
 * the way the page uses them.
 *
 *   npx tsx tests/e2e-agents.test.ts
 */
import assert from "node:assert/strict";
import { startApp, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app: App = await startApp();
  try {
    let editor = "";
    let books = "";

    await test("agents are made over HTTP, a loop in the map is refused, and the list comes back as a tree", async () => {
      const made = await app.api("POST", "/api/agents", { name: "Bookkeeper", role: "Keeps the numbers", when: "after an edit changes a figure" });
      assert.equal(made.status, 200, JSON.stringify(made.body));
      books = made.body.agent.id;
      const e = await app.api("POST", "/api/agents", { name: "Editor", role: "Tightens prose", when: "a draft needs tightening", instructions: "Cut by a fifth.", next: [books] });
      assert.equal(e.status, 200, JSON.stringify(e.body));
      editor = e.body.agent.id;
      assert.equal((await app.api("PATCH", `/api/agents/${editor}`, { reportsTo: editor })).status, 400);
      assert.equal((await app.api("POST", "/api/agents", { name: "editor" })).status, 400);
      assert.equal((await app.api("PATCH", "/api/agents/agent_nope", { role: "x" })).status, 404);
      // Dragging one agent under another on the chart is this PATCH, and its own team goes with it.
      const under = await app.api("POST", "/api/agents", { name: "Proofreader", reportsTo: editor });
      assert.equal(under.status, 200);
      assert.equal((await app.api("PATCH", `/api/agents/${editor}`, { reportsTo: under.body.agent.id })).status, 400, "not under its own team");
      assert.equal((await app.api("PATCH", `/api/agents/${editor}`, { reportsTo: books })).status, 200);
      const moved = (await app.api("GET", "/api/agents")).body.tree;
      const bookkeeper = moved.reports.find((n: any) => n.agent.id === books);
      assert.deepEqual(bookkeeper.reports.map((n: any) => n.agent.name), ["Editor"]);
      assert.deepEqual(bookkeeper.reports[0].reports.map((n: any) => n.agent.name), ["Proofreader"]);
      assert.equal((await app.api("DELETE", `/api/agents/${under.body.agent.id}`)).status, 200);
      assert.equal((await app.api("PATCH", `/api/agents/${editor}`, { reportsTo: "agent_autora" })).status, 200);
      const list = await app.api("GET", "/api/agents");
      assert.equal(list.body.agents.length, 3);
      assert.equal(list.body.tree.agent.id, "agent_autora");
      assert.equal(list.body.tree.reports.length, 2);
      assert.equal((await app.api("DELETE", "/api/agents/agent_autora")).status, 400);
    });

    await test("the lead is told the map, starts the Editor, and the Editor's report goes on to the Bookkeeper", async () => {
      app.seen.length = 0;
      app.decide = (req) => {
        if (req.last.includes("Continue from Editor")) return { text: "Books updated: figures match." };
        if (req.last.includes("You are Editor")) return { text: "Tightened: cut 20%." };
        if (req.last.includes("Books updated")) return { text: "Both agents finished." };
        if (req.last.includes("Review chapter 2")) return { tools: [{ name: "agents", args: { action: "run", agent: "Editor", task: "Tighten chapter 2" } }] };
        return { text: "ok" };
      };
      const s = await app.newSession("org", "build");
      const ev = await app.turn(s, "Review chapter 2");
      assert.match(app.seen[0].system, /Your organization/);
      assert.match(app.seen[0].system, /Editor \(agent_[0-9a-f]+\), Tightens prose\. Reports to Autora\. Call it when: a draft needs tightening Then hands to: Bookkeeper/);
      assert.ok(app.seen[0].tools.includes("agents") && app.seen[0].tools.includes("thread"));
      assert.ok(ev.some((e) => e.kind === "tool.result" && e.payload.ok === true));
      const back = app.seen.find((r) => r.last.includes("Books updated: figures match") && r.last.includes("---"))!;
      assert.ok(back, "the lead was handed both reports back");
      assert.match(back.last, /Editor \(session-[^)]+\):\nTightened: cut 20%/);
      assert.match(back.last, /Bookkeeper \(session-[^)]+\):\nBooks updated: figures match/);
      const sessions = (await app.api("GET", "/api/sessions")).body as { id: string; title: string }[];
      assert.ok(sessions.some((x) => x.title.startsWith("Editor: Tighten chapter 2")), "the Editor had a chat of its own");
      assert.ok(sessions.some((x) => x.title.startsWith("Bookkeeper: Continue from Editor")), "and the Bookkeeper followed in another");
      const handed = app.seen.find((r) => r.last.includes("Continue from Editor"))!;
      assert.match(handed.last, /Tightened: cut 20%/, "the Bookkeeper was given the Editor's report");
      assert.match(handed.last, /handed to you by Autora -> Editor/);
      app.decide = null;
    });

    await test("a specialist works from its own mind and never sees Autora's; what it learns stays its own", async () => {
      const made = await app.api("POST", "/api/agents", { name: "Walrus Keeper", role: "Knows the walrus protocol", when: "anything about the walrus protocol" });
      assert.equal(made.status, 200, JSON.stringify(made.body));
      const keeper: string = made.body.agent.id;
      // Autora's own Mind knows a handshake; the lead teaches the Keeper the protocol into the Keeper's own mind.
      await app.api("POST", "/api/memory", { title: "Secret handshake", body: "The secret handshake is pineapple, said twice.", kind: "fact", subject: "handshake" });
      await app.api("POST", "/api/memory", { title: "Walrus protocol", body: "The walrus protocol: always bring a flask and wave twice.", kind: "fact", subject: "walrus protocol" });
      let wrote = false;
      app.seen.length = 0;
      app.decide = (req) => {
        if (req.last.includes("Hand over the walrus knowledge")) {
          return { tools: [{ name: "agents", args: { action: "teach", agent: "Walrus Keeper", query: "walrus protocol" } }] };
        }
        if (req.last.includes("Moved") && req.last.includes("walrus")) return { text: "Handed over." };
        if (req.last.includes("Ask the keeper")) {
          return { tools: [{ name: "agents", args: { action: "run", agent: "Walrus Keeper", task: "Explain the walrus protocol and the secret handshake." } }] };
        }
        if (req.last.includes("You are Walrus Keeper")) {
          return { tools: [{ name: "set_mode", args: { to: "build", reason: "writing a memory" } }] };
        }
        if (!wrote && /build|mode/i.test(req.last) && req.messages.some((m) => JSON.stringify(m.content).includes("You are Walrus Keeper"))) {
          wrote = true;
          return { tools: [{ name: "memory_write", args: { title: "Walrus keeper: flasks come full", body: "A flask for the walrus protocol is brought full, never empty.", kind: "fact", subject: "walrus protocol" } }] };
        }
        return { text: "Done." };
      };
      const s = await app.newSession("split", "build");
      await app.turn(s, "Hand over the walrus knowledge");
      const mine = (await app.api("GET", "/api/memory")).body;
      const titles = (mine.records ?? mine.memories ?? mine).map((r: any) => r.title);
      assert.ok(!titles.includes("Walrus protocol"), "the knowledge left Autora's Mind");
      assert.ok(titles.includes("Secret handshake"), "and the rest stayed");
      const held = (await app.api("GET", `/api/agents/${keeper}/mind`)).body;
      assert.ok(held.memories.some((m: any) => /flask/.test(m.text)), "it is in the Keeper's own mind");

      app.seen.length = 0;
      await app.turn(s, "Ask the keeper about it");
      const child = app.seen.find((r) => r.last.includes("You are Walrus Keeper"))!;
      assert.ok(child, "the Keeper was started");
      const asked = `${child.system}\n${JSON.stringify(child.messages)}`;
      assert.match(asked, /flask/, "it recalls from its own mind");
      assert.doesNotMatch(asked, /pineapple/, "and never from Autora's, though the task named the handshake");
      const after = (await app.api("GET", `/api/agents/${keeper}/mind`)).body;
      assert.ok(after.memories.some((m: any) => /never empty/.test(m.text)), "what it learned went into its own mind");
      const main = (await app.api("GET", "/api/memory")).body;
      const mainText = JSON.stringify(main);
      assert.ok(!/never empty/.test(mainText), "and not into Autora's");
      app.decide = null;
    });

    await test("a switched-off agent is skipped, and an unknown one is refused", async () => {
      await app.api("PATCH", `/api/agents/${editor}`, { enabled: false });
      app.decide = (req) => {
        if (req.last.includes("Try them")) return { tools: [{ name: "agents", args: { action: "run", agent: "Editor", task: "x" } }, { name: "agents", args: { action: "run", agent: "Ghost", task: "x" } }] };
        return { text: "Noted." };
      };
      const s = await app.newSession("off", "build");
      const ev = await app.turn(s, "Try them");
      assert.equal(ev.filter((e) => e.kind === "tool.error").length, 2, "both were refused");
      const told = app.seen[app.seen.length - 1].messages.map((m) => JSON.stringify(m.content)).join("\n");
      assert.match(told, /Editor is switched off/);
      assert.match(told, /There is no agent \\"Ghost\\"/);
      app.decide = null;
    });

    await test("the person posts, comments, replies and likes over HTTP, and the order follows the likes", async () => {
      const a = await app.api("POST", "/api/threads", { title: "First", body: "Hello **agents**", tags: ["intro"] });
      assert.equal(a.status, 200, JSON.stringify(a.body));
      const b = await app.api("POST", "/api/threads", { title: "Second" });
      assert.equal((await app.api("POST", "/api/threads", { title: " " })).status, 400);
      const c = await app.api("POST", `/api/threads/${a.body.post.id}/comments`, { text: "Welcome" });
      const r = await app.api("POST", `/api/threads/${a.body.post.id}/comments`, { text: "Thanks", parent: c.body.comment.id });
      assert.equal(r.body.comment.parent, c.body.comment.id);
      assert.equal((await app.api("POST", `/api/threads/${a.body.post.id}/comments`, { text: "x", parent: "cm_nope" })).status, 404);
      const liked = await app.api("POST", `/api/threads/${a.body.post.id}/like`, {});
      assert.deepEqual(liked.body.post.likes, ["user"]);
      assert.equal((await app.api("GET", "/api/threads?sort=top")).body.posts[0].id, a.body.post.id);
      assert.equal((await app.api("GET", "/api/threads?sort=new")).body.posts[0].id, b.body.post.id);
      assert.equal((await app.api("DELETE", `/api/threads/${a.body.post.id}/comments/${c.body.comment.id}`)).status, 200);
      assert.equal((await app.api("GET", `/api/threads/${a.body.post.id}`)).body.post.comments.length, 0, "the reply went with its comment");
      assert.equal((await app.api("DELETE", `/api/threads/${b.body.post.id}`)).status, 200);
      assert.equal((await app.api("GET", `/api/threads/${b.body.post.id}`)).status, 404);
    });

    await test("an agent's post in a chat shows on the same Threads the person reads", async () => {
      app.decide = (req) => req.last.includes("Say hi")
        ? { tools: [{ name: "thread", args: { action: "post", title: "From the lead", text: "Morning all", as: "Bookkeeper" } }] }
        : { text: "Posted." };
      const s = await app.newSession("post", "build");
      await app.turn(s, "Say hi on Threads");
      const posts = (await app.api("GET", "/api/threads")).body.posts as any[];
      const mine = posts.find((p) => p.title === "From the lead");
      assert.ok(mine);
      assert.deepEqual([mine.by.kind, mine.by.name], ["agent", "Bookkeeper"]);
      app.decide = null;
    });
  } finally {
    await app.stop();
  }
  console.log(`${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
