/**
 * A message is finished before a fold lands.
 *
 * The person's ask: the agent must always be able to finish the output it is
 * writing -- the message they are reading -- before the context is compacted,
 * so compaction can never be the reason a reply stops mid-sentence.
 *
 * Folding runs in the background while the turn keeps working, which is what
 * makes it cheap and is also exactly what made this possible: the swap
 * replaced the history under a reply that was still being written. The rule
 * now is that no fold is begun while a message is in flight, and one already
 * asked for waits for the message to finish before it lands.
 *
 *   npx tsx tests/context-writing.test.ts
 */
import assert from "node:assert/strict";
import { ContextEngine, type CompactionReport, type ContextConfig } from "../server/context";
import type { ChatMessage } from "../server/llm";

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

/** Small enough to pass its high-water mark with a handful of messages. */
const config: ContextConfig = {
  maxContextTokens: 400,
  highWaterPct: 0.5,
  protectedRecent: 2,
  maxToolTokens: 500,
  maxMessages: 24,
};

const line = (n: number, role: ChatMessage["role"] = "user"): ChatMessage => ({
  role,
  text: `message ${n}: ${"words about the work that was done. ".repeat(6)}`,
});

/** A history comfortably past the point where a fold is asked for. */
function past(): { engine: ContextEngine; nextSeq: number } {
  const engine = new ContextEngine(config, "test-writing");
  const history = Array.from({ length: 12 }, (_, i) => ({
    message: line(i),
    seq: i + 1,
  }));
  engine.load(history);
  return { engine, nextSeq: 13 };
}

/** A summariser that does not answer until told to. */
function held() {
  let release: (text: string) => void = () => {};
  const promise = new Promise<string>((resolve) => {
    release = resolve;
  });
  let calls = 0;
  return {
    calls: () => calls,
    summarize: () => {
      calls += 1;
      return promise;
    },
    release: (text = "## ANCHORED WORKING MEMORY\n- the work so far") => release(text),
  };
}

const tick = () => new Promise((r) => setTimeout(r, 0));

console.log("context: a message is finished before a fold lands");

await test("while a message is being written no fold is even asked for", async () => {
  const { engine } = past();
  const s = held();
  engine.beginWriting();
  assert.equal(engine.isWriting, true);
  assert.equal(engine.maybeCompact("system", s.summarize), false, "no fold while writing");
  assert.equal(s.calls(), 0, "the summariser was not asked at all");
  engine.endWriting();
  assert.equal(engine.isWriting, false);
  assert.equal(engine.maybeCompact("system", s.summarize), true, "and the next step folds");
  s.release();
  await tick();
});

await test("a fold already under way waits for the message to finish", async () => {
  const { engine, nextSeq } = past();
  const s = held();
  let report: CompactionReport | null = null;
  assert.equal(engine.maybeCompact("system", s.summarize, (r) => { report = r; }), true);
  // The summariser is still thinking, and the agent has started writing.
  engine.beginWriting();
  engine.append({ role: "assistant", text: "Here is the whole answer, in one piece." }, nextSeq);
  s.release();
  await tick();
  await tick();
  assert.equal(report, null, "the summary came back but the swap did not land");
  const stillThere = engine.messagesFor("system");
  assert.ok(
    stillThere.some((m) => m.text?.includes("Here is the whole answer")),
    "the message being written is still in the prompt",
  );
  assert.equal(engine.foldedThroughSeq, 0, "the fold has not landed");
  assert.ok(
    !engine.systemFor("system").includes("ANCHORED WORKING MEMORY"),
    "and the record it wrote is not in the prompt yet",
  );

  // The message is finished, and now the fold goes in.
  engine.endWriting();
  for (let i = 0; i < 5 && report === null; i += 1) await tick();
  assert.notEqual(report, null, "the fold landed once the message was out");
  assert.ok(engine.foldedThroughSeq > 0, "and the history moved into the record");
  assert.ok(
    engine.systemFor("system").includes("ANCHORED WORKING MEMORY"),
    "the record it wrote is in the prompt now",
  );
  assert.equal((report as unknown as CompactionReport).ok, true);
});

await test("the message just written survives the fold that follows it", async () => {
  const { engine, nextSeq } = past();
  const s = held();
  const done = new Promise<CompactionReport>((resolve) => {
    engine.maybeCompact("system", s.summarize, resolve);
  });
  engine.beginWriting();
  const written = "The whole reply, which must not be cut off.";
  engine.append({ role: "assistant", text: written }, nextSeq);
  s.release();
  engine.endWriting();
  const report = await done;
  assert.equal(report.ok, true, "the fold happened");
  assert.ok(report.folded > 0, "and something was folded");
  const after = engine.messagesFor("system");
  assert.ok(
    after.some((m) => m.text?.includes(written)),
    "the newest message is still there -- a fold cannot take back what they were told",
  );
});

await test("writing is counted, so a nested call cannot re-open a fold too early", async () => {
  const { engine } = past();
  const s = held();
  engine.beginWriting();
  engine.beginWriting();
  engine.endWriting();
  assert.equal(engine.maybeCompact("system", s.summarize), false, "one is still open");
  engine.endWriting();
  assert.equal(engine.maybeCompact("system", s.summarize), true);
  engine.endWriting();
  s.release();
  await tick();
});

await test("endWriting without beginWriting is harmless", () => {
  const { engine } = past();
  engine.endWriting();
  assert.equal(engine.isWriting, false);
});

console.log(`\n${passed} passed`);
