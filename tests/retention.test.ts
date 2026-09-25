/**
 * Housekeeping: what the policy keeps and what it lets go.
 *
 * Nothing used to delete anything -- sessions, logs and the Artifacts page
 * grew for the life of the install -- so the rules that now do it are worth
 * pinning down, especially the ones about not deleting: the newest N, the
 * pinned, and anything in use right now.
 *
 *   npx tsx tests/retention.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-retention-"));
process.env.AUTORA_STATE_DIR = dir;
const store = await import("../server/store");
const retention = await import("../server/retention");
const settings = await import("../server/state");

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

const DAY = 24 * 60 * 60 * 1000;

/** A session whose files were last written `ageDays` ago. */
function session(id: string, ageDays: number, pinned = false) {
  store.saveSession({
    id,
    title: id,
    createdAt: Math.floor((Date.now() - ageDays * DAY) / 1000),
    pinned,
    events: [{ seq: 1, ts: 1, kind: "session.started", actor: "system", span: null, payload: {}, blob: null }],
  });
  /* Both files: the age of a session is the newest thing in its folder, and
     the counts beside the log are written whenever the log is. */
  const when = new Date(Date.now() - ageDays * DAY);
  for (const name of ["events.jsonl", "meta.json"]) {
    fs.utimesSync(path.join(dir, "sessions", id, name), when, when);
  }
}

/**
 * An artifact as the index records one: a file, and an entry beside it. The
 * index is written here rather than through saveArtifact because the age is
 * what the policy is about and saveArtifact always says "now".
 */
const INDEX = path.join(dir, "artifacts", "index.json");
fs.mkdirSync(path.join(dir, "artifacts"), { recursive: true });
const index: any[] = [];

function artifact(name: string, ageDays: number) {
  const id = `file_${crypto.randomBytes(8).toString("hex")}`;
  const body = "x".repeat(1000);
  fs.writeFileSync(path.join(dir, "artifacts", id), body);
  index.push({
    id, origin: "agent", name, mime: "application/octet-stream",
    size: body.length, ts: Date.now() - ageDays * DAY,
  });
  return id;
}

console.log("retention");

session("session-old", 400);
session("session-older", 500);
session("session-new", 1);
session("session-pinned", 600, true);
session("session-busy", 700);
const oldArtifact = artifact("report.pdf", 500);
artifact("today.png", 0);
/* Written before anything asks the artifacts module, which reads the index
   once and keeps it. */
fs.writeFileSync(INDEX, JSON.stringify(index));

test("the report says what is stored, by area", () => {
  const report = retention.storageReport();
  assert.equal(report.sessions.count, 5);
  assert.equal(report.artifacts.count, 2);
  assert.ok(report.sessions.bytes > 0);
  assert.ok(report.artifacts.bytes > 0);
  assert.ok(report.total >= report.sessions.bytes + report.artifacts.bytes);
});

test("an age limit and a floor: older than the days, never fewer than the newest N", () => {
  const result = retention.prune(
    { sessionDays: 180, keepSessions: 1, artifactDays: 180, keepArtifacts: 1 },
    Date.now(),
    (id) => id === "session-busy",
  );
  // session-new is the newest, so the floor keeps it whatever its age; the
  // pinned one and the busy one are never touched; the two old ones go.
  assert.deepEqual(result.sessions.ids.sort(), ["session-old", "session-older"]);
  assert.deepEqual(result.artifacts.ids, [oldArtifact]);
  assert.ok(result.sessions.bytes > 0 && result.artifacts.bytes > 0);
  const left = store.loadSessionIndex().map((s) => s.id).sort();
  assert.deepEqual(left, ["session-busy", "session-new", "session-pinned"]);
});

test("the floor alone protects the newest, whatever their age", () => {
  session("session-ancient", 900);
  const result = retention.prune(
    { sessionDays: 180, keepSessions: 1, artifactDays: 0, keepArtifacts: 1 },
    Date.now(),
    (id) => id === "session-busy",
  );
  // keepSessions: 1 keeps only the newest; the age limit still applies to the
  // rest, so only the ancient one goes.
  assert.deepEqual(result.sessions.ids, ["session-ancient"]);
  // Whatever the age limit, the newest one is under the floor: kept.
  // The only artifact left is the newest, and the floor is one: kept.
  assert.deepEqual(result.artifacts.ids, []);
});

test("0 days means never on age alone", () => {
  session("session-forever", 3000);
  const result = retention.prune(
    { sessionDays: 0, keepSessions: 999, artifactDays: 0, keepArtifacts: 999 },
    Date.now(),
  );
  assert.equal(result.sessions.count, 0);
  assert.equal(result.artifacts.count, 0);
  assert.ok(store.loadSessionIndex().some((s) => s.id === "session-forever"));
});

test("posted numbers are clamped rather than trusted", () => {
  // The policy is a setting, so what arrives is whatever the panel sent.
  const policy = settings.mergeRetention(
    { ...settings.RETENTION_DEFAULTS },
    { sessionDays: -5, keepSessions: 0, artifactDays: 99999, keepArtifacts: 12.6 },
  );
  assert.equal(policy.sessionDays, 0);
  assert.equal(policy.keepSessions, 1);
  assert.equal(policy.artifactDays, 3650);
  assert.equal(policy.keepArtifacts, 13);
});

console.log(`\nretention: ${passed} passed`);
