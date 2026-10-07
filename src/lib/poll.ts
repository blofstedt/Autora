import { useEffect, useState } from "react";

/**
 * Call `fn` every `ms` while the tab is visible, and once when it comes back.
 * A tab in the background has nobody to show a refreshed list to, and on a
 * phone the app sitting in the background kept the radio and the server busy
 * for every page that polled. Returns what stops it.
 */
export function every(fn: () => unknown, ms: number): () => void {
  const timer = window.setInterval(() => { if (!document.hidden) void fn(); }, ms);
  const onVisible = () => { if (!document.hidden) void fn(); };
  document.addEventListener("visibilitychange", onVisible);
  return () => {
    window.clearInterval(timer);
    document.removeEventListener("visibilitychange", onVisible);
  };
}

/** Fetch `url` as JSON now and every `ms` while the tab is visible. A failure
    leaves what was there; the next poll will pick it up. */
export function usePoll<T>(url: string, ms: number): T | null {
  const [data, setData] = useState<T | null>(null);
  useEffect(() => {
    let alive = true;
    const load = async () => {
      try {
        const res = await fetch(url);
        if (res.ok && alive) setData(await res.json() as T);
      } catch {
        /* the next poll will pick it up */
      }
    };
    void load();
    const stop = every(load, ms);
    return () => { alive = false; stop(); };
  }, [url, ms]);
  return data;
}
