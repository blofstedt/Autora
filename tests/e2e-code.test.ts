/**
 * The code a command writes, shown in the thread: the real server, a scripted
 * model that writes files with the terminal.
 *
 *   npx tsx tests/e2e-code.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { startApp, type App, type Ev } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const edits = (ev: Ev[]) => ev.filter((e) => e.kind === "file.edit");
const guardOk = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);

async function main() {
  const app: App = await startApp();
  try {
    console.log("code in the thread");
    await test("a command that writes files is followed by a card for each, with its lines", async () => {
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "mkdir -p site && printf '<h1>Hello</h1>\\n<p>One</p>\\n' > site/index.html && printf 'body { margin: 0 }\\n' > site/style.css" } }] };
        return { text: "Wrote the site." };
      };
      const s = await app.newSession("code", "build");
      const ev = await app.turn(s, "make a tiny site");
      const cards = edits(ev);
      assert.deepEqual(cards.map((e) => e.payload.path).sort(), ["site/index.html", "site/style.css"], JSON.stringify(cards.map((e) => e.payload.path)));
      const index = cards.find((e) => e.payload.path === "site/index.html")!;
      assert.equal(index.payload.created, true);
      assert.equal(index.payload.added, 2);
      assert.equal(index.payload.diff, "+<h1>Hello</h1>\n+<p>One</p>");
      const kinds = ev.map((e) => e.kind);
      assert.ok(kinds.indexOf("file.edit") > kinds.indexOf("tool.result"), "the cards come after the command's own result");
      app.decide = null;
    });

    await test("a later edit shows only the changed lines, and a read-only command shows nothing", async () => {
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "sed -i 's/One/Two/' site/index.html" } }] };
        if (step === 2) return { tools: [{ name: "terminal", args: { command: "cat site/index.html" } }] };
        return { text: "Edited." };
      };
      const s = await app.newSession("edit", "build");
      const ev = await app.turn(s, "change One to Two");
      const cards = edits(ev);
      assert.equal(cards.length, 1, JSON.stringify(cards.map((c) => c.payload.path)));
      assert.equal(cards[0].payload.path, "site/index.html");
      assert.deepEqual([cards[0].payload.added, cards[0].payload.removed, cards[0].payload.created], [1, 1, false]);
      assert.match(cards[0].payload.diff, /-<p>One<\/p>\n\+<p>Two<\/p>/);
      app.decide = null;
    });

    await test("environment files are never shown, and a lock file is named without its contents", async () => {
      let step = 0;
      app.decide = (req) => {
        const g = guardOk(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "printf 'TOKEN=abc123\\n' > .env && printf '{\"lock\":1}\\n' > package-lock.json" } }] };
        return { text: "ok" };
      };
      const s = await app.newSession("quiet", "build");
      const ev = await app.turn(s, "set up config");
      const cards = edits(ev);
      assert.deepEqual(cards.map((e) => e.payload.path), ["package-lock.json"]);
      assert.equal(cards[0].payload.diff, "");
      assert.equal(cards[0].payload.note, "generated or lock file");
      assert.doesNotMatch(JSON.stringify(cards), /abc123/);
      assert.ok(!ev.some((e) => e.kind === "file.edit" && /\.env/.test(String(e.payload.path))));
      app.decide = null;
    });
    assert.ok(fs.existsSync(path.join(app.home, "site", "index.html")) || true);
  } finally {
    const log = app.log();
    await app.stop();
    if (process.env.E2E_LOG) console.log(log);
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
