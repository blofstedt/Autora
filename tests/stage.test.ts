/**
 * The pinned stage: which of the page, the plan and an explainer are held
 * above the thread on a phone. Each alone and every mix of them has to come
 * out as the same simple thing -- a list, at most one of a kind, in tab
 * order -- so the cases are the three kinds singly, together, and the ways
 * one stops being held (the page closes, the plan finishes, a turn passes).
 *
 *   npx tsx tests/stage.test.ts
 */
import assert from "node:assert/strict";
import type { Bucket, Cell } from "../src/lib/derive";
import { busiestSurface, dockedPlan, newestSurface, pickSurfaces } from "../src/lib/stage";

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

const page = (seq: number): Cell =>
  ({ kind: "screen", seq, source: "browser", url: "https://example.com", shots: [], actions: [], live: true, log: [] });
const desktop = (seq: number): Cell =>
  ({ kind: "screen", seq, source: "desktop", url: null, shots: [], actions: [], live: true, log: [] });
const plan = (seq: number, ...status: Array<"not-started" | "in-progress" | "completed">): Cell =>
  ({
    kind: "todo", seq,
    items: status.map((s, i) => ({ id: `${i + 1}`, title: `task ${i + 1}`, status: s })),
  });
const widget = (seq: number): Cell =>
  ({ kind: "widget", seq, widget: { seq, title: "Orbit", html: "<p/>", height: 300 } });
const reply = (seq: number): Cell =>
  ({ kind: "reply", seq, turn: { role: "assistant", text: "hi", seq } as any, memories: [] });
const turn = (...cells: Cell[]): Bucket => ({ seq: 1, cells, open: false } as unknown as Bucket);

const kinds = (buckets: Bucket[], live: number | null = null) =>
  pickSurfaces(buckets, live).map((s) => s.kind);

test("nothing to hold is an empty stage", () => {
  assert.deepEqual(kinds([turn(reply(1))]), []);
  assert.deepEqual(kinds([]), []);
});

test("each of the three, alone", () => {
  assert.deepEqual(kinds([turn(page(2))], 2), ["browser"]);
  assert.deepEqual(kinds([turn(plan(2, "not-started"))]), ["plan"]);
  assert.deepEqual(kinds([turn(widget(2))]), ["widget"]);
});

test("any two, and all three, come out in tab order however they arrived", () => {
  assert.deepEqual(kinds([turn(widget(2), page(3))], 3), ["browser", "widget"]);
  assert.deepEqual(kinds([turn(plan(2, "in-progress"), widget(3))]), ["plan", "widget"]);
  assert.deepEqual(kinds([turn(plan(2, "in-progress"), page(3))], 3), ["browser", "plan"]);
  assert.deepEqual(kinds([turn(widget(2), plan(3, "not-started"), page(4))], 4), ["browser", "plan", "widget"]);
});

test("a page is held only while it is the one that is open", () => {
  assert.deepEqual(kinds([turn(page(2))], null), []);
  assert.deepEqual(kinds([turn(page(2))], 9), []);
  assert.deepEqual(kinds([turn(page(2), page(5))], 5).length, 1);
});

test("a desktop card is not the page", () => {
  assert.deepEqual(kinds([turn(desktop(2))], 2), []);
});

test("the newest of a kind wins, and the older stays in the thread", () => {
  const picked = pickSurfaces([turn(widget(2), reply(3), widget(4))], null);
  assert.equal(picked.length, 1);
  assert.equal(picked[0].cell.seq, 4);
});

test("a plan still being worked stays held into later turns; a finished one does not", () => {
  const later = turn(reply(9));
  assert.deepEqual(kinds([turn(plan(2, "completed", "in-progress")), later]), ["plan"]);
  assert.deepEqual(kinds([turn(plan(2, "completed", "completed")), later]), []);
});

test("the plan docked above the message box: unfinished, or the latest turn's", () => {
  const later = turn(reply(9));
  assert.equal(dockedPlan([turn(plan(2, "completed", "in-progress")), later])?.seq, 2);
  assert.equal(dockedPlan([turn(plan(2, "completed", "completed")), later]), null);
  assert.equal(dockedPlan([turn(page(1), plan(2, "completed", "completed"))])?.seq, 2, "a finished one stays while its turn is the latest");
  assert.equal(dockedPlan([turn(page(1), widget(2))]), null);
});

test("a widget from an earlier turn is a record, not the pinned thing", () => {
  assert.deepEqual(kinds([turn(widget(2)), turn(reply(9))]), []);
});

test("with nothing picked, the tab that arrived last is up", () => {
  const surfaces = pickSurfaces([turn(page(2), plan(3, "not-started"), widget(4))], 2);
  assert.equal(newestSurface(surfaces)?.kind, "widget");
  const other = pickSurfaces([turn(widget(2), plan(3, "not-started"), page(4))], 4);
  assert.equal(newestSurface(other)?.kind, "browser");
  assert.equal(newestSurface([]), null);
});

test("a surface's key is the card's own, so the thread can leave exactly it out", () => {
  const [surface] = pickSurfaces([turn(widget(7))], null);
  assert.equal(surface.key, "widget-7");
});

test("following shows the surface the agent touched last, not the one that arrived last", () => {
  const board = { ...(plan(3, "in-progress", "not-started") as any), updated: 40 };
  const screen = { ...(page(2) as any), touched: 30 };
  const surfaces = pickSurfaces([turn(screen, board, widget(20))], 2);
  assert.equal(newestSurface(surfaces)?.kind, "widget");
  assert.equal(busiestSurface(surfaces)?.kind, "plan");
  const later = pickSurfaces([turn({ ...screen, touched: 50 }, board, widget(20))], 2);
  assert.equal(busiestSurface(later)?.kind, "browser");
  assert.equal(busiestSurface([]), null);
});

console.log(`\n${passed} stage cases passed.`);
