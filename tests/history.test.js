'use strict';
const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { recordHistory, valuesAt } = require('../scraper/src/trips/history');

test('history: rows only on change, gone cells recorded empty, replays to any time', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  const c = (cls, total) => ({ home: 'YVR', cls, in: 'ICN', out: 'DAD', total });
  assert.strictEqual(recordHistory(dir, '2027-01-31T10:00:00Z', [c('hybrid', 4000), c('economy', 900)]), 2);
  assert.strictEqual(recordHistory(dir, '2027-01-31T11:00:00Z', [c('hybrid', 4000), c('economy', 900)]), 0);
  // Next month's file: the last-month value still counts as "last".
  assert.strictEqual(recordHistory(dir, '2027-02-01T09:00:00Z', [c('hybrid', 3800)]), 2);

  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'derived/history/2027-02.csv'), 'utf8').trim().split('\n').slice(1), [
    '2027-02-01T09:00:00Z,YVR,economy,ICN,DAD,',
    '2027-02-01T09:00:00Z,YVR,hybrid,ICN,DAD,3800',
  ]);
  const dayAgo = valuesAt(dir, '2027-01-31T10:30:00Z');
  assert.strictEqual(dayAgo.get('YVR,hybrid,ICN,DAD'), 4000);
  const now = valuesAt(dir, '2027-02-01T09:00:00Z');
  assert.strictEqual(now.get('YVR,hybrid,ICN,DAD'), 3800);
  assert.strictEqual(now.get('YVR,economy,ICN,DAD'), null);
});
