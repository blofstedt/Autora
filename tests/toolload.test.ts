/**
 * Which tools the model is shown, and when a specialist set comes in.
 *
 *   npx tsx tests/toolload.test.ts
 */
import assert from "node:assert/strict";
import { FAMILIES, loadedFamilies, loadedFromLog, mcpServerOf, unloadedIndex, withoutUnloaded } from "../server/toolload";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const ev = (kind: string, payload: Record<string, any> = {}) => ({ kind, payload });
const names = (...n: string[]) => n.map((name) => ({ name }));
const all = names("terminal", "pdf_edit", "pdf_read", "widget_show", "mcp_offer", "schedule", "pre_authorise", "notebook", "browser_open");

console.log("tool loading");

test("an MCP server's tools stay out until it is named, used or asked for", () => {
  const tools = names("terminal", "mcp__google__drive_search", "mcp__google__gmail_send", "mcp__home_assistant__light_on", "mcp__github__create_issue");
  const servers = ["google", "home_assistant", "github"];
  const shown = (said: string, events: any[] = []) =>
    withoutUnloaded(tools, loadedFamilies({ events, said, lazy: true, mcpServers: servers })).map((t) => t.name);
  assert.deepEqual(shown("fix the failing test"), ["terminal"]);
  assert.deepEqual(shown("open an issue on GitHub"), ["terminal", "mcp__github__create_issue"]);
  assert.deepEqual(shown("turn on the light with home assistant"), ["terminal", "mcp__home_assistant__light_on"]);
  assert.deepEqual(shown("hello", [ev("tool.call", { name: "mcp__google__drive_search" })]),
    ["terminal", "mcp__google__drive_search", "mcp__google__gmail_send"]);
  assert.deepEqual(shown("hello", [ev("tools.enable", { family: "mcp:github" })]), ["terminal", "mcp__github__create_issue"]);
  assert.equal(withoutUnloaded(tools, new Set(["mcp:*"])).length, tools.length, "the escape hatch brings every server in");
  assert.equal(mcpServerOf("mcp__home_assistant__light_on"), "home_assistant");
  assert.equal(mcpServerOf("terminal"), null);
});

test("the index names each unloaded MCP server and its size, and drops it once loaded", () => {
  const index = unloadedIndex(new Set(FAMILIES.map((f) => f.id)), [{ server: "google", tools: 110 }])!;
  assert.match(index, /mcp:google: the 110 tools/);
  assert.equal(unloadedIndex(new Set([...FAMILIES.map((f) => f.id), "mcp:google"]), [{ server: "google", tools: 110 }]), null);
});

test("a fresh chat is shown the core tools and not the specialist sets", () => {
  const shown = withoutUnloaded(all, loadedFamilies({ events: [], lazy: true })).map((t) => t.name);
  assert.deepEqual(shown, ["terminal", "browser_open"]);
});

test("the person's words bring a set in", () => {
  assert.ok(loadedFamilies({ events: [], said: "fill in this PDF form for me" , lazy: true}).has("pdf"));
  assert.ok(loadedFamilies({ events: [], said: "run this every morning" , lazy: true}).has("schedule"));
  assert.ok(loadedFamilies({ events: [], said: "make a chart of sales" , lazy: true}).has("widgets"));
  assert.equal(loadedFamilies({ events: [], said: "fix the failing test" , lazy: true}).size, 0);
});

test("a PDF in the chat brings the pdf set in, whatever was said", () => {
  assert.ok(loadedFamilies({ events: [], said: "ok", hasPdf: true, lazy: true }).has("pdf"));
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
