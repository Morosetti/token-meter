'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // plan / calibration
  plan: 'max5',                 // pro | max5 | max20 | custom
  autoCalibrate: true,          // raise the budget to whatever history proves you reached

  // Opt-in: ask the server for the real numbers using the CLI's stored token.
  // Undocumented endpoint, so it is off unless the user turns it on.
  officialSource: false,
  officialCalibrate: true,      // let a successful fetch calibrate the estimate
  calibration: 1,               // manual factor; 1 = use the built-in estimate
  customSession: 30,
  customWeek: 350,
  sessionHours: 5,
  weekMode: 'rolling',          // rolling | fixed
  weekResetDay: 1,              // 0=Sun .. 6=Sat, used when weekMode=fixed
  weekResetHour: 0,

  // tray badge
  badgeMetric: 'max',           // session | week | max | today
  badgeStyle: 'ring',           // ring | bar | dot
  badgeShowNumber: true,

  // floating overlay
  overlayEnabled: false,
  overlayBounds: null,          // { x, y } persisted between runs
  overlayOpacity: 0.92,
  overlayClickThrough: false,
  overlayCompact: false,
  overlayAlwaysOnTop: true,

  // general
  refreshSeconds: 20,
  launchAtLogin: false,
  theme: 'dark',                // dark | light
  extraRoots: [],
  priceOverrides: {},
  warnAt: 80,                   // % that turns the badge amber
  dangerAt: 95,                 // % that turns it red
};

/* ------------------------------------------------------------ validation -- */

const bool = (v) => (typeof v === 'boolean' ? v : undefined);
const oneOf = (...allowed) => (v) => (allowed.includes(v) ? v : undefined);

const num = (min, max, { int = false } = {}) => (v) => {
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  const clamped = Math.min(max, Math.max(min, n));
  return int ? Math.round(clamped) : clamped;
};

/** Window position, or null to fall back to the default corner. */
const point = (v) => {
  if (v === null) return null;
  if (!v || typeof v !== 'object') return undefined;
  const x = num(-32000, 32000, { int: true })(v.x);
  const y = num(-32000, 32000, { int: true })(v.y);
  return x === undefined || y === undefined ? undefined : { x, y };
};

/**
 * Extra transcript directories. Not exposed in the UI, so this exists mainly to
 * stop a malformed value from steering the reader somewhere unexpected: it must
 * be a short list of plain absolute paths, nothing else.
 */
const roots = (v) => {
  if (!Array.isArray(v)) return undefined;
  const out = v
    .filter((p) => typeof p === 'string' && p.trim() !== '' && !p.includes('\0'))
    .map((p) => path.resolve(p.trim()))
    .slice(0, 8);
  return out;
};

/** Per-model price overrides: a small map of plain numeric rates. */
const prices = (v) => {
  if (!v || typeof v !== 'object' || Array.isArray(v)) return undefined;
  const out = Object.create(null);
  for (const [key, row] of Object.entries(v).slice(0, 50)) {
    if (key === '__proto__' || !row || typeof row !== 'object') continue;
    const i = num(0, 1e4)(row.in);
    const o = num(0, 1e4)(row.out);
    if (i === undefined || o === undefined) continue;
    const entry = { in: i, out: o };
    if (typeof row.label === 'string') entry.label = row.label.slice(0, 40);
    const cr = num(0, 1e4)(row.cacheReadFlat);
    if (cr !== undefined) entry.cacheReadFlat = cr;
    out[key] = entry;
  }
  return out;
};

/**
 * One validator per setting. Anything not listed here is dropped, so neither a
 * renderer nor a hand-edited file can introduce keys the app never defined —
 * including `__proto__`, which `Object.entries` would otherwise carry through.
 */
const SCHEMA = {
  plan: oneOf('pro', 'max5', 'max20', 'custom'),
  calibration: num(0.02, 50),
  customSession: num(0.01, 1e5),
  customWeek: num(0.01, 1e6),
  sessionHours: num(1, 24),
  weekMode: oneOf('rolling', 'fixed'),
  weekResetDay: num(0, 6, { int: true }),
  weekResetHour: num(0, 23, { int: true }),

  autoCalibrate: bool,
  officialSource: bool,
  officialCalibrate: bool,

  badgeMetric: oneOf('session', 'week', 'max', 'today'),
  badgeStyle: oneOf('ring', 'bar', 'dot'),
  badgeShowNumber: bool,

  overlayEnabled: bool,
  overlayBounds: point,
  overlayOpacity: num(0.15, 1),
  overlayClickThrough: bool,
  overlayCompact: bool,
  overlayAlwaysOnTop: bool,

  refreshSeconds: num(5, 3600, { int: true }),
  launchAtLogin: bool,
  theme: oneOf('dark', 'light'),
  extraRoots: roots,
  priceOverrides: prices,
  warnAt: num(1, 200),
  dangerAt: num(1, 300),
};

/** Keep only known keys carrying valid values. */
function sanitize(patch) {
  const out = {};
  if (!patch || typeof patch !== 'object' || Array.isArray(patch)) return out;
  for (const key of Object.keys(SCHEMA)) {
    if (!Object.prototype.hasOwnProperty.call(patch, key)) continue;
    const value = SCHEMA[key](patch[key]);
    if (value !== undefined) out[key] = value;
  }
  return out;
}

/* ----------------------------------------------------------------- store -- */

class Store {
  constructor(file) {
    this.file = file || path.join(app.getPath('userData'), 'settings.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      // Run the file through the same validation as an IPC patch. A settings
      // file that was hand-edited, corrupted, or written by an older version
      // must not be able to put the app into a state the UI cannot produce.
      this.data = { ...DEFAULTS, ...sanitize(raw) };
    } catch {
      // First run, or a corrupt file we can safely regenerate.
    }
    return this.data;
  }

  save() {
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      fs.writeFileSync(this.file, JSON.stringify(this.data, null, 2));
    } catch (err) {
      console.error('[store] could not persist settings:', err.message);
    }
  }

  get() { return this.data; }

  set(patch) {
    this.data = { ...this.data, ...sanitize(patch) };
    this.save();
    return this.data;
  }

  reset() {
    this.data = { ...DEFAULTS };
    this.save();
    return this.data;
  }
}

module.exports = { Store, DEFAULTS, sanitize };
