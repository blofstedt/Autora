/**
 * Checking a call's arguments against the tool's own schema before it runs.
 *
 * Every tool declares a JSON Schema, and the vendors read it, but the handlers
 * coerce whatever arrives (`String(args.command ?? "")`), so a missing or
 * mistyped argument reaches the tool and comes back as a tool-specific
 * message, or does something. This says exactly what is wrong, in the
 * model's terms, before anything runs.
 */

import type { ToolSpec } from "./tools";

type Schema = ToolSpec["parameters"];

function kind(value: unknown): string {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  return typeof value;
}

function fits(want: string, value: unknown): boolean {
  if (want === "integer") return Number.isInteger(value);
  return kind(value) === want;
}

/** Null when the arguments fit; otherwise one message naming every problem. */
export function checkArgs(name: string, schema: Schema, args: unknown): string | null {
  if (kind(args) !== "object") {
    return `Not run: ${name} takes an object of arguments, got ${kind(args)}.`;
  }
  const given = args as Record<string, unknown>;
  const problems: string[] = [];
  for (const key of schema.required ?? []) {
    if (given[key] === undefined || given[key] === null) {
      const spec = schema.properties[key] ?? {};
      problems.push(`missing required "${key}"${spec.type ? ` (${spec.type})` : ""}`);
    }
  }
  for (const [key, value] of Object.entries(given)) {
    const spec = schema.properties[key];
    // An argument the schema doesn't name is ignored, as it always was: some
    // vendors and MCP servers send extras, and refusing them breaks working calls.
    if (!spec) continue;
    if (value === undefined || value === null) continue;
    const want = Array.isArray(spec.type) ? spec.type : spec.type ? [spec.type] : [];
    if (want.length > 0 && !want.some((t: string) => fits(t, value))) {
      problems.push(`"${key}" must be ${want.join(" or ")}, got ${kind(value)}`);
    } else if (Array.isArray(spec.enum) && !spec.enum.includes(value)) {
      problems.push(`"${key}" must be one of ${spec.enum.map((e: unknown) => JSON.stringify(e)).join(", ")}`);
    }
  }
  if (problems.length === 0) return null;
  const accepts = Object.entries(schema.properties)
    .map(([k, v]) => `${k}${schema.required?.includes(k) ? "*" : ""}: ${v?.type ?? "any"}`)
    .join(", ");
  return `Not run: ${name} was called wrongly -- ${problems.join("; ")}. Arguments (* required): ${accepts}.`;
}
