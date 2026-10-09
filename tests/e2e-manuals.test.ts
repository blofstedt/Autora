/**
 * A window's manual comes with the result of the first tool call into it, once per chat -- not every turn.
 *
 *   npx tsx tests/e2e-manuals.test.ts
 */
import assert from "node:assert/strict";
import { startApp, type App } from "./e2e-harness";

const toolResults = (req: any): string[] => (req.messages ?? []).filter((m: any) => m.role === "tool").map((m: any) => (typeof m.content === "string" ? m.content : JSON.stringify(m.content)));

async function main() {
  const app: App = await startApp();
  try {
    const s = await app.newSession("manuals", "build");
    app.seen.length = 0;
    // The first call into the PDF window (a file that is not there: the manual still comes with the answer).
    app.script.push({ tools: [{ name: "pdf_read", args: { file: "nothing-here.pdf" } }] });
    app.script.push({ tools: [{ name: "pdf_read", args: { file: "nothing-here.pdf" } }] });
    app.script.push({ text: "Done." });
    await app.turn(s, "read nothing-here.pdf");
    const all = app.seen.map((r: any) => r);
    const last = toolResults(all[all.length - 1]);
    const withManual = last.filter((t) => t.includes("Autora PDF (tools pdf_read"));
    assert.equal(withManual.length, 1, `the manual is in one result, not ${withManual.length}`);
    assert.ok(!/Autora PDF \(tools pdf_read/.test(all[0].system), "and not in the briefing");
    // A later turn in the same chat does not get it again.
    app.seen.length = 0;
    app.script.push({ tools: [{ name: "pdf_read", args: { file: "nothing-here.pdf" } }] });
    app.script.push({ text: "Done." });
    await app.turn(s, "again");
    const again = toolResults(app.seen[app.seen.length - 1]);
    assert.equal(again.filter((t) => t.includes("Autora PDF (tools pdf_read")).length, 0, "no second copy of the manual");
    console.log("  ok  the manual rides on the first call into a window, once");
  } finally {
    await app.stop();
  }
}
main().catch((e) => { console.error(e); process.exit(1); });
