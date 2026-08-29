const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flc', {
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    add: (data) => ipcRenderer.invoke('servers:add', data),
    update: (id, patch) => ipcRenderer.invoke('servers:update', id, patch),
    delete: (id) => ipcRenderer.invoke('servers:delete', id),
  },
  game: {
    connect: (payload) => ipcRenderer.invoke('game:connect', payload),
    getWebglStatus: () => ipcRenderer.invoke('game:get-webgl-status'),
    setSoftwareWebgl: (preferSoftware) =>
      ipcRenderer.invoke('game:set-software-webgl', preferSoftware),
  },
  onWebglFallback: (callback) => {
    const wrapped = (_event, info) => callback(info);
    ipcRenderer.on('webgl:fallback', wrapped);
    return () => ipcRenderer.removeListener('webgl:fallback', wrapped);
  },
  log: (level, ...args) =>
    ipcRenderer.send('renderer-log:write', level, args.map(String).join(' ')),
});
