import { createRoot } from "react-dom/client";
import { App } from "./App";
import "./styles.css";

createRoot(document.getElementById("root")!).render(<App />);

// Registered for installability. It caches only hashed assets and the shell --
// see public/sw.js. Failure is silent and harmless: without it the app still
// works, it just cannot be added to a home screen.
if ("serviceWorker" in navigator) {
  window.addEventListener("load", () => {
    void navigator.serviceWorker.register("/sw.js").catch(() => undefined);
  });
}
