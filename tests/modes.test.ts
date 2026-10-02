/**
 * Chat modes: what stops to ask in Plan and Ask.
 *
 * The rule that has to hold is the safe way round: a tool is treated as a
 * change unless somebody listed it as looking only. So the cases are that the
 * list names real tools, that nothing marked risky is on it, that a method
 * decides for http_request, and that a tool nobody has heard of asks.
 *
 *   npx tsx tests/modes.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-modes-"));

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

async function main() {
  const m = await import("../server/modes");
  const { findTool } = await import("../server/tools");
  const client = await import("../src/lib/modes");
  const source = fs.readFileSync(path.resolve("server/modes.ts"), "utf8");
  const listed = [...(/const LOOKS_ONLY = new Set\(\[([\s\S]*?)\]\);/.exec(source)?.[1] ?? "").matchAll(/"([a-z_]+)"/g)].map((x) => x[1]);

  test("a mode nobody recognises is agent, so an old or edited file cannot strand a chat", () => {
    for (const bad of [undefined, null, "", "AUTO", "yolo", 7, {}]) assert.equal(m.workMode(bad), m.DEFAULT_WORK_MODE);
    for (const good of m.WORK_MODE_LIST) assert.equal(m.workMode(good), good);
    assert.equal(m.isWorkMode("plan"), true);
    assert.equal(m.isWorkMode("Plan"), false);
    assert.deepEqual(Object.keys(m.WORK_MODES).sort(), [...m.WORK_MODE_LIST].sort());
  });

  test("a chat from before this split keeps what it had: ask moves to the permission it was", () => {
    assert.equal(m.workMode("auto"), "agent");
    assert.equal(m.workMode("plan"), "plan");
    assert.equal(m.workMode("ask"), "build");
    assert.equal(m.legacyPermissions("ask"), "ask");
    assert.equal(m.legacyPermissions("auto"), "yolo");
    assert.equal(m.permissionsOf("nope"), "yolo");
    assert.equal(m.permissionsOf("ask"), "ask");
  });

  test("the looks-only list is not empty, and every name on it is a real tool", () => {
    assert.ok(listed.length > 10);
    for (const name of listed) assert.ok(findTool(name), `${name} is on the looks-only list but is not a tool`);
  });

  test("nothing marked risky is on the looks-only list, bar two decided ones", () => {
    const decided = new Set(["pre_authorisations", "memory_confirm"]);
    for (const name of listed) {
      if (decided.has(name)) continue;
      assert.ok(!findTool(name)?.risky, `${name} is risky and cannot be looks-only`);
    }
  });

  test("taking a standing agreement back is a change; listing them is not", () => {
    assert.equal(m.looksOnly("pre_authorisations", {}), true);
    assert.equal(m.looksOnly("pre_authorisations", { revoke: "" }), true);
    assert.equal(m.looksOnly("pre_authorisations", { revoke: "allow-m7x2k-abc" }), false);
    assert.equal(m.askAbout("ask", "", "pre_authorisations", { revoke: "allow-1" }), "hold");
    assert.equal(m.askAbout("ask", "", "pre_authorisations", {}), "skip");
  });

  test("http_request is judged on its method, in any case", () => {
    assert.equal(m.looksOnly("http_request", { method: "get" }), true);
    assert.equal(m.looksOnly("http_request", {}), true);
    assert.equal(m.looksOnly("http_request", { method: "HEAD" }), true);
    for (const method of ["POST", "put", "PATCH", "DELETE"]) assert.equal(m.looksOnly("http_request", { method }), false, method);
  });

  test("looking at the app window is looking; starting, reloading or stopping it is not", () => {
    assert.equal(m.looksOnly("app_preview", { action: "look" }), true);
    assert.equal(m.looksOnly("app_preview", { action: " LOOK " }), true);
    for (const action of ["start", "reload", "stop", ""]) assert.equal(m.looksOnly("app_preview", { action }), false, action);
    assert.equal(m.planRefusal("plan", undefined, "app_preview", { action: "look" }), null);
    assert.equal(m.askAbout("ask", "", "app_preview", { action: "start", command: "npm run dev" }), "hold");
  });

  test("reading and looking at a PDF is looking; extracting from it or changing it is not", () => {
    assert.equal(m.looksOnly("pdf_read", { file: "a.pdf", find: ["email"] }), true);
    assert.equal(m.looksOnly("pdf_look", { file: "a.pdf" }), true);
    assert.equal(m.looksOnly("pdf_read", { file: "a.pdf", extract: ["all"] }), false);
    assert.equal(m.looksOnly("pdf_read", { file: "a.pdf", extract: "xfa" }), false);
    for (const name of ["pdf_edit", "pdf_compose", "pdf_pages", "pdf_redact", "pdf_replace_text", "pdf_compress"]) {
      assert.equal(m.looksOnly(name, { file: "a.pdf" }), false, name);
      assert.ok(findTool(name), `${name} is a tool`);
    }
    assert.equal(m.planRefusal("plan", undefined, "pdf_read", { file: "a.pdf" }), null);
    assert.match(m.planRefusal("plan", undefined, "pdf_redact", { file: "a.pdf" })!, /Plan mode/);
  });

  test("reading notebooks is looking; filing into one, or keeping a screenshot, is not", () => {
    assert.ok(findTool("notebook"));
    for (const action of ["list", "read", " READ "]) assert.equal(m.looksOnly("notebook", { action }), true, action);
    for (const action of ["create", "add", "edit", "remove", "move", "export", ""]) {
      assert.equal(m.looksOnly("notebook", { action }), false, action);
    }
    assert.equal(m.looksOnly("browser_screenshot", {}), true);
    assert.equal(m.looksOnly("browser_screenshot", { full_page: true }), true);
    assert.equal(m.looksOnly("browser_screenshot", { save_as: "evidence" }), false);
    assert.equal(m.looksOnly("browser_screenshot", { notebook: "Case" }), false);
  });

  test("Build never refuses; Plan refuses changes and lets looking through", () => {
    assert.equal(m.planRefusal("build", undefined, "terminal", { command: "rm x" }), null);
    for (const name of ["terminal", "run_background", "browser_click", "browser_fill", "browser_eval", "mcp__github__create_issue", "brand_new_tool"]) {
      assert.match(m.planRefusal("plan", undefined, name, {})!, /Plan mode/, name);
    }
    for (const name of ["browser_read", "web_search", "ask_user", "todo", "set_mode", "browser_handoff"]) {
      assert.equal(m.planRefusal("plan", undefined, name, {}), null, name);
    }
  });

  test("Agent plans until it says otherwise, and building is refused nothing", () => {
    assert.equal(m.phaseFor("agent", undefined), "plan");
    assert.match(m.planRefusal("agent", undefined, "terminal", {})!, /set_mode/);
    assert.match(m.planRefusal("agent", "plan", "terminal", {})!, /set_mode/);
    assert.equal(m.planRefusal("agent", "build", "terminal", {}), null);
    assert.equal(m.planRefusal("agent", "plan", "todo", {}), null);
    assert.equal(m.phaseFor("build", "plan"), "build");
    assert.equal(m.phaseFor("plan", "build"), "plan");
  });

  test("Yolo asks nothing; Ask holds changes, or judges them against the person's words", () => {
    assert.equal(m.askAbout("yolo", "", "terminal", {}), "skip");
    assert.equal(m.askAbout("yolo", "deleting", "terminal", {}), "skip");
    assert.equal(m.askAbout("ask", "", "browser_read", {}), "skip");
    assert.equal(m.askAbout("ask", "", "terminal", {}), "hold");
    assert.equal(m.askAbout("ask", "   ", "terminal", {}), "hold");
    assert.equal(m.askAbout("ask", "deleting files", "terminal", {}), "judge");
    assert.equal(m.askAbout("ask", "deleting files", "web_search", {}), "skip");
    for (const name of ["mcp__github__create_issue", "my_deploy", ""]) assert.equal(m.askAbout("ask", "", name, {}), "hold", name);
  });

  test("the words for when to ask are tidied and capped", () => {
    assert.equal(m.cleanAskWhen("  before   deleting \t things  "), "before deleting things");
    assert.equal(m.cleanAskWhen(42), "");
    assert.equal(m.cleanAskWhen("x".repeat(5000)).length, 600);
  });

  test("the agent is told how the chat works, and what to do about it", () => {
    assert.equal(m.modeBriefing("build", undefined), null);
    assert.match(m.modeBriefing("plan", undefined)!, /Plan mode[\s\S]*Nothing is to be changed[\s\S]*Then stop/);
    assert.match(m.modeBriefing("agent", "plan")!, /PLANNING[\s\S]*very simple[\s\S]*set_mode/);
    assert.match(m.modeBriefing("agent", "build")!, /BUILDING[\s\S]*to-do list/);
    assert.match(m.modeBriefing("plan", undefined, true)!, /incognito/);
    assert.equal(m.permissionBriefing("yolo", "anything"), null);
    assert.match(m.permissionBriefing("ask", "")!, /held on a card/);
    assert.match(m.permissionBriefing("ask", "deleting files")!, /"deleting files"/);
    assert.match(m.askReason("deleting files"), /deleting files/);
    assert.match(m.askReason(""), /Ask/);
  });

  test("the page and the server agree on the modes, the permissions and the suggestions", () => {
    assert.deepEqual(client.WORK_MODES.map((x) => x.id), m.WORK_MODE_LIST);
    assert.deepEqual(client.PERMISSIONS.map((x) => x.id), m.PERMISSION_LIST);
    assert.deepEqual(client.ASK_SUGGESTIONS, m.ASK_SUGGESTIONS);
    assert.equal(client.DEFAULT_WORK_MODE, m.DEFAULT_WORK_MODE);
    assert.equal(client.DEFAULT_PERMISSIONS, m.DEFAULT_PERMISSIONS);
    assert.equal(client.ASK_WHEN_MAX, 600);
  });

  test("tapping a suggestion adds its rule to the words, and again takes it out", () => {
    const [a, b, c] = client.ASK_SUGGESTIONS.map((x) => x.rule);
    let text = client.toggleRule("", a);
    assert.equal(text, a);
    text = client.toggleRule(text, b);
    text = client.toggleRule(text, c);
    assert.equal(text, `${a}; ${b}; ${c}`);
    assert.equal(client.toggleRule(text, b), `${a}; ${c}`);
    assert.equal(client.toggleRule(client.toggleRule(text, a), c), b);
    assert.equal(client.toggleRule("my own words; " + a, a), "my own words");
    assert.equal(client.hasRule(text, a), true);
    assert.equal(client.hasRule("", a), false);
  });

  test("in planning a terminal command that only reads runs; anything that could write is refused", () => {
    for (const command of [
      "cat /data/out/report.txt", "ls -la ~/project", "head -n 20 notes.md | grep todo", "cd app && ls && git status",
      "git log --oneline -5", "find . -name '*.pdf'", "pdftotext out.pdf - 2>&1 | head", "wc -l a b 2>/dev/null",
    ]) {
      assert.equal(m.planRefusal("plan", undefined, "terminal", { command }), null, command);
      assert.equal(m.planRefusal("agent", "plan", "terminal", { command }), null, command);
    }
    for (const command of [
      "", "rm x", "cat a > b", "echo hi >> log", "ls $(rm x)", "ls `id`", "cat a | tee b", "sed -i s/a/b/ f", "sort -o out in",
      "find . -delete", "find . -exec rm {} ;", "git commit -m x", "git push", "ls & rm x", "cat a; rm b", "curl example.com",
      "npm install", "python -c 'open(1)'", "cat <(rm x)",
    ]) {
      assert.match(m.planRefusal("plan", undefined, "terminal", { command }) ?? "", /Not run/, command);
    }
    assert.equal(m.askAbout("ask", "", "terminal", { command: "cat file" }), "skip");
    assert.equal(m.askAbout("ask", "", "terminal", { command: "rm file" }), "hold");
  });

  console.log(`\n${passed} modes cases passed.`);
}
main().catch((err) => { console.error(err); process.exit(1); });
