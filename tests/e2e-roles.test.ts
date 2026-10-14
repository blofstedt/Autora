/**
 * Roles across providers, end to end: the real server, a scripted model.
 *
 * DeepSeek builds and the planner is on OpenRouter, both pointed at the same
 * fake model, which answers by the model each request names. Checked: an Agent
 * chat plans on the planner and builds on DeepSeek, each request carrying its
 * own vendor's model; the planning chip names the planner and its vendor; each
 * call is billed to the vendor that made it; and a planner that will not answer
 * (a key refused) does not fail the turn -- the main model carries it, and the
 * chat says so.
 *
 *   npx tsx tests/e2e-roles.test.ts
 */
import assert from "node:assert/strict";
import { startApp, type App, type Seen } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const PLANNER = "planner-x";
const BUILDER = "deepseek-flash";

async function main() {
  const app: App = await startApp({ env: { DEEPSEEK_API_KEY: "sk-test", OPENROUTER_API_KEY: "sk-or-test" } });
  try {
    const set = await app.api("PATCH", "/api/settings", {
      provider: "deepseek",
      models: { deepseek: BUILDER },
      base_urls: { deepseek: app.modelUrl, openrouter: app.modelUrl },
      planner_providers: { deepseek: "openrouter" },
      planner_models: { deepseek: PLANNER },
    });
    assert.equal(set.status, 200, JSON.stringify(set.body));
    const card = set.body.catalog.find((c: { id: string }) => c.id === "deepseek");
    assert.equal(card.planner_provider, "openrouter");
    assert.equal(card.planner_model, PLANNER);
    assert.match(set.body.active.planner, /planner-x \(OpenRouter\)/);

    await test("an Agent chat plans on the other vendor's planner and builds on the main model", async () => {
      app.seen.length = 0;
      app.decide = (req: Seen) => req.model === PLANNER
        ? { tools: [{ name: "set_mode", args: { to: "build", reason: "plan is ready" } }] }
        : { text: "Built it." };
      const s = await app.newSession("Roles", "agent");
      const events = await app.turn(s, "Make the thing.");
      const models = app.seen.map((r) => r.model);
      assert.equal(models[0], PLANNER, "the turn opens planning, on the planner");
      assert.ok(models.includes(BUILDER), "and builds on the main model");
      assert.ok(models.lastIndexOf(PLANNER) < models.indexOf(BUILDER), "planner first, then builder");

      const chips = events.filter((e) => e.kind === "mode.switch");
      assert.match(String(chips[0]?.payload.model), /planner-x \(OpenRouter\)/, "the planning chip names the planner");
      assert.equal(chips.find((e) => e.payload.to === "build")?.payload.model, BUILDER);

      /* Each call billed to its own vendor. */
      const usage = events.filter((e) => e.kind === "usage.turn").map((e) => `${e.payload.provider}/${e.payload.model}`);
      assert.ok(usage.includes(`openrouter/${PLANNER}`), usage.join(", "));
      assert.ok(usage.includes(`deepseek/${BUILDER}`), usage.join(", "));
      assert.equal(events.some((e) => e.kind === "system.error"), false);
    });

    await test("a planner that will not answer leaves the turn to the main model, and says so", async () => {
      app.seen.length = 0;
      app.decide = (req: Seen) => req.model === PLANNER
        ? { status: 401, error: "key refused" }
        : { text: "Done on the main model." };
      const s = await app.newSession("Roles fallback", "agent");
      const events = await app.turn(s, "Make the other thing.");
      const models = app.seen.map((r) => r.model);
      assert.equal(models.filter((m) => m === PLANNER).length, 1, "the planner is asked once, not retried");
      assert.ok(models.includes(BUILDER));
      const said = events.filter((e) => e.kind === "system.log").map((e) => String(e.payload.message ?? ""));
      assert.ok(said.some((m) => /OpenRouter \(planner-x\) did not answer.*carries on with deepseek-flash/.test(m)), said.join("\n"));
      assert.equal(events.some((e) => e.kind === "system.error"), false, "the turn did not fail");
      assert.ok(events.some((e) => e.kind === "agent.reply" || e.kind === "turn.agent.done"));
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
