import { useCallback, useEffect, useState } from "react";
import { IconArrow, IconX } from "./Icons";

/** How often to ask the server what it is running. Cheap, and the answer only
    matters around a deploy. */
const POLL_MS = 45_000;

/** What this page was stamped as when the server handed it over. */
const PAGE_VERSION =
  document.querySelector<HTMLMetaElement>('meta[name="autora-version"]')?.content ?? "dev";

/** The version the server is running now, polled. */
export function useServerVersion(): string | null {
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    const read = () =>
      fetch("/api/origin", { cache: "no-store" })
        .then((r) => r.json())
        .then((body) => {
          if (alive && typeof body?.version === "string") setVersion(body.version);
        })
        .catch(() => undefined);
    read();
    const timer = window.setInterval(read, POLL_MS);
    return () => { alive = false; window.clearInterval(timer); };
  }, []);

  return version;
}

/** What is on screen, and what is actually installed. */
export function versions(server: string | null) {
  return {
    page: PAGE_VERSION,
    server,
    /* "dev" means a development server handed the page over rather than
       Autora, so there is nothing to compare and nothing to complain about. */
    stale: PAGE_VERSION !== "dev" && !!server && server !== PAGE_VERSION,
  };
}

/**
 * "You are looking at an old copy of the app."
 *
 * This failure has now cost several rounds of confusion, and it deserves to
 * report itself rather than be diagnosed. An update lands, the browser is
 * holding the previous shell in its cache, and the page keeps running the old
 * code -- working perfectly, simply not the version that was installed. There
 * is nothing to notice: no error, no blank screen, just a change that is
 * apparently missing.
 *
 * The page knows what it was built as and can ask what is installed, so when
 * those disagree it says so and offers the one action that fixes it. Clearing
 * the caches first, because a plain reload can be served the same old shell.
 */
export function UpdateNotice() {
  const server = useServerVersion();
  const { page, stale } = versions(server);
  const [dismissed, setDismissed] = useState(false);
  const [reloading, setReloading] = useState(false);

  const refresh = useCallback(async () => {
    setReloading(true);
    try {
      if ("caches" in window) {
        const keys = await caches.keys();
        await Promise.all(keys.map((key) => caches.delete(key)));
      }
      const workers = await navigator.serviceWorker?.getRegistrations?.();
      await Promise.all((workers ?? []).map((w) => w.update().catch(() => undefined)));
    } catch {
      /* Cleared or not, the reload below is still the right next move. */
    }
    location.reload();
  }, []);

  if (!stale || dismissed) return null;

  return (
    <div className="update-notice" role="status">
      <span className="update-text">
        <b>Autora {server} is installed.</b> This page is still running {page} from
        your browser's cache.
      </span>
      <button className="btn primary" onClick={() => void refresh()} disabled={reloading}>
        {reloading ? "Reloading…" : <>Load {server} <IconArrow size={13} /></>}
      </button>
      <button
        className="btn icon ghost"
        onClick={() => setDismissed(true)}
        aria-label="Dismiss"
      >
        <IconX size={14} />
      </button>
    </div>
  );
}
