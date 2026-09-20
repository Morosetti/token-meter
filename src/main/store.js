'use strict';
const fs = require('fs');
const path = require('path');
const { app } = require('electron');

const DEFAULTS = {
  // plan / calibration
  plan: 'max5',                 // pro | max5 | max20 | custom
  calibration: 1,               // scales the budget; 1 = use the built-in estimate
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

class Store {
  constructor(file) {
    this.file = file || path.join(app.getPath('userData'), 'settings.json');
    this.data = { ...DEFAULTS };
    this.load();
  }

  load() {
    try {
      const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
      this.data = { ...DEFAULTS, ...raw };
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
    this.data = { ...this.data, ...patch };
    this.save();
    return this.data;
  }

  reset() {
    this.data = { ...DEFAULTS };
    this.save();
    return this.data;
  }
}

module.exports = { Store, DEFAULTS };
