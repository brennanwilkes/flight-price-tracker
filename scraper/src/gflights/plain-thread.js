'use strict';
/* Plain search fetches (flights.js searchPlain) in a worker thread of their own, off the planner's
 * event loop. 10:05 am Vancouver, 2026-11-13: the network probe beside the sweep (scripts/netprobe.sh,
 * curl) loaded the same search page in 0.8-1.2 s all run, with the tunnel at ~1 MB/s and nothing
 * refused, while the job's own plain fetches took median 4.5 s, 90% 9.5 s, with 204 "fetch failed
 * (ETIMEDOUT)" in the build: the event loop they share with the checks was delayed up to 4 s.
 *
 *   const { searchPlain } = require('./plain-thread');
 *   const rows = await searchPlain(query, tries);   // as flights.js searchPlain; e.netMs, r.netMs: time in the thread
 */
const { Worker, isMainThread, parentPort, workerData } = require('node:worker_threads');

if (isMainThread || !workerData?.plainThread) {
  let worker = null;
  const waiting = new Map();
  let next = 0;
  const fail = (e) => { for (const w of waiting.values()) w.fail(e); waiting.clear(); worker = null; };
  const start = () => {
    worker = new Worker(__filename, { workerData: { plainThread: true } });
    worker.unref(); // held only while a fetch is in flight
    worker.on('message', (m) => {
      const w = waiting.get(m.id);
      if (!w) return;
      waiting.delete(m.id);
      if (!waiting.size) worker?.unref();
      if (m.error == null) { const rows = m.rows; Object.defineProperty(rows, 'netMs', { value: m.ms }); w.ok(rows); return; }
      const e = new Error(m.error);
      if (m.cause) e.cause = { code: m.cause, message: m.cause };
      e.netMs = m.ms;
      w.fail(e);
    });
    worker.on('error', fail);
    worker.on('exit', () => fail(new Error('plain search thread exited')));
  };
  module.exports.searchPlain = (query, tries = 2) => new Promise((ok, f) => {
    if (!worker) start();
    const id = next++;
    waiting.set(id, { ok, fail: f });
    worker.ref();
    worker.postMessage({ id, query, tries });
  });
} else {
  const { searchPlain } = require('./flights');
  // A cause for the log: the code, and for a connection tried on several addresses each one's.
  const causeOf = (e) => {
    const c = e.cause;
    if (!c) return null;
    const all = c.errors?.map((x) => `${x.code ?? x.message}${x.address ? ` ${x.address.includes(':') ? 'v6' : 'v4'}` : ''}`);
    return all?.length ? `${c.code ?? c.name}: ${all.join(', ')}` : c.code ?? c.message ?? String(c);
  };
  parentPort.on('message', async ({ id, query, tries }) => {
    const t0 = Date.now();
    try {
      const rows = await searchPlain(query, tries);
      parentPort.postMessage({ id, rows, ms: Date.now() - t0 });
    } catch (e) {
      parentPort.postMessage({ id, error: e.message, cause: causeOf(e), ms: Date.now() - t0 });
    }
  });
}
