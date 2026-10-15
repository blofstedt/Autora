/**
 * The tools handbook (server/handbook.ts): each window has a manual, tools map to the right one, the overview every turn
 * points at them, and `tool_manual` reads one.
 *
 *   npx tsx tests/handbook.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-handbook-test-"));
const { MANUAL_IDS, manualId, manualText, windowsOverview } = await import("../server/handbook");
const { capabilityBriefing, runTool, findTool } = await import("../server/tools");

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try { await fn(); passed += 1; console.log(`  ok  ${name}`); } catch (err) { console.error(`  FAIL ${name}`); throw err; }
}

await test("every window has a manual that names its tools", () => {
  const expect: Record<string, string[]> = {
    browser: ["Autora Browser", "browser_handoff"], creator: ["Autora Creator", "app_preview"], terminal: ["Autora Terminal", "run_background"],
    pdf: ["Autora PDF", "pdf_compose"], video: ["Autora Video", "video_ui"], studio: ["Autora Music", "studio_make"],
    office: ["Pages, Sheets and Slides", "office_create"], cad: ["Autora 3D", "cad_shape_measure"], game: ["Autora Games", "game_catalog"], photo: ["Autora Photo", "photo_edit"],
    widgets: ["Widgets", "widget_show"],
  };
  assert.deepEqual([...MANUAL_IDS].sort(), Object.keys(expect).sort());
  for (const id of MANUAL_IDS) for (const needle of expect[id]) assert.ok(manualText(id).includes(needle), `${id} lacks ${needle}`);
});

await test("the PDF manual teaches the window as it is now: the bar, the grid, the trays, tap to redact, sign", () => {
  const pdf = manualText("pdf");
  for (const needle of ["All tools", "colour wheel", "Redact N regions", "pending", "never an image", "replaces the old toolbar", "Shapes has a round button", "pin any tool", "Reset bar", "down the right side on a desktop", "page thumbnails", "Merge, Add pages, Split"]) {
    assert.ok(pdf.includes(needle), `the PDF manual lacks "${needle}"`);
  }
  assert.ok(!/menu bar of|Mark up, Fill & sign/.test(pdf), "and says nothing of the bar it replaced, except that it is replaced");
});

await test("the Music manual teaches the tool bar and not the toolbar it replaced", () => {
  const music = manualText("studio");
  for (const needle of ["All tools", "Add track", "Split, Duplicate and Delete", "pin any tool", "no old toolbar", "whatever is shown"]) {
    assert.ok(music.includes(needle), `the Music manual lacks "${needle}"`);
  }
});

await test("the 3D manual teaches the tool bar and not the bottom bar it replaced", () => {
  const cad = manualText("cad");
  for (const needle of ["All tools", "Size & position", "Pick edges", "Push & pull", "pin any tool", "no bottom bar", "whatever is shown"]) {
    assert.ok(cad.includes(needle), `the 3D manual lacks "${needle}"`);
  }
});

await test("the Office manual teaches the tool bar and not the ribbon it replaced", () => {
  const office = manualText("office");
  for (const needle of ["All tools", "no ribbon", "one group per old ribbon tab", "pin any of them", "keyboard shortcuts work", "whatever is shown"]) {
    assert.ok(office.includes(needle), `the Office manual lacks "${needle}"`);
  }
});

await test("the Video manual teaches the tool bar and not the tab strip and toolbar it replaced", () => {
  const video = manualText("video");
  for (const needle of ["All tools", "no strip of tabs", "pin any of them", "keyboard shortcuts work", "video_ui by its name"]) {
    assert.ok(video.includes(needle), `the Video manual lacks "${needle}"`);
  }
});

await test("the Photo manual teaches the tool bar and not the menu bar and toolbox it replaced", () => {
  const photo = manualText("photo");
  for (const needle of ["All tools", "no menu bar, no toolbox", "pin any tool or command", "keyboard shortcuts work", "whatever is shown"]) {
    assert.ok(photo.includes(needle), `the Photo manual lacks "${needle}"`);
  }
});

await test("the Office manual says that with Visible work on office_edit's words are typed in the window by hand", () => {
  const office = manualText("office");
  for (const needle of ["With Visible work on", "typed there by your hand, live", "name box", "formula bar's tick", "box is opened on its slide", "With Visible work off"]) {
    assert.ok(office.includes(needle), `the Office manual lacks "${needle}"`);
  }
});

await test("the PDF manual says that with Visible work on pdf_edit is done in the window by hand, and what is not", () => {
  const pdf = manualText("pdf");
  for (const needle of ["With Visible work on", "by your hand, live", "Fill N fields", "Ctrl+S", "done on the file afterwards", "With Visible work off"]) {
    assert.ok(pdf.includes(needle), `the PDF manual lacks "${needle}"`);
  }
});

await test("the Photo manual says that with Visible work on the edit is done in the window by hand", () => {
  const photo = manualText("photo");
  for (const needle of ["Visible work on", "by your hand", "clicks its tile", "command's own dialog", "Visible work off"]) {
    assert.ok(photo.includes(needle), `the Photo manual lacks "${needle}"`);
  }
});

await test("a tool finds its window's manual, and a tool with no window finds none", () => {
  assert.equal(manualId("browser_click"), "browser");
  assert.equal(manualId("web_search"), "browser");
  assert.equal(manualId("app_preview"), "creator");
  assert.equal(manualId("terminal"), "terminal");
  assert.equal(manualId("pdf_edit"), "pdf");
  assert.equal(manualId("studio_clip"), "studio");
  assert.equal(manualId("office_edit"), "office");
  assert.equal(manualId("cad_batch"), "cad");
  assert.equal(manualId("photo_edit"), "photo");
  assert.equal(manualId("game_edit"), "game");
  assert.equal(manualId("widget_show"), "widgets");
  assert.equal(manualId("todo"), null);
  assert.equal(manualId("memory_search"), null);
});

await test("the overview every turn explains the layout and points at the manuals", async () => {
  const overview = windowsOverview();
  assert.ok(overview.includes("x on its tab") && overview.includes("Follow") && overview.includes("tool_manual"));
  // The switch beside Follow, and what turning it off changes for the agent.
  assert.ok(overview.includes("Visible work on") && overview.includes("Visible work off you work at speed"));
  // Video: the name is in the window's bar, the editor's own row is the projects menu and Export.
  assert.match(manualText("video"), /only the projects menu \(New project, Rename/);
  const briefing = await capabilityBriefing();
  assert.ok(briefing.includes("How Autora's windows work"));
  assert.ok(!briefing.includes("a real Chromium running on this machine"), "the manuals are not in the briefing");
});

await test("the organization is briefed once, and the lead is told it routes the work", async () => {
  const briefing = await capabilityBriefing();
  const said = briefing.split("You run this organization, so you may shape it with the agents tool").length - 1;
  assert.equal(said, 1, "the hiring text is emitted once, not twice");
  assert.match(briefing, /Autora leads, plans and routes the work/);
});

await test("tool_manual returns a manual, and refuses a window that does not exist", async () => {
  const spec = findTool("tool_manual")!;
  assert.ok(spec);
  const ctx = { session: "s", onOutput: () => undefined } as never;
  const ok = await runTool(spec, { window: "Studio" }, ctx);
  assert.equal(ok.ok, true);
  assert.ok(ok.summary.includes("Autora Music"));
  const bad = await runTool(spec, { window: "nope" }, ctx);
  assert.equal(bad.ok, false);
  assert.ok(bad.summary.includes("browser, creator"));
});

console.log(`\n${passed} passed`);
process.exit(0);
