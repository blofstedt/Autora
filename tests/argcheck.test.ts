/**
 * Arguments are checked against the tool's schema before it runs.
 *
 *   npx tsx tests/argcheck.test.ts
 */
import assert from "node:assert/strict";
import { checkArgs } from "../server/argcheck";

const schema = {
  type: "object" as const,
  properties: { command: { type: "string" }, cwd: { type: "string" }, n: { type: "integer" }, mode: { type: "string", enum: ["a", "b"] } },
  required: ["command"],
};

console.log("argument check");
assert.equal(checkArgs("terminal", schema, { command: "ls" }), null);
assert.match(checkArgs("terminal", schema, {}) ?? "", /missing required "command" \(string\)/);
assert.match(checkArgs("terminal", schema, { command: 5 }) ?? "", /"command" must be string, got number/);
assert.equal(checkArgs("terminal", schema, { command: "x", extra: 1 }), null);
assert.match(checkArgs("terminal", schema, { command: "x", n: 1.5 }) ?? "", /"n" must be integer/);
assert.match(checkArgs("terminal", schema, { command: "x", mode: "c" }) ?? "", /one of "a", "b"/);
assert.match(checkArgs("terminal", schema, "ls") ?? "", /takes an object/);
console.log("  ok  argument check");
