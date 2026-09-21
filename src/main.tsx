import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

/**
 * The service worker, and getting off an old copy of the app.
 *
 * It is registered for installability and an offline shell, and that shell is
 * the problem this code exists for: load the page while the server is briefly
 * down -- which is precisely what an update does -- and the cached shell is
 * served, pointing at the previous bundle, which is also cached. The app then
 * runs old code and looks completely normal. Nothing says "you are three
 * versions behind"; the only symptom is that a change you were told shipped is
 * not there, which is indistinguishable from the change being wrong. It cost
 * an evening of chasing fixes that had in fact already landed.
 *
 * Worse, a worker is per origin, so reaching the same server over http on one
 * port and https on another leaves two independent caches. Updating "the app"
 * updates one of them.
 *
 * So: ask for a fresh worker on every load, and when one takes over, reload
 * once into it. `skipWaiting` in the worker means it activates without waiting
 * for tabs to close, and `controllerchange` is how the page learns that
 * happened. The guard matters -- without it the reload fires again on the next
 * controller change and the app spins.
 */
if ("serviceWorker" in navigator) {
  let reloading = false;
  navigator.serviceWorker.addEventListener("controllerchange", () => {
    if (reloading) return;
    reloading = true;
    window.location.reload();
  });

  window.addEventListener("load", () => {
    void navigator.serviceWorker
      .register("/sw.js")
      .then((registration) => registration.update())
      .catch(() => undefined);
  });
}
