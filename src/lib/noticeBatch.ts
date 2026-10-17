// A scheduled task that ran several times while the person was away is said
// once, not once per run. Apart from the component so a test can call it.

export type Notice = {
  id: number;
  ts: number;
  tone: "ok" | "error" | "info";
  title: string;
  detail: string;
  session: string | null;
};

/** "9:02 AM", or with the day when the runs span more than one. */
function clock(ts: number, withDay: boolean): string {
  const d = new Date(ts * 1000);
  const time = d.toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
  return withDay ? `${d.toLocaleDateString([], { month: "short", day: "numeric" })} ${time}` : time;
}

/**
 * Notices that share a tone and a title (the same task finishing again) become
 * one: "Daily digest finished ×5" -- "ran 5× from 9:02 AM to 9:40 AM". The card
 * opens the newest run's session and carries the newest run's sentence. Order
 * is by first appearance, and a lone notice is returned as it came.
 */
export function batchNotices(list: Notice[]): Notice[] {
  const groups = new Map<string, Notice[]>();
  for (const n of list) {
    const key = `${n.tone}\u0000${n.title}`;
    const group = groups.get(key);
    if (group) group.push(n);
    else groups.set(key, [n]);
  }
  return [...groups.values()].map((group) => {
    if (group.length === 1) return group[0];
    const first = group[0];
    const last = group[group.length - 1];
    const days = new Date(first.ts * 1000).toDateString() !== new Date(last.ts * 1000).toDateString();
    return {
      ...last,
      title: `${first.title} ×${group.length}`,
      detail: `Ran ${group.length}× from ${clock(first.ts, days)} to ${clock(last.ts, days)}. Latest: ${last.detail}`,
    };
  });
}
