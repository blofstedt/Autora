/**
 * The whole app in a real browser, at desktop and phone width: every page
 * opens with no console error, no failed request and no sideways scroll, with a
 * thread that has a reply, a plan and a widget in it. The cheapest way to
 * catch a page that throws, or a layout that spills off a phone.
 *
 *   npx tsx tests/ui-smoke.test.ts
 */
import fs from "node:fs";
import { chromium } from "playwright-core";
import { startApp } from "./e2e-harness";
const app = await startApp();
const problems: string[] = [];
try {
  // some content to show
  app.decide = (req) => {
    const n = req.messages.filter((m) => m.role === "tool").length;
    if (/^make a plan/.test(req.last) && n === 0) return { tools: [{ name: "todo", args: { todos: [{ title: "Read the inbox", status: "in-progress" }, "Book flights"] } }] };
    if (/^show a widget/.test(req.last) && n === 0) return { tools: [{ name: "widget_show", args: { title: "Orbit", html: "<div>hi</div>", height: 200 } }] };
    return { text: "Here is a reply with **bold** and a list:\n\n- one\n- two\n\n```js\nconsole.log(1)\n```" };
  };
  const s = await app.newSession("UI check");
  await app.turn(s, "say something");
  await app.turn(s, "make a plan");
  await app.turn(s, "show a widget");
  const exe = process.env.AUTORA_BROWSER_PATH || "/opt/pw-browsers/chromium-1194/chrome-linux/chrome";
  if (!fs.existsSync(exe)) { console.log("  skip  no browser here"); await app.stop(); process.exit(0); }
  const browser = await chromium.launch({ executablePath: exe });
  for (const [label, vp, mobile] of [["desktop", { width: 1280, height: 800 }, false], ["phone", { width: 390, height: 780 }, true]] as const) {
    const ctx = await browser.newContext({ viewport: vp, isMobile: mobile, hasTouch: mobile, deviceScaleFactor: mobile ? 2 : 1 });
    const page = await ctx.newPage();
    page.on("console", (m) => { if (m.type() === "error") problems.push(`[${label}] console error: ${m.text().slice(0, 200)}`); });
    page.on("pageerror", (e) => problems.push(`[${label}] uncaught: ${e.message.slice(0, 200)}`));
    page.on("requestfailed", (r) => { if (!/favicon|ws\//.test(r.url())) problems.push(`[${label}] request failed: ${r.url().slice(0, 100)} ${r.failure()?.errorText}`); });
    page.on("response", (r) => { if (r.status() >= 400 && !/favicon/.test(r.url())) problems.push(`[${label}] ${r.status()} ${r.url().slice(0, 100)}`); });
    for (const id of ["chat", "sessions", "artifacts", "analytics", "cron", "triggers", "mind", "mcp", "system", "config"]) {
      await page.goto(`${app.base}/?page=${id}${id === "chat" ? `&session=${s}` : ""}`);
      await page.waitForTimeout(id === "chat" ? 1800 : 900);
      const over = await page.evaluate(() => {
        const w = document.documentElement.clientWidth;
        const bad: string[] = [];
        for (const el of Array.from(document.querySelectorAll("body *")).slice(0, 4000) as HTMLElement[]) {
          const r = el.getBoundingClientRect();
          if (r.width > 0 && r.right > w + 2 && getComputedStyle(el).position !== "fixed" && !el.closest("[style*='overflow']") ) {
            const anc = el.closest(".thread, .shot-log, pre, .term-body, .diff-code, table, .stage-bar, .rail-scroll");
            if (!anc) bad.push(`${el.tagName.toLowerCase()}.${String(el.className).slice(0, 30)} right=${Math.round(r.right)}`);
          }
        }
        return { scrollW: document.documentElement.scrollWidth, w, bad: bad.slice(0, 4) };
      });
      if (over.scrollW > over.w + 2) problems.push(`[${label}] page ${id}: horizontal scroll (${over.scrollW} > ${over.w}) ${over.bad.join(" | ")}`);
        }
    await ctx.close();
  }
  await browser.close();
} finally { await app.stop(); }
if (problems.length) {
  console.error(`  FAIL ${problems.length} problem(s):\n${problems.map((p) => "    " + p).join("\n")}`);
  process.exit(1);
}
console.log("  ok  every page opens clean at desktop and phone width");
process.exit(0);
