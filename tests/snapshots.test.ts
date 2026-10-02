/**
 * Version history for the folder the agent builds in: saved after a change,
 * restored on request (files made since removed), and the restore itself kept
 * so it can be undone. The project's own git is never touched.
 *
 *   npx tsx tests/snapshots.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "autora-snap-home-"));
const proj = fs.mkdtempSync(path.join(os.tmpdir(), "autora-snap-proj-"));
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
  const { snapshot, versions, restore } = await import("../server/snapshots");
  const w = (name: string, text: string) => {
    fs.mkdirSync(path.dirname(path.join(proj, name)), { recursive: true });
    fs.writeFileSync(path.join(proj, name), text);
  };
  const r = (name: string) => fs.readFileSync(path.join(proj, name), "utf8");

  w("index.html", "<h1>one</h1>");
  w("node_modules/dep/index.js", "x");
  await test("a change is saved, nothing changed is not, dependencies are left out", async () => {
    const first = await snapshot(proj, "first page");
    assert.ok(first);
    assert.equal(first!.label, "first page");
    assert.equal(await snapshot(proj, "again"), null);
    assert.equal((await versions(proj)).length, 1);
    assert.equal(first!.files, 1);
  });

  await test("restoring puts files back and removes the ones made since", async () => {
    const [v1] = await versions(proj);
    w("index.html", "<h1>two</h1>");
    w("extra.css", "body{}");
    const second = await snapshot(proj, "second");
    assert.ok(second);
    await restore(proj, v1.id);
    assert.equal(r("index.html"), "<h1>one</h1>");
    assert.ok(!fs.existsSync(path.join(proj, "extra.css")));
    assert.ok(fs.existsSync(path.join(proj, "node_modules/dep/index.js")), "untracked dependencies stay");
  });

  await test("a restore can itself be undone", async () => {
    const list = await versions(proj);
    assert.match(list[0].label, /^Restored: first page/);
    const second = list.find((v) => v.label === "second")!;
    await restore(proj, second.id);
    assert.equal(r("index.html"), "<h1>two</h1>");
    assert.ok(fs.existsSync(path.join(proj, "extra.css")));
  });

  await test("the project's own git is untouched, and a bad id is refused", async () => {
    assert.ok(!fs.existsSync(path.join(proj, ".git")));
    await assert.rejects(() => restore(proj, "nonsense"));
    await assert.rejects(() => restore(proj, "0".repeat(40)));
  });

  fs.rmSync(home, { recursive: true, force: true });
  fs.rmSync(proj, { recursive: true, force: true });
  console.log(`\n${passed} passed`);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
