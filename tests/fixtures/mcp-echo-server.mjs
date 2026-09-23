// A minimal stdio MCP server for tests: two tools, add and shout.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";

const server = new McpServer({ name: "echo", version: "1.2.3" });
server.tool("add", "Add two numbers", { a: z.number(), b: z.number() },
  async ({ a, b }) => ({ content: [{ type: "text", text: String(a + b) }] }));
server.tool("shout", "Upper-case some text", { text: z.string() },
  async ({ text }) => ({ content: [{ type: "text", text: text.toUpperCase() }] }));
await server.connect(new StdioServerTransport());
