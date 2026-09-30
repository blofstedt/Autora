/**
 * The to-do list: the plan the person watches instead of reading.
 *
 * The write is always the whole list, so the cases are about what the model
 * may say and what it is told back: statuses in its own words, refusals that
 * name the three that work, a list read back out of the session's events
 * (including one recorded as a board, before the to-do list existed).
 *
 *   npx tsx tests/todos.test.ts
 */
import assert from "node:assert/strict";

const { applyTodos, describeTodos, latestTodos, statusOf, readItems } = await import("../server/todos");

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

test("statuses in the model's own words map onto the three", () => {
  for (const w of ["todo", "pending", "Not started", "not_started"]) assert.equal(statusOf(w), "not-started", w);
  for (const w of ["doing", "In progress", "in_progress", "working on it"]) assert.equal(statusOf(w), "in-progress", w);
  for (const w of ["done", "complete", "Completed", "finished"]) assert.equal(statusOf(w), "completed", w);
  assert.equal(statusOf("blocked"), null);
  assert.equal(statusOf(""), null);
});

test("the whole list is written; strings are items that have not started", () => {
  const r = applyTodos(null, { todos: ["Read", { title: "Write", status: "doing" }, { title: "Send", status: "done" }] });
  assert.ok(r.ok);
  assert.deepEqual(r.list!.items.map((i) => [i.id, i.title, i.status]), [
    ["1", "Read", "not-started"], ["2", "Write", "in-progress"], ["3", "Send", "completed"],
  ]);
  assert.equal(r.preview, "1 of 3 done");
  assert.match(r.summary, /\[~\] 2\. Write/);
});

test("a second write replaces the first", () => {
  const first = applyTodos(null, { todos: ["a", "b", "c"] }).list!;
  const second = applyTodos(first, { todos: ["a", "b"] });
  assert.equal(second.list!.items.length, 2);
});

test("a status nobody recognises is refused, with the three that work", () => {
  const r = applyTodos(null, { todos: [{ title: "x", status: "blocked" }] });
  assert.equal(r.ok, false);
  assert.match(r.summary, /not-started, in-progress or completed/);
  assert.equal(r.list, undefined);
});

test("untitled items are dropped; a list of nothing is refused", () => {
  assert.equal(applyTodos(null, { todos: [{ title: "  " }, ""] }).ok, false);
  assert.deepEqual(readItems(["a", " ", { title: "b" }]).map((i) => i.id), ["1", "2"]);
});

test("more than one in progress is kept but the model is told", () => {
  const r = applyTodos(null, { todos: [{ title: "a", status: "doing" }, { title: "b", status: "doing" }] });
  assert.ok(r.ok);
  assert.equal(r.list!.items.length, 2);
  assert.match(r.summary, /one in progress at a time/);
});

test("no arguments reads it back; an empty list or clear empties it", () => {
  const cur = applyTodos(null, { todos: ["a", "b"] }).list!;
  const read = applyTodos(cur, {});
  assert.ok(read.ok && !read.list);
  assert.match(read.summary, /0 of 2 done/);
  assert.deepEqual(applyTodos(cur, { todos: [] }).list, { items: [] });
  assert.deepEqual(applyTodos(cur, { clear: true }).list, { items: [] });
  assert.match(applyTodos(null, {}).summary, /empty/);
});

test("a non-list is refused, and the list is capped and titles cut", () => {
  assert.equal(applyTodos(null, { todos: "do it" }).ok, false);
  const big = applyTodos(null, { todos: Array.from({ length: 80 }, (_, i) => `item ${i}`) });
  assert.equal(big.list!.items.length, 40);
  assert.equal(readItems(["x".repeat(900)])[0].title.length, 200);
});

test("the list is read back out of the events: the last one wins", () => {
  const events = [
    { kind: "todo.update", payload: { items: [{ title: "a", status: "not-started" }] } },
    { kind: "reply", payload: {} },
    { kind: "todo.update", payload: { items: [{ title: "a", status: "completed" }, { title: "b" }] } },
  ];
  const list = latestTodos(events)!;
  assert.deepEqual(list.items.map((i) => i.status), ["completed", "not-started"]);
  assert.equal(latestTodos([{ kind: "reply", payload: {} }]), null);
});

test("a session recorded with a board still has its plan", () => {
  const list = latestTodos([{ kind: "kanban.update", payload: { tasks: [
    { id: "t1", title: "Read", status: "done" }, { id: "t2", title: "Send", status: "doing" }, { id: "t3", title: "Log" }] } }])!;
  assert.deepEqual(list.items.map((i) => i.status), ["completed", "in-progress", "not-started"]);
});

test("describeTodos is a checklist", () => {
  assert.equal(describeTodos({ items: [] }), "The to-do list is empty.");
  assert.match(describeTodos({ items: [{ id: "1", title: "a", status: "completed" }] }), /1 of 1 done[\s\S]*\[x\] 1\. a/);
});

console.log(`\n${passed} passed`);
