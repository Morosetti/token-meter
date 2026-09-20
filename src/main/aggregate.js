'use strict';
const { costOf, tokensOf, familyOf } = require('./pricing');
const { SESSION_HOURS, budgets } = require('./plans');

const HOUR = 36e5;
const DAY = 864e5;

function blank() {
  return { cost: 0, tokens: 0, input: 0, out: 0, cacheWrite: 0, cacheRead: 0, calls: 0 };
}

function add(acc, e, overrides) {
  acc.cost += costOf(e, overrides);
  acc.tokens += tokensOf(e);
  acc.input += e.input;
  acc.out += e.out;
  acc.cacheWrite += e.cw5 + e.cw1h;
  acc.cacheRead += e.cr;
  acc.calls += 1;
  return acc;
}

/**
 * Split entries into 5-hour blocks the way the upstream session window works:
 * a block opens on your first message (floored to the hour) and runs for five
 * hours; the next message after it closes opens a fresh block.
 */
function sessionBlocks(entries, hours = SESSION_HOURS) {
  const span = hours * HOUR;
  const blocks = [];
  let cur = null;
  for (const e of entries) {
    if (!cur || e.t >= cur.end) {
      const start = Math.floor(e.t / HOUR) * HOUR;
      cur = { start, end: start + span, entries: [] };
      blocks.push(cur);
    }
    cur.entries.push(e);
  }
  return blocks;
}

/** Start of the current weekly window. */
function weekStart(settings, now) {
  if (settings.weekMode === 'fixed') {
    const d = new Date(now);
    const target = settings.weekResetDay ?? 1; // 0=Sun
    const hour = settings.weekResetHour ?? 0;
    const reset = new Date(d);
    reset.setHours(hour, 0, 0, 0);
    let back = (d.getDay() - target + 7) % 7;
    if (back === 0 && d < reset) back = 7;
    reset.setDate(reset.getDate() - back);
    return reset.getTime();
  }
  return now - 7 * DAY; // rolling
}

function topN(map, n, key = 'cost') {
  return [...map.entries()]
    .map(([name, v]) => ({ name, ...v }))
    .sort((a, b) => b[key] - a[key])
    .slice(0, n);
}

/** Everything the UI needs, computed in one pass. */
function summarize(entries, settings, now = Date.now()) {
  const ov = settings.priceOverrides;
  const b = budgets(settings);

  const blocks = sessionBlocks(entries, settings.sessionHours || SESSION_HOURS);
  const active = blocks.length && now < blocks[blocks.length - 1].end
    ? blocks[blocks.length - 1]
    : null;

  const session = blank();
  if (active) for (const e of active.entries) add(session, e, ov);

  const wStart = weekStart(settings, now);
  const dStart = new Date(now); dStart.setHours(0, 0, 0, 0);
  const dayStart = dStart.getTime();

  const week = blank();
  const today = blank();
  const byModel = new Map();
  const byProject = new Map();
  const days = new Map(); // yyyy-mm-dd -> acc

  for (const e of entries) {
    if (e.t >= wStart) {
      add(week, e, ov);
      const fam = familyOf(e.model);
      if (!byModel.has(fam)) byModel.set(fam, blank());
      add(byModel.get(fam), e, ov);
      if (!byProject.has(e.project)) byProject.set(e.project, blank());
      add(byProject.get(e.project), e, ov);
    }
    if (e.t >= dayStart) add(today, e, ov);

    if (e.t >= now - 14 * DAY) {
      const d = new Date(e.t);
      const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
      if (!days.has(key)) days.set(key, blank());
      add(days.get(key), e, ov);
    }
  }

  const sparkline = [];
  for (let i = 13; i >= 0; i--) {
    const d = new Date(now - i * DAY);
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    sparkline.push({ day: key, cost: (days.get(key) || blank()).cost });
  }

  const pct = (used, budget) => Math.min(999, Math.round((used / budget) * 1000) / 10);

  return {
    now,
    plan: b.label,
    session: {
      ...session,
      pct: active ? pct(session.cost, b.session) : 0,
      budget: b.session,
      start: active ? active.start : null,
      end: active ? active.end : null,
      resetsIn: active ? active.end - now : null,
      active: !!active,
    },
    week: {
      ...week,
      pct: pct(week.cost, b.week),
      budget: b.week,
      start: wStart,
      end: settings.weekMode === 'fixed' ? wStart + 7 * DAY : now + 0,
      resetsIn: settings.weekMode === 'fixed' ? wStart + 7 * DAY - now : null,
      mode: settings.weekMode || 'rolling',
    },
    today,
    byModel: topN(byModel, 6),
    byProject: topN(byProject, 6),
    sparkline,
    entryCount: entries.length,
  };
}

module.exports = { summarize, sessionBlocks, weekStart, blank };
