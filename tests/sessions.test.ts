/**
 * Sessions on disk: the listing without the logs, and the vault that outlives
 * a restart.
 *
 * A restart used to parse every session's whole event log to build threads
 * nobody had asked to see. That is what the index is for, and this is the
 * test that says the index still answers the questions the log answered --
 * and that a vaulted output is still readable after the process that stored
 * it is gone, which is when vault_read used to say "no such artifact".
 *
 *   npx tsx tests/sessions.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-sessions-"));
process.env.AUTORA_STATE_DIR = dir;
const store = await import("../server/store");
const { ContextEngine } = await import("../server/context");

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

const event = (seq: number, kind: string) => ({
  seq, ts: 1_700_000_000 + seq, kind, actor: "agent", span: null, payload: {}, blob: null,
});

console.log("sessions on disk");

store.saveSession({
  id: "session-a", title: "First", createdAt: 1_700_000_000,
  events: [event(1, "session.started"), event(2, "turn.user"), event(3, "tool.call")],
});
store.appendEvent("session-a", event(4, "tool.error"));
await new Promise((resolve) => setTimeout(resolve, 400)); // the log is written in batches

test("the listing reads meta.json, not the log", () => {
  const index = store.loadSessionIndex();
  assert.equal(index.length, 1);
  assert.equal(index[0].id, "session-a");
  assert.equal(index[0].title, "First");
  // The events are not in it: that is the whole point.
  assert.equal("events" in index[0], false);
});

test("the counts are kept in meta.json, so nothing has to count them", () => {
  const meta = JSON.parse(
    fs.readFileSync(path.join(dir, "sessions", "session-a", "meta.json"), "utf8"),
  );
  assert.ok(meta.counts, "counts were written");
  assert.equal(meta.counts.seq, 4);
  assert.equal(meta.counts.turns, 1);
  assert.equal(meta.counts.tools, 1);
  assert.equal(meta.counts.errors, 1);
});

test("a session written before the counts existed is counted once, from its log", () => {
  const metaPath = path.join(dir, "sessions", "session-a", "meta.json");
  const meta = JSON.parse(fs.readFileSync(metaPath, "utf8"));
  delete meta.counts;
  fs.writeFileSync(metaPath, JSON.stringify(meta));
  const counts = store.countSession("session-a");
  assert.equal(counts.seq, 4);
  assert.equal(counts.events, 4);
});

test("the log is read on demand, in order, and survives a torn last line", () => {
  fs.appendFileSync(path.join(dir, "sessions", "session-a", "events.jsonl"), '{"seq": 5, "ki');
  const events = store.loadSessionEvents<{ seq: number }>("session-a");
  assert.deepEqual(events.map((e) => e.seq), [1, 2, 3, 4]);
});

test("a vaulted output is still there after a restart", () => {
  const first = new ContextEngine(undefined, "session-a");
  const id = first.vault.put("x".repeat(50_000));
  assert.match(id, /^art_[0-9a-f]{8}$/);

  // A new engine, as a new process would build: nothing in memory at all.
  const second = new ContextEngine(undefined, "session-a");
  const text = second.vault.get(id);
  assert.equal(text?.length, 50_000);

  // An id from a session that no longer exists is not invented.
  const other = new ContextEngine(undefined, "session-b");
  assert.equal(other.vault.get(id), null);
});

test("a vault id cannot be made to point at a file", () => {
  const engine = new ContextEngine(undefined, "session-a");
  assert.equal(engine.vault.get("../../settings.json"), null);
  assert.equal(engine.vault.get("art_../x"), null);
});

test("deleting a session takes its log and its vault with it", () => {
  store.deleteSession("session-a");
  assert.equal(fs.existsSync(path.join(dir, "sessions", "session-a")), false);
  assert.equal(store.loadSessionIndex().length, 0);
});

console.log(`\nsessions: ${passed} passed`);
