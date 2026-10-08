import { useEffect } from "react";

/**
 * A window that holds an editor in a frame: if the frame has not said it is up after a while, say so.
 *
 * An editor that fails on its way up (a browser too old for something it uses, a file the page could not fetch)
 * leaves a frame that is simply grey or white, and the person is left looking at it with nothing to go on. This turns
 * that into a line with the next thing to try, and with the browser named so that it can be reported.
 */
const WAIT_MS = 25_000;

const browserName = (): string => {
  const ua = typeof navigator === "undefined" ? "" : navigator.userAgent;
  const m = /(Edg|Chrome|Firefox|Version)\/([\d.]+)/.exec(ua);
  const name = m ? (m[1] === "Version" ? "Safari" : m[1] === "Edg" ? "Edge" : m[1]) : "this browser";
  return m ? `${name} ${m[2].split(".")[0]}` : name;
};

export function useBootWatch(
  /** Whether the editor has said it is up. Read when the time is up, not before. */
  up: () => boolean,
  /** Changes when the frame is loaded afresh: the wait starts again. */
  key: unknown,
  /** "PDF editor", "video editor": what the line calls it. */
  label: string,
  /** Where the line goes (the window's own problem banner). */
  say: (line: string) => void,
): void {
  useEffect(() => {
    const timer = window.setTimeout(() => {
      if (!up()) {
        say(`The ${label} has not started after ${WAIT_MS / 1000} seconds (${browserName()}). Reloading the page often sorts it; if it keeps happening, an up-to-date browser may be needed.`);
      }
    }, WAIT_MS);
    return () => window.clearTimeout(timer);
    // `up` and `say` are read when the time is up; the wait restarts with the frame, not with them.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [key, label]);
}
