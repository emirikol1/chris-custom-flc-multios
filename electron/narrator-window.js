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

/**
 * @param {{ restore: Function, track: Function }} [windowState]
 */
function ensureNarratorWindow(windowState) {
  const existing = getNarratorWindow();
  if (existing) {
    return existing;
  }

  const defaults = { width: 720, height: 820 };
  const bounds = windowState ? windowState.restore('mud', defaults) : defaults;

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
    windowState.track(win, 'mud');
  }
  logInfo('FLC MUD window opened');

  win.on('closed', () => {
    logInfo('FLC MUD window closed');
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
