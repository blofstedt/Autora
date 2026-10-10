/**
 * The organization: the agents there are, what each is for, who it reports to
 * and which agent it hands work to next.
 *
 * Autora starts with one agent, the lead, which is whatever answers in the
 * chat. The person adds others on the Organization page (a researcher, an
 * editor, a bookkeeper), each with its own task, a line on when it should be
 * called, and the agents that follow it in a sequence. The lead is told this
 * map every turn and can start any of them with the agents tool, so who does
 * what, and who comes after whom, is written down once rather than guessed.
 *
 * Stored as `agents.json`. Pure apart from that: the tool that runs an agent
 * lives with the turn loop in server.ts.
 */

import crypto from "node:crypto";
import { readDoc, saveDoc } from "./store";
import { dropMind, knowsAbout, mergeMind } from "./agentmind";
import { BOND_START, characterLine, draftCharacter, grown, saneTraits, suggestName, type Traits } from "./agentcharacter";

interface Agent {
  id: string;
  name: string;
  /** Its job title: "Researcher", "Editor". */
  role: string;
  /** What it is told to be and do when it is started. */
  instructions: string;
  /** In plain words, when the lead (or another agent) should call it. */
  when: string;
  /** The agent it reports to; null for the head of the organization. */
  reportsTo: string | null;
  /** Agents it hands its result to, in order. */
  next: string[];
  enabled: boolean;
  /** Its own shape (corners) and colour (hue, degrees) wherever the app draws
      it. Drawn at random when it is made, and never the same as another's. */
  look?: AgentLook;
  /** How much it has to say, 0.6 (reserved) to 1.4 (chatty): its own temper, drawn
      at random with its look. It scales how readily it speaks up in Threads. */
  social?: number;
  /** A line or two on who it is: how it works and talks, drawn from its expertise (server/agentcharacter.ts). */
  personality?: string;
  /** Its attributes, 0..100: the person can set them; teamwork grows with the work. */
  traits?: Traits;
  /** How well it works with each colleague, 0..100 by agent id; rises as work between them goes well. */
  bonds?: Record<string, number>;
  /** Tasks it has been started on, and how many of them it finished. */
  tasks?: { done: number; failed: number };
  /** The lead cannot be deleted or detached from the top. */
  builtin?: boolean;
  created: number;
  updated: number;
}

export const LEAD_ID = "agent_autora";

/** A temper between reserved and chatty. */
const temper = (random: () => number = Math.random) => Math.round((0.6 + random() * 0.8) * 100) / 100;

export interface AgentLook { sides: number; hue: number }

/** Shapes and hues the agents are drawn from. The triangle and the violet
    around 270 are Autora's own. 5 shapes x 12 hues is 60 looks, one per agent
    at the most there can be. */
const SIDES = [4, 5, 6, 7, 8];
const HUES = [0, 25, 50, 80, 120, 155, 185, 210, 235, 305, 330, 350];

/**
 * A look no other agent has, drawn at random: by preference a shape and a hue
 * that neither is yet used, then a new shape or a new hue alone, then (only when
 * all sixty are taken) anything.
 */
export function pickLook(taken: AgentLook[], random: () => number = Math.random): AgentLook {
  const all = SIDES.flatMap((sides) => HUES.map((hue) => ({ sides, hue })));
  const free = all.filter((l) => !taken.some((t) => t.sides === l.sides && t.hue === l.hue));
  const fresh = (l: AgentLook) => ({
    sides: !taken.some((t) => t.sides === l.sides),
    hue: !taken.some((t) => t.hue === l.hue),
  });
  const tiers = [
    free.filter((l) => fresh(l).sides && fresh(l).hue),
    free.filter((l) => fresh(l).sides || fresh(l).hue),
    free,
    all,
  ];
  const pool = tiers.find((t) => t.length) ?? all;
  return pool[Math.floor(random() * pool.length)];
}

const MAX_AGENTS = 60;
const MAX_NAME = 60;
const MAX_ROLE = 80;
const MAX_TEXT = 8000;
const MAX_WHEN = 1000;
const MAX_PERSONALITY = 600;
const MAX_NEXT = 12;

const DOC = "agents";
let roster: Agent[] | null = null;

export class AgentError extends Error {}

const agentId = () => `agent_${crypto.randomBytes(5).toString("hex")}`;
const clip = (v: unknown, max: number) => String(v ?? "").replace(/\u0000/g, "").trim().slice(0, max);

function lead(): Agent {
  const now = Date.now();
  return {
    id: LEAD_ID, name: "Autora", role: "Lead", builtin: true, enabled: true, reportsTo: null, next: [],
    instructions: "", when: "Everything, unless another agent is a better fit for the part of the job.",
    created: now, updated: now,
  };
}

function load(): Agent[] {
  if (roster) return roster;
  const raw = readDoc<unknown>(DOC);
  const list = Array.isArray(raw)
    ? raw.filter((a): a is Agent => !!a && typeof a === "object" && typeof (a as Agent).id === "string" && typeof (a as Agent).name === "string")
    : [];
  if (!list.some((a) => a.id === LEAD_ID)) list.unshift(lead());
  roster = list.map((a) => ({
    ...a,
    role: a.role ?? "", instructions: a.instructions ?? "", when: a.when ?? "",
    reportsTo: a.id === LEAD_ID ? null : (a.reportsTo ?? LEAD_ID),
    next: Array.isArray(a.next) ? a.next : [], enabled: a.enabled !== false,
  }));
  // Agents made before they had a look get one now, and keep it.
  let gave = false;
  for (const a of roster) {
    if (a.id === LEAD_ID) { delete a.look; a.social = 1; continue; }
    if (typeof a.social !== "number") { a.social = temper(); gave = true; }
    // Agents made before they had a character get one drawn from their expertise, and keep it.
    if (!a.personality || !a.traits) {
      const drawn = draftCharacter(a.role, a.instructions);
      a.personality = a.personality || drawn.personality;
      a.traits = { ...drawn.traits, ...(a.traits ?? {}) };
      gave = true;
    }
    const ok = a.look && SIDES.includes(a.look.sides) && Number.isFinite(a.look.hue);
    if (ok) continue;
    a.look = pickLook(roster.flatMap((o) => (o.look && o !== a ? [o.look] : [])));
    gave = true;
  }
  if (gave) saveDoc(DOC, () => roster);
  return roster;
}

function persist(agent?: Agent) {
  if (agent) agent.updated = Date.now();
  saveDoc(DOC, () => load());
}

export function listAgents(): Agent[] {
  return load();
}

export function getAgent(id: string): Agent | null {
  return load().find((a) => a.id === id) ?? null;
}

/** An agent by id or, failing that, by name (any case). */
export function findAgent(ref: unknown): Agent | null {
  const want = String(ref ?? "").trim();
  if (!want) return null;
  return getAgent(want) ?? load().find((a) => a.name.toLowerCase() === want.toLowerCase()) ?? null;
}

/** Everyone under `id`, however deep. */
function below(id: string): Set<string> {
  const out = new Set<string>();
  const walk = (of: string) => {
    for (const a of load()) if (a.reportsTo === of && !out.has(a.id)) { out.add(a.id); walk(a.id); }
  };
  walk(id);
  return out;
}

function sanePlace(id: string, reportsTo: unknown): string {
  const ref = clip(reportsTo, 80) || LEAD_ID;
  const boss = findAgent(ref);
  if (!boss) throw new AgentError(`There is no agent "${ref}" to report to.`);
  const to = boss.id;
  if (to === id || below(id).has(to)) throw new AgentError("An agent cannot report to itself or to someone beneath it.");
  return to;
}

function saneNext(id: string, raw: unknown): string[] {
  const refs = Array.isArray(raw) ? raw : typeof raw === "string" && raw.trim() ? raw.split(",") : [];
  const out: string[] = [];
  for (const ref of refs) {
    const found = findAgent(ref);
    if (!found) throw new AgentError(`There is no agent "${String(ref).trim()}" to hand work to.`);
    if (found.id !== id && !out.includes(found.id)) out.push(found.id);
  }
  return out.slice(0, MAX_NEXT);
}

export function createAgent(input: {
  name: unknown; role?: unknown; instructions?: unknown; when?: unknown;
  reportsTo?: unknown; next?: unknown; enabled?: unknown; personality?: unknown; traits?: unknown;
}): Agent {
  const name = clip(input.name, MAX_NAME);
  if (!name) throw new AgentError("An agent needs a name.");
  if (findAgent(name)) throw new AgentError(`An agent called "${name}" already exists.`);
  if (load().length >= MAX_AGENTS) throw new AgentError(`There are already ${MAX_AGENTS} agents; remove one first.`);
  const id = agentId();
  const now = Date.now();
  const agent: Agent = {
    id, name, role: clip(input.role, MAX_ROLE), instructions: clip(input.instructions, MAX_TEXT),
    when: clip(input.when, MAX_WHEN), reportsTo: sanePlace(id, input.reportsTo),
    next: [], enabled: input.enabled !== false, created: now, updated: now,
    look: pickLook(load().flatMap((o) => (o.look ? [o.look] : []))), social: temper(),
    bonds: {}, tasks: { done: 0, failed: 0 },
  };
  /* A personality comes from whoever made the agent, or else from its expertise. */
  const drawn = draftCharacter(agent.role, agent.instructions);
  agent.personality = clip(input.personality, MAX_PERSONALITY) || drawn.personality;
  agent.traits = { ...drawn.traits, ...saneTraits(input.traits) };
  load().push(agent);
  agent.next = saneNext(id, input.next);
  persist();
  return agent;
}

export function updateAgent(id: string, patch: {
  name?: unknown; role?: unknown; instructions?: unknown; when?: unknown;
  reportsTo?: unknown; next?: unknown; enabled?: unknown; personality?: unknown; traits?: unknown;
}): Agent {
  const agent = getAgent(id);
  if (!agent) throw new AgentError(`There is no agent "${id}".`);
  if (patch.name !== undefined) {
    const name = clip(patch.name, MAX_NAME);
    if (!name) throw new AgentError("An agent needs a name.");
    const clash = findAgent(name);
    if (clash && clash.id !== id) throw new AgentError(`An agent called "${name}" already exists.`);
    agent.name = name;
  }
  if (patch.role !== undefined) agent.role = clip(patch.role, MAX_ROLE);
  if (patch.instructions !== undefined) agent.instructions = clip(patch.instructions, MAX_TEXT);
  if (patch.when !== undefined) agent.when = clip(patch.when, MAX_WHEN);
  if (patch.reportsTo !== undefined && !agent.builtin) agent.reportsTo = sanePlace(id, patch.reportsTo);
  if (patch.next !== undefined) agent.next = saneNext(id, patch.next);
  if (patch.enabled !== undefined && !agent.builtin) agent.enabled = Boolean(patch.enabled);
  if (!agent.builtin) {
    if (patch.personality !== undefined) agent.personality = clip(patch.personality, MAX_PERSONALITY) || draftCharacter(agent.role, agent.instructions).personality;
    if (patch.traits !== undefined) agent.traits = { ...(agent.traits ?? draftCharacter(agent.role, agent.instructions).traits), ...saneTraits(patch.traits) };
  }
  persist(agent);
  return agent;
}

/** The agent goes; the ones that reported to it move up a level, and no one hands work to it any more. */
export function deleteAgent(id: string): boolean {
  const agent = getAgent(id);
  if (!agent) return false;
  if (agent.builtin) throw new AgentError("The lead cannot be removed.");
  const list = load();
  for (const a of list) {
    if (a.reportsTo === id) a.reportsTo = agent.reportsTo ?? LEAD_ID;
    a.next = a.next.filter((n) => n !== id);
    if (a.bonds) delete a.bonds[id];
  }
  list.splice(list.indexOf(agent), 1);
  dropMind(id);
  persist();
  return true;
}

/**
 * Two agents become one: `from` is folded into `into`, which keeps its own name
 * and place and takes on what `from` was for -- its instructions and its 'call it
 * when' are appended, what reported to `from` now reports to `into`, and the
 * agents that handed work to `from` now hand it to `into`. Neither may be the lead.
 */
export function mergeAgents(fromRef: unknown, intoRef: unknown): Agent {
  const from = findAgent(fromRef);
  const into = findAgent(intoRef);
  if (!from) throw new AgentError(`There is no agent "${String(fromRef ?? "").trim()}" to merge.`);
  if (!into) throw new AgentError(`There is no agent "${String(intoRef ?? "").trim()}" to merge into.`);
  if (from.id === into.id) throw new AgentError("An agent cannot be merged into itself.");
  if (from.builtin) throw new AgentError("The lead cannot be merged into another agent.");
  const join = (a: string, b: string, max: number, sep: string) =>
    clip(!b || a.includes(b) ? a : a ? `${a}${sep}${b}` : b, max);
  into.instructions = join(into.instructions, from.instructions, MAX_TEXT, "\n\n");
  into.when = join(into.when, from.when, MAX_WHEN, " Also: ");
  if (!into.role && from.role) into.role = clip(from.role, MAX_ROLE);
  const list = load();
  for (const a of list) {
    if (a.reportsTo === from.id) a.reportsTo = a.id === into.id ? (from.reportsTo ?? LEAD_ID) : into.id;
    a.next = [...new Set(a.next.map((n) => (n === from.id ? into.id : n)))].filter((n) => n !== a.id);
  }
  into.next = [...new Set([...into.next, ...from.next])].filter((n) => n !== into.id && n !== from.id).slice(0, MAX_NEXT);
  for (const a of list) {
    if (!a.bonds || a.bonds[from.id] === undefined) continue;
    if (a.id !== into.id) a.bonds[into.id] = Math.max(a.bonds[into.id] ?? 0, a.bonds[from.id]);
    delete a.bonds[from.id];
  }
  list.splice(list.indexOf(from), 1);
  mergeMind(from.id, into.id);
  persist(into);
  return into;
}

/**
 * Moves an agent: under a different boss (`reportsTo`), and/or to `position`
 * among the agents who report to the same boss (counting from 1). The order the
 * organization is drawn and listed in follows this.
 */
export function moveAgent(ref: unknown, to: { reportsTo?: unknown; position?: unknown }): Agent {
  const agent = findAgent(ref);
  if (!agent) throw new AgentError(`There is no agent "${String(ref ?? "").trim()}".`);
  if (agent.builtin) throw new AgentError("The lead stays at the top.");
  if (to.reportsTo !== undefined && String(to.reportsTo).trim()) {
    const boss = findAgent(to.reportsTo);
    if (!boss) throw new AgentError(`There is no agent "${String(to.reportsTo).trim()}" to report to.`);
    agent.reportsTo = sanePlace(agent.id, boss.id);
  }
  const place = Number(to.position);
  if (to.position !== undefined && Number.isFinite(place)) {
    const list = load();
    list.splice(list.indexOf(agent), 1);
    const siblings = list.filter((a) => a.reportsTo === agent.reportsTo);
    const before = siblings[Math.max(0, Math.floor(place) - 1)];
    if (before) list.splice(list.indexOf(before), 0, agent);
    else if (siblings.length) list.splice(list.indexOf(siblings[siblings.length - 1]) + 1, 0, agent);
    else list.push(agent);
  }
  persist(agent);
  return agent;
}

interface OrgNode { agent: Agent; reports: OrgNode[] }

/** The organization as a tree from the lead down. */
export function orgTree(): OrgNode {
  const list = load();
  const seen = new Set<string>();
  const build = (agent: Agent): OrgNode => {
    seen.add(agent.id);
    return { agent, reports: list.filter((a) => a.reportsTo === agent.id && !seen.has(a.id)).map(build) };
  };
  return build(list.find((a) => a.id === LEAD_ID)!);
}

const nameOf = (id: string) => getAgent(id)?.name ?? id;

/** One agent in a line, for the tool's list and the briefing. */
export function agentLine(a: Agent): string {
  const next = a.next.length ? ` Then hands to: ${a.next.map(nameOf).join(", ")}.` : "";
  const boss = a.reportsTo ? ` Reports to ${nameOf(a.reportsTo)}.` : "";
  const knows = knowsAbout(a.id);
  return `- ${a.name} (${a.id})${a.role ? `, ${a.role}` : ""}${a.enabled ? "" : " [switched off]"}.${boss}` +
    `${a.when ? ` Call it when: ${a.when}` : ""}${knows ? ` Its own mind holds ${knows}.` : ""}${next}`;
}

/** The lead may shape the organization itself, as a manager does. */
export const HIRING =
  "You run this organization, so you may shape it with the agents tool: hire (a new agent for a kind of work that keeps " +
  "coming up and that none of the agents covers), edit, merge (two agents that overlap become one), move (change who an " +
  "agent reports to, or its place in the order) and remove (an agent that is no longer needed). Prefer editing or " +
  "merging to hiring, give each agent a human first name that no one has (\"Sabrina\", not \"Legal Agent\") and a job title as its role (\"Family Lawyer\"), and one clear job and a 'call it when' that says when, and tell the person in a line " +
  "what you changed and why. Give each hire a personality that fits its expertise (personality: a line or two on how it works and talks; traits: warmth, candor, rigor, curiosity, humor, initiative from 0 to 100) -- a lawyer careful and plain-spoken, a support agent warm and patient; if you leave it out one is drawn from the role. Personalities and relationships then grow with the work, so do not reset them. Every other agent has a mind of its own, kept apart from yours, so a specialist is not confused by " +
  "what you know about everything else. As your own Mind grows, use agents domains to see where it clusters; when a body of " +
  "knowledge has become a subject of its own (a product, a site, a client, a field), hire an agent for it with knowledge (or " +
  "teach an existing one: agent, query) so that knowledge moves out of your Mind and into theirs, and from then on call that " +
  "agent for the subject instead of answering it from memory. What the person told you about themselves stays with you.";

/** What the lead is told about the organization, or "" while it is only itself. */
export function orgBriefing(): string {
  const others = load().filter((a) => a.id !== LEAD_ID);
  if (!others.length) return "";
  return [
    "Your organization (the Organization page): agents the person set up, each with its own task. Start one with the agents",
    "tool (action run, agent, task) when its 'call it when' fits the job, and let it run to the end before you rely on its",
    "answer. When it has a 'then hands to' list, those agents follow it in that order, each given the one before's result.",
    "Do not call an agent for what you can do in a step or two yourself.",
    HIRING,
    ...others.map(agentLine),
  ].join("\n");
}

/**
 * What an agent is told when it is started. `chain` is the names of the agents
 * that have already handed work down to it, so it knows where the task came from.
 */
export function agentBrief(agent: Agent, task: string, chain: string[]): string {
  const next = agent.next.map(getAgent).filter((a): a is Agent => !!a && a.enabled);
  return [
    `You are ${agent.name}${agent.role ? `, the ${agent.role}` : ""}, an agent in the person's organization.`,
    characterLine(agent, (id) => getAgent(id)?.name ?? null),
    agent.instructions ? `Your instructions:\n${agent.instructions}` : "",
    chain.length ? `This was handed to you by ${chain.join(" -> ")}.` : "",
    `Your task:\n${task}`,
    "Finish the task and end with a short report: what you did, what you found, what is left. Your reply is passed on as it is.",
    next.length
      ? `After you, ${next.map((a) => a.name).join(", then ")} will take your report forward; write it so they can start from it.`
      : "",
    "You may also post on Threads (the thread tool) about anything you noticed that is outside this task. When you learn something worth " +
      "keeping -- how something works, what to avoid, what a colleague is good at -- keep it with the agents tool (action note), so you have it next time. Your mind is your own: it is recalled for you as you work, and nothing in it is shared with the other agents or Autora.",
  ].filter(Boolean).join("\n\n");
}

/** Test hook: forget what was loaded, so a new state directory is read. */
export function resetAgents() {
  roster = null;
}

/** A first name no agent has: for a hire the lead or the person left unnamed. */
export function freshName(): string {
  return suggestName(load().map((a) => a.name));
}

/** An agent's task ended: its record, and a little experience for the teamwork it brings. */
export function recordWork(id: string, ok: boolean): void {
  const a = getAgent(id);
  if (!a || a.builtin) return;
  a.tasks = { done: (a.tasks?.done ?? 0) + (ok ? 1 : 0), failed: (a.tasks?.failed ?? 0) + (ok ? 0 : 1) };
  persist();
}

/**
 * Two agents worked together -- one handed work to the other, or they talked in
 * Threads -- and it went well or not. Each remembers the other a little better
 * (`bonds`), and each is a slightly better collaborator for it (`traits.teamwork`).
 * `weight` is how much the occasion counts. The lead keeps no bonds.
 */
export function recordCollab(aId: string, bId: string, ok: boolean, weight: number): void {
  if (aId === bId) return;
  let changed = false;
  for (const [me, other] of [[aId, bId], [bId, aId]]) {
    const a = getAgent(me);
    if (!a || a.builtin || !getAgent(other)) continue;
    a.bonds = { ...(a.bonds ?? {}), [other]: grown(a.bonds?.[other] ?? BOND_START, ok, weight) };
    if (a.traits) a.traits = { ...a.traits, teamwork: grown(a.traits.teamwork, ok, weight / 4) };
    changed = true;
  }
  if (changed) persist();
}

/** How much agent `id` warms to agent `other`, 0..100 (50 when they have not yet worked together). */
export function bondOf(id: string, other: string): number {
  return getAgent(id)?.bonds?.[other] ?? BOND_START;
}

