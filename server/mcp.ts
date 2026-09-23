/**
 * MCP servers: other programs' tools, offered to the agent as its own.
 *
 * Each configured server is a Model Context Protocol endpoint -- a command
 * Autora starts and talks to over stdio, or a URL it reaches over HTTP. Once
 * connected, the server's tools are listed and offered to the model beside
 * the built-in ones, named `mcp__<server>__<tool>` so the transcript says
 * where a call went. A server that fails to connect says why on the MCP page
 * and contributes nothing; the rest of the agent is unaffected.
 */

import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import { StreamableHTTPClientTransport } from "@modelcontextprotocol/sdk/client/streamableHttp.js";
import { SSEClientTransport } from "@modelcontextprotocol/sdk/client/sse.js";
import { log } from "./logs";

export interface McpServerConfig {
  id: string;
  name: string;
  transport: "stdio" | "http";
  /** stdio: the program and its arguments. */
  command?: string;
  args?: string[];
  env?: Record<string, string>;
  /** http: the endpoint, and any headers (an Authorization, usually). */
  url?: string;
  headers?: Record<string, string>;
  enabled: boolean;
}

export interface McpTool {
  /** The name the agent sees. */
  name: string;
  /** The name the server knows it by. */
  remote: string;
  server: string;
  description: string;
  parameters: { type: "object"; properties: Record<string, any>; required?: string[] };
}

export type McpStatus = "off" | "connecting" | "connected" | "error";

interface Live {
  status: McpStatus;
  error?: string;
  client?: Client;
  tools: McpTool[];
  connectedAt?: number;
  version?: string;
}

const CONNECT_TIMEOUT_MS = 30_000;
const CALL_TIMEOUT_MS = 120_000;

const live = new Map<string, Live>();

/** Tool names must fit every vendor: letters, digits, _ and -, at most 64. */
function slug(text: string): string {
  return text.toLowerCase().replace(/[^a-z0-9_-]+/g, "_").replace(/^_+|_+$/g, "") || "server";
}

export function toolName(serverName: string, tool: string): string {
  return `mcp__${slug(serverName)}__${tool.replace(/[^A-Za-z0-9_-]/g, "_")}`.slice(0, 64);
}

/** JSON Schema as MCP servers write it, trimmed to what every vendor accepts
    at the top level of a tool's parameters. */
function cleanSchema(schema: any): McpTool["parameters"] {
  const out: any = { type: "object", properties: {} };
  if (schema && typeof schema === "object") {
    if (schema.properties && typeof schema.properties === "object") out.properties = schema.properties;
    if (Array.isArray(schema.required) && schema.required.length) out.required = schema.required;
  }
  return out;
}

function withTimeout<T>(work: Promise<T>, ms: number, what: string): Promise<T> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${what} timed out after ${ms / 1000}s`)), ms);
    work.then((v) => { clearTimeout(timer); resolve(v); }, (e) => { clearTimeout(timer); reject(e); });
  });
}

export async function disconnect(id: string) {
  const entry = live.get(id);
  live.delete(id);
  try { await entry?.client?.close(); } catch { /* already gone */ }
}

/** Connect (or reconnect) one server and list its tools. Never throws: the
    outcome is recorded as the server's status. */
export async function connect(cfg: McpServerConfig): Promise<void> {
  await disconnect(cfg.id);
  if (!cfg.enabled) {
    live.set(cfg.id, { status: "off", tools: [] });
    return;
  }
  const entry: Live = { status: "connecting", tools: [] };
  live.set(cfg.id, entry);

  const client = new Client({ name: "autora", version: "1" });
  try {
    if (cfg.transport === "stdio") {
      if (!cfg.command?.trim()) throw new Error("No command to run.");
      const transport = new StdioClientTransport({
        command: cfg.command.trim(),
        args: cfg.args ?? [],
        env: { ...(process.env as Record<string, string>), ...(cfg.env ?? {}) },
        stderr: "pipe",
      });
      transport.stderr?.on("data", (chunk: Buffer) => {
        const text = chunk.toString().trim();
        if (text) log("debug", `mcp:${cfg.name}`, text);
      });
      await withTimeout(client.connect(transport), CONNECT_TIMEOUT_MS, "Connecting");
    } else {
      if (!cfg.url?.trim()) throw new Error("No URL to connect to.");
      const url = new URL(cfg.url.trim());
      const requestInit = { headers: cfg.headers ?? {} };
      try {
        await withTimeout(
          client.connect(new StreamableHTTPClientTransport(url, { requestInit })),
          CONNECT_TIMEOUT_MS, "Connecting",
        );
      } catch (streamErr) {
        // Older servers speak only the SSE transport.
        const fallback = new Client({ name: "autora", version: "1" });
        try {
          await withTimeout(
            fallback.connect(new SSEClientTransport(url, { requestInit })),
            CONNECT_TIMEOUT_MS, "Connecting",
          );
        } catch {
          throw streamErr;
        }
        entry.client = fallback;
      }
    }
    entry.client ??= client;

    const tools: McpTool[] = [];
    let cursor: string | undefined;
    do {
      const page = await withTimeout(entry.client.listTools(cursor ? { cursor } : {}), CONNECT_TIMEOUT_MS, "Listing tools");
      for (const t of page.tools) {
        tools.push({
          name: toolName(cfg.name, t.name),
          remote: t.name,
          server: cfg.id,
          description: `[MCP: ${cfg.name}] ${t.description ?? t.name}`.slice(0, 1024),
          parameters: cleanSchema(t.inputSchema),
        });
      }
      cursor = page.nextCursor;
    } while (cursor);

    if (live.get(cfg.id) !== entry) { await entry.client.close().catch(() => undefined); return; }
    entry.tools = tools;
    entry.status = "connected";
    entry.connectedAt = Date.now();
    entry.version = entry.client.getServerVersion()?.version;
    log("info", "mcp", `${cfg.name}: connected, ${tools.length} tool${tools.length === 1 ? "" : "s"}`);
  } catch (err: any) {
    entry.status = "error";
    // Node reports every network failure as "fetch failed"; the cause says which.
    const cause = err?.cause?.code ?? err?.cause?.message;
    entry.error = err?.message === "fetch failed" && cause
      ? `Could not reach ${cfg.url} (${cause}).`
      : err?.message ?? String(err);
    entry.tools = [];
    log("error", "mcp", `${cfg.name}: ${entry.error}`);
    try { await (entry.client ?? client).close(); } catch { /* nothing to close */ }
    entry.client = undefined;
  }
}

export function statusOf(id: string) {
  const entry = live.get(id);
  return {
    status: entry?.status ?? ("off" as McpStatus),
    error: entry?.error ?? null,
    tools: (entry?.tools ?? []).map((t) => ({ name: t.remote, description: t.description.replace(/^\[MCP: [^\]]*\] /, "") })),
    connected_at: entry?.connectedAt ?? null,
    version: entry?.version ?? null,
  };
}

/** Every tool from every connected server, for the model's schema. */
export function mcpTools(): McpTool[] {
  const out: McpTool[] = [];
  for (const entry of live.values()) if (entry.status === "connected") out.push(...entry.tools);
  return out;
}

export function findMcpTool(name: string): McpTool | undefined {
  return mcpTools().find((t) => t.name === name);
}

/** Run a tool on its server. Text parts come back joined; anything else is
    named so the model knows it was there. */
export async function callMcpTool(
  name: string, args: Record<string, any>,
): Promise<{ ok: boolean; text: string }> {
  const tool = findMcpTool(name);
  if (!tool) return { ok: false, text: `The MCP tool "${name}" is not connected any more.` };
  const client = live.get(tool.server)?.client;
  if (!client) return { ok: false, text: "Its server is not connected." };
  const result: any = await withTimeout(
    client.callTool({ name: tool.remote, arguments: args }),
    CALL_TIMEOUT_MS, `${tool.remote}`,
  );
  const parts: string[] = [];
  for (const c of result?.content ?? []) {
    if (c.type === "text") parts.push(c.text);
    else if (c.type === "resource" && c.resource?.text) parts.push(c.resource.text);
    else parts.push(`[${c.type}${c.mimeType ? ` ${c.mimeType}` : ""} omitted]`);
  }
  if (result?.structuredContent && parts.length === 0) parts.push(JSON.stringify(result.structuredContent));
  return { ok: !result?.isError, text: parts.join("\n") || "(no output)" };
}

/** Servers worth offering one click away. Each only pre-fills the form. */
export interface McpCatalogEntry {
  name: string;
  transport: "stdio";
  command: string;
  args: string[];
  note: string;
}

export const MCP_CATALOG: McpCatalogEntry[] = [
  {
    name: "filesystem", transport: "stdio", command: "npx",
    args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
    note: "Read and write files under the directories you list (edit the last argument).",
  },
  {
    name: "memory", transport: "stdio", command: "npx",
    args: ["-y", "@modelcontextprotocol/server-memory"],
    note: "A separate knowledge-graph memory the agent can build and query.",
  },
  {
    name: "sequential-thinking", transport: "stdio", command: "npx",
    args: ["-y", "@modelcontextprotocol/server-sequential-thinking"],
    note: "A structured step-by-step reasoning tool.",
  },
  {
    name: "everything", transport: "stdio", command: "npx",
    args: ["-y", "@modelcontextprotocol/server-everything"],
    note: "The MCP reference server: every feature, for testing a connection.",
  },
];
