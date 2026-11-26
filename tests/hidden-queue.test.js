'use strict';
const test = require('node:test');
const assert = require('node:assert');
const { markHidden, hiddenFirst } = require('../scraper/src/trips/hidden-queue');

test('hidden cells\' searches (outbound or return) go first, order kept', () => {
  const fareKeys = new Map([['out1', 'A|B'], ['out2', 'C|D']]);
  const list = [{ keys: ['out2'] }, { keys: ['out1,"selected":[1]'] }, { keys: ['other'] }, { keys: ['out1'] }];
  assert.strictEqual(markHidden(list, { cell: 'A|B,X|Y' }, fareKeys), 2);
  assert.deepStrictEqual(hiddenFirst(list).map((s) => s.keys[0]), ['out1,"selected":[1]', 'out1', 'out2', 'other']);
});
