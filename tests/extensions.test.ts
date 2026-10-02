/**
 * Chrome extensions: unpacked from a package, loaded into the browser, running
 * on pages, and their popup page opening as a tab.
 *
 *   npx tsx tests/extensions.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { zipSync, strToU8 } from "fflate";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "autora-ext-"));
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
  const ext = await import("../server/extensions");
  const manifest = {
    manifest_version: 3,
    name: "__MSG_extName__",
    default_locale: "en",
    version: "1.2.3",
    content_scripts: [{ matches: ["http://127.0.0.1/*"], js: ["mark.js"] }],
    action: { default_popup: "popup.html" },
  };
  const zip = Buffer.from(zipSync({
    "manifest.json": strToU8(JSON.stringify(manifest)),
    "_locales/en/messages.json": strToU8(JSON.stringify({ extName: { message: "Marker" } })),
    "mark.js": strToU8(`const d = document.createElement("p"); d.textContent = "extension was here"; (document.body || document.documentElement).append(d);`),
    "popup.html": strToU8("<title>Popup</title><p>popup of the marker</p>"),
    "../../escape.txt": strToU8("no"),
  }));
  // The same package behind a CRX3 header.
  const header = Buffer.alloc(12);
  header.write("Cr24", 0, "latin1");
  header.writeUInt32LE(3, 4);
  header.writeUInt32LE(0, 8);
  const crx = Buffer.concat([header, zip]);

  await test("a package unpacks, named from its own locale, and cannot write outside its folder", () => {
    assert.deepEqual(ext.launchArgs(), []);
    const info = ext.installPackage(crx, "file", "marker");
    assert.equal(info.name, "Marker");
    assert.equal(info.version, "1.2.3");
    assert.match(info.popup!, /^chrome-extension:\/\/[a-p]{32}\/popup\.html$/);
    assert.ok(!fs.existsSync(path.join(home, "extensions", "escape.txt")));
    assert.ok(!fs.existsSync(path.join(home, "escape.txt")));
    assert.equal(ext.listExtensions().length, 1);
    assert.ok(ext.launchArgs().some((a) => a.startsWith("--load-extension=")));
  });
  await test("a store address or id is understood, anything else is not", () => {
    const id = "ddkjiahejlhfcafbddmgiahcphecmpfh";
    assert.equal(ext.storeIdOf(id), id);
    assert.equal(ext.storeIdOf(`https://chromewebstore.google.com/detail/ublock-origin-lite/${id}`), id);
    assert.equal(ext.storeIdOf(`https://evil.example/${id}`), null);
    assert.equal(ext.storeIdOf("hello"), null);
  });
  await test("a disabled extension is not loaded", () => {
    const id = ext.listExtensions()[0].id;
    ext.setExtensionEnabled(id, false);
    assert.deepEqual(ext.launchArgs(), []);
    ext.setExtensionEnabled(id, true);
    assert.ok(ext.launchArgs().length > 0);
  });

  const { LiveBrowser, probeBrowser } = await import("../server/browser");
  if (!(await probeBrowser()).ok) {
    console.log("  (no browser here: the page tests are skipped)");
    console.log(`\n${passed} passed`);
    return;
  }
  const server = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end("<title>Plain</title><p>a plain page</p>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const origin = `http://127.0.0.1:${(server.address() as any).port}`;
  const live = new LiveBrowser({
    onFrame: () => {}, onKeyframe: () => {}, onNav: () => {}, onAction: () => {}, onFields: () => {}, watchers: () => 0,
  });
  try {
    await test("the extension runs on the page", async () => {
      const read = await live.goto(origin + "/");
      assert.match(read.text, /extension was here/);
    });
    await test("its popup opens as a tab", async () => {
      const popup = ext.listExtensions()[0].popup!;
      const out: any = await live.newTab(popup);
      assert.match(out.text, /popup of the marker/);
      assert.equal(live.tabList().length, 2);
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
