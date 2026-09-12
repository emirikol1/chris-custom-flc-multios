const path = require('path');
const { BrowserWindow } = require('electron');
const { logInfo } = require('./logger');

/** @type {import('electron').BrowserWindow | null} */
let narratorWindow = null;

function getNarratorWindow() {
  if (narratorWindow && !narratorWindow.isDestroyed()) {
    return narratorWindow;
  }
  return null;
}

/** @type {(() => void) | null} */
let untrackSession = null;

/**
 * Window-state key for the MUD window. It follows the game session: each
 * saved server gets its own MUD window placement, falling back to the last
 * generic one.
 * @param {string} [layoutKey] game session layout key ("game:<id>")
 */
function mudStateKey(layoutKey) {
  return layoutKey && layoutKey !== 'game' ? `${layoutKey}:mud` : 'mud';
}

/**
 * Re-home an open MUD window onto a new session's remembered placement.
 * @param {import('electron').BrowserWindow} win
 * @param {ReturnType<import('./window-state').createWindowStateStore>} windowState
 * @param {string} [layoutKey]
 */
function adoptSession(win, windowState, layoutKey) {
  const key = mudStateKey(layoutKey);
  if (key !== 'mud' && windowState.has(key)) {
    const current = win.getBounds();
    const bounds = windowState.restore(key, { width: current.width, height: current.height });
    if (bounds.width && bounds.height) win.setSize(bounds.width, bounds.height);
    if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) win.setPosition(bounds.x, bounds.y);
  }
  if (untrackSession) untrackSession();
  untrackSession = key !== 'mud' ? windowState.track(win, key) : null;
}

/**
 * @param {ReturnType<import('./window-state').createWindowStateStore>} [windowState]
 * @param {string} [layoutKey] game session the MUD window belongs to right now
 */
function ensureNarratorWindow(windowState, layoutKey) {
  const existing = getNarratorWindow();
  if (existing) {
    if (windowState) adoptSession(existing, windowState, layoutKey);
    return existing;
  }

  const defaults = { width: 720, height: 820 };
  const bounds = windowState
    ? windowState.restore(mudStateKey(layoutKey), windowState.restore('mud', defaults))
    : defaults;

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    minWidth: 420,
    minHeight: 360,
    resizable: true,
    title: 'FLC MUD',
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload-narrator.js'),
    },
  });

  narratorWindow = win;
  if (bounds.maximized) {
    win.maximize();
  }
  if (windowState) {
    // Generic key keeps a sane default for new sessions; session key is exact.
    windowState.track(win, 'mud');
    adoptSession(win, windowState, layoutKey);
  }
  logInfo('FLC MUD window opened', { perSession: mudStateKey(layoutKey) !== 'mud' });

  win.on('closed', () => {
    logInfo('FLC MUD window closed');
    if (untrackSession) {
      untrackSession();
      untrackSession = null;
    }
    if (narratorWindow === win) {
      narratorWindow = null;
    }
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'narrator.html'));
  return win;
}

function closeNarratorWindow() {
  const win = getNarratorWindow();
  if (!win) {
    return false;
  }
  win.close();
  return true;
}

function sendNarratorLine(line) {
  const win = getNarratorWindow();
  if (!win) {
    return;
  }
  win.webContents.send('narrator:line', line);
}

function sendNarratorStatus(status) {
  const win = getNarratorWindow();
  if (!win) {
    return;
  }
  win.webContents.send('narrator:status', status);
}

module.exports = {
  closeNarratorWindow,
  ensureNarratorWindow,
  getNarratorWindow,
  sendNarratorLine,
  sendNarratorStatus,
};
