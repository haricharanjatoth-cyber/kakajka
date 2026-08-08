

const STATIC_CACHE = "streamhub-static-v3";
const DATA_CACHE = "streamhub-data-v3";

const STATIC_ASSETS = [
  "/", "/index.html", "/style.css", "/config.js", "/script.js", "/countries.js",
  "/categories.js", "/categories/index.html",
  "/account.html", "/account.js", "/firebase-config.js", "/auth.js",
  "/v/watch/index.html", "/v/watch/watch.js",
  "/models/profile/index.html", "/models/profile/profile.js",
  "/placeholder.webp", "/placeholder-avatar.webp",
];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(STATIC_CACHE).then((cache) =>
      // Add each asset independently so one missing file can't fail
      // the entire precache the way cache.addAll() would.
      Promise.allSettled(
        STATIC_ASSETS.map((url) =>
          cache.add(url).catch((err) =>
            console.warn(`[sw] precache skipped "${url}":`, err)
          )
        )
      )
    )
  );
  self.skipWaiting();
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys().then((keys) =>
      Promise.all(
        keys.filter((k) => k !== STATIC_CACHE && k !== DATA_CACHE).map((k) => caches.delete(k))
      )
    )
  );
  self.clients.claim();
});

function isJsonDataRequest(url) {
  return url.pathname.endsWith(".json");
}

function isJsRequest(url) {
  return url.pathname.endsWith(".js");
}

// Shared network-first-with-cache-fallback strategy, used for both
// page navigations and .js files — anything where serving a stale
// copy means the site is running outdated logic, not just an
// outdated picture.
function networkFirst(event) {
  return fetch(event.request)
    .then((res) => {
      if (res.ok) {
        // Clone SYNCHRONOUSLY, in the same tick res arrives — not
        // inside the caches.open().then() below. See FIX note above.
        const resClone = res.clone();
        caches.open(STATIC_CACHE).then((cache) => cache.put(event.request, resClone));
      }
      return res;
    })
    .catch(() =>
      caches.match(event.request).then((cached) => cached || (event.request.mode === "navigate" ? caches.match("/index.html") : undefined))
    );
}

self.addEventListener("fetch", (event) => {
  const url = new URL(event.request.url);
  if (event.request.method !== "GET") return;
  if (url.origin !== self.location.origin) return;

  // Navigation requests (actual page loads, e.g. clicking a link or
  // typing a URL) and .js files both get network-first with cache
  // fallback, so visitors always run your latest deployed HTML/JS and
  // only fall back to a cached copy if the network genuinely fails
  // (e.g. offline).
  if (event.request.mode === "navigate" || isJsRequest(url)) {
    event.respondWith(networkFirst(event));
    return;
  }

  // Stale-while-revalidate for content*.json / authors.json — serve the
  // cached copy instantly, then quietly refresh the cache in the
  // background for next time. Falls back to network if nothing cached.
  if (isJsonDataRequest(url)) {
    event.respondWith(
      caches.open(DATA_CACHE).then(async (cache) => {
        const cached = await cache.match(event.request);
        const networkFetch = fetch(event.request)
          .then((res) => {
            // Same rule as above: clone immediately on arrival. This one
            // was already safe (cache is resolved before fetch starts,
            // so there's no async gap between receiving res and cloning
            // it) — kept as-is, just noting why it wasn't part of the bug.
            if (res.ok) cache.put(event.request, res.clone());
            return res;
          })
          .catch(() => cached);
        return cached || networkFetch;
      })
    );
    return;
  }

  // Cache-first for same-origin static assets that aren't logic-bearing
  // (CSS, images). The .catch() here is the critical fix — without it,
  // a failed fetch() with nothing cached crashes the whole request
  // with ERR_FAILED instead of just letting the browser's normal
  // error handling take over.
  event.respondWith(
    caches.match(event.request).then(
      (cached) => cached || fetch(event.request).catch(() => cached)
    )
  );
});