// Service worker registration and code updates. Ported from spirit-tracker viz/app/pwa.js.
// - A new build applies at launch and on resume (nothing on screen to lose); one that lands
//   mid-use offers a tap-to-reload bar instead of swapping code under the page.
// - Only a deploy-stamped build registers the worker (scripts/stamp-pwa.mjs fills fl-build);
//   unstamped (localhost) any old registration is removed.
// Data freshness is app/main.js's job: the worker never serves data.

// An automatic swap reloads only if it lands this soon after being asked for; later, the
// person is already using the page, so it becomes the bar.
const AUTO_APPLY_RELOAD_MS = 5000;
const BAR_RANK = { fresh: 1, update: 2 };

let autoApplyAt = null;

export const isStandalone = () => navigator.standalone === true || matchMedia('(display-mode: standalone)').matches;

/** Resolves to the registration, or null when there's no worker (unsupported or unstamped). */
export function register() {
  if (!('serviceWorker' in navigator)) return Promise.resolve(null);
  if (document.querySelector('meta[name="fl-build"]').content === '__BUILD__') {
    navigator.serviceWorker.getRegistrations().then((regs) => { for (const r of regs) r.unregister(); });
    return Promise.resolve(null);
  }

  const registered = navigator.serviceWorker.register('sw.js', { scope: './', updateViaCache: 'none' });
  registered.then((reg) => {
    if (reg.waiting !== null) applyNow(reg.waiting); // launch: nothing on screen yet
    reg.addEventListener('updatefound', () => {
      const sw = reg.installing;
      if (sw === null) return;
      sw.addEventListener('statechange', () => {
        // A controller already exists => this is an update, not the first install.
        if (sw.state === 'installed' && navigator.serviceWorker.controller !== null) {
          showBar('update', 'A new version is ready. Tap to reload.', () => { autoApplyAt = null; sw.postMessage('SKIP_WAITING'); });
        }
      });
    });
  }).catch((err) => console.error('[pwa] registration failed:', err));

  // The first install's clients.claim() also fires controllerchange; that isn't an update.
  let controlled = navigator.serviceWorker.controller !== null;
  let reloading = false;
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (!controlled) { controlled = true; return; }
    if (autoApplyAt !== null && Date.now() - autoApplyAt > AUTO_APPLY_RELOAD_MS) {
      showBar('update', 'A new version is ready. Tap to reload.', () => location.reload());
      return;
    }
    if (reloading) return;
    reloading = true;
    location.reload();
  });

  document.addEventListener('visibilitychange', async () => {
    if (document.visibilityState !== 'visible') return;
    const reg = await registered;
    if (reg.waiting !== null) applyNow(reg.waiting);
    else reg.update();
  });
  return registered.catch(() => null);
}

function applyNow(sw) {
  autoApplyAt = Date.now();
  sw.postMessage('SKIP_WAITING');
}

/** A bar at the bottom of the screen; tapping it runs onTap. A lower-ranked bar never replaces a higher one. */
export function showBar(kind, text, onTap) {
  const cur = document.getElementById('pwaBar');
  if (cur !== null) {
    if (BAR_RANK[cur.dataset.kind] > BAR_RANK[kind]) return;
    cur.remove();
  }
  const bar = document.createElement('button');
  bar.type = 'button';
  bar.id = 'pwaBar';
  bar.className = `pwaBar pwaBar-${kind}`;
  bar.dataset.kind = kind;
  bar.textContent = text;
  bar.addEventListener('click', () => { bar.remove(); onTap(); });
  document.body.appendChild(bar);
}

export function clearBar(kind) {
  const cur = document.getElementById('pwaBar');
  if (cur?.dataset.kind === kind) cur.remove();
}
