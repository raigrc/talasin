/*
 * Talasin service worker — minimal, hand-written (DESIGN.md §7).
 *
 * Strategy:
 *   - Network-first for navigations (HTML) so a gated/expired page is never
 *     served stale from cache.
 *   - Cache-first for static assets (Next static chunks, icons, fonts).
 *   - NEVER cache /api/** requests or audio — this guards against retaining
 *     transcripts/audio locally and against serving stale API data.
 */

const CACHE = "talasin-static-v1";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  void event;
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    (async () => {
      const keys = await caches.keys();
      await Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k)));
      await self.clients.claim();
    })(),
  );
});

function isCacheableStatic(url) {
  return (
    url.pathname.startsWith("/_next/static/") ||
    url.pathname.startsWith("/icons/") ||
    url.pathname === "/manifest.webmanifest" ||
    /\.(?:css|js|woff2?|png|svg|ico|webp)$/.test(url.pathname)
  );
}

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);

  // Only handle same-origin requests.
  if (url.origin !== self.location.origin) return;

  // HARD SKIP: never touch API routes or audio. Let them go straight to network,
  // uncached, both request and response.
  if (url.pathname.startsWith("/api/")) return;
  if (req.destination === "audio") return;
  if (/\.(?:webm|ogg|mp3|wav|m4a|aac|flac|aiff)$/.test(url.pathname)) return;

  // Network-first for page navigations.
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req).catch(async () => {
        const cached = await caches.match(req);
        return cached || Response.error();
      }),
    );
    return;
  }

  // Cache-first for static assets.
  if (isCacheableStatic(url)) {
    event.respondWith(
      (async () => {
        const cached = await caches.match(req);
        if (cached) return cached;
        const res = await fetch(req);
        if (res.ok) {
          const cache = await caches.open(CACHE);
          cache.put(req, res.clone());
        }
        return res;
      })(),
    );
  }
});
