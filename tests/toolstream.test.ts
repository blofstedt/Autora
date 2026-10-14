/**
 * Tool calls streamed by vendors that bend the OpenAI wire format (GLM among
 * them) must still come out as whole calls with their arguments intact.
 *
 *   npx tsx tests/toolstream.test.ts
 */
import assert from "node:assert/strict";
import { addToolDelta, parseArgs, type BuildingCall } from "../server/llm";

const fold = (parts: any[]) => {
  const m = new Map<number, BuildingCall>();
  for (const p of parts) addToolDelta(m, p);
  return [...m.values()];
};
const fn = (name: string | undefined, args: string | undefined) => ({ function: { name, arguments: args } });

// standard: id+name once, then fragments
let r = fold([{ index: 0, id: "a", ...fn("agents", "") }, { index: 0, ...fn(undefined, '{"action":') }, { index: 0, ...fn(undefined, '"list"}') }]);
assert.deepEqual(r, [{ id: "a", name: "agents", args: '{"action":"list"}' }]);

// name repeated in every chunk
r = fold([{ index: 0, id: "a", ...fn("notebook", '{"action"') }, { index: 0, ...fn("notebook", ':"list"}') }]);
assert.equal(r[0].name, "notebook");
assert.equal(r[0].args, '{"action":"list"}');

// cumulative arguments
r = fold([{ index: 0, id: "a", ...fn("agents", '{"act') }, { index: 0, ...fn("agents", '{"action":"list"}') }]);
assert.equal(r[0].args, '{"action":"list"}');

// two parallel calls on the same index, told apart by id
r = fold([{ index: 0, id: "a", ...fn("agents", '{"action":"list"}') }, { index: 0, id: "b", ...fn("notebook", '{"action":"list"}') }]);
assert.equal(r.length, 2);
assert.deepEqual(r.map((c) => c.name), ["agents", "notebook"]);

// arguments as an object
r = fold([{ index: 0, id: "a", function: { name: "agents", arguments: { action: "list" } } }]);
assert.equal(r[0].args, '{"action":"list"}');

// double-encoded and fenced arguments
assert.deepEqual(parseArgs(JSON.stringify('{"action":"list"}')), { action: "list" });
assert.deepEqual(parseArgs('```json\n{"action":"list"}\n```'), { action: "list" });
assert.deepEqual(parseArgs("{broken"), {});

console.log("toolstream: ok");
