/**
 * MCP client against a real stdio server (tests/fixtures/mcp-echo-server.mjs).
 *
 *   npx tsx tests/mcp.test.ts
 */
import assert from "node:assert/strict";
import path from "node:path";
import { callMcpTool, connect, disconnect, mcpTools, statusOf, toolName } from "../server/mcp";
import { availableTools, findTool, runTool } from "../server/tools";

async function main() {
  const fixture = path.join(import.meta.dirname, "fixtures", "mcp-echo-server.mjs");
  const cfg = { id: "t1", name: "Echo Test", transport: "stdio" as const, command: process.execPath, args: [fixture], enabled: true };

  await connect(cfg);
  const status = statusOf("t1");
  assert.equal(status.status, "connected", status.error ?? "");
  assert.equal(status.version, "1.2.3");
  assert.deepEqual(status.tools.map((t) => t.name).sort(), ["add", "shout"]);
  console.log("  ok  connects over stdio and lists tools");

  const names = mcpTools().map((t) => t.name).sort();
  assert.deepEqual(names, ["mcp__echo_test__add", "mcp__echo_test__shout"]);
  assert.equal(mcpTools()[0].parameters.type, "object");
  console.log("  ok  tools are named for the agent and carry an object schema");

  assert.deepEqual(await callMcpTool(toolName("Echo Test", "add"), { a: 2, b: 40 }), { ok: true, text: "42" });
  assert.deepEqual(await callMcpTool(toolName("Echo Test", "shout"), { text: "hi" }), { ok: true, text: "HI" });
  console.log("  ok  calls tools and returns their text");

  const offered = (await availableTools()).map((t) => t.name);
  assert.ok(offered.includes("mcp__echo_test__add"), "offered to the model with the built-in tools");
  const spec = findTool("mcp__echo_test__add");
  assert.ok(spec && spec.group === "mcp");
  const outcome = await runTool(spec!, { a: 1, b: 2 }, {} as any);
  assert.equal(outcome.ok, true);
  assert.equal(outcome.summary, "3");
  console.log("  ok  offered to the agent and run through the normal tool dispatcher");

  await connect({ ...cfg, id: "t2", name: "Broken", command: "/nonexistent/binary" });
  assert.equal(statusOf("t2").status, "error");
  assert.ok(statusOf("t2").error);
  console.log("  ok  a server that cannot start reports an error and adds no tools");

  await connect({ ...cfg, enabled: false });
  assert.equal(statusOf("t1").status, "off");
  assert.equal(mcpTools().length, 0);
  console.log("  ok  disabling disconnects and removes its tools");

  await disconnect("t2");
  console.log("\n6 passed");
}

main().then(() => process.exit(0), (err) => { console.error(err); process.exit(1); });
