'use strict';

/**
 * Wires detection, the on-disk verdict, the black-screen window, and the
 * loading-card script. Addresses are read only to test same-origin; they are
 * not kept, logged, or written to the verdict file.
 */

const { ipcMain, BrowserWindow } = require('electron');
const { isJoinPageUrl } = require('./foundry-autologin');
const { shortServerHash } = require('./log-ids');
const detect = require('./slow-cache-detect');
const { createSlowCacheStore, validId } = require('./slow-cache-store');
const { buildAdminMessage } = require('./slow-cache-advice');
const { buildSlowCacheNoticeScript } = require('./slow-cache-notice-script');
const { openLoadNotice, closeLoadNotice } = require('./load-notice-window');
const { IPC } = require('./slow-cache-ipc');

/** Loading-card notice is off by user decision; the notice window covers it. */
const IN_CARD_NOTICE = false;

/** @type {ReturnType<typeof createSlowCacheStore> | null} */
let store = null;
/** @type {(msg: string, ...args: unknown[]) => void} */
let logInfo = function logInfo() {};
/** @type {() => void} */
let notify = function notify() {};
/** @type {{ writeText: (text: string) => void } | null} */
let clip = null;
let ipcReady = false;

/** @type {WeakMap<object, { serverId: string }>} */
const watchByWin = new WeakMap();
/** @type {WeakMap<object, { phase: string, logged: boolean, injected: boolean }>} */
const uiByWin = new WeakMap();

/**
 * @param {object | null | undefined} win
 * @returns {boolean}
 */
function gone(win) {
  return !win || (typeof win.isDestroyed === 'function' && win.isDestroyed());
}

/**
 * @param {object} win
 * @returns {{ phase: string, logged: boolean, injected: boolean }}
 */
function uiState(win) {
  let state = uiByWin.get(win);
  if (!state) {
    state = { phase: 'idle', logged: false, injected: false };
    uiByWin.set(win, state);
  }
  return state;
}

/**
 * @param {object} win
 * @returns {string}
 */
function serverIdOf(win) {
  const watched = watchByWin.get(win);
  return watched && typeof watched.serverId === 'string' ? watched.serverId : '';
}

/**
 * Page origin for this one check. Not retained.
 * @param {object} win
 * @returns {string}
 */
function originOf(win) {
  try {
    const current = win.webContents.getURL();
    if (typeof current !== 'string' || !current || current === 'about:blank') return '';
    const parsed = new URL(current);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return '';
    return parsed.origin;
  } catch {
    return '';
  }
}

/**
 * Hostname for the advice check. Not retained or logged.
 * @param {object} win
 * @returns {string}
 */
function hostnameOf(win) {
  const origin = originOf(win);
  if (!origin) return '';
  try {
    return new URL(origin).hostname;
  } catch {
    return '';
  }
}

/**
 * @param {string} serverId
 * @param {{ slow: boolean, proxy: string, total: number, noCache: number }} summary
 */
function logSlow(serverId, summary) {
  const id = shortServerHash(serverId);
  if (!/^srv:[0-9a-f]{6}$/.test(id)) return;
  const proxy = summary.proxy === 'nginx' ? 'nginx' : 'other';
  const assets = Math.round(summary.total);
  const noCache = Math.round(summary.noCache);
  if (!Number.isFinite(assets) || !Number.isFinite(noCache)) return;
  logInfo(
    `slow server cache config detected { server: '${id}', proxy: '${proxy}', assets: ${assets}, noCache: ${noCache} }`,
  );
}

/**
 * @param {object} win
 * @param {{ slow: boolean, proxy: string, total: number, noCache: number }} summary
 */
function commit(win, summary) {
  if (!store || !summary || summary.total < detect.DECIDE_AT) return;
  const id = serverIdOf(win);
  if (!validId(id)) return;
  const show = detect.adviceApplies(summary, hostnameOf(win));
  store.saveVerdict(id, {
    slow: show,
    proxy: summary.proxy === 'nginx' ? 'nginx' : 'other',
    total: summary.total,
    noCache: summary.noCache,
    at: Date.now(),
  });
  const state = uiState(win);
  if (show && !state.logged) {
    state.logged = true;
    logSlow(id, summary);
  }
  try { notify(); } catch { /* join window missed the ping */ }
}

/**
 * @param {object} win
 */
function maybeOpen(win) {
  if (gone(win) || !store) return;
  const state = uiState(win);
  if (state.phase !== 'game') return;
  const row = store.get(serverIdOf(win));
  if (!row || row.dismissed === true) return;
  const host = hostnameOf(win);
  if (!host) return;
  if (!detect.adviceApplies({ slow: row.slow === true, proxy: row.proxy }, host)) return;
  try { openLoadNotice(win); } catch { /* notice window failed */ }
}

/**
 * @param {object} win
 * @param {string} proxy
 */
function inject(win, proxy) {
  if (gone(win)) return;
  const state = uiState(win);
  if (state.injected) return;
  state.injected = true;
  // The in-card notice is intentionally disabled: the black-screen notice
  // window and the Join screen already carry the admin message and copy.
  if (!IN_CARD_NOTICE) return;
  const message = buildAdminMessage({ proxy: proxy === 'nginx' ? 'nginx' : 'other' });
  const source = buildSlowCacheNoticeScript(message);
  try {
    win.webContents.executeJavaScript(source).catch(() => {});
  } catch {
    /* page is closing */
  }
}

/**
 * @param {import('electron').WebContents | null | undefined} contents
 * @returns {object | null}
 */
function gameWinFromContents(contents) {
  if (!contents) return null;
  let win = null;
  try { win = BrowserWindow.fromWebContents(contents); } catch { win = null; }
  if (!win) return null;
  const parent = typeof win.getParentWindow === 'function' ? win.getParentWindow() : null;
  if (parent && watchByWin.has(parent)) return parent;
  if (watchByWin.has(win)) return win;
  return parent || null;
}

/**
 * @param {string} serverId
 * @returns {'nginx' | 'other'}
 */
function proxyFor(serverId) {
  if (!store || !validId(serverId)) return 'other';
  const row = store.get(serverId);
  return row && row.proxy === 'nginx' ? 'nginx' : 'other';
}

/**
 * @param {import('electron').IpcMainInvokeEvent} event
 * @param {unknown} serverId
 * @returns {string}
 */
function idFromEvent(event, serverId) {
  if (validId(serverId)) return serverId;
  const win = gameWinFromContents(event && event.sender);
  return win ? serverIdOf(win) : '';
}

function registerIpc() {
  if (ipcReady) return;
  ipcReady = true;
  ipcMain.handle(IPC.list, () => (store ? store.list() : Object.create(null)));
  ipcMain.handle(IPC.message, (event) => buildAdminMessage({
    proxy: proxyFor(idFromEvent(event, '')),
  }));
  ipcMain.handle(IPC.copy, (event, serverId) => {
    const text = buildAdminMessage({ proxy: proxyFor(idFromEvent(event, serverId)) });
    try {
      if (!clip || typeof clip.writeText !== 'function') return false;
      clip.writeText(text);
      return true;
    } catch {
      return false;
    }
  });
  ipcMain.handle(IPC.dismiss, (event) => {
    if (!store) return false;
    const id = idFromEvent(event, '');
    if (!validId(id)) return false;
    const ok = store.dismiss(id);
    const win = gameWinFromContents(event && event.sender);
    if (win) closeLoadNotice(win);
    try { notify(); } catch { /* ignore */ }
    return ok;
  });
}

/**
 * @param {{
 *   filePath?: string,
 *   logInfo?: (msg: string, ...args: unknown[]) => void,
 *   clipboard?: { writeText: (text: string) => void },
 *   notify?: () => void,
 * }} opts
 */
function initSlowCache(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  if (typeof options.logInfo === 'function') logInfo = options.logInfo;
  if (typeof options.notify === 'function') notify = options.notify;
  if (options.clipboard && typeof options.clipboard.writeText === 'function') clip = options.clipboard;
  if (!store) {
    store = createSlowCacheStore({
      filePath: typeof options.filePath === 'string' ? options.filePath : '',
      log: {
        warn: (name) => {
          try { logInfo(`[slow-cache] ${name}`); } catch { /* ignore */ }
        },
      },
    });
  }
  registerIpc();
}

/**
 * Remember which saved server this window belongs to. The id is the opaque
 * srv: key; the page address is not kept.
 * @param {object} win
 * @param {unknown} serverId
 */
function watch(win, serverId) {
  if (!win) return;
  watchByWin.set(win, { serverId: typeof serverId === 'string' ? serverId : '' });
}

/**
 * One completed response from the game session.
 * @param {object} win
 * @param {unknown} details
 */
function noteCompleted(win, details) {
  try {
    if (gone(win) || !watchByWin.has(win)) return;
    const result = detect.noteCompleted(win, details, originOf(win));
    if (!result.counted || result.summary.total < detect.DECIDE_AT) return;
    const state = uiState(win);
    if (result.crossed || (result.summary.slow === true && !state.logged)) commit(win, result.summary);
    maybeOpen(win);
  } catch {
    /* classification failed */
  }
}

/**
 * Game-document navigation started (not the join page).
 * @param {object} win
 * @param {boolean} isGameDoc
 */
function onNavigation(win, isGameDoc) {
  try {
    if (gone(win) || isGameDoc !== true) return;
    const state = uiState(win);
    if (state.phase === 'game') return;
    const counts = detect.countsFor(win);
    const keep = counts.total >= detect.DECIDE_AT && state.phase !== 'dom' && state.phase !== 'ready';
    if (!keep) {
      detect.resetCounts(win);
      state.logged = false;
      state.injected = false;
    }
    state.phase = 'game';
    if (keep) commit(win, detect.summarize(detect.countsFor(win)));
    maybeOpen(win);
  } catch {
    /* navigation bookkeeping failed */
  }
}

/**
 * @param {object} win
 * @returns {boolean}
 */
function pageIsGameDoc(win) {
  if (uiState(win).phase === 'game') return true;
  try {
    const current = win.webContents.getURL();
    if (typeof current !== 'string' || !/^https?:\/\//i.test(current)) return false;
    return !isJoinPageUrl(current);
  } catch {
    return false;
  }
}

/**
 * @param {object} win
 */
function onDomReady(win) {
  try {
    if (gone(win)) return;
    const gameDoc = pageIsGameDoc(win);
    const state = uiState(win);
    if (gameDoc) state.phase = 'dom';
    closeLoadNotice(win);
    const summary = detect.summarize(detect.countsFor(win));
    if (summary.total >= detect.DECIDE_AT) commit(win, summary);
    if (!gameDoc || !store) return;
    const row = store.get(serverIdOf(win));
    const host = hostnameOf(win);
    if (row && detect.adviceApplies({ slow: row.slow === true, proxy: row.proxy }, host) && row.dismissed !== true) {
      inject(win, row.proxy);
    }
  } catch {
    /* dom-ready hook failed */
  }
}

/**
 * @param {object} win
 */
function onReady(win) {
  try {
    if (gone(win)) return;
    const state = uiState(win);
    state.phase = 'ready';
    const summary = detect.summarize(detect.countsFor(win));
    if (summary.total >= detect.DECIDE_AT) commit(win, summary);
  } catch {
    /* ready hook failed */
  }
}

/**
 * @param {object} win
 */
function onClosed(win) {
  try {
    closeLoadNotice(win);
    if (win) {
      detect.resetCounts(win);
      uiByWin.delete(win);
      watchByWin.delete(win);
    }
  } catch {
    /* close bookkeeping failed */
  }
}

/**
 * @param {unknown} serverId
 * @returns {{ slow: boolean, proxy: 'nginx' | 'other' } | null}
 */
function verdictFor(serverId) {
  if (!store || !validId(serverId)) return null;
  const row = store.get(serverId);
  if (!row) return null;
  return {
    slow: row.slow === true,
    proxy: row.proxy === 'nginx' ? 'nginx' : 'other',
  };
}

module.exports = {
  initSlowCache,
  watch,
  noteCompleted,
  onNavigation,
  onDomReady,
  onReady,
  onClosed,
  verdictFor,
};
