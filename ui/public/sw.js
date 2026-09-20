/**
 * Service worker: installability, and a shell that loads instantly.
 *
 * Autora is a live view of a machine on your network, so there is no useful
 * offline mode and caching is not the point -- being installable to a home
 * screen is. What this does cache is only what is safe to: the built assets,
 * which carry content hashes in their names and so can never go stale, and the
 * shell HTML, served network-first so a deploy is picked up on the next load.
 *
 * Everything live is deliberately untouched. /api/ and /ws/ go straight to the
 * network every time; a cached session list or a replayed event stream would be
 * worse than no service worker at all.
 */

const CACHE = "autora-v1";

self.addEventListener("install", () => {
  // Take over as soon as the new worker is ready rather than waiting for every
  // tab to close -- this is a single-user app on a LAN, not a public site.
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const request = event.request;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  // Live data and the event stream are never cached, never intercepted.
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/ws/")) return;

  // The shell: network first, falling back to the last good copy so a launch
  // from the home screen still paints if the server is briefly unreachable.
  if (request.mode === "navigate") {
    event.respondWith(
      fetch(request)
        .then((response) => {
          const copy = response.clone();
          caches.open(CACHE).then((cache) => cache.put("/", copy)).catch(() => {});
          return response;
        })
        .catch(() => caches.match("/").then((hit) => hit || Response.error())),
    );
    return;
  }

  // Hashed build output and fonts: immutable, so a hit is always correct.
  if (url.pathname.startsWith("/assets/") || url.pathname.startsWith("/fonts/")) {
    event.respondWith(
      caches.match(request).then(
        (hit) =>
          hit ||
          fetch(request).then((response) => {
            if (response.ok) {
              const copy = response.clone();
              caches.open(CACHE).then((cache) => cache.put(request, copy)).catch(() => {});
            }
            return response;
          }),
      ),
    );
  }
});
