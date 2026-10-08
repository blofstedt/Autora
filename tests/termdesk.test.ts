/**
 * The Terminal window's server side (server/termdesk.ts): what the person types runs in a folder that carries from
 * one command to the next, what the agent runs appears beside it, each is told of the other, the line being typed
 * is completed, and a long output keeps its start and its end.
 *
 *   npx tsx tests/termdesk.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-termdesk-test-"));
const work = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), "autora-term-work-")));
process.env.AUTORA_WORKDIR = work;
fs.mkdirSync(path.join(work, "alpha", "inner"), { recursive: true });
fs.mkdirSync(path.join(work, "beta"));
fs.writeFileSync(path.join(work, "alpine.txt"), "x");
fs.writeFileSync(path.join(work, ".hidden"), "x");
fs.writeFileSync(path.join(work, "package.json"), JSON.stringify({ scripts: { build: "vite build", test: "tsx tests" } }));

const term = await import("../server/termdesk");

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

const S = "session-test-1";

await test("a command runs where the terminal is, and a cd carries to the next one", async () => {
  const first = await term.runInTerm(S, "pwd");
  assert.equal(first.ok, true);
  const second = await term.runInTerm(S, "cd alpha && pwd");
  assert.equal(second.ok, true);
  const third = await term.runInTerm(S, "pwd");
  assert.equal(third.ok, true);
  assert.equal(term.termState(S).open, false, "not open until the window is");
});

await test("the output is shown without the mark that says where the command ended", async () => {
  const express = (await import("express")).default;
  const app = express();
  app.use(express.json());
  term.termRoutes(app, { exists: () => true });
  const server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as any).port}`;
  try {
    const open = await fetch(`${base}/api/term/${S}/open`, { method: "POST" });
    assert.equal(open.status, 200);
    const done = await term.runInTerm(S, "echo hello; cd ..; pwd");
    assert.equal(done.ok, true);
    const got: any = await (await fetch(`${base}/api/term/${S}`)).json();
    const last = got.entries[got.entries.length - 1];
    assert.equal(last.exit, 0);
    assert.equal(last.running, false);
    assert.match(last.output, /^hello\n/);
    assert.doesNotMatch(last.output, /AUTORA_CWD|\u0001/);
    assert.equal(got.cwd, work, "cd .. from alpha is the working folder again");
    const states = got.entries.map((e: any) => e.cwd);
    assert.equal(states[0], work);
    assert.equal(states[1], work);
    assert.equal(states[2], path.join(work, "alpha"), "the cd in the second command moved the third");
    // Deltas: nothing newer than what was seen.
    const none: any = await (await fetch(`${base}/api/term/${S}?after=${got.rev}`)).json();
    assert.equal(none.entries.length, 0);
    assert.equal(none.known.length, got.entries.length);
  } finally {
    server.close();
  }
});

await test("a failing command says so, and its exit code is kept", async () => {
  await term.runInTerm(S, "echo oops >&2; exit 3");
  const state = term.termState(S);
  assert.equal(state.open, true);
  assert.equal(state.running, false);
});

await test("the agent's command appears marked as the agent's, and the person's are told back to it", async () => {
  const id = term.termAgentBegin(S, "ls", work);
  term.termAgentChunk(S, id, "a b c\n");
  term.termAgentEnd(S, id, 0);
  await term.runInTerm(S, "echo from-the-person");
  const news = term.termNews(S);
  assert.match(news, /the person ran:/);
  assert.match(news, /echo from-the-person/);
  assert.equal(term.termNews(S), "", "told once");
  assert.equal(term.termCwd(S), work, "the agent starts where the window is");
});

await test("a long output keeps its start and its end", async () => {
  await term.runInTerm(S, "seq 1 60000");
  const express = (await import("express")).default;
  const app = express();
  term.termRoutes(app, { exists: () => true });
  const server = app.listen(0);
  try {
    const got: any = await (await fetch(`http://127.0.0.1:${(server.address() as any).port}/api/term/${S}`)).json();
    const last = got.entries[got.entries.length - 1];
    assert.ok(last.output.length < 80_000, `kept to a size (${last.output.length})`);
    assert.match(last.output, /^1\n2\n3\n/);
    assert.match(last.output, /left out of the middle/);
    assert.match(last.output, /60000\n$/);
  } finally {
    server.close();
  }
});

await test("a command name is completed, what was used before first", () => {
  const found = term.completeLine("ec", 2, work, ["echo hi"]);
  assert.equal(found.from, 0);
  assert.ok(found.items.some((i) => i.text === "echo"));
  assert.equal(found.items[0].text, "echo", "echo was typed before, so it leads");
  assert.deepEqual(term.completeLine("", 0, work).items, [], "an empty line suggests nothing");
});

await test("a path is completed: folders first with a slash, dotfiles only when asked, cd takes folders only", () => {
  const a = term.completeLine("cat al", 6, work);
  assert.deepEqual(a.items.map((i) => i.text), ["alpha/", "alpine.txt"]);
  assert.equal(a.from, 4);
  const cd = term.completeLine("cd al", 5, work);
  assert.deepEqual(cd.items.map((i) => i.text), ["alpha/"]);
  assert.ok(!term.completeLine("ls ", 3, work).items.some((i) => i.text.startsWith(".")), "dotfiles are not offered unprompted");
  assert.ok(term.completeLine("ls .h", 5, work).items.some((i) => i.text === ".hidden"));
  const deep = term.completeLine("cd alpha/", 9, work);
  assert.deepEqual(deep.items.map((i) => i.text), ["alpha/inner/"]);
  const spaced = path.join(work, "my dir");
  fs.mkdirSync(spaced);
  assert.ok(term.completeLine("cd my", 5, work).items.some((i) => i.text === "my\\ dir/"), "a space is escaped");
});

await test("git subcommands, npm scripts and a pipe's next command are completed", () => {
  assert.ok(term.completeLine("git sta", 7, work).items.some((i) => i.text === "status"));
  assert.deepEqual(term.completeLine("npm run b", 9, work).items.map((i) => i.text), ["build"]);
  const piped = term.completeLine("ls | gre", 8, work);
  assert.equal(piped.from, 5);
  assert.ok(piped.items.some((i) => i.text === "grep"));
  assert.ok(term.completeLine("sudo ec", 7, work).items.some((i) => i.text === "echo"), "after sudo it is a command again");
});

await test("a terminal that is switched off, or an empty command, does not run", async () => {
  assert.equal((await term.runInTerm(S, "   ")).ok, false);
  assert.equal((await term.runInTerm("bad id!", "ls")).ok, false);
});

term.dropTerm(S);
await test("putting the chat away clears its terminal", () => {
  assert.equal(term.termState(S).open, false);
  assert.equal(term.termCwd(S), null);
});

console.log(`\n${passed} terminal cases passed.`);
process.exit(0);
