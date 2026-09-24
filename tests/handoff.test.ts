/**
 * Working a page: what the agent says stays in the page's card, and a CAPTCHA
 * handed to the person settles itself once it passes.
 *
 *   npx tsx tests/handoff.test.ts
 */
import assert from "node:assert/strict";
import { derive } from "../src/lib/derive";
import { Kind, type AutoraEvent } from "../src/lib/types";
import { captchaWatch } from "../server/tools";

let passed = 0;
async function test(name: string, fn: () => Promise<void> | void) {
  try {
    await fn();
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

let seq = 0;
const ev = (kind: string, payload: Record<string, any> = {}, blob: string | null = null): AutoraEvent => ({
  seq: ++seq, ts: seq, kind, actor: "agent", span: null, payload, blob,
});
const frame = () => ev(Kind.BrowserFrame, {}, `b${seq}`);
const say = (text: string) => ev(Kind.AgentText, { text });

async function main() {
  console.log("the page's card");
  const working = [
    ev(Kind.UserMessage, { text: "find it" }),
    ev(Kind.BrowserNav, { url: "https://example.com" }), frame(),
    say("Opened the page."),
    ev(Kind.BrowserAction, { action: "click", url: "https://example.com/a" }), frame(),
    say("Clicked through."),
  ];

  await test("while the turn runs, the page is one card with the narration inside", () => {
    const [bucket] = derive(working).buckets;
    assert.equal(bucket.cells.length, 1);
    const card = bucket.cells[0];
    assert.equal(card.kind, "screen");
    if (card.kind !== "screen") return;
    assert.equal(card.shots.length, 2);
    assert.deepEqual(card.log.map((c) => c.kind === "reply" && c.turn.text), ["Opened the page.", "Clicked through."]);
    assert.equal(card.live, true);
  });

  await test("once the turn ends, the last words go back in the conversation", () => {
    const [bucket] = derive([...working, ev(Kind.AgentDone)]).buckets;
    assert.deepEqual(bucket.cells.map((c) => c.kind), ["screen", "reply"]);
    const card = bucket.cells[0];
    if (card.kind !== "screen") return;
    assert.equal(card.log.length, 1, "narration between actions stays in the card");
  });

  await test("a terminal command in between does not open a second card", () => {
    const [bucket] = derive([
      ...working,
      ev(Kind.ToolCall, { name: "bash", args: { command: "ls" } }),
      say("Listed it."),
      frame(),
    ]).buckets;
    assert.deepEqual(bucket.cells.map((c) => c.kind), ["screen"]);
    const card = bucket.cells[0];
    if (card.kind !== "screen") return;
    assert.equal(card.shots.length, 3);
    assert.deepEqual(card.log.map((c) => c.kind), ["reply", "reply", "terminal", "reply"]);
  });

  await test("a later prompt on the same browser moves the one card down to it", () => {
    const buckets = derive([
      ...working,
      ev(Kind.AgentDone),
      ev(Kind.UserMessage, { text: "now the other one" }),
      say("Going there."),
      ev(Kind.BrowserNav, { url: "https://example.org" }), frame(),
      ev(Kind.AgentDone),
    ]).buckets;
    assert.deepEqual(buckets.map((b) => b.cells.map((c) => c.kind)), [["reply"], ["reply", "screen"]]);
    const card = buckets[1].cells[1];
    if (card.kind !== "screen") return;
    assert.equal(card.shots.length, 3, "the earlier pages stay in the card's history");
    assert.equal(card.url, "https://example.org");
  });

  await test("closing the browser ends the card", () => {
    const buckets = derive([
      ...working,
      ev(Kind.BrowserAction, { action: "close", url: "" }),
      ev(Kind.AgentDone),
      ev(Kind.UserMessage, { text: "again" }),
      ev(Kind.BrowserNav, { url: "https://example.org" }), frame(),
    ]).buckets;
    assert.equal(buckets[0].cells.filter((c) => c.kind === "screen").length, 1);
    assert.equal(buckets[1].cells.filter((c) => c.kind === "screen").length, 1);
  });

  await test("a logged screenshot of the page lands on the one screen, never a second card", () => {
    const shot = (payload: Record<string, any>) => ev(Kind.MediaImage, payload, `s${seq}`);
    for (const picture of [
      { alt: "cats", caption: "file:///app/cats/index.html", w: 1280, h: 800 },
      { alt: "cats", caption: "file:///app/cats/other.html" },
      { alt: "the page as it looks now", caption: "" },
    ]) {
      const cells = derive([
        ev(Kind.UserMessage, { text: "make a cat page" }),
        ev(Kind.ToolCall, { tool: "artifact_save", args: { path: "/app/cats/cat2.jpg" } }),
        frame(),
        ev(Kind.ToolCall, { tool: "artifact_save", args: { path: "/app/cats/cat3.jpg" } }),
        shot(picture),
        ev(Kind.AgentDone),
      ]).buckets[0].cells;
      assert.equal(cells.filter((c) => c.kind === "images").length, 0, JSON.stringify(picture));
      assert.equal(cells.filter((c) => c.kind === "screen").length, 1);
    }
  });

  await test("pictures that are not the page still get their own card", () => {
    const cells = derive([
      ev(Kind.UserMessage, { text: "draw" }),
      ev(Kind.BrowserNav, { url: "https://example.com" }), frame(),
      ev(Kind.MediaImage, { alt: "a cat", caption: "Generated: a cat" }, "g1"),
      ev(Kind.AgentDone),
    ]).buckets[0].cells;
    assert.equal(cells.filter((c) => c.kind === "images").length, 1);
  });

  console.log("captcha handoff");
  const page = (steps: { present: boolean; passed: boolean }[]) => {
    let i = 0;
    return { captchaStatus: async () => ({ ...steps[Math.min(i++, steps.length - 1)], url: "https://x" }) };
  };

  await test("settles once the CAPTCHA has stayed passed", async () => {
    const watch = await captchaWatch(page([
      { present: true, passed: false },
      { present: true, passed: false },
      { present: true, passed: true },
      { present: true, passed: true },
    ]), "Please solve the picture challenge");
    assert.ok(watch);
    assert.equal(await watch!(), null);
    assert.equal(await watch!(), null, "one passed look is not enough");
    assert.match(String(await watch!()), /passed/);
  });

  await test("a verification page that lets you through by leaving counts", async () => {
    const watch = await captchaWatch(page([
      { present: true, passed: false },
      { present: false, passed: false },
    ]), "Complete the Cloudflare check");
    assert.equal(await watch!(), null);
    assert.match(String(await watch!()), /cleared/);
  });

  await test("a sign-in with no CAPTCHA still waits for the person", async () => {
    const watch = await captchaWatch(page([{ present: false, passed: false }]), "Please log in to GitHub");
    assert.equal(watch, undefined);
  });

  console.log(`\n${passed} passed`);
}

main().catch(() => process.exit(1));
