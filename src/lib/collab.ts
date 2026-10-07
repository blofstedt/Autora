import { useSyncExternalStore } from "react";

/**
 * Who has hold of what, in this chat (server/presence.ts): the surfaces the
 * person has taken from the agent, and the ones they are using this moment.
 * Said by the server when it changes; the windows show it and offer "take
 * control" and "hand back".
 */
type Surface = "pdf" | "office" | "app" | "browser" | "code";
type CollabState = { held: Surface[]; active: Surface[] };

const NONE: CollabState = { held: [], active: [] };
let state: CollabState = NONE;
const listeners = new Set<() => void>();

export function setCollabState(next: unknown) {
  const n = next as Partial<CollabState> | null;
  const held = Array.isArray(n?.held) ? (n!.held as Surface[]) : [];
  const active = Array.isArray(n?.active) ? (n!.active as Surface[]) : [];
  // The same thing again must not redraw every window that reads it.
  if (state.held.join() === held.join() && state.active.join() === active.join()) return;
  state = { held, active };
  for (const l of listeners) l();
}

export function resetCollab() {
  setCollabState(null);
}

const subscribe = (l: () => void) => { listeners.add(l); return () => { listeners.delete(l); }; };

export function useCollab(): CollabState {
  return useSyncExternalStore(subscribe, () => state, () => NONE);
}

/** Take a surface from the agent, or hand it back. */
export async function holdSurface(sessionId: string, surface: Surface, hold: boolean): Promise<void> {
  try {
    const res = await fetch(`/api/sessions/${encodeURIComponent(sessionId)}/control`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ surface, hold }),
    });
    if (res.ok) setCollabState(await res.json());
  } catch {
    // The next message from the server says how it stands.
  }
}
