import { useEffect } from "react";

/**
 * The back gesture, in an app that is one page.
 *
 * Autora is installed to a phone's home screen and opened from there. On
 * Android, back is a system gesture, and in an installed app with no history
 * behind it, back means "leave the app".
 *
 * What back does here, in order:
 *
 *  1. Anything open over the chat -- a card, a drawer, the session list --
 *     closes, the way it closes when its scrim is tapped.
 *  2. Otherwise the app steps back a screen: a page returns to the chat, and
 *     whatever the app says a step back is (it registers that with
 *     setStepBack, because what counts as a screen belongs to the app).
 *  3. At the chat itself there is nothing of ours left to go back to, so the
 *     gesture leaves the app: it closes itself.
 *
 * It never goes to the Umbrel dashboard. That was the old behaviour -- back
 * took the person out of Autora and onto https://<host>/, a different page
 * they had not asked for, instead of out of the app. Back means back.
 *
 * The mechanism is one entry of our own history, pushed when the app loads, so
 * the first back arrives here rather than at the end of the app's history.
 * Each back we answer puts that entry back, so it keeps arriving here. The one
 * back that leaves does not: it consumes the entry, so if the window will not
 * close itself (a browser tab rather than an installed app), the next back
 * reaches the end of the app's history and the browser closes it there.
 */

/** What is open over the chat, if anything: closing it is the first back. */
function topLayer(): HTMLElement | null {
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

/** How the app steps back one screen. True when it moved. */
type StepBack = () => boolean;

let stepBack: StepBack | null = null;

/**
 * Tell the back gesture how to step back one screen. Called by the app, and
 * taken back when it unmounts. One app, one answer: the last to register wins.
 */
export function setStepBack(fn: StepBack | null): () => void {
  stepBack = fn;
  return () => {
    if (stepBack === fn) stepBack = null;
  };
}

/**
 * What one back gesture does, given what the gesture found: something open on
 * top (closing it is the back), else whether the app could step back a screen,
 * else nothing left but to leave the app.
 *
 * Split out from the gesture itself so it can be tested without a browser.
 */
export function backAction(layerOpen: boolean, stepped: boolean): "close-layer" | "step-back" | "leave-app" {
  if (layerOpen) return "close-layer";
  if (stepped) return "step-back";
  return "leave-app";
}

/** Answer the back gesture, from the moment the app is on the screen. */
export function useBackGesture(): void {
  useEffect(() => {
    // One entry of our own, on top, so the first back arrives here instead of
    // at the end of the app's history.
    const sentinel = { autora: "back" };
    const hold = () => history.pushState(sentinel, "", location.href);
    hold();

    const onPop = () => {
      const layer = topLayer();
      const stepped = layer ? false : (stepBack?.() ?? false);
      switch (backAction(!!layer, stepped)) {
        case "close-layer":
          // Clicking the scrim is how it is closed by hand, so a memory or a
          // session list closes the way it always does.
          layer!.click();
          hold();
          return;
        case "step-back":
          // ...and the entry is put back, so the next back is answered here
          // too rather than at the end of the history.
          hold();
          return;
        default:
          // At the chat: leave the app, not the app's page on the Umbrel
          // dashboard. No entry is put back (see the note at the top).
          window.close();
          return;
      }
    };

    window.addEventListener("popstate", onPop);
    return () => window.removeEventListener("popstate", onPop);
  }, []);
}
