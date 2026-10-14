/**
 * "Answer without thinking" is a wish, not a need.
 *
 * Some OpenRouter models (z-ai/glm-5.3-flash) reply 400 "Reasoning is mandatory
 * for this endpoint and cannot be disabled" to the off switch. The turn must
 * not fail for it: the call is made again without the switch, and that model is
 * not asked to switch off again.
 *
 * The body is read off a real HTTP server, as in endpoint-pin.test.ts.
 *
 *   npx tsx tests/thinking-off.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-thinking-off-"));
const { streamChat } = await import("../server/llm");

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const bodies: any[] = [];
let mandatory = true;
const vendor = http.createServer((req, res) => {
  let raw = "";
  req.on("data", (chunk) => { raw += chunk; });
  req.on("end", () => {
    const body = JSON.parse(raw);
    bodies.push(body);
    if (mandatory && body.reasoning?.enabled === false) {
      res.writeHead(400, { "Content-Type": "application/json" });
      return void res.end(JSON.stringify({ error: { message: "Reasoning is mandatory for this endpoint and cannot be disabled.", code: 400 } }));
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" });
    res.write(`data: ${JSON.stringify({ choices: [{ delta: { content: "hi" } }] })}\n\n`);
    res.write(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: "stop" }], usage: { prompt_tokens: 1, completion_tokens: 1 } })}\n\n`);
    res.write("data: [DONE]\n\n");
    res.end();
  });
});
vendor.listen(0);
await new Promise((r) => vendor.once("listening", r));
const base = `http://127.0.0.1:${(vendor.address() as { port: number }).port}/api/v1`;

const ask = (model: string) => streamChat({
  provider: "openrouter", model, key: "k", baseUrl: base,
  system: "", messages: [{ role: "user", text: "hi" }], thinking: "off",
}, () => undefined);

await test("a model that refuses the off switch is asked again without it, and answers", async () => {
  bodies.length = 0;
  const turn = await ask("z-ai/glm-5.3-flash");
  assert.equal(turn.text, "hi");
  assert.equal(bodies.length, 2);
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
  assert.equal(bodies[1].reasoning, undefined);
  assert.equal(bodies[1].thinking, undefined, "no GLM thinking switch on the second try either");
});

await test("the next call to that model does not ask again", async () => {
  bodies.length = 0;
  await ask("z-ai/glm-5.3-flash");
  assert.equal(bodies.length, 1);
  assert.equal(bodies[0].reasoning, undefined);
});

await test("a model that accepts the switch still gets it", async () => {
  mandatory = false;
  bodies.length = 0;
  await ask("some/other-model");
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].reasoning, { enabled: false });
});

await test("any other error is still an error", async () => {
  const failing = http.createServer((_req, res) => {
    res.writeHead(401, { "Content-Type": "application/json" });
    res.end(JSON.stringify({ error: { message: "bad key" } }));
  });
  failing.listen(0);
  await new Promise((r) => failing.once("listening", r));
  const url = `http://127.0.0.1:${(failing.address() as { port: number }).port}/api/v1`;
  await assert.rejects(streamChat({
    provider: "openrouter", model: "x/y", key: "k", baseUrl: url,
    system: "", messages: [{ role: "user", text: "hi" }], thinking: "off",
  }, () => undefined), /bad key/);
  failing.close();
});

vendor.close();
console.log(`\n${passed} passed`);
process.exit(0);
