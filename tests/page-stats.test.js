'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { profile, summary } = require('../scraper/src/gflights/page-stats');

// A page whose CDP metrics climb by fixed amounts between the first and second read.
function fakePage(cpu) {
  const handlers = {};
  let reads = 0;
  const cdp = {
    send: async (m) => {
      if (m !== 'Performance.getMetrics') return {};
      const k = reads++ ? 1 : 0;
      return { metrics: [{ name: 'ProcessTime', value: k * cpu }, { name: 'TaskDuration', value: k * cpu / 2 }, { name: 'ScriptDuration', value: k * cpu / 4 }, { name: 'Nodes', value: 9 }] };
    },
    detach: async () => {},
  };
  return {
    on: (e, f) => { handlers[e] = f; },
    fire: (type) => handlers.request({ resourceType: () => type }),
    context: () => ({ newCDPSession: async () => cdp }),
  };
}

test('page-stats: phases, renderer CPU and requests a page', async () => {
  const all = {};
  const stats = require('../scraper/src/gflights/page-stats').stats;
  for (const cpu of [2, 6]) {
    const page = fakePage(cpu);
    const p = await profile(page, 'probe', Date.now() - 100);
    p.mark('open');
    page.fire('xhr'); page.fire('xhr'); page.fire('image');
    p.mark('load');
    await p.done(cpu === 2);
  }
  all.probe = stats.probe;
  const [line] = summary(all);
  assert.match(line, /^probe pages: 2 \(1 failed\)/);
  assert.match(line, /open 0\.1\/0\.1 s/);
  assert.match(line, /process 2\.0\/2\.0 s, main thread 1\.0 \(script 0\.5/);
  assert.match(line, /all pages' renderer CPU 8 s \(2 measured\)/);
  assert.match(line, /requests a page: xhr 2\.0, image 1\.0/);
});

test('page-stats: a page without CDP still counts', async () => {
  const page = { on: () => {}, context: () => ({ newCDPSession: async () => { throw new Error('no cdp'); } }) };
  const p = await profile(page, 'nocdp');
  p.mark('load');
  await p.done();
  const line = summary().find((l) => l.startsWith('nocdp'));
  assert.match(line, /nocdp pages: 1 \(0 failed\).*renderer CPU not measured/);
});
