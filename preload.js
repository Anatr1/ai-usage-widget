'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  getUsage: (force) => ipcRenderer.invoke('usage:get', !!force),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  togglePin: () => ipcRenderer.invoke('widget:toggle-pin'),
  getPin: () => ipcRenderer.invoke('widget:get-pin'),
  hide: () => ipcRenderer.send('widget:hide'),
  resize: (height) => ipcRenderer.send('widget:resize', height),
  onRefreshRequested: (cb) => ipcRenderer.on('usage:refresh', cb),
});
