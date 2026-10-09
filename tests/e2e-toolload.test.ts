/**
 * The model is shown a short tool list, and a set comes in when it is wanted.
 *
 *   npx tsx tests/e2e-toolload.test.ts
 */
import assert from "node:assert/strict";
import { startApp, type App } from "./e2e-harness";

// The short list that grows as it is wanted is a switch now (every tool is a default tool): this file tests it.
process.env.AUTORA_LAZY_TOOLS = "1";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const offered = (r: any): string[] => r.tools ?? [];

async function main() {
  const app: App = await startApp();
  try {
    console.log("tool loading");
    await test("with lazy tools on, a plain chat is not shown the PDF, widget or scheduler tools, and is told how to get them", async () => {
      app.seen.length = 0;
      const s = await app.newSession("plain", "build");
      app.script.push({ text: "Hi." });
      await app.turn(s, "hello there");
      const req = app.seen[app.seen.length - 1] as any;
      const names = offered(req);
      assert.ok(names.includes("terminal"));
      for (const n of ["pdf_edit", "pdf_read", "widget_show", "mcp_offer", "schedule"]) assert.ok(!names.includes(n), `${n} should not be offered`);
      assert.ok(names.includes("tools_enable"));
      assert.match(req.system + JSON.stringify(req.messages), /Load one with tools_enable/);
    });

    await test("asking for a set brings it in on the next step, and it stays on the next turn", async () => {
      app.seen.length = 0;
      const s = await app.newSession("enable", "build");
      app.script.push({ tools: [{ name: "tools_enable", args: { family: "widgets" } }] });
      app.script.push({ text: "Loaded." });
      await app.turn(s, "show me something");
      const during = app.seen.map(offered);
      assert.ok(!during[0].includes("widget_show"));
      assert.ok(during[1].includes("widget_show"), "in the list on the step after");
      app.script.push({ text: "Still here." });
      await app.turn(s, "go on");
      assert.ok(offered(app.seen[app.seen.length - 1]).includes("widget_show"));
    });

    await test("what the person says brings a set in before the first step", async () => {
      app.seen.length = 0;
      const s = await app.newSession("said", "build");
      app.script.push({ text: "Sure." });
      await app.turn(s, "please merge these two PDFs");
      assert.ok(offered(app.seen[0]).includes("pdf_edit"));
      app.script.push({ text: "Yes." });
      await app.turn(s, "thanks, and now?");
      assert.ok(offered(app.seen[app.seen.length - 1]).includes("pdf_edit"), "kept after the words are gone");
    });

    await test("calling a tool from a set that is not loaded loads it and runs the call", async () => {
      app.seen.length = 0;
      const s = await app.newSession("called", "build");
      app.script.push({ tools: [{ name: "notebook", args: { action: "list" } }] });
      app.script.push({ text: "Listed." });
      await app.turn(s, "do something");
      const all = JSON.stringify(app.seen.map((r: any) => r.messages));
      assert.doesNotMatch(all, /group is not available/);
      assert.ok(offered(app.seen[app.seen.length - 1]).includes("notebook"), "in the list afterwards");
    });

    await test("an unknown set is refused, naming the ones that exist", async () => {
      const s = await app.newSession("bad", "build");
      app.script.push({ tools: [{ name: "tools_enable", args: { family: "nope" } }] });
      app.script.push({ text: "Ok." });
      await app.turn(s, "do something");
      const all = JSON.stringify(app.seen.map((r: any) => r.messages));
      assert.match(all, /sets are: pdf, video, studio, office, cad, game, photo, widgets, mcp, schedule, notebooks/);
    });
  } finally {
    await app.stop();
  }
  console.log(`${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
