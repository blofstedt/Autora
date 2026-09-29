/**
 * The voice goes quiet when it is told to, and stays quiet.
 *
 * The complaint that started this: a beep, over and over, that could not be
 * turned off. Two things have to hold for "stop talking" to be an answer
 * rather than a promise -- the tool that mutes is offered to the agent, and
 * muting it takes the speak tool away from every turn after it, because a
 * setting that only lasts the turn it was set in is not a setting.
 *
 *   npx tsx tests/mute.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const dir = fs.mkdtempSync(path.join(os.tmpdir(), "autora-mute-"));
process.env.AUTORA_STATE_DIR = dir;

const { mergeTools, state } = await import("../server/state");
const { availableTools, groupStates, needsApproval, renderCall } = await import("../server/tools");

let passed = 0;
function test(name: string, fn: () => void | Promise<void>) {
  try {
    const out = fn();
    if (out instanceof Promise) {
      return out.then(() => { passed += 1; console.log(`  ok  ${name}`); },
        (err) => { console.error(`  FAIL ${name}`); throw err; });
    }
    passed += 1;
    console.log(`  ok  ${name}`);
  } catch (err) {
    console.error(`  FAIL ${name}`);
    throw err;
  }
}

/** The live settings, which is what the registry reads: a merge into a copy
    would prove nothing about what the agent is actually offered. */
function settings() {
  return state.tools;
}

await test("voice_mute is offered, and is not a group that can be gated", () => {
  const spec = { name: "voice_mute", group: "voice", description: "", parameters: { type: "object", properties: {} } } as any;
  assert.equal(needsApproval(spec), false, "muting must never wait on an approval card");
  assert.equal(
    renderCall(spec, { muted: true }),
    "mute the voice: stop saying things out loud",
    "the card and the thread say what it does",
  );
  assert.equal(renderCall(spec, { muted: false }), "unmute the voice");
});

await test("muting takes the speak tool away, and unmuting gives it back", async () => {
  const before = (await availableTools()).map((t) => t.name);
  assert.ok(before.includes("speak"), "speak is offered while the voice is on");
  assert.ok(before.includes("voice_mute"), "and so is the way to stop it");

  mergeTools(settings(), { voice: { enabled: false } });
  const muted = (await availableTools()).map((t) => t.name);
  assert.ok(!muted.includes("speak"), "a muted install is not offered the speak tool at all");
  assert.ok(muted.includes("voice_mute"), "but is still offered the way back");

  mergeTools(settings(), { voice: { enabled: true } });
  const back = (await availableTools()).map((t) => t.name);
  assert.ok(back.includes("speak"), "unmuting restores it");
});

await test("the group says which it is, in one sentence", async () => {
  const on = (await groupStates()).find((g) => g.group === "voice");
  assert.ok(on, "the voice is a group the panel can show");
  assert.equal(on!.enabled, true);
  assert.equal(on!.available, true);
  assert.deepEqual([...on!.tools].sort(), ["speak", "voice_mute"]);

  mergeTools(settings(), { voice: { enabled: false } });
  const off = (await groupStates()).find((g) => g.group === "voice");
  assert.equal(off!.enabled, false);
  assert.equal(off!.available, false);
  assert.match(off!.detail, /cannot make this page say anything/);
  assert.match(off!.detail, /talk mode/, "and says what is not affected");
});

await test("a settings file without the field still loads", () => {
  const old = {
    terminal: { enabled: true, cwd: "", timeout: 120, approval: "never" },
    browser: { enabled: true, approval: "never" },
    computer: { enabled: true, approval: "never" },
    memory: { enabled: true, approval: "never" },
  } as any;
  /* The previous test muted it, which is exactly the state an upgrade starts
     from: a saved file that has never heard of the field must not turn the
     voice back on, and must not leave the group missing either. */
  const merged = mergeTools(settings(), old);
  assert.equal(merged.voice.enabled, false, "a file with no opinion does not undo a mute");
  assert.equal(typeof merged.voice.approval, "string", "and the group is still whole");
  mergeTools(settings(), { voice: { enabled: true } });
  assert.equal(settings().voice.enabled, true, "and the switch still works");
});

console.log(`\n${passed} passed`);
