/**
 * Explainer widgets: the tool, and the page a widget runs in.
 *
 *   npx tsx tests/widget.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { MAX_WIDGET_CHARS, THREE_CDN, usesThree, widgetDocument } from "../src/lib/widget";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-widget-"));
const { availableTools, findTool, runTool } = await import("../server/tools");
const { listArtifacts, readArtifact } = await import("../server/artifacts");

let passed = 0;
async function test(name: string, fn: () => void | Promise<void>) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

console.log("explainer widgets");

const THREE_WIDGET = `<script type="module">import * as THREE from "three";
import { OrbitControls } from "three/addons/controls/OrbitControls.js";</script>`;

await test("Three.js is only added to widgets that import it", () => {
  assert.equal(usesThree(THREE_WIDGET), true);
  assert.equal(usesThree(`<script type="module">const T = await import('three');</script>`), true);
  assert.equal(usesThree(`<canvas></canvas><script>const three = 3;</script>`), false);
  assert.doesNotMatch(widgetDocument({ title: "t", html: "<p>hi</p>" }), /importmap/);
});

await test("the thread's frame shares one bundled copy; the saved copy loads the CDN", () => {
  const framed = widgetDocument({ title: "t", html: THREE_WIDGET, threeBundle: "data:text/javascript;base64,AA==", frame: "w1" });
  const map = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(framed)![1]).imports;
  assert.equal(map.three, "data:text/javascript;base64,AA==");
  assert.equal(map["three/addons/controls/OrbitControls.js"], map.three);
  assert.match(framed, /autoraWidget: "w1"/);

  const alone = widgetDocument({ title: "t", html: THREE_WIDGET });
  const cdn = JSON.parse(/<script type="importmap">(.*?)<\/script>/.exec(alone)![1]).imports;
  assert.equal(cdn.three, `${THREE_CDN}/build/three.module.js`);
  assert.equal(cdn["three/addons/"], `${THREE_CDN}/examples/jsm/`);
  assert.doesNotMatch(alone, /autoraWidget/);
});

await test("a whole document keeps its shape, with the theme put in its head", () => {
  const doc = widgetDocument({ title: "t", html: `<!doctype html><html><head><title>Mine</title></head><body>x</body></html>` });
  assert.equal((doc.match(/<html/g) ?? []).length, 1);
  assert.match(doc, /<head>\n<meta charset="utf-8">[\s\S]*--accent:[\s\S]*<title>Mine<\/title>/);
});

const { probeBrowser } = await import("../server/browser");
const canCheck = (await probeBrowser()).ok;

await test("widget_show is always offered, tries the widget, shows it and saves a copy", async () => {
  assert.ok((await availableTools()).some((t) => t.name === "widget_show"));
  const shown: { title: string; html: string; height: number; artifact?: string }[] = [];
  const ctx = { showWidget: (w: any) => shown.push(w), session: "s1" } as any;
  const html = `<p>Hello</p><button onclick="this.textContent='Done'">Go</button>`;
  const outcome = await runTool(findTool("widget_show")!, { title: "Orbits", html, height: 5000 }, ctx);
  assert.equal(outcome.ok, true, outcome.summary);
  assert.equal(shown.length, 1);
  assert.equal(shown[0].height, 1400);
  const art = listArtifacts().find((a) => a.name === "orbits.html");
  assert.ok(art && art.mime === "text/html");
  assert.equal(shown[0].artifact, art.id);
  assert.match(readArtifact(art.id)!.toString("utf8"), /<p>Hello<\/p>/);
  if (canCheck) {
    assert.match(outcome.summary, /Text: "Hello Go"/);
    assert.match(outcome.summary, /button "Go": clicked; no errors/);
  }
});

await test("a widget that throws when used is not shown, and the agent is told what broke", async () => {
  if (!canCheck) return console.log("      (no browser here; skipped)");
  const shown: unknown[] = [];
  const ctx = { showWidget: (w: unknown) => shown.push(w), session: "s1" } as any;
  const html = `<button>Heat up</button><script>document.querySelector("button").onclick = () => evaporate();</script>`;
  const outcome = await runTool(findTool("widget_show")!, { title: "Water", html }, ctx);
  assert.equal(outcome.ok, false);
  assert.equal(shown.length, 0);
  assert.match(outcome.summary, /NOT shown/);
  assert.match(outcome.summary, /after using button "Heat up": evaporate is not defined/);
});

await test("a widget that draws nothing is not shown", async () => {
  if (!canCheck) return console.log("      (no browser here; skipped)");
  const shown: unknown[] = [];
  const ctx = { showWidget: (w: unknown) => shown.push(w), session: "s1" } as any;
  const outcome = await runTool(findTool("widget_show")!, { title: "Empty", html: "<canvas></canvas>" }, ctx);
  assert.equal(outcome.ok, false);
  assert.match(outcome.summary, /NOTHING IS VISIBLE/);
  assert.equal(shown.length, 0);
});

await test("an empty or oversized widget is refused, not shown", async () => {
  const shown: unknown[] = [];
  const ctx = { showWidget: (w: unknown) => shown.push(w), session: "s1" } as any;
  const spec = findTool("widget_show")!;
  assert.equal((await runTool(spec, { title: "x", html: "  " }, ctx)).ok, false);
  assert.equal((await runTool(spec, { title: "x", html: "a".repeat(MAX_WIDGET_CHARS + 1) }, ctx)).ok, false);
  assert.equal(shown.length, 0);
});

console.log(`${passed} passed`);
// The checking browser closes itself after a few idle minutes; a test run
// should not wait for it.
process.exit(0);
