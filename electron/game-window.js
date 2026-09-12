const path = require('path');
const { BrowserWindow, session, app, ipcMain, screen } = require('electron');
const { readGpuPrefs, writeGpuPrefs } = require('./gpu-prefs');
const { redactForLog } = require('./log-redact');
const { logInfo, logWarn, logError } = require('./logger');
const { buildAutologinScript, isJoinPageUrl } = require('./foundry-autologin');
const {
  sanitizeDescriptor,
  descriptorKey,
  popoutBoundsKey,
  layoutRecordKey,
  readLayout,
  sameDesktop,
  layoutRecordFromSnapshot,
  removeEntry,
  SNAPSHOT_LAYOUT_SCRIPT,
  IDENTIFY_POPOUT_SCRIPT,
  GAME_READY_SCRIPT,
  buildRestoreScript,
  buildCloseUnlistedScript,
  shouldForgetOnFailure,
} = require('./session-layout');

/** @type {Map<string, import('electron').BrowserWindow>} */
const gameWindowsById = new Map();
/** @type {Set<import('electron').BrowserWindow>} */
const liveGameWindows = new Set();
/** @type {WeakMap<import('electron').WebContents, { username: string, label: string }>} */
const autologinContextByWebContents = new WeakMap();

/**
 * Integration points supplied by main.js so this module stays free of
 * narrator/window-state wiring details.
 * @type {{
 *   windowState: ReturnType<import('./window-state').createWindowStateStore> | null,
 *   isMudEnabled: () => boolean,
 *   buildCaptureScript: (() => string) | null,
 *   onGameWindowOpened: ((win: import('electron').BrowserWindow, info: { layoutKey: string, sessionScoped: boolean }) => void) | null,
 * }}
 */
const deps = {
  windowState: null,
  isMudEnabled: () => false,
  buildCaptureScript: null,
  onGameWindowOpened: null,
};

const GAME_PRELOAD = path.join(__dirname, 'preload-game.js');

// Heuristic probe: validates WebGL context creation, not render output (e.g. black canvas).
const WEBGL_PROBE_SCRIPT = `(function() {
  try {
    var canvas = document.createElement('canvas');
    var gl = canvas.getContext('webgl2') || canvas.getContext('webgl');
    if (!gl) {
      return { ok: false, reason: 'WebGL context creation failed' };
    }
    if (gl.isContextLost && gl.isContextLost()) {
      return { ok: false, reason: 'WebGL context is lost' };
    }
    if (gl.getError && gl.getError() !== gl.NO_ERROR) {
      return { ok: false, reason: 'WebGL reported an error after context creation' };
    }
    return { ok: true, reason: null };
  } catch (e) {
    return { ok: false, reason: (e && e.message) ? e.message : 'WebGL probe failed' };
  }
})()`;

/**
 * @param {string} url
 * @returns {string}
 */
function normalizeGameUrl(url) {
  const trimmed = String(url).trim();
  if (!/^https?:\/\//i.test(trimmed)) {
    return `https://${trimmed}`;
  }
  return trimmed;
}

/**
 * @param {string} [label]
 * @returns {string}
 */
function sanitizeTitle(label) {
  return String(label || 'Game').slice(0, 200);
}

/**
 * @param {import('electron').BrowserWindow} excludeWin
 * @param {{ reason: string, message: string }} info
 */
function notifyWebglFallbackExcluding(excludeWin, info) {
  for (const win of BrowserWindow.getAllWindows()) {
    if (win === excludeWin || win.isDestroyed()) {
      continue;
    }
    win.webContents.send('webgl:fallback', info);
  }
}

/**
 * @param {import('electron').BrowserWindow} gameWin
 * @param {string|null|undefined} reason
 * @param {string} gpuPrefsPath
 */
function handleProbeFailure(gameWin, reason, gpuPrefsPath) {
  const prefs = readGpuPrefs(gpuPrefsPath);
  if (prefs.preferSoftwareWebgl) {
    return;
  }

  const fallbackReason = reason || 'WebGL context creation failed';
  logError(
    `[GPU] WebGL probe failed, falling back to software rendering: ${fallbackReason}`,
  );

  writeGpuPrefs(gpuPrefsPath, {
    preferSoftwareWebgl: true,
    lastFallbackReason: fallbackReason,
    lastFallbackAt: new Date().toISOString(),
  });

  notifyWebglFallbackExcluding(gameWin, {
    reason: fallbackReason,
    message: 'WebGL fell back to software rendering',
  });

  logWarn('[GPU] Relaunching app to apply SwiftShader flags');

  setTimeout(() => {
    if (!gameWin.isDestroyed()) {
      gameWin.close();
    }
    app.relaunch();
    app.exit(0);
  }, 400);
}

/**
 * Inject the Foundry chat capture into one game window (Mud feature).
 * @param {import('electron').BrowserWindow} win
 */
async function injectCapture(win) {
  if (!deps.isMudEnabled() || typeof deps.buildCaptureScript !== 'function') {
    return;
  }
  if (!win || win.isDestroyed()) {
    return;
  }
  try {
    await win.webContents.executeJavaScript(deps.buildCaptureScript());
    logInfo('[game-window] foundry capture injected');
  } catch {
    logWarn('[game-window] foundry capture inject failed');
  }
}

/** Called when the Mud toggle is switched on while games are open. */
function injectCaptureIntoLiveWindows() {
  for (const win of liveGameWindows) {
    injectCapture(win);
  }
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {{ username?: string, password?: string, autoJoin?: boolean }} creds
 */
async function maybeAutologin(win, creds) {
  // Password is optional: Foundry users may have no password set.
  if (!creds || creds.autoJoin === false || !creds.username) {
    return;
  }
  if (win.isDestroyed()) {
    return;
  }
  let currentUrl = '';
  try {
    currentUrl = win.webContents.getURL();
  } catch {
    return;
  }
  if (!isJoinPageUrl(currentUrl)) {
    return;
  }
  try {
    await win.webContents.executeJavaScript(
      buildAutologinScript({ username: creds.username, password: creds.password }),
    );
    logInfo('[game-window] autologin armed');
  } catch {
    logWarn('[game-window] autologin inject failed');
  }
}

/**
 * Window-state key for a game session. Saved servers get their own layout;
 * incognito or anonymous connections share the generic one.
 * @param {string | undefined} serverId
 * @param {boolean | undefined} incognito
 * @returns {string}
 */
function sessionLayoutKey(serverId, incognito) {
  if (incognito || !serverId) return 'game';
  return `game:${serverId}`;
}

// ---------------------------------------------------------------------------
// Session screen layout: in-page Foundry windows + PopOut! OS windows.
// ---------------------------------------------------------------------------

const SNAPSHOT_INTERVAL_MS = 3000;
const IDENTIFY_POLL_MS = 400;
const IDENTIFY_TIMEOUT_MS = 15000;
const READY_POLL_MS = 500;
const READY_TIMEOUT_MS = 120000;
const POPOUT_MODULE_GRACE_MS = 10000;
const RESTORE_ENTRY_TIMEOUT_MS = 25000;
const CLOSE_FLUSH_TIMEOUT_MS = 800;

/**
 * @typedef {{
 *   layoutKey: string,
 *   sessionScoped: boolean,
 *   parentClosing: boolean,
 *   closeFlushed: boolean,
 *   restoring: boolean,
 *   restoreDone: boolean,
 *   snapshotsSuspended: boolean,
 *   pendingEntry: import('./session-layout').LayoutEntry | null,
 *   popouts: Map<import('electron').BrowserWindow, { key: string, desc: object | null, untrack: (() => void) | null, slot: number }>,
 *   snapshotTimer: NodeJS.Timeout | null,
 *   lastSaved: string,
 * }} LayoutCtx
 */

/** @type {WeakMap<import('electron').WebContents, LayoutCtx>} */
const layoutCtxByWebContents = new WeakMap();
/** @type {Map<string, LayoutCtx>} layoutKey -> ctx of the live game window */
const layoutCtxByKey = new Map();

/**
 * @param {Promise<T>} promise
 * @param {number} ms
 * @returns {Promise<T>}
 * @template T
 */
function withTimeout(promise, ms) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('timeout')), ms);
    promise.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      },
    );
  });
}

function currentDisplays() {
  try {
    return screen.getAllDisplays();
  } catch {
    return [];
  }
}

/**
 * @param {string} layoutKey
 * @returns {LayoutCtx}
 */
function createLayoutCtx(layoutKey) {
  return {
    layoutKey,
    sessionScoped: layoutKey !== 'game',
    parentClosing: false,
    closeFlushed: false,
    restoring: false,
    restoreDone: false,
    /** Bumped on each main-frame navigation; a restore runs at most once per load. */
    loadSeq: 0,
    restoreSeq: -1,
    snapshotsSuspended: false,
    pendingEntry: null,
    popouts: new Map(),
    snapshotTimer: null,
    lastSaved: '',
  };
}

/**
 * Persist a page snapshot for this session (no-op when not applicable).
 * @param {LayoutCtx} ctx
 * @param {unknown} raw result of SNAPSHOT_LAYOUT_SCRIPT (or IPC payload)
 * @returns {boolean} saved
 */
function saveLayoutSnapshot(ctx, raw) {
  if (!deps.windowState || !ctx.sessionScoped) return false;
  if (ctx.restoring || !ctx.restoreDone || ctx.snapshotsSuspended) return false;
  const record = layoutRecordFromSnapshot(raw, { displays: currentDisplays() });
  if (!record) return false;
  const sig = JSON.stringify({ w: record.windows, d: record.desktop });
  if (sig === ctx.lastSaved) return false;
  deps.windowState.set(layoutRecordKey(ctx.layoutKey), record);
  ctx.lastSaved = sig;
  return true;
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {LayoutCtx} ctx
 */
async function snapshotNow(win, ctx) {
  if (!win || win.isDestroyed()) return false;
  try {
    const raw = await withTimeout(
      win.webContents.executeJavaScript(SNAPSHOT_LAYOUT_SCRIPT, true),
      CLOSE_FLUSH_TIMEOUT_MS,
    );
    return saveLayoutSnapshot(ctx, raw);
  } catch {
    return false;
  }
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {LayoutCtx} ctx
 */
function startSnapshotLoop(win, ctx) {
  stopSnapshotLoop(ctx);
  if (!ctx.sessionScoped) return;
  ctx.snapshotTimer = setInterval(() => {
    if (win.isDestroyed() || ctx.parentClosing) {
      stopSnapshotLoop(ctx);
      return;
    }
    snapshotNow(win, ctx);
  }, SNAPSHOT_INTERVAL_MS);
}

/** @param {LayoutCtx} ctx */
function stopSnapshotLoop(ctx) {
  if (ctx.snapshotTimer) {
    clearInterval(ctx.snapshotTimer);
    ctx.snapshotTimer = null;
  }
}

/**
 * Apply saved bounds for `key` to a popout window, if any are stored.
 * @param {import('electron').BrowserWindow} child
 * @param {string} key
 */
function applySavedPopoutBounds(child, key) {
  if (!deps.windowState || child.isDestroyed()) return;
  if (!deps.windowState.has(key)) return;
  const requested = child.getBounds();
  const bounds = deps.windowState.restore(key, { width: requested.width, height: requested.height });
  if (bounds.width && bounds.height) child.setSize(bounds.width, bounds.height);
  if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) child.setPosition(bounds.x, bounds.y);
}

/**
 * Switch the window-state key a popout is tracked under.
 * @param {import('electron').BrowserWindow} child
 * @param {{ key: string, untrack: (() => void) | null }} entry
 * @param {string} key
 */
function trackPopoutAs(child, entry, key) {
  if (!deps.windowState) return;
  if (entry.untrack) entry.untrack();
  entry.key = key;
  entry.untrack = deps.windowState.track(child, key);
}

/**
 * Poll the popout window until PopOut! tells us which Application it holds,
 * then re-key its remembered bounds by that identity.
 * @param {import('electron').BrowserWindow} child
 * @param {{ key: string, desc: object | null, untrack: (() => void) | null }} entry
 * @param {LayoutCtx} ctx
 */
async function identifyPopout(child, entry, ctx) {
  const started = Date.now();
  while (!child.isDestroyed() && Date.now() - started < IDENTIFY_TIMEOUT_MS) {
    let raw = null;
    try {
      raw = await child.webContents.executeJavaScript(IDENTIFY_POPOUT_SCRIPT, true);
    } catch {
      raw = null;
    }
    const desc = sanitizeDescriptor(raw);
    if (desc) {
      if (entry.desc && descriptorKey(entry.desc) === descriptorKey(desc)) return;
      const key = popoutBoundsKey(ctx.layoutKey, desc);
      const hadSaved = Boolean(deps.windowState && deps.windowState.has(key));
      applySavedPopoutBounds(child, key);
      trackPopoutAs(child, entry, key);
      entry.desc = desc;
      logInfo('[game-window] popout identified', { kind: desc.kind, restoredBounds: hadSaved });
      return;
    }
    await new Promise((r) => setTimeout(r, IDENTIFY_POLL_MS));
  }
}

/**
 * Wait until Foundry reports game.ready (and, if wanted, PopOut! is present).
 * @param {import('electron').BrowserWindow} win
 * @param {{ needPopout: boolean }} opts
 * @returns {Promise<{ ready: boolean, popout: boolean }>}
 */
async function waitForGameReady(win, opts) {
  const started = Date.now();
  let readyAt = 0;
  let last = { ready: false, popout: false };
  while (!win.isDestroyed() && Date.now() - started < READY_TIMEOUT_MS) {
    try {
      last = (await win.webContents.executeJavaScript(GAME_READY_SCRIPT, true)) || last;
    } catch {
      return { ready: false, popout: false };
    }
    if (last.ready) {
      if (!readyAt) readyAt = Date.now();
      if (!opts.needPopout || last.popout || Date.now() - readyAt > POPOUT_MODULE_GRACE_MS) {
        return { ready: true, popout: Boolean(last.popout) };
      }
    }
    await new Promise((r) => setTimeout(r, READY_POLL_MS));
  }
  return { ready: false, popout: false };
}

/**
 * Restore the saved screen layout for this session, then close anything that
 * is open but was not part of it. Every step is isolated so one bad window
 * cannot affect the others or the game window itself.
 * @param {import('electron').BrowserWindow} win
 * @param {LayoutCtx} ctx
 */
async function restoreSessionLayout(win, ctx) {
  if (ctx.restoring || ctx.restoreDone) return;
  // Foundry can fire did-finish-load more than once for one document load.
  if (ctx.restoreSeq === ctx.loadSeq) return;
  ctx.restoreSeq = ctx.loadSeq;
  if (!ctx.sessionScoped || !deps.windowState) {
    ctx.restoreDone = true;
    return;
  }
  ctx.restoring = true;
  try {
    const record = deps.windowState.get(layoutRecordKey(ctx.layoutKey));
    let layout = readLayout(record);
    const needPopout = layout.some((e) => e.mode === 'popout');
    const ready = await waitForGameReady(win, { needPopout });
    if (!ready.ready || win.isDestroyed()) {
      // Not a game page (or it never became ready): nothing to restore or record.
      ctx.restoring = false;
      return;
    }

    if (layout.length === 0) {
      logInfo('[game-window] layout: nothing saved for this session');
    } else if (!sameDesktop(record && /** @type {any} */ (record).desktop, currentDisplays())) {
      logInfo('[game-window] layout: desktop changed since last session, not restored', {
        saved: layout.length,
      });
      layout = [];
    } else {
      const preexisting = new Set(ctx.popouts.keys());
      let changed = false;
      let restored = 0;
      for (const entry of layout.slice()) {
        if (win.isDestroyed()) break;
        let result = { ok: false, reason: 'exception' };
        try {
          if (entry.mode === 'popout') ctx.pendingEntry = entry;
          result =
            (await withTimeout(
              win.webContents.executeJavaScript(buildRestoreScript(entry), true),
              RESTORE_ENTRY_TIMEOUT_MS,
            )) || result;
        } catch (err) {
          result = { ok: false, reason: err && err.message === 'timeout' ? 'timeout' : 'exception' };
        } finally {
          ctx.pendingEntry = null;
        }
        if (result.ok) {
          restored += 1;
        } else {
          const reason = String(result.reason || 'unknown');
          logWarn('[game-window] layout: window not restored', { kind: entry.kind, mode: entry.mode, reason });
          if (shouldForgetOnFailure(reason)) {
            layout = removeEntry(layout, entry);
            changed = true;
          }
        }
      }

      // Same screen state: close anything that is open but was not saved.
      let closedInPage = 0;
      try {
        closedInPage = Number(
          await withTimeout(
            win.webContents.executeJavaScript(buildCloseUnlistedScript(layout), true),
            RESTORE_ENTRY_TIMEOUT_MS,
          ),
        ) || 0;
      } catch {
        closedInPage = 0;
      }
      let closedPopouts = 0;
      const keepPopoutKeys = new Set(
        layout.filter((e) => e.mode === 'popout').map((e) => descriptorKey(e)),
      );
      for (const child of preexisting) {
        if (child.isDestroyed()) continue;
        const entry = ctx.popouts.get(child);
        const keep = entry && entry.desc && keepPopoutKeys.has(descriptorKey(entry.desc));
        if (!keep) {
          try {
            child.close();
            closedPopouts += 1;
          } catch {
            /* ignore */
          }
        }
      }
      logInfo('[game-window] layout restored', {
        restored,
        skipped: layout.length - restored,
        closedInPage,
        closedPopouts,
      });
      if (changed && record && typeof record === 'object') {
        deps.windowState.set(layoutRecordKey(ctx.layoutKey), { ...record, windows: layout });
      }
    }
  } catch (err) {
    logWarn('[game-window] layout restore failed', { error: err && err.name ? err.name : 'Error' });
  } finally {
    ctx.restoring = false;
    ctx.restoreDone = true;
  }
  if (!win.isDestroyed()) {
    armPageHideSnapshot(win);
    startSnapshotLoop(win, ctx);
  }
}

/**
 * Ask the page to send a final snapshot when it unloads (reload, disconnect,
 * navigation, window close) so the last state is never lost.
 * @param {import('electron').BrowserWindow} win
 */
function armPageHideSnapshot(win) {
  const src = `(function(){
    if (window.__flcLayoutHideArmed) return;
    window.__flcLayoutHideArmed = true;
    window.addEventListener('pagehide', function () {
      try {
        var snap = ${SNAPSHOT_LAYOUT_SCRIPT};
        if (snap && window.flcGame && typeof window.flcGame.layoutSnapshot === 'function') {
          window.flcGame.layoutSnapshot(snap);
        }
      } catch (e) {}
    });
  })()`;
  win.webContents.executeJavaScript(src, true).catch(() => {});
}

/**
 * Popout OS windows (PopOut! module / window.open) for a game window.
 * @param {import('electron').BrowserWindow} parent
 * @param {import('electron').Session} gameSession
 * @param {LayoutCtx} ctx
 */
function enablePopouts(parent, gameSession, ctx) {
  parent.webContents.setWindowOpenHandler(() => ({
    action: 'allow',
    overrideBrowserWindowOptions: {
      autoHideMenuBar: true,
      webPreferences: {
        session: gameSession,
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        preload: GAME_PRELOAD,
      },
    },
  }));

  parent.webContents.on('did-create-window', (child) => {
    const slot = acquirePopoutSlot(ctx.layoutKey);
    /** @type {{ key: string, desc: object | null, untrack: (() => void) | null, slot: number }} */
    const entry = { key: popoutSlotKey(ctx.layoutKey, slot), desc: null, untrack: null, slot };
    ctx.popouts.set(child, entry);

    // Opened by our own restore: we already know what it is.
    const expected = ctx.pendingEntry ? sanitizeDescriptor(ctx.pendingEntry) : null;
    if (expected) {
      entry.desc = expected;
      entry.key = popoutBoundsKey(ctx.layoutKey, expected);
    }
    logInfo('[game-window] popout opened', { slot, restored: Boolean(expected) });
    if (deps.windowState) {
      applySavedPopoutBounds(child, entry.key);
      entry.untrack = deps.windowState.track(child, entry.key);
    }
    identifyPopout(child, entry, ctx).catch(() => {});

    child.on('closed', () => {
      ctx.popouts.delete(child);
      releasePopoutSlot(ctx.layoutKey, slot);
      logInfo('[game-window] popout closed', { slot });
    });
  });
}

/** Popout slots currently in use, per session layout key (1-based). */
const popoutSlotsInUse = new Map();

/**
 * Fallback identity for popouts PopOut! does not know about (plain
 * window.open): the Nth concurrently open one shares slot N's memory.
 * @param {string} layoutKey
 * @returns {number}
 */
function acquirePopoutSlot(layoutKey) {
  let used = popoutSlotsInUse.get(layoutKey);
  if (!used) {
    used = new Set();
    popoutSlotsInUse.set(layoutKey, used);
  }
  let slot = 1;
  while (used.has(slot)) slot += 1;
  used.add(slot);
  return slot;
}

/**
 * @param {string} layoutKey
 * @param {number} slot
 */
function releasePopoutSlot(layoutKey, slot) {
  const used = popoutSlotsInUse.get(layoutKey);
  if (used) {
    used.delete(slot);
    if (used.size === 0) popoutSlotsInUse.delete(layoutKey);
  }
}

/**
 * @param {string} layoutKey
 * @param {number} slot
 */
function popoutSlotKey(layoutKey, slot) {
  return `${layoutKey}:popout-${slot}`;
}

/**
 * Forget the remembered screen layout (game window bounds, popout bounds,
 * open windows) for one saved server. Used when a bad layout blocks connecting.
 * @param {string} serverId
 * @returns {number} records removed
 */
function forgetSessionLayout(serverId) {
  if (!deps.windowState || !serverId) return 0;
  const layoutKey = sessionLayoutKey(serverId, false);
  const live = layoutCtxByKey.get(layoutKey);
  if (live) {
    // Don't let a connected window immediately re-save what was just forgotten.
    live.snapshotsSuspended = true;
    stopSnapshotLoop(live);
    live.lastSaved = '';
  }
  const removed = deps.windowState.forgetPrefix(layoutKey);
  logInfo('[game-window] session layout forgotten', { removed, live: Boolean(live) });
  return removed;
}

/**
 * @param {{ id?: string, url: string, label?: string, incognito?: boolean, autoJoin?: boolean, username?: string, password?: string }} payload
 * @param {string} gpuPrefsPath
 * @returns {Promise<void>}
 */
function openGameWindow(payload, gpuPrefsPath) {
  const { id, url, label, incognito } = payload;
  const creds = {
    autoJoin: payload.autoJoin !== false,
    username: payload.username,
    password: payload.password,
  };

  if (id && gameWindowsById.has(id)) {
    const existing = gameWindowsById.get(id);
    if (existing && !existing.isDestroyed()) {
      existing.focus();
      return Promise.resolve();
    }
    gameWindowsById.delete(id);
  }

  const loadUrl = normalizeGameUrl(url);
  const redactedUrl = redactForLog(loadUrl);
  let hostDisplay = redactedUrl;
  try {
    hostDisplay = new URL(String(redactedUrl)).host;
  } catch {
    // keep redacted URL string
  }
  logInfo(`Connecting to server "${sanitizeTitle(label)}" (${hostDisplay})`);

  const partition = incognito
    ? `incog-${Date.now()}-${Math.random().toString(36).slice(2)}`
    : `persist:game-${id}`;
  const gameSession = session.fromPartition(partition);

  // Window layout is remembered per session (per saved server), so each
  // server can have its own game-window and popout arrangement. A server that
  // has never been opened falls back to the last generic game layout.
  const layoutKey = sessionLayoutKey(id, incognito);
  const defaults = { width: 1280, height: 800 };
  const bounds = deps.windowState
    ? deps.windowState.restore(layoutKey, deps.windowState.restore('game', defaults))
    : defaults;

  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    resizable: true,
    title: sanitizeTitle(label),
    webPreferences: {
      session: gameSession,
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: GAME_PRELOAD,
    },
  });
  if (bounds.maximized) {
    win.maximize();
  }
  if (deps.windowState) {
    deps.windowState.track(win, layoutKey);
    // Also keep the generic key fresh so new servers start from a sane layout.
    if (layoutKey !== 'game') deps.windowState.track(win, 'game');
  }

  const windowTitle = sanitizeTitle(label);
  logInfo(`Game window opened: "${windowTitle}" (id=${id || 'anonymous'})`);
  liveGameWindows.add(win);
  autologinContextByWebContents.set(win.webContents, {
    username: String(creds.username || ''),
    label: windowTitle,
  });

  const ctx = createLayoutCtx(layoutKey);
  layoutCtxByWebContents.set(win.webContents, ctx);
  if (ctx.sessionScoped) layoutCtxByKey.set(layoutKey, ctx);

  // Save on close/exit: hold the close briefly for a final in-page snapshot,
  // then flush popout bounds and let the window go.
  win.on('close', (event) => {
    ctx.parentClosing = true;
    stopSnapshotLoop(ctx);
    if (ctx.closeFlushed) return;
    ctx.closeFlushed = true;
    if (!ctx.sessionScoped || !ctx.restoreDone) return;
    event.preventDefault();
    const finish = () => {
      if (deps.windowState) {
        for (const [child, entry] of ctx.popouts) {
          if (!child.isDestroyed()) deps.windowState.save(child, entry.key);
        }
      }
      if (!win.isDestroyed()) win.close();
    };
    snapshotNow(win, ctx).then(finish, finish);
  });

  win.on('closed', () => {
    logInfo(`Game window closed: "${windowTitle}" (id=${id || 'anonymous'})`);
    stopSnapshotLoop(ctx);
    liveGameWindows.delete(win);
    if (id && gameWindowsById.get(id) === win) {
      gameWindowsById.delete(id);
    }
    if (layoutCtxByKey.get(layoutKey) === ctx) layoutCtxByKey.delete(layoutKey);
  });

  if (id) {
    gameWindowsById.set(id, win);
  }

  enablePopouts(win, gameSession, ctx);

  if (typeof deps.onGameWindowOpened === 'function') {
    deps.onGameWindowOpened(win, { layoutKey, sessionScoped: ctx.sessionScoped });
  }

  // A new document load (reload / disconnect / different world) starts over.
  win.webContents.on('did-navigate', () => {
    stopSnapshotLoop(ctx);
    ctx.loadSeq += 1;
    ctx.restoring = false;
    ctx.restoreDone = false;
    ctx.lastSaved = '';
  });

  const prefsAtOpen = readGpuPrefs(gpuPrefsPath);

  win.webContents.on('did-finish-load', async () => {
    let result;
    try {
      result = await win.webContents.executeJavaScript(WEBGL_PROBE_SCRIPT);
    } catch (err) {
      logWarn('[game-window] WebGL probe execution failed:', err.message);
      result = { ok: false, reason: err.message };
    }

    if (result && result.ok === false && !prefsAtOpen.preferSoftwareWebgl) {
      handleProbeFailure(win, result.reason, gpuPrefsPath);
      return;
    }

    await maybeAutologin(win, creds);
    await injectCapture(win);
    restoreSessionLayout(win, ctx).catch(() => {});
  });
  win.webContents.on('did-navigate-in-page', () => {
    injectCapture(win);
  });
  win.webContents.on('did-frame-finish-load', (_event, isMainFrame) => {
    if (isMainFrame) {
      injectCapture(win);
    }
  });

  win.loadURL(loadUrl);
  return Promise.resolve();
}

/**
 * Runs a script in every live game window (used by the Mud "post to Foundry" option).
 * @param {string} source JS source to execute
 */
async function runInLiveGameWindows(source) {
  for (const win of liveGameWindows) {
    if (!win || win.isDestroyed()) {
      continue;
    }
    try {
      await win.webContents.executeJavaScript(source);
    } catch {
      logWarn('[game-window] script run in game window failed');
    }
  }
}

/**
 * @param {import('electron').WebContents} webContents
 * @returns {{ username: string, label: string } | undefined}
 */
function getAutologinContext(webContents) {
  return autologinContextByWebContents.get(webContents);
}

function hasLiveGameWindows() {
  for (const win of liveGameWindows) {
    if (win && !win.isDestroyed()) {
      return true;
    }
  }
  return false;
}

/**
 * @param {string} gpuPrefsPath
 * @param {Partial<typeof deps>} [integration]
 */
function registerGameIpc(gpuPrefsPath, integration) {
  Object.assign(deps, integration || {});

  ipcMain.handle('game:connect', (_event, payload) => openGameWindow(payload, gpuPrefsPath));

  ipcMain.handle('game:forget-layout', (_event, serverId) => ({
    removed: forgetSessionLayout(String(serverId || '')),
  }));

  // Final snapshot sent by the page on pagehide (reload, disconnect, close).
  ipcMain.on('foundry:layout-snapshot', (event, raw) => {
    const ctx = layoutCtxByWebContents.get(event.sender);
    if (ctx) saveLayoutSnapshot(ctx, raw);
  });

  ipcMain.handle('game:get-webgl-status', () => {
    const prefs = readGpuPrefs(gpuPrefsPath);
    return {
      mode: prefs.preferSoftwareWebgl ? 'software' : 'hardware',
      lastFallbackReason: prefs.lastFallbackReason || undefined,
    };
  });

  ipcMain.handle('game:set-software-webgl', (_event, preferSoftware) => {
    const prefer = !!preferSoftware;
    const current = readGpuPrefs(gpuPrefsPath);
    writeGpuPrefs(gpuPrefsPath, {
      preferSoftwareWebgl: prefer,
      lastFallbackReason: prefer ? current.lastFallbackReason : null,
      lastFallbackAt: prefer ? current.lastFallbackAt : null,
    });
    logInfo(`[main] Relaunching with preferSoftwareWebgl=${prefer}`);
    app.relaunch();
    app.exit(0);
  });
}

module.exports = {
  openGameWindow,
  registerGameIpc,
  forgetSessionLayout,
  sessionLayoutKey,
  injectCaptureIntoLiveWindows,
  runInLiveGameWindows,
  hasLiveGameWindows,
  getAutologinContext,
};
