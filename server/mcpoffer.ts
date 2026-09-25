/**
 * The agent offering an MCP server, and setting it up on a yes.
 *
 * Three kinds of server can be offered: one from the catalog (mcpcatalog.ts),
 * any MCP server published on npm or reachable at a URL, and one the agent
 * writes itself (mcpscript.ts). Whatever the kind, the person sees one card
 * saying what it is, why it beats what the agent would otherwise do, what
 * will run, and which keys it needs -- and nothing is installed until they
 * tap "Set it up". Keys typed on the card go straight to the secret store;
 * the config only ever refers to them by name.
 *
 * An offer turned down is not made again in the same session: a helper that
 * keeps asking is not helping.
 */

import { connect, statusOf, type McpServerConfig } from "./mcp";
import { CATALOG, catalogEntry, fillParams, matchCatalog, secretRefs, type CatalogNeed } from "./mcpcatalog";
import { writeScriptServer, checkTools, type ScriptTool } from "./mcpscript";
import { save, saneMcp, secretFor, state } from "./state";

export interface OfferNeed extends CatalogNeed {
  /** Already in the secret store. */
  set: boolean;
}

export interface OfferPlan {
  name: string;
  title: string;
  summary: string;
  why: string;
  /** What will run, said plainly for the card. */
  runs: string;
  kind: "catalog" | "package" | "remote" | "script";
  needs: OfferNeed[];
  /** The config to save, made only once the person has said yes. */
  build: () => Omit<McpServerConfig, "id">;
}

/** Offers turned down, per session. */
const declined = new Map<string, Set<string>>();

export function wasDeclined(session: string, name: string): boolean {
  return declined.get(session)?.has(name.toLowerCase()) ?? false;
}
export function noteDeclined(session: string, name: string) {
  const set = declined.get(session) ?? new Set<string>();
  set.add(name.toLowerCase());
  declined.set(session, set);
}

const hasSecret = (name: string) => Boolean((secretFor(name) ?? "").trim());

function needsFrom(raw: unknown): CatalogNeed[] {
  if (!Array.isArray(raw)) return [];
  return raw
    .map((n: any) => ({
      env: String(n?.env ?? "").trim().toUpperCase(),
      label: String(n?.label ?? n?.env ?? "").trim(),
      url: n?.url ? String(n.url) : undefined,
      hint: n?.hint ? String(n.hint) : undefined,
    }))
    .filter((n) => /^[A-Z_][A-Z0-9_]*$/.test(n.env) && n.label)
    .slice(0, 6);
}

const withState = (needs: CatalogNeed[]): OfferNeed[] => needs.map((n) => ({ ...n, set: hasSecret(n.env) }));

/**
 * Turn the agent's arguments into an offer, or say what is wrong with them.
 */
export function planOffer(args: Record<string, any>): OfferPlan | string {
  const why = String(args.why ?? "").trim();
  if (!why) return "Say in one line why this server is better for what they asked (the `why` argument).";

  // A catalog server.
  if (args.server) {
    const entry = catalogEntry(String(args.server));
    if (!entry) {
      return `There is no catalog server called "${args.server}". Known: ${CATALOG.map((e) => e.id).join(", ")}. ` +
        "For anything else, offer it by `package` (an npm MCP server), `url`, or write one with `tools`.";
    }
    const params: Record<string, string> = {};
    for (const p of entry.params ?? []) if (args[p.name] !== undefined) params[p.name] = String(args[p.name]);
    const filled = fillParams(entry, params);
    return {
      name: entry.name,
      title: entry.title,
      summary: entry.summary,
      why,
      runs: `${entry.command} ${filled.filter((a) => !a.startsWith("${secret:")).join(" ")}`,
      kind: "catalog",
      needs: withState(entry.needs ?? []),
      build: () => ({
        name: entry.name, transport: "stdio", command: entry.command, args: filled,
        env: entry.env, enabled: true, origin: "agent", note: entry.summary,
      }),
    };
  }

  const name = String(args.name ?? "").trim().toLowerCase().replace(/[^a-z0-9_-]+/g, "_").slice(0, 40);
  if (!name) return "A server that is not in the catalog needs a short `name`.";
  const title = String(args.title ?? args.name).trim().slice(0, 60);
  const summary = String(args.summary ?? "").trim().slice(0, 200) || title;
  const needs = needsFrom(args.needs);
  const env = Object.fromEntries(needs.map((n) => [n.env, `\${secret:${n.env}}`]));

  // One the agent writes itself.
  if (Array.isArray(args.tools)) {
    const tools = args.tools as ScriptTool[];
    const problem = checkTools(tools);
    if (problem) return problem;
    return {
      name, title, summary, why,
      runs: `A small server I wrote with ${tools.length} tool${tools.length === 1 ? "" : "s"}: ${tools.map((t) => t.name).join(", ")}`,
      kind: "script",
      needs: withState(needs),
      build: () => ({
        name, transport: "stdio", command: process.execPath, args: [writeScriptServer(name, tools)],
        env, enabled: true, origin: "agent", note: summary,
      }),
    };
  }

  // A remote server.
  if (args.url) {
    let url: URL;
    try { url = new URL(String(args.url)); } catch { return `"${args.url}" is not a URL.`; }
    if (!/^https?:$/.test(url.protocol)) return "Only http and https servers can be reached.";
    const auth = needs[0];
    return {
      name, title, summary, why,
      runs: `A remote server at ${url.origin}${url.pathname}`,
      kind: "remote",
      needs: withState(needs),
      build: () => ({
        name, transport: "http", url: url.toString(),
        headers: auth ? { Authorization: `Bearer \${secret:${auth.env}}` } : undefined,
        enabled: true, origin: "agent", note: summary,
      }),
    };
  }

  // A published npm package.
  if (args.package) {
    const pkg = String(args.package).trim();
    if (!/^(@[a-z0-9][\w.-]*\/)?[a-z0-9][\w.-]*(@[\w.^~-]+)?$/i.test(pkg)) return `"${pkg}" does not look like an npm package name.`;
    const extra = Array.isArray(args.args) ? args.args.map((a: unknown) => String(a)).slice(0, 12) : [];
    return {
      name, title, summary, why,
      runs: `npx -y ${pkg}${extra.length ? ` ${extra.join(" ")}` : ""}`,
      kind: "package",
      needs: withState(needs),
      build: () => ({
        name, transport: "stdio", command: "npx", args: ["-y", pkg, ...extra],
        env, enabled: true, origin: "agent", note: summary,
      }),
    };
  }

  return "Name what to set up: `server` (from the catalog), `package`, `url`, or `tools` for one you write.";
}

/** An existing server by this name, if any. */
export function existing(name: string): McpServerConfig | undefined {
  return state.mcpServers.find((s) => s.name.toLowerCase() === name.toLowerCase());
}

/** Save and connect. Replaces a server of the same name the agent made before. */
export async function install(plan: OfferPlan): Promise<{ ok: boolean; error: string | null; tools: string[]; missing: string[] }> {
  const draft = saneMcp(plan.build());
  if (!draft) return { ok: false, error: "The server could not be described.", tools: [], missing: [] };
  const before = existing(draft.name);
  const cfg: McpServerConfig = before ? { ...draft, id: before.id } : draft;
  state.mcpServers = before
    ? state.mcpServers.map((s) => (s.id === before.id ? cfg : s))
    : [...state.mcpServers, cfg];
  save();
  await connect(cfg);
  const status = statusOf(cfg.id);
  const missing = secretRefs([
    ...Object.values(cfg.env ?? {}), ...(cfg.args ?? []), ...Object.values(cfg.headers ?? {}), cfg.url,
  ]).filter((n) => !hasSecret(n));
  return {
    ok: status.status === "connected",
    error: status.error,
    tools: status.tools.map((t) => t.name),
    missing,
  };
}

/** What the agent is told when it asks what MCP servers there are. */
export function overview(topic = ""): string {
  const lines: string[] = [];
  if (state.mcpServers.length) {
    lines.push("Set up on this machine:");
    for (const cfg of state.mcpServers) {
      const s = statusOf(cfg.id);
      lines.push(
        `- ${cfg.name} (${s.status}${s.error ? `: ${s.error}` : ""})` +
        (s.tools.length ? ` -- tools: ${s.tools.map((t) => `mcp__${cfg.name.toLowerCase().replace(/[^a-z0-9_-]+/g, "_")}__${t.name}`).join(", ")}` : "") +
        (cfg.origin === "agent" ? " [set up by you]" : ""),
      );
    }
  } else {
    lines.push("No MCP servers are set up yet.");
  }
  const matched = topic.trim() ? matchCatalog(topic, 4) : [];
  const shown = matched.length ? matched : CATALOG;
  lines.push("", matched.length ? `Catalog servers that fit "${topic.trim()}":` : "Catalog servers you can offer (mcp_offer server=<id>):");
  for (const e of shown) {
    const needs = e.needs?.length ? ` Needs: ${e.needs.map((n) => `${n.label}${hasSecret(n.env) ? " (already saved)" : ""}`).join(", ")}.` : " No key needed.";
    lines.push(`- ${e.id}: ${e.summary} Better than the browser because: ${e.better}${needs}`);
  }
  lines.push(
    "",
    "Anything else can be offered too: an MCP server published on npm (package=...), a remote one (url=...), " +
      "or one you write yourself (tools=[...], each a short JavaScript body) when a service has an API but no server.",
  );
  return lines.join("\n");
}
