/**
 * The agent offering MCP servers: what an offer is made of, that nothing is
 * installed without a yes, that a no is remembered for the session, that a
 * key goes through the secret store rather than the config, and that a
 * server the agent writes itself really runs.
 *
 *   npx tsx tests/mcpoffer.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-mcpoffer-"));

const { matchCatalog } = await import("../server/mcpcatalog");
const { planOffer } = await import("../server/mcpoffer");
const { findTool, runTool } = await import("../server/tools");
const { setSecretLookup, callMcpTool, disconnect } = await import("../server/mcp");
const { setSecret, secretFor, state } = await import("../server/state");

setSecretLookup((name) => secretFor(name) || null);

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

/** A tool context whose person answers every ask with `choice`, and records the asks. */
function context(choice: string) {
  const asked: any[] = [];
  const ctx = {
    session: "s-test",
    ask: async (request: any) => {
      asked.push(request);
      return { cancelled: false, choices: [choice], text: "", who: "user" };
    },
  } as any;
  return { ctx, asked };
}

console.log("mcp offers");

await test("requests are matched to the servers that fit", () => {
  assert.equal(matchCatalog("list the open issues on my github repo")[0]?.id, "github");
  assert.equal(matchCatalog("what does this postgres table hold")[0]?.id, "postgres");
  assert.deepEqual(matchCatalog("tell me a joke"), []);
});

await test("an offer needs a reason and a real server", () => {
  assert.equal(typeof planOffer({ server: "github" }), "string", "no why");
  assert.match(String(planOffer({ server: "nope", why: "x" })), /no catalog server/i);
  const plan = planOffer({ server: "github", why: "Reads issues directly" });
  assert.ok(typeof plan !== "string");
  assert.equal(plan.needs[0].env, "GITHUB_PERSONAL_ACCESS_TOKEN");
  assert.equal(plan.needs[0].set, false);
  assert.doesNotMatch(plan.runs, /secret/, "the card never shows a secret reference as a command");
});

await test("saying not now installs nothing and is not asked again", async () => {
  const spec = findTool("mcp_offer")!;
  const { ctx, asked } = context("Not now");
  const first = await runTool(spec, { server: "context7", why: "Current docs in one call" }, ctx);
  assert.equal(first.ok, true);
  assert.equal(asked.length, 1);
  assert.equal(asked[0].kind, "offer");
  assert.equal(asked[0].offer.name, "context7");
  assert.equal(state.mcpServers.length, 0);
  const again = await runTool(spec, { server: "context7", why: "Still better" }, ctx);
  assert.equal(again.ok, false);
  assert.match(again.summary, /already said not now/);
  assert.equal(asked.length, 1, "no second card");
});

await test("a server the agent writes runs, with its key from the secret store", async () => {
  setSecret("GREETING", "hej");
  const spec = findTool("mcp_offer")!;
  const { ctx } = context("Set it up");
  const out = await runTool(spec, {
    why: "Greets people properly",
    name: "Greeter",
    summary: "Says hello",
    needs: [{ env: "GREETING", label: "Greeting word" }],
    tools: [{
      name: "greet",
      description: "Say hello to someone",
      parameters: { properties: { who: { type: "string" } }, required: ["who"] },
      code: "return `${env.GREETING}, ${args.who}!`;",
    }],
  }, ctx);
  assert.equal(out.ok, true, out.summary);
  assert.match(out.summary, /mcp__greeter__greet/);
  const saved = state.mcpServers.find((s) => s.name === "greeter")!;
  assert.equal(saved.origin, "agent");
  assert.equal(saved.env?.GREETING, "${secret:GREETING}", "the config holds a reference, not the key");
  assert.deepEqual(await callMcpTool("mcp__greeter__greet", { who: "Ada" }), { ok: true, text: "hej, Ada!" });
  await disconnect(saved.id);
});

await test("code that does not parse is refused before anything is offered", async () => {
  const spec = findTool("mcp_offer")!;
  const { ctx, asked } = context("Set it up");
  const out = await runTool(spec, {
    why: "x", name: "broken",
    tools: [{ name: "oops", description: "d", code: "return (" }],
  }, ctx);
  assert.equal(out.ok, false);
  assert.match(out.summary, /does not parse/);
  assert.equal(asked.length, 0);
});

await test("the overview names what is set up and what can be offered", async () => {
  const out = await runTool(findTool("mcp_servers")!, { topic: "slack channel" }, {} as any);
  assert.match(out.summary, /greeter/);
  assert.match(out.summary, /slack/);
});

console.log(`\nmcp offers: ${passed} passed`);
process.exit(0);
