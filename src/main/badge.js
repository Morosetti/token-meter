'use strict';
const { BrowserWindow, nativeImage, screen } = require('electron');
const path = require('path');

/**
 * Draws the tray icon.
 *
 * Electron's main process has no canvas, so we keep one hidden, never-shown
 * window whose only job is to rasterise the badge. `executeJavaScript` returns
 * the function's value straight back to us, so no IPC plumbing is needed.
 */
class BadgeRenderer {
  constructor() {
    this.win = null;
    this.ready = null;
    this.lastKey = null;
    this.lastImage = null;
  }

  _ensure() {
    if (this.ready) return this.ready;
    this.win = new BrowserWindow({
      show: false,
      width: 128,
      height: 128,
      webPreferences: { offscreen: true, nodeIntegration: false, contextIsolation: true },
    });
    this.ready = new Promise((resolve) => {
      this.win.webContents.once('did-finish-load', resolve);
      this.win.loadFile(path.join(__dirname, '..', 'renderer', 'badge.html'));
    });
    return this.ready;
  }

  /** Pixel size the platform wants for a tray icon. */
  static size() {
    if (process.platform === 'darwin') return 44;   // 22pt @2x
    let scale = 1;
    try { scale = screen.getPrimaryDisplay().scaleFactor || 1; } catch {}
    return Math.max(16, Math.round(16 * Math.max(scale, 2)));
  }

  async render(opts) {
    // Re-rasterising an identical badge every tick is pure waste; the tray
    // updates on a timer and the number usually has not moved.
    const key = JSON.stringify(opts);
    if (key === this.lastKey && this.lastImage) return this.lastImage;

    await this._ensure();
    const arg = JSON.stringify({ ...opts, size: BadgeRenderer.size() });
    const url = await this.win.webContents.executeJavaScript(`drawBadge(${arg})`);
    const img = nativeImage.createFromDataURL(url);
    img.setTemplateImage(false);
    this.lastKey = key;
    this.lastImage = img;
    return img;
  }

  destroy() {
    if (this.win && !this.win.isDestroyed()) this.win.destroy();
    this.win = null;
    this.ready = null;
  }
}

module.exports = { BadgeRenderer };
