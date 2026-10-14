/**
 * Which tools the model is shown, and when a specialist set comes in.
 *
 *   npx tsx tests/toolload.test.ts
 */
import assert from "node:assert/strict";
import { FAMILIES, loadedFamilies, loadedFromLog, mcpServerOf, preloadMcp, searchMcp, shortName, signatureOf, unloadedIndex, withoutUnloaded } from "../server/toolload";

let passed = 0;
function test(name: string, fn: () => void) {
  try { fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}
const ev = (kind: string, payload: Record<string, any> = {}) => ({ kind, payload });
const names = (...n: string[]) => n.map((name) => ({ name }));
const all = names("terminal", "pdf_edit", "pdf_read", "widget_show", "mcp_offer", "schedule", "pre_authorise", "notebook", "browser_open");

console.log("tool loading");

const mcp = [
  { name: "mcp__google__drive_search", description: "Search files and folders in Google Drive by name or content." },
  { name: "mcp__google__drive_get_file", description: "Read a file from Google Drive." },
  { name: "mcp__google__gmail_send", description: "Send an email from the user's Gmail account." },
  { name: "mcp__google__calendar_create_event", description: "Create an event on the user's Google Calendar." },
  { name: "mcp__github__create_issue", description: "Create an issue in a GitHub repository." },
  { name: "mcp__github__list_pull_requests", description: "List pull requests in a GitHub repository." },
  { name: "mcp__home_assistant__light_on", description: "Turn a light on." },
];
const none = new Set<string>();

test("a message brings in the connected tools it is about, and only those", () => {
  assert.deepEqual(preloadMcp(mcp, "fix the failing test", none), []);
  assert.deepEqual(preloadMcp(mcp, "find the budget file in my drive", none).sort(),
    ["mcp__google__drive_get_file", "mcp__google__drive_search"]);
  assert.ok(preloadMcp(mcp, "send an email to Sam", none).includes("mcp__google__gmail_send"));
  assert.ok(preloadMcp(mcp, "put a meeting on my calendar", none).includes("mcp__google__calendar_create_event"));
  // an action word alone ("create", "list") says nothing about which tool
  assert.deepEqual(preloadMcp(mcp, "create a list", none), []);
});

test("a small server named outright comes in whole, and nothing loaded comes twice", () => {
  assert.deepEqual(preloadMcp(mcp, "turn it on with home assistant", none), ["mcp__home_assistant__light_on"]);
  assert.deepEqual(preloadMcp(mcp, "turn it on with home assistant", new Set(["mcpt:mcp__home_assistant__light_on"])), []);
  assert.deepEqual(preloadMcp(mcp, "anything about drive or github", new Set(["mcp:*"])), []);
});

test("one message loads a handful of tools, not a server's hundred", () => {
  const big = Array.from({ length: 110 }, (_, i) => ({ name: `mcp__google__doc_${i}`, description: "Work with a Google doc." }));
  assert.ok(preloadMcp(big, "edit my google doc", none).length <= 12);
});

test("tools_enable's query finds tools across servers", () => {
  assert.equal(searchMcp(mcp, "pull requests on github")[0].name, "mcp__github__list_pull_requests");
  assert.deepEqual(searchMcp(mcp, "zebra"), []);
});

test("the log carries which tools were loaded: asked for, preloaded or used", () => {
  const tools = names("terminal", "mcp__google__drive_search", "mcp__google__gmail_send", "mcp__github__create_issue");
  const shown = (events: any[]) => withoutUnloaded(tools, loadedFamilies({ events, lazy: true })).map((t) => t.name);
  assert.deepEqual(shown([]), ["terminal"]);
  assert.deepEqual(shown([ev("tools.enable", { tools: ["mcp__google__drive_search"] })]), ["terminal", "mcp__google__drive_search"]);
  assert.deepEqual(shown([ev("tool.call", { name: "mcp__github__create_issue" })]), ["terminal", "mcp__github__create_issue"]);
  assert.deepEqual(shown([ev("tools.enable", { family: "mcp:google" })]), ["terminal", "mcp__google__drive_search", "mcp__google__gmail_send"]);
  assert.equal(withoutUnloaded(tools, new Set(["mcp:*"])).length, tools.length, "the escape hatch brings every server in");
  assert.equal(mcpServerOf("mcp__home_assistant__light_on"), "home_assistant");
  assert.equal(shortName("mcp__home_assistant__light_on"), "light_on");
  assert.equal(mcpServerOf("terminal"), null);
});

test("a tool's signature shows its arguments, the required ones starred", () => {
  const line = signatureOf({ name: "mcp__g__send", description: "Send a mail. Extra words.", parameters: { properties: { to: { type: "string" }, kind: { enum: ["a", "b"] } }, required: ["to"] } });
  assert.equal(line, "mcp__g__send(to*: string, kind: a|b) -- Send a mail.");
});

test("the index lists unloaded connected tools by name, compactly, and drops them once loaded", () => {
  const index = unloadedIndex(new Set(FAMILIES.map((f) => f.id)), mcp)!;
  assert.match(index, /- google \(4\): drive_search, drive_get_file, gmail_send, calendar_create_event/);
  assert.doesNotMatch(index, /mcp__google__drive_search/, "short names, not full ones");
  const part = unloadedIndex(new Set([...FAMILIES.map((f) => f.id), "mcp:google", "mcpt:mcp__github__create_issue"]), mcp)!;
  assert.doesNotMatch(part, /google/);
  assert.match(part, /- github \(1\): list_pull_requests/);
  assert.equal(unloadedIndex(new Set([...FAMILIES.map((f) => f.id), "mcp:*"]), mcp), null);
  const huge = Array.from({ length: 300 }, (_, i) => ({ name: `mcp__big__t${i}`, description: "x" }));
  assert.match(unloadedIndex(new Set(FAMILIES.map((f) => f.id)), huge)!, /and \d+ more/);
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
