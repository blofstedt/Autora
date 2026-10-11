/**
 * The few words beside the agent's cursor are made from the act itself, short, and only for acts with something to say.
 *
 *   npx tsx tests/thought.test.ts
 */
import assert from "node:assert/strict";
import { MAX, liveTool, thoughtForTool, thoughtFromAction } from "../src/lib/thought";
import { Kind, type AutoraEvent } from "../src/lib/types";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

test("the browser's own description of a click, fill or page becomes the thought", () => {
  assert.equal(thoughtFromAction('click [4] button "Add to cart"'), "Clicking “Add to cart”");
  assert.equal(thoughtFromAction("click [4] link"), "Clicking the link");
  assert.equal(thoughtFromAction('fill [7] "Email address"'), "Filling in “Email address”");
  assert.equal(thoughtFromAction("open https://www.example.com/a/b?q=1"), "Opening example.com");
  assert.equal(thoughtFromAction("press Enter"), "Pressing Enter");
  assert.equal(thoughtFromAction("submit"), "Sending the form");
  assert.equal(thoughtFromAction("click at 10,20"), "Clicking here");
  assert.equal(thoughtFromAction("back"), "Going back");
});

test("an act with nothing to say has no thought, rather than a made-up one", () => {
  assert.equal(thoughtFromAction("you opened a dropdown at 4,5"), null);
  assert.equal(thoughtFromAction("eval (clicked Save)"), null);
  assert.equal(thoughtForTool("memory_write", { title: "x" }), null);
  assert.equal(thoughtForTool("todo", {}), null);
  assert.equal(thoughtForTool("agents", {}), null);
});

test("tools in the windows say what they are doing, with the one detail that is true", () => {
  assert.equal(thoughtForTool("office_edit", { ops: [{}, {}, {}] }), "Making 3 changes");
  assert.equal(thoughtForTool("office_edit", { ops: [{}] }), "Making a change");
  assert.equal(thoughtForTool("pdf_look", { pages: 4 }), "Looking at page 4");
  assert.equal(thoughtForTool("browser_fill", { values: [{}, {}] }), "Filling in 2 fields");
  assert.equal(thoughtForTool("terminal", { command: "npm test\nrm x" }), "Running “npm test”");
  assert.equal(thoughtForTool("video_ui", { label: "Export" }), "Using “Export”");
  assert.equal(thoughtForTool("photo_edit", {}), "Editing the picture");
  assert.equal(thoughtForTool("studio_notes", {}), "Writing notes");
});

test("every thought is short enough to read while the cursor moves", () => {
  const long = "x".repeat(200);
  for (const t of [
    thoughtFromAction(`click [1] button "${long}"`), thoughtFromAction(`fill [1] "${long}"`), thoughtFromAction(`open https://${long}.example.com/`),
    thoughtForTool("web_search", { query: long }), thoughtForTool("terminal", { command: long }), thoughtForTool("video_ui", { label: long }),
  ]) assert.ok(t && t.length <= MAX + 12, `${t?.length}: ${t}`);
});

const ev = (seq: number, kind: string, payload: Record<string, any> = {}, span: string | null = null): AutoraEvent =>
  ({ seq, ts: seq, kind, actor: "agent", span, payload, blob: null });

test("the tool in flight is the one opened and not yet answered, in the turn now", () => {
  const events = [
    ev(1, Kind.UserMessage, { text: "go" }),
    ev(2, Kind.ToolCall, { name: "pdf_look", args: { pages: 2 } }, "a"),
    ev(3, Kind.ToolResult, { ok: true }, "a"),
    ev(4, Kind.ToolCall, { name: "pdf_edit", args: {} }, "b"),
  ];
  assert.equal(liveTool(events)?.name, "pdf_edit");
  assert.equal(liveTool([...events, ev(5, Kind.ToolResult, { ok: true }, "b")]), null, "answered: nothing in flight");
  assert.equal(liveTool([...events, ev(5, Kind.AgentDone)]), null, "the turn is over");
  assert.equal(liveTool([ev(1, Kind.ToolCall, { name: "pdf_edit" }, "z"), ev(2, Kind.UserMessage, {})]), null, "an earlier turn's call is history");
});

console.log(`${passed} passed`);
