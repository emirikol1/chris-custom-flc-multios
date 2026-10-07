'use strict';

const path = require('path');
const { BrowserWindow } = require('electron');
const { forgetNetTrace } = require('./net-trace-ipc');

/** @type {WeakMap<import('electron').BrowserWindow, import('electron').BrowserWindow>} */
const statsByGame = new WeakMap();
/** @type {WeakMap<import('electron').WebContents, { serverId: string, label: string, incognito: boolean }>} */
const contextByContents = new WeakMap();

const DEFAULTS = { width: 520, height: 760 };

/**
 * @param {import('electron').BrowserWindow | null | undefined} gameWin
 * @returns {import('electron').BrowserWindow | null}
 */
function getStatsWindowFor(gameWin) {
  if (!gameWin) return null;
  const win = statsByGame.get(gameWin);
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null;
  return win;
}

/**
 * @param {import('electron').WebContents | null | undefined} webContents
 * @returns {{ serverId: string, label: string, incognito: boolean }}
 */
function getStatsContext(webContents) {
  const ctx = webContents ? contextByContents.get(webContents) : null;
  if (!ctx) return { serverId: '', label: '', incognito: false };
  return {
    serverId: typeof ctx.serverId === 'string' ? ctx.serverId : '',
    label: typeof ctx.label === 'string' ? ctx.label : '',
    incognito: ctx.incognito === true,
  };
}

/**
 * @param {(enabled: boolean, intervalMs?: number) => void} [fn]
 * @param {boolean} enabled
 * @param {number} [intervalMs]
 */
function callSampling(fn, enabled, intervalMs) {
  if (typeof fn !== 'function') return;
  try {
    fn(enabled, intervalMs);
  } catch {
    /* sampling hook failed */
  }
}

/**
 * One statistics window per game window. A free-standing window (no parent,
 * not modal, not always-on-top) whose placement is remembered per session.
 * @param {import('electron').BrowserWindow} gameWin
 * @param {{
 *   serverId?: string,
 *   label?: string,
 *   incognito?: boolean,
 *   windowState?: { restore: Function, track: Function, has?: Function } | null,
 *   layoutKey?: string,
 *   onSampling?: (enabled: boolean, intervalMs?: number) => void,
 *   onReady?: () => void,
 * }} opts
 * @returns {import('electron').BrowserWindow | null}
 */
function openWorldStatsWindow(gameWin, opts) {
  if (!gameWin || (typeof gameWin.isDestroyed === 'function' && gameWin.isDestroyed())) return null;
  const existing = getStatsWindowFor(gameWin);
  if (existing) {
    try {
      if (typeof existing.focus === 'function') existing.focus();
    } catch {
      /* ignore */
    }
    return existing;
  }

  const options = opts && typeof opts === 'object' ? opts : {};
  const layoutKey = typeof options.layoutKey === 'string' && options.layoutKey ? options.layoutKey : 'game';
  const stateKey = `${layoutKey}:stats`;
  const windowState = options.windowState || null;
  let bounds = DEFAULTS;
  if (windowState && typeof windowState.restore === 'function') {
    try {
      bounds = windowState.restore(stateKey, DEFAULTS) || DEFAULTS;
    } catch {
      bounds = DEFAULTS;
    }
  }

  /** @type {Electron.BrowserWindowConstructorOptions} */
  const browserOpts = {
    width: bounds.width || DEFAULTS.width,
    height: bounds.height || DEFAULTS.height,
    minWidth: 420,
    minHeight: 520,
    // Independent OS window: no parent, so it can live on another monitor and
    // does not minimize or stack with the game window. Closing the game window
    // closes it explicitly (game-window.js 'closed' handler).
    modal: false,
    alwaysOnTop: false,
    show: true,
    autoHideMenuBar: true,
    title: 'World Statistics',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload-world-stats.js'),
    },
  };
  if (Number.isFinite(bounds.x)) browserOpts.x = bounds.x;
  if (Number.isFinite(bounds.y)) browserOpts.y = bounds.y;

  const win = new BrowserWindow(browserOpts);
  if (bounds.maximized && typeof win.maximize === 'function') win.maximize();
  if (windowState && typeof windowState.track === 'function') {
    try {
      windowState.track(win, stateKey);
    } catch {
      /* placement memory is optional */
    }
  }

  const tracedServerId = typeof options.serverId === 'string' ? options.serverId : '';
  contextByContents.set(win.webContents, {
    serverId: tracedServerId,
    label: typeof options.label === 'string' ? options.label : '',
    incognito: options.incognito === true,
  });
  statsByGame.set(gameWin, win);

  win.on('closed', () => {
    if (tracedServerId) forgetNetTrace(tracedServerId);
    if (statsByGame.get(gameWin) === win) statsByGame.delete(gameWin);
    callSampling(options.onSampling, false);
  });
  win.webContents.on('did-finish-load', () => {
    if (typeof options.onReady === 'function') {
      try {
        options.onReady();
      } catch {
        /* ignore */
      }
    }
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'world-stats.html'));
  callSampling(options.onSampling, true, 5000);
  return win;
}

/**
 * @param {import('electron').BrowserWindow | null | undefined} gameWin
 * @returns {boolean}
 */
function closeStatsWindowFor(gameWin) {
  const win = getStatsWindowFor(gameWin);
  if (!win) return false;
  try {
    win.close();
  } catch {
    return false;
  }
  return true;
}

/**
 * @param {import('electron').BrowserWindow | null | undefined} gameWin
 * @param {object} payload
 */
function pushUpdate(gameWin, payload) {
  const win = getStatsWindowFor(gameWin);
  if (!win) return;
  try {
    win.webContents.send('stats:update', payload);
  } catch {
    /* window went away */
  }
}

module.exports = {
  openWorldStatsWindow,
  getStatsWindowFor,
  closeStatsWindowFor,
  pushUpdate,
  getStatsContext,
};
