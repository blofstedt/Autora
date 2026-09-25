/**
 * Tool health: which site or command a failure belongs to.
 *
 * Keyed by tool alone, one hostile site poisoned "browser" for a week: the
 * note told the agent the browser was failing, which was untrue of every
 * other site. What is asserted here is that a failure is attributed to the
 * host or the command that earned it, and that the note only names things
 * that are actually going wrong often.
 *
 *   npx tsx tests/toolhealth.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-health-"));
const health = await import("../server/toolhealth");

let passed = 0;
function test(name: string, fn: () => void) {
  try {
    fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

const now = Math.floor(Date.now() / 1000);
const DAY = 24 * 60 * 60;

console.log("tool health");

test("a URL becomes the host it points at", () => {
  assert.equal(
    health.targetOf("browser_open", { url: "https://www.shop.example.com/cart?x=1" }),
    "shop.example.com",
  );
  assert.equal(health.targetOf("http_request", { url: "http://api.example.org/v1" }), "api.example.org");
  assert.equal(health.targetOf("browser_click", { ref: 4 }, "https://news.example.net/a"), "news.example.net");
  assert.equal(health.targetOf("browser_click", { ref: 4 }), "");
});

test("a terminal call is named by the command, not left out", () => {
  assert.equal(health.targetOf("terminal", { command: "git push origin main --tags" }), "git push");
  assert.equal(health.targetOf("memory_write", { title: "x" }), "");
});

test("one failing site is not the browser failing", () => {
  health.recordOutcome("browser_open", false, "net::ERR_CONNECTION_REFUSED", { at: now, target: "shop.example.com" });
  health.recordOutcome("browser_open", false, "net::ERR_CONNECTION_REFUSED", { at: now, target: "shop.example.com" });
  health.recordOutcome("browser_open", true, "ok", { at: now, target: "shop.example.com" });
  health.recordOutcome("browser_open", true, "ok", { at: now, target: "docs.example.org" });
  health.recordOutcome("browser_open", true, "ok", { at: now, target: "docs.example.org" });
  health.recordOutcome("browser_open", true, "ok", { at: now, target: "docs.example.org" });

  const rows = health.toolHealth(now);
  const shop = rows.find((r) => r.label === "browser_open (shop.example.com)");
  const docs = rows.find((r) => r.label === "browser_open (docs.example.org)");
  assert.equal(shop?.failures, 2);
  assert.equal(docs?.failures, 0);

  const note = health.healthBriefing(now);
  assert.match(note, /browser_open \(shop\.example\.com\): 2 of the last 3 calls failed/);
  assert.doesNotMatch(note, /docs\.example\.org/);
});

test("too few calls says nothing at all", () => {
  const fresh = Math.floor(Date.now() / 1000) + 1_000_000;
  assert.equal(health.healthBriefing(fresh), "");
});

test("a command has to fail more than once before it is blamed", () => {
  health.recordOutcome("terminal", false, "Exit code 1\nfatal: no upstream", { at: now, target: "git fetch" });
  let note = health.healthBriefing(now);
  assert.doesNotMatch(note, /git fetch/);

  health.recordOutcome("terminal", false, "Exit code 1\nfatal: no upstream", { at: now, target: "git fetch" });
  health.recordOutcome("terminal", false, "Exit code 1\nfatal: no upstream", { at: now, target: "git fetch" });
  note = health.healthBriefing(now);
  assert.match(note, /terminal \(git fetch\): 3 of the last 3 calls failed/);
});

test("outcomes from last week say nothing about today", () => {
  health.recordOutcome("browser_open", false, "gone", { at: now - 8 * DAY, target: "old.example.com" });
  const rows = health.toolHealth(now);
  assert.equal(rows.some((r) => r.target === "old.example.com"), false);
});

/* Written a moment after the change rather than on every one -- a turn can
   record dozens of outcomes a second -- so the file appears shortly after. */
await new Promise((resolve) => setTimeout(resolve, 700));
test("the history survives in the state directory", () => {
  const file = path.join(process.env.AUTORA_STATE_DIR!, "tool-health.json");
  assert.ok(fs.existsSync(file), "tool health is written next to the settings");
  const written = JSON.parse(fs.readFileSync(file, "utf8"));
  assert.ok(written["browser_open (shop.example.com)"], "stored under tool and target");
});

console.log(`\ntool health: ${passed} passed`);
