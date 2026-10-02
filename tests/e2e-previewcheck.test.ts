/**
 * The agent says it is finished, and the app window's console says otherwise.
 *
 *   npx tsx tests/e2e-previewcheck.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const GOOD = `<!doctype html><html><head><meta charset="utf-8"><title>Site</title></head><body><h1>Hello</h1></body></html>`;
const BROKEN = GOOD.replace("</body>", `<script>throw new Error("boom in the app")</script></body>`);

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  const app = await startApp();
  try {
    fs.mkdirSync(`${app.home}/site`, { recursive: true });
    fs.writeFileSync(`${app.home}/site/index.html`, GOOD);
    fs.writeFileSync(`${app.home}/site/broken.html`, BROKEN);
    const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);

    const s = await app.newSession("check", "build");
    app.decide = (req) => guard(req) ?? (req.messages.some((m) => m.role === "tool") ? { text: "Open." } : { tools: [{ name: "app_preview", args: { action: "start", dir: "site" } }] });
    await app.turn(s, "show it", 60_000);

    console.log("looking at the app after a change");
    await test("a change that breaks the page sends the agent back, and a fix ends it", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guard(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: "cp site/broken.html site/index.html" } }] };
        if (step === 2) return { text: "Done, the page is updated." };
        if (step === 3) return { tools: [{ name: "terminal", args: { command: `cat > site/index.html <<'EOF'\n${GOOD}\nEOF` } }] };
        return { text: "Fixed." };
      };
      const ev = await app.turn(s, "update the page", 90_000);
      const all = app.seen.map((r) => JSON.stringify(r.messages)).join("\n");
      assert.match(all, /looked at the app window after your changes/);
      assert.match(all, /boom in the app/);
      assert.ok(step >= 4, `the agent was sent back (${step} model calls)`);
      assert.ok(ev.some((e) => e.kind === "system.log" && /app window reports 1 error/.test(String(e.payload.message))));
    });

    await test("a change that leaves the page clean is not sent back", async () => {
      app.seen.length = 0;
      let step = 0;
      app.decide = (req) => {
        const g = guard(req);
        if (g) return g;
        step += 1;
        if (step === 1) return { tools: [{ name: "terminal", args: { command: `cat > site/index.html <<'EOF'\n${GOOD.replace("Hello", "Hi")}\nEOF` } }] };
        return { text: "Done." };
      };
      const ev = await app.turn(s, "say hi instead", 90_000);
      assert.equal(step, 2);
      assert.ok(ev.some((e) => e.kind === "system.log" && /console is clean/.test(String(e.payload.message))));
      assert.doesNotMatch(app.seen.map((r) => JSON.stringify(r.messages)).join("\n"), /looked at the app window after your changes/);
    });
  } finally {
    await app.stop();
  }
  console.log(`${passed} passed`);
}
main().catch((e) => { console.error(e); process.exit(1); });
