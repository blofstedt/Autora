/**
 * Recorded flows: a browser job recorded once and replayed by code, finding
 * each element again by what it is, stopping rather than guessing, and never
 * keeping a secret.
 *
 *   npx tsx tests/flows.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-flows-"));
const f = await import("../server/flows");
import type { PageRead, RefInfo } from "../server/browser";
import type { FlowBrowser } from "../server/flows";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

const ref = (n: number, role: string, name: string, extra: Record<string, any> = {}) =>
  ({ ref: n, role, name, value: null, x: 0, y: 0, w: 10, h: 10, href: null, checked: null, disabled: false, ...extra });
const page = (url: string, refs: any[], text = ""): PageRead => ({ url, title: "T", outline: refs.map((r) => `[${r.ref}] ${r.role} "${r.name}"`).join("\n"), refs, text, captchas: [] });
const info = (role: string, name: string, extra: Partial<RefInfo> = {}): RefInfo => ({ role, name, href: null, type: null, placeholder: null, purpose: null, nth: 0, ...extra });

/** A site with a login, then a statements page; numbers differ on every load. */
function fakeSite(opts: { shuffle?: boolean; renamed?: boolean } = {}) {
  const log: string[] = [];
  let current = page("about:blank", []);
  const n = (base: number) => (opts.shuffle ? base + 100 : base);
  const pages: Record<string, () => PageRead> = {
    "https://bank.test/login": () => page("https://bank.test/login", [
      ref(n(1), "textbox", "Username", { purpose: "username" }),
      ref(n(2), "textbox", "Password", { type: "password" }),
      ref(n(3), "button", opts.renamed ? "Continue" : "Sign in"),
    ]),
    "https://bank.test/statements": () => page("https://bank.test/statements", [
      ref(n(4), "link", "March 2024 statement", { href: "https://bank.test/s/2024-03" }),
      ref(n(5), "link", "April 2024 statement", { href: "https://bank.test/s/2024-04" }),
    ], "Your statements"),
  };
  const browser: FlowBrowser = {
    async goto(url) { log.push(`goto ${url}`); current = (pages[url] ?? (() => page(url, [], `page ${url}`)))(); return current; },
    async snapshot() { return current; },
    async click(r) {
      const el = current.refs.find((x) => x.ref === r)!;
      log.push(`click ${el.name}`);
      current = el.href ? page(el.href, [], `Statement ${el.name}`) : pages["https://bank.test/statements"]();
      return current;
    },
    async fill(values, submit) { log.push(`fill ${values.map((v) => `${current.refs.find((x) => x.ref === v.ref)!.name}=${v.text}`).join(",")}${submit ? " +submit" : ""}`); return current; },
    async press(keys) { log.push(`press ${keys.join("+")}`); return current; },
    async scroll() { log.push("scroll"); return current; },
    async back() { log.push("back"); return current; },
  };
  return { browser, log };
}

const SESSION = "s1";
await test("recording keeps the steps, and a password never goes in", () => {
  assert.equal(f.startRecording(SESSION, "Bad Name!", ""), "A flow's name is letters, numbers, - and _ (up to 48), e.g. monthly-statement.");
  assert.equal(f.startRecording(SESSION, "statement", "Get a statement"), null);
  assert.deepEqual(f.recordingOf(SESSION), { name: "statement", steps: 0 });
  f.recordStep(SESSION, { type: "open", url: "https://bank.test/login" });
  f.recordStep(SESSION, { type: "fill", submit: false, fields: [
    { target: info("textbox", "Username", { purpose: "username" }), text: "{{cred:bank.test:username}}" },
    { target: info("textbox", "Password", { type: "password" }), text: "hunter2-actual" },
  ] });
  f.recordStep(SESSION, { type: "click", target: info("button", "Sign in") });
  f.recordStep(SESSION, { type: "click", target: info("link", "March 2024 statement", { href: "https://bank.test/s/2024-03" }) });
  assert.equal(f.recordExpect(SESSION, { text: "March 2024 statement" }), null);
  const done = f.stopRecording(SESSION);
  assert.ok(done.flow);
  const json = JSON.stringify(done.flow);
  assert.doesNotMatch(json, /hunter2/);
  assert.match(json, /\{\{password\}\}/);
  assert.match(json, /\{\{cred:bank\.test:username\}\}/);
  assert.equal(done.flow!.params.password, null);
});

await test("a literal can be turned into a parameter with a default", () => {
  f.startRecording(SESSION, "month", "");
  f.recordStep(SESSION, { type: "open", url: "https://bank.test/statements" });
  f.recordStep(SESSION, { type: "click", target: info("link", "March 2024 statement") });
  f.recordStep(SESSION, { type: "fill", submit: false, fields: [{ target: info("textbox", "Search"), text: "March 2024" }] });
  f.recordExpect(SESSION, { text: "March 2024" });
  assert.match(f.parametrize(SESSION, "month", "March 2024").message, /2 places/);
  assert.equal(f.parametrize(SESSION, "x", "absent").ok, false);
  const saved = f.stopRecording(SESSION).flow!;
  assert.equal(saved.params.month, "March 2024");
});

await test("replay finds elements by what they are, even when their numbers changed", async () => {
  const flow = f.getFlow("statement")!;
  const { browser, log } = fakeSite({ shuffle: true });
  const r = await f.runFlow(flow, { password: "from-the-run" }, browser, { resolve: (t) => t.replace(/\{\{cred:[^}]+\}\}/g, "alice") });
  assert.equal(r.ok, true, r.message);
  assert.deepEqual(log, ["goto https://bank.test/login", "fill Username=alice,Password=from-the-run", "click Sign in", "click March 2024 statement"]);
  assert.match(r.lines.join("\n"), /5\. expect the page to show "March 2024 statement" -- ok/);
  assert.equal(r.page?.url, "https://bank.test/s/2024-03");
});

await test("a missing parameter is asked for before anything runs", async () => {
  const { browser, log } = fakeSite();
  const r = await f.runFlow(f.getFlow("statement")!, {}, browser);
  assert.equal(r.ok, false);
  assert.match(r.message, /needs password/);
  assert.deepEqual(log, []);
});

await test("a parameter defaults, can be given, and unknown ones are named", async () => {
  const flow = f.getFlow("month")!;
  assert.deepEqual(f.bindParams(flow, {}).values, { month: "March 2024" });
  const b = f.bindParams(flow, { month: "April 2024", extra: 1 });
  assert.equal(b.values.month, "April 2024");
  assert.deepEqual(b.unknown, ["extra"]);
});

await test("a step whose element is gone stops the run, naming what is there instead", async () => {
  const { browser, log } = fakeSite({ renamed: true });
  const r = await f.runFlow(f.getFlow("statement")!, { password: "x" }, browser, { resolve: (t) => t });
  assert.equal(r.ok, false);
  assert.match(r.message, /Stopped at step 3 of 5/);
  assert.match(r.message, /no button like "Sign in"/);
  assert.match(r.message, /"Continue"/);
  assert.ok(!log.includes("click Continue"), "it did not guess");
  assert.match(r.lines.join("\n"), /FAILED/);
});

await test("an expectation that is not met fails the run, with where it was", async () => {
  f.startRecording(SESSION, "check", "");
  f.recordStep(SESSION, { type: "open", url: "https://bank.test/statements" });
  f.recordExpect(SESSION, { text: "Payments due" });
  f.stopRecording(SESSION);
  const { browser } = fakeSite();
  const r = await f.runFlow(f.getFlow("check")!, {}, browser);
  assert.equal(r.ok, false);
  assert.match(r.message, /does not show "Payments due" \(it is https:\/\/bank\.test\/statements\)/);
});

await test("locating prefers an exact name or the same link, and refuses a tie", () => {
  const refs = [ref(1, "link", "Download"), ref(2, "link", "Download PDF", { href: "https://x/pdf" }), ref(3, "link", "Download CSV", { href: "https://x/csv" })] as any;
  assert.deepEqual(f.locate(refs, info("link", "Download")), { ref: 1 });
  assert.deepEqual(f.locate(refs, info("link", "Get the file", { href: "https://x/csv" })), { ref: 3 });
  const tie = f.locate(refs.slice(1), info("link", "Download", { nth: 5 }));
  assert.ok("error" in tie && /more than one/.test(tie.error));
});

await test("flows are listed, described, and forgotten", () => {
  assert.deepEqual(f.listFlows().map((x) => x.name), ["check", "month", "statement"]);
  const text = f.describeFlow(f.getFlow("statement")!);
  assert.match(text, /Parameters: password \(required\)/);
  assert.match(text, /1\. open https:\/\/bank\.test\/login/);
  f.noteRun("statement", true, "ok");
  assert.equal(f.getFlow("statement")!.runs, 1);
  assert.equal(f.deleteFlow("check"), true);
  assert.equal(f.getFlow("check"), null);
});

await test("a cancelled run stops between steps", async () => {
  const { browser, log } = fakeSite();
  let n = 0;
  const r = await f.runFlow(f.getFlow("month")!, {}, browser, { cancelled: () => ++n > 1 });
  assert.equal(r.ok, false);
  assert.match(r.message, /Stopped before step 2/);
  assert.equal(log.length, 1);
});

console.log(`\n${passed} flow cases passed.`);
