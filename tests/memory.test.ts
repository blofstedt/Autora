/**
 * The memory graph: recall by meaning, no near-copies, learned is not known
 * until confirmed, and housekeeping.
 *
 *   npx tsx tests/memory.test.ts
 */
import assert from "node:assert/strict";
import { MemoryGraph, similarity, tokens, type MemoryRecord } from "../server/memory";

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

function graph() {
  let saves = 0;
  const g = new MemoryGraph([], [], () => { saves += 1; });
  return { g, saves: () => saves };
}

console.log("memory");

test("words are compared without stop words or endings", () => {
  assert.deepEqual(tokens("Restarting the containers"), ["restart", "container"]);
  assert.ok(similarity("restart the docker containers", "restarting docker container") > 0.9);
});

test("recall ranks by the request, not by age or use", () => {
  const { g } = graph();
  const old = g.write({ title: "Backups go to the NAS", body: "The nightly backup writes to /mnt/nas/backups via rsync." }).record;
  old.uses = 50;
  g.write({ title: "Restart the media server", body: "docker restart jellyfin fixes a stuck library scan." });
  const hits = g.recall("jellyfin library scan is stuck again");
  assert.equal(hits[0].record.title, "Restart the media server");
  assert.ok(!hits.some((h) => h.record === old), "an unrelated memory is not recalled for its use count");
  assert.match(hits[0].reason, /matched/);
});

test("pinned memories are always recalled, and say why", () => {
  const { g } = graph();
  const pin = g.write({ title: "Answer in British English", body: "Colour, not color.", kind: "preference" }).record;
  g.update(pin.id, { pinned: true });
  const hits = g.recall("what is the weather");
  assert.equal(hits.length, 1);
  assert.match(hits[0].reason, /pinned/);
  assert.equal(g.recall("what is the weather", 6, false).length, 0);
});

test("writing a near-copy updates the original", () => {
  const { g } = graph();
  const first = g.write({ title: "Media server restart", body: "docker restart jellyfin", kind: "procedure" });
  const again = g.write({ title: "Media server restart", body: "docker restart jellyfin && docker logs jellyfin", kind: "procedure" });
  assert.equal(first.action, "added");
  assert.equal(again.action, "merged");
  assert.equal(g.records.length, 1);
  assert.match(g.records[0].body, /docker logs/);
});

test("a learned rewrite of a confirmed memory waits to be kept", () => {
  const { g } = graph();
  const known = g.write({ title: "Backup location", body: "Backups are written to /mnt/nas/backups every night at 3.", kind: "fact" }).record;
  const learned = g.write({
    title: "Backup location", body: "Backups moved to /mnt/usb/backups; the NAS share is gone.", kind: "fact", status: "provisional",
  });
  assert.equal(learned.action, "proposed");
  assert.equal(learned.record.replaces, known.id);
  assert.equal(known.superseded_by, null, "the confirmed one stands until the rewrite is kept");
  g.confirm(learned.record.id);
  assert.equal(known.superseded_by, learned.record.id);
  assert.deepEqual(g.active().map((r) => r.id), [learned.record.id]);
});

test("learning the same thing again counts as it having worked", () => {
  const { g } = graph();
  const known = g.write({ title: "Restart jellyfin", body: "docker restart jellyfin fixes a stuck scan", kind: "procedure" }).record;
  const again = g.write({ title: "Restart jellyfin", body: "docker restart jellyfin fixes a stuck scan", kind: "procedure", status: "provisional" });
  assert.equal(again.action, "reinforced");
  assert.equal(known.worked, 1);
  assert.equal(g.records.length, 1);
});

test("an unconfirmed memory that keeps working is confirmed, and a procedure promoted", () => {
  const { g } = graph();
  const r = g.write({ title: "Clear the cache", body: "rm -rf ~/.cache/app then restart it", kind: "procedure", status: "provisional" }).record;
  assert.equal(g.reinforce(r.id), null);
  assert.equal(g.reinforce(r.id), "confirmed");
  assert.equal(r.status, "confirmed");
  assert.ok(!r.tags.includes("learned"));
  assert.equal(g.reinforce(r.id), "promoted");
  assert.ok(r.tags.includes("proven"));
  assert.equal(r.pinned, false, "proven is not pinned: it is recalled only when it is relevant");
  assert.equal(g.recall("what is the weather in paris").length, 0);
  assert.equal(g.recall("the app cache is broken, clear it")[0]?.record.id, r.id);
});

test("an unrelated skill is not recalled for sharing one word", () => {
  const { g } = graph();
  g.write({
    title: "Deploy the blog", kind: "procedure", tags: ["skill"],
    body: "Build the site, copy the files to the server over rsync, then purge the CDN cache.",
  });
  const rename = g.write({ title: "Rename photos by date", kind: "procedure", tags: ["skill", "photos"],
    body: "exiftool '-FileName<DateTimeOriginal' renames every photo in the folder." }).record;
  assert.equal(g.recall("move these files into a folder on the desktop please").some((h) => h.record.title === "Deploy the blog"), false);
  assert.equal(g.recall("which skill do i have").length, 0, "the bookkeeping tag matches nothing");
  assert.equal(g.recall("rename my photos")[0]?.record.id, rename.id);
});

test("procedures pinned by the old promotion are unpinned on load", () => {
  const base = { scope: "workspace", status: "confirmed" as const, source_session: null, source_seq: null, uses: 3, last_used: null, superseded_by: null, created: 1, updated: 1 };
  const records: MemoryRecord[] = [
    { ...base, id: "p", kind: "procedure", title: "Clear the cache", body: "rm -rf ~/.cache/app", tags: ["proven"], pinned: true },
    { ...base, id: "q", kind: "preference", title: "British English", body: "Colour", tags: [], pinned: true },
  ];
  const g = new MemoryGraph(records, []);
  assert.equal(g.get("p")?.pinned, false);
  assert.equal(g.get("q")?.pinned, true, "what the person pinned stays pinned");
});

test("new memories are linked to related ones", () => {
  const { g } = graph();
  const a = g.write({ title: "Jellyfin runs in docker", body: "The jellyfin container serves the media library.", tags: ["jellyfin"] }).record;
  const b = g.write({ title: "Jellyfin library path", body: "The media library for jellyfin is /mnt/media.", tags: ["jellyfin"] }).record;
  assert.ok(g.links.some((l) => l.src === b.id && l.dst === a.id));
});

test("forgetting removes a memory and its links; replacing keeps history", () => {
  const { g } = graph();
  const a = g.write({ title: "Old router address", body: "The router is at 192.168.1.1 on the admin page", tags: ["router"] }).record;
  const b = g.write({ title: "New router address", body: "The router is at 10.0.0.1 on the admin page", tags: ["router"] }).record;
  g.forget(a.id, b.id);
  assert.equal(a.superseded_by, b.id);
  g.forget(b.id);
  assert.equal(g.get(b.id), undefined);
  assert.ok(!g.links.some((l) => l.src === b.id || l.dst === b.id));
});

test("housekeeping merges copies and drops stale unconfirmed guesses", () => {
  const records: MemoryRecord[] = [];
  const g = new MemoryGraph(records, []);
  const base = { scope: "workspace", tags: [], status: "confirmed" as const, pinned: false, source_session: null, source_seq: null, uses: 1, last_used: null, superseded_by: null };
  records.push(
    { ...base, id: "a", kind: "fact", title: "Printer IP", body: "The office printer is at 10.0.0.9", created: 1, updated: 1 },
    { ...base, id: "b", kind: "fact", title: "Printer IP", body: "The office printer is at 10.0.0.9", created: 2, updated: 2 },
    { ...base, id: "c", kind: "fact", title: "A guess", body: "Something learned once and never used", status: "provisional", uses: 0, created: 0, updated: 0 },
  );
  const out = g.consolidate(60 * 24 * 3600);
  assert.equal(out.merged, 1);
  assert.equal(out.dropped, 1);
  assert.equal(g.get("a")?.superseded_by, "b");
  assert.equal(g.get("c"), undefined);
});

console.log(`${passed} passed`);
