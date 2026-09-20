'use strict';
/**
 * Cost model.
 *
 * Prices are USD per 1M tokens, from the published API pricing table.
 * Cache multipliers relative to that model's INPUT price:
 *   - 5-minute cache write : 1.25x
 *   - 1-hour cache write   : 2.00x
 *   - cache read           : 0.10x
 * Fable 5.x is the exception: its cache reads are a flat $0.25/MTok.
 *
 * Everything here is data, not logic. Users can override any of it from
 * Settings -> Advanced, which writes into the same shape.
 */

const MODELS = [
  // matcher (lowercase substring, first hit wins), input, output, label
  { match: 'fable',    in: 10.0, out: 50.0, cacheReadFlat: 0.25, label: 'Fable' },
  { match: 'mythos',   in: 10.0, out: 50.0, cacheReadFlat: 0.25, label: 'Mythos' },
  { match: 'opus',     in: 5.0,  out: 25.0, label: 'Opus' },
  { match: 'sonnet-4', in: 3.0,  out: 15.0, label: 'Sonnet 4.6' },
  { match: 'sonnet',   in: 2.0,  out: 10.0, label: 'Sonnet' },
  { match: 'haiku',    in: 1.0,  out: 5.0,  label: 'Haiku' },
];

const FALLBACK = { in: 3.0, out: 15.0, label: 'Outro' };

const CACHE_WRITE_5M = 1.25;
const CACHE_WRITE_1H = 2.0;
const CACHE_READ = 0.1;

const _cache = new Map();

/** Resolve a raw model id to its price row, matching on the family substring. */
function priceFor(modelId, overrides) {
  const id = String(modelId || '').toLowerCase();
  if (overrides && overrides[id]) return overrides[id];
  if (_cache.has(id)) return _cache.get(id);
  const row = MODELS.find((m) => id.includes(m.match)) || FALLBACK;
  _cache.set(id, row);
  return row;
}

/** Short human label for grouping in the UI ("Opus", "Sonnet", "Haiku"). */
function familyOf(modelId) {
  return priceFor(modelId).label;
}

/**
 * USD cost of a single usage record.
 * `e` is a reader entry: { model, input, out, cr, cw5, cw1h }
 */
function costOf(e, overrides) {
  const p = priceFor(e.model, overrides);
  const M = 1e6;
  const readRate = p.cacheReadFlat != null ? p.cacheReadFlat : p.in * CACHE_READ;
  return (
    (e.input * p.in +
      e.cw5 * p.in * CACHE_WRITE_5M +
      e.cw1h * p.in * CACHE_WRITE_1H +
      e.cr * readRate +
      e.out * p.out) / M
  );
}

/** Raw token count (every kind of token, unweighted). */
function tokensOf(e) {
  return e.input + e.cw5 + e.cw1h + e.cr + e.out;
}

module.exports = { priceFor, familyOf, costOf, tokensOf, MODELS, FALLBACK };
