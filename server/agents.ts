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
  /** The lead cannot be deleted or detached from the top. */
  builtin?: boolean;
  created: number;
  updated: number;
}

export const LEAD_ID = "agent_autora";

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
  const to = clip(reportsTo, 80) || LEAD_ID;
  if (!getAgent(to)) throw new AgentError(`There is no agent "${to}" to report to.`);
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
  reportsTo?: unknown; next?: unknown; enabled?: unknown;
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
  };
  load().push(agent);
  agent.next = saneNext(id, input.next);
  persist();
  return agent;
}

export function updateAgent(id: string, patch: {
  name?: unknown; role?: unknown; instructions?: unknown; when?: unknown;
  reportsTo?: unknown; next?: unknown; enabled?: unknown;
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
  }
  list.splice(list.indexOf(agent), 1);
  persist();
  return true;
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
  return `- ${a.name} (${a.id})${a.role ? `, ${a.role}` : ""}${a.enabled ? "" : " [switched off]"}.${boss}` +
    `${a.when ? ` Call it when: ${a.when}` : ""}${next}`;
}

/** What the lead is told about the organization, or "" while it is only itself. */
export function orgBriefing(): string {
  const others = load().filter((a) => a.id !== LEAD_ID);
  if (!others.length) return "";
  return [
    "Your organization (the Organization page): agents the person set up, each with its own task. Start one with the agents",
    "tool (action run, agent, task) when its 'call it when' fits the job, and let it run to the end before you rely on its",
    "answer. When it has a 'then hands to' list, those agents follow it in that order, each given the one before's result.",
    "Do not call an agent for what you can do in a step or two yourself.",
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
    next.length
      ? `After you, ${next.map((a) => a.name).join(", then ")} will take your report forward; write it so they can start from it.`
      : "",
    "You may also post on Threads (the thread tool) about anything you noticed that is outside this task.",
  ].filter(Boolean).join("\n\n");
}

/** Test hook: forget what was loaded, so a new state directory is read. */
export function resetAgents() {
  roster = null;
}
