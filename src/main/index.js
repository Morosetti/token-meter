'use strict';
const { app, BrowserWindow, Tray, Menu, ipcMain, screen, shell, nativeImage } = require('electron');
const path = require('path');
const fs = require('fs');

const { Store } = require('./store');
const { Reader } = require('./reader');
const { summarize, applyOfficial } = require('./aggregate');
const { calibrationFor, calibrationFromOfficial } = require('./plans');
const { OfficialSource } = require('./official');
const { BadgeRenderer } = require('./badge');
const { transcriptRoots } = require('./paths');

const RENDERER = path.join(__dirname, '..', 'renderer');
const PRELOAD = path.join(__dirname, '..', 'preload', 'api.js');

let store, reader, badge, tray, officialSource;
let popupWin = null, overlayWin = null, settingsWin = null;
let latest = null;
let tickTimer = null;
let watchers = [];
let watchDebounce = null;

/* ------------------------------------------------------------------ data -- */

async function tick() {
  const s = store.get();
  let entries;
  try {
    entries = reader.scan(s.extraRoots);
  } catch (err) {
    console.error('[scan] failed:', err.message);
    return;
  }
  const base = summarize(entries, s, Date.now());

  // The official source is opt-in and never fatal: any failure leaves the
  // local estimate in place and is reported through the settings window.
  let official = null;
  if (s.officialSource) {
    official = await officialSource.get();
    if (official && official.ok && s.officialCalibrate) calibrateFrom(official, base);
  }

  latest = applyOfficial(base, official);
  latest.officialError = official && !official.ok ? official.error : null;
  latest.hasData = entries.length > 0;
  latest.roots = transcriptRoots(s.extraRoots);
  await paintTray();
  broadcast();
}

/**
 * Pin the local estimate to a percentage the server reported, so the numbers
 * stay right even if the endpoint later breaks or gets switched off.
 * Prefers the weekly window: it moves slowly, so its implied budget is stable.
 */
function calibrateFrom(official, base) {
  const s = store.get();
  for (const scope of ['week', 'session']) {
    const w = official[scope];
    if (!w) continue;
    const k = calibrationFromOfficial(s, scope, base[scope].cost, w.pct);
    if (k == null) continue;
    if (Math.abs(k - (s.calibration || 1)) > 0.01) store.set({ calibration: k });
    return;
  }
}

function broadcast() {
  for (const w of [popupWin, overlayWin, settingsWin]) {
    if (w && !w.isDestroyed()) w.webContents.send('usage:update', latest);
  }
}

/** Which number the tray badge is showing right now. */
function badgeValue() {
  if (!latest) return { pct: 0, label: '-' };
  const s = store.get();
  switch (s.badgeMetric) {
    case 'session': return { pct: latest.session.pct, label: 'Sessao 5h' };
    case 'week': return { pct: latest.week.pct, label: 'Semana' };
    case 'today': return { pct: Math.min(100, (latest.today.cost / (latest.week.budget / 7)) * 100), label: 'Hoje' };
    default:
      return latest.session.pct >= latest.week.pct
        ? { pct: latest.session.pct, label: 'Sessao 5h' }
        : { pct: latest.week.pct, label: 'Semana' };
  }
}

function colorFor(pct) {
  const s = store.get();
  if (pct >= s.dangerAt) return '#f87171';
  if (pct >= s.warnAt) return '#fbbf24';
  return '#4ade80';
}

async function paintTray() {
  if (!tray || tray.isDestroyed()) return;
  const s = store.get();
  const v = badgeValue();
  try {
    const img = await badge.render({
      pct: v.pct,
      style: s.badgeStyle,
      showNumber: s.badgeShowNumber,
      color: colorFor(v.pct),
    });
    tray.setImage(img);
  } catch (err) {
    console.error('[badge] render failed:', err.message);
  }
  tray.setToolTip(tooltip());
}

function tooltip() {
  if (!latest) return 'TokenMeter - lendo transcripts...';
  const usd = (n) => '$' + n.toFixed(2);
  const L = [
    'Sessao 5h:  ' + latest.session.pct + '%  (' + usd(latest.session.cost) + ')',
    'Semana:     ' + latest.week.pct + '%  (' + usd(latest.week.cost) + ')',
    'Hoje:       ' + usd(latest.today.cost),
  ];
  if (latest.session.active && latest.session.resetsIn != null) {
    L.push('Reseta em:  ' + fmtDur(latest.session.resetsIn));
  }
  return L.join('\n');
}

function fmtDur(ms) {
  if (ms == null || ms < 0) return '-';
  const h = Math.floor(ms / 36e5);
  const m = Math.floor((ms % 36e5) / 6e4);
  return h > 0 ? h + 'h ' + m + 'm' : m + 'm';
}

/* -------------------------------------------------------------- watching -- */

function startWatching() {
  stopWatching();
  for (const root of transcriptRoots(store.get().extraRoots)) {
    try {
      // Recursive watch is supported on Windows and macOS. On Linux it is not,
      // so there we lean on the polling timer instead of failing to start.
      const w = fs.watch(root, { recursive: process.platform !== 'linux' }, () => {
        clearTimeout(watchDebounce);
        watchDebounce = setTimeout(tick, 900);
      });
      w.on('error', () => {});
      watchers.push(w);
    } catch {
      // Watching is an optimisation; the polling timer is the guarantee.
    }
  }
}

function stopWatching() {
  for (const w of watchers) { try { w.close(); } catch {} }
  watchers = [];
}

function restartTimer() {
  clearInterval(tickTimer);
  const secs = Math.max(5, store.get().refreshSeconds || 20);
  tickTimer = setInterval(tick, secs * 1000);
}

/* --------------------------------------------------------------- windows -- */

function baseWebPrefs() {
  return { preload: PRELOAD, contextIsolation: true, nodeIntegration: false, sandbox: false };
}

function createPopup() {
  popupWin = new BrowserWindow({
    width: 380, height: 580,
    show: false, frame: false, resizable: false, movable: false,
    skipTaskbar: true, fullscreenable: false, alwaysOnTop: true,
    transparent: process.platform !== 'linux',
    backgroundColor: process.platform === 'linux' ? '#12100e' : '#00000000',
    webPreferences: baseWebPrefs(),
  });
  popupWin.loadFile(path.join(RENDERER, 'popup.html'));
  popupWin.on('blur', () => {
    if (popupWin && !popupWin.webContents.isDevToolsOpened()) popupWin.hide();
  });
  popupWin.on('closed', () => { popupWin = null; });
}

/** Park the popup against the tray icon, clamped to the display work area. */
function positionPopup() {
  const b = popupWin.getBounds();
  let anchor = null;
  try { anchor = tray.getBounds(); } catch { anchor = null; }
  const pt = anchor && anchor.width
    ? { x: Math.round(anchor.x + anchor.width / 2), y: anchor.y }
    : screen.getCursorScreenPoint();
  const area = screen.getDisplayNearestPoint(pt).workArea;

  let x = Math.round(pt.x - b.width / 2);
  // Tray sitting in the lower half of the screen means the panel opens upward.
  let y = pt.y > area.y + area.height / 2
    ? Math.round((anchor ? anchor.y : pt.y) - b.height - 8)
    : Math.round((anchor ? anchor.y + anchor.height : pt.y) + 8);

  x = Math.max(area.x + 8, Math.min(x, area.x + area.width - b.width - 8));
  y = Math.max(area.y + 8, Math.min(y, area.y + area.height - b.height - 8));
  popupWin.setPosition(x, y, false);
}

function togglePopup() {
  if (!popupWin || popupWin.isDestroyed()) createPopup();
  if (popupWin.isVisible()) { popupWin.hide(); return; }
  positionPopup();
  popupWin.show();
  popupWin.focus();
  broadcast();
}

function overlaySize() {
  return store.get().overlayCompact
    ? { width: 172, height: 48 }
    : { width: 236, height: 108 };
}

function createOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) { overlayWin.show(); return; }
  const s = store.get();
  const size = overlaySize();

  overlayWin = new BrowserWindow({
    width: size.width, height: size.height,
    show: false, frame: false, transparent: true, resizable: false,
    skipTaskbar: true, fullscreenable: false, minimizable: false, maximizable: false,
    hasShadow: false, focusable: !s.overlayClickThrough,
    webPreferences: baseWebPrefs(),
  });

  const saved = s.overlayBounds;
  if (saved && isOnScreen(saved)) {
    overlayWin.setPosition(saved.x, saved.y, false);
  } else {
    const area = screen.getPrimaryDisplay().workArea;
    overlayWin.setPosition(area.x + area.width - size.width - 24, area.y + 24, false);
  }

  applyOverlayFlags();
  overlayWin.loadFile(path.join(RENDERER, 'overlay.html'));
  overlayWin.once('ready-to-show', () => { overlayWin.show(); broadcast(); });
  overlayWin.on('moved', () => {
    if (!overlayWin || overlayWin.isDestroyed()) return;
    const pos = overlayWin.getPosition();
    store.set({ overlayBounds: { x: pos[0], y: pos[1] } });
  });
  overlayWin.on('closed', () => { overlayWin = null; });
}

/** Keep a saved position usable after monitors are unplugged or rearranged. */
function isOnScreen(p) {
  return screen.getAllDisplays().some((d) => {
    const a = d.workArea;
    return p.x >= a.x - 40 && p.x <= a.x + a.width - 40
        && p.y >= a.y - 40 && p.y <= a.y + a.height - 40;
  });
}

function applyOverlayFlags() {
  if (!overlayWin || overlayWin.isDestroyed()) return;
  const s = store.get();
  overlayWin.setAlwaysOnTop(!!s.overlayAlwaysOnTop, 'screen-saver');
  overlayWin.setVisibleOnAllWorkspaces(true, { visibleOnFullScreen: true });
  overlayWin.setOpacity(Math.max(0.15, Math.min(1, s.overlayOpacity)));
  overlayWin.setIgnoreMouseEvents(!!s.overlayClickThrough, { forward: true });
}

function destroyOverlay() {
  if (overlayWin && !overlayWin.isDestroyed()) overlayWin.destroy();
  overlayWin = null;
}

function openSettings() {
  if (settingsWin && !settingsWin.isDestroyed()) { settingsWin.show(); settingsWin.focus(); return; }
  settingsWin = new BrowserWindow({
    width: 540, height: 700, show: false, frame: false, resizable: true,
    minWidth: 460, minHeight: 520,
    backgroundColor: '#12100e',
    webPreferences: baseWebPrefs(),
  });
  settingsWin.loadFile(path.join(RENDERER, 'settings.html'));
  settingsWin.once('ready-to-show', () => { settingsWin.show(); broadcast(); });
  settingsWin.on('closed', () => { settingsWin = null; });
}

/* ----------------------------------------------------------------- tray -- */

function buildMenu() {
  const s = store.get();
  const head = latest
    ? 'Sessao ' + latest.session.pct + '%  |  Semana ' + latest.week.pct + '%'
    : 'Carregando...';

  return Menu.buildFromTemplate([
    { label: head, enabled: false },
    { type: 'separator' },
    { label: 'Abrir painel', click: togglePopup },
    {
      label: 'Overlay flutuante',
      type: 'checkbox',
      checked: s.overlayEnabled,
      click: (item) => {
        store.set({ overlayEnabled: item.checked });
        if (item.checked) createOverlay(); else destroyOverlay();
        refreshMenu();
      },
    },
    {
      label: 'Badge mostra',
      submenu: ['max', 'session', 'week', 'today'].map((m) => ({
        label: { max: 'Maior dos dois', session: 'Sessao 5h', week: 'Semana', today: 'Hoje' }[m],
        type: 'radio',
        checked: s.badgeMetric === m,
        click: () => { store.set({ badgeMetric: m }); paintTray(); },
      })),
    },
    { type: 'separator' },
    { label: 'Atualizar agora', click: tick },
    { label: 'Configuracoes...', click: openSettings },
    { type: 'separator' },
    { label: 'Sair', click: () => app.quit() },
  ]);
}

function refreshMenu() {
  if (tray && !tray.isDestroyed()) tray.setContextMenu(buildMenu());
}

function createTray() {
  // Start from an empty image; the first paintTray() replaces it within a few
  // hundred ms, which avoids shipping a placeholder asset just for startup.
  tray = new Tray(nativeImage.createEmpty());
  tray.setToolTip('TokenMeter');
  tray.setContextMenu(buildMenu());
  tray.on('click', togglePopup);
  tray.on('double-click', togglePopup);
}

/* ------------------------------------------------------------------ ipc -- */

function registerIpc() {
  ipcMain.handle('usage:get', () => latest);
  ipcMain.handle('usage:refresh', async () => {
    if (store.get().officialSource) await officialSource.get({ force: true });
    await tick();
    return latest;
  });

  // Lets Settings test the connection without waiting for the poll interval.
  ipcMain.handle('official:test', async () => {
    officialSource.reset();
    const r = await officialSource.get({ force: true });
    await tick();
    return r && r.ok
      ? { ok: true, session: r.session, week: r.week }
      : { ok: false, error: (r && r.error) || 'Falhou.' };
  });

  ipcMain.handle('settings:get', () => store.get());

  ipcMain.handle('settings:set', async (_e, raw) => {
    const patch = raw || {};
    const before = store.get();
    const s = store.set(patch);

    if ('overlayEnabled' in patch) {
      if (patch.overlayEnabled) createOverlay(); else destroyOverlay();
    }
    if (overlayWin && ('overlayOpacity' in patch || 'overlayClickThrough' in patch || 'overlayAlwaysOnTop' in patch)) {
      applyOverlayFlags();
    }
    // Window size is fixed at creation, so a layout switch means a rebuild.
    if ('overlayCompact' in patch && patch.overlayCompact !== before.overlayCompact && s.overlayEnabled) {
      destroyOverlay();
      createOverlay();
    }
    if ('refreshSeconds' in patch) restartTimer();
    // Turning the official source on or off should take effect immediately,
    // not after the backoff from a previous failure has elapsed.
    if ('officialSource' in patch) officialSource.reset();
    if ('extraRoots' in patch) {
      reader.files.clear();
      reader.seen.clear();
      startWatching();
    }
    if ('launchAtLogin' in patch) {
      try {
        app.setLoginItemSettings({ openAtLogin: !!patch.launchAtLogin, openAsHidden: true });
      } catch (err) {
        console.error('[login-item] failed:', err.message);
      }
    }
    refreshMenu();
    await tick();
    return s;
  });

  ipcMain.handle('settings:reset', async () => {
    const s = store.reset();
    await tick();
    refreshMenu();
    return s;
  });

  ipcMain.handle('settings:calibrate', async (_e, arg) => {
    if (!latest) return store.get();
    const scope = arg && arg.scope === 'session' ? 'session' : 'week';
    const used = scope === 'session' ? latest.session.cost : latest.week.cost;
    const k = calibrationFor(store.get(), scope, used, Number(arg && arg.observedPct));
    const s = store.set({ calibration: k });
    await tick();
    return s;
  });

  ipcMain.on('window:settings', openSettings);

  ipcMain.on('window:close-self', (e) => {
    const w = BrowserWindow.fromWebContents(e.sender);
    if (!w) return;
    if (w === popupWin) w.hide(); else w.close();
  });

  ipcMain.on('app:quit', () => app.quit());

  ipcMain.on('app:open-external', (_e, url) => {
    if (typeof url === 'string' && /^https?:\/\//.test(url)) shell.openExternal(url);
  });
}

/* ------------------------------------------------------------ lifecycle -- */

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', togglePopup);

  app.whenReady().then(async () => {
    if (process.platform === 'darwin' && app.dock) app.dock.hide();

    store = new Store();
    reader = new Reader({ retentionDays: 45 });
    badge = new BadgeRenderer();
    officialSource = new OfficialSource();

    registerIpc();
    createTray();
    createPopup();
    if (store.get().overlayEnabled) createOverlay();

    await tick();
    refreshMenu();
    startWatching();
    restartTimer();
  });

  // A tray app spends most of its life with no windows open; that must not
  // be treated as a reason to exit.
  app.on('window-all-closed', (e) => {
    if (e && typeof e.preventDefault === 'function') e.preventDefault();
  });

  app.on('before-quit', () => {
    clearInterval(tickTimer);
    stopWatching();
    if (badge) badge.destroy();
    if (tray && !tray.isDestroyed()) tray.destroy();
  });
}
