/**
 * code_search through the real server: the model asks, the answer is places in
 * the code, and Plan mode lets it through because it only looks.
 *
 *   npx tsx tests/e2e-search.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp, type App } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const app: App = await startApp();
  try {
    const proj = path.join(app.home, "proj");
    fs.mkdirSync(path.join(proj, "src"), { recursive: true });
    fs.writeFileSync(path.join(proj, "src", "orders.ts"), "export function cancelOrderById(id: string) {\n  return db.delete('orders', id);\n}\n");
    fs.writeFileSync(path.join(proj, "src", "other.ts"), "export const unrelated = 1;\n");

    console.log("searching code");
    for (const mode of ["build", "plan"]) {
      await test(`the model finds a function by the words in its name (${mode} mode)`, async () => {
        app.seen.length = 0;
        app.decide = (req) => {
          if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
          if (req.messages.some((m) => m.role === "tool")) return { text: "Found it." };
          return { tools: [{ name: "code_search", args: { query: "cancel order", path: proj } }] };
        };
        const s = await app.newSession(`search ${mode}`, mode);
        const ev = await app.turn(s, "where do orders get cancelled?");
        assert.ok(ev.some((e) => e.kind === "tool.call" && e.payload.name === "code_search"));
        assert.ok(!ev.some((e) => e.kind === "tool.error"), JSON.stringify(ev.filter((e) => e.kind === "tool.error").map((e) => e.payload)));
        const told = JSON.stringify(app.seen.at(-1)!.messages.filter((m) => m.role === "tool"));
        assert.match(told, /src\/orders\.ts:1-3/);
        assert.match(told, /cancelOrderById/);
        assert.doesNotMatch(told, /other\.ts/);
        app.decide = null;
      });
    }

    await test("a call with no query is refused before it runs, naming the argument", async () => {
      app.seen.length = 0;
      app.decide = (req) => {
        if (/You check one action/.test(req.system)) return { text: '{"destructive": false, "requested": true}' };
        if (req.messages.some((m) => m.role === "tool")) return { text: "Oops." };
        return { tools: [{ name: "code_search", args: { mode: "exact" } }] };
      };
      const s = await app.newSession("noquery", "build");
      await app.turn(s, "search");
      const told = JSON.stringify(app.seen.at(-1)!.messages.filter((m) => m.role === "tool"));
      assert.match(told, /missing required \\"query\\"/);
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
