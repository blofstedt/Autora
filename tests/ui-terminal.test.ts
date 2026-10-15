/**
 * The Terminal window with the agent at work, in a real browser. With Visible work on, the agent's command is typed at
 * the window's own prompt, a key at a time, and runs in that shell (its output and exit code read back from it); with
 * it off, it runs on its own at speed.
 *
 *   npx tsx tests/ui-terminal.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { chromium } from "playwright-core";
import { sleep, startApp } from "./e2e-harness";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

async function main() {
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); return; }
  const shots = process.env.TERM_SHOTS || "";
  const app = await startApp();
  const browser = await chromium.launch({ executablePath: exe });
  const page = await browser.newPage({ viewport: { width: 1360, height: 820 } });
  try {
    const s = await app.newSession("Shell", "build");
    await page.goto(`${app.base}/?session=${s}`);
    assert.equal((await app.api("POST", `/api/term/${s}/open`)).status, 200);
    await page.waitForSelector(".tm-window .xterm-rows");
    const screen = () => page.locator(".tm-window .xterm-rows").innerText();
    const until = async (what: string, ok: () => Promise<boolean>, ms = 15_000) => {
      const end = Date.now() + ms;
      while (Date.now() < end) { if (await ok()) return; await sleep(150); }
      throw new Error(`timed out: ${what}: ${JSON.stringify((await screen()).slice(-400))}`);
    };
    await until("the prompt", async () => /[#$]\s*$/m.test(await screen()));
    const told = () => JSON.stringify(app.seen.flatMap((r) => r.messages).filter((m: { role: string }) => m.role === "tool").slice(-1));

    await test("with Visible work on, the command is typed at the window's own prompt and runs in that shell", async () => {
      app.script.push({ tools: [{ name: "terminal", args: { command: "export SEEN=by-hand; echo made-$((6*7))" } }] });
      app.script.push({ text: "Done." });
      let midway = false;
      let on = true;
      void (async () => {
        while (on) {
          const t = await screen().catch(() => "");
          if (/# export SEEN=by-h?a?n?$|# export SEE?N?$/m.test(t) || (/# export/.test(t) && !/made-42/.test(t))) midway = true;
          await sleep(40);
        }
      })();
      await app.turn(s, "run it", 60_000);
      on = false;
      assert.match(told(), /Typed into the shell in the Terminal window/, told());
      assert.match(told(), /Exit code 0/);
      assert.match(told(), /made-42/);
      assert.ok(midway, "the command was on the screen part typed, before it ran");
      const t = await screen();
      assert.match(t, /[#$] export SEEN=by-hand; echo made-\$\(\(6\*7\)\)/, "typed at the prompt");
      assert.doesNotMatch(t, /\[Autora\] \$/, "not printed beside the shell");
      if (shots) await page.screenshot({ path: `${shots}/term-hand.png` });
      // It ran in the person's shell: what it set is there for them.
      await page.locator(".tm-screen").click();
      await page.keyboard.type("echo $SEEN\n");
      await until("the person sees what the agent set", async () => /^by-hand$/m.test(await screen()));
    });

    await test("with Visible work off, it runs on its own at speed and is shown beside the shell", async () => {
      await app.api("PATCH", "/api/agent-cursor", { on: false });
      app.script.push({ tools: [{ name: "terminal", args: { command: "echo quick-run" } }] });
      app.script.push({ text: "Done." });
      await app.turn(s, "run it fast", 60_000);
      assert.doesNotMatch(told(), /Typed into the shell/);
      assert.match(told(), /quick-run/);
      await app.api("PATCH", "/api/agent-cursor", { on: true });
    });
  } finally {
    await browser.close();
    await app.stop();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => { console.error(err); process.exit(1); });
