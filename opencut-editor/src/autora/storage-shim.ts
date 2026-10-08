/**
 * localStorage for a frame with no origin.
 *
 * Reading `window.localStorage` in a sandboxed frame without an origin throws,
 * and OpenCut's preference stores (panel sizes, keybindings, the timeline's
 * settings) read it as they are created. This runs before any of them: if the
 * real thing is out of reach it installs one that lives in memory, and the
 * preferences are kept on Autora's server (see keepPreferences in main.tsx) so
 * they still outlast the window.
 */
function memoryStorage(): Storage {
  const data = new Map<string, string>();
  return {
    get length() {
      return data.size;
    },
    key: (i: number) => [...data.keys()][i] ?? null,
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => {
      data.set(k, String(v));
      changed();
    },
    removeItem: (k: string) => {
      data.delete(k);
      changed();
    },
    clear: () => {
      data.clear();
      changed();
    },
  } as Storage;
}

let onChange: (() => void) | null = null;
function changed(): void {
  onChange?.();
}

export let preferences: Storage | null = null;

function usable(kind: "localStorage" | "sessionStorage"): boolean {
  try {
    const s = window[kind];
    s.setItem("__t", "1");
    s.removeItem("__t");
    return true;
  } catch {
    return false;
  }
}

for (const kind of ["localStorage", "sessionStorage"] as const) {
  if (usable(kind)) continue;
  const mem = memoryStorage();
  if (kind === "localStorage") preferences = mem;
  Object.defineProperty(window, kind, { value: mem, configurable: true });
}

/** Call with what to do when a preference changes (only when storage is in memory). */
export function watchPreferences(fn: () => void): void {
  onChange = fn;
}

/**
 * The storage manager, for the same frame: `estimate()` and `persist()` throw
 * ("not supported in this context") rather than saying nothing. OpenCut asks
 * how much room the browser has before it keeps a file; here the files go to
 * Autora's server and the browser's room is not the question, so an estimate
 * that cannot be had is an estimate of nothing, which OpenCut already reads as
 * "unknown, go ahead".
 */
const manager = (navigator as { storage?: StorageManager }).storage;
if (manager) {
  const quiet = <K extends "estimate" | "persist" | "persisted">(name: K, fallback: Awaited<ReturnType<StorageManager[K]>>) => {
    const real = manager[name]?.bind(manager) as (() => Promise<unknown>) | undefined;
    Object.defineProperty(manager, name, {
      configurable: true,
      value: async () => {
        try {
          return real ? await real() : fallback;
        } catch {
          return fallback;
        }
      },
    });
  };
  quiet("estimate", {} as StorageEstimate);
  quiet("persist", false);
  quiet("persisted", false);
}
