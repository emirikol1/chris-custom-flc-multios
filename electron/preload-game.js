const { contextBridge, ipcRenderer } = require('electron');

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
});
