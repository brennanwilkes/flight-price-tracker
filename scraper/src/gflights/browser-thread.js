'use strict';
/* The flight-check browser in a worker thread of its own. Playwright drives Chromium from this
 * process's event loop; with it on the main thread, every page waited behind the checks' CPU work
 * (10:05 sweep, 2026-11-02: pages 3-6 s on an idle runner, median 31 s and 90% 247 s in the build).
 *
 *   const b = await openBrowserThread({ lean: true });
 *   const payloads = await b.shoppingResults(query, opts);   // as browser.shoppingResults
 *   await b.close();
 */
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (isMainThread || !workerData?.browserThread) { // required anywhere but the browser thread itself
  module.exports.openBrowserThread = (opts = {}) => new Promise((resolve, reject) => {
    const worker = new Worker(__filename, { workerData: { ...opts, browserThread: true } });
    const waiting = new Map();
    let next = 0;
    worker.on('message', (m) => {
      if (m.ready) return resolve({
        shoppingResults: (query, o = {}) => new Promise((ok, fail) => {
          const id = next++;
          waiting.set(id, { ok, fail });
          worker.postMessage({ id, query, opts: o });
        }),
        close: async () => { worker.postMessage({ close: true }); await new Promise((r) => worker.once('exit', r)); },
      });
      if (m.fatal) return reject(new Error(m.fatal));
      const w = waiting.get(m.id);
      waiting.delete(m.id);
      if (m.error) w.fail(new Error(m.error)); else w.ok(m.payloads);
    });
    worker.on('error', (e) => { for (const w of waiting.values()) w.fail(e); waiting.clear(); reject(e); });
    worker.on('exit', () => { for (const w of waiting.values()) w.fail(new Error('browser thread exited')); waiting.clear(); });
  });
} else {
  const { openBrowser, shoppingResults } = require('./browser');
  const { browserThread, ...opts } = workerData;
  openBrowser(opts).then(({ browser, ctx }) => {
    parentPort.on('message', async (m) => {
      if (m.close) { await browser.close().catch(() => {}); parentPort.close(); return; }
      try {
        parentPort.postMessage({ id: m.id, payloads: await shoppingResults(ctx, m.query, m.opts) });
      } catch (e) {
        parentPort.postMessage({ id: m.id, error: e.message });
      }
    });
    parentPort.postMessage({ ready: true });
  }, (e) => parentPort.postMessage({ fatal: e.message }));
}
