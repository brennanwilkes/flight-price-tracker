'use strict';
// One planning thread (threads.js): an arrival city in, its planCities parts out; null ends it.
const { parentPort, workerData } = require('node:worker_threads');
const config = require('../../config/sweep.json');
const { loadFares } = require('./fares');
const { planCities } = require('../../../frontend/app/build.js');

const { dataDir, now, checked, lands } = workerData;
const fares = loadFares(dataDir, config, { now, checked: new Map(checked), lands: new Map(lands) });
parentPort.on('message', (x) => {
  if (x == null) { parentPort.close(); return; }
  parentPort.postMessage({ x, ...planCities(fares, { cities: [x] }) });
});
parentPort.postMessage({ ready: true });
