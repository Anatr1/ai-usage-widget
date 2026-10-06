'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('widget', {
  getUsage: (force) => ipcRenderer.invoke('usage:get', !!force),
  getSettings: () => ipcRenderer.invoke('settings:get'),
  setSettings: (patch) => ipcRenderer.invoke('settings:set', patch),
  togglePin: () => ipcRenderer.invoke('widget:toggle-pin'),
  getPin: () => ipcRenderer.invoke('widget:get-pin'),
  hide: () => ipcRenderer.send('widget:hide'),
  resize: (size) => ipcRenderer.send('widget:resize', size),
  startResize: (edge) => ipcRenderer.send('widget:resize-start', edge),
  updateResize: () => ipcRenderer.send('widget:resize-update'),
  endResize: () => ipcRenderer.send('widget:resize-end'),
  onHoverChanged: (cb) => ipcRenderer.on('widget:hover', (_event, hovered) => cb(hovered)),
  onRefreshRequested: (cb) => ipcRenderer.on('usage:refresh', cb),
});
