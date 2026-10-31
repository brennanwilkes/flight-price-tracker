// Service worker: Web Push display, and no stale app files.
// iOS revokes push permission when a push shows no notification, so every push shows one,
// with a generic line if the payload can't be read.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

// GitHub Pages sends max-age=600, so after a deploy the browser could mix a new index.html with
// old modules for 10 min. Revalidate every same-origin file instead (a cheap 304 when unchanged).
self.addEventListener('fetch', (e) => {
  if (e.request.method !== 'GET' || new URL(e.request.url).origin !== self.location.origin) return;
  e.respondWith(fetch(e.request, { cache: 'no-cache' }));
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
