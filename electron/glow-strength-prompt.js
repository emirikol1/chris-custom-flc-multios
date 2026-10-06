'use strict';

const path = require('path');
const { BrowserWindow, ipcMain } = require('electron');

/**
 * Ask for a glow strength from 0 to 300. Resolves to the number, or null if cancelled.
 * @param {import('electron').BrowserWindow | null | undefined} parent
 * @param {number} current
 * @returns {Promise<number | null>}
 */
function askGlowStrength(parent, current) {
  const start = Number.isFinite(current) ? Math.round(current) : 100;
  return new Promise((resolve) => {
    let settled = false;
    const parentWin = parent && typeof parent.isDestroyed === 'function' && !parent.isDestroyed() ? parent : null;
    const win = new BrowserWindow({
      width: 420,
      height: 190,
      parent: parentWin || undefined,
      modal: Boolean(parentWin),
      resizable: false,
      minimizable: false,
      maximizable: false,
      autoHideMenuBar: true,
      title: 'Glow Strength',
      webPreferences: {
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
        spellcheck: false,
        preload: path.join(__dirname, 'glow-strength-preload.js'),
      },
    });

    const finish = (value) => {
      if (settled) return;
      settled = true;
      ipcMain.removeListener('glow-strength:submit', onSubmit);
      ipcMain.removeListener('glow-strength:cancel', onCancel);
      resolve(value);
      if (!win.isDestroyed()) win.close();
    };

    const onSubmit = (event, raw) => {
      if (event.sender !== win.webContents) return;
      const n = Number(raw);
      if (!Number.isInteger(n) || n < 0 || n > 300) return;
      finish(n);
    };

    const onCancel = (event) => {
      if (event.sender !== win.webContents) return;
      finish(null);
    };

    ipcMain.on('glow-strength:submit', onSubmit);
    ipcMain.on('glow-strength:cancel', onCancel);
    win.on('closed', () => finish(null));

    win.webContents.once('did-finish-load', () => {
      const script = `(() => { const el = document.getElementById('pct'); if (el) { el.value = ${JSON.stringify(String(start))}; el.focus(); el.select(); } })()`;
      win.webContents.executeJavaScript(script).catch(() => {});
    });

    win.loadFile(path.join(__dirname, '..', 'src', 'glow-strength.html'));
  });
}

module.exports = { askGlowStrength };
