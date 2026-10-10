import { useEffect, useState } from "react";
import type { AgentLook } from "./agentlook";

/** The organization (agents) and Threads as the client sees them: see server/agents.ts and server/threads.ts. */

export type Agent = {
  id: string;
  name: string;
  role: string;
  instructions: string;
  when: string;
  reportsTo: string | null;
  next: string[];
  enabled: boolean;
  builtin?: boolean;
  /** Its own shape and colour (see server/agents.ts); the lead has none and keeps Autora's mark. */
  look?: AgentLook;
  /** Who it is, drawn from its expertise and editable (server/agentcharacter.ts). */
  personality?: string;
  /** Its attributes, 0..100; teamwork grows as it works well with others. */
  traits?: Partial<Record<TraitName, number>>;
  /** How well it works with each colleague, 0..100 by agent id; grows with the work. */
  bonds?: Record<string, number>;
  tasks?: { done: number; failed: number };
  created: number;
  updated: number;
};

export type TraitName = "warmth" | "candor" | "rigor" | "curiosity" | "humor" | "initiative" | "teamwork";

/** The sliders, in order, with what each end means. */
export const TRAITS: { key: TraitName; label: string; low: string; high: string }[] = [
  { key: "warmth", label: "Warmth", low: "businesslike", high: "warm" },
  { key: "candor", label: "Candor", low: "diplomatic", high: "blunt" },
  { key: "rigor", label: "Rigor", low: "quick", high: "exacting" },
  { key: "curiosity", label: "Curiosity", low: "focused", high: "curious" },
  { key: "humor", label: "Humor", low: "serious", high: "playful" },
  { key: "initiative", label: "Initiative", low: "waits to be asked", high: "proactive" },
  { key: "teamwork", label: "Teamwork", low: "lone worker", high: "collaborator" },
];

export type AgentPatch = Partial<Pick<Agent, "name" | "role" | "instructions" | "when" | "reportsTo" | "next" | "enabled" | "personality" | "traits">>;

export type Who = { kind: "agent" | "user"; id: string; name: string };

export type ThreadComment = {
  id: string;
  parent: string | null;
  by: Who;
  text: string;
  created: number;
  /** A GIF the author added: an address on a GIF service, and a caption. */
  gif?: { url: string; alt: string };
  likes: string[];
};

export type ThreadPost = {
  id: string;
  title: string;
  body: string;
  tags: string[];
  by: Who;
  created: number;
  updated: number;
  gif?: { url: string; alt: string };
  likes: string[];
  comments: ThreadComment[];
};

export type ThreadSort = "new" | "top" | "active";

/** The id the person's own likes are kept under. */
export const ME = "user";

async function call<T>(url: string, init?: RequestInit): Promise<T> {
  const res = await fetch(url, init);
  const body = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(body.error ?? `Request failed (${res.status}).`);
  return body as T;
}

const json = (method: string, body: unknown): RequestInit => ({
  method, headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
});

export const fetchAgents = () =>
  call<{ agents: Agent[] }>("/api/agents").then((d) => {
    remember(d.agents ?? []);
    return d.agents ?? [];
  });

/* Every agent's look, kept from the last time the list was read, so a byline in
   Threads can draw the agent's own mark without each one asking. */
const looks = new Map<string, AgentLook | null>();
const watchers = new Set<() => void>();
let asking = false;
function remember(list: Agent[]) {
  for (const a of list) looks.set(a.id, a.look ?? null);
  watchers.forEach((f) => f());
}

/** The look of agent `id`: null for the lead (Autora's own mark), undefined while not known. */
export function useLook(id: string): AgentLook | null | undefined {
  const [, bump] = useState(0);
  useEffect(() => {
    const f = () => bump((n) => n + 1);
    watchers.add(f);
    if (id.startsWith("agent_") && !looks.has(id) && !asking) {
      asking = true;
      void fetchAgents().catch(() => undefined).finally(() => { asking = false; });
    }
    return () => { watchers.delete(f); };
  }, [id]);
  return looks.get(id);
}
export const createAgent = (input: AgentPatch) =>
  call<{ agent: Agent }>("/api/agents", json("POST", input)).then((d) => d.agent);
export const updateAgent = (id: string, patch: AgentPatch) =>
  call<{ agent: Agent }>(`/api/agents/${id}`, json("PATCH", patch)).then((d) => d.agent);
export type AgentMemory = { id: string; text: string; kind: string; from: string; at: number; used: number };
export const fetchMind = (id: string) =>
  call<{ main: boolean; memories: AgentMemory[] }>(`/api/agents/${id}/mind`);
export const forgetMemory = (id: string, memory: string) =>
  call<{ ok: true }>(`/api/agents/${id}/mind/${memory}`, { method: "DELETE" });
export const deleteAgent = (id: string) => call<{ ok: true }>(`/api/agents/${id}`, { method: "DELETE" });

export const fetchPosts = (sort: ThreadSort) =>
  call<{ posts: ThreadPost[] }>(`/api/threads?sort=${sort}`).then((d) => d.posts ?? []);
export const makePost = (title: string, body: string, tags: string[]) =>
  call<{ post: ThreadPost }>("/api/threads", json("POST", { title, body, tags })).then((d) => d.post);
export const deletePost = (id: string) => call<{ ok: true }>(`/api/threads/${id}`, { method: "DELETE" });
export const makeComment = (post: string, text: string, parent: string | null) =>
  call<{ post: ThreadPost }>(`/api/threads/${post}/comments`, json("POST", { text, parent })).then((d) => d.post);
export const deleteComment = (post: string, comment: string) =>
  call<{ ok: true }>(`/api/threads/${post}/comments/${comment}`, { method: "DELETE" });
export const likeIn = (post: string, comment?: string) =>
  call<{ post: ThreadPost }>(`/api/threads/${post}/like`, json("POST", { comment })).then((d) => d.post);

/** Ids of everyone below `id` in the org, so the "reports to" choice cannot make a loop. */
export function underneath(agents: Agent[], id: string): Set<string> {
  const out = new Set<string>();
  const walk = (of: string) => {
    for (const a of agents) if (a.reportsTo === of && !out.has(a.id)) { out.add(a.id); walk(a.id); }
  };
  walk(id);
  return out;
}

/** A steady colour for one author, so the same agent looks the same everywhere. */
export function hueOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i += 1) h = (h * 31 + id.charCodeAt(i)) % 360;
  return h;
}
