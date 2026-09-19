export type MemoryRecord = {
  id: string;
  kind: "fact" | "preference" | "procedure" | "episode";
  scope: string;
  title: string;
  body: string;
  tags: string[];
  status: "provisional" | "confirmed" | "retired";
  pinned: boolean;
  source_session: string | null;
  source_seq: number | null;
  created: number;
  updated: number;
  uses: number;
  last_used: number | null;
  superseded_by: string | null;
};

export type MemoryLink = { src: string; dst: string; rel: string };

export type Knowledge = {
  records: MemoryRecord[];
  links: MemoryLink[];
  enabled: boolean;
};

export const KIND_COLOR: Record<MemoryRecord["kind"], string> = {
  preference: "var(--accent-2)",
  procedure: "var(--live)",
  fact: "var(--accent)",
  episode: "var(--warn)",
};

export async function fetchKnowledge(includeRetired: boolean): Promise<Knowledge> {
  const res = await fetch(`/api/memory?include_retired=${includeRetired}`);
  if (!res.ok) return { records: [], links: [], enabled: false };
  return res.json();
}

export async function patchRecord(id: string, body: Partial<MemoryRecord>) {
  await fetch(`/api/memory/${id}`, {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
}

export async function deleteRecord(id: string, hard: boolean) {
  await fetch(`/api/memory/${id}?hard=${hard}`, { method: "DELETE" });
}

/**
 * Edges the graph draws.
 *
 * Explicit links carry real meaning -- one record superseded another, or they
 * were learned in the same session. Shared tags are a weaker signal, so they
 * are drawn thinner and capped: a tag applied to forty records would otherwise
 * produce 780 edges and a hairball that says nothing.
 */
const MAX_TAG_GROUP = 6;

export function edgesFor(k: Knowledge): { a: string; b: string; strong: boolean }[] {
  const ids = new Set(k.records.map((r) => r.id));
  const out: { a: string; b: string; strong: boolean }[] = [];
  const seen = new Set<string>();
  const key = (a: string, b: string) => (a < b ? `${a}|${b}` : `${b}|${a}`);

  for (const link of k.links) {
    if (!ids.has(link.src) || !ids.has(link.dst)) continue;
    const id = key(link.src, link.dst);
    if (seen.has(id)) continue;
    seen.add(id);
    out.push({ a: link.src, b: link.dst, strong: true });
  }

  const byTag = new Map<string, string[]>();
  for (const record of k.records) {
    for (const tag of record.tags) {
      const group = byTag.get(tag) ?? [];
      group.push(record.id);
      byTag.set(tag, group);
    }
  }
  for (const group of byTag.values()) {
    if (group.length < 2 || group.length > MAX_TAG_GROUP) continue;
    for (let i = 0; i < group.length; i++) {
      for (let j = i + 1; j < group.length; j++) {
        const id = key(group[i], group[j]);
        if (seen.has(id)) continue;
        seen.add(id);
        out.push({ a: group[i], b: group[j], strong: false });
      }
    }
  }
  return out;
}
