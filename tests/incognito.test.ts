/**
 * The chat that is never written down.
 *
 * Incognito is a promise made by the store, not by whoever calls it: a
 * session whose id says it is ephemeral cannot be written, however a caller
 * reaches it -- no log, no meta.json, no tallies, and nothing in the vault.
 * That is what makes "nothing is saved" true even if a later change forgets
 * to check the flag somewhere, so it is the store that is tested here rather
 * than the routes above it.
 *
 *   npx tsx tests/incognito.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-incognito-"));
process.env.AUTORA_STATE_DIR = dir;
const store = await import("../server/store");

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
const sessionDir = (id: string) => path.join(dir, "sessions", id);

console.log("incognito sessions");

const live = store.ephemeralId();

test("an incognito id is recognised, and an ordinary one is not", () => {
  assert.equal(store.isEphemeral(live), true);
  assert.equal(store.isEphemeral("session-mfx1-k3ta"), false);
  assert.equal(store.isEphemeral("session-init"), false);
  assert.equal(store.isEphemeral(live + "/../x"), false);
});

test("two incognito chats never share an id", () => {
  assert.notEqual(store.ephemeralId(), store.ephemeralId());
});

test("its log is not written, and no folder is made for it", async () => {
  store.appendEvent(live, event(1, "turn.user"));
  store.saveSession({ id: live, title: "Incognito", createdAt: 1_700_000_000, events: [event(1, "session.started")] });
  store.saveMeta({ id: live, title: "Incognito", createdAt: 1_700_000_000 });
  await new Promise((resolve) => setTimeout(resolve, 500)); // the log is written in batches
  assert.equal(fs.existsSync(sessionDir(live)), false);
});

test("its tallies are in memory only, and start empty", async () => {
  assert.deepEqual(store.countsFor(live), { seq: 0, lastTs: 0, events: 0, turns: 0, tools: 0, errors: 0 });
  await new Promise((resolve) => setTimeout(resolve, 300));
  assert.equal(fs.existsSync(sessionDir(live)), false);
});

test("the vault keeps nothing for it either", async () => {
  store.saveVaultText(live, "art_0123456789abcdef", "a very long tool output");
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal(store.readVaultText(live, "art_0123456789abcdef"), null);
  assert.equal(fs.existsSync(sessionDir(live)), false);
});

test("closing one removes nothing, and does not mind that there is nothing", () => {
  store.deleteSession(live);
  store.forgetCounts(live);
  assert.equal(fs.existsSync(sessionDir(live)), false);
});

test("an ordinary session beside it is still written, log and meta together", async () => {
  const kept = "session-kept";
  store.saveSession({ id: kept, title: "Kept", createdAt: 1_700_000_000, events: [event(1, "session.started")] });
  store.appendEvent(kept, event(2, "turn.user"));
  await new Promise((resolve) => setTimeout(resolve, 500));
  assert.equal(fs.existsSync(path.join(sessionDir(kept), "events.jsonl")), true);
  assert.equal(store.loadSessionIndex().some((m) => m.id === kept), true);
  // And it is not in the list under a name of its own.
  assert.equal(store.loadSessionIndex().some((m) => m.id === live), false);
});

console.log(`\n${passed} passed`);
