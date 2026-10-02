/**
 * The git tool: structured reads, changes that go through git without a shell,
 * and no way to do the things that cannot be undone.
 *
 *   npx tsx tests/gittool.test.ts
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { gitReadOnly, runGit } from "../server/gittool";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-git-"));
const git = (...a: string[]) => execFileSync("git", a, { cwd: dir, encoding: "utf8" });
git("init", "-q", "-b", "main");
git("config", "user.email", "t@example.com");
git("config", "user.name", "Test");
const call = (args: Record<string, any>) => runGit({ cwd: dir, args });

await test("outside a repository it says so", async () => {
  const empty = fs.mkdtempSync(path.join(os.tmpdir(), "autora-nogit-"));
  const r = await runGit({ cwd: empty, args: { action: "status" } });
  assert.equal(r.ok, false);
  assert.match(r.summary, /not inside a git repository/);
});

await test("status groups what changed, and a clean tree says so", async () => {
  fs.writeFileSync(path.join(dir, "a.txt"), "one\n");
  let r = await call({ action: "status" });
  assert.match(r.summary, /Untracked \(1\)/);
  assert.match(r.summary, /a\.txt/);
  await call({ action: "add", paths: ["a.txt"] });
  r = await call({ action: "status" });
  assert.match(r.summary, /Staged \(1\)/);
  r = await call({ action: "commit", message: "Add a" });
  assert.equal(r.ok, true, r.summary);
  assert.match(r.summary, /Working tree clean/);
});

await test("a commit needs a message and something staged", async () => {
  assert.equal((await call({ action: "commit", message: "" })).ok, false);
  const r = await call({ action: "commit", message: "Nothing" });
  assert.equal(r.ok, false);
  assert.match(r.summary, /Nothing is staged/);
});

await test("diff shows the stat and the patch; staged and path narrow it", async () => {
  fs.writeFileSync(path.join(dir, "a.txt"), "one\ntwo\n");
  fs.writeFileSync(path.join(dir, "b.txt"), "b\n");
  const r = await call({ action: "diff" });
  assert.match(r.summary, /\+two/);
  assert.equal((await call({ action: "diff", staged: true })).summary, "No differences.");
  const only = await call({ action: "diff", paths: ["a.txt"], stat_only: true });
  assert.doesNotMatch(only.summary, /b\.txt/);
});

await test("commit all takes tracked changes; log, show and blame read them back", async () => {
  fs.rmSync(path.join(dir, "b.txt"));
  const c = await call({ action: "commit", message: "Two lines", all: true });
  assert.equal(c.ok, true, c.summary);
  const log = await call({ action: "log", limit: 5 });
  assert.match(log.summary, /Two lines/);
  assert.match(log.summary, /Add a/);
  assert.match((await call({ action: "log", search: "add a" })).summary, /Add a/);
  assert.match((await call({ action: "show", ref: "HEAD" })).summary, /\+two/);
  assert.match((await call({ action: "blame", path: "a.txt" })).summary, /two/);
});

await test("branches: create, switch, merge, and delete only what is merged", async () => {
  assert.equal((await call({ action: "switch", branch: "feature", create: true })).ok, true);
  fs.writeFileSync(path.join(dir, "f.txt"), "f\n");
  await call({ action: "add", paths: ["f.txt"] });
  await call({ action: "commit", message: "Feature work" });
  await call({ action: "switch", branch: "main" });
  const m = await call({ action: "merge", branch: "feature" });
  assert.equal(m.ok, true, m.summary);
  assert.ok(fs.existsSync(path.join(dir, "f.txt")));
  assert.equal((await call({ action: "branch", branch: "feature", delete: true })).ok, true);
  assert.match((await call({ action: "branches" })).summary, /main/);
});

await test("restore unstages by default and only discards when asked, never everything", async () => {
  fs.writeFileSync(path.join(dir, "a.txt"), "changed\n");
  await call({ action: "add", paths: ["a.txt"] });
  await call({ action: "restore", paths: ["a.txt"] });
  assert.match((await call({ action: "status" })).summary, /Changed, not staged/);
  await call({ action: "restore", paths: ["a.txt"], discard: true });
  assert.match((await call({ action: "status" })).summary, /Working tree clean/);
  assert.match((await call({ action: "restore" })).summary, /needs paths/);
});

await test("stash puts work aside and brings it back", async () => {
  fs.writeFileSync(path.join(dir, "a.txt"), "wip\n");
  assert.equal((await call({ action: "stash", message: "wip" })).ok, true);
  assert.match((await call({ action: "stashes" })).summary, /wip/);
  assert.equal((await call({ action: "stash", mode: "pop" })).ok, true);
  assert.equal(fs.readFileSync(path.join(dir, "a.txt"), "utf8"), "wip\n");
});

await test("options cannot be smuggled in as refs or paths, and force-style actions do not exist", async () => {
  assert.equal((await call({ action: "log", ref: "--output=/tmp/x" })).ok, false);
  assert.equal((await call({ action: "add", paths: ["--force"] })).ok, false);
  for (const action of ["reset", "clean", "push --force", "rebase"]) {
    const r = await call({ action });
    assert.equal(r.ok, false);
    assert.match(r.summary, /action is one of/);
  }
});

await test("only the reading actions count as looking, for Plan mode", () => {
  for (const action of ["status", "diff", "log", "show", "blame", "branches", "stashes", "remotes"]) assert.equal(gitReadOnly({ action }), true, action);
  for (const action of ["add", "commit", "switch", "branch", "restore", "stash", "merge", "fetch", "pull", "push", ""]) assert.equal(gitReadOnly({ action }), false, action);
});

console.log(`\n${passed} git cases passed.`);
