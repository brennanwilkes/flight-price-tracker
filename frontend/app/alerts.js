// "Enable alerts": registers sw.js, subscribes to Web Push with the Worker's VAPID key and
// hands the subscription to the Worker (one subscription; a new one replaces the old).
// Shows the Worker's push health so a dead subscription is visible (SCOPE: Notifications).
// Also the "scrape everything now" button (Worker POST /sweep).

export const WORKER = new URLSearchParams(location.search).get('worker') ?? 'https://flight-fare-tracker.brennan-a53.workers.dev';

const b64url = (s) => Uint8Array.from(atob(s.replace(/-/g, '+').replace(/_/g, '/')), (c) => c.charCodeAt(0));
const standalone = () => matchMedia('(display-mode: standalone)').matches || navigator.standalone === true;
const ios = () => /iPhone|iPad|iPod/.test(navigator.userAgent);
const ago = (iso) => {
  const h = (Date.now() - Date.parse(iso)) / 36e5;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))} min ago` : h < 48 ? `${Math.round(h)} h ago` : `${Math.round(h / 24)} days ago`;
};

async function subscribe() {
  const reg = await navigator.serviceWorker.register('sw.js');
  if ((await Notification.requestPermission()) !== 'granted') throw new Error('notifications not allowed');
  const { publicKey } = await (await fetch(`${WORKER}/vapid`)).json();
  const sub = (await reg.pushManager.getSubscription())
    ?? await reg.pushManager.subscribe({ userVisibleOnly: true, applicationServerKey: b64url(publicKey) });
  const res = await fetch(`${WORKER}/subscribe`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(sub) });
  if (!res.ok) throw new Error(`subscribe: HTTP ${res.status}`);
}

async function health() {
  try {
    const res = await fetch(`${WORKER}/health`, { cache: 'no-store' });
    return res.ok ? await res.json() : null;
  } catch { return null; }
}

/** Render the alerts line into `el`. */
export async function alertsBar(el) {
  if (!('serviceWorker' in navigator) || !('PushManager' in window)) {
    el.innerHTML = ios() && !standalone()
      ? 'Alerts: Share → Add to Home Screen, then open it from there.'
      : 'Alerts aren’t supported in this browser.';
    return;
  }
  const h = await health();
  const reg = await navigator.serviceWorker.getRegistration();
  const here = Notification.permission === 'granted' && !!(await reg?.pushManager.getSubscription());
  let status;
  if (!h) status = 'Alert server unreachable.';
  else if (!h.subscribed) status = '<b class="warn">Alerts off.</b>';
  else if (h.lastError && (!h.lastPushAt || h.lastErrorAt > h.lastPushAt)) status = `<b class="warn">Last push failed</b> (${ago(h.lastErrorAt)}).`;
  else status = `Alerts on${h.lastPushAt ? ` · last push ${ago(h.lastPushAt)}` : ''}.`;
  el.innerHTML = `${status} <button type="button">${here && h?.subscribed ? 'Re-subscribe' : 'Enable alerts'}</button>`;
  el.querySelector('button').addEventListener('click', async (e) => {
    e.target.disabled = true;
    try {
      await subscribe();
    } catch (err) {
      el.textContent = `Couldn't enable alerts: ${err.message}`;
      return;
    }
    alertsBar(el);
  });
}

/** Ask the Worker for a full sweep now; it allows one per 30 min. Returns a status line. */
async function requestSweep() {
  const res = await fetch(`${WORKER}/sweep`, { method: 'POST' });
  const r = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(r.error ?? `HTTP ${res.status}`);
  return r.started ? 'Full scrape started: new prices in ~30 min.' : `A full scrape started ${ago(r.at)}; next allowed 30 min after it.`;
}

/**
 * "Scrape everything now" button in `el`. Opening the page from an alert (?sweep=1) presses it
 * automatically, so the rest of the routes refresh while the deal is being looked at.
 */
export function sweepButton(el) {
  const run = async () => {
    el.textContent = 'Starting a full scrape…';
    try { el.textContent = await requestSweep(); } catch (e) { el.textContent = `Couldn't start a scrape: ${e.message}`; }
  };
  el.innerHTML = '<button type="button">Scrape everything now</button>';
  el.querySelector('button').addEventListener('click', run);
  const params = new URLSearchParams(location.search);
  if (params.get('sweep') === '1') {
    params.delete('sweep');
    history.replaceState(null, '', `${location.pathname}${params.size ? `?${params}` : ''}${location.hash}`);
    run();
  }
}
