'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flcGlowStrength', {
  submit: (value) => ipcRenderer.send('glow-strength:submit', value),
  cancel: () => ipcRenderer.send('glow-strength:cancel'),
});
