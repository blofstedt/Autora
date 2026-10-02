/**
 * Working side by side, end to end: what the person does in the app window is
 * told to the agent, what they hold is not touched, and the agent goes on to
 * other work instead of stopping. The real server, a real browser, a scripted
 * model.
 *
 *   npx tsx tests/e2e-collab.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const SITE = `<!doctype html><html><head><meta charset="utf-8"><title>Shop</title><style>
body{margin:0;font:16px system-ui} button{position:absolute;left:100px;top:100px;padding:14px 26px;font-size:18px}
input{position:absolute;left:100px;top:200px;width:240px;padding:8px}
</style></head><body><button id="b" onclick="console.error('person clicked buy')">Buy now</button>
<input placeholder="Your name"></body></html>`;

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  const app = await startApp();
  try {
    fs.mkdirSync(`${app.home}/site`, { recursive: true });
    fs.writeFileSync(`${app.home}/site/index.html`, SITE);
    const s = await app.newSession("Collab", "build");
    const guard = (req: { system: string }) => (/You check one action/.test(req.system) ? { text: '{"destructive": false, "requested": true}' } : null);
    const unesc = (t: string) => t.replace(/\\"/g, '"').replace(/\\n/g, "\n");
    const all = () => unesc(app.seen.map((r) => `${r.system}\n${JSON.stringify(r.messages)}`).join("\n"));
    const toolSaid = () => unesc(app.seen.map((r) => JSON.stringify(r.messages.filter((m) => m.role === "tool"))).join("\n"));
    const presence = async () => (await app.api("GET", `/api/sessions/${s}/presence`)).body;
    const person = (path: string, body: unknown) => app.api("POST", `/api/sessions/${s}/browser/${path}?target=preview`, body);

    app.decide = (req) => guard(req) ?? (req.messages.some((m) => m.role === "tool") ? { text: "Open." } : { tools: [{ name: "app_preview", args: { action: "start", dir: "site" } }] });
    await app.turn(s, "show the shop", 60_000);
    await sleep(500);

    const turn = async (calls: Record<string, unknown>[], text = "test it") => {
      app.seen.length = 0;
      let n = 0;
      app.decide = (req) => {
        const g = guard(req);
        if (g) return g;
        return n < calls.length ? { tools: [{ name: calls[n].name as string ?? "app_preview", args: (calls[n++] as any).args }] } : { text: "Carrying on." };
      };
      return app.turn(s, text, 90_000);
    };

    console.log("what the person does");
    await test("a click and typing in the window are told to the agent at its next turn, in words", async () => {
      assert.equal((await person("click", { x: 150, y: 120 })).status, 200);
      assert.equal((await person("type", { text: "Ada" })).status, 200);
      assert.ok((await presence()).active.includes("app"), "the window is in use");
      await turn([]);
      const said = all();
      assert.match(said, /\[The person, working alongside you:/);
      assert.match(said, /clicked the "Buy now" button/, said.slice(said.indexOf("[The person, working"), said.indexOf("[The person, working") + 500));
      assert.match(said, /do not undo it/);
      assert.match(said, /You work alongside the person/);
    });

    console.log("what they hold");
    await test("while they are using the window the agent's click is not done, said plainly, and the turn goes on", async () => {
      await person("click", { x: 150, y: 120 });
      const ev = await turn([{ name: "app_preview", args: { action: "click", target: "Buy now" } }]);
      assert.match(toolSaid(), /working on the app window right now/);
      assert.match(toolSaid(), /do not retry it straight away/);
      const held = ev.filter((e) => e.kind === "tool.error" && e.payload.held);
      assert.equal(held.length, 1);
      assert.match(ev.filter((e) => e.kind === "turn.agent.text").map((e) => e.payload.text).join(""), /Carrying on/, "the agent went on to answer");
      assert.ok(!ev.some((e) => e.kind === "system.log" && /Stopped|going in circles/.test(String(e.payload.message))));
    });

    await test("after a pause the window is the agent's again", async () => {
      await sleep(8600);
      assert.ok(!(await presence()).active.includes("app"));
      await turn([{ name: "app_preview", args: { action: "click", target: "Buy now" } }]);
      assert.match(toolSaid(), /Clicked button "Buy now"/);
      assert.match(toolSaid(), /person clicked buy/);
    });

    await test("taking control holds the window until it is handed back, and the agent is told both ways", async () => {
      const held = await app.api("POST", `/api/sessions/${s}/control`, { surface: "app", hold: true });
      assert.deepEqual(held.body.held, ["app"]);
      await turn([{ name: "app_preview", args: { action: "click", target: "Buy now" } }]);
      assert.match(toolSaid(), /taken control of the app window/);
      assert.match(all(), /They have taken control of the app window/);
      assert.ok(!/Clicked button/.test(toolSaid()), "nothing was clicked");
      await sleep(9000);
      assert.deepEqual((await presence()).held, ["app"], "still theirs after any lease would have run out");
      await app.api("POST", `/api/sessions/${s}/control`, { surface: "app", hold: false });
      await turn([{ name: "app_preview", args: { action: "click", target: "Buy now" } }]);
      assert.match(all(), /handed the app window back/);
      assert.match(toolSaid(), /Clicked button/);
    });

    await test("the agent's own browser and the PDF are held the same way, and looking is never held", async () => {
      await app.api("POST", `/api/sessions/${s}/control`, { surface: "browser", hold: true });
      await app.api("POST", `/api/sessions/${s}/control`, { surface: "pdf", hold: true });
      await turn([
        { name: "browser_open", args: { url: "http://localhost:1/" } },
        { name: "pdf_edit", args: { file: "x.pdf", add: [{ type: "text", text: "hi", page: 1, x: 10, y: 10 }] } },
        { name: "app_preview", args: { action: "look" } },
      ]);
      const said = toolSaid();
      assert.match(said, /taken control of the browser/);
      assert.match(said, /taken control of the PDF/);
      assert.match(said, /The preview at http/, "looking at the app was not held");
      await app.api("POST", `/api/sessions/${s}/control`, { surface: "browser", hold: false });
      await app.api("POST", `/api/sessions/${s}/control`, { surface: "pdf", hold: false });
    });

    await test("a bad surface is refused", async () => {
      assert.equal((await app.api("POST", `/api/sessions/${s}/control`, { surface: "moon", hold: true })).status, 400);
    });
  } finally {
    await app.stop();
  }
  console.log(`\n${passed} passed`);
  process.exit(0);
}
main().catch((err) => { console.error(err); process.exit(1); });
