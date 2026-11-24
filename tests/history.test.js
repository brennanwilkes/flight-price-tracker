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

  assert.deepStrictEqual(fs.readFileSync(path.join(dir, 'derived/history/2027-02-01.csv'), 'utf8').trim().split('\n').slice(1), [
    '2027-02-01T09:00:00Z,YVR,economy,ICN,DAD,',
    '2027-02-01T09:00:00Z,YVR,hybrid,ICN,DAD,3800',
  ]);
  const dayAgo = valuesAt(dir, '2027-01-31T10:30:00Z');
  assert.strictEqual(dayAgo.get('YVR,hybrid,ICN,DAD'), 4000);
  const now = valuesAt(dir, '2027-02-01T09:00:00Z');
  assert.strictEqual(now.get('YVR,hybrid,ICN,DAD'), 3800);
  assert.strictEqual(now.get('YVR,economy,ICN,DAD'), null);
});

test('history: a month\'s file (before Nov 24, 2026) replays before that month\'s day files', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hist-'));
  fs.mkdirSync(path.join(dir, 'derived/history'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'derived/history/2026-11.csv'), 'generated_at,home,class,in,out,total\n2026-11-24T10:00:00Z,YVR,hybrid,ICN,DAD,4000\n');
  assert.strictEqual(recordHistory(dir, '2026-11-24T11:00:00Z', [{ home: 'YVR', cls: 'hybrid', in: 'ICN', out: 'DAD', total: 4000 }]), 0);
  assert.strictEqual(recordHistory(dir, '2026-11-24T12:00:00Z', [{ home: 'YVR', cls: 'hybrid', in: 'ICN', out: 'DAD', total: 3900 }]), 1);
  assert.strictEqual(valuesAt(dir, '2026-11-24T12:00:00Z').get('YVR,hybrid,ICN,DAD'), 3900);
  assert.strictEqual(valuesAt(dir, '2026-11-24T11:00:00Z').get('YVR,hybrid,ICN,DAD'), 4000);
  assert.ok(fs.existsSync(path.join(dir, 'derived/history/2026-11-24.csv')));
});
