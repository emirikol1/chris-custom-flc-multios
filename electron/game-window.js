const path = require('path');
const { BrowserWindow, session, app, ipcMain } = require('electron');
const { readGpuPrefs, writeGpuPrefs } = require('./gpu-prefs');
const { redactForLog } = require('./log-redact');
const { logInfo, logWarn, logError } = require('./logger');
const { buildAutologinScript, isJoinPageUrl } = require('./foundry-autologin');

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
 *   windowState: { restore: Function, track: Function } | null,
 *   isMudEnabled: () => boolean,
 *   buildCaptureScript: (() => string) | null,
 *   onGameWindowOpened: ((win: import('electron').BrowserWindow) => void) | null,
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
 * @param {import('electron').BrowserWindow} parent
 * @param {import('electron').Session} gameSession
 */
function enablePopouts(parent, gameSession) {
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
    logInfo('[game-window] popout opened');
    if (deps.windowState) {
      const bounds = deps.windowState.restore('popout', {
        width: child.getBounds().width,
        height: child.getBounds().height,
      });
      if (bounds.width && bounds.height) {
        child.setSize(bounds.width, bounds.height);
      }
      if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) {
        child.setPosition(bounds.x, bounds.y);
      }
      deps.windowState.track(child, 'popout');
    }
    child.on('closed', () => {
      logInfo('[game-window] popout closed');
    });
  });
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

  const defaults = { width: 1280, height: 800 };
  const bounds = deps.windowState ? deps.windowState.restore('game', defaults) : defaults;

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
    deps.windowState.track(win, 'game');
  }

  const windowTitle = sanitizeTitle(label);
  logInfo(`Game window opened: "${windowTitle}" (id=${id || 'anonymous'})`);
  liveGameWindows.add(win);
  autologinContextByWebContents.set(win.webContents, {
    username: String(creds.username || ''),
    label: windowTitle,
  });

  win.on('closed', () => {
    logInfo(`Game window closed: "${windowTitle}" (id=${id || 'anonymous'})`);
    liveGameWindows.delete(win);
    if (id && gameWindowsById.get(id) === win) {
      gameWindowsById.delete(id);
    }
  });

  if (id) {
    gameWindowsById.set(id, win);
  }

  enablePopouts(win, gameSession);

  if (typeof deps.onGameWindowOpened === 'function') {
    deps.onGameWindowOpened(win);
  }

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
  injectCaptureIntoLiveWindows,
  runInLiveGameWindows,
  hasLiveGameWindows,
  getAutologinContext,
};
