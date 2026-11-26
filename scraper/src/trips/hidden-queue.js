'use strict';
// A hidden cell is a trip whose return search was never made (details.js unlistedWhy). Its
// outstanding search is the one that shows it, so the search runner takes those first.
const SELECTED = ',"selected":['; // as details.js: a return search's key is its outbound's key + this + the pick

/**
 * Marks each queued search `hidden` when it is a search of a hidden cell's trip: the build's
 * `sigs` (cell id → its tickets' fareKeys, comma-joined) against `fareKeys` (outbound search key →
 * fareKey; a return search's key starts with its outbound's).
 */
function markHidden(list, sigs, fareKeys) {
  const hid = new Set();
  for (const sig of Object.values(sigs ?? {})) for (const k of String(sig).split(',')) hid.add(k);
  for (const s of list) {
    s.hidden = s.keys.some((k) => {
      const i = k.indexOf(SELECTED);
      return hid.has(fareKeys?.get?.(i < 0 ? k : k.slice(0, i)));
    });
  }
  return list.filter((s) => s.hidden).length;
}

/** The queue with hidden cells' searches first, each group in its own order. */
const hiddenFirst = (queue) => [...queue.filter((s) => s.hidden), ...queue.filter((s) => !s.hidden)];

module.exports = { markHidden, hiddenFirst };
