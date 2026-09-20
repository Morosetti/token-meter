/* Shared formatting + meter painting. Loaded as a classic script by every page. */

function usd(n) {
  if (!Number.isFinite(n)) return '$0.00';
  if (n >= 1000) return '$' + n.toFixed(0);
  return '$' + n.toFixed(2);
}

function tokens(n) {
  if (!Number.isFinite(n) || n === 0) return '0';
  if (n >= 1e9) return (n / 1e9).toFixed(2) + 'B';
  if (n >= 1e6) return (n / 1e6).toFixed(1) + 'M';
  if (n >= 1e3) return (n / 1e3).toFixed(1) + 'k';
  return String(n);
}

function dur(ms) {
  if (ms == null || ms < 0) return '--';
  const h = Math.floor(ms / 36e5);
  const m = Math.floor((ms % 36e5) / 6e4);
  if (h >= 24) return Math.floor(h / 24) + 'd ' + (h % 24) + 'h';
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

function clockAt(ts) {
  if (!ts) return '--';
  const d = new Date(ts);
  return String(d.getHours()).padStart(2, '0') + ':' + String(d.getMinutes()).padStart(2, '0');
}

/** Threshold colour, matching what the tray badge uses. */
function tone(pct, settings) {
  const warn = (settings && settings.warnAt) || 80;
  const danger = (settings && settings.dangerAt) || 95;
  if (pct >= danger) return { cls: 'is-danger', color: 'var(--danger)' };
  if (pct >= warn) return { cls: 'is-warn', color: 'var(--warn)' };
  return { cls: 'is-ok', color: 'var(--ok)' };
}

/**
 * Paint one meter. `root` must contain .meter-pct, .track and .fill.
 * Values above 100 clamp the bar and switch it to the striped over-budget look.
 */
function paintMeter(root, pct, settings) {
  const t = tone(pct, settings);
  const pctEl = root.querySelector('.meter-pct');
  const track = root.querySelector('.track');
  const fill = root.querySelector('.fill');
  if (pctEl) {
    pctEl.textContent = (pct > 999 ? '999+' : Math.round(pct)) + '%';
    pctEl.className = 'meter-pct ' + t.cls;
  }
  if (track) track.classList.toggle('over', pct > 100);
  if (fill) {
    fill.style.width = Math.max(0, Math.min(100, pct)) + '%';
    fill.style.backgroundColor = t.color;
  }
}

function applyTheme(settings) {
  document.documentElement.dataset.theme = (settings && settings.theme) === 'light' ? 'light' : 'dark';
}
