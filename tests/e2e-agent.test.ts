/**
 * The agent loop, end to end: the real server, a scripted model.
 *
 * What is checked is what a person would see and what the model is told --
 * the prompt it gets, what happens to its tool calls, and what the thread
 * records when things go wrong. Each case starts from its own session.
 *
 *   npx tsx tests/e2e-agent.test.ts
 */
import assert from "node:assert/strict";
import { startApp, type App, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const kinds = (ev: Ev[]) => ev.map((e) => e.kind);
const texts = (ev: Ev[]) => ev.filter((e) => e.kind === "turn.agent.text").map((e) => e.payload.text).join("");

async function main() {
  const app: App = await startApp();
  try {
    console.log("a plain turn");
    await test("a reply streams into the thread, is billed, and the turn ends", async () => {
      app.script.push({ text: "Hello there, friend." });
      const s = await app.newSession();
      const ev = await app.turn(s, "hi");
      assert.equal(texts(ev), "Hello there, friend.");
      assert.ok(kinds(ev).includes("usage.turn"));
      assert.equal(kinds(ev).at(-1), "turn.agent.done");
      const usage = await app.api("GET", "/api/usage");
      assert.ok(usage.body.today.turns >= 1);
    });

    console.log("what the model is told");
    await test("standing instructions are in the system prompt, last, and repeated on the turn's note", async () => {
      const set = await app.api("PATCH", "/api/settings", { system_prompt: "Be concise. Answer in bullet points, three at most." });
      assert.equal(set.status, 200);
      app.seen.length = 0;
      app.script.push({ text: "- one" });
      const s = await app.newSession();
      await app.turn(s, "explain the moon");
      const first = app.seen[0];
      assert.match(first.system, /=== THE PERSON'S STANDING INSTRUCTIONS ===\n[\s\S]*Be concise\. Answer in bullet points[\s\S]*=== END STANDING INSTRUCTIONS ===/);
      assert.ok(first.system.trimEnd().endsWith("=== END STANDING INSTRUCTIONS ==="), "they are the last thing in the instructions");
      assert.doesNotMatch(first.system, /final answer in full/, "the console's own default gives way");
      assert.match(first.last, /Be concise\. Answer in bullet points/, "and they ride on the latest message");
      assert.match(first.last, /explain the moon/);
      await app.api("PATCH", "/api/settings", { system_prompt: "" });
    });
    await test("the 8000-character limit is kept, and what is saved is what is used", async () => {
      const long = "x".repeat(9000);
      const set = await app.api("PATCH", "/api/settings", { system_prompt: long });
      assert.equal(set.status, 200);
      const got = (await app.api("GET", "/api/settings")).body;
      assert.equal(got.system_prompt.length, 8000);
      assert.equal(got.system_prompt_limit, 8000);
      await app.api("PATCH", "/api/settings", { system_prompt: "" });
    });

    console.log("tools");
    await test("a tool call runs, its result is shown, and the model is given it", async () => {
      app.seen.length = 0;
      app.script.push({ text: "Running it.", tools: [{ name: "terminal", args: { command: "echo hello-from-the-shell" } }] });
      app.script.push({ text: "It printed hello." });
      const s = await app.newSession();
      const ev = await app.turn(s, "run echo");
      assert.ok(kinds(ev).includes("tool.call"));
      assert.ok(ev.some((e) => e.kind.startsWith("pty.") && JSON.stringify(e.payload).includes("hello-from-the-shell")), "the output is in the thread");
      assert.equal(app.seen.length, 2, "one call for the tool, one after its result");
      const back = app.seen[1].messages.filter((m) => m.role === "tool").map((m) => JSON.stringify(m.content)).join("");
      assert.match(back, /hello-from-the-shell/);
      assert.match(texts(ev), /It printed hello/);
    });
    await test("several calls in one message are all run and all answered, in order", async () => {
      app.seen.length = 0;
      app.script.push({ tools: [
        { name: "terminal", args: { command: "echo first-one" } },
        { name: "terminal", args: { command: "echo second-one" } },
      ] });
      app.script.push({ text: "Both done." });
      const s = await app.newSession();
      const ev = await app.turn(s, "two commands");
      assert.equal(ev.filter((e) => e.kind === "tool.call").length, 2);
      const results = app.seen[1].messages.filter((m) => m.role === "tool");
      assert.equal(results.length, 2, "every call is answered, or the provider refuses the next request");
      assert.match(JSON.stringify(results[0].content), /first-one/);
      assert.match(JSON.stringify(results[1].content), /second-one/);
      const ids = new Set(app.seen[1].messages.flatMap((m) => (m.tool_calls ?? []).map((c: any) => c.id)));
      for (const r of results) assert.ok(ids.has(r.tool_call_id), "each result names the call it answers");
    });
    await test("a tool that does not exist is answered with the ones that do, and the turn goes on", async () => {
      app.seen.length = 0;
      app.script.push({ tools: [{ name: "teleport_home", args: {} }] });
      app.script.push({ text: "Sorry, that tool is not there." });
      const s = await app.newSession();
      const ev = await app.turn(s, "go");
      assert.ok(ev.some((e) => e.kind === "tool.error"));
      assert.match(JSON.stringify(app.seen[1].messages.filter((m) => m.role === "tool")), /There is no tool called \\"teleport_home\\"|no tool called/);
      assert.equal(kinds(ev).at(-1), "turn.agent.done");
    });
    await test("a command that fails is reported with its exit code, not hidden", async () => {
      app.seen.length = 0;
      app.script.push({ tools: [{ name: "terminal", args: { command: "sh -c 'echo nope >&2; exit 3'" } }] });
      app.script.push({ text: "It failed." });
      const s = await app.newSession();
      const ev = await app.turn(s, "fail");
      const back = JSON.stringify(app.seen[1].messages.filter((m) => m.role === "tool"));
      assert.match(back, /exit(ed)?( with)?( code)?:? ?3|\b3\b/);
      assert.match(back, /nope/);
      assert.equal(kinds(ev).at(-1), "turn.agent.done");
    });

    console.log("when things go wrong");
    await test("a provider that refuses is said in the thread, and the session is still usable", async () => {
      app.script.push({ status: 400, error: "context length exceeded" });
      const s = await app.newSession();
      const ev = await app.turn(s, "this will fail", 30_000);
      assert.ok(ev.some((e) => e.kind === "system.error" || e.kind === "context.note" || (e.kind === "turn.agent.text" && /context length|could not|went wrong|error/i.test(e.payload.text))),
        `nothing in the thread says it failed: ${kinds(ev).join(",")}`);
      app.script.push({ text: "Back again." });
      const again = await app.turn(s, "still there?");
      assert.match(texts(again), /Back again/);
    });
    await test("stop ends a turn that is streaming, and says so", async () => {
      app.script.push({ text: "word ".repeat(200), slow: true });
      const s = await app.newSession();
      await app.say(s, "talk for a long time");
      await app.until(s, (ev) => ev.some((e) => e.kind === "turn.agent.text"), "the reply to start");
      const stop = await app.api("POST", `/api/sessions/${s}/interrupt`);
      assert.equal(stop.status, 200);
      const ev = await app.until(s, (e) => e.some((x) => x.kind === "turn.agent.done"), "the turn to end", 10_000);
      assert.ok(texts(ev).length < 200 * 5, "it did not run to the end");
      app.script.push({ text: "Ready." });
      assert.match(texts(await app.turn(s, "ok")), /Ready/);
    });

    console.log("the guard");
    await test("a risky command the model says is destructive and unrequested is held, and it is told why", async () => {
      app.seen.length = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": true, "requested": false}' };
        if (req.messages.some((m) => m.role === "tool")) return { text: "Understood, I will not." };
        return { tools: [{ name: "terminal", args: { command: `rm -rf ${app.home}/precious` } }] };
      };
      const s = await app.newSession();
      const ev = await app.turn(s, "tidy up a bit");
      assert.ok(ev.some((e) => e.kind === "tool.error" && e.payload.guarded), "the call was held");
      assert.ok(!ev.some((e) => e.kind === "pty.output" && /rm -rf/.test(JSON.stringify(e.payload)) && e.payload.exit === 0));
      const told = JSON.stringify(app.seen.at(-1)!.messages.filter((m) => m.role === "tool"));
      assert.match(told, /Held by the guard/);
      assert.match(told, /ask_user/);
      app.decide = null;
    });
    await test("the same command runs when the model says the person asked for it", async () => {
      app.seen.length = 0;
      const target = `${app.home}/scratch-dir`;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": true, "requested": true}' };
        if (req.messages.some((m) => m.role === "tool")) return { text: "Deleted." };
        return { tools: [{ name: "terminal", args: { command: `mkdir -p ${target} && rm -rf ${target} && echo gone` } }] };
      };
      const s = await app.newSession();
      const ev = await app.turn(s, "delete the scratch-dir folder");
      assert.ok(!ev.some((e) => e.kind === "tool.error" && e.payload.guarded));
      assert.match(JSON.stringify(app.seen.at(-1)!.messages.filter((m) => m.role === "tool")), /gone/);
      app.decide = null;
    });
    await test("a model that cannot be asked never stops the work", async () => {
      app.seen.length = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { status: 500, error: "overloaded" };
        if (req.messages.some((m) => m.role === "tool")) return { text: "Done." };
        return { tools: [{ name: "terminal", args: { command: `mkdir -p ${app.home}/a && rm -rf ${app.home}/a && echo removed` } }] };
      };
      const s = await app.newSession();
      const ev = await app.turn(s, "clean a", 40_000);
      assert.ok(!ev.some((e) => e.kind === "tool.error" && e.payload.guarded));
      assert.match(JSON.stringify(app.seen.at(-1)!.messages.filter((m) => m.role === "tool")), /removed/);
      app.decide = null;
    });
    await test("a command nothing can undo stops and asks, and a no means it never runs", async () => {
      app.seen.length = 0;
      app.decide = (req) => {
        if (req.messages.some((m) => m.role === "tool")) return { text: "Understood." };
        return { tools: [{ name: "terminal", args: { command: "rm -rf /" } }] };
      };
      const s = await app.newSession();
      await app.say(s, "wipe everything");
      const asked = await app.until(s, (ev) => ev.some((e) => e.kind === "permission.request"), "the card");
      const card = asked.find((e) => e.kind === "permission.request")!;
      assert.match(JSON.stringify(card.payload), /cannot be undone/);
      const id = card.payload.request_id ?? card.payload.id ?? card.payload.requestId;
      const answered = await app.api("POST", `/api/policy/${id}`, { approved: false, who: "user" });
      assert.equal(answered.status, 200);
      const ev = await app.until(s, (e) => e.some((x) => x.kind === "turn.agent.done"), "the turn to end");
      assert.ok(ev.some((e) => e.kind === "tool.error" && e.payload.denied));
      assert.match(JSON.stringify(app.seen.at(-1)!.messages.filter((m) => m.role === "tool")), /declined/);
      app.decide = null;
    });
  } finally {
    const log = app.log();
    await app.stop();
    if (process.env.E2E_LOG) console.log(log);
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
