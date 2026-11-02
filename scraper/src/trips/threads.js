'use strict';
/* Trip planning on every CPU: planCities (build.js) per arrival city on worker threads, the parts
 * joined in fares.cities order (finishTrips), so the trips are the same as one thread's.
 *
 * Fares carry functions, so each thread loads its own from the same files and inputs (fares.js).
 */
const os = require('node:os');
const path = require('node:path');
const { Worker } = require('node:worker_threads');
const { buildTrips, finishTrips } = require('../../../frontend/app/build.js');

// Each thread's heap: one arrival city's planning at a time, its kept trips handed back after each.
const THREAD_HEAP_MB = 3072;

/**
 * buildTrips(fares) on `threads` threads. load: what fares came from, { dataDir, now, checked,
 * lands } (loadFares' inputs). One thread, or none to spare: buildTrips here.
 */
async function buildTripsThreaded(fares, load, threads = os.availableParallelism()) {
  if (threads < 2) return buildTrips(fares);
  const queue = [...fares.cities];
  const parts = new Map();
  const workerData = { dataDir: load.dataDir, now: load.now, checked: [...load.checked], lands: [...(load.lands ?? [])] };
  await Promise.all(Array.from({ length: Math.min(threads, queue.length) }, () => new Promise((done, fail) => {
    const w = new Worker(path.join(__dirname, 'threads-worker.js'), { workerData, resourceLimits: { maxOldGenerationSizeMb: THREAD_HEAP_MB } });
    w.on('message', (m) => {
      if (m.x) parts.set(m.x, m);
      w.postMessage(queue.shift() ?? null);
    });
    w.on('error', fail);
    w.on('exit', (code) => (code === 0 ? done() : fail(new Error(`planning thread exited ${code}`))));
  })));
  return finishTrips(...fares.cities.filter((x) => parts.has(x)).map((x) => parts.get(x)));
}

module.exports = { buildTripsThreaded };
