/**
 * Slash commands: what a draft starting with "/" offers, and what it runs.
 *
 * The one thing that must not happen is a message being eaten: a path the
 * person meant to send ("/etc/hosts is wrong") has to reach the agent.
 *
 *   npx tsx tests/commands.test.ts
 */
import assert from "node:assert/strict";
import { resolve, suggest } from "../src/lib/commands";

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

console.log("commands");

test("a bare slash offers everything that applies", () => {
  const idle = suggest("/", false).map((c) => c.name);
  assert.ok(idle.includes("new"));
  assert.ok(!idle.includes("stop"), "stop is only offered while something runs");
  assert.ok(suggest("/", true).some((c) => c.name === "stop"));
});

test("the list narrows as the name is typed", () => {
  assert.deepEqual(suggest("/st", true).map((c) => c.name), ["stop"]);
  assert.deepEqual(suggest("/zzz", true), []);
});

test("the menu goes away once the name is finished", () => {
  assert.deepEqual(suggest("/remember ", false), []);
  assert.deepEqual(suggest("hello /new", false), []);
});

test("a finished command resolves, with its argument", () => {
  const hit = resolve("/remember the NAS is at 10.0.0.4");
  assert.equal(hit?.command.id, "remember");
  assert.equal(hit?.arg, "the NAS is at 10.0.0.4");
  assert.equal(resolve("/STOP")?.command.id, "stop");
});

test("renamed commands still answer to their old names", () => {
  assert.equal(resolve("/settings")?.command.id, "config");
  assert.equal(resolve("/config")?.command.id, "config");
  assert.equal(resolve("/schedules")?.command.id, "cron");
  assert.equal(resolve("/cron")?.command.id, "cron");
  assert.ok(!suggest("/", false).some((c) => c.name === "cron"), "old names are not offered");
});

test("a path or an unknown word is a message, not a command", () => {
  assert.equal(resolve("/etc/hosts is wrong"), null);
  assert.equal(resolve("/host/home/umbrel"), null);
  assert.equal(resolve("/deploy it"), null);
  assert.equal(resolve("please /stop"), null);
});

console.log(`\ncommands: ${passed} passed`);
