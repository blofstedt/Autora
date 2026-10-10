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
  created: number;
  updated: number;
};

export type AgentPatch = Partial<Pick<Agent, "name" | "role" | "instructions" | "when" | "reportsTo" | "next" | "enabled">>;

export type Who = { kind: "agent" | "user"; id: string; name: string };

export type ThreadComment = {
  id: string;
  parent: string | null;
  by: Who;
  text: string;
  created: number;
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

export const fetchAgents = () => call<{ agents: Agent[] }>("/api/agents").then((d) => d.agents ?? []);
export const createAgent = (input: AgentPatch) =>
  call<{ agent: Agent }>("/api/agents", json("POST", input)).then((d) => d.agent);
export const updateAgent = (id: string, patch: AgentPatch) =>
  call<{ agent: Agent }>(`/api/agents/${id}`, json("PATCH", patch)).then((d) => d.agent);
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
