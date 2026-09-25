/**
 * MCP servers the agent writes itself.
 *
 * When no ready-made server fits -- an internal API, a home-lab service, a
 * vendor without one -- the agent can describe a few tools, each a short
 * piece of JavaScript, and this turns them into a real stdio MCP server file
 * beside the settings. It is then offered and connected like any other, so
 * its tools show up as mcp__<name>__<tool> and on the Integrations page.
 *
 * The file is generated from a fixed template: the agent supplies only each
 * tool's name, description, JSON schema and function body. The body is
 * syntax-checked here, so a typo is reported to the agent straight away
 * rather than as a server that will not start.
 */

import fs from "node:fs";
import path from "node:path";
import { createRequire } from "node:module";
import { stateDir } from "./state";

export interface ScriptTool {
  name: string;
  description: string;
  /** JSON Schema for the arguments, an object schema. */
  parameters?: { type?: string; properties?: Record<string, unknown>; required?: string[] };
  /** The body of `async (args, env) => { ... }`; returns a string or JSON. */
  code: string;
}

const AsyncFunction = Object.getPrototypeOf(async () => undefined).constructor as new (
  ...args: string[]
) => (...a: unknown[]) => Promise<unknown>;

const TOOL_NAME = /^[a-zA-Z][a-zA-Z0-9_-]{0,48}$/;

/** Where the SDK's CommonJS build is, so the generated file can require it. */
function sdkPaths(): { server: string; stdio: string; types: string } {
  const bases = [process.argv[1], path.join(process.cwd(), "package.json")].filter(Boolean) as string[];
  let lastError: unknown;
  for (const base of bases) {
    try {
      const req = createRequire(path.resolve(base));
      return {
        server: req.resolve("@modelcontextprotocol/sdk/server/index.js"),
        stdio: req.resolve("@modelcontextprotocol/sdk/server/stdio.js"),
        types: req.resolve("@modelcontextprotocol/sdk/types.js"),
      };
    } catch (err) {
      lastError = err;
    }
  }
  throw new Error(`The MCP SDK could not be found: ${String((lastError as Error)?.message ?? lastError)}`);
}

export function scriptDir(): string {
  return path.join(stateDir(), "mcp-servers");
}

/** Check the tools; the first problem, in words, or null. */
export function checkTools(tools: ScriptTool[]): string | null {
  if (!Array.isArray(tools) || tools.length === 0) return "A server needs at least one tool.";
  if (tools.length > 20) return "At most 20 tools per server.";
  const seen = new Set<string>();
  for (const tool of tools) {
    if (!TOOL_NAME.test(tool?.name ?? "")) return `"${tool?.name}" is not a usable tool name (letters, digits, _ and -).`;
    if (seen.has(tool.name)) return `Two tools are called ${tool.name}.`;
    seen.add(tool.name);
    if (!String(tool.description ?? "").trim()) return `${tool.name} needs a description.`;
    if (!String(tool.code ?? "").trim()) return `${tool.name} has no code.`;
    try {
      new AsyncFunction("args", "env", tool.code);
    } catch (err: any) {
      return `${tool.name} does not parse: ${err?.message ?? err}`;
    }
  }
  return null;
}

/** Write the server and return the path of the file to run with node. */
export function writeScriptServer(name: string, tools: ScriptTool[]): string {
  const problem = checkTools(tools);
  if (problem) throw new Error(problem);
  const sdk = sdkPaths();
  const slug = name.toLowerCase().replace(/[^a-z0-9_-]+/g, "-").replace(/^-+|-+$/g, "") || "server";
  const dir = path.join(scriptDir(), slug);
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });

  const listed = tools.map((t) => ({
    name: t.name,
    description: t.description.trim(),
    inputSchema: {
      type: "object",
      properties: t.parameters?.properties ?? {},
      ...(t.parameters?.required?.length ? { required: t.parameters.required } : {}),
    },
  }));
  const handlers = tools
    .map((t) => `  ${JSON.stringify(t.name)}: async (args, env) => {\n${t.code}\n  },`)
    .join("\n");

  const source = `// Written by Autora for "${name.replace(/[\r\n"]/g, " ")}". Regenerated if it is offered again.
"use strict";
const { Server } = require(${JSON.stringify(sdk.server)});
const { StdioServerTransport } = require(${JSON.stringify(sdk.stdio)});
const { ListToolsRequestSchema, CallToolRequestSchema } = require(${JSON.stringify(sdk.types)});

const TOOLS = ${JSON.stringify(listed, null, 2)};

const HANDLERS = {
${handlers}
};

const server = new Server({ name: ${JSON.stringify(slug)}, version: "1.0.0" }, { capabilities: { tools: {} } });
server.setRequestHandler(ListToolsRequestSchema, async () => ({ tools: TOOLS }));
server.setRequestHandler(CallToolRequestSchema, async (request) => {
  const run = HANDLERS[request.params.name];
  if (!run) return { isError: true, content: [{ type: "text", text: "No such tool: " + request.params.name }] };
  try {
    const out = await run(request.params.arguments || {}, process.env);
    const text = typeof out === "string" ? out : JSON.stringify(out, null, 2);
    return { content: [{ type: "text", text: text === undefined ? "(done)" : text }] };
  } catch (err) {
    return { isError: true, content: [{ type: "text", text: String((err && err.message) || err) }] };
  }
});
server.connect(new StdioServerTransport()).catch((err) => {
  process.stderr.write(String(err) + "\\n");
  process.exit(1);
});
`;
  const file = path.join(dir, "server.cjs");
  fs.writeFileSync(file, source, { mode: 0o600 });
  return file;
}
