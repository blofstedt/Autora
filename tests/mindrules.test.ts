/**
 * The rules the mind is kept by: one topic per record, filed under a subject,
 * durable, and a reference that says where it was read and when.
 *
 *   npx tsx tests/mindrules.test.ts
 */
import assert from "node:assert/strict";
import {
  actsOnSite, checkEntry, checkSource, groundingRefusal, referenceFresh, subjectKey, tidyRecords,
  GROUNDING_REFUSALS, REFERENCE_FRESH_DAYS,
} from "../server/mindrules";
import type { MemoryRecord } from "../server/memory";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const DAY = 86400;
const NOW = 1_800_000_000;
const rec = (over: Partial<MemoryRecord>): MemoryRecord => ({
  id: "mem-a", kind: "fact", scope: "workspace", title: "t", body: "a body", tags: [], status: "confirmed", pinned: false,
  source_session: null, source_seq: null, created: NOW - 400 * DAY, updated: NOW - 400 * DAY, uses: 0, last_used: null, superseded_by: null,
  ...over,
});

console.log("mind rules");

test("a title is put under its subject, and a body that holds a secret is refused", () => {
  const ok = checkEntry({ title: "where repository settings are", body: "Top bar, Settings tab.", kind: "reference", subject: "GitHub", facet: "interface", source: "https://docs.github.com/en/repositories/managing-your-repositorys-settings-and-features" });
  assert.ok(ok.ok);
  if (ok.ok) {
    assert.equal(ok.entry.title, "GitHub: where repository settings are");
    assert.equal(ok.entry.subject, "github");
    assert.equal(ok.entry.status, "confirmed", "github.com is github's own site");
    assert.ok(ok.entry.tags.includes("interface") && ok.entry.tags.includes("github"));
  }
  const secret = checkEntry({ title: "Server login", body: "password: hunter2hunter2" });
  assert.ok(!secret.ok);
});

test("a body that is too long is sent back to be split, by the limit for its kind", () => {
  const v = checkEntry({ title: "Docker: things", body: "x".repeat(700), kind: "fact" });
  assert.ok(!v.ok);
  if (!v.ok) assert.match(v.error, /Too long for a fact \(700 characters; at most 600\).*split/);
  assert.ok(checkEntry({ title: "Docker: how", body: "y".repeat(1100), kind: "procedure" }).ok);
});

test("a note about the moment is not durable", () => {
  const v = checkEntry({ title: "Working", body: "I am working on the login page right now" });
  assert.ok(!v.ok);
  if (!v.ok) assert.match(v.error, /this conversation or this moment/);
  assert.ok(checkEntry({ title: "Backups", body: "Backups run at 03:00 to /mnt/backup." }).ok);
});

test("a reference needs a subject and a source it can use", () => {
  assert.match((checkEntry({ title: "x", body: "y", kind: "reference", source: "https://docs.stripe.com/api" }) as any).error, /needs a subject/);
  assert.match((checkEntry({ title: "x", body: "y", kind: "reference", subject: "stripe" }) as any).error, /needs its source/);
  assert.match((checkEntry({ title: "x", body: "y", kind: "reference", subject: "stripe", source: "not a url" }) as any).error, /address/);
  assert.match((checkEntry({ title: "x", body: "y", kind: "reference", subject: "stripe", source: "http://localhost:3000/docs" }) as any).error, /public web address/);
});

test("a reference from somebody else's site is kept, but unconfirmed", () => {
  const v = checkEntry({ title: "Stripe: refunds", body: "POST /v1/refunds", kind: "reference", subject: "stripe", source: "https://medium.com/@someone/stripe-refunds" });
  assert.ok(v.ok);
  if (v.ok) {
    assert.equal(v.entry.status, "provisional");
    assert.match(v.notes.join(" "), /does not read as stripe's own/);
  }
  assert.equal(checkSource("https://stackoverflow.com/q/1", "stackoverflow").official, false, "a forum is not its subject's word");
});

test("tracking noise is stripped from the source", () => {
  const s = checkSource("https://support.google.com/docs/answer/1?utm_source=x&hl=en#top", "google docs");
  assert.ok(s.ok);
  assert.equal(s.url, "https://support.google.com/docs/answer/1?hl=en");
  assert.equal(s.official, true);
});

test("old records are filed and tidied, and what needs judgment is listed", () => {
  const records = [
    rec({ id: "m1", title: "  Login   needs 2fa  ", tags: ["github.com", "learned"] }),
    rec({ id: "m2", title: "Long one", body: "z".repeat(900), tags: ["notes"] }),
    rec({ id: "m3", title: "Moment", body: "doing this right now", tags: ["x1"] }),
    rec({ id: "m4", kind: "reference", title: "Gmail: compose", subject: "gmail", body: "button", facet: "interface", updated: NOW - 100 * DAY }),
  ];
  const report = tidyRecords(records, NOW);
  assert.equal(records[0].subject, "github");
  assert.equal(records[0].title, "Github: Login needs 2fa");
  assert.ok(report.fixed.some((f) => f.id === "m1"));
  assert.ok(report.flagged.find((f) => f.id === "m2")!.problems.some((p) => /too long for a fact/.test(p)));
  assert.ok(report.flagged.find((f) => f.id === "m3")!.problems.some((p) => /moment/.test(p)));
  const m4 = report.flagged.find((f) => f.id === "m4")!.problems.join(" ");
  assert.match(m4, /no source/);
  assert.equal(report.total, 4);
});

test("a reference goes stale at the pace of its sort of knowledge", () => {
  const ref = (facet: any, days: number) => rec({ kind: "reference", facet, fetched: NOW - days * DAY, subject: "s", source: "https://s.com" });
  assert.ok(referenceFresh(ref("interface", REFERENCE_FRESH_DAYS.interface - 1), NOW));
  assert.ok(!referenceFresh(ref("interface", REFERENCE_FRESH_DAYS.interface + 1), NOW));
  assert.ok(referenceFresh(ref("docs", 60), NOW), "docs last longer than an interface");
  assert.ok(!referenceFresh(rec({ kind: "fact" }), NOW), "only references count");
});

test("only calls that act on a site are held for grounding, and only until it is learned or given up on", () => {
  assert.ok(actsOnSite("browser_click") && actsOnSite("browser_fill"));
  assert.ok(!actsOnSite("browser_open") && !actsOnSite("browser_read"));
  assert.ok(actsOnSite("http_request", { method: "POST" }) && !actsOnSite("http_request", { method: "get" }));
  const base = { enabled: true, site: "acme.com", fresh: false, stale: false, refused: 0 };
  const first = groundingRefusal(base)!;
  assert.match(first, /nothing is stored about how acme\.com works/);
  assert.match(first, /kind "reference", subject "acme"/);
  assert.match(groundingRefusal({ ...base, stale: true })!, /too long ago to trust/);
  assert.equal(groundingRefusal({ ...base, fresh: true }), null);
  assert.equal(groundingRefusal({ ...base, enabled: false }), null);
  assert.equal(groundingRefusal({ ...base, site: "" }), null, "localhost and addresses are not grounded");
  assert.match(groundingRefusal({ ...base, refused: GROUNDING_REFUSALS - 1 })!, /go ahead/);
  assert.equal(groundingRefusal({ ...base, refused: GROUNDING_REFUSALS }), null, "it cannot wedge a turn");
  assert.equal(subjectKey("  Google   Sheets! "), "google sheets");
});

console.log(`${passed} passed`);
