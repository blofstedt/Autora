/**
 * MCP servers the agent writes for itself: a few tools as JavaScript bodies
 * become a real stdio server file. The checks catch a typo in words before it
 * is a server that will not start, and the last cases start one for real and
 * talk to it as a client would.
 *
 *   npx tsx tests/mcpscript.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-mcpscript-"));

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

const tool = (over: Record<string, unknown> = {}) => ({
  name: "greet", description: "Say hello.", code: "return 'hello ' + (args.name || 'world');", ...over,
});

async function main() {
  const { checkTools, scriptDir, writeScriptServer } = await import("../server/mcpscript");

  console.log("checking the tools");
  await test("a good tool passes; none, too many, or not-a-list do not", () => {
    assert.equal(checkTools([tool()]), null);
    assert.match(checkTools([])!, /at least one tool/);
    assert.match(checkTools(Array.from({ length: 21 }, (_, i) => tool({ name: `t${i}` })))!, /At most 20/);
    assert.match(checkTools(null as never)!, /at least one tool/);
  });
  await test("names: letters first, then letters digits _ -, once each", () => {
    for (const bad of ["", "1abc", "has space", "semi;colon", "a".repeat(60), "dot.name"]) {
      assert.match(checkTools([tool({ name: bad })])!, /not a usable tool name/, bad);
    }
    assert.match(checkTools([tool(), tool()])!, /Two tools are called greet/);
    assert.equal(checkTools([tool({ name: "a-b_c9" })]), null);
  });
  await test("a tool needs a description and code, and the code has to parse", () => {
    assert.match(checkTools([tool({ description: "  " })])!, /needs a description/);
    assert.match(checkTools([tool({ code: "" })])!, /has no code/);
    assert.match(checkTools([tool({ code: "return (" })])!, /greet does not parse/);
    assert.equal(checkTools([tool({ code: "const r = await Promise.resolve(2); return r;" })]), null);
  });
  await test("code that tries to close its own function and add another is refused", () => {
    assert.match(checkTools([tool({ code: "}, evil: async () => {" })])!, /does not parse/);
  });

  console.log("the server it writes");
  await test("a name cannot break out of the header comment", () => {
    const file = writeScriptServer('bad\u2028process.exit(3)\nrequire("child_process")"', [tool()]);
    const text = fs.readFileSync(file, "utf8");
    const head = text.split(/[\r\n\u2028\u2029]/)[0];
    assert.match(head, /^\/\/ Written by Autora/);
    assert.ok(!text.includes("\u2028"), "no line separator survives into the file");
    assert.equal(spawnSyntaxOk(file), true);
  });
  await test("the file is private, under the settings, named for the server", () => {
    const file = writeScriptServer("My Home Lab!", [tool()]);
    assert.ok(file.startsWith(scriptDir()));
    assert.match(file, /my-home-lab[\\/]server\.cjs$/);
    assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  });
  await test("a bad set of tools throws the first problem instead of writing anything", () => {
    assert.throws(() => writeScriptServer("nothing", []), /at least one tool/);
    assert.equal(fs.existsSync(path.join(scriptDir(), "nothing")), false);
  });
  await test("started for real, it lists its tools and runs them, and an error is a result", async () => {
    const { Client } = await import("@modelcontextprotocol/sdk/client/index.js");
    const { StdioClientTransport } = await import("@modelcontextprotocol/sdk/client/stdio.js");
    const file = writeScriptServer("live", [
      tool({ parameters: { properties: { name: { type: "string" } }, required: ["name"] } }),
      tool({ name: "boom", description: "Always fails.", code: "throw new Error('nope');" }),
      tool({ name: "data", description: "Returns JSON.", code: "return { n: 2, env: typeof env.PATH };" }),
    ]);
    const client = new Client({ name: "test", version: "1.0.0" });
    await client.connect(new StdioClientTransport({ command: process.execPath, args: [file] }));
    try {
      const listed = await client.listTools();
      assert.deepEqual(listed.tools.map((t) => t.name), ["greet", "boom", "data"]);
      assert.deepEqual((listed.tools[0].inputSchema as { required?: string[] }).required, ["name"]);
      const hello: any = await client.callTool({ name: "greet", arguments: { name: "Ada" } });
      assert.equal(hello.content[0].text, "hello Ada");
      const failed: any = await client.callTool({ name: "boom", arguments: {} });
      assert.equal(failed.isError, true);
      assert.match(failed.content[0].text, /nope/);
      const json: any = await client.callTool({ name: "data", arguments: {} });
      assert.deepEqual(JSON.parse(json.content[0].text), { n: 2, env: "string" });
      const missing: any = await client.callTool({ name: "ghost", arguments: {} });
      assert.equal(missing.isError, true);
    } finally {
      await client.close();
    }
  });
  console.log(`\n${passed} mcpscript cases passed.`);
}

/** Whether node accepts the file's syntax, without running it. */
function spawnSyntaxOk(file: string): boolean {
  return spawnSync(process.execPath, ["--check", file]).status === 0;
}

main().catch((err) => { console.error(err); process.exit(1); });
