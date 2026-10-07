/**
 * "Are you sure?", in the app's own dialog instead of the browser's.
 *
 *     if (!(await sure("Delete this file?", "Delete"))) return;
 *
 * The browser's confirm() is an unthemed system box, awkward in an installed
 * app and impossible to reach with a screen reader's usual tools on some
 * phones. `SureHost` (mounted once, in App) draws this one. Without a host
 * (a test, say) it falls back to confirm().
 */
import { useSyncExternalStore } from "react";

type Question = { message: string; yes: string; settle: (answer: boolean) => void };

let current: Question | null = null;
let mounted = 0;
const listeners = new Set<() => void>();
const tell = () => { for (const l of listeners) l(); };

export function sure(message: string, yes = "Delete"): Promise<boolean> {
  if (mounted === 0) return Promise.resolve(window.confirm(message));
  // A second question while one is open answers the first with a no.
  current?.settle(false);
  return new Promise((resolve) => {
    current = {
      message,
      yes,
      settle: (answer) => { if (current?.settle === settle) { current = null; tell(); } resolve(answer); },
    };
    const settle = current.settle;
    tell();
  });
}

export function useQuestion(): Question | null {
  return useSyncExternalStore(
    (l) => { listeners.add(l); return () => { listeners.delete(l); }; },
    () => current,
    () => null,
  );
}

/** The host registers itself so `sure` knows a dialog will be drawn. */
export function hostMounted(): () => void {
  mounted += 1;
  return () => { mounted -= 1; };
}
