/**
 * The folded detail: the short half of a post on screen, the dense half one
 * click away.
 *
 * An agent's post carrying a number, a path, a version and two sources read as
 * a wall, so the wall was what nobody read. A fence whose info string is
 * exactly `detail` is therefore not code but a CLOSED disclosure -- the first
 * line of the fence body is the label on the toggle and the rest is Markdown
 * again, so a list, a table, a command and a link all still work behind it.
 *
 * These tests hold three lines: what the reader sees (Markdown.tsx, rendered
 * here for real), what another agent is handed (the forum prompt in
 * threadlife.ts, where the fence must survive as a fence), and what the agent
 * is told to write (the rule in the system prompt, which has to name the fence
 * exactly, because `detail` and nothing else is what matches).
 *
 *   npx tsx tests/detail.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "../src/components/Markdown";

// The forum half writes posts, so it gets a store of its own, not the live one.
process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-detail-"));

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

/** What the reader's page is handed for one reply. */
const draw = (text: string) => renderToStaticMarkup(createElement(Markdown, { text }));

const summaryOf = (html: string) => html.match(/<summary class="md-detail-head">([^<]*)<\/summary>/)?.[1];

/* The reader's side ------------------------------------------------------------------ */

await test("a ```detail fence is a closed disclosure, not a code block", () => {
  const html = draw("Ran the numbers and it is worth doing.\n\n```detail\nThe numbers\n- hit rate 41% -> 78%\n```\n\nWant a look before I write it up?");
  assert.match(html, /<details class="md-detail">/);
  assert.equal(summaryOf(html), "The numbers");
  assert.ok(!html.includes("md-code"), "the fence must not also be drawn as code");
  assert.ok(!html.includes(" open"), "it lands closed");
  assert.match(html, /<p>Ran the numbers and it is worth doing\.<\/p>/);
  assert.match(html, /<p>Want a look before I write it up\?<\/p>/);
});

await test("behind it the body is Markdown again: a list, a table, a link, inline code", () => {
  const html = draw("```detail\nThe numbers\n- a\n- b\n\n| before | after |\n| --- | --- |\n| 41% | 78% |\n\n**bold** and `npm test` and [x](https://example.com)\n```");
  assert.match(html, /<li>a<\/li>/);
  assert.match(html, /md-table/);
  assert.match(html, /<strong>bold<\/strong>/);
  assert.match(html, /<code>npm test<\/code>/);
  assert.match(html, /href="https:\/\/example\.com"/);
});

await test("an empty body is the label Detail with nothing behind it", () => {
  const html = draw("```detail\n```");
  assert.equal(summaryOf(html), "Detail");
  assert.ok(!html.includes("md-detail-body"), "nothing to open onto");
});

await test("a half-written reply is an open detail to the end, the way a code fence is", () => {
  const html = draw("```detail\nStill writing\n- one");
  assert.match(html, /<details class="md-detail" open/);
  assert.ok(/<details[^>]*\sopen/.test(html), "the closing fence has not arrived, so nothing is hidden behind a shut toggle");
  assert.equal(summaryOf(html), "Still writing");
  assert.match(html, /<li>one<\/li>/);
});

await test("a detail that did close lands closed, so the words on screen stay the short ones", () => {
  const html = draw("```detail\nStill writing\n- one\n```");
  assert.match(html, /<details class="md-detail">/);
  assert.ok(!/<details[^>]*\sopen/.test(html));
  assert.match(html, /<li>one<\/li>/);
});

await test("only exactly `detail` counts: every other fence is still code", () => {
  assert.match(draw("```ts\nconst a = 1;\n```"), /md-code/);
  assert.match(draw("```detail-notes\nx\n```"), /md-code/);
  assert.ok(!draw("```detail-notes\nx\n```").includes("md-detail"));
  assert.ok(!draw("```\nplain\n```").includes("md-detail"));
});

await test("the label is the body's first line, trimmed -- a label on the fence line is no fence at all", () => {
  assert.equal(summaryOf(draw("```detail\n  Files touched  \n- a\n```")), "Files touched");
  // Written the other way it is not a fence: the reader gets the backticks as words,
  // which is why the prompt spells the shape out.
  const wrong = draw("```detail Files touched\n- a\n```");
  assert.ok(!wrong.includes("md-detail"));
  assert.match(wrong, /```detail Files touched/);
});

await test("a second fence inside a detail block ends it early -- the rule the prompt states", () => {
  const html = draw("```detail\nCmd\n- a\n```sh\nnpm test\n```");
  assert.match(html, /md-detail/);
  assert.match(html, /md-code/, "the inner fence spills out, which is why a command goes in single backticks");
});

/* The other agents' side ------------------------------------------------------------- */

const forum = await import("../server/threads");
const life = await import("../server/threadlife");

const BODY = [
  "Ran the numbers on the cache change and it is worth doing.",
  "",
  "```detail",
  "The numbers",
  "- hit rate 41% -> 78% on the same trace",
  "- src/lib/cache.ts, line 88",
  "```",
].join("\n");

forum.createPost({ title: "Cache change", body: BODY, tags: ["autora"], by: { kind: "agent", id: "agent_ada", name: "Ada" } });

const read = life.lifePrompt(
  { id: "agent_ben", name: "Ben", role: "Engineer", instructions: "You work on the app." } as never,
  ["Ada"],
);

await test("a post is stored with its fence whole", () => {
  assert.equal(forum.listPosts("new")[0].body, BODY);
});

await test("the forum prompt keeps the fence and the label on their own lines", () => {
  assert.match(read.prompt, /\n```detail\nThe numbers\n/, "flattened to one run of words, the fence stops being a fence");
  assert.ok(read.prompt.includes("hit rate 41%"), "another agent is handed the folded material too");
  assert.ok(read.prompt.includes("worth doing"), "and the visible sentence is not squeezed out");
});

await test("what an agent is told to write names the fence exactly and says one fence only", () => {
  assert.ok(read.system.includes("```detail"), "the rule has to name the string that matches");
  assert.match(read.system, /fence line is exactly ```detail and nothing else/);
  assert.match(read.system, /no second fenced block inside a detail block/i);
  assert.match(read.system, /one to three short sentences/);
});

console.log(`\n${passed} passed`);
