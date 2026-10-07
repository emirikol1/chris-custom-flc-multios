'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flcLoadNotice', {
  getAdminMessage: () => ipcRenderer.invoke('slowcache:message'),
  copyAdminMessage: () => ipcRenderer.invoke('slowcache:copy'),
  dismiss: () => ipcRenderer.invoke('slowcache:dismiss'),
});
