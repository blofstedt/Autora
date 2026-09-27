/**
 * Standing agreements: things the person has already said yes to.
 *
 * The guard asks about a call when it thinks the call could destroy something
 * and the person did not ask for it -- and then asks again about the same
 * kind of thing the next time, and the time after that. That is the wrong
 * shape for work that is repeated: restarting the same container, re-running
 * the same deploy, clearing the same cache directory. Each of those is a
 * decision the person has already made.
 *
 * A rule here says: this tool, doing something whose words include this, is
 * agreed from now on. It is remembered, it is shown back to the person, and
 * it can be revoked -- a class of work, not a blank cheque.
 *
 * What a rule can never do: cover the irrecoverable tier. Formatting a disk,
 * wiping a Docker volume, force-pushing over main and deleting the whole tree
 * are asked about every single time, however many rules there are. Those are
 * checked in server/jev/guard.ts before the guard this one feeds, and this
 * file deliberately has no say in them.
 */

import { irreversible } from "./jev/guard";
import { readDoc, saveDoc } from "./store";

export interface Rule {
  id: string;
  /** The tool it covers: terminal, run_background, http_request. */
  tool: string;
  /** The words matched against the call: a command, a method and address. */
  match: string;
  /** Why it exists, in words the person will read back. */
  note: string;
  added: number;
  by: "agent" | "person";
  used: number;
  last_used: number | null;
}

/** Too short to be a class of anything, and too easy to match by accident. */
const MIN_MATCH = 8;
/** Rules beyond this go on the end and push nothing out; it is a sanity cap
    on a file that is shown in full, not a limit on autonomy. */
const MAX_RULES = 100;

let loaded = false;
let rules: Rule[] = [];

function all(): Rule[] {
  if (!loaded) {
    loaded = true;
    const stored = readDoc<Rule[]>("autonomy");
    rules = Array.isArray(stored) ? stored.filter((r) => r && typeof r.match === "string") : [];
  }
  return rules;
}

function persist() {
  saveDoc("autonomy", () => rules);
}

/** Tools whose calls can be covered, and the part of the call that is matched
    -- the command, or the method and address. Nothing else: a rule keyed on
    an argument it cannot see would be a rule nobody can reason about. */
export function matchText(name: string, args: Record<string, any>): string | null {
  if (name === "terminal" || name === "run_background") {
    const command = String(args?.command ?? "").trim();
    return command || null;
  }
  if (name === "http_request") {
    const method = String(args?.method ?? "GET").toUpperCase();
    const url = String(args?.url ?? "").trim();
    return url ? `${method} ${url}` : null;
  }
  return null;
}

export function listRules(): Rule[] {
  return [...all()].sort((a, b) => b.added - a.added);
}

export interface AddOutcome {
  rule?: Rule;
  error?: string;
}

export function addRule(input: { tool: string; match: string; note?: string; by?: "agent" | "person" }): AddOutcome {
  const tool = String(input.tool ?? "").trim();
  const match = String(input.match ?? "").trim();
  if (!match) return { error: "Say what the agreement covers." };
  if (match.length < MIN_MATCH) {
    return { error: `"${match}" is too short to be a class of work: give at least ${MIN_MATCH} characters of the command, so the agreement cannot cover something else by accident.` };
  }
  if (matchText(tool, { command: match, url: match }) === null) {
    return { error: `There is no pre-authorisation for ${tool || "that tool"}: only terminal, run_background and http_request calls can be covered, because those are the ones the guard asks about.` };
  }
  /* A rule must not be a way of saying yes in advance to something nothing
     can undo. Nothing that matches the irrecoverable tier can be covered. */
  const danger = irreversible(tool === "http_request" ? "http_request" : "terminal", { command: match, url: match });
  if (danger) {
    return { error: `${danger.what} is asked about every time, and no standing agreement can cover it.` };
  }
  if (all().some((r) => r.tool === tool && r.match.toLowerCase() === match.toLowerCase())) {
    return { error: "That is already agreed." };
  }
  const rule: Rule = {
    id: `allow-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 5)}`,
    tool,
    match,
    note: String(input.note ?? "").trim().slice(0, 200),
    added: Date.now(),
    by: input.by ?? "agent",
    used: 0,
    last_used: null,
  };
  const list = all();
  list.push(rule);
  if (list.length > MAX_RULES) list.splice(0, list.length - MAX_RULES);
  persist();
  return { rule };
}

export function revoke(id: string): boolean {
  const at = all().findIndex((r) => r.id === id.trim() || r.id === `allow-${id.trim()}`);
  if (at === -1) return false;
  all().splice(at, 1);
  persist();
  return true;
}

export function revokeAll(): number {
  const n = all().length;
  rules = [];
  persist();
  return n;
}

/**
 * The standing agreement that covers this call, if there is one.
 *
 * The longest match wins, so a narrow rule and a broad one do not fight: the
 * call is attributed to the most specific thing the person agreed to. Being
 * covered is recorded, because a rule nobody can see the use of is a rule
 * nobody will trust.
 */
export function covered(name: string, args: Record<string, any>): Rule | null {
  const text = matchText(name, args);
  if (!text) return null;
  let best: Rule | null = null;
  for (const rule of all()) {
    if (rule.tool !== name) continue;
    if (!text.toLowerCase().includes(rule.match.toLowerCase())) continue;
    if (!best || rule.match.length > best.match.length) best = rule;
  }
  if (best) {
    best.used += 1;
    best.last_used = Math.floor(Date.now() / 1000);
    persist();
  }
  return best;
}

/** What the next turn is told, so the agent uses an agreement instead of
    asking again about something already settled. Empty when there are none. */
export function autonomyBriefing(): string {
  const list = listRules();
  if (list.length === 0) return "";
  return [
    "Standing agreements -- things the person has already agreed to, so do not ask about them again:",
    ...list.map((r) =>
      `- ${r.tool}: anything containing "${r.match}"${r.note ? ` (${r.note})` : ""}` +
      `${r.used > 0 ? `, used ${r.used} time${r.used === 1 ? "" : "s"}` : ""}.`),
    "They cover the guard only. Nothing that cannot be undone is ever covered: that is still asked about every time.",
    "You may add one yourself with pre_authorise when you meet the same question twice; the person adds them by pressing \"Always allow this kind\" on an approval card. They are listed under Standing agreements in Scheduled tasks, where either of you can take one back.",
  ].join("\n");
}
