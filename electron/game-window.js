const { BrowserWindow, session, app, ipcMain } = require('electron');
const { readGpuPrefs, writeGpuPrefs } = require('./gpu-prefs');
const { redactForLog } = require('./log-redact');
const { logInfo, logWarn, logError } = require('./logger');

/** @type {Map<string, import('electron').BrowserWindow>} */
const gameWindowsById = new Map();

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
 * @param {{ id?: string, url: string, label?: string, incognito?: boolean }} payload
 * @param {string} gpuPrefsPath
 * @returns {Promise<void>}
 */
function openGameWindow(payload, gpuPrefsPath) {
  const { id, url, label, incognito } = payload;

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

  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    resizable: true,
    title: sanitizeTitle(label),
    webPreferences: {
      session: session.fromPartition(partition),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const windowTitle = sanitizeTitle(label);
  logInfo(`Game window opened: "${windowTitle}" (id=${id || 'anonymous'})`);

  win.on('closed', () => {
    logInfo(`Game window closed: "${windowTitle}" (id=${id || 'anonymous'})`);
    if (id && gameWindowsById.get(id) === win) {
      gameWindowsById.delete(id);
    }
  });

  if (id) {
    gameWindowsById.set(id, win);
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
    }
  });

  win.loadURL(loadUrl);
  return Promise.resolve();
}

/**
 * @param {string} gpuPrefsPath
 */
function registerGameIpc(gpuPrefsPath) {
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
};
