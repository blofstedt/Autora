/**
 * The agent testing what it built, through the app window the person is
 * watching: it types, clicks, presses keys and scrolls with real input, is
 * told what it did and what the page then shows, and is refused while planning.
 *
 *   npx tsx tests/e2e-appuse.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const SITE = `<!doctype html><html><head><meta charset="utf-8"><title>Hello</title><style>
body{margin:0;font:16px system-ui} .row{padding:20px} #tall{height:2400px;background:linear-gradient(#fff,#ddd)}
</style></head><body>
<div class="row"><input id="name" placeholder="Your name"> <button id="go" onclick="console.error('greeted ' + document.getElementById('name').value)">Say hello</button></div>
<div class="row"><form onsubmit="event.preventDefault();console.error('submitted ' + this.q.value)"><input name="q" placeholder="Search"></form></div>
<div class="row"><a id="more" href="#">Read more</a></div>
<div id="tall"></div>
<script>window.addEventListener("scroll",()=>{ if (scrollY>300) console.error("scrolled to " + Math.round(scrollY)) });
document.addEventListener("keydown",(e)=>{ if (e.key==="Escape") console.error("escape pressed") });</script>
</body></html>`;

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  const app = await startApp();
  try {
    fs.mkdirSync(`${app.home}/site`, { recursive: true });
    fs.writeFileSync(`${app.home}/site/index.html`, SITE);
    const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);
    const told = () => app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n");

    const s = await app.newSession("Use", "build");
    app.decide = (req) => guard(req) ?? (req.messages.some((m) => m.role === "tool") ? { text: "Open." } : { tools: [{ name: "app_preview", args: { action: "start", dir: "site" } }] });
    await app.turn(s, "show it", 60_000);

    const steps = async (calls: Record<string, unknown>[]) => {
      app.seen.length = 0;
      let n = 0;
      app.decide = (req) => {
        const g = guard(req);
        if (g) return g;
        return n < calls.length ? { tools: [{ name: "app_preview", args: calls[n++] }] } : { text: "Tested." };
      };
      return app.turn(s, "test it", 90_000);
    };

    console.log("using the app");
    await test("it types into a field by its placeholder and clicks a button by its words; the page did what a person would see", async () => {
      await steps([
        { action: "type", target: "Your name", text: "Ada" },
        { action: "click", target: "Say hello" },
      ]);
      const said = told();
      assert.match(said, /Typed \\"Ada\\" into input \\"Your name\\"/);
      assert.match(said, /Clicked button \\"Say hello\\"/);
      assert.match(said, /greeted Ada/, "the page's own handler ran with what was typed");
    });

    await test("submit presses Enter, a key can be pressed, and the page scrolls", async () => {
      await steps([
        { action: "type", target: "Search", text: "bikes", submit: true },
        { action: "press", key: "Escape" },
        { action: "scroll", dy: 900 },
      ]);
      const said = told();
      assert.match(said, /pressed Enter/);
      assert.match(said, /submitted bikes/);
      assert.match(said, /escape pressed/);
      assert.match(said, /Scrolled down 900 pixels/);
      assert.match(said, /scrolled to \d{3}/);
    });

    await test("a target that is not there says what is, so the agent can choose", async () => {
      await steps([{ action: "click", target: "Checkout" }]);
      const said = told();
      assert.match(said, /Nothing on the page matches \\"Checkout\\"/);
      assert.match(said, /Say hello/);
      assert.match(said, /Read more/);
    });

    await test("a selector works too, and a missing target or key is refused before anything moves", async () => {
      await steps([{ action: "click", target: "#go" }, { action: "click" }, { action: "press" }, { action: "type", text: "" }]);
      const said = told();
      assert.match(said, /Clicked button/);
      assert.match(said, /click needs a target/);
      assert.match(said, /press needs a key/);
      assert.match(said, /type needs text/);
    });

    await test("while planning, using the app is refused", async () => {
      const p = await app.newSession("Plan", "plan");
      app.seen.length = 0;
      let n = 0;
      app.decide = (req) => {
        const g = guard(req);
        if (g) return g;
        n += 1;
        if (n === 1) return { tools: [{ name: "app_preview", args: { action: "click", target: "Say hello" } }] };
        return { text: "Planned." };
      };
      await app.turn(p, "click it", 60_000);
      assert.match(told(), /Plan mode/);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
