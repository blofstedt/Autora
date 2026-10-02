import { useSyncExternalStore } from "react";

/**
 * Whether the agent's work is shown as it is done: the cursor in the PDF and
 * app windows, and code typed out in the thread. One switch for all of it,
 * kept on the server (the app window's cursor is drawn there) and mirrored
 * here so every place that shows it agrees at once.
 *
 * A presentation only: off, the work is exactly the same and simply appears.
 */
const KEY = "autora.agentCursor";

function stored(): boolean {
  try {
    return localStorage.getItem(KEY) !== "off";
  } catch {
    return true;
  }
}

let on = stored();
const listeners = new Set<() => void>();
let asked = false;

function set(next: boolean) {
  on = next;
  try {
    localStorage.setItem(KEY, next ? "on" : "off");
  } catch {
    // a private window: the switch still holds for this page
  }
  for (const l of listeners) l();
}

/** The server's answer, once, so a switch made on another device is followed. */
function sync() {
  if (asked) return;
  asked = true;
  fetch("/api/agent-cursor")
    .then((r) => (r.ok ? r.json() : null))
    .then((j: { on?: boolean } | null) => {
      if (j && typeof j.on === "boolean" && j.on !== on) set(j.on);
    })
    .catch(() => undefined);
}

export function setAgentCursor(next: boolean) {
  set(next);
  void fetch("/api/agent-cursor", {
    method: "PATCH",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on: next }),
  }).catch(() => undefined);
}

export const agentCursorOn = () => on;

const subscribe = (l: () => void) => {
  sync();
  listeners.add(l);
  return () => { listeners.delete(l); };
};

export function useAgentCursor(): [boolean, (next: boolean) => void] {
  const value = useSyncExternalStore(subscribe, () => on, () => true);
  return [value, setAgentCursor];
}
