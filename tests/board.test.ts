/**
 * The task board: the plan the person watches instead of reading.
 *
 * Everything here is about the two ways a board can lie -- a card that never
 * moves while the work does, and a card moved onto the wrong thing -- so the
 * cases are the refusals as much as the writes: an ambiguous title, a status
 * nobody recognises, an action that does not exist. The write is always the
 * whole board, which is the property that keeps the agent's tool and the
 * page's drag from overwriting each other.
 *
 *   npx tsx tests/board.test.ts
 */
import assert from "node:assert/strict";

const board = await import("../server/board");
const { applyBoard, describeBoard, latestBoard, statusOf, emptyBoard } = board;

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

/** A planned board, written the way the agent writes one. */
const planned = (...titles: string[]) => {
  const result = applyBoard(null, { action: "plan", title: "Release", tasks: titles });
  assert.equal(result.ok, true, result.summary);
  return result.board!;
};

test("a plan makes one card per step, in order, all in To do", () => {
  const b = planned("Bump the version", "Run the gate", "Push and offer");
  assert.equal(b.title, "Release");
  assert.deepEqual(b.tasks.map((t) => t.id), ["t1", "t2", "t3"]);
  assert.deepEqual(b.tasks.map((t) => t.title), ["Bump the version", "Run the gate", "Push and offer"]);
  assert.deepEqual(b.tasks.map((t) => t.status), ["todo", "todo", "todo"]);
});

test("a plan keeps the order it was written in, which is the order it is done in", () => {
  const b = planned("first", "second", "third");
  const moved = applyBoard(b, { action: "move", task: "t2", status: "doing" });
  assert.equal(moved.ok, true, moved.summary);
  assert.equal(moved.board!.tasks[1].status, "doing");
  assert.equal(moved.board!.tasks[0].status, "todo");
});

test("a plan may say where a card starts -- half a plan is what it is", () => {
  const b = applyBoard(null, {
    action: "plan",
    tasks: [{ title: "already doing this", status: "in progress" }, "and this next"],
  }).board!;
  assert.equal(b.tasks[0].status, "doing");
  assert.equal(b.tasks[1].status, "todo");
});

test("the statuses people actually type are understood", () => {
  assert.equal(statusOf("To Do"), "todo");
  assert.equal(statusOf("in_progress"), "doing");
  assert.equal(statusOf("working on it"), "doing");
  assert.equal(statusOf("Completed"), "done");
  assert.equal(statusOf("shipped"), "done");
  assert.equal(statusOf("someday"), null);
  assert.equal(statusOf(""), null);
});

test("starting a card puts it in Doing and makes it the one being worked on", () => {
  const moved = applyBoard(planned("Read the inbox", "Draft the reply"), {
    action: "move", task: "t1", status: "doing",
  });
  assert.equal(moved.ok, true, moved.summary);
  assert.equal(moved.board!.activeTaskId, "t1");
});

test("finishing a card moves it to Done and stops it being the active one", () => {
  let b = planned("Read the inbox", "Draft the reply");
  b = applyBoard(b, { action: "move", task: "t1", status: "doing" }).board!;
  b = applyBoard(b, { action: "move", task: "t1", status: "done" }).board!;
  assert.equal(b.tasks[0].status, "done");
  assert.equal(b.activeTaskId, null);
});

test("a card can be named by its title instead of its id", () => {
  const moved = applyBoard(planned("Pull the attachment", "Send it"), {
    action: "move", task: "Send it", status: "done",
  });
  assert.equal(moved.ok, true, moved.summary);
  assert.equal(moved.board!.tasks[1].status, "done");
});

test("a card can be named by part of its title, when that picks out one card", () => {
  const moved = applyBoard(planned("Pull the attachment", "Send it"), {
    action: "move", task: "attachment", status: "doing",
  });
  assert.equal(moved.ok, true, moved.summary);
  assert.equal(moved.board!.tasks[0].status, "doing");
});

test("part of a title that fits two cards is refused, not guessed", () => {
  const result = applyBoard(planned("Read the email", "Send the email"), {
    action: "move", task: "email", status: "done",
  });
  assert.equal(result.ok, false);
  assert.match(result.summary, /matches 2 cards/);
  assert.match(result.summary, /t1/);
  assert.match(result.summary, /t2/);
});

test("moving a card that is not on the board is refused, and lists what is", () => {
  const result = applyBoard(planned("Read the email"), { action: "move", task: "t9", status: "done" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /no card called "t9"/);
  assert.match(result.summary, /Read the email/);
});

test("a move with no card named is refused, and says what a card looks like", () => {
  const result = applyBoard(planned("Read the email"), { action: "move", status: "done" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /Name the card/);
});

test("a move with no status is refused, and names the three there are", () => {
  const result = applyBoard(planned("Read the email"), { action: "move", task: "t1" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /todo, doing or done/);
});

test("a status nobody recognises is refused rather than silently ignored", () => {
  const result = applyBoard(planned("Read the email"), { action: "move", task: "t1", status: "nearly" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /todo, doing or done/);
});

test("an action nobody recognises is refused, and lists the ones that work", () => {
  const result = applyBoard(planned("Read the email"), { action: "delete everything" });
  assert.equal(result.ok, false);
  assert.match(result.summary, /Unknown action/);
  assert.match(result.summary, /plan/);
});

test("a note goes on the card, so the board carries the outcome too", () => {
  const result = applyBoard(planned("Check the invoice"), {
    action: "note", task: "t1", notes: "GBP 240, due Friday",
  });
  assert.equal(result.ok, true, result.summary);
  assert.equal(result.board!.tasks[0].notes, "GBP 240, due Friday");
  assert.match(describeBoard(result.board!), /GBP 240, due Friday/);
});

test("a card added later goes to the end of its column with a fresh id", () => {
  const result = applyBoard(planned("one", "two"), { action: "add", task: "three" });
  assert.equal(result.ok, true, result.summary);
  assert.deepEqual(result.board!.tasks.map((t) => t.id), ["t1", "t2", "t3"]);
  assert.equal(result.board!.tasks[2].status, "todo");
});

test("an add with no title is refused, because a blank card says nothing", () => {
  const result = applyBoard(planned("one"), { action: "add", task: "   " });
  assert.equal(result.ok, false);
  assert.match(result.summary, /needs a title/);
});

test("a plan with no cards is refused, and says how to pass them", () => {
  const result = applyBoard(null, { action: "plan", tasks: [] });
  assert.equal(result.ok, false);
  assert.match(result.summary, /needs its cards/);
});

test("the whole board comes back on every write -- that is what keeps two writers honest", () => {
  const b = planned("one", "two", "three");
  const moved = applyBoard(b, { action: "move", task: "two", status: "doing" });
  assert.equal(moved.board!.tasks.length, 3, "a move is not allowed to drop the other cards");
  assert.equal(moved.board!.id, b.id);
  assert.equal(moved.board!.title, b.title);
});

test("a board is read back out of the session's own events, newest first", () => {
  const events = [
    { kind: "reply", payload: { text: "hello" } },
    { kind: "kanban.update", payload: { id: "board-main", title: "Plan", tasks: [{ id: "t1", title: "one", status: "todo" }] } },
    { kind: "kanban.update", payload: { id: "board-main", title: "Plan", tasks: [{ id: "t1", title: "one", status: "done" }] } },
  ];
  const b = latestBoard(events);
  assert.ok(b);
  assert.equal(b!.tasks[0].status, "done");
});

test("a session with no board has no board, rather than an empty one", () => {
  assert.equal(latestBoard([{ kind: "reply", payload: {} }]), null);
  assert.equal(latestBoard([]), null);
});

test("reading a board with nothing on it is an answer, not an error", () => {
  const result = applyBoard(emptyBoard("Plan"), { action: "show" });
  assert.equal(result.ok, true);
  assert.match(result.summary, /Nothing on it yet/);
});

test("the board as the agent reads it counts the columns", () => {
  let b = planned("one", "two", "three");
  b = applyBoard(b, { action: "move", task: "t1", status: "done" }).board!;
  b = applyBoard(b, { action: "move", task: "t2", status: "doing" }).board!;
  const text = describeBoard(b);
  assert.match(text, /3 cards \(1 to do, 1 doing, 1 done\)/);
  assert.match(text, /To do:/);
  assert.match(text, /Doing:/);
  assert.match(text, /Done:/);
});

test("clearing takes the cards off and leaves the board standing", () => {
  const result = applyBoard(planned("one", "two"), { action: "clear" });
  assert.equal(result.ok, true);
  assert.deepEqual(result.board!.tasks, []);
  assert.equal(result.board!.title, "Release");
});

/* The other half of the wire: the event the server writes is what the page
   folds into a cell. Without this the board could be written perfectly and
   still never drawn -- which is exactly how it stood before, with every part
   of it present and nothing joining them. */
const { derive } = await import("../src/lib/derive");
const { Kind } = await import("../src/lib/types");

test("a kanban.update event becomes the board the page draws", () => {
  const at = (seq: number, kind: string, payload: Record<string, any>) =>
    ({ seq, ts: 1_700_000_000 + seq, kind, actor: "agent", span: null, payload, blob: null }) as any;
  const view = derive([
    at(1, Kind.SessionStarted, { title: "Email" }),
    at(2, Kind.UserMessage, { text: "Check my email and draft a reply" }),
    at(3, Kind.KanbanUpdate, {
      id: "board-main",
      title: "Email",
      autonomous: true,
      tasks: [
        { id: "t1", title: "Read the inbox", status: "done" },
        { id: "t2", title: "Draft the reply", status: "doing" },
      ],
    }),
  ]);
  const cells = view.buckets.flatMap((b) => b.cells).filter((c) => c.kind === "kanban");
  assert.equal(cells.length, 1, "one board on the page");
  const cell = cells[0] as Extract<typeof cells[number], { kind: "kanban" }>;
  assert.equal(cell.board.title, "Email");
  assert.deepEqual(cell.board.tasks.map((t) => `${t.id}:${t.status}`), ["t1:done", "t2:doing"]);
});

test("a second kanban.update moves the cards on the board already drawn", () => {
  const at = (seq: number, kind: string, payload: Record<string, any>) =>
    ({ seq, ts: 1_700_000_000 + seq, kind, actor: "agent", span: null, payload, blob: null }) as any;
  const first = { id: "board-main", title: "Email", tasks: [{ id: "t1", title: "Read the inbox", status: "doing" }] };
  const second = { id: "board-main", title: "Email", tasks: [{ id: "t1", title: "Read the inbox", status: "done" }] };
  const view = derive([
    at(1, Kind.SessionStarted, { title: "Email" }),
    at(2, Kind.UserMessage, { text: "Check my email" }),
    at(3, Kind.KanbanUpdate, first),
    at(4, Kind.KanbanUpdate, second),
  ]);
  const cells = view.buckets.flatMap((b) => b.cells).filter((c) => c.kind === "kanban");
  assert.equal(cells.length, 1, "moving a card updates the board rather than adding another");
  assert.equal((cells[0] as any).board.tasks[0].status, "done");
});

console.log(`\n${passed} board cases passed.`);
