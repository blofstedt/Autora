/**
 * Every tool is a default tool: a plain chat is shown the specialist sets too, and is not told to load anything.
 * (AUTORA_LAZY_TOOLS=1 is the short list that grows as it is wanted: tests/e2e-toolload.test.ts.)
 *
 *   npx tsx tests/e2e-alltools.test.ts
 */
import assert from "node:assert/strict";
import { startApp, type App } from "./e2e-harness";

const offered = (r: any): string[] => r.tools ?? [];

async function main() {
  const app: App = await startApp();
  try {
    const s = await app.newSession("everything", "build");
    app.script.push({ text: "Hi." });
    await app.turn(s, "hello there");
    const req = app.seen[app.seen.length - 1] as any;
    const names = offered(req);
    for (const n of ["terminal", "pdf_edit", "pdf_read", "widget_show", "mcp_offer", "schedule"]) assert.ok(names.includes(n), `${n} should be offered`);
    assert.ok(!/Load one with tools_enable/.test(req.system + JSON.stringify(req.messages)), "nothing is left to load");
    console.log("  ok  every tool is a default tool");
  } finally {
    await app.stop();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
