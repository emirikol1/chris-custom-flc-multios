'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');
const { logInfo } = require('./logger');

/** Window-state key: app window, not per session. */
const STATE_KEY = 'server-config';

/** @type {import('electron').BrowserWindow | null} */
let configWindow = null;
/** @type {{ mode: 'add' | 'edit' | 'clone', server: object | null }} */
let context = { mode: 'add', server: null };

function getServerConfigWindow() {
  return configWindow && !configWindow.isDestroyed() ? configWindow : null;
}

/**
 * Open (or refocus) the server configuration window.
 * @param {{ mode: 'add' | 'edit' | 'clone', server?: object | null }} ctx
 * @param {{ windowState?: ReturnType<import('./window-state').createWindowStateStore>, parent?: import('electron').BrowserWindow | null }} [opts]
 */
function openServerConfigWindow(ctx, opts = {}) {
  context = { mode: ctx.mode, server: ctx.server || null };
  const existing = getServerConfigWindow();
  if (existing) {
    existing.webContents.send('server-config:context', context);
    existing.show();
    existing.focus();
    return existing;
  }

  const defaults = { width: 560, height: 680 };
  const ws = opts.windowState;
  const bounds = ws ? ws.restore(STATE_KEY, defaults) : defaults;
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 420,
    minHeight: 480,
    parent: opts.parent && !opts.parent.isDestroyed() ? opts.parent : undefined,
    autoHideMenuBar: true,
    title: 'Server configuration',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  configWindow = win;
  if (bounds.maximized) win.maximize();
  if (ws) ws.track(win, STATE_KEY);
  logInfo('[server-config] window opened', { mode: context.mode });

  win.on('closed', () => {
    logInfo('[server-config] window closed');
    if (configWindow === win) configWindow = null;
  });
  win.loadFile(path.join(__dirname, '..', 'src', 'server-config.html'));
  return win;
}

function getServerConfigContext() {
  return context;
}

function closeServerConfigWindow() {
  const win = getServerConfigWindow();
  if (win) win.close();
}

module.exports = {
  openServerConfigWindow,
  getServerConfigContext,
  closeServerConfigWindow,
  getServerConfigWindow,
};
