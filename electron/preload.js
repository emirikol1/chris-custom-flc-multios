const { contextBridge, ipcRenderer } = require('electron');

/**
 * @param {string} channel
 * @returns {(callback: (info: unknown) => void) => () => void}
 */
function subscribe(channel) {
  return (callback) => {
    const wrapped = (_event, info) => callback(info);
    ipcRenderer.on(channel, wrapped);
    return () => ipcRenderer.removeListener(channel, wrapped);
  };
}

contextBridge.exposeInMainWorld('flc', {
  servers: {
    list: () => ipcRenderer.invoke('servers:list'),
    add: (data) => ipcRenderer.invoke('servers:add', data),
    update: (id, patch) => ipcRenderer.invoke('servers:update', id, patch),
    delete: (id) => ipcRenderer.invoke('servers:delete', id),
    getUsers: (url, serverId) => ipcRenderer.invoke('servers:get-users', url, serverId),
  },
  game: {
    connect: (payload) => ipcRenderer.invoke('game:connect', payload),
    getWebglStatus: () => ipcRenderer.invoke('game:get-webgl-status'),
    setSoftwareWebgl: (preferSoftware) =>
      ipcRenderer.invoke('game:set-software-webgl', preferSoftware),
  },
  prefs: {
    get: () => ipcRenderer.invoke('prefs:get'),
    set: (patch) => ipcRenderer.invoke('prefs:set', patch),
  },
  settings: {
    exportToFile: () => ipcRenderer.invoke('settings:export'),
    importFromFile: () => ipcRenderer.invoke('settings:import'),
  },
  ai: {
    getPresets: () => ipcRenderer.invoke('ai:get-presets'),
    getSettings: () => ipcRenderer.invoke('ai:get-settings'),
    saveSettings: (cfg) => ipcRenderer.invoke('ai:save-settings', cfg),
    testConnection: (cfg) => ipcRenderer.invoke('ai:test-connection', cfg),
    openSignup: (presetId) => ipcRenderer.invoke('ai:open-signup', presetId),
  },
  onWebglFallback: subscribe('webgl:fallback'),
  onAutologinStatus: subscribe('autologin:status'),
  onOpenMudSetup: subscribe('mud:open-setup'),
  log: (level, ...args) =>
    ipcRenderer.send('renderer-log:write', level, args.map(String).join(' ')),
});
