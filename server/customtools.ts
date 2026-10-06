/**
 * Tools the agent wrote for itself.
 *
 * When the agent works out a sequence of commands it will need again -- check
 * the backup, rotate a log, pull a report -- it can save it as a tool with a
 * name, a description and parameters, and from then on it is offered like
 * any other tool. The script runs in the same shell the terminal tool uses,
 * with each argument in an environment variable (ARG_<NAME>) and all of them
 * as JSON in TOOL_ARGS, so a script never has to parse its arguments out of a
 * command line.
 *
 * They are offered as `my_<name>` so they cannot shadow a built-in tool, and
 * only while the terminal is available, since that is what runs them.
 */

import { readDoc, saveDoc } from "./store";

export interface CustomParam {
  name: string;
  description: string;
  required: boolean;
}

export interface CustomTool {
  name: string;
  description: string;
  params: CustomParam[];
  script: string;
  created: number;
  updated: number;
  /** The session it was written in. */
  session: string | null;
  /** Kept by the server: how it has gone. */
  runs: number;
  failures: number;
}

export const PREFIX = "my_";
const NAME = /^[a-z][a-z0-9_]{1,39}$/;
const PARAM = /^[a-z][a-z0-9_]{0,39}$/;

const tools: CustomTool[] = (() => {
  const stored = readDoc<CustomTool[]>("custom-tools");
  return Array.isArray(stored) ? stored : [];
})();

const save = () => saveDoc("custom-tools", () => tools);

/* Bumped whenever the set of custom tools changes, so a caller caching its
   tool list knows to rebuild. The turn loop offers these every round and must
   notice one the agent wrote mid-turn. */
let generation = 0;
export function customToolsGeneration(): number {
  return generation;
}

export function listCustomTools(): CustomTool[] {
  return tools;
}

export function getCustomTool(toolName: string): CustomTool | undefined {
  const bare = toolName.startsWith(PREFIX) ? toolName.slice(PREFIX.length) : toolName;
  return tools.find((t) => t.name === bare);
}

/**
 * The arguments a tool takes, out of whatever shape the model wrote them in.
 *
 * The schema asks for a list of {name, description, required}, and models
 * write a JSON Schema ({type: "object", properties: {...}, required: [...]})
 * or a plain map of name to description about as often. Reading only the list
 * saved those tools with no arguments at all, and the script then ran with
 * every $ARG_ empty and nothing said why. All of them are read here; anything
 * else is no arguments, as before.
 */
export function readParams(raw: unknown): { name: unknown; description?: unknown; required?: unknown }[] {
  if (Array.isArray(raw)) {
    return raw.map((item) => (typeof item === "string" ? { name: item } : (item as any)));
  }
  if (!raw || typeof raw !== "object") return [];
  const body = raw as Record<string, any>;
  const table = body.properties && typeof body.properties === "object" && !Array.isArray(body.properties)
    ? (body.properties as Record<string, any>)
    : body;
  const required = Array.isArray(body.required) ? body.required.map(String) : null;
  // A schema's own words are not arguments.
  const skip = table === body ? new Set(["type", "required", "additionalProperties", "description", "title", "$schema"]) : new Set<string>();
  return Object.entries(table)
    .filter(([key]) => !skip.has(key))
    .map(([key, value]) => {
      const detail = value && typeof value === "object" ? (value as Record<string, any>) : {};
      return {
        name: key,
        description: typeof value === "string" ? value : detail.description,
        required: required ? required.includes(key) : detail.required,
      };
    });
}

/** What the script reads that no argument provides: it would run with those empty. */
export function undeclaredArgs(script: string, params: CustomParam[]): string[] {
  const declared = new Set(params.map((p) => `ARG_${p.name.toUpperCase()}`));
  const used = script.match(/\$\{?(ARG_[A-Z0-9_]+)/g) ?? [];
  return [...new Set(used.map((u) => u.replace(/^\$\{?/, "")))].filter((n) => !declared.has(n));
}

/** Save a tool, or replace the one of the same name. Throws with the reason. */
export function defineCustomTool(input: {
  name: unknown; description: unknown; params?: unknown; script: unknown; session?: string | null;
}): { tool: CustomTool; replaced: boolean; warnings: string[] } {
  let name = String(input.name ?? "").trim().toLowerCase();
  if (name.startsWith(PREFIX)) name = name.slice(PREFIX.length);
  if (!NAME.test(name)) {
    throw new Error("A tool name is 2-40 lowercase letters, digits and underscores, starting with a letter.");
  }
  const description = String(input.description ?? "").trim();
  if (!description) throw new Error("Say what the tool does, for the model that will pick it.");
  const script = String(input.script ?? "").trim();
  if (!script) throw new Error("The tool needs a script to run.");
  const params: CustomParam[] = [];
  for (const raw of readParams(input.params)) {
    const pname = String((raw as any)?.name ?? "").trim().toLowerCase();
    if (!PARAM.test(pname)) throw new Error(`"${pname}" is not a usable parameter name.`);
    if (params.some((p) => p.name === pname)) throw new Error(`Parameter "${pname}" is named twice.`);
    params.push({
      name: pname,
      description: String((raw as any)?.description ?? "").trim(),
      required: (raw as any)?.required !== false,
    });
  }
  const now = Math.floor(Date.now() / 1000);
  const missing = undeclaredArgs(script, params);
  const warnings = missing.length
    ? [`The script reads ${missing.map((m) => "$" + m).join(", ")}, but no argument of that name is declared, so ${missing.length === 1 ? "it" : "they"} will always be empty. Declare ${missing.length === 1 ? "it" : "them"} in parameters and save again.`]
    : [];
  const existing = tools.find((t) => t.name === name);
  if (existing) {
    Object.assign(existing, { description, params, script, updated: now });
    save();
    return { tool: existing, replaced: true, warnings };
  }
  const tool: CustomTool = {
    name, description, params, script, created: now, updated: now,
    session: input.session ?? null, runs: 0, failures: 0,
  };
  tools.push(tool);
  generation += 1;
  save();
  return { tool, replaced: false, warnings };
}

export function deleteCustomTool(toolName: string): boolean {
  const tool = getCustomTool(toolName);
  if (!tool) return false;
  tools.splice(tools.indexOf(tool), 1);
  generation += 1;
  save();
  return true;
}

export function noteCustomRun(toolName: string, ok: boolean) {
  const tool = getCustomTool(toolName);
  if (!tool) return;
  tool.runs += 1;
  if (!ok) tool.failures += 1;
  save();
}

/** The environment a run gets: ARG_<NAME> per argument, TOOL_ARGS for all. */
export function customEnv(tool: CustomTool, args: Record<string, any>): Record<string, string> {
  const env: Record<string, string> = { TOOL_ARGS: JSON.stringify(args ?? {}) };
  for (const p of tool.params) {
    const v = args?.[p.name];
    if (v === undefined || v === null) continue;
    env[`ARG_${p.name.toUpperCase()}`] = typeof v === "string" ? v : JSON.stringify(v);
  }
  return env;
}

/** Missing required arguments, by name. */
export function missingArgs(tool: CustomTool, args: Record<string, any>): string[] {
  return tool.params.filter((p) => p.required && (args?.[p.name] === undefined || args?.[p.name] === "")).map((p) => p.name);
}
