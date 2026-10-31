/* Service worker: the app shell, and Web Push. Classic script, no imports.
 * Shell handling ported from spirit-tracker viz/sw.js.
 *
 * BUILD and FILES are filled at deploy by scripts/stamp-pwa.mjs (deploy-pages.yml). UNSTAMPED
 * (localhost, or a deploy that skipped the stamp) this worker is a kill switch: it deletes its
 * caches, unregisters and reloads its pages, rather than serve a stale shell forever.
 *
 * Data is not handled here: it's cross-origin (raw.githubusercontent.com, pinned to a commit,
 * see app/main.js) and goes straight to the network. So the worker never shows old prices.
 *
 * iOS revokes push permission when a push shows no notification, so every push shows one, with
 * a generic line if the payload can't be read. Push works stamped or not.
 */

const BUILD = '__BUILD__';
const FILES = [/*__FILES__*/];
// Split so the stamp step, which replaces the placeholder exactly once, leaves this alone.
const UNSTAMPED = BUILD === '__' + 'BUILD__';
const SHELL = `shell-${BUILD}`;

self.addEventListener('install', (e) => {
  if (UNSTAMPED) {
    self.skipWaiting();
    return;
  }
  e.waitUntil((async () => {
    const cache = await caches.open(SHELL);
    // `?v=BUILD` makes every URL new to Pages' CDN, which keeps the previous deploy for up to
    // 10 min; `cache: 'reload'` skips the browser's HTTP cache. Stored under the clean URL.
    await Promise.all(FILES.map(async (u) => {
      const res = await fetch(`${u}?v=${BUILD}`, { cache: 'reload' });
      if (res.status !== 200) throw new Error(`[sw] precache ${u}: HTTP ${res.status}`);
      await cache.put(u, res);
    }));
  })());
  // No skipWaiting(): swapping modules under a running page mixes versions. app/pwa.js asks for
  // the swap at launch, on resume, or on a tap.
});

self.addEventListener('activate', (e) => {
  e.waitUntil((async () => {
    for (const name of await caches.keys()) {
      if (name.startsWith('shell-') && (UNSTAMPED || name !== SHELL)) await caches.delete(name);
    }
    if (UNSTAMPED) {
      await self.registration.unregister();
      for (const c of await self.clients.matchAll({ type: 'window' })) c.navigate(c.url);
      return;
    }
    await self.clients.claim();
  })());
});

self.addEventListener('message', (e) => {
  if (e.data === 'SKIP_WAITING') self.skipWaiting();
});

self.addEventListener('fetch', (e) => {
  if (UNSTAMPED) return;
  const req = e.request;
  if (req.method !== 'GET' || new URL(req.url).origin !== self.location.origin) return;
  e.respondWith((async () => {
    const cache = await caches.open(SHELL);
    // The cached index.html wins for navigations (any query string, e.g. from an alert), so
    // HTML and modules always come from the same build.
    if (req.mode === 'navigate') return (await cache.match('./index.html')) ?? fetch(req);
    // Shell: cache-first. Never caches a non-200: a cached 404 would live as long as the build.
    const hit = await cache.match(req);
    if (hit !== undefined) return hit;
    const res = await fetch(req);
    if (res.status === 200) await cache.put(req, res.clone());
    return res;
  })());
});

self.addEventListener('push', (e) => {
  let msg = {};
  try { msg = e.data?.json() ?? {}; } catch {}
  const title = msg.title || 'Fare alert';
  e.waitUntil(self.registration.showNotification(title, {
    body: msg.body || 'Something changed. Open the dashboard.',
    tag: msg.tag || 'fare',
    data: { url: msg.url || './' },
  }));
});

// Navigates (a full load) rather than just focusing, so the page reads the alert's ?v= data.
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const wins = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    const win = wins.find((w) => w.url.startsWith(self.registration.scope));
    if (win) { await win.focus(); return win.navigate(url); }
    return self.clients.openWindow(url);
  })());
});
