/**
 * The MCP (integrations) routes: listing the connected servers and the suggested
 * ones, adding, changing, reconnecting and removing them.
 *
 * These were part of server.ts, which held every route in the app alongside the
 * turn loop and the WebSocket stream. Nothing changed in the move except what it
 * can see: the server list it reads and writes arrives in `deps`, so this file
 * cannot reach back into server.ts unnoticed.
 */

import type { Express, Request, Response } from "express";
import type { McpServerConfig } from "../mcp";
import { MCP_CATALOG, connect as connectMcp, disconnect as disconnectMcp, statusOf as mcpStatus } from "../mcp";
import { existing as existingMcp, install as installMcp, planOffer } from "../mcpoffer";
import { suggested as mcpSuggested } from "../mcpcatalog";

const MASK = "••••••";

export function mcpRoutes(app: Express, deps: {
  /** The configured servers, read and written in place. */
  servers: McpServerConfig[];
  /** Persist the settings after a change. */
  save: () => void;
  /** Record a line in the Logs page. */
  log: (level: "debug" | "info" | "warn" | "error", topic: string, line: string) => void;
  /** Turn a stored secret name into its value, for ${secret:NAME} in configs. */
  secretFor: (name: string) => string | null;
  /** The names in the secret store, which a suggested server can ask for. */
  secretNames: () => string[];
  /** Recent session titles and the standing instruction, which the suggestion
      is read against. */
  suggestionSeed: () => string;
  /** Validate and normalise a posted config. */
  sane: (raw: unknown) => McpServerConfig;
}) {
  const { servers, save, log, secretNames, suggestionSeed, sane: saneMcp } = deps;
  const isSecretRef = (v: string) => /^(Bearer )?\$\{secret:[A-Za-z_][A-Za-z0-9_]*\}$/.test(v);
  const mcpView = () => servers.map((cfg) => ({
    ...cfg,
    // Values of env vars and headers are usually secrets: shown masked, and a
    // masked value sent back means "keep what you have".
    // A reference to the secret store is not itself a secret: shown as written.
    env: cfg.env ? Object.fromEntries(Object.entries(cfg.env).map(([k, v]) => [k, isSecretRef(v) ? v : MASK])) : undefined,
    headers: cfg.headers ? Object.fromEntries(Object.entries(cfg.headers).map(([k, v]) => [k, isSecretRef(v) ? v : MASK])) : undefined,
    ...mcpStatus(cfg.id),
  }));
  const keepMasked = (next: Record<string, string> | undefined, prev: Record<string, string> | undefined) => {
    if (!next) return next;
    const out: Record<string, string> = {};
    for (const [k, v] of Object.entries(next)) out[k] = v === MASK ? (prev?.[k] ?? "") : v;
    return out;
  };

  app.get("/api/mcp", (_req: Request, res: Response) => {
    res.json({ servers: mcpView(), catalog: MCP_CATALOG });
  });

  /**
   * Servers worth suggesting to this install, from what it already shows
   * about itself: a key in the secret store, or a word in what the person has
   * said. See suggested() in server/mcpcatalog.ts for what it weighs and why
   * an empty list is a fine answer.
   *
   * The text it reads is the standing instructions and the titles of recent
   * chats -- the two things here that are already about what this install is
   * for. It does not read the threads themselves: ranking a suggestion is not
   * worth walking every log on the disk for.
   */
  app.get("/api/mcp/suggested", (_req: Request, res: Response) => {
    const installed = servers.map((s) => s.name);
    const secrets = secretNames();
    const found = mcpSuggested({
      installed,
      secrets,
      text: suggestionSeed(),
      limit: 3,
    });
    res.json({
      suggested: found.map((e) => ({
        id: e.id,
        name: e.name,
        title: e.title,
        summary: e.summary,
        better: e.better,
        reason: e.reason,
        needs: (e.needs ?? []).map((n) => ({ env: n.env, label: n.label, optional: !!n.optional })),
      })),
    });
  });

  /**
   * Set one of them up, from the page rather than from the agent's card.
   *
   * The offer and the install are the same code the agent uses (see
   * server/mcpoffer.ts): planOffer builds it from the catalog id, install
   * writes the config and connects. Nothing here reaches past that, which is
   * why a suggestion cannot install something the offer path could not.
   */
  app.post("/api/mcp/suggested/:id/install", async (req: Request, res: Response) => {
    // The offer path wants the agent's one line on why; pressing the button
    // on the page is the person's own reason, so give it one. Without it every
    // "Set it up" failed with the agent's "say why" message.
    const plan = planOffer({ server: req.params.id, why: "Set up from the Integrations page." });
    if (typeof plan === "string") return res.status(400).json({ error: plan });
    if (existingMcp(plan.name)) {
      return res.status(400).json({ error: `There is already a server called "${plan.name}".` });
    }
    const outcome = await installMcp(plan);
    log("info", "mcp", `suggested server ${plan.name} installed from the MCP page: ${outcome.ok ? "connected" : "failed"}`);
    if (!outcome.ok) return res.status(400).json({ error: outcome.error ?? "It did not connect.", missing: outcome.missing });
    res.json({ ok: true, name: plan.name, tools: outcome.tools, missing: outcome.missing });
  });

  app.post("/api/mcp", async (req: Request, res: Response) => {
    const cfg = saneMcp({ ...req.body, id: undefined });
    if (!cfg) return res.status(400).json({ error: "A server needs a name." });
    if (servers.some((s) => s.name.toLowerCase() === cfg.name.toLowerCase())) {
      return res.status(400).json({ error: `There is already a server called "${cfg.name}".` });
    }
    servers.push(cfg);
    save();
    await connectMcp(cfg);
    res.json({ servers: mcpView(), catalog: MCP_CATALOG });
  });

  app.patch("/api/mcp/:id", async (req: Request, res: Response) => {
    const index = servers.findIndex((s) => s.id === req.params.id);
    if (index < 0) return res.status(404).json({ error: "No such server." });
    const prev = servers[index];
    const next = saneMcp({ ...prev, ...req.body, id: prev.id });
    if (!next) return res.status(400).json({ error: "A server needs a name." });
    next.env = keepMasked(next.env, prev.env);
    next.headers = keepMasked(next.headers, prev.headers);
    servers[index] = next;
    save();
    await connectMcp(next);
    res.json({ servers: mcpView(), catalog: MCP_CATALOG });
  });

  app.post("/api/mcp/:id/reconnect", async (req: Request, res: Response) => {
    const cfg = servers.find((s) => s.id === req.params.id);
    if (!cfg) return res.status(404).json({ error: "No such server." });
    await connectMcp(cfg);
    res.json({ servers: mcpView(), catalog: MCP_CATALOG });
  });

  app.delete("/api/mcp/:id", async (req: Request, res: Response) => {
    const cfg = servers.find((s) => s.id === req.params.id);
    if (!cfg) return res.status(404).json({ error: "No such server." });
    await disconnectMcp(cfg.id);
    /* In place, not filter: the caller holds this array as `state.mcpServers`,
       and replacing it here would leave the settings pointing at the old one. */
    servers.splice(0, servers.length, ...servers.filter((s) => s.id !== cfg.id));
    save();
    log("info", "mcp", `${cfg.name}: removed`);
    res.json({ servers: mcpView(), catalog: MCP_CATALOG });
  });
}
