'use strict';
/**
 * Official usage source (opt-in, off by default).
 *
 * Reads the OAuth access token the CLI already stored on this machine and asks
 * the server for the real utilisation of the subscription windows. This is the
 * only way to get the exact number: it does not exist anywhere on disk.
 *
 * The contract below was recovered by reading the CLI binary's own request
 * code, not from documentation, because there is none:
 *
 *   GET https://api.anthropic.com/api/oauth/usage
 *   Authorization: Bearer <accessToken>
 *   anthropic-beta: oauth-2025-04-20
 *
 *   -> { five_hour: { utilization, resets_at }, seven_day: { ... }, ... }
 *      `utilization` is a fraction: the CLI renders it as utilization * 100.
 *
 * Because it is undocumented, it can change or disappear in any update. Every
 * parse here is deliberately tolerant and every failure is non-fatal: the app
 * falls back to the local estimate and says so.
 *
 * Two rules this module keeps:
 *   - The token is read, used for one request, and never logged, persisted,
 *     copied or sent anywhere except that one host.
 *   - It never writes to the credentials file. A stale token is reported so the
 *     user can refresh it by running the CLI; silently refreshing it here would
 *     mean mutating the file their login depends on.
 */
const fs = require('fs');
const path = require('path');
const { configDir } = require('./paths');

const ENDPOINT = 'https://api.anthropic.com/api/oauth/usage';
const BETA = 'oauth-2025-04-20';
const TIMEOUT_MS = 5000;

/** Server-side rate limiting is real; never poll faster than this. */
const MIN_INTERVAL_MS = 60_000;
/**
 * Floor for a user-initiated fetch. A manual click should feel immediate, but
 * "manual" is not a licence to bypass the limiter: holding down the refresh
 * button must not turn into a burst of requests.
 */
const FORCE_FLOOR_MS = 10_000;
/** After an auth failure, stop hammering: the credential will not fix itself. */
const AUTH_BACKOFF_MS = 15 * 60_000;
/** A usage payload is a few hundred bytes; anything near this is not one. */
const MAX_BODY_BYTES = 256 * 1024;
/** Fallback wait when the server rate-limits us without a Retry-After. */
const RATE_LIMIT_BACKOFF_MS = 60_000;

const SESSION_KEYS = ['five_hour'];
const WEEK_KEYS = ['seven_day', 'seven_day_overage_included', 'seven_day_opus', 'seven_day_sonnet'];

class AuthError extends Error {}

/**
 * Pull the access token out of the file the CLI maintains.
 * Returns only what is needed; the caller never stores it.
 */
function readToken() {
  const file = path.join(configDir(), '.credentials.json');

  let raw;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch {
    throw new AuthError(process.platform === 'darwin'
      ? 'No macOS o login fica no Keychain, nao neste arquivo. Fonte oficial indisponivel.'
      : 'Arquivo de credenciais nao encontrado. Faca login na CLI primeiro.');
  }

  let parsed;
  try { parsed = JSON.parse(raw); } catch { throw new AuthError('Credenciais ilegiveis.'); }

  const cred = parsed && parsed.claudeAiOauth;
  if (!cred || !cred.accessToken) throw new AuthError('Sem credencial de login. Faca login na CLI.');

  // Deliberately NOT a hard stop on expiry. The CLI refreshes on use and only
  // then rewrites this file, so the stored expiry is stale most of the time
  // while the credential itself still works. Treating it as fatal would mean
  // the feature almost never runs. It is kept only to explain a 401 afterwards.
  const expired = cred.expiresAt ? Date.now() > Number(cred.expiresAt) : false;
  return { token: cred.accessToken, expired };
}

function firstNumber(...vals) {
  for (const v of vals) {
    const n = typeof v === 'string' ? Number(v) : v;
    if (typeof n === 'number' && Number.isFinite(n)) return n;
  }
  return null;
}

function toMs(v) {
  if (v == null) return null;
  if (typeof v === 'number') return v < 1e12 ? v * 1000 : v;  // seconds vs millis
  const t = Date.parse(v);
  return Number.isFinite(t) ? t : null;
}

/** Read one window out of the body, accepting the spellings seen in the wild. */
function pickWindow(body, keys) {
  for (const key of keys) {
    const w = body && body[key];
    if (!w || typeof w !== 'object') continue;
    const u = firstNumber(w.utilization, w.utilization_pct, w.pct);
    if (u == null) continue;
    // The CLI multiplies utilization by 100, so it is a fraction. A value above
    // 1.5 can only be an already-scaled percentage, so take it as one.
    const pct = u > 1.5 ? u : u * 100;
    return { key, pct: Math.round(pct * 10) / 10, resetsAt: toMs(w.resets_at ?? w.resetsAt) };
  }
  return null;
}

/** The server explains auth failures well; pass its wording through. */
async function safeErrorMessage(res) {
  try {
    const body = await res.json();
    const m = body && body.error && body.error.message;
    return typeof m === 'string' ? m.slice(0, 120) : null;
  } catch {
    return null;
  }
}

class OfficialSource {
  constructor() {
    this.last = null;        // last successful result
    this.lastAt = 0;         // when that success happened
    this.lastAttemptAt = 0;  // when we last hit the network, success or not
    this.error = null;
    this.blockedUntil = 0;
    this.inFlight = null;
  }

  /** True when a fetch would actually go out right now. */
  _due(force) {
    if (Date.now() < this.blockedUntil) return false;
    // Throttle on the last *attempt*, not the last success. Keying off success
    // would leave a failing endpoint completely unthrottled, which is exactly
    // the case where backing off matters most.
    const since = Date.now() - this.lastAttemptAt;
    return since >= (force ? FORCE_FLOOR_MS : MIN_INTERVAL_MS);
  }

  /** Seconds left on a server-imposed wait, or 0. */
  waitingSeconds() {
    return Math.max(0, Math.ceil((this.blockedUntil - Date.now()) / 1000));
  }

  /**
   * Never throws. Returns the cached result when it is fresh enough, and the
   * previous result (marked stale) when a refresh fails.
   */
  async get({ force = false } = {}) {
    if (!this._due(force)) {
      const wait = this.waitingSeconds();
      return this.last
        ? { ...this.last, stale: Date.now() - this.lastAt > MIN_INTERVAL_MS, error: this.error }
        : { ok: false, error: this.error, waitingSeconds: wait };
    }
    // Collapse concurrent callers onto one request.
    if (this.inFlight) return this.inFlight;
    this.inFlight = this._fetch().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }

  async _fetch() {
    let cred;
    try {
      cred = readToken();
    } catch (err) {
      this.error = err.message;
      this.blockedUntil = Date.now() + AUTH_BACKOFF_MS;
      return { ok: false, error: this.error };
    }
    const token = cred.token;
    this.lastAttemptAt = Date.now();

    try {
      const res = await fetch(ENDPOINT, {
        method: 'GET',
        headers: {
          Authorization: 'Bearer ' + token,
          'anthropic-beta': BETA,
          'Content-Type': 'application/json',
        },
        // The real endpoint never redirects. Following one would mean sending
        // the credential somewhere it was not meant for, so treat it as an
        // error instead. (Node strips the Authorization header on a
        // cross-origin redirect, but a same-host one would keep it, and
        // neither case is a shape this app should accept.)
        redirect: 'error',
        signal: AbortSignal.timeout(TIMEOUT_MS),
      });

      if (res.status === 401 || res.status === 403) {
        // The CLI refreshes and re-saves on use, so running it once is the fix.
        // Doing the refresh here would risk rotating the credential their login
        // depends on, which is not this app's business.
        const detail = await safeErrorMessage(res);
        this.error = (cred.expired || /expired/i.test(detail || ''))
          ? 'Credencial expirada. Rode a CLI uma vez para renovar.'
          : 'Credencial recusada' + (detail ? ': ' + detail : ' (' + res.status + ')') + '.';
        this.blockedUntil = Date.now() + AUTH_BACKOFF_MS;
        return { ok: false, error: this.error };
      }
      if (res.status === 429) {
        // The server is asking us to slow down. It usually says for how long,
        // and ignoring that is what turns one 429 into a stream of them.
        const retryAfter = Number(res.headers.get('retry-after'));
        const waitMs = Number.isFinite(retryAfter) && retryAfter > 0
          ? Math.min(retryAfter * 1000, 30 * 60_000)
          : RATE_LIMIT_BACKOFF_MS;
        this.blockedUntil = Date.now() + waitMs;
        this.error = 'Muitas consultas ao servidor. Nova tentativa em '
          + Math.ceil(waitMs / 1000) + 's.';
        return this.last
          ? { ...this.last, stale: true, error: this.error }
          : { ok: false, error: this.error, waitingSeconds: Math.ceil(waitMs / 1000) };
      }

      if (!res.ok) {
        this.error = 'Servidor respondeu ' + res.status + '.';
        return this.last ? { ...this.last, stale: true, error: this.error } : { ok: false, error: this.error };
      }

      // A usage payload is a few hundred bytes. Parsing an unbounded body from
      // the network into memory is never something this app needs to do.
      const declared = Number(res.headers.get('content-length'));
      if (Number.isFinite(declared) && declared > MAX_BODY_BYTES) {
        this.error = 'Resposta grande demais (' + declared + ' bytes).';
        return { ok: false, error: this.error };
      }
      const text = await res.text();
      if (text.length > MAX_BODY_BYTES) {
        this.error = 'Resposta grande demais.';
        return { ok: false, error: this.error };
      }

      let body;
      try {
        body = JSON.parse(text);
      } catch {
        this.error = 'Resposta nao e JSON valido.';
        return { ok: false, error: this.error };
      }

      const session = pickWindow(body, SESSION_KEYS);
      const week = pickWindow(body, WEEK_KEYS);

      if (!session && !week) {
        // Reachable and authorised, but the shape moved. Say so plainly rather
        // than reporting a confident zero.
        this.error = 'Resposta em formato desconhecido (a API mudou).';
        return { ok: false, error: this.error, keys: Object.keys(body || {}) };
      }

      this.error = null;
      this.blockedUntil = 0;
      this.lastAt = Date.now();
      this.last = { ok: true, session, week, at: this.lastAt, stale: false };
      return this.last;
    } catch (err) {
      this.error = err.name === 'TimeoutError' ? 'Tempo esgotado (5s).' : 'Falha de rede.';
      return this.last ? { ...this.last, stale: true, error: this.error } : { ok: false, error: this.error };
    }
  }

  /**
   * Clear cached state so the next call goes out fresh.
   * `lastAttemptAt` deliberately survives: the floor between network calls is
   * about being a good citizen to the server, and a reset must not be a way to
   * sidestep it.
   */
  reset() {
    this.last = null;
    this.lastAt = 0;
    this.error = null;
    this.blockedUntil = 0;
  }
}

module.exports = { OfficialSource, readToken, pickWindow };
