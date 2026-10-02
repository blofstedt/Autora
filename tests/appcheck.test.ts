/**
 * What a developer's tools show about an app, from the preview's own browser:
 * the network log, an accessibility audit, and a before/after screen diff.
 *
 *   npx tsx tests/appcheck.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { LiveBrowser, probeBrowser, redactHeaders, redactUrl } from "../server/browser";
import { a11yReport, hasBaseline, keepBaseline, networkReport, regionsOf, runA11y, runDiff } from "../server/appcheck";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

await test("secrets in headers and addresses are blanked before they are logged", () => {
  assert.deepEqual(redactHeaders({ Authorization: "Bearer abc", "Content-Type": "text/plain", Cookie: "s=1" }), { Authorization: "[redacted]", "Content-Type": "text/plain", Cookie: "[redacted]" });
  assert.equal(redactUrl("https://x.test/a?token=abc&page=2"), "https://x.test/a?token=[redacted]&page=2");
  assert.equal(redactUrl("https://x.test/a?page=2"), "https://x.test/a?page=2");
});

await test("changed cells that touch become one region, biggest first", () => {
  const r = regionsOf([{ x: 0, y: 0, n: 5 }, { x: 1, y: 0, n: 5 }, { x: 1, y: 1, n: 2 }, { x: 9, y: 9, n: 30 }], 40);
  assert.equal(r.length, 2);
  assert.deepEqual(r[0], { x: 360, y: 360, w: 40, h: 40, n: 30 });
  assert.deepEqual(r[1], { x: 0, y: 0, w: 80, h: 80, n: 12 });
});

await test("the reports say plainly when there is nothing wrong", () => {
  assert.match(networkReport([]), /No requests/);
  assert.match(a11yReport([]), /No accessibility problems/);
});

const exe = process.env.AUTORA_BROWSER_PATH
  || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
if (exe) process.env.AUTORA_BROWSER_PATH = exe;
const probe = await probeBrowser();
if (!probe.ok) {
  console.log(`  skip  no browser here (${probe.detail})`);
  console.log(`\n${passed} appcheck cases passed.`);
  process.exit(0);
}

let version = 1;
const server = http.createServer((req, res) => {
  if (req.url?.startsWith("/api/items")) { res.setHeader("content-type", "application/json"); res.end(JSON.stringify({ items: [1, 2, 3] })); return; }
  if (req.url?.startsWith("/api/missing")) { res.statusCode = 404; res.end("nope"); return; }
  res.setHeader("content-type", "text/html");
  res.end(version === 1
    ? `<!doctype html><html><head><title>Shop</title></head><body style="margin:0;font:16px sans-serif">
        <h1>Shop</h1><h3>Skipped heading</h3>
        <img src="data:image/gif;base64,R0lGODlhAQABAAAAACw=" width=50 height=50>
        <input id="q" type="text" placeholder="Search"><button id="go"></button>
        <p style="color:#bbb;background:#fff">Pale text on white</p>
        <a href="#x" style="display:inline-block;width:10px;height:10px">.</a>
        <script>fetch("/api/items?token=secret123"); fetch("/api/missing");</script></body></html>`
    : `<!doctype html><html lang="en"><head><title>Shop</title><meta name="viewport" content="width=device-width"></head><body style="margin:0;font:16px sans-serif">
        <h1>Shop</h1><h2>Fixed heading</h2>
        <label>Search <input type="text"></label><button aria-label="Go">Go</button>
        <div style="margin:20px;width:300px;height:120px;background:#2563eb;color:#fff">A new banner</div></body></html>`);
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;
const live = new LiveBrowser({ onFrame: () => {}, onKeyframe: () => {}, onNav: () => {}, onAction: () => {}, onFields: () => {}, watchers: () => 0 }, { viewport: { width: 800, height: 500 } });

try {
  await live.goto(url);
  await new Promise((r) => setTimeout(r, 400));

  await test("the network log shows each request, its status, and what failed", async () => {
    const rows = live.networkLog();
    assert.ok(rows.length >= 3, `rows ${rows.length}`);
    const items = rows.find((r) => r.url.includes("/api/items"))!;
    assert.equal(items.status, 200);
    assert.equal(items.type, "fetch");
    assert.match(items.url, /token=\[redacted\]/, "the secret in the address is not logged");
    assert.equal(live.networkLog({ failed: true }).length, 1);
    assert.equal(live.networkLog({ url: "api", type: "fetch" }).length, 2);
    const report = networkReport(live.networkLog());
    assert.match(report, /Failed \(1\)/);
    assert.match(report, /API calls \(2\)/);
  });

  await test("a response body can be read back, JSON laid out", async () => {
    const id = live.networkLog({ url: "/api/items" })[0].id;
    const body = await live.networkBody(id);
    assert.equal(body.ok, true);
    assert.match(body.text, /"items": \[/);
    assert.equal((await live.networkBody(99999)).ok, false);
  });

  await test("the accessibility audit finds what is wrong in the page's structure", async () => {
    const report = await runA11y(live);
    for (const rule of ["html-lang", "viewport", "img-alt", "form-label", "control-name", "heading-order", "contrast", "tap-target"]) {
      assert.match(report, new RegExp(`${rule} \\(`), `${rule} missing from:\n${report}`);
    }
  });

  await test("a clean page passes, and a baseline shows what changed after an edit", async () => {
    const before = await live.capture();
    keepBaseline("s", before, url);
    assert.equal(hasBaseline("s"), true);
    version = 2;
    await live.goto(url);
    const fixed = await runA11y(live);
    assert.doesNotMatch(fixed, /form-label|control-name|img-alt|html-lang|heading-order/);
    const same = await runDiff(live, "none", before);
    assert.match(same.summary, /no baseline/);
    const diff = await runDiff(live, "s", await live.capture());
    assert.match(diff.summary, /% of the picture changed/);
    assert.ok(diff.marked && diff.marked.subarray(1, 4).toString() === "PNG");
    keepBaseline("t", await live.capture(), url);
    assert.match((await runDiff(live, "t", await live.capture())).summary, /No visible difference/);
  });
} finally {
  await live.close();
  server.close();
}
console.log(`\n${passed} appcheck cases passed.`);
process.exit(0);
