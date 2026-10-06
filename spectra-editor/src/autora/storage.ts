/**
 * Storage, where the sandbox does not have any.
 *
 * The frame runs without an origin of its own, so touching `localStorage`
 * throws rather than returning null: Spectra's renderer keeps its theme, its
 * panel widths and its recent files there, and one throw on the way up stops
 * the whole app mounting. There is no real storage to be had in a frame like
 * this, so it is kept in memory for as long as the window is open -- which is
 * the lifetime these settings are read for anyway -- and the real thing is
 * used when it is there (the standalone development page).
 */

function memoryStore(): Storage {
  const map = new Map<string, string>();
  const store = {
    get length() {
      return map.size;
    },
    key: (i: number) => [...map.keys()][i] ?? null,
    getItem: (k: string) => (map.has(k) ? (map.get(k) as string) : null),
    setItem: (k: string, v: string) => void map.set(String(k), String(v)),
    removeItem: (k: string) => void map.delete(k),
    clear: () => map.clear(),
  };
  return store as Storage;
}

/** One of the two storages, made safe to touch. */
function install(name: "localStorage" | "sessionStorage"): void {
  try {
    // Throws outright in a sandboxed frame; null in a browser where it is off.
    if (window[name]) return;
  } catch {
    // The sandbox case: fall through to the replacement.
  }
  try {
    Object.defineProperty(window, name, { value: memoryStore(), configurable: true });
  } catch {
    // A browser that will not let the property be replaced: the renderer's
    // reads will throw, and it says so where it uses them.
  }
}

export function installStorage(): void {
  install("localStorage");
  install("sessionStorage");
}
