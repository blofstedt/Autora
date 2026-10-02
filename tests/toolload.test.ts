/**
 * Which tools the model is shown, and when a specialist set comes in.
 *
 *   npx tsx tests/toolload.test.ts
 */
import assert from "node:assert/strict";
import { FAMILIES, loadedFamilies, loadedFromLog, unloadedIndex, withoutUnloaded } from "../server/toolload";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const ev = (kind: string, payload: Record<string, any> = {}) => ({ kind, payload });
const names = (...n: string[]) => n.map((name) => ({ name }));
const all = names("terminal", "pdf_edit", "pdf_read", "widget_show", "mcp_offer", "schedule", "pre_authorise", "notebook", "browser_open");

console.log("tool loading");

test("a fresh chat is shown the core tools and not the specialist sets", () => {
  const shown = withoutUnloaded(all, loadedFamilies({ events: [] })).map((t) => t.name);
  assert.deepEqual(shown, ["terminal", "browser_open"]);
});

test("the person's words bring a set in", () => {
  assert.ok(loadedFamilies({ events: [], said: "fill in this PDF form for me" }).has("pdf"));
  assert.ok(loadedFamilies({ events: [], said: "run this every morning" }).has("schedule"));
  assert.ok(loadedFamilies({ events: [], said: "make a chart of sales" }).has("widgets"));
  assert.equal(loadedFamilies({ events: [], said: "fix the failing test" }).size, 0);
});

test("a PDF in the chat brings the pdf set in, whatever was said", () => {
  assert.ok(loadedFamilies({ events: [], said: "ok", hasPdf: true }).has("pdf"));
});

test("a set that was asked for or used stays", () => {
  const log = [ev("tools.enable", { family: "mcp" }), ev("tool.call", { name: "pdf_read" }), ev("tool.call", { name: "terminal" })];
  const l = loadedFromLog(log);
  assert.deepEqual([...l].sort(), ["mcp", "pdf"]);
  assert.deepEqual(withoutUnloaded(all, l).map((t) => t.name), ["terminal", "pdf_edit", "pdf_read", "mcp_offer", "browser_open"]);
});

test("the index names what is out, and is silent when everything is in", () => {
  const idx = unloadedIndex(new Set(["pdf"]))!;
  assert.match(idx, /tools_enable/);
  assert.match(idx, /- widgets:/);
  assert.ok(!/- pdf:/.test(idx));
  assert.equal(unloadedIndex(new Set(FAMILIES.map((f) => f.id))), null);
});

test("the escape hatch puts everything in", () => {
  assert.equal(withoutUnloaded(all, loadedFamilies({ events: [], all: true })).length, all.length);
});

console.log(`${passed} passed`);
