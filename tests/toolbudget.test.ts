/**
 * What every model call carries before the conversation: the tool schemas of
 * the default set and the capability briefing.
 *
 * Measured at 0.9.159: 51 tools, 44 KB of schema (~11k tokens), and a 16 KB
 * briefing (~4k tokens). It is paid on every cache miss and in full by vendors
 * that do not cache, so growth should be a decision rather than a drift:
 * raise the budget here on purpose, in the change that adds the weight.
 * (docs/REVIEW.md M1)
 *
 *   npx tsx tests/toolbudget.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

process.env.AUTORA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), "autora-budget-"));

const { availableTools, capabilityBriefing } = await import("../server/tools");
const { withoutUnloaded } = await import("../server/toolload");

const SCHEMA_BUDGET_CHARS = 48_000;
const BRIEFING_BUDGET_CHARS = 17_500;

console.log("tool budget");

const shown = withoutUnloaded(await availableTools() as any[], new Set());
const schema = shown.reduce(
  (n, t: any) => n + JSON.stringify({ name: t.name, description: t.description, parameters: t.parameters }).length, 0);
console.log(`  ${shown.length} tools, ${schema} chars of schema (~${Math.round(schema / 4)} tokens)`);
assert.ok(schema <= SCHEMA_BUDGET_CHARS, `the default tool set is ${schema} chars; the budget is ${SCHEMA_BUDGET_CHARS}`);
console.log("  ok  the default tool set is within its budget");

const briefing = (await capabilityBriefing()).length;
console.log(`  the briefing is ${briefing} chars (~${Math.round(briefing / 4)} tokens)`);
assert.ok(briefing <= BRIEFING_BUDGET_CHARS, `the briefing is ${briefing} chars; the budget is ${BRIEFING_BUDGET_CHARS}`);
console.log("  ok  the capability briefing is within its budget");

console.log("2 passed");
process.exit(0);
