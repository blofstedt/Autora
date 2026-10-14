/**
 * The improvements log: an agent writes down what Autora should do better, in the repository,
 * where the next agent finds it -- once, without secrets, and without committing anything.
 *
 *   npx tsx tests/improvements.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const home = fs.mkdtempSync(path.join(os.tmpdir(), "autora-imp-"));
process.env.AUTORA_STATE_DIR = path.join(home, "state");
process.env.AUTORA_WORKDIR = path.join(home, "work"); // not a checkout: the agent's own folder
fs.mkdirSync(process.env.AUTORA_WORKDIR, { recursive: true });
delete process.env.AUTORA_REPO;
// Not the real checkout either: with nothing named, the tool also looks at where the server was started.
process.chdir(home);

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const { findTool, runTool } = await import("../server/tools");
const imp = await import("../server/improvements");
const state = await import("../server/state");

/** A folder shaped like a checkout of Autora: a git working tree with Autora's package.json. */
const checkout = (name: string, pkg = "autora") => {
  const root = path.join(home, name);
  fs.mkdirSync(path.join(root, ".git"), { recursive: true });
  fs.mkdirSync(path.join(root, "docs"), { recursive: true });
  fs.writeFileSync(path.join(root, "package.json"), JSON.stringify({ name: pkg }));
  return root;
};
const spec = findTool("improvements")!;
const ctx = (name = "Sabrina") => ({ agents: { self: { id: "a1", name } }, origin: { model: "deepseek/deepseek-flash", version: "0.9.237" } }) as never;
const run = (args: Record<string, unknown>, who?: string) => runTool(spec, args, ctx(who));
const finding = {
  title: "pdf_edit refuses a valid page range",
  happened: "Asked pdf_edit to change pages 2-4 of a 10 page file and it said the range was invalid.",
  evidence: "Error: range 2-4 out of bounds for 0 pages",
  suggestion: "The page count is read before the file is loaded, so it is 0. Read it after loading.",
  area: "tools", severity: "high",
};

await test("the tool is one of the memory tools, and a chat in Plan mode cannot make it write a file", async () => {
  assert.ok(spec, "a tool called improvements");
  assert.equal(spec.group, "memory");
  const { planRefusal } = await import("../server/modes");
  assert.match(planRefusal("plan", undefined, "improvements", { action: "record", title: "x" }) ?? "", /Not run/);
  assert.equal(planRefusal("build", undefined, "improvements", { action: "record", title: "x" }), null, "Build and Agent (once building) may");
});

await test("a finding is written into the checkout as one file, in the format the README describes, and nothing is committed", async () => {
  const root = checkout("repo-a");
  const out = await run({ ...finding, repo: root });
  assert.equal(out.ok, true, out.summary);
  assert.match(out.summary, /docs\/improvements\/ in the Autora checkout/);
  assert.match(out.summary, /written, not committed/i);
  assert.match(out.summary, /tell the person/i, "the agent is told to say so");
  assert.match(out.summary, /work on it now or leave it for someone else/);
  const files = fs.readdirSync(path.join(root, "docs", "improvements"));
  assert.equal(files.length, 1);
  assert.match(files[0], /^\d{4}-\d{2}-\d{2}-pdf-edit-refuses-a-valid-page-range-[0-9a-f]{4}\.md$/);
  const text = fs.readFileSync(path.join(root, "docs", "improvements", files[0]), "utf8");
  assert.match(text, /^---\nid: imp-\d{8}-[0-9a-f]{4}\nstatus: open\narea: tools\nseverity: high\nseen: 1\n/);
  assert.match(text, /models: deepseek\/deepseek-flash\nversions: 0\.9\.237\nby: Sabrina\n---\n# pdf_edit refuses a valid page range/);
  assert.match(text, /## What happened\nAsked pdf_edit/);
  assert.match(text, /## Evidence\n```text\nError: range 2-4 out of bounds for 0 pages\n```/);
  assert.match(text, /## What needs to improve\nThe page count/);
  assert.equal(fs.existsSync(path.join(root, ".git", "index")), false, "no git operation was made");
  assert.equal(imp.listEntries(path.join(root, "docs", "improvements"))[0].status, "open");
});

await test("a finding already open is not written twice: the sighting, the model and the build are added to it", async () => {
  const root = checkout("repo-b");
  await run({ ...finding, repo: root });
  const again = await runTool(spec, { ...finding, title: "PDF edit refuses valid page range", evidence: "Error: range 1-2 out of bounds for 0 pages", repo: root },
    { agents: { self: { id: "a2", name: "Reggie" } }, origin: { model: "openai/gpt-5-mini", version: "0.9.240" } } as never);
  assert.equal(again.ok, true, again.summary);
  assert.match(again.summary, /already recorded.*now seen 2 times/);
  const dir = path.join(root, "docs", "improvements");
  assert.equal(fs.readdirSync(dir).length, 1, "still one file");
  const [entry] = imp.listEntries(dir);
  assert.equal(entry.seen, 2);
  assert.deepEqual(entry.models, ["deepseek/deepseek-flash", "openai/gpt-5-mini"]);
  assert.deepEqual(entry.versions, ["0.9.237", "0.9.240"]);
  const text = fs.readFileSync(path.join(dir, entry.file), "utf8");
  assert.match(text, /## Seen again\n- \d{4}-\d{2}-\d{2} · openai\/gpt-5-mini · 0\.9\.240 · Reggie: Error: range 1-2/);
  // A different problem is its own entry.
  await run({ ...finding, title: "browser_click hangs on a closed dialog", repo: root });
  assert.equal(fs.readdirSync(dir).length, 2);
  // And once it is done, the same words are a new finding, not an old one revived.
  imp.setStatus(dir, entry.id, "done", "Sabrina", "fixed", (t) => t);
  await run({ ...finding, repo: root });
  assert.equal(fs.readdirSync(dir).length, 3);
});

await test("secrets are removed from every field before anything is written", async () => {
  const root = checkout("repo-c");
  state.setSecret("GITHUB_TOKEN", "ghp_supersecretvalue1234567890");
  const out = await run({
    title: "http_request leaks ghp_supersecretvalue1234567890 in its error",
    happened: "Called the API with token ghp_supersecretvalue1234567890 and the error repeated it.",
    evidence: "Authorization: Bearer ghp_supersecretvalue1234567890 -> 401",
    suggestion: "Redact the header before the error is shown. ghp_supersecretvalue1234567890", repo: root,
  });
  assert.equal(out.ok, true, out.summary);
  const dir = path.join(root, "docs", "improvements");
  for (const f of fs.readdirSync(dir)) assert.doesNotMatch(f + fs.readFileSync(path.join(dir, f), "utf8"), /ghp_supersecretvalue/);
});

await test("with no checkout the finding waits in the install's inbox and says so, and file moves it into one", async () => {
  const out = await run(finding);
  assert.equal(out.ok, true, out.summary);
  assert.match(out.summary, /this install's own inbox/);
  assert.match(out.summary, /not in the repository yet/);
  const inbox = path.join(process.env.AUTORA_STATE_DIR!, "improvements");
  assert.equal(fs.readdirSync(inbox).length, 1);
  const nowhere = await run({ action: "file" });
  assert.equal(nowhere.ok, false);
  assert.match(nowhere.summary, /No checkout of the Autora repository/);
  const root = checkout("repo-d");
  const moved = await run({ action: "file", repo: root });
  assert.equal(moved.ok, true, moved.summary);
  assert.match(moved.summary, /Moved 1 from the inbox/);
  assert.equal(fs.readdirSync(inbox).length, 0);
  assert.equal(fs.readdirSync(path.join(root, "docs", "improvements")).length, 1);
  assert.equal((await run({ action: "file", repo: root })).summary, "The inbox is empty: nothing to move.");
});

await test("a repo that is not a checkout of Autora is never written into", async () => {
  const stranger = checkout("not-autora", "something-else");
  const noGit = path.join(home, "no-git");
  fs.mkdirSync(noGit, { recursive: true });
  fs.writeFileSync(path.join(noGit, "package.json"), JSON.stringify({ name: "autora" }));
  const titles = ["office_edit drops a table border", "terminal output loses colour codes", "memory_search misses a recent write", "schedule rejects a valid cron"];
  for (const [i, repo] of [stranger, noGit, "/etc", path.join(home, "does-not-exist")].entries()) {
    const out = await run({ ...finding, title: titles[i], repo });
    assert.equal(out.ok, true, out.summary);
    assert.match(out.summary, /inbox/, `${repo} fell back to the inbox`);
  }
  assert.equal(fs.existsSync(path.join(stranger, "docs", "improvements")), false);
  assert.equal(fs.existsSync(path.join(noGit, "docs", "improvements")), false);
  assert.equal(fs.existsSync("/etc/docs/improvements"), false);
  // A subfolder of a checkout finds its root, so an agent working in src/ still lands in the right place.
  const root = checkout("repo-e");
  fs.mkdirSync(path.join(root, "src", "deep"), { recursive: true });
  assert.equal(imp.findCheckout([path.join(root, "src", "deep")]), root);
  assert.equal(imp.findCheckout([undefined, "", "  "]), null);
});

await test("list shows what is open and where, and status marks one taken and then done, with who and why", async () => {
  const root = checkout("repo-f");
  await run({ ...finding, repo: root });
  await run({ ...finding, title: "ask_user cards overlap on a phone", area: "ui", severity: "low", repo: root });
  const listed = await run({ action: "list", repo: root });
  assert.match(listed.summary, /2 open in docs\/improvements\//);
  assert.match(listed.summary, /\[open, high, tools, seen 1x on deepseek\/deepseek-flash\] pdf_edit refuses a valid page range/);
  const id = /(imp-\d{8}-[0-9a-f]{4})\b[^\n]*pdf_edit refuses/.exec(listed.summary)![1];
  const taken = await run({ action: "status", id, status: "taking-it", note: "on it", repo: root }, "Sabrina");
  assert.equal(taken.ok, true, taken.summary);
  assert.match((await run({ action: "list", status: "taking-it", repo: root })).summary, /1 taking-it/);
  assert.match((await run({ action: "list", repo: root })).summary, /1 open/);
  const done = await run({ action: "status", id, status: "done", note: "read the page count after loading", repo: root }, "Reggie");
  assert.equal(done.ok, true, done.summary);
  const file = path.join(root, "docs", "improvements", imp.listEntries(path.join(root, "docs", "improvements")).find((e) => e.id === id)!.file);
  const text = fs.readFileSync(file, "utf8");
  assert.match(text, /^---\nid: imp-\d{8}-[0-9a-f]{4}\nstatus: done\n/);
  assert.match(text, /## Taken\n- [\d-]+ · Sabrina: on it/);
  assert.match(text, /## Done\n- [\d-]+ · Reggie: read the page count after loading/);
  assert.equal((await run({ action: "status", id: "imp-nope", status: "done", repo: root })).ok, false);
  assert.equal((await run({ action: "status", id, status: "nonsense", repo: root })).ok, false);
  assert.match((await run({ action: "list", status: "all", repo: root })).summary, /2 in docs\/improvements/);
});

await test("a finding must say what happened and what to improve, and its text cannot break the file", async () => {
  const root = checkout("repo-g");
  assert.equal((await run({ title: "x", happened: "", suggestion: "y", repo: root })).ok, false);
  assert.equal((await run({ title: "x", happened: "y", suggestion: "", repo: root })).ok, false);
  assert.equal((await run({ title: "", happened: "y", suggestion: "z", repo: root })).ok, false);
  const out = await run({
    title: "A title\nwith a newline and: a colon\n---\nstatus: done",
    happened: "line one\n---\nstatus: done\n---", evidence: "```\nnot a fence\n```", suggestion: "ok", repo: root,
  });
  assert.equal(out.ok, true, out.summary);
  const dir = path.join(root, "docs", "improvements");
  const [entry] = imp.listEntries(dir);
  assert.equal(entry.status, "open", "the body cannot set the status");
  assert.equal(entry.title.includes("\n"), false);
  const text = fs.readFileSync(path.join(dir, entry.file), "utf8");
  assert.equal(text.match(/```/g)!.length, 2, "the evidence cannot close its own fence early");
  assert.equal(imp.listEntries(dir).length, 1);
});

await test("size is bounded and the README is not an entry", async () => {
  const root = checkout("repo-h");
  const out = await run({ title: "t".repeat(500), happened: "h".repeat(50_000), evidence: "e".repeat(50_000), suggestion: "s".repeat(50_000), repo: root });
  assert.equal(out.ok, true, out.summary);
  const dir = path.join(root, "docs", "improvements");
  fs.writeFileSync(path.join(dir, "README.md"), "# Improvements\n");
  const [only] = fs.readdirSync(dir).filter((n) => n !== "README.md");
  assert.ok(fs.statSync(path.join(dir, only)).size < 12_000);
  assert.equal(imp.listEntries(dir).length, 1, "README.md is not an entry");
});

await test("the briefing says when to record, to tell the person, and what is not worth recording", async () => {
  const { MEMORY_GUIDE } = await import("../server/guides");
  assert.match(MEMORY_GUIDE, /Improving Autora/);
  assert.match(MEMORY_GUIDE, /tell the person in a line or two/);
  assert.match(MEMORY_GUIDE, /Not the person's mistakes, a site being down, or a hard task/);
  const { ErrorBudget } = await import("../server/errorbudget");
  const b = new ErrorBudget(3, 6);
  let note: string | null = null;
  for (let i = 0; i < 3; i += 1) note = b.record("pdf_edit", `attempt ${i}`, false, "range out of bounds").note;
  assert.match(note ?? "", /improvements tool/, "a failure that repeats is where an agent is reminded");
});

console.log(`\n${passed} passed`);
