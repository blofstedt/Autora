/**
 * Jev Mode, end to end against a fake OpenAI-compatible server.
 *
 *   npx tsx tests/jev.test.ts
 *
 * The fake answers each field request with top_logprobs chosen by the test,
 * so the parser, the scoring, the threshold, the fallbacks and the breaker
 * can all be checked without a real model or a key.
 */
import assert from "node:assert/strict";
import http from "node:http";
import { parseSchema } from "../server/jev/schema";
import { scoreField } from "../server/jev/engine";
import { decide, resetHealth, supportFor } from "../server/jev/router";
import type { JevTarget } from "../server/jev/engine";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

// ------------------------------------------------------------ fake server --
type Reply = (field: string) => { status?: number; body: unknown; delayMs?: number };
let reply: Reply = () => ({ body: {} });
const seen: { system: string; user: string }[] = [];

const server = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (c) => (raw += c));
  req.on("end", async () => {
    const body = JSON.parse(raw || "{}");
    const system = body.messages?.find((m: any) => m.role === "system")?.content ?? "";
    const user = body.messages?.find((m: any) => m.role === "user")?.content ?? "";
    seen.push({ system, user });
    const field = /Field "([^"]+)"/.exec(user)?.[1] ?? "";
    const r = reply(field);
    if (r.delayMs) await new Promise((ok) => setTimeout(ok, r.delayMs));
    res.writeHead(r.status ?? 200, { "Content-Type": "application/json" });
    res.end(JSON.stringify(r.body));
  });
});

const ok = (top: [string, number][]) => ({
  body: {
    choices: [{ logprobs: { content: [{
      token: top[0][0], logprob: Math.log(top[0][1]),
      top_logprobs: top.map(([token, p]) => ({ token, logprob: Math.log(p) })),
    }] } }],
    usage: { prompt_tokens: 100, completion_tokens: 1, prompt_tokens_details: { cached_tokens: 80 } },
  },
});

async function main() {
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const port = (server.address() as any).port;
  const target: JevTarget = {
    provider: "local", kind: "openai", baseUrl: `http://127.0.0.1:${port}/v1`, key: "", model: "fake",
  };
  const on = { enabled: true, threshold: 0.75 };

  const schema = {
    type: "object",
    properties: {
      priority: { type: "string", enum: ["low", "medium", "high"] },
      urgent: { type: "boolean" },
      stars: { type: "integer", minimum: 1, maximum: 5 },
    },
  };

  console.log("schema parser");
  await test("enum, boolean and small integer range are eligible", () => {
    const p = parseSchema(schema);
    assert.equal(p.eligible, true);
    assert.deepEqual(p.fields.map((f) => f.options.length), [3, 2, 5]);
    assert.deepEqual(p.fields[0].options.map((o) => o.label), ["A", "B", "C"]);
  });
  await test("free text makes the decision ineligible", () => {
    const p = parseSchema({ properties: { note: { type: "string" }, ok: { type: "boolean" } } });
    assert.equal(p.eligible, false);
    assert.match(p.reasons.join(), /note/);
  });
  await test("declared and described dependencies are detected", () => {
    assert.equal(parseSchema({ properties: {
      items: { type: "boolean" }, total: { type: "boolean", "x-depends-on": ["items"] },
    } }).eligible, false);
    assert.equal(parseSchema({ properties: {
      items: { type: "boolean" }, total: { type: "boolean", description: "computed from `items`" },
    } }).eligible, false);
    assert.equal(parseSchema({
      properties: { a: { type: "boolean" }, b: { type: "boolean" } },
      dependentRequired: { a: ["b"] },
    }).eligible, false);
  });
  await test("more options than can be scored is ineligible", () => {
    assert.equal(parseSchema({ properties: { n: { type: "integer", minimum: 0, maximum: 99 } } }).eligible, false);
  });

  console.log("scoring");
  await test("spelling variants of a label are folded together", () => {
    const field = parseSchema(schema).fields[0];
    const s = scoreField(field, [
      { token: " A", logprob: Math.log(0.5) },
      { token: "A)", logprob: Math.log(0.3) },
      { token: "B", logprob: Math.log(0.1) },
      { token: "Hello", logprob: Math.log(0.1) },
    ]);
    assert.equal(s.value, "low");
    assert.ok(Math.abs(s.confidence - 0.8 / 0.9) < 1e-9);
    assert.ok(Math.abs(s.coverage - 0.9) < 1e-9);
  });

  console.log("router");
  await test("confident fields take the fast path with a valid payload", async () => {
    resetHealth();
    seen.length = 0;
    reply = (f) => f === "priority" ? ok([["C", 0.95], ["B", 0.04]])
      : f === "urgent" ? ok([["A", 0.9], ["B", 0.1]])
      : ok([[" D", 0.97], ["E", 0.02]]);
    const out = await decide({ name: "t", context: "ship it now", schema }, target, on);
    assert.equal(out.mode, "jev");
    if (out.mode !== "jev") return;
    assert.deepEqual(out.values, { priority: "high", urgent: true, stars: 4 });
    assert.equal(out.usage.cached, 240);
    // One request per field, all with the same prefix -- the cacheable part.
    assert.equal(seen.length, 3);
    assert.equal(new Set(seen.map((s) => s.system)).size, 1);
  });
  await test("one unsure field sends the whole decision to the fallback", async () => {
    resetHealth();
    reply = (f) => f === "urgent" ? ok([["A", 0.55], ["B", 0.45]]) : ok([["A", 0.99]]);
    const out = await decide({ name: "t", context: "", schema }, target, on);
    assert.equal(out.mode, "fallback");
    if (out.mode !== "fallback") return;
    assert.equal(out.attempted, true);
    assert.match(out.reason, /urgent/);
  });
  await test("an answer that is not a letter is low coverage, not confidence", async () => {
    resetHealth();
    reply = () => ok([["Sure", 0.9], ["A", 0.05]]);
    const out = await decide({ name: "t", context: "", schema }, target, on);
    assert.equal(out.mode, "fallback");
  });
  await test("a backend without logprobs is remembered as unsupported", async () => {
    resetHealth();
    seen.length = 0;
    reply = () => ({ status: 400, body: { error: { message: "logprobs is not supported" } } });
    const first = await decide({ name: "t", context: "", schema }, target, on);
    assert.equal(first.mode, "fallback");
    const asked = seen.length;
    assert.equal(asked, 1, "an unknown backend is probed with one field first");
    const second = await decide({ name: "t", context: "", schema }, target, on);
    assert.equal(second.mode, "fallback");
    assert.equal(seen.length, asked, "no further requests once known unsupported");
    assert.equal(supportFor(target).state, "no");
  });
  await test("repeated failures open the breaker", async () => {
    resetHealth();
    reply = () => ({ status: 500, body: { error: { message: "boom" } } });
    for (let i = 0; i < 3; i++) await decide({ name: "t", context: "", schema }, target, on);
    seen.length = 0;
    const out = await decide({ name: "t", context: "", schema }, target, on);
    assert.equal(out.mode, "fallback");
    assert.equal(seen.length, 0);
  });
  await test("a slow backend times out into the fallback", async () => {
    resetHealth();
    reply = () => ({ ...ok([["A", 0.99]]), delayMs: 400 });
    const out = await decide({ name: "t", context: "", schema, timeoutMs: 100 }, target, on);
    assert.equal(out.mode, "fallback");
  });
  await test("off, Anthropic, and reasoning models never make a request", async () => {
    resetHealth();
    seen.length = 0;
    assert.equal((await decide({ name: "t", context: "", schema }, target, { ...on, enabled: false })).mode, "fallback");
    assert.equal((await decide({ name: "t", context: "", schema }, { ...target, kind: "anthropic" }, on)).mode, "fallback");
    assert.equal((await decide({ name: "t", context: "", schema }, { ...target, model: "gpt-5-mini" }, on)).mode, "fallback");
    assert.equal(seen.length, 0);
  });

  server.close();
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  server.close();
  process.exit(1);
});
