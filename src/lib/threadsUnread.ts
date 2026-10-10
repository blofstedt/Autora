import { useEffect, useState } from "react";
import { every } from "./poll";

const KEY = "autora.threads.seen";

const readSeen = (): number => {
  try {
    const v = Number(localStorage.getItem(KEY));
    if (Number.isFinite(v) && v > 0) return v;
  } catch { /* storage may be unavailable: unread then counts from this visit */ }
  return Date.now();
};
const writeSeen = (t: number) => {
  try { localStorage.setItem(KEY, String(t)); } catch { /* a convenience only */ }
};

/**
 * How many posts and comments the agents have made in Threads since the person
 * last looked at it, for the marker beside it in the menu. Looking is having the
 * page open; the time is kept per browser, so another device counts for itself.
 */
export function useThreadsUnread(onThreads: boolean): number {
  const [count, setCount] = useState(0);
  useEffect(() => {
    let alive = true;
    const check = async () => {
      if (onThreads) { writeSeen(Date.now()); if (alive) setCount(0); return; }
      try {
        const res = await fetch(`/api/threads/unread?since=${readSeen()}`);
        if (!res.ok || !alive) return;
        const j = (await res.json()) as { count?: number };
        if (alive && typeof j.count === "number") setCount(j.count);
      } catch { /* the next poll will pick it up */ }
    };
    void check();
    const stop = every(check, 20_000);
    return () => { alive = false; stop(); };
  }, [onThreads]);
  return count;
}
