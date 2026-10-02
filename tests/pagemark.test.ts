/**
 * The cursor and the outline are drawn into the page itself, so they are in the
 * frames the person watches: a real browser, a real page, and the pixels.
 *
 *   npx tsx tests/pagemark.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import { chromium } from "playwright-core";
import { LiveBrowser, probeBrowser } from "../server/browser";
import { diffDom } from "../server/domdiff";

let passed = 0;
async function test(name: string, fn: () => Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const exe = process.env.AUTORA_BROWSER_PATH
  || ["/opt/pw-browsers/chromium-1194/chrome-linux/chrome", "/usr/bin/chromium-browser", "/usr/bin/chromium"].find((p) => fs.existsSync(p));
if (exe) process.env.AUTORA_BROWSER_PATH = exe;
const probe = await probeBrowser();
if (!probe.ok) {
  console.log(`  skip  no browser here (${probe.detail})`);
  process.exit(0);
}

const server = http.createServer((_req, res) => {
  res.setHeader("content-type", "text/html");
  res.end("<!doctype html><body style='margin:0;background:#fff;font:16px system-ui'><h1 style='margin:20px'>Hello</h1><p id=slot style='margin:20px'>Intro</p></body>");
});
await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", () => resolve()));
const url = `http://127.0.0.1:${(server.address() as { port: number }).port}/`;

const live = new LiveBrowser({
  onFrame: () => {}, onKeyframe: () => {}, onNav: () => {}, onAction: () => {}, onFields: () => {}, watchers: () => 0,
}, { viewport: { width: 800, height: 500 } });
const reader = await chromium.launch({ executablePath: exe });
const readerPage = await reader.newPage();

/** Pixels of the violet the mark and cursor are drawn in, by where they are. */
async function violet(png: Buffer, box: { x: number; y: number; w: number; h: number }): Promise<{ inside: number; total: number }> {
  // A string, not a function: the test runner's own helpers must not be shipped into the page.
  return readerPage.evaluate(`(async () => {
    const box = ${JSON.stringify(box)};
    const img = new Image();
    img.src = "data:image/png;base64,${png.toString("base64")}";
    await img.decode();
    const c = document.createElement("canvas");
    c.width = img.width; c.height = img.height;
    const g = c.getContext("2d");
    g.drawImage(img, 0, 0);
    const data = g.getImageData(0, 0, c.width, c.height).data;
    let inside = 0, total = 0;
    for (let y = 0; y < c.height; y++) {
      for (let x = 0; x < c.width; x++) {
        const i = (y * c.width + x) * 4;
        if (!(Math.abs(data[i] - 139) < 40 && Math.abs(data[i + 1] - 124) < 40 && Math.abs(data[i + 2] - 246) < 40)) continue;
        total += 1;
        if (x >= box.x - 14 && x <= box.x + box.w + 14 && y >= box.y - 30 && y <= box.y + box.h + 14) inside += 1;
      }
    }
    return { inside, total };
  })()`) as Promise<{ inside: number; total: number }>;
}

try {
  await live.goto(url);
  console.log("marks drawn into the page");

  await test("a change is found, the outline goes round it, and the pixels are there", async () => {
    const before = (await live.domMap())!;
    assert.ok(before.length >= 2);
    await live.pickOp(`document.body.insertAdjacentHTML("beforeend", '<button id="b" style="margin:20px;padding:12px 30px;font-size:18px">Subscribe</button>'); true`);
    const after = (await live.domMap())!;
    const [cue] = diffDom(before, after, live.viewport());
    assert.ok(cue, "the new button was found");
    assert.equal(cue.label, "New button");
    const untouched = await violet(await live.capture(), cue);
    assert.equal(untouched.total < 20, true, "nothing is drawn before it is asked for");
    await live.markAt(cue.x, cue.y, cue.w, cue.h, cue.label);
    const marked = await violet(await live.capture(), cue);
    assert.ok(marked.inside > 200, `the outline and the cursor are on the button (${marked.inside} violet pixels near it)`);
    assert.ok(marked.inside >= marked.total * 0.9, "and it is not drawn anywhere else");
  });

  await test("the mark goes away on its own", async () => {
    await new Promise((resolve) => setTimeout(resolve, 2300));
    const box = { x: 20, y: 0, w: 10, h: 10 };
    const gone = await violet(await live.capture(), box);
    // The cursor dot stays where it last was; the outline and its name do not.
    assert.ok(gone.total < 700, `only the cursor is left (${gone.total} violet pixels)`);
  });
} finally {
  await live.close().catch(() => undefined);
  await reader.close();
  server.close();
}
console.log(`\n${passed} passed`);
process.exit(0);
