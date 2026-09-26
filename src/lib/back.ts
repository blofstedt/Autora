import { useEffect } from "react";

/**
 * Where the back gesture goes, in an app that is one page.
 *
 * Autora is installed to a phone's home screen and opened from there. On
 * Android, back is a system gesture, and in an installed app with no history
 * behind it, back means "leave the app": pressing it closed Autora rather
 * than stepping out of it, and there was no way from the app back to the
 * dashboard it was opened from.
 *
 * Umbrel's dashboard is the bare host, with Autora's port taken off: the PWA
 * is served at :8443 (the tailscale-serve bridge) and the tile at :8817, and
 * in both cases https://<host>/ is the dashboard. So the app pushes one entry
 * of its own when it loads, which makes the first back ours to answer, and
 * answers it by leaving for that dashboard -- the browser carries the whole
 * entry across, so it is the dashboard that opens, not a second copy of the
 * app.
 *
 * Anything open over the chat -- a memory, a session list -- closes first, and
 * only the back after that leaves. A back that closed the session list and
 * the app together would be a back nobody asked for.
 */

/**
 * The dashboard above this page: the same host without Autora's port.
 *
 * Null when there is no port to take off -- a page served on the bare host
 * (the dev server, a proxy in front, a box with no Umbrel) has nowhere
 * useful above it, and guessing would send the back gesture somewhere worse
 * than the tab it came from.
 */
export function umbrelHome(href: string): string | null {
  let url: URL;
  try {
    url = new URL(href);
  } catch {
    return null;
  }
  if (!url.port) return null;
  url.port = "";
  url.pathname = "/";
  url.search = "";
  url.hash = "";
  return url.toString();
}

/** What is open over the chat, if anything: closing it is the first back. */
export function topLayer(): HTMLElement | null {
  const scrim = document.querySelector<HTMLElement>(".scrim, .drawer-scrim");
  if (!scrim) return null;
  // Both scrims are position: fixed, and a fixed element has no offsetParent
  // to be tested against -- asking that question answered "nothing is open"
  // for every card and drawer there is, so the first back left the app with a
  // card still on the screen. Ask the rendering instead: a scrim that is
  // displayed and has a box on screen is one to close.
  const style = getComputedStyle(scrim);
  if (style.display === "none" || style.visibility === "hidden") return null;
  return scrim.getClientRects().length > 0 ? scrim : null;
}

/**
 * Answer the back gesture: close what is open, then leave for the dashboard.
 *
 * Called once, from the app, so it is listening before anything can be
 * opened over it.
 */
export function useBackOut(): void {
  useEffect(() => {
    const home = umbrelHome(location.href);
    if (!home) return;

    // One entry of our own, on top, so the first back arrives here instead of
    // at the end of the app's history.
    const sentinel = { autora: "back" };
    const hold = () => history.pushState(sentinel, "", location.href);
    hold();

    const onPop = () => {
      const open = topLayer();
      if (open) {
        // Clicking the scrim is how it is closed by hand, so a memory or a
        // session list closes the way it always does.
        open.click();
        // ...and the entry is put back, so the next back is answered here
        // too rather than at the end of the history.
        hold();
        return;
      }
      location.assign(home);
    };

    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
