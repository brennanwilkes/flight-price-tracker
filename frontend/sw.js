// Service worker: Web Push display only (no offline cache yet).
// iOS revokes push permission when a push shows no notification, so every push shows one,
// with a generic line if the payload can't be read.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

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
