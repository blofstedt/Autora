/**
 * The browser's own lists: history, bookmarks and downloads kept across
 * restarts, a real download landing as bytes, and find on a page.
 *
 *   npx tsx tests/browsedata.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "autora-browsedata-"));
process.env.AUTORA_HOME = home;

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

async function main() {
  const data = await import("../server/browsedata");
  await test("history keeps web pages once per visit, newest first, and searches", () => {
    data.recordVisit("about:blank", "");
    data.recordVisit("https://a.example/", "A");
    data.recordVisit("https://a.example/", "A page");
    data.recordVisit("https://b.example/x", "B");
    const all = data.history();
    assert.deepEqual(all.map((h) => h.url), ["https://b.example/x", "https://a.example/"]);
    assert.equal(all[1].title, "A page");
    assert.equal(data.history("b.example").length, 1);
    data.clearHistory();
    assert.equal(data.history().length, 0);
  });
  await test("bookmarks are web pages only, once each, and removable", () => {
    assert.equal(data.addBookmark("javascript:alert(1)", "x"), null);
    data.addBookmark("https://a.example/", "A");
    data.addBookmark("https://a.example/", "A again");
    assert.equal(data.bookmarks().length, 1);
    assert.ok(data.isBookmarked("https://a.example/"));
    data.removeBookmark("https://a.example/");
    assert.equal(data.bookmarks().length, 0);
  });
  await test("they survive a restart", () => {
    data.addBookmark("https://keep.example/", "Keep");
    data.recordDownload({ artifact: "file_1", name: "a.txt", url: "https://x/a.txt", size: 3, ts: 1 });
    data.flushBrowseData();
    data.resetBrowseData();
    assert.equal(data.bookmarks()[0].url, "https://keep.example/");
    assert.equal(data.downloads()[0].name, "a.txt");
  });

  const { LiveBrowser, probeBrowser } = await import("../server/browser");
  if (!(await probeBrowser()).ok) {
    console.log("  (no browser here: the page tests are skipped)");
    console.log(`\n${passed} passed`);
    return;
  }
  const server = http.createServer((req, res) => {
    if (req.url === "/file.txt") {
      res.setHeader("Content-Type", "application/octet-stream");
      res.setHeader("Content-Disposition", 'attachment; filename="hello.txt"');
      res.end("hello download");
      return;
    }
    res.setHeader("Content-Type", "text/html");
    res.end(`<title>T</title><a href="/file.txt">get it</a><p>The quick brown fox jumps over the lazy dog.</p>`);
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const got: Array<{ name: string; bytes: Buffer }> = [];
  const live = new LiveBrowser({
    onFrame: () => {}, onKeyframe: () => {}, onNav: () => {}, onAction: () => {}, onFields: () => {}, watchers: () => 0,
    onDownload: (f) => { got.push(f); },
  });
  try {
    await test("a download arrives as a name and its bytes", async () => {
      const read = await live.goto(origin + "/");
      const link = Number(/\[(\d+)\] link "get it"/.exec(read.outline)![1]);
      await live.click(link);
      for (let i = 0; i < 30 && got.length === 0; i++) await new Promise((r) => setTimeout(r, 100));
      assert.equal(got[0]?.name, "hello.txt");
      assert.equal(got[0]?.bytes.toString(), "hello download");
    });
    await test("find selects the word on the page, and says when it is not there", async () => {
      await live.goto(origin + "/");
      assert.equal(await live.find("brown fox"), true);
      assert.equal(await live.find("zebra"), false);
    });
  } finally {
    await live.close();
    server.close();
    fs.rmSync(home, { recursive: true, force: true });
  }
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
