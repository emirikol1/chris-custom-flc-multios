const { contextBridge, ipcRenderer, webFrame } = require('electron');

// Install the join probe in the page's main world before any page script runs
// so socket creation and the world payload are observed from the start.
// The preload is sandboxed (no relative require), so main hands over the
// script text. game-window.js re-injects on dom-ready as a fallback (no-op).
try {
  const script = ipcRenderer.sendSync('foundry:telemetry-script');
  if (typeof script === 'string' && script) {
    webFrame.executeJavaScript(script).catch(() => {});
  }
} catch {
  // Probe install is best-effort.
}

contextBridge.exposeInMainWorld('flcGame', {
  chatLine: (payload) => {
    ipcRenderer.send('foundry:chat-line', payload);
  },
  captureStatus: (payload) => {
    ipcRenderer.send('foundry:capture-status', payload);
  },
  tokenMove: (payload) => {
    ipcRenderer.send('foundry:token-move', payload);
  },
  autologinStatus: (status) => {
    ipcRenderer.send('foundry:autologin-status', status);
  },
  layoutSnapshot: (snapshot) => {
    ipcRenderer.send('foundry:layout-snapshot', snapshot);
  },
  promptAttention: () => {
    ipcRenderer.send('foundry:prompt-attention');
  },
  telemetry: (payload) => {
    ipcRenderer.send('foundry:telemetry', payload);
  },
  openStats: () => {
    ipcRenderer.send('foundry:open-stats');
  },
});
