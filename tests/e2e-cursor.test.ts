/**
 * The cursor in the app window, end to end: the agent changes a page it is
 * previewing, and the window goes to what changed. The real server, a real
 * browser and a scripted model.
 *
 *   npx tsx tests/e2e-cursor.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const SITE = `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title><style>
body{margin:0;font:16px system-ui;background:#fff;color:#111} h1{margin:20px} p{margin:20px}
button{margin:20px;padding:10px 18px}
</style></head><body><h1>Welcome</h1><p>Hand-built bikes.</p>
<!--SLOT--></body></html>`;

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  const app = await startApp();
  try {
    fs.mkdirSync(`${app.home}/site`, { recursive: true });
    fs.writeFileSync(`${app.home}/site/index.html`, SITE);
    const s = await app.newSession("Shop", "build");
    const state = async () => (await app.api("GET", `/api/sessions/${s}/preview`)).body;
    const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);

    app.decide = (req) => guard(req) ?? (req.messages.some((m) => m.role === "tool") ? { text: "Open." } : { tools: [{ name: "app_preview", args: { action: "start", dir: "site" } }] });
    await app.turn(s, "show me the shop", 60_000);
    assert.equal((await state()).open, true);
    assert.equal((await state()).cues.seq, 0);
    await sleep(800);

    const change = async (command: string) => {
      let step = 0;
      app.decide = (req) => {
        const g = guard(req);
        if (g) return g;
        step += 1;
        return step === 1 ? { tools: [{ name: "terminal", args: { command } }] } : { text: "Changed it." };
      };
      await app.turn(s, "change the page", 60_000);
    };
    const waitCues = async (above: number) => {
      for (let i = 0; i < 60; i++) {
        const st = await state();
        if (st.cues.seq > above) return st.cues;
        await sleep(200);
      }
      return null;
    };

    console.log("following a change");
    await test("a new element on the page is where the cursor goes, named, inside the window", async () => {
      await change(`sed -i 's|<!--SLOT-->|<button id="buy">Buy now</button>|' site/index.html`);
      const cues = await waitCues(0);
      assert.ok(cues, "the window went to the change");
      assert.deepEqual(cues.items.map((c: any) => [c.kind, c.label]), [["added", "New button"]]);
      const [c] = cues.items;
      assert.ok(c.x >= 0 && c.x < 1280 && c.y >= 0 && c.y < 800 && c.w > 20 && c.h > 10, JSON.stringify(c));
    });

    await test("with the agent cursor off, the page is remembered but nothing is shown", async () => {
      assert.equal((await app.api("PATCH", "/api/agent-cursor", { on: false })).body.on, false);
      const before = (await state()).cues.seq;
      await change(`sed -i 's|Hand-built bikes.|Hand-built city bikes.|' site/index.html`);
      await sleep(3500);
      assert.equal((await state()).cues.seq, before);
      assert.equal((await app.api("PATCH", "/api/agent-cursor", { on: true })).body.on, true);
    });

    await test("a change after that is compared with the page as it then was, not with the old one", async () => {
      const before = (await state()).cues.seq;
      await change(`sed -i 's|<button id="buy">Buy now</button>|<button id="buy">Buy now</button><p>Free delivery.</p>|' site/index.html`);
      const cues = await waitCues(before);
      assert.ok(cues, "no cue: " + JSON.stringify(await state()) + " file: " + fs.readFileSync(`${app.home}/site/index.html`, "utf8").split("<body>")[1]);
      assert.deepEqual(cues.items.map((c: any) => c.label), ["New text"], "only the new line, not the earlier words");
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
