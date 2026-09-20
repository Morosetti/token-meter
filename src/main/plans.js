'use strict';
/**
 * Plan calibration.
 *
 * Subscription limits are not published in token terms, and the real
 * percentages live server-side. So we estimate: we price every transcript
 * record at API rates and compare that "API-equivalent value consumed" against
 * a per-plan budget.
 *
 * The numbers below are ESTIMATES and are meant to be corrected. Settings has a
 * one-click calibration: type the percentage the official app is showing you
 * and the budget is rescaled so this one agrees with it from then on.
 */
const PLANS = {
  pro:    { label: 'Pro',    session: 6,   week: 70 },
  max5:   { label: 'Max 5x', session: 30,  week: 350 },
  max20:  { label: 'Max 20x',session: 120, week: 1400 },
  custom: { label: 'Custom', session: 30,  week: 350 },
};

const SESSION_HOURS = 5;

/** Effective budgets after the user's calibration factor is applied. */
function budgets(settings) {
  const base = PLANS[settings.plan] || PLANS.max5;
  const s = settings.plan === 'custom'
    ? { session: settings.customSession, week: settings.customWeek }
    : base;
  const k = settings.calibration || 1;
  return {
    label: base.label,
    session: Math.max(0.01, s.session / k),
    week: Math.max(0.01, s.week / k),
  };
}

/**
 * Solve for the calibration factor that makes our percentage match the one the
 * user is actually seeing. observedPct is 0-100.
 */
function calibrationFor(settings, scope, usedUsd, observedPct) {
  if (!(observedPct > 0) || !(usedUsd > 0)) return settings.calibration || 1;
  const base = PLANS[settings.plan] || PLANS.max5;
  const raw = settings.plan === 'custom'
    ? (scope === 'session' ? settings.customSession : settings.customWeek)
    : (scope === 'session' ? base.session : base.week);
  // want: usedUsd / (raw / k) = observedPct/100
  const k = (observedPct / 100) * raw / usedUsd;
  return Math.min(50, Math.max(0.02, k));
}

module.exports = { PLANS, SESSION_HOURS, budgets, calibrationFor };
