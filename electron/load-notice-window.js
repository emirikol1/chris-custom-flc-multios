'use strict';

/**
 * Frameless child that covers the game window during the black screen, before
 * Foundry's loading card exists. It does not take focus. Closed at dom-ready.
 */

const path = require('path');
const { BrowserWindow } = require('electron');

/** @type {WeakMap<object, import('electron').BrowserWindow>} */
const noticeByParent = new WeakMap();

const HTML = path.join(__dirname, '..', 'src', 'load-notice.html');
const PRELOAD = path.join(__dirname, 'preload-load-notice.js');
const SYNC_EVENTS = ['move', 'resize', 'maximize', 'unmaximize', 'restore'];

/**
 * @param {import('electron').BrowserWindow | null | undefined} win
 * @returns {boolean}
 */
function gone(win) {
  return !win || (typeof win.isDestroyed === 'function' && win.isDestroyed());
}

/**
 * @param {import('electron').BrowserWindow} parent
 * @returns {{ x: number, y: number, width: number, height: number }}
 */
function contentBounds(parent) {
  try {
    const bounds = parent.getContentBounds();
    if (bounds && bounds.width > 0 && bounds.height > 0) {
      return {
        x: bounds.x,
        y: bounds.y,
        width: bounds.width,
        height: bounds.height,
      };
    }
  } catch {
    /* bounds unavailable */
  }
  return { x: 0, y: 0, width: 960, height: 640 };
}

/**
 * @param {import('electron').BrowserWindow} parent
 * @param {import('electron').BrowserWindow} child
 */
function syncBounds(parent, child) {
  if (gone(parent) || gone(child)) return;
  try {
    const bounds = contentBounds(parent);
    child.setBounds(bounds);
  } catch {
    /* window is closing */
  }
}

/**
 * @param {import('electron').BrowserWindow} gameWin
 * @returns {import('electron').BrowserWindow | null}
 */
function openLoadNotice(gameWin) {
  if (gone(gameWin)) return null;
  const existing = noticeByParent.get(gameWin);
  if (existing && !gone(existing)) {
    syncBounds(gameWin, existing);
    try {
      if (typeof existing.isVisible === 'function' && !existing.isVisible()) existing.show();
    } catch {
      /* ignore */
    }
    return existing;
  }

  const bounds = contentBounds(gameWin);
  const child = new BrowserWindow({
    parent: gameWin,
    frame: false,
    show: false,
    focusable: false,
    skipTaskbar: true,
    resizable: false,
    movable: false,
    minimizable: false,
    maximizable: false,
    fullscreenable: false,
    hasShadow: false,
    backgroundColor: '#161818',
    x: bounds.x,
    y: bounds.y,
    width: bounds.width,
    height: bounds.height,
    webPreferences: {
      preload: PRELOAD,
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      spellcheck: false,
    },
  });
  noticeByParent.set(gameWin, child);

  const onSync = () => syncBounds(gameWin, child);
  for (let i = 0; i < SYNC_EVENTS.length; i += 1) {
    try { gameWin.on(SYNC_EVENTS[i], onSync); } catch { /* ignore */ }
  }
  const detach = () => {
    for (let i = 0; i < SYNC_EVENTS.length; i += 1) {
      try { gameWin.removeListener(SYNC_EVENTS[i], onSync); } catch { /* ignore */ }
    }
  };

  child.on('closed', () => {
    detach();
    if (noticeByParent.get(gameWin) === child) noticeByParent.delete(gameWin);
  });
  const show = () => {
    if (gone(child)) return;
    onSync();
    try { child.show(); } catch { /* ignore */ }
  };
  child.once('ready-to-show', show);
  try {
    child.webContents.once('did-finish-load', () => {
      if (typeof child.isVisible === 'function' && child.isVisible()) return;
      show();
    });
  } catch {
    /* webContents not ready */
  }
  child.loadFile(HTML).catch(() => {});
  return child;
}

/**
 * @param {import('electron').BrowserWindow | null | undefined} gameWin
 */
function closeLoadNotice(gameWin) {
  if (!gameWin) return;
  const child = noticeByParent.get(gameWin);
  if (!child) return;
  noticeByParent.delete(gameWin);
  if (gone(child)) return;
  try { child.close(); } catch { /* ignore */ }
}

/**
 * @param {import('electron').BrowserWindow | null | undefined} gameWin
 * @returns {boolean}
 */
function loadNoticeOpen(gameWin) {
  const child = gameWin ? noticeByParent.get(gameWin) : null;
  return !!(child && !gone(child));
}

module.exports = {
  openLoadNotice,
  closeLoadNotice,
  loadNoticeOpen,
};
