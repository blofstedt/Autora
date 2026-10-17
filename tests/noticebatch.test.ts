/**
 * A task that ran several times while the person was away is one card.
 *
 *   npx tsx tests/noticebatch.test.ts
 */
import assert from "node:assert/strict";
import { batchNotices, type Notice } from "../src/lib/noticeBatch";

const at = (id: number, title: string, ts: number, extra: Partial<Notice> = {}): Notice =>
  ({ id, ts, tone: "ok", title, detail: `run ${id}`, session: `s${id}`, ...extra });

console.log("notice batching");

const base = Math.floor(new Date(2026, 9, 17, 9, 0).getTime() / 1000);

assert.deepEqual(batchNotices([]), []);
console.log("  ok  nothing in, nothing out");

const lone = at(1, "Digest finished", base);
assert.deepEqual(batchNotices([lone]), [lone]);
console.log("  ok  a lone notice is untouched");

const five = [0, 1, 2, 3, 4].map((i) => at(i + 1, "Digest finished", base + i * 600));
const [one] = batchNotices(five);
assert.equal(batchNotices(five).length, 1);
assert.equal(one.title, "Digest finished ×5");
assert.equal(one.id, 5);
assert.equal(one.session, "s5");
assert.match(one.detail, /^Ran 5× from .+ to .+\. Latest: run 5$/);
console.log("  ok  five runs of one task are one card for the newest run");

const mixed = batchNotices([
  at(1, "A finished", base), at(2, "B finished", base + 1), at(3, "A finished", base + 2),
  at(4, "A finished", base + 3, { tone: "error" }),
]);
assert.deepEqual(mixed.map((n) => n.title), ["A finished ×2", "B finished", "A finished"]);
console.log("  ok  other tasks and other outcomes stay separate, in first-seen order");

const days = batchNotices([at(1, "X finished", base), at(2, "X finished", base + 86_400)])[0];
assert.match(days.detail, /\d.*from .*\d.* to .*\d/);
console.log("  ok  runs on different days say the day");
