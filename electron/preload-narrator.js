const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flcNarrator', {
  ask: (text) => ipcRenderer.invoke('narrator:ask', text),
  getSettings: () => ipcRenderer.invoke('narrator:get-settings'),
  setPostToFoundry: (enabled) =>
    ipcRenderer.invoke('narrator:set-post-to-foundry', enabled),
  setSettings: (patch) => ipcRenderer.invoke('narrator:set-settings', patch),
  openSetup: () => ipcRenderer.send('narrator:open-setup'),
  onLine: (callback) => {
    const wrapped = (_event, line) => callback(line);
    ipcRenderer.on('narrator:line', wrapped);
    return () => ipcRenderer.removeListener('narrator:line', wrapped);
  },
  onStatus: (callback) => {
    const wrapped = (_event, status) => callback(status);
    ipcRenderer.on('narrator:status', wrapped);
    return () => ipcRenderer.removeListener('narrator:status', wrapped);
  },
});
