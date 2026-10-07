const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('flcStats', {
  getContext: () => ipcRenderer.invoke('stats:get-context'),
  getSnapshot: (serverId) => ipcRenderer.invoke('stats:get-snapshot', serverId),
  setSampling: (serverId, enabled, intervalMs) => (
    intervalMs == null
      ? ipcRenderer.invoke('stats:set-sampling', serverId, enabled)
      : ipcRenderer.invoke('stats:set-sampling', serverId, enabled, intervalMs)
  ),
  copyReport: (serverId, opts) => ipcRenderer.invoke('stats:copy-report', serverId, opts),
  saveDiagnostics: (serverId) => ipcRenderer.invoke('stats:save-diagnostics', serverId),
  badUrls: (serverId) => ipcRenderer.invoke('stats:bad-urls', serverId),
  copyBadUrls: (serverId) => ipcRenderer.invoke('stats:copy-bad-urls', serverId),
  getAdminEmail: (serverId) => ipcRenderer.invoke('stats:get-admin-email', serverId),
  setAdminEmail: (serverId, email) => ipcRenderer.invoke('stats:set-admin-email', serverId, email),
  emailAdmin: (serverId) => ipcRenderer.invoke('stats:email-admin', serverId),
  clearCache: (serverId) => ipcRenderer.invoke('game:clear-cache', serverId),
  fullRefresh: (serverId) => ipcRenderer.invoke('stats:full-refresh', serverId),
  listIssueAcks: (serverId) => ipcRenderer.invoke('stats:list-issue-acks', serverId),
  ackIssue: (serverId, findingId) => ipcRenderer.invoke('stats:ack-issue', serverId, findingId),
  releaseIssue: (serverId, findingId) => ipcRenderer.invoke('stats:release-issue', serverId, findingId),
  onUpdate: (callback) => {
    const wrapped = (_event, payload) => callback(payload);
    ipcRenderer.on('stats:update', wrapped);
    return () => ipcRenderer.removeListener('stats:update', wrapped);
  },
  netTrace: {
    run: (serverId) => ipcRenderer.invoke('nettrace:run', serverId),
    cancel: (serverId) => ipcRenderer.invoke('nettrace:cancel', serverId),
    get: (serverId, opts) => ipcRenderer.invoke('nettrace:get', serverId, opts),
    copy: (serverId, opts) => ipcRenderer.invoke('nettrace:copy', serverId, opts),
    onProgress: (callback) => {
      const wrapped = (_event, payload) => callback(payload);
      ipcRenderer.on('nettrace:progress', wrapped);
      return () => ipcRenderer.removeListener('nettrace:progress', wrapped);
    },
  },
});
