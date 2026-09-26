/**
 * Learning after a turn: when it is worth a look, and what of the reply is
 * trusted.
 *
 *   npx tsx tests/learning.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseReflection, reflectionPrompt, worthReflecting } from "../server/learning";

process.env.AUTORA_STATE_DIR = fs.mkdtempSync(path.join(os.tmpdir(), "autora-learn-"));
const custom = await import("../server/customtools");

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

console.log("learning and custom tools");

test("only real work, or being told how, is reflected on", () => {
  const base = { ranSomething: false, stopped: false, ok: true };
  assert.equal(worthReflecting({ ...base, request: "what's 2+2" }), false);
  assert.equal(worthReflecting({ ...base, request: "from now on, answer in French" }), true);
  assert.equal(worthReflecting({ ...base, ranSomething: true, request: "fix the backup" }), true);
  assert.equal(worthReflecting({ ...base, ranSomething: true, stopped: true, request: "fix it" }), false);
  // A turn that ran tools and then went wrong is the one to look back at...
  assert.equal(worthReflecting({ ...base, ok: false, ranSomething: true, request: "fix the backup" }), true);
  // ...but one that never reached a tool is the provider having a bad day.
  assert.equal(worthReflecting({ ...base, ok: false, request: "fix the backup" }), false);
});

test("a failing tool is named in the review, with what to do instead", () => {
  const prompt = reflectionPrompt({
    request: "check the logs",
    previousReply: "",
    steps: ["- terminal (pkill -f \"dist/server.cjs\") -> exit 128", "- terminal (curl ...) -> ok"],
    trouble: "Tools that have been failing lately (last 7 days):\n- terminal (pkill -f): 3 of the last 3 calls failed, most recently: (no output)",
    reply: "done",
    recalled: [],
    nearby: [],
  });
  assert.match(prompt, /pkill -f\): 3 of the last 3 calls failed/, "the failing command is quoted to the reviewer");
  assert.match(prompt, /the procedure that avoids it, not a note that it hurt/);
  // With nothing going wrong the block is left out entirely.
  const quiet = reflectionPrompt({
    request: "check the logs", previousReply: "", steps: [], reply: "done", recalled: [], nearby: [],
  });
  assert.doesNotMatch(quiet, /behaving lately/);
});

test("a reflection keeps well-formed lessons and known ids only", () => {
  const reply = 'Here you go: {"learned":[' +
    '{"kind":"procedure","title":"Fix stuck scan","body":"docker restart jellyfin, then rescan","tags":["jellyfin"],"revises":"mem-a"},' +
    '{"kind":"opinion","title":"x","body":"not a real kind here"},' +
    '{"kind":"fact","title":"Token","body":"api_key: sk-abcdef123456 for the router"}' +
    '],"helped":["mem-a","mem-zzz"],"misled":["mem-b"]}';
  const out = parseReflection(reply, new Set(["mem-a", "mem-b"]));
  assert.equal(out.learned.length, 1, "bad kinds and secrets are dropped");
  assert.equal(out.learned[0].revises, "mem-a");
  assert.deepEqual(out.helped, ["mem-a"]);
  assert.deepEqual(out.misled, ["mem-b"]);
  assert.deepEqual(parseReflection("no json here", new Set()), { learned: [], helped: [], misled: [] });
});

test("a tool the agent writes is saved, replaced by name, and gets its arguments as env", () => {
  const { tool, replaced } = custom.defineCustomTool({
    name: "my_disk_free", description: "Free space on a mount", script: "df -h \"$ARG_MOUNT\"",
    params: [{ name: "mount", description: "path" }],
  });
  assert.equal(tool.name, "disk_free");
  assert.equal(replaced, false);
  assert.equal(custom.defineCustomTool({ name: "disk_free", description: "v2", script: "df" }).replaced, true);
  assert.equal(custom.listCustomTools().length, 1);
  const again = custom.defineCustomTool({
    name: "disk_free", description: "Free space", script: "df -h \"$ARG_MOUNT\"",
    params: [{ name: "mount", description: "path" }],
  }).tool;
  assert.deepEqual(custom.missingArgs(again, {}), ["mount"]);
  assert.equal(custom.customEnv(again, { mount: "/data" }).ARG_MOUNT, "/data");
  assert.throws(() => custom.defineCustomTool({ name: "Bad Name", description: "x", script: "y" }), /lowercase/);
  assert.equal(custom.deleteCustomTool("my_disk_free"), true);
  assert.equal(custom.listCustomTools().length, 0);
});

console.log(`${passed} passed`);
