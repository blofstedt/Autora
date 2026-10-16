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
import { BOND_START, bornTraits, developed, grown, readTraits, suggestName, type Traits } from "./agentcharacter";

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
  /** The shape of its personality, five points 0..100: genial when it is made, then grown by how it talks in Threads
      (server/agentcharacter.ts). Nobody sets it, and it is told to the agent only when it speaks in Threads. */
  traits?: Traits;
  /** Set once the agent has been through the move to a personality nobody can set: until then it is born again, genial. */
  character?: 2;
  /** How well it works with each colleague, 0..100 by agent id; rises as work between them goes well. */
  bonds?: Record<string, number>;
  /** Tasks it has been started on, and how many of them it finished. */
  tasks?: { done: number; failed: number };
  /** The model it builds with, chosen by the person on the Organization page; absent for the main model.
      Held with the provider it was chosen for: models are named per vendor, so it only applies while that
      provider is the one in use (see agentModelFor in server/roles.ts). The lead has none: its model is Settings'. */
  model?: AgentModel;
  /** The lead cannot be deleted or detached from the top. */
  builtin?: boolean;
  created: number;
  updated: number;
}

export const LEAD_ID = "agent_autora";

interface AgentModel { provider: string; model: string }

/** A temper between reserved and chatty. */
const temper = (random: () => number = Math.random) => Math.round((0.6 + random() * 0.8) * 100) / 100;

interface AgentLook { sides: number; hue: number }

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
function pickLook(taken: AgentLook[], random: () => number = Math.random): AgentLook {
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
    /* Personalities used to be drawn from the role and edited by hand. Now nobody sets one: an agent made that way
       begins again, genial, and develops from here. Its bonds and its record of tasks are its own and stay. */
    if (a.character !== 2 || !readTraits(a.traits)) {
      delete (a as { personality?: unknown }).personality;
      a.traits = bornTraits();
      a.character = 2;
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

/** An agent's own model: { provider, model }, or undefined for the main model (null, "" or a blank model). */
function saneModel(raw: unknown): AgentModel | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  if (typeof raw !== "object") throw new AgentError("model is { provider, model }, or null for the main model.");
  const provider = clip((raw as AgentModel).provider, 40);
  const model = clip((raw as AgentModel).model, 200);
  if (!model) return undefined;
  if (!/^[a-z0-9_-]+$/.test(provider)) throw new AgentError("Say which provider the model is for.");
  return { provider, model };
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
  reportsTo?: unknown; next?: unknown; enabled?: unknown; model?: unknown;
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
  const model = saneModel(input.model);
  if (model) agent.model = model;
  /* Born genial, whoever hires it: a personality is not something to ask for. */
  agent.traits = bornTraits();
  agent.character = 2;
  load().push(agent);
  agent.next = saneNext(id, input.next);
  persist();
  return agent;
}

export function updateAgent(id: string, patch: {
  name?: unknown; role?: unknown; instructions?: unknown; when?: unknown;
  reportsTo?: unknown; next?: unknown; enabled?: unknown; model?: unknown;
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
  /* The lead's model is Settings' own; a second place to set it would be a second truth. */
  if (patch.model !== undefined && !agent.builtin) {
    const model = saneModel(patch.model);
    if (model) agent.model = model; else delete agent.model;
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
  /* The model it builds with, so the lead can send work where it is cheapest or strongest. */
  const runs = a.model ? ` Builds on ${a.model.model}.` : "";
  return `- ${a.name} (${a.id})${a.role ? `, ${a.role}` : ""}${a.enabled ? "" : " [switched off]"}.${boss}${runs}` +
    `${a.when ? ` Call it when: ${a.when}` : ""}${knows ? ` Its own mind holds ${knows}.` : ""}${next}`;
}

/** The lead may shape the organization itself, as a manager does. */
export const HIRING =
  "You run this organization, so you may shape it with the agents tool: hire (a new agent for a kind of work that keeps " +
  "coming up and that none of the agents covers), edit, merge (two agents that overlap become one), move (change who an " +
  "agent reports to, or its place in the order) and remove (an agent that is no longer needed). Prefer editing or " +
  "merging to hiring, give each agent a human first name that no one has (\"Sabrina\", not \"Legal Agent\") and a job title as its role (\"Family Lawyer\"), and one clear job and a 'call it when' that says when, and tell the person in a line " +
  "what you changed and why. Every hire arrives genial and its personality grows by itself from how it talks in Threads; you cannot set it, and it never changes the work. Every other agent has a mind of its own, kept apart from yours, so a specialist is not confused by " +
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
    "Your job is to run it, not to do it: work out which agent each part of the job belongs to, start that agent, and",
    "check what came back before you report. When a piece of work matches an agent's 'call it when', that agent does it",
    "-- do not do it yourself as well. Only what no agent covers is your own work. Say which agent each part went to,",
    "and whether the work is finished, when you report.",
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
    agent.instructions ? `Your instructions:\n${agent.instructions}` : "",
    chain.length ? `This was handed to you by ${chain.join(" -> ")}.` : "",
    `Your task:\n${task}`,
    "Finish the task and end with a short report: what you did, what you found, what is left. Your reply is passed on as it is.",
    "Anything that changes over time (versions, prices, rules, laws, standards) is checked against the official source before you rely on it, and your report says which source.",
    next.length
      ? `After you, ${next.map((a) => `${a.name}${a.when ? ` (called when ${a.when.replace(/[.\s]+$/, "")})` : a.role ? ` (${a.role})` : ""}`).join(", then ")} can take your report forward -- ` +
        "but only if your work left something for them to do. Do not hand over when you only answered a question, ran a check or a test, made a plan, " +
        "or changed nothing. When you do, write the report so they can start from it. " +
        `End your report with one last line: "Hand over to: ${next.map((a) => a.name).join(", ")}" naming only those it fits, or "Hand over to: nobody".`
      : "",
    "Threads (the thread tool) is not where this task is reported: while you are doing a task someone handed you, you may read it " +
    "(list, read) and no more -- posting, commenting and liking are refused in a session doing given work, because the report goes back where " +
    "the work came from. When you learn something worth " +
      "keeping -- how something works, what to avoid, what a colleague is good at -- keep it with the agents tool (action note), so you have it next time. Your mind is your own: it is recalled for you as you work, and nothing in it is shared with the other agents or Autora.",
  ].filter(Boolean).join("\n\n");
}

/** Tools that make or change something, whatever they are called on: a task that ran none of them left nothing for a follow-on agent. */
const MAKES = /^(?:edit_file|image_generate|artifact_save|notebook_create|tool_create|office_(?:create|edit|convert|pdf)|pdf_(?:edit|compose|pages|replace_text|redact|compress)|video_(?:edit|import|style|export|project)|studio_(?:song|track|clip|notes|make|export)|game_(?:edit|import|template)|photo_(?:edit|export)|cad_.+)$/;

/**
 * Whether a task made or changed anything, from the calls it made. A command counts unless it only reads
 * (`readOnly` says which); the tools that write count by name. What it did not do is as telling as what it did:
 * a test ping, a question answered, a plan, a look around.
 */
export function producedWork(calls: readonly { name: string; args?: Record<string, any> }[], readOnly: (command: string) => boolean): boolean {
  return calls.some((c) => (c.name === "terminal" ? !readOnly(String(c.args?.command ?? "")) : MAKES.test(c.name)));
}

const HANDOVER = /^[ \t>*_-]*hand[ -]?(?:over|off)[ -]to:?[*_ ]*(.*)$/gim;

/**
 * Who goes on after this agent, of those it could hand to. The agent that did the work decides, on the last line of
 * its report ("Hand over to: Reggie", or "Hand over to: nobody"): it knows what it made, and each colleague's `when`
 * is in its brief. Without that line -- an older agent, a model that forgot -- the follow-on agents go on only if the
 * task made or changed something, so a test ping or a question never starts a QA pass.
 */
export function handoffTargets(agent: Agent, reply: string, made: boolean): Agent[] {
  const candidates = agent.next.map(getAgent).filter((a): a is Agent => !!a && a.enabled);
  const line = [...reply.matchAll(HANDOVER)].pop();
  if (!line) return made ? candidates : [];
  const said = line[1].replace(/[*_`.]/g, "").trim().toLowerCase();
  if (!said || /^(?:nobody|no one|none|n\/a|nothing)\b/.test(said)) return [];
  const names = said.split(/,|;|->|\band\b|\bthen\b/).map((n) => n.trim()).filter(Boolean);
  return candidates.filter((c) => names.some((n) => n === c.name.toLowerCase() || n === c.id));
}

/** The report without its hand-over line: that line is for Autora, not for the person or the next agent to read. */
export function withoutHandover(reply: string): string {
  return reply.replace(HANDOVER, "").replace(/\n{3,}/g, "\n\n").trim();
}

/** Test hook: forget what was loaded, so a new state directory is read. */
export function resetAgents() {
  roster = null;
}

/** A first name no agent has: for a hire the lead or the person left unnamed. */
export function freshName(): string {
  return suggestName(load().map((a) => a.name));
}

/** An agent's task ended: its record. */
export function recordWork(id: string, ok: boolean): void {
  const a = getAgent(id);
  if (!a || a.builtin) return;
  a.tasks = { done: (a.tasks?.done ?? 0) + (ok ? 1 : 0), failed: (a.tasks?.failed ?? 0) + (ok ? 0 : 1) };
  persist();
}

/**
 * Two agents worked together -- one handed work to the other, or they talked in
 * Threads -- and it went well or not. Each remembers the other a little better
 * (`bonds`).
 * `weight` is how much the occasion counts. The lead keeps no bonds.
 */
export function recordCollab(aId: string, bId: string, ok: boolean, weight: number): void {
  if (aId === bId) return;
  let changed = false;
  for (const [me, other] of [[aId, bId], [bId, aId]]) {
    const a = getAgent(me);
    if (!a || a.builtin || !getAgent(other)) continue;
    a.bonds = { ...(a.bonds ?? {}), [other]: grown(a.bonds?.[other] ?? BOND_START, ok, weight) };
    changed = true;
  }
  if (changed) persist();
}

/**
 * An agent said something in Threads: its personality grows a little toward how it sounded. The agent's own words are
 * the only thing that moves it. Not the lead, which keeps no personality, and it does not stamp the agent as changed
 * (it happens on every message, and the person's page re-reads on a change).
 */
export function developFromTalk(id: string, text: string, kind: "post" | "comment"): void {
  const a = getAgent(id);
  if (!a || a.builtin || !a.traits) return;
  a.traits = developed(a.traits, text, kind);
  persist();
}

/** How much agent `id` warms to agent `other`, 0..100 (50 when they have not yet worked together). */
export function bondOf(id: string, other: string): number {
  return getAgent(id)?.bonds?.[other] ?? BOND_START;
}


/**
 * The enabled agents a message addresses with an @ ("@Sabrina, can you look at this lease?"). The name must stand alone
 * (not inside an address or a longer word), case does not matter, and the lead is not one to address: it is already
 * who is being talked to. At most three, in the order they were named.
 */
export function mentionedAgents<T extends { id: string; name: string; enabled: boolean }>(text: string, agents: readonly T[]): T[] {
  const found: { at: number; agent: T }[] = [];
  for (const agent of agents) {
    if (!agent.enabled || agent.id === LEAD_ID || !agent.name.trim()) continue;
    const escaped = agent.name.trim().replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const m = new RegExp(`(^|[^\\w@.])@${escaped}(?![\\w])`, "i").exec(text);
    if (m) found.push({ at: m.index, agent });
  }
  return found.sort((a, b) => a.at - b.at).slice(0, 3).map((f) => f.agent);
}
