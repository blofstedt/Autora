/**
 * The page's theme, for the editors that live in a sandboxed frame.
 *
 * A frame without `allow-same-origin` (the PDF editor, the Word / Excel /
 * PowerPoint editors) cannot read the page's custom properties, and used to
 * carry Autora Violet as literals: pick Teal or Ember in Settings and every
 * other surface followed while those windows stayed violet. The page sends the
 * resolved tokens instead, on load and whenever the theme, the font or the
 * text size changes; the frame lays them on its root as `--autora-*`, which
 * its own stylesheet reads with the violet literals as fallbacks (so a frame
 * opened on its own still looks right). The same names in both editors.
 *
 * OpenCut has its own, older channel (`autora:opencut:theme`); it will move
 * here the next time it is touched.
 */
import { useEffect, type RefObject } from "react";

/** [name in the frame, token on this page]. */
const TOKENS: Array<[string, string]> = [
  ["--autora-bg", "--bg"], ["--autora-s1", "--s1"], ["--autora-s2", "--s2"], ["--autora-s3", "--s3"], ["--autora-s4", "--s4"],
  ["--autora-sink", "--sink"], ["--autora-border", "--border"], ["--autora-border-strong", "--border-strong"],
  ["--autora-text", "--text"], ["--autora-text-2", "--text-2"], ["--autora-text-3", "--text-3"],
  ["--autora-accent", "--accent"], ["--autora-accent-rgb", "--accent-rgb"], ["--autora-accent-deep", "--accent-deep"],
  ["--autora-accent-light", "--accent-light"], ["--autora-on-accent", "--on-accent"],
  ["--autora-accent-soft", "--accent-soft"], ["--autora-accent-line", "--accent-line"],
  ["--autora-accent-2", "--accent-2"], ["--autora-accent-2-rgb", "--accent2-rgb"],
  ["--autora-live", "--live"], ["--autora-live-rgb", "--live-rgb"],
  ["--autora-warn", "--warn"], ["--autora-warn-rgb", "--warn-rgb"],
  ["--autora-danger", "--danger"], ["--autora-danger-rgb", "--danger-rgb"],
];

export function frameThemeVars(): Record<string, string> {
  const css = getComputedStyle(document.documentElement);
  const out: Record<string, string> = {};
  for (const [to, from] of TOKENS) {
    const v = css.getPropertyValue(from).trim();
    if (v) out[to] = v;
  }
  return out;
}

/**
 * Keep a frame's theme in step with this page's: when the frame loads (any frame the ref points at, however
 * often it is re-created), and on every change after.
 */
export function useFrameTheme(frame: RefObject<HTMLIFrameElement>): void {
  useEffect(() => {
    const send = () => frame.current?.contentWindow?.postMessage({ type: "autora:theme", vars: frameThemeVars() }, "*");
    /* A frame's load event does not bubble, but it can be caught on the way down. */
    const onLoad = (e: Event) => { if (e.target === frame.current) send(); };
    window.addEventListener("load", onLoad, true);
    window.addEventListener("autora-theme", send);
    const watch = new MutationObserver(send);
    watch.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme", "style"] });
    send();
    return () => {
      window.removeEventListener("load", onLoad, true);
      window.removeEventListener("autora-theme", send);
      watch.disconnect();
    };
  }, [frame]);
}
