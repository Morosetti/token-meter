'use strict';
const { contextBridge, ipcRenderer } = require('electron');

/**
 * The only bridge between the UI and the main process. The renderers run with
 * contextIsolation on and no Node access; everything they can do is listed here.
 */
contextBridge.exposeInMainWorld('usage', {
  get: () => ipcRenderer.invoke('usage:get'),
  refresh: () => ipcRenderer.invoke('usage:refresh'),

  settingsGet: () => ipcRenderer.invoke('settings:get'),
  settingsSet: (patch) => ipcRenderer.invoke('settings:set', patch),
  settingsReset: () => ipcRenderer.invoke('settings:reset'),
  calibrate: (scope, observedPct) => ipcRenderer.invoke('settings:calibrate', { scope, observedPct }),

  openSettings: () => ipcRenderer.send('window:settings'),
  closeSelf: () => ipcRenderer.send('window:close-self'),
  quit: () => ipcRenderer.send('app:quit'),
  openExternal: (url) => ipcRenderer.send('app:open-external', url),

  // Pushed from main whenever a rescan produces new numbers.
  onUpdate: (fn) => {
    const h = (_e, payload) => fn(payload);
    ipcRenderer.on('usage:update', h);
    return () => ipcRenderer.removeListener('usage:update', h);
  },
});
