/**
 * The few browser APIs a frame without its own origin does not have.
 *
 * The editor runs sandboxed, with no origin, because it renders PDFs from
 * anywhere and must not be able to reach the app or its API. That costs it
 * three things the page assumes are there, each of which throws rather than
 * returning null -- and a throw on the way up is not a degraded editor, it is
 * no editor:
 *
 *   localStorage / sessionStorage   read by the theme and workspace code
 *   navigator.locks                 taken by the document pipeline to keep one
 *                                   reader at a time on a file
 *
 * Both are replaced with an in-page equivalent: memory instead of disk, and a
 * promise queue instead of the browser's lock manager. The real APIs are used
 * when they are there (the standalone development page, and any host that
 * grants an origin).
 */
import { installStorage } from "./storage";

type LockMode = "exclusive" | "shared";
type LockRequest = string | string[];
interface LockOptions {
  mode?: LockMode;
  ifAvailable?: boolean;
  steal?: boolean;
  signal?: AbortSignal;
}

/** One queue per lock name, so the same name serializes and different names do
 *  not wait on each other. */
function installLocks(): void {
  const real = (() => {
    try {
      return navigator.locks;
    } catch {
      return undefined;
    }
  })();

  const tails = new Map<string, Promise<unknown>>();

  const queued = <T>(name: string | string[], opts: LockOptions, run: (lock: unknown) => Promise<T>): Promise<T> => {
    const names = Array.isArray(name) ? name : [name];
    // A cancelled request never runs: the signal is checked before the queue is
    // joined, which is what the browser's own lock does with it.
    if (opts.signal?.aborted) return Promise.reject(new DOMException("Aborted", "AbortError"));
    const previous = names.map((n) => tails.get(n) ?? Promise.resolve());
    const done = Promise.all(previous).then(
      () => run({ name: names[0], mode: opts.mode ?? "exclusive" }),
      () => run({ name: names[0], mode: opts.mode ?? "exclusive" }),
    );
    // The queue's tail must not carry a rejection on to the next waiter.
    const tail = done.then(
      () => undefined,
      () => undefined,
    );
    for (const n of names) tails.set(n, tail);
    return done;
  };

  /* The API being *present* is not the same as it working: a frame without an
     origin still has `navigator.locks` and every call on it throws
     `SecurityError: Access to the Locks API is denied in this context`. So it
     is probed once, and until the answer is in the in-page queue is used --
     which is what serializes anyway; the probe only decides whether the
     browser's own manager is worth deferring to. */
  let realWorks: boolean | null = null;

  const request = <T>(
    name: string | string[],
    options: LockOptions | ((lock: unknown) => Promise<T>),
    callback?: (lock: unknown) => Promise<T>,
  ): Promise<T> => {
    const opts: LockOptions = typeof options === "function" ? {} : options;
    const run = (typeof options === "function" ? options : callback) as (lock: unknown) => Promise<T>;
    if (realWorks === true && real?.request) {
      return (real.request as any).call(real, name, options as any, callback as any) as Promise<T>;
    }
    return queued(name, opts, run);
  };

  try {
    Object.defineProperty(navigator, "locks", {
      value: { request, query: async () => ({ held: [], pending: [] }) },
      configurable: true,
    });
  } catch {
    // A browser that will not let the property be replaced: the document
    // pipeline reports what it could not take.
    return;
  }

  if (real?.request) {
    void (real.request as any).call(real, "autora-probe", async () => {})
      .then(() => { realWorks = true; })
      .catch((err: unknown) => {
        realWorks = (err as DOMException)?.name === "SecurityError" ? false : null;
      });
  }
}

export function installSandbox(): void {
  installStorage();
  installLocks();
}
