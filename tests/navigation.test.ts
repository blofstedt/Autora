/**
 * Getting around a real site: the ways a page makes an agent look foolish.
 *
 * A cookie bar or pop-up drawn over an element that is still listed as
 * clickable; a page that draws itself with script and reads as empty; a
 * result that arrives a beat after the click; a click that did nothing and
 * said nothing. Each is a fixture served to a real Chromium, and the
 * assertions are what the agent would be told. Skipped where there is no
 * browser.
 *
 *   npx tsx tests/navigation.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-navigation-"));

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const PAGES: Record<string, string> = {
  banner: `<body style="margin:0"><h1>Shop</h1>
    <button style="position:absolute;bottom:40px;left:30px" onclick="document.title='BOUGHT'">Buy now</button>
    <div style="position:fixed;left:0;right:0;bottom:0;height:120px;background:#222;color:#fff;padding:12px;z-index:99">
      We use cookies.
      <button onclick="this.parentNode.remove()">Accept all</button><button>Reject</button></div></body>`,
  overlay: `<body><h1>Article</h1><a href="#x" onclick="document.title='CLICKED'">Read more</a>
    <div style="position:fixed;inset:0;background:rgba(0,0,0,.6);z-index:50"><div style="background:#fff;margin:80px auto;width:300px;padding:20px">
      Subscribe to our newsletter!
      <button onclick="this.closest('div').parentNode.remove()">No thanks</button></div></div></body>`,
  spa: `<body><div id=app>Loading...</div><script>setTimeout(function(){
    document.getElementById('app').innerHTML='<h1>Dashboard</h1><button>Start report</button>'},1600)</script></body>`,
  delayed: `<body><button onclick="setTimeout(function(){document.getElementById('out').innerHTML='<a href=#r>Result one</a>'},1200)">Search</button><div id=out></div></body>`,
  noop: `<body><button>Do nothing</button></body>`,
  sticky: `<body style="margin:0"><header style="position:sticky;top:0;height:90px;background:#123;color:#fff;z-index:10">Site header</header>
    <div style="height:1500px">long</div><a href="#" onclick="document.title='HIT'">Target link</a><div style="height:1500px"></div></body>`,
};

async function main() {
  const { LiveBrowser, probeBrowser, outlineOf } = await import("../server/browser");
  const executable = process.env.AUTORA_BROWSER_PATH
    || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"]
      .find((p) => fs.existsSync(p));
  if (executable) process.env.AUTORA_BROWSER_PATH = executable;

  console.log("the outline");
  await test("a covered element is marked, and the way to close its cover is named", () => {
    const refs = [
      { ref: 0, role: "link", name: "Read more", value: null, x: 1, y: 1, w: 9, h: 9, href: null,
        checked: null, disabled: false, inView: true, covered: "Newsletter", coverRefs: [1] },
      { ref: 1, role: "button", name: "No thanks", value: null, x: 1, y: 1, w: 9, h: 9, href: null,
        checked: null, disabled: false, inView: true },
    ];
    const out = outlineOf(refs as never);
    assert.match(out, /1 element is covered by "Newsletter".*Dismiss it first with \[1\] "No thanks"/);
    assert.match(out, /\[0\] link "Read more" COVERED by "Newsletter"/);
  });

  const probe = await probeBrowser();
  if (!probe.ok) {
    console.log(`  skip  no browser here (${probe.detail})`);
    console.log(`\n${passed} passed`);
    return;
  }

  const server = http.createServer((req, res) => {
    res.setHeader("content-type", "text/html; charset=utf-8");
    res.end(PAGES[(req.url ?? "").slice(1)] ?? "not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  const live = new LiveBrowser({
    onFrame: () => {}, onKeyframe: () => {}, onNav: () => {}, onAction: () => {},
    onFields: () => {}, watchers: () => 0,
  });
  const refOf = (page: { outline: string }, pattern: RegExp) => {
    const line = page.outline.split("\n").find((l) => /^\[\d+\]/.test(l) && pattern.test(l));
    assert.ok(line, `no element matching ${pattern} in:\n${page.outline}`);
    return Number(/^\[(\d+)\]/.exec(line!)![1]);
  };

  try {
    console.log("a cookie bar");
    await test("a button under it is marked covered, with the bar's own buttons to close it", async () => {
      const page = await live.goto(`${origin}/banner`);
      assert.match(page.outline, /\[\d+\] button "Buy now" COVERED by "We use cookies/);
      assert.match(page.outline, /Dismiss it first with \[\d+\] "Accept all" or \[\d+\] "Reject"/);
    });
    await test("clicking it is held back and says why, instead of clicking the bar", async () => {
      let page = await live.goto(`${origin}/banner`);
      page = await live.click(refOf(page, /button "Buy now"/));
      assert.match(page.notes?.[0] ?? "", /^NOT CLICKED: .*covered by "We use cookies/);
      assert.notEqual(page.title, "BOUGHT");
    });
    await test("asking for the same click again means it", async () => {
      let page = await live.goto(`${origin}/banner`);
      const buy = refOf(page, /button "Buy now"/);
      page = await live.click(buy);
      assert.match(page.notes?.[0] ?? "", /^NOT CLICKED/);
      page = await live.click(buy);
      assert.doesNotMatch(page.notes?.[0] ?? "", /^NOT CLICKED/);
    });
    await test("closing the bar frees the button, and the click lands", async () => {
      let page = await live.goto(`${origin}/banner`);
      page = await live.click(refOf(page, /button "Accept all"/));
      page = await live.click(refOf(page, /button "Buy now"/));
      assert.equal(page.title, "BOUGHT");
    });

    console.log("a pop-up");
    await test("a link behind a newsletter pop-up is held back too", async () => {
      let page = await live.goto(`${origin}/overlay`);
      assert.match(page.outline, /link "Read more" COVERED by "Subscribe to our newsletter/);
      page = await live.click(refOf(page, /link "Read more"/));
      assert.match(page.notes?.[0] ?? "", /^NOT CLICKED/);
      assert.notEqual(page.title, "CLICKED");
    });

    console.log("a header that sticks");
    await test("a link the sticky header would hide is centred, and clicked", async () => {
      let page = await live.goto(`${origin}/sticky`);
      page = await live.scroll({ text: "Target link" } as never);
      page = await live.click(refOf(page, /link "Target link"/));
      assert.equal(page.title, "HIT");
    });

    console.log("a page that is slow");
    await test("a page that draws itself with script is read once it has", async () => {
      const page = await live.goto(`${origin}/spa`);
      assert.match(page.outline, /button "Start report"/);
      assert.doesNotMatch(page.text, /^Loading/);
    });
    await test("a result that arrives after the click is in the page the click returns", async () => {
      let page = await live.goto(`${origin}/delayed`);
      page = await live.click(refOf(page, /button "Search"/));
      assert.match(page.outline, /link "Result one"/);
      assert.equal(page.notes?.length ?? 0, 0);
    });
    await test("a click that changed nothing says so", async () => {
      let page = await live.goto(`${origin}/noop`);
      page = await live.click(refOf(page, /button "Do nothing"/));
      assert.match(page.notes?.[0] ?? "", /Nothing on the page changed/);
    });
  } finally {
    await live.close();
    server.close();
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
