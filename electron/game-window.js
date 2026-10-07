const fs = require('fs');
const os = require('os');
const path = require('path');
const { BrowserWindow, Menu, session, app, ipcMain, screen, dialog, net, shell, clipboard } = require('electron');
const { readGpuPrefs, writeGpuPrefs } = require('./gpu-prefs');
const { logDebug, logInfo, logWarn, logError, setLogLevel, getLogLevel, MAIN_LOG_PATH } = require('./logger');
const { shortServerHash } = require('./log-ids');
const { classifyWebglReason } = require('./webgl-reason');
const { buildAutologinScript, isJoinPageUrl } = require('./foundry-autologin');
const { buildTelemetryScript, buildLoadingDetailsScript, buildReferenceLookupScript } = require('./foundry-telemetry');
const { createBadUrlStore, shouldRecordFailure, formatBadUrlsText, failurePathname } = require('./bad-urls');
const { formatBytes, percentile, liveFromSnapshot } = require('./join-telemetry');
const { buildGaugesScript } = require('./gauges-script');
const slowCache = require('./slow-cache-runtime');
const { buildLoadingVideoScript } = require('./loading-video-script');
const { attachMediaProtocol } = require('./media-protocol');
const { expectedTotals, computeFills, monotonic, GAUGES, gaugeBinding } = require('./join-gauges');
const { getLogsDir, getDataDir } = require('./paths');
const { buildTroubleshootingReport } = require('./ts-report');
const { forgetNetTrace, redactedNetTraceText } = require('./net-trace-ipc');
const { summarizeAppMetrics, readMemAvailableBytes } = require('./system-info');
const {
  tailLines,
  diagnosticsFileName,
  buildDiagnosticsText,
  copyDiagnosticsText,
  saveDiagnosticsText,
} = require('./diagnostics');
const {
  openWorldStatsWindow,
  getStatsWindowFor,
  closeStatsWindowFor,
  pushUpdate,
  getStatsContext,
} = require('./world-stats-window');
const {
  buildCenterPromptsScript,
  centerPromptsEnabled,
  normalizePromptGlow,
  normalizePromptGlowStrength,
  promptAutoRaiseEnabled,
  promptHighlightEnabled,
} = require('./center-prompts');
const { gameWindowMenuTemplate } = require('./game-menu');
const { createMenuPlacement } = require('./menu-placement');
const menuPlacement = createMenuPlacement({ platform: process.platform, Menu });
/** @type {WeakSet<import('electron').BrowserWindow>} */
const menuCloseBound = new WeakSet();
/** @type {WeakMap<import('electron').BrowserWindow, import('electron').BrowserWindow>} */
const popoutParentByWin = new WeakMap();
const { askGlowStrength } = require('./glow-strength-prompt');
const { driftedOntoOtherWindow, holdBounds, scheduleUnbury, unburyWindow } = require('./unbury-window');
const { requestUserAttention } = require('./os-attention');
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
  buildTagPopoutScript,
  buildIdentifyPopoutScript,
  FIT_POPOUT_SCRIPT,
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
/** @type {WeakMap<import('electron').BrowserWindow, boolean>} */
const centerPromptsByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, boolean>} */
const promptHighlightByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, string>} */
const promptGlowByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, number>} */
const promptGlowStrengthByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, boolean>} */
const promptAutoRaiseByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, string>} */
const serverIdByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, import('electron').Session>} */
const gameSessionByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, () => void>} */
const unburyCancelByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, string>} */
const hubIdByWin = new WeakMap();
/** @type {WeakMap<import('electron').WebContents, string>} */
const hubIdByContents = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, string>} */
const labelByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, boolean>} */
const incognitoByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, string>} */
const layoutKeyByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, string>} */
const pageTitleByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, boolean>} */
const samplingByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, number>} */
const intervalByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, number>} */
const probeAtByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, boolean>} */
const probeFlightByWin = new WeakMap();
/** @type {WeakMap<import('electron').BrowserWindow, Promise<void>>} */
const pushChainByWin = new WeakMap();
/** @type {WeakSet<import('electron').Session>} */
const netBoundSessions = new WeakSet();
/** @type {WeakMap<import('electron').Session, import('electron').BrowserWindow>} */
const netWinBySession = new WeakMap();
/** @type {Map<string, number>} */
const hubChangeDepth = new Map();
/** @type {WeakMap<import('electron').BrowserWindow, { prev: object | null, labeled: boolean, lastAt: number, timer: NodeJS.Timeout | null }>} */
const gaugeByWin = new WeakMap();

/**
 * @param {unknown} value
 * @returns {string}
 */
function scriptInt(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
  const text = String(Math.round(value));
  return /^\d+$/.test(text) ? text : '0';
}

function freshGaugeState() {
  return { prev: null, labeled: false, lastAt: 0, timer: null };
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {number} seq
 */
function resetJoinGauges(win, seq) {
  const prev = gaugeByWin.get(win);
  if (prev && prev.timer) clearTimeout(prev.timer);
  gaugeByWin.set(win, freshGaugeState());
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
  const n = scriptInt(seq);
  const src = 'if((window.__flcGaugeSeq|0)<' + n + '){window.__flcGaugeSeq=' + n
    + ';window.__flcGauges&&window.__flcGauges.destroy()}';
  win.webContents.executeJavaScript(src).catch(() => {});
}

/**
 * Captions and fills share one id-keyed record. The page looks each dial up
 * by that id, so a missing cache caption cannot shift the dial beside it.
 * @param {ReturnType<import('./join-gauges').expectedTotals>} expected
 * @param {object} fills
 * @returns {{ labels: Record<string, number | null>, fills: Record<string, number | null> }}
 */
function gaugeMaps(expected, fills) {
  const bound = gaugeBinding(fills, expected);
  /** @type {Record<string, number | null>} */
  const labels = {};
  /** @type {Record<string, number | null>} */
  const bodies = {};
  for (let i = 0; i < GAUGES.length; i += 1) {
    const id = GAUGES[i].id;
    labels[id] = bound[id].label;
    bodies[id] = bound[id].fill;
  }
  return { labels, fills: bodies };
}

/**
 * @param {ReturnType<import('./join-gauges').expectedTotals>} expected
 * @returns {string}
 */
function gaugeLabelScript(expected) {
  const labels = gaugeMaps(expected, null).labels;
  return 'window.__flcGauges&&window.__flcGauges.setExpectedLabels(' + JSON.stringify(labels) + ')';
}

/**
 * @param {object} fills
 * @returns {string}
 */
function gaugeFillScript(fills) {
  const body = gaugeMaps(null, fills).fills;
  return 'window.__flcGauges&&window.__flcGauges.setFills(' + JSON.stringify(body) + ')';
}

/**
 * @param {import('electron').BrowserWindow} win
 */
function pushGaugesNow(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
  const state = gaugeByWin.get(win) || freshGaugeState();
  gaugeByWin.set(win, state);
  const hubId = hubIdByWin.get(win);
  let snap = null;
  try {
    if (deps.hub && hubId && typeof deps.hub.snapshot === 'function') snap = deps.hub.snapshot(hubId);
  } catch {
    snap = null;
  }
  if (!snap) return;
  const serverId = serverIdByWin.get(win) || '';
  let rows = [];
  try {
    if (typeof serverId === 'string' && serverId && deps.joinHistory && typeof deps.joinHistory.list === 'function') {
      const listed = deps.joinHistory.list(serverId);
      if (Array.isArray(listed)) rows = listed;
    }
  } catch {
    rows = [];
  }
  let expected;
  try {
    expected = expectedTotals(rows);
  } catch {
    expected = expectedTotals(null);
  }
  let fills;
  try {
    fills = monotonic(state.prev, computeFills(liveFromSnapshot(snap), expected, Date.now()));
  } catch {
    return;
  }
  state.prev = fills;
  state.lastAt = Date.now();
  // Labels ride with the fills: the first pushes can land before the page
  // script has installed, so a one-shot label push would be lost.
  state.labeled = true;
  win.webContents.executeJavaScript(gaugeLabelScript(expected) + ';' + gaugeFillScript(fills)).catch(() => {});
}

/**
 * @param {import('electron').BrowserWindow | null} win
 */
function scheduleGauges(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
  const state = gaugeByWin.get(win) || freshGaugeState();
  gaugeByWin.set(win, state);
  const now = Date.now();
  const wait = 250 - (now - (state.lastAt || 0));
  if (state.lastAt && wait > 0) {
    if (!state.timer) {
      state.timer = setTimeout(() => {
        state.timer = null;
        pushGaugesNow(win);
      }, wait);
    }
    return;
  }
  if (state.timer) {
    clearTimeout(state.timer);
    state.timer = null;
  }
  pushGaugesNow(win);
}

/**
 * Integration points supplied by main.js so this module stays free of
 * narrator/window-state wiring details.
 * @type {{
 *   windowState: ReturnType<import('./window-state').createWindowStateStore> | null,
 *   isMudEnabled: () => boolean,
 *   buildCaptureScript: (() => string) | null,
 *   onGameWindowOpened: ((win: import('electron').BrowserWindow, info: { layoutKey: string, sessionScoped: boolean }) => void) | null,
 *   setCenterPrompts: ((serverId: string, enabled: boolean) => void) | null,
 *   setPromptHighlight: ((serverId: string, enabled: boolean) => void) | null,
 *   setPromptAutoRaise: ((serverId: string, enabled: boolean) => void) | null,
 *   setPromptGlow: ((serverId: string, glow: string) => void) | null,
 *   setPromptGlowStrength: ((serverId: string, strength: number) => void) | null,
 *   forgetPromptAppearance: ((serverId: string) => boolean) | null,
 *   getDiskCache: (() => { limitBytes: number, mode: string }) | null,
 *   hub: object | null,
 *   joinHistory: { forget?: Function, list?: Function } | null,
 *   appPrefs: { get?: () => { loadingBannerEnabled?: boolean } } | null,
 *   machineBaseline: { get?: Function } | null,
 *   getSystemInfo: (() => Promise<object | null>) | null,
 *   notifyJoinWindow: ((channel: string, payload: object) => void) | null,
 * }}
 */
const deps = {
  windowState: null,
  isMudEnabled: () => false,
  buildCaptureScript: null,
  onGameWindowOpened: null,
  setCenterPrompts: null,
  setPromptHighlight: null,
  setPromptAutoRaise: null,
  setPromptGlow: null,
  setPromptGlowStrength: null,
  forgetPromptAppearance: null,
  getDiskCache: null,
  hub: null,
  joinHistory: null,
  appPrefs: null,
  machineBaseline: null,
  getSystemInfo: null,
  notifyJoinWindow: null,
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
  logError('[GPU] WebGL probe failed, falling back to software rendering', {
    reason: classifyWebglReason(fallbackReason),
  });

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
    return false;
  }
  if (win.isDestroyed()) {
    return false;
  }
  let currentUrl = '';
  try {
    currentUrl = win.webContents.getURL();
  } catch {
    return false;
  }
  if (!isJoinPageUrl(currentUrl)) {
    return false;
  }
  try {
    await win.webContents.executeJavaScript(
      buildAutologinScript({ username: creds.username, password: creds.password }),
    );
    logInfo('[game-window] autologin armed');
    return true;
  } catch {
    logWarn('[game-window] autologin inject failed');
    return false;
  }
}

/**
 * @param {import('electron').BrowserWindow} win
 */
function installGameMenu(win) {
  if (!win || win.isDestroyed()) return;
  const enabled = centerPromptsByWin.get(win) !== false;
  const menu = Menu.buildFromTemplate(gameWindowMenuTemplate({
    centerPrompts: enabled,
    promptHighlight: promptHighlightByWin.get(win) !== false,
    promptAutoRaise: promptAutoRaiseByWin.get(win) !== false,
    promptGlow: promptGlowByWin.get(win) || 'blue',
    promptGlowStrength: promptGlowStrengthByWin.get(win),
    verboseLogging: getLogLevel() === 'debug',
    platform: process.platform,
    onToggleCenterPrompts: (next) => {
      setWindowCenterPrompts(win, next);
    },
    onTogglePromptHighlight: (next) => {
      setWindowPromptHighlight(win, next);
    },
    onTogglePromptAutoRaise: (next) => {
      setWindowPromptAutoRaise(win, next);
    },
    onPickPromptGlow: (glow) => {
      setWindowPromptGlow(win, glow);
    },
    onPickPromptGlowStrength: () => {
      choosePromptGlowStrength(win);
    },
    onFullRefresh: () => {
      fullRefresh(win).catch((err) => {
        logWarn('[cache] full refresh failed', {
          error: err && err.name ? err.name : 'Error',
        });
      });
    },
    onOpenWorldStats: () => {
      openStatsFor(win);
    },
    onToggleVerboseLogging: (next) => {
      try {
        setLogLevel(next ? 'debug' : 'info');
      } catch (err) {
        logWarn('[game-window] log level failed', {
          error: err && err.name ? err.name : 'Error',
        });
      }
      installGameMenu(win);
    },
    onOpenLogs: () => {
      try {
        const opened = shell.openPath(getLogsDir());
        if (opened && typeof opened.catch === 'function') opened.catch(() => {});
      } catch (err) {
        logWarn('[game-window] open logs failed', {
          error: err && err.name ? err.name : 'Error',
        });
      }
    },
    onOpenProblemLog: () => {
      try {
        const filePath = path.join(getDataDir(), 'problem-log.jsonl');
        fs.mkdirSync(path.dirname(filePath), { recursive: true });
        if (!fs.existsSync(filePath)) {
          fs.writeFileSync(filePath, '', { encoding: 'utf8', mode: 0o600 });
        }
        const opened = shell.openPath(filePath);
        if (opened && typeof opened.catch === 'function') opened.catch(() => {});
      } catch (err) {
        logWarn('[game-window] open problem log failed', {
          error: err && err.name ? err.name : 'Error',
        });
      }
    },
    onCopyTroubleshooting: () => {
      handleStatsCopyReport(serverIdByWin.get(win) || '').catch((err) => {
        logWarn('[game-window] copy report failed', {
          error: err && err.name ? err.name : 'Error',
        });
      });
    },
    onSaveDiagnostics: () => {
      handleStatsSaveDiagnostics(serverIdByWin.get(win) || '').catch((err) => {
        logWarn('[game-window] save diagnostics failed', {
          error: err && err.name ? err.name : 'Error',
        });
      });
    },
  }));
  if (!menuCloseBound.has(win)) {
    menuCloseBound.add(win);
    win.on('closed', () => {
      menuPlacement.onClosed(win);
    });
  }
  menuPlacement.installForWindow(win, menu);
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {boolean} enabled
 */
function setWindowCenterPrompts(win, enabled) {
  const on = enabled === true;
  centerPromptsByWin.set(win, on);
  const serverId = serverIdByWin.get(win);
  if (serverId && typeof deps.setCenterPrompts === 'function') {
    deps.setCenterPrompts(serverId, on);
  }
  installGameMenu(win);
  applyCenterPrompts(win);
}

function setWindowPromptHighlight(win, enabled) {
  const on = enabled === true;
  promptHighlightByWin.set(win, on);
  const serverId = serverIdByWin.get(win);
  if (serverId && typeof deps.setPromptHighlight === 'function') {
    deps.setPromptHighlight(serverId, on);
  }
  installGameMenu(win);
  applyCenterPrompts(win);
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {boolean} enabled
 */
function setWindowPromptAutoRaise(win, enabled) {
  const on = enabled === true;
  promptAutoRaiseByWin.set(win, on);
  const serverId = serverIdByWin.get(win);
  if (serverId && typeof deps.setPromptAutoRaise === 'function') {
    deps.setPromptAutoRaise(serverId, on);
  }
  installGameMenu(win);
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} glow
 */
function setWindowPromptGlow(win, glow) {
  const id = normalizePromptGlow(glow);
  promptGlowByWin.set(win, id);
  const serverId = serverIdByWin.get(win);
  if (serverId && typeof deps.setPromptGlow === 'function') {
    deps.setPromptGlow(serverId, id);
  }
  installGameMenu(win);
  applyCenterPrompts(win);
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {number} strength
 */
function setWindowPromptGlowStrength(win, strength) {
  const n = normalizePromptGlowStrength(strength);
  promptGlowStrengthByWin.set(win, n);
  const serverId = serverIdByWin.get(win);
  if (serverId && typeof deps.setPromptGlowStrength === 'function') {
    deps.setPromptGlowStrength(serverId, n);
  }
  installGameMenu(win);
  applyCenterPrompts(win);
}

/**
 * @param {import('electron').BrowserWindow} win
 */
function choosePromptGlowStrength(win) {
  const current = normalizePromptGlowStrength(promptGlowStrengthByWin.get(win));
  askGlowStrength(win, current).then((next) => {
    if (next == null || win.isDestroyed()) return;
    setWindowPromptGlowStrength(win, next);
  }).catch(() => {
    logWarn('[game-window] glow strength prompt failed');
  });
}

async function applyCenterPrompts(win) {
  if (!win || win.isDestroyed()) return;
  const enabled = centerPromptsByWin.get(win) !== false;
  const highlight = promptHighlightByWin.get(win) !== false;
  const glow = normalizePromptGlow(promptGlowByWin.get(win));
  const strength = normalizePromptGlowStrength(promptGlowStrengthByWin.get(win));
  try {
    await win.webContents.executeJavaScript(buildCenterPromptsScript(enabled, highlight, glow, strength));
  } catch {
    logWarn('[game-window] center prompts inject failed');
  }
}

function cancelUnbury(win) {
  const cancel = unburyCancelByWin.get(win);
  if (typeof cancel === 'function') cancel();
  unburyCancelByWin.delete(win);
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
    lastNavUrl: '',
    lastNavAt: 0,
    seenGameDoc: false,
    gameDocUrl: '',
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

function savedPopoutPoints(layoutKey) {
  if (!deps.windowState) return [];
  const points = [];
  for (const entry of readLayout(deps.windowState.get(layoutRecordKey(layoutKey)))) {
    if (!entry || entry.mode !== 'popout') continue;
    const saved = deps.windowState.get(popoutBoundsKey(layoutKey, entry));
    if (saved && typeof saved === 'object') points.push(saved);
  }
  return points;
}

/**
 * If the game window has landed on a saved popout, put it back on its own spot.
 * @param {import('electron').BrowserWindow} win
 * @param {LayoutCtx} ctx
 */
function keepGameWindowHome(win, ctx) {
  const home = ctx && ctx.homeBounds;
  if (!home || !win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
  if (typeof win.getBounds !== 'function' || typeof win.setBounds !== 'function') return;
  let here;
  try {
    here = win.getBounds();
  } catch {
    return;
  }
  if (!driftedOntoOtherWindow(here, home, savedPopoutPoints(ctx.layoutKey))) return;
  try {
    win.setBounds(home);
  } catch {
    return;
  }
  logInfo('[game-window] restored game window position');
}

/**
 * Apply saved bounds for `key` to a popout window, if any are stored.
 * Putting the popout in place must not drag the game window with it.
 * @param {import('electron').BrowserWindow | null | undefined} parent
 * @param {import('electron').BrowserWindow} child
 * @param {string} key
 */
function applySavedPopoutBounds(parent, child, key) {
  const restoreParent = holdBounds(parent);
  if (!deps.windowState || child.isDestroyed()) {
    restoreParent();
    return;
  }
  if (!deps.windowState.has(key)) {
    restoreParent();
    return;
  }
  const requested = child.getBounds();
  const bounds = deps.windowState.restore(key, { width: requested.width, height: requested.height });
  if (bounds.width && bounds.height) child.setSize(bounds.width, bounds.height);
  if (Number.isFinite(bounds.x) && Number.isFinite(bounds.y)) child.setPosition(bounds.x, bounds.y);
  restoreParent();
  const ctx = parent && layoutCtxByWebContents.get(parent.webContents);
  if (ctx) {
    keepGameWindowHome(parent, ctx);
    setTimeout(() => keepGameWindowHome(parent, ctx), 200);
  }
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
let nextPopoutTag = 1;

/**
 * Poll until PopOut! (in the game window) tells us which Application the popout
 * holds, then key its remembered bounds by that identity. The popout is tagged
 * so the parent can find it: the child cannot see the parent's lexical globals.
 * Bounds are applied only once (identity if known, slot fallback otherwise) so a
 * fresh popout never inherits the size of a different, earlier popout.
 * @param {import('electron').BrowserWindow} parent
 * @param {import('electron').BrowserWindow} child
 * @param {{ key: string, desc: object | null, untrack: (() => void) | null, boundsApplied: boolean }} entry
 * @param {LayoutCtx} ctx
 */
async function identifyPopout(parent, child, entry, ctx) {
  const tag = nextPopoutTag++;
  const started = Date.now();
  let tagged = false;
  while (!child.isDestroyed() && !parent.isDestroyed() && Date.now() - started < IDENTIFY_TIMEOUT_MS) {
    if (!tagged) {
      try {
        tagged = Boolean(await child.webContents.executeJavaScript(buildTagPopoutScript(tag), true));
      } catch {
        tagged = false;
      }
    }
    let raw = null;
    if (tagged) {
      try {
        raw = await parent.webContents.executeJavaScript(buildIdentifyPopoutScript(tag), true);
      } catch {
        raw = null;
      }
    }
    const desc = sanitizeDescriptor(raw);
    if (desc) {
      const key = popoutBoundsKey(ctx.layoutKey, desc);
      const same = entry.desc && descriptorKey(entry.desc) === descriptorKey(desc);
      const hadSaved = Boolean(deps.windowState && deps.windowState.has(key));
      if (!entry.boundsApplied) {
        applySavedPopoutBounds(parent, child, key);
        entry.boundsApplied = true;
      }
      if (!same) trackPopoutAs(child, entry, key);
      entry.desc = desc;
      logInfo('[game-window] popout identified', { kind: desc.kind, restoredBounds: hadSaved });
      keepPopoutFitted(child).catch(() => {});
      return;
    }
    await new Promise((r) => setTimeout(r, IDENTIFY_POLL_MS));
  }
  // Not a PopOut! window (plain window.open): fall back to the slot's memory.
  if (!child.isDestroyed() && !entry.boundsApplied) {
    applySavedPopoutBounds(parent, child, entry.key);
    entry.boundsApplied = true;
  }
}

/**
 * Install the fit guard in a popout once PopOut! has placed the app node.
 * @param {import('electron').BrowserWindow} child
 */
async function keepPopoutFitted(child) {
  const started = Date.now();
  while (!child.isDestroyed() && Date.now() - started < IDENTIFY_TIMEOUT_MS) {
    try {
      if (await child.webContents.executeJavaScript(FIT_POPOUT_SCRIPT, true)) return;
    } catch {
      // page not ready yet
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

/** Reasons the in-page restore script is allowed to put in a log. */
const LAYOUT_RESTORE_REASONS = new Set([
  'not_found',
  'no_sheet',
  'unknown_kind',
  'render_failed',
  'no_popout_module',
  'exception',
  'timeout',
  'unknown',
]);

/**
 * @param {unknown} reason
 * @returns {string}
 */
function layoutRestoreReason(reason) {
  const code = typeof reason === 'string' ? reason : '';
  return LAYOUT_RESTORE_REASONS.has(code) ? code : 'unknown';
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
          const reason = layoutRestoreReason(result.reason);
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
    keepGameWindowHome(win, ctx);
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
    popoutParentByWin.set(child, parent);
    const slot = acquirePopoutSlot(ctx.layoutKey);
    /** @type {{ key: string, desc: object | null, untrack: (() => void) | null, slot: number, boundsApplied: boolean }} */
    const entry = { key: popoutSlotKey(ctx.layoutKey, slot), desc: null, untrack: null, slot, boundsApplied: false };
    ctx.popouts.set(child, entry);

    // Opened by our own restore: we already know what it is, so its remembered
    // bounds can be applied right away. Otherwise wait for identification.
    const expected = ctx.pendingEntry ? sanitizeDescriptor(ctx.pendingEntry) : null;
    if (expected) {
      entry.desc = expected;
      entry.key = popoutBoundsKey(ctx.layoutKey, expected);
    }
    logInfo('[game-window] popout opened', { slot, restored: Boolean(expected) });
    if (deps.windowState) {
      if (expected) {
        applySavedPopoutBounds(parent, child, entry.key);
        entry.boundsApplied = true;
      }
      entry.untrack = deps.windowState.track(child, entry.key);
    }
    identifyPopout(parent, child, entry, ctx).catch(() => {});

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
  if (!serverId) return 0;
  let removed = 0;
  if (deps.windowState) {
    const layoutKey = sessionLayoutKey(serverId, false);
    const live = layoutCtxByKey.get(layoutKey);
    if (live) {
      // Don't let a connected window immediately re-save what was just forgotten.
      live.snapshotsSuspended = true;
      stopSnapshotLoop(live);
      live.lastSaved = '';
    }
    removed = deps.windowState.forgetPrefix(layoutKey);
  }
  if (typeof deps.forgetPromptAppearance === 'function') {
    deps.forgetPromptAppearance(serverId);
  }
  resetLivePromptAppearance(serverId);
  logInfo('[game-window] session layout forgotten', { removed });
  return removed;
}

/**
 * Put a connected game window back on the default prompt appearance.
 * @param {string} serverId
 */
function resetLivePromptAppearance(serverId) {
  for (const win of liveGameWindows) {
    if (!win || win.isDestroyed()) continue;
    if (serverIdByWin.get(win) !== serverId) continue;
    centerPromptsByWin.set(win, true);
    promptHighlightByWin.set(win, true);
    promptAutoRaiseByWin.set(win, true);
    promptGlowByWin.set(win, 'blue');
    promptGlowStrengthByWin.set(win, 100);
    installGameMenu(win);
    applyCenterPrompts(win);
  }
}

/**
 * @param {import('electron').BrowserWindow | null | undefined} win
 * @returns {import('electron').Session | null}
 */
function sessionForGameWindow(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null;
  return gameSessionByWin.get(win) || null;
}

/**
 * @param {import('electron').Session | null} gameSession
 * @returns {Promise<number | null>}
 */
async function readCacheBytes(gameSession) {
  if (!gameSession || typeof gameSession.getCacheSize !== 'function') return null;
  try {
    const size = await gameSession.getCacheSize();
    return Number.isFinite(size) ? size : null;
  } catch {
    return null;
  }
}

/**
 * Clear the HTTP cache, then reload without using it. Cookies and other storage stay.
 * @param {import('electron').BrowserWindow} win
 * @returns {Promise<void>}
 */
async function fullRefresh(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
  const serverId = serverIdByWin.get(win);
  const gameSession = sessionForGameWindow(win);
  try {
    const hubId = win.webContents && hubIdByContents.get(win.webContents);
    if (hubId) badUrls.clear(hubId);
  } catch {
    /* webContents unavailable */
  }
  const clearedBytes = await readCacheBytes(gameSession);
  try {
    if (gameSession && typeof gameSession.clearCache === 'function') {
      await gameSession.clearCache();
    }
  } catch (err) {
    logWarn('[cache] full refresh clear failed', {
      error: err && err.name ? err.name : 'Error',
    });
  }
  logInfo('[cache] full refresh', { server: shortServerHash(serverId), clearedBytes });
  try {
    if (!win.isDestroyed()) win.webContents.reloadIgnoringCache();
  } catch (err) {
    logWarn('[cache] full refresh reload failed', {
      error: err && err.name ? err.name : 'Error',
    });
  }
  notifyJoin('servers:cache-changed', {});
}

/**
 * @param {import('electron').BrowserWindow | null | undefined} win
 * @returns {Promise<{ cacheBytes: number | null, limitBytes: number, mode: string }>}
 */
async function getCacheInfo(win) {
  const reported = typeof deps.getDiskCache === 'function' ? deps.getDiskCache() : null;
  const limitBytes = reported && Number.isFinite(reported.limitBytes) ? reported.limitBytes : 0;
  const mode = reported && typeof reported.mode === 'string' ? reported.mode : 'auto-fallback';
  const cacheBytes = await readCacheBytes(sessionForGameWindow(win));
  return { cacheBytes, limitBytes, mode };
}

/**
 * Clear the HTTP cache only. Does not call clearStorageData, so login cookies survive.
 * @param {import('electron').BrowserWindow | null | undefined} win
 * @returns {Promise<number | null>} bytes in the cache before the clear, or null
 */
async function clearCache(win) {
  const gameSession = sessionForGameWindow(win);
  if (!gameSession || typeof gameSession.clearCache !== 'function') return null;
  const clearedBytes = await readCacheBytes(gameSession);
  try {
    await gameSession.clearCache();
  } catch (err) {
    logWarn('[cache] clear failed', {
      error: err && err.name ? err.name : 'Error',
    });
    return null;
  }
  return clearedBytes;
}

/**
 * The game window that owns this call. A future stats window is not a game window
 * and passes the saved server id instead.
 * @param {import('electron').IpcMainInvokeEvent} event
 * @param {unknown} serverId
 * @returns {import('electron').BrowserWindow | null}
 */
function gameWindowForCacheIpc(event, serverId) {
  let fromSender = null;
  try {
    fromSender = BrowserWindow.fromWebContents(event && event.sender);
  } catch {
    fromSender = null;
  }
  if (fromSender && liveGameWindows.has(fromSender) && !fromSender.isDestroyed()) {
    return fromSender;
  }
  if (typeof serverId !== 'string' || !serverId) return null;
  const found = gameWindowsById.get(serverId);
  if (found && !found.isDestroyed()) return found;
  return null;
}

/**
 * @param {string} channel
 * @param {object} payload
 */
function notifyJoin(channel, payload) {
  if (typeof deps.notifyJoinWindow !== 'function') return;
  try {
    deps.notifyJoinWindow(channel, payload);
  } catch (err) {
    logWarn('[game-window] join notify failed', {
      error: err && err.name ? err.name : 'Error',
    });
  }
}

/**
 * @param {unknown} serverId
 * @returns {string}
 */
function allocateHubId(serverId) {
  if (typeof serverId === 'string' && serverId) return serverId;
  return `anon-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

/**
 * @param {unknown} serverId
 * @returns {import('electron').BrowserWindow | null}
 */
function windowForServer(serverId) {
  if (typeof serverId !== 'string' || !serverId) return null;
  const win = gameWindowsById.get(serverId);
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null;
  return win;
}

/**
 * @param {object | null | undefined} snap
 * @returns {string}
 */
function titleSuffix(snap) {
  if (!snap) return '';
  if (snap.sync && snap.sync.state === 'out-of-sync') return ' — Out of sync';
  const phases = snap.phases || {};
  if (phases.ready != null) return '';
  if (phases.setup != null || phases.canvasReady != null) return ' — loading: setup';
  const bytes = snap.worldData && snap.worldData.bytes;
  const hasBytes = typeof bytes === 'number' && Number.isFinite(bytes) && bytes >= 0;
  if (phases.worldDataReceived != null || (hasBytes && bytes > 0)) {
    if (hasBytes) return ` — loading: world data ${formatBytes(bytes)}`;
    return ' — loading: world data';
  }
  if (phases.connect != null || phases.gameNavigation != null || phases.domReady != null) return ' — loading';
  return '';
}

/**
 * @param {import('electron').BrowserWindow} win
 */
function applyWindowTitle(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
  const base = pageTitleByWin.get(win) || 'Game';
  let suffix = '';
  const hubId = hubIdByWin.get(win);
  if (deps.hub && hubId && typeof deps.hub.snapshot === 'function') {
    try {
      suffix = titleSuffix(deps.hub.snapshot(hubId));
    } catch {
      suffix = '';
    }
  }
  try {
    win.setTitle(`${base}${suffix}`.slice(0, 240));
  } catch {
    /* title update failed */
  }
}

/**
 * @param {boolean} enabled
 * @param {number} intervalMs
 * @returns {string}
 */
function telemetrySamplingSource(enabled, intervalMs) {
  if (!enabled) {
    return 'try{if(window.__flcTelemetry&&typeof window.__flcTelemetry.stop==="function")window.__flcTelemetry.stop()}catch(e){}';
  }
  const ms = Math.round(Number(intervalMs));
  const safe = Number.isFinite(ms) && ms > 0 ? ms : 5000;
  return `try{if(window.__flcTelemetry&&typeof window.__flcTelemetry.start==="function")window.__flcTelemetry.start(${safe})}catch(e){}`;
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {boolean} enabled
 * @param {number} [intervalMs]
 * @returns {Promise<{ ok: boolean }>}
 */
async function setSampling(win, enabled, intervalMs) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return { ok: false };
  const on = enabled === true;
  const ms = typeof intervalMs === 'number' && Number.isFinite(intervalMs) && intervalMs > 0
    ? Math.round(intervalMs)
    : (intervalByWin.get(win) || 5000);
  samplingByWin.set(win, on);
  intervalByWin.set(win, ms);
  const hubId = hubIdByWin.get(win);
  if (deps.hub && hubId && typeof deps.hub.setLive === 'function') {
    deps.hub.setLive(hubId, { sampling: on, intervalMs: ms });
  }
  try {
    await win.webContents.executeJavaScript(telemetrySamplingSource(on, ms));
  } catch {
    return { ok: false };
  }
  return { ok: true };
}

// ---------------------------------------------------------------------------
// Operational monitoring: learn the sync-loss cause from the client's own
// recent traffic before reaching for an out-of-band probe.
// ---------------------------------------------------------------------------

const OBSERVED_WINDOW_MS = 30000;
const OBSERVED_CAP = 100;
/** Net error names that mean this machine has no usable network path. */
const LOCAL_LINK_ERRORS = new Set([
  'ERR_INTERNET_DISCONNECTED',
  'ERR_NETWORK_CHANGED',
  'ERR_ADDRESS_UNREACHABLE',
  'ERR_NETWORK_ACCESS_DENIED',
  'ERR_PROXY_CONNECTION_FAILED',
]);
/** Net error names that mean the server (or its name/TLS) is not answering. */
const SERVER_SIDE_ERRORS = new Set([
  'ERR_NAME_NOT_RESOLVED',
  'ERR_CONNECTION_REFUSED',
  'ERR_CONNECTION_RESET',
  'ERR_CONNECTION_CLOSED',
  'ERR_CONNECTION_TIMED_OUT',
  'ERR_TIMED_OUT',
  'ERR_CONNECTION_FAILED',
  'ERR_EMPTY_RESPONSE',
  'ERR_SSL_PROTOCOL_ERROR',
]);

/** Failing files for the Bad URLs panel. In memory only — never log or persist. */
const badUrls = createBadUrlStore();

/** @type {Map<string, Array<{ at: number, kind: 'error' | 'ok' | '5xx', name: string }>>} */
const observedByHub = new Map();

/**
 * Record one observed request outcome (no URL, no body; just kind and error name).
 * @param {string} hubId
 * @param {'error' | 'ok' | '5xx'} kind
 * @param {string} name
 */
function noteObserved(hubId, kind, name) {
  if (!hubId) return;
  let list = observedByHub.get(hubId);
  if (!list) {
    list = [];
    observedByHub.set(hubId, list);
  }
  list.push({ at: Date.now(), kind, name: String(name || '').slice(0, 64) });
  if (list.length > OBSERVED_CAP) list.splice(0, list.length - OBSERVED_CAP);
}

/** @param {string} hubId */
function forgetObserved(hubId) {
  observedByHub.delete(hubId);
}

/**
 * Classify a sync loss from what the client has seen in the last 30 s.
 * Returns null when there is nothing recent to learn from.
 * @param {string} hubId
 * @param {{ reconnects?: number } | null} sync
 * @param {number} [nowMs]
 * @returns {'local-offline' | 'server-unreachable' | 'socket-stalled' | null}
 */
function classifyObservedCause(hubId, sync, nowMs) {
  const list = observedByHub.get(hubId) || [];
  const since = (nowMs || Date.now()) - OBSERVED_WINDOW_MS;
  let local = 0;
  let server = 0;
  let fiveHundred = 0;
  let ok = 0;
  let anyError = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const e = list[i];
    if (e.at < since) break;
    if (e.kind === 'ok') ok += 1;
    else if (e.kind === '5xx') fiveHundred += 1;
    else {
      anyError += 1;
      if (LOCAL_LINK_ERRORS.has(e.name)) local += 1;
      else if (SERVER_SIDE_ERRORS.has(e.name) || /^ERR_CERT_/.test(e.name)) server += 1;
    }
  }
  if (local > 0 && local >= server) return 'local-offline';
  if (server > 0 || fiveHundred > 0) return 'server-unreachable';
  // Requests still succeed and the socket keeps retrying: the socket itself is stuck.
  if (ok > 0 && (!sync || Number(sync.reconnects) > 0 || anyError === 0)) return 'socket-stalled';
  return null;
}

/**
 * @param {unknown} url
 * @returns {boolean}
 */
function isRecordableUrl(url) {
  if (typeof url !== 'string' || !url || url.length > 2048) return false;
  const head = url.slice(0, 8).toLowerCase();
  return head.startsWith('https://') || head.startsWith('http://');
}

/**
 * Join-window "Loading banner" checkbox. The dom-ready handler calls this.
 * @returns {boolean}
 */
function loadingBannerEnabled() {
  try {
    if (!deps.appPrefs || typeof deps.appPrefs.get !== 'function') return true;
    const prefs = deps.appPrefs.get();
    if (!prefs || !Object.prototype.hasOwnProperty.call(prefs, 'loadingBannerEnabled')) return true;
    return prefs.loadingBannerEnabled !== false;
  } catch {
    return true;
  }
}

/**
 * @param {import('electron').Session} gameSession
 * @param {string} hubId
 */
function bindSessionNet(gameSession, hubId, win) {
  if (gameSession && win) netWinBySession.set(gameSession, win);
  if (!gameSession || !deps.hub || !hubId || netBoundSessions.has(gameSession)) return;
  const webRequest = gameSession.webRequest;
  if (!webRequest || typeof webRequest.onErrorOccurred !== 'function') return;
  netBoundSessions.add(gameSession);
  const filter = { urls: ['<all_urls>'] };
  try {
    webRequest.onErrorOccurred(filter, (details) => {
      const raw = details && details.error != null ? String(details.error) : '';
      const name = raw.replace(/^net::/, '');
      if (name && deps.hub) deps.hub.netError(hubId, name);
      if (name) noteObserved(hubId, 'error', name);
      if (details && shouldRecordFailure({ errorName: name, resourceType: details.resourceType }) && isRecordableUrl(details.url)) {
        badUrls.note(hubId, {
          url: details.url,
          status: null,
          error: name,
          resourceType: details.resourceType,
          referrer: details.referrer || null,
          at: Date.now(),
        });
      }
    });
  } catch (err) {
    logWarn('[game-window] net hook failed', { error: err && err.name ? err.name : 'Error' });
  }
  if (typeof webRequest.onCompleted !== 'function') return;
  try {
    webRequest.onCompleted(filter, (details) => {
      if (!details || !deps.hub) return;
      slowCache.noteCompleted(netWinBySession.get(gameSession) || win, details);
      if (typeof details.statusCode === 'number' && details.statusCode >= 400) {
        deps.hub.httpStatus(hubId, details.statusCode);
        noteObserved(hubId, details.statusCode >= 500 ? '5xx' : 'ok', String(details.statusCode));
        if (shouldRecordFailure({ statusCode: details.statusCode, resourceType: details.resourceType }) && isRecordableUrl(details.url)) {
          badUrls.note(hubId, {
            url: details.url,
            status: details.statusCode,
            error: null,
            resourceType: details.resourceType,
            referrer: details.referrer || null,
            at: Date.now(),
          });
        }
      } else {
        noteObserved(hubId, 'ok', '');
      }
      if (details.resourceType !== 'mainFrame' || !details.responseHeaders) return;
      const headers = details.responseHeaders;
      const rawDate = headers.date || headers.Date;
      const text = Array.isArray(rawDate) ? rawDate[0] : rawDate;
      if (typeof text !== 'string' || !text) return;
      const serverMs = Date.parse(text);
      if (!Number.isFinite(serverMs)) return;
      deps.hub.setClockSkew(hubId, Date.now() - serverMs);
    });
  } catch (err) {
    logWarn('[game-window] net hook failed', { error: err && err.name ? err.name : 'Error' });
  }
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} hubId
 */
function bindCrashHandlers(win, hubId) {
  win.webContents.on('render-process-gone', (_event, details) => {
    const reason = details && typeof details.reason === 'string' ? details.reason : 'unknown';
    if (deps.hub && hubId) deps.hub.rendererGone(hubId, reason);
    logWarn('[game-window] renderer gone', { reason, exitCode: details && details.exitCode });
    dialog.showMessageBox(win, {
      type: 'error',
      buttons: ['Reload', 'Close'],
      defaultId: 0,
      cancelId: 1,
      noLink: true,
      title: 'Foundry Light Client',
      message: 'The game page crashed.',
    }).then((result) => {
      const response = result && result.response;
      if (!win || win.isDestroyed()) return;
      if (response === 0) win.webContents.reload();
      else if (response === 1) win.close();
    }).catch(() => {});
  });

  win.webContents.on('unresponsive', () => {
    if (deps.hub && hubId) deps.hub.unresponsive(hubId);
    logWarn('[game-window] unresponsive');
  });

  win.webContents.on('responsive', () => {
    logInfo('[game-window] responsive');
  });

  win.webContents.on('did-fail-load', (_event, errorCode, errorDescription, _validatedURL, isMainFrame) => {
    if (!isMainFrame) return;
    const description = typeof errorDescription === 'string' && errorDescription ? errorDescription : 'ERR_FAILED';
    if (deps.hub && hubId) deps.hub.netError(hubId, description);
    logWarn('[game-window] load failed', { code: errorCode });
  });
}

/**
 * @param {ReturnType<typeof createLayoutCtx>} ctx
 * @param {string} hubId
 * @param {string} navUrl
 */
function noteGameNavigation(ctx, hubId, navUrl) {
  if (!deps.hub || !hubId || !ctx) return;
  if (typeof navUrl !== 'string' || !navUrl || isJoinPageUrl(navUrl)) return;
  let readySeen = false;
  try {
    const snap = deps.hub.snapshot(hubId);
    readySeen = !!(snap && snap.phases && snap.phases.ready != null);
  } catch {
    readySeen = false;
  }
  const sameAgain = ctx.seenGameDoc === true && navUrl === ctx.gameDocUrl;
  if (!ctx.seenGameDoc) {
    ctx.seenGameDoc = true;
    ctx.gameDocUrl = navUrl;
    deps.hub.newDocument(hubId);
    deps.hub.mark(hubId, 'gameNavigation');
    return;
  }
  if (readySeen || sameAgain) {
    deps.hub.resetLoad(hubId, ctx.loadSeq);
    deps.hub.mark(hubId, 'connect');
    deps.hub.mark(hubId, 'gameNavigation');
    ctx.gameDocUrl = navUrl;
    return;
  }
  ctx.gameDocUrl = navUrl;
  deps.hub.newDocument(hubId);
  deps.hub.mark(hubId, 'gameNavigation');
}

/**
 * @returns {number | null}
 */
function currentSpeedIndex() {
  if (!deps.machineBaseline || typeof deps.machineBaseline.get !== 'function') return null;
  try {
    const row = deps.machineBaseline.get();
    const n = row && row.speedIndex;
    return typeof n === 'number' && Number.isFinite(n) ? n : null;
  } catch {
    return null;
  }
}

/**
 * App and cache counters for an open statistics window. Does not touch the page.
 * @param {import('electron').BrowserWindow} win
 * @param {string} hubId
 * @returns {Promise<object | null>}
 */
async function sampleResources(win, hubId) {
  let metrics = null;
  try {
    let pid;
    try {
      pid = win.webContents.getOSProcessId();
    } catch {
      pid = undefined;
    }
    metrics = summarizeAppMetrics(app.getAppMetrics(), { rendererPid: pid, gpu: true });
  } catch {
    metrics = null;
  }
  let mem = null;
  try {
    if (typeof process.getSystemMemoryInfo === 'function') mem = process.getSystemMemoryInfo();
  } catch {
    mem = null;
  }
  let loadAvg = null;
  if (process.platform !== 'win32') {
    try {
      const loads = os.loadavg();
      loadAvg = Array.isArray(loads) && Number.isFinite(loads[0]) ? loads[0] : null;
    } catch {
      loadAvg = null;
    }
  }
  let cache = { cacheBytes: null, limitBytes: null };
  try {
    cache = await getCacheInfo(win);
  } catch {
    cache = { cacheBytes: null, limitBytes: null };
  }
  if (deps.hub && hubId && typeof deps.hub.resourcesUpdate === 'function') {
    deps.hub.resourcesUpdate(hubId, {
      rendererCpuPercent: metrics && metrics.renderer ? metrics.renderer.cpuPercent : null,
      rendererMemoryBytes: metrics && metrics.renderer ? metrics.renderer.memoryBytes : null,
      gpuCpuPercent: metrics && metrics.gpu ? metrics.gpu.cpuPercent : null,
      gpuMemoryBytes: metrics && metrics.gpu ? metrics.gpu.memoryBytes : null,
      systemTotalBytes: mem && Number.isFinite(mem.total) ? mem.total * 1024 : null,
      // Prefer "available" (Linux MemAvailable); "free" ignores reclaimable cache.
      systemFreeBytes: readMemAvailableBytes() ?? (mem && Number.isFinite(mem.free) ? mem.free * 1024 : null),
      loadAvg1: loadAvg,
      cacheBytes: cache.cacheBytes,
      cacheLimitBytes: Number.isFinite(cache.limitBytes) ? cache.limitBytes : null,
    }, false);
  }
  return metrics;
}

/**
 * @param {number} n
 * @returns {string}
 */
function readLogTail(n) {
  try {
    const stat = fs.statSync(MAIN_LOG_PATH);
    const size = stat.size;
    if (!Number.isFinite(size) || size <= 0) return '';
    const take = Math.min(size, 256 * 1024);
    const buf = Buffer.alloc(take);
    const fd = fs.openSync(MAIN_LOG_PATH, 'r');
    try {
      fs.readSync(fd, buf, 0, take, size - take);
    } finally {
      fs.closeSync(fd);
    }
    return tailLines(buf.toString('utf8'), n);
  } catch {
    return '';
  }
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {{ metrics?: boolean }} [opts]
 */
async function assembleStats(win, opts) {
  const hubId = hubIdByWin.get(win);
  if (!deps.hub || !hubId || typeof deps.hub.payload !== 'function') return null;
  const wantMetrics = !!(opts && opts.metrics);
  let systemInfo = null;
  if (typeof deps.getSystemInfo === 'function') {
    try {
      systemInfo = await deps.getSystemInfo();
    } catch {
      systemInfo = null;
    }
  }
  let appMetrics = null;
  if (wantMetrics) appMetrics = await sampleResources(win, hubId);
  let base = null;
  try {
    base = deps.hub.payload(hubId, {
      systemInfo,
      speedIndex: currentSpeedIndex(),
      sampling: samplingByWin.get(win) === true,
      intervalMs: intervalByWin.get(win) || 5000,
    });
  } catch {
    base = null;
  }
  if (!base) return null;
  const cache = await getCacheInfo(win);
  let system = null;
  if (systemInfo && typeof systemInfo === 'object') {
    system = Object.assign({}, systemInfo);
    if (appMetrics) system.appMetrics = appMetrics;
  }
  return Object.assign({}, base, {
    cache,
    system,
    badUrlCount: hubId ? badUrls.count(hubId) : 0,
  });
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} hubId
 */
function schedulePush(win, hubId) {
  if (!hubId || !getStatsWindowFor(win)) return;
  const prev = pushChainByWin.get(win) || Promise.resolve();
  const next = prev.then(() => deliverStats(win, hubId), () => deliverStats(win, hubId));
  pushChainByWin.set(win, next);
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} hubId
 */
async function deliverStats(win, hubId) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return;
  if (!getStatsWindowFor(win)) return;
  const payload = await assembleStats(win, { metrics: samplingByWin.get(win) === true });
  if (!payload || !getStatsWindowFor(win)) return;
  pushUpdate(win, payload);
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} hubId
 */
async function probeServer(win, hubId) {
  let origin = '';
  try {
    origin = new URL(win.webContents.getURL()).origin;
  } catch {
    if (deps.hub && hubId) deps.hub.setSyncCause(hubId, 'server-unreachable');
    return;
  }
  if (!origin || typeof net.fetch !== 'function') {
    if (deps.hub && hubId) deps.hub.setSyncCause(hubId, 'server-unreachable');
    return;
  }
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 5000);
  try {
    await net.fetch(origin, { method: 'HEAD', signal: ctrl.signal });
    if (deps.hub && hubId) deps.hub.setSyncCause(hubId, 'socket-stalled');
  } catch {
    if (deps.hub && hubId) deps.hub.setSyncCause(hubId, 'server-unreachable');
  } finally {
    clearTimeout(timer);
  }
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} hubId
 */
function considerSync(win, hubId) {
  if (!deps.hub || !hubId || typeof deps.hub.snapshot !== 'function') return;
  const snap = deps.hub.snapshot(hubId);
  if (!snap || !snap.sync) return;
  if (snap.sync.state !== 'out-of-sync') {
    if (snap.sync.cause) deps.hub.setSyncCause(hubId, null);
    return;
  }
  if (snap.sync.cause) return;
  let online = true;
  try {
    if (typeof net.isOnline === 'function') online = net.isOnline();
  } catch {
    online = true;
  }
  if (online === false) {
    deps.hub.setSyncCause(hubId, 'local-offline');
    return;
  }
  // Prefer what the client itself observed over an out-of-band probe.
  const observed = classifyObservedCause(hubId, snap.sync);
  if (observed) {
    deps.hub.setSyncCause(hubId, observed);
    return;
  }
  // Nothing recent to learn from: one rate-limited probe as a last resort.
  if (probeFlightByWin.get(win)) return;
  const nowMs = Date.now();
  const prev = probeAtByWin.get(win) || 0;
  if (nowMs - prev < 30000) return;
  probeAtByWin.set(win, nowMs);
  probeFlightByWin.set(win, true);
  probeServer(win, hubId).finally(() => {
    probeFlightByWin.set(win, false);
  });
}

/**
 * @param {import('electron').BrowserWindow} win
 * @param {string} hubId
 */
function onHubChange(win, hubId) {
  const depth = hubChangeDepth.get(hubId) || 0;
  if (depth > 0) return;
  hubChangeDepth.set(hubId, 1);
  try {
    considerSync(win, hubId);
    applyWindowTitle(win);
  } finally {
    hubChangeDepth.set(hubId, 0);
  }
  schedulePush(win, hubId);
}

/**
 * @param {import('electron').BrowserWindow} win
 */
function openStatsFor(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return null;
  const serverId = serverIdByWin.get(win) || '';
  const hubId = hubIdByWin.get(win);
  return openWorldStatsWindow(win, {
    serverId,
    label: labelByWin.get(win) || 'Game',
    incognito: incognitoByWin.get(win) === true,
    windowState: deps.windowState,
    layoutKey: layoutKeyByWin.get(win) || 'game',
    onSampling(enabled, intervalMs) {
      setSampling(win, enabled, intervalMs).catch(() => {});
    },
    onReady() {
      if (hubId) schedulePush(win, hubId);
    },
  });
}

/**
 * @param {string} serverId
 * @returns {Promise<number | null>}
 */
async function clearServerHttpCache(serverId) {
  if (typeof serverId !== 'string' || !serverId) return null;
  const live = gameWindowsById.get(serverId);
  let gameSession = null;
  if (live && !(typeof live.isDestroyed === 'function' && live.isDestroyed())) {
    gameSession = sessionForGameWindow(live);
  }
  if (!gameSession) {
    try {
      gameSession = session.fromPartition(`persist:game-${serverId}`);
    } catch {
      return null;
    }
  }
  const clearedBytes = await readCacheBytes(gameSession);
  try {
    if (gameSession && typeof gameSession.clearCache === 'function') await gameSession.clearCache();
  } catch (err) {
    logWarn('[cache] clear failed', { error: err && err.name ? err.name : 'Error' });
    return null;
  }
  return clearedBytes;
}

/**
 * @param {import('electron').WebContents} sender
 */
function handleStatsGetContext(sender) {
  return getStatsContext(sender);
}

/**
 * @param {unknown} serverId
 */
async function handleStatsGetSnapshot(serverId) {
  const win = windowForServer(serverId);
  if (!win) return null;
  return assembleStats(win, { metrics: true });
}

/**
 * @param {unknown} serverId
 * @param {boolean} enabled
 * @param {number} [intervalMs]
 */
function handleStatsSetSampling(serverId, enabled, intervalMs) {
  const win = windowForServer(serverId);
  if (!win) return Promise.resolve({ ok: false });
  return setSampling(win, enabled === true, intervalMs);
}

/**
 * @param {unknown} serverId
 * @returns {Promise<{ ok: boolean, bytes: number }>}
 */
async function handleStatsCopyReport(serverId, opts) {
  const win = windowForServer(serverId);
  if (!win) return { ok: false, bytes: 0 };
  try {
    const payload = await assembleStats(win, { metrics: true });
    if (!payload) return { ok: false, bytes: 0 };
    let netTrace = null;
    try {
      netTrace = await redactedNetTraceText(serverId, {
        includeAddresses: Boolean(opts && opts.includeAddresses),
      });
    } catch (err) {
      logWarn('[nettrace] report skipped', { error: err && err.name ? err.name : 'Error' });
    }
    const report = buildTroubleshootingReport({
      snapshot: payload.snapshot,
      systemInfo: payload.system,
      findings: payload.findings,
      history: payload.history,
      netTrace,
      slowCache: slowCache.verdictFor(serverId),
    });
    return copyDiagnosticsText({ clipboard }, report);
  } catch (err) {
    logWarn('[game-window] copy report failed', { error: err && err.name ? err.name : 'Error' });
    return { ok: false, bytes: 0 };
  }
}

/**
 * @param {unknown} serverId
 */
async function handleStatsSaveDiagnostics(serverId) {
  const win = windowForServer(serverId);
  if (!win) return { ok: false, error: 'Error' };
  try {
    const payload = await assembleStats(win, { metrics: true });
    if (!payload) return { ok: false, error: 'Error' };
    const report = buildTroubleshootingReport({
      snapshot: payload.snapshot,
      systemInfo: payload.system,
      findings: payload.findings,
      history: payload.history,
      slowCache: slowCache.verdictFor(serverId),
    });
    const text = buildDiagnosticsText({ report, logTail: readLogTail(200) });
    let defaultPath = diagnosticsFileName(new Date());
    try {
      defaultPath = path.join(app.getPath('documents'), diagnosticsFileName(new Date()));
    } catch {
      defaultPath = diagnosticsFileName(new Date());
    }
    return saveDiagnosticsText({
      dialog: { showSaveDialog: (dialogOpts) => dialog.showSaveDialog(win, dialogOpts) },
      fs,
    }, text, { defaultPath });
  } catch (err) {
    logWarn('[game-window] save diagnostics failed', { error: err && err.name ? err.name : 'Error' });
    return { ok: false, error: err && err.name ? err.name : 'Error' };
  }
}

/**
 * @param {unknown} serverId
 */
async function handleStatsFullRefresh(serverId) {
  const win = windowForServer(serverId);
  if (!win) return { ok: false };
  forgetNetTrace(serverId);
  try {
    await fullRefresh(win);
    return { ok: true };
  } catch (err) {
    logWarn('[cache] full refresh failed', { error: err && err.name ? err.name : 'Error' });
    return { ok: false };
  }
}

/**
 * @param {object | null} refMap
 * @param {unknown} url
 * @returns {string[]}
 */
function refsFromLookup(refMap, url) {
  const key = failurePathname(url);
  if (!refMap || typeof refMap !== 'object' || !key) return [];
  if (!Object.prototype.hasOwnProperty.call(refMap, key)) return [];
  const found = refMap[key];
  if (!Array.isArray(found)) return [];
  const refs = [];
  for (let i = 0; i < found.length && refs.length < 5; i += 1) {
    const text = found[i];
    if (typeof text === 'string' && text && text.length <= 2048) refs.push(text);
  }
  return refs;
}

/**
 * Failing files plus in-world references. URLs and names stay in this return
 * value for the statistics window; they are not logged.
 * @param {unknown} serverId
 */
async function handleStatsBadUrls(serverId) {
  const win = windowForServer(serverId);
  if (!win) return { entries: [], count: 0 };
  const hubId = hubIdByWin.get(win);
  if (!hubId) return { entries: [], count: 0 };
  const listed = badUrls.list(hubId);
  const label = labelByWin.get(win) || 'Game';
  let foundryVersion = null;
  let systemId = null;
  let systemVersion = null;
  try {
    const snap = deps.hub && typeof deps.hub.snapshot === 'function' ? deps.hub.snapshot(hubId) : null;
    const world = snap && snap.world;
    if (world && typeof world === 'object') {
      if (typeof world.foundryVersion === 'string' && world.foundryVersion) foundryVersion = world.foundryVersion;
      const system = world.system;
      if (system && typeof system === 'object') {
        if (typeof system.id === 'string' && system.id) systemId = system.id;
        if (typeof system.version === 'string' && system.version) systemVersion = system.version;
      }
    }
  } catch {
    foundryVersion = null;
    systemId = null;
    systemVersion = null;
  }
  const paths = [];
  for (let i = 0; i < listed.length && paths.length < 200; i += 1) {
    const url = listed[i] && listed[i].url;
    if (typeof url === 'string' && url.length <= 2048) paths.push(url);
  }
  let refMap = null;
  if (paths.length) {
    try {
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return { entries: [], count: 0 };
      const raw = await win.webContents.executeJavaScript(buildReferenceLookupScript(paths), true);
      if (raw && typeof raw === 'object') refMap = raw;
    } catch (err) {
      logWarn('[game-window] bad url lookup failed', {
        error: err && err.name ? err.name : 'Error',
      });
      refMap = null;
    }
  }
  if (!windowForServer(serverId)) return { entries: [], count: 0 };
  const entries = listed.map((row) => ({
    url: row.url,
    status: row.status,
    error: row.error,
    resourceType: row.resourceType,
    referrer: row.referrer,
    at: row.at,
    lastAt: row.lastAt,
    hits: row.hits,
    refs: refsFromLookup(refMap, row.url),
  }));
  return {
    entries,
    count: entries.length,
    dropped: badUrls.dropped(hubId),
    label,
    foundryVersion,
    systemId,
    systemVersion,
  };
}

/**
 * @param {unknown} serverId
 * @returns {Promise<{ ok: boolean, count: number }>}
 */
async function handleStatsCopyBadUrls(serverId) {
  try {
    const data = await handleStatsBadUrls(serverId);
    const text = formatBadUrlsText({
      label: data && data.label,
      generatedAt: new Date(),
      foundryVersion: data && data.foundryVersion,
      systemId: data && data.systemId,
      systemVersion: data && data.systemVersion,
      entries: data && data.entries,
      dropped: data && data.dropped,
    });
    clipboard.writeText(text);
    const count = data && typeof data.count === 'number' && Number.isFinite(data.count) ? data.count : 0;
    return { ok: true, count };
  } catch (err) {
    logWarn('[game-window] copy bad urls failed', {
      error: err && err.name ? err.name : 'Error',
    });
    return { ok: false, count: 0 };
  }
}

function noteGpuProcessGone() {
  if (!deps.hub || typeof deps.hub.setClient !== 'function') return;
  for (const win of liveGameWindows) {
    const id = hubIdByWin.get(win);
    if (id) deps.hub.setClient(id, { gpuGone: true });
  }
}

/**
 * @param {import('electron').WebContents} webContents
 * @param {string} error
 */
function noteCertificateError(webContents, error) {
  const id = webContents ? hubIdByContents.get(webContents) : null;
  if (!id || !deps.hub || typeof deps.hub.netError !== 'function') return;
  deps.hub.netError(id, typeof error === 'string' && error ? error : 'ERR_CERT');
}

/**
 * @param {{ id?: string, url: string, label?: string, incognito?: boolean, autoJoin?: boolean, username?: string, password?: string, centerPrompts?: boolean, promptHighlight?: boolean, promptAutoRaise?: boolean, promptGlow?: string, promptGlowStrength?: number }} payload
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
  logInfo('connecting', { server: shortServerHash(id), incognito: Boolean(incognito) });

  const partition = incognito
    ? `incog-${Date.now()}-${Math.random().toString(36).slice(2)}`
    : `persist:game-${id}`;
  const gameSession = session.fromPartition(partition);
  try {
    attachMediaProtocol(gameSession.protocol);
  } catch (err) {
    logWarn('[game-window] media protocol failed', { error: err && err.name ? err.name : 'Error' });
  }

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
      // Keep Foundry's timers and sockets running when this window is unfocused or minimized.
      backgroundThrottling: false,
      autoplayPolicy: 'no-user-gesture-required',
      preload: GAME_PRELOAD,
    },
  });
  gameSessionByWin.set(win, gameSession);
  if (bounds.maximized) {
    win.maximize();
  }
  if (deps.windowState) {
    deps.windowState.track(win, layoutKey);
    // Also keep the generic key fresh so new servers start from a sane layout.
    if (layoutKey !== 'game') deps.windowState.track(win, 'game');
  }

  const windowTitle = sanitizeTitle(label);
  const hubId = allocateHubId(id);
  logInfo('game window opened', { server: shortServerHash(id) });
  liveGameWindows.add(win);
  hubIdByWin.set(win, hubId);
  hubIdByContents.set(win.webContents, hubId);
  labelByWin.set(win, windowTitle);
  incognitoByWin.set(win, Boolean(incognito));
  layoutKeyByWin.set(win, layoutKey);
  pageTitleByWin.set(win, windowTitle);
  autologinContextByWebContents.set(win.webContents, {
    username: String(creds.username || ''),
    label: windowTitle,
  });
  if (deps.hub && typeof deps.hub.attach === 'function') {
    deps.hub.attach(hubId, { serverId: typeof id === 'string' ? id : '', label: windowTitle });
    if (typeof deps.hub.onChange === 'function') deps.hub.onChange(hubId, () => onHubChange(win, hubId));
    deps.hub.mark(hubId, 'connect');
    bindSessionNet(gameSession, hubId, win);
  }
  bindCrashHandlers(win, hubId);

  const ctx = createLayoutCtx(layoutKey);
  ctx.homeBounds = Number.isFinite(bounds.x) && Number.isFinite(bounds.y)
    ? { x: bounds.x, y: bounds.y, width: bounds.width, height: bounds.height }
    : null;
  layoutCtxByWebContents.set(win.webContents, ctx);
  if (ctx.sessionScoped) layoutCtxByKey.set(layoutKey, ctx);

  // Save on close/exit: hold the close briefly for a final in-page snapshot,
  // then flush popout bounds and let the window go.
  win.on('close', (event) => {
    cancelUnbury(win);
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
    logInfo('game window closed', { server: shortServerHash(id) });
    closeStatsWindowFor(win);
    slowCache.onClosed(win);
    if (id) forgetNetTrace(id);
    forgetObserved(hubId);
    badUrls.forget(hubId);
    if (deps.hub && typeof deps.hub.detach === 'function') deps.hub.detach(hubId);
    hubChangeDepth.delete(hubId);
    stopSnapshotLoop(ctx);
    liveGameWindows.delete(win);
    if (id && gameWindowsById.get(id) === win) {
      gameWindowsById.delete(id);
    }
    if (layoutCtxByKey.get(layoutKey) === ctx) layoutCtxByKey.delete(layoutKey);
    notifyJoin('servers:cache-changed', {});
  });

  if (id) {
    gameWindowsById.set(id, win);
  }

  serverIdByWin.set(win, id || '');
  slowCache.watch(win, id || '');
  centerPromptsByWin.set(win, centerPromptsEnabled(payload.centerPrompts));
  promptHighlightByWin.set(win, promptHighlightEnabled(payload.promptHighlight));
  promptAutoRaiseByWin.set(win, promptAutoRaiseEnabled(payload.promptAutoRaise));
  promptGlowByWin.set(win, normalizePromptGlow(payload.promptGlow));
  promptGlowStrengthByWin.set(win, normalizePromptGlowStrength(payload.promptGlowStrength));
  installGameMenu(win);
  unburyCancelByWin.set(win, scheduleUnbury(win, undefined, () => keepGameWindowHome(win, ctx)));
  setTimeout(() => keepGameWindowHome(win, ctx), 0);
  setTimeout(() => keepGameWindowHome(win, ctx), 500);

  enablePopouts(win, gameSession, ctx);

  if (typeof deps.onGameWindowOpened === 'function') {
    deps.onGameWindowOpened(win, { layoutKey, sessionScoped: ctx.sessionScoped });
  }

  // A new document load (reload / disconnect / different world) starts over.
  win.webContents.on('did-navigate', (_event, url) => {
    // Foundry's /game load reports two navigations to the same document within
    // milliseconds; treat those as one load (kept in memory only, never logged).
    const now = Date.now();
    if (url === ctx.lastNavUrl && now - ctx.lastNavAt < 2000) return;
    ctx.lastNavUrl = url;
    ctx.lastNavAt = now;
    stopSnapshotLoop(ctx);
    ctx.loadSeq += 1;
    resetJoinGauges(win, ctx.loadSeq);
    try {
      win.webContents.executeJavaScript(
        'try{window.__flcLoadingVideo&&window.__flcLoadingVideo.destroy()}catch(e){}'
      ).catch(() => {});
    } catch { /* window may already be closing */ }
    ctx.restoring = false;
    ctx.restoreDone = false;
    ctx.lastSaved = '';
    noteGameNavigation(ctx, hubId, url);
    slowCache.onNavigation(win, typeof url === 'string' && /^https?:\/\//i.test(url) && !isJoinPageUrl(url));
  });

  const prefsAtOpen = readGpuPrefs(gpuPrefsPath);

  win.webContents.on('did-finish-load', async () => {
    let result;
    try {
      result = await win.webContents.executeJavaScript(WEBGL_PROBE_SCRIPT);
    } catch (err) {
      logWarn('[game-window] WebGL probe execution failed', {
        name: err && err.name ? err.name : 'Error',
      });
      result = { ok: false, reason: err && err.message ? err.message : 'WebGL probe failed' };
    }

    if (deps.hub && hubId && typeof deps.hub.setClient === 'function') {
      deps.hub.setClient(hubId, {
        webglMode: prefsAtOpen.preferSoftwareWebgl ? 'software' : 'hardware',
        webglFallbackReason: prefsAtOpen.lastFallbackReason
          ? (classifyWebglReason(prefsAtOpen.lastFallbackReason) || null)
          : null,
      });
    }

    if (result && result.ok === false && !prefsAtOpen.preferSoftwareWebgl) {
      handleProbeFailure(win, result.reason, gpuPrefsPath);
      return;
    }

    let pageUrl = '';
    try {
      pageUrl = win.webContents.getURL();
    } catch {
      pageUrl = '';
    }
    if (deps.hub && hubId && isJoinPageUrl(pageUrl)) deps.hub.mark(hubId, 'joinPageLoaded');
    const injected = await maybeAutologin(win, creds);
    if (injected && deps.hub && hubId) deps.hub.mark(hubId, 'autologinArmed');
    await applyCenterPrompts(win);
    await injectCapture(win);
    restoreSessionLayout(win, ctx).catch(() => {});
  });
  win.webContents.on('dom-ready', () => {
    slowCache.onDomReady(win);
    win.webContents.executeJavaScript(buildTelemetryScript()).then(() => {
      if (samplingByWin.get(win) === true && !win.isDestroyed()) {
        return setSampling(win, true, intervalByWin.get(win) || 5000);
      }
      return null;
    }).catch(() => {});

    // Plain decimal only, so the page call cannot carry anything but numbers.
    const bannerOn = typeof loadingBannerEnabled === 'function' ? loadingBannerEnabled() : true;
    let pushVideoJoin = function pushVideoJoin() {};
    const finiteScriptArg = (value) => {
      if (typeof value !== 'number' || !Number.isFinite(value)) return '0';
      const text = String(Math.round(value));
      return /^\d+$/.test(text) ? text : '0';
    };

    win.webContents.executeJavaScript(buildLoadingDetailsScript()).then(() => {
      try {
        if (!win || win.isDestroyed()) return null;
        const clockHubId = hubIdByWin.get(win);
        const serverId = serverIdByWin.get(win) || '';
        let elapsedMs = 0;
        let typicalMs = 0;
        let joins = 0;
        try {
          if (deps.hub && clockHubId && typeof deps.hub.snapshot === 'function') {
            const snap = deps.hub.snapshot(clockHubId);
            const startedAt = snap && snap.startedAt;
            if (typeof startedAt === 'number' && Number.isFinite(startedAt) && startedAt > 0) {
              const delta = Date.now() - startedAt;
              if (Number.isFinite(delta) && delta >= 0) elapsedMs = delta;
            }
          }
        } catch {
          elapsedMs = 0;
        }
        try {
          if (typeof serverId === 'string' && serverId && deps.joinHistory && typeof deps.joinHistory.list === 'function') {
            const rows = deps.joinHistory.list(serverId);
            if (Array.isArray(rows)) {
              joins = rows.length;
              const totals = [];
              for (let i = 0; i < rows.length; i += 1) {
                const total = rows[i] && rows[i].totalMs;
                if (typeof total === 'number' && Number.isFinite(total) && total >= 0) totals.push(total);
              }
              const med = percentile(totals, 50);
              if (typeof med === 'number' && Number.isFinite(med) && med > 0) typicalMs = med;
            }
          }
        } catch {
          typicalMs = 0;
          joins = 0;
        }
        const n1 = finiteScriptArg(elapsedMs);
        const n2 = finiteScriptArg(typicalMs);
        const n3 = finiteScriptArg(joins);
        pushVideoJoin = function pushVideoJoin() {
          if (!bannerOn || !win || win.isDestroyed()) return null;
          return win.webContents.executeJavaScript(
            'window.__flcLoadingVideo && window.__flcLoadingVideo.setJoin(' + n1 + ',' + n2 + ')'
          );
        };
        return win.webContents.executeJavaScript(
          'window.__flcLoadingDetails && window.__flcLoadingDetails.setJoin(' + n1 + ',' + n2 + ',' + n3 + ')'
        ).then(() => pushVideoJoin());
      } catch {
        return null;
      }
    }).catch(() => {});
    win.webContents.executeJavaScript(
      buildGaugesScript() + ';try{window.__flcGaugeSeq=' + scriptInt(ctx.loadSeq) + ';}catch(e){}'
    ).catch(() => {});
    if (bannerOn) {
      win.webContents.executeJavaScript(buildLoadingVideoScript()).then(() => {
        try { pushVideoJoin(); } catch { /* ignore */ }
      }).catch(() => {});
    }
  });
  win.webContents.on('page-title-updated', (event, title) => {
    event.preventDefault();
    if (typeof title === 'string' && title.trim()) {
      pageTitleByWin.set(win, title.trim().slice(0, 200));
    }
    applyWindowTitle(win);
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
 * The OS window that contains the prompt, plus the game window that owns the setting.
 * @param {import('electron').WebContents} contents
 * @returns {{ surface: import('electron').BrowserWindow, host: import('electron').BrowserWindow } | null}
 */
function windowForPrompt(contents) {
  const win = BrowserWindow.fromWebContents(contents);
  if (!win) return null;
  if (liveGameWindows.has(win)) return { surface: win, host: win };
  for (const parent of liveGameWindows) {
    const ctx = layoutCtxByWebContents.get(parent.webContents);
    if (ctx && ctx.popouts.has(win)) return { surface: win, host: parent };
  }
  return null;
}

/**
 * @param {import('electron').BrowserWindow} win
 * @returns {boolean}
 */
function promptNeedsRaise(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
  if (typeof win.isMinimized === 'function' && win.isMinimized()) return true;
  if (typeof win.isFocused === 'function' && win.isFocused()) return false;
  return true;
}

/**
 * @param {string} gpuPrefsPath
 * @param {Partial<typeof deps>} [integration]
 */
function registerGameIpc(gpuPrefsPath, integration) {
  Object.assign(deps, integration || {});

  ipcMain.handle('game:connect', (_event, payload) => openGameWindow(payload, gpuPrefsPath));

  ipcMain.handle('game:cache-info', (event, serverId) => getCacheInfo(gameWindowForCacheIpc(event, serverId)));

  ipcMain.handle('game:clear-cache', async (event, serverId) => {
    const bytes = await clearCache(gameWindowForCacheIpc(event, serverId));
    notifyJoin('servers:cache-changed', {});
    return bytes;
  });

  ipcMain.handle('game:forget-layout', async (_event, serverId) => {
    const id = String(serverId || '');
    const removed = forgetSessionLayout(id);
    const clearedBytes = await clearServerHttpCache(id);
    if (deps.joinHistory && id && typeof deps.joinHistory.forget === 'function') {
      try {
        deps.joinHistory.forget(id);
      } catch (err) {
        logWarn('[game-window] history forget failed', {
          error: err && err.name ? err.name : 'Error',
        });
      }
    }
    notifyJoin('servers:cache-changed', {});
    return { removed, clearedBytes };
  });

  // Preload asks for the probe source synchronously so it can run before page scripts.
  ipcMain.on('foundry:telemetry-script', (event) => {
    event.returnValue = hubIdByContents.has(event.sender) ? buildTelemetryScript() : '';
  });

  ipcMain.on('foundry:telemetry', (event, payload) => {
    const hubId = hubIdByContents.get(event.sender);
    if (!hubId || !deps.hub || typeof deps.hub.ingest !== 'function') return;
    deps.hub.ingest(hubId, payload);
    const kind = payload && typeof payload.type === 'string' ? payload.type : '';
    if (kind !== 'progress' && kind !== 'phase') return;
    let win = null;
    try {
      win = BrowserWindow.fromWebContents(event.sender);
    } catch {
      win = null;
    }
    if (!win || !liveGameWindows.has(win)) return;
    if (kind === 'phase' && payload.name === 'ready') {
      slowCache.onReady(win);
      // Final fill so the row reads 100%, then take it down with the overlay.
      pushGaugesNow(win);
      setTimeout(() => {
        if (win.isDestroyed()) return;
        win.webContents.executeJavaScript('window.__flcGauges&&window.__flcGauges.destroy()').catch(() => {});
      }, 1500);
      return;
    }
    scheduleGauges(win);
  });

  ipcMain.on('foundry:open-stats', (event) => {
    let win = null;
    try {
      win = BrowserWindow.fromWebContents(event.sender);
    } catch {
      win = null;
    }
    if (win && liveGameWindows.has(win)) openStatsFor(win);
  });

  ipcMain.on('foundry:autologin-status', (event, status) => {
    if (!status || status.submitted !== true) return;
    const hubId = hubIdByContents.get(event.sender);
    if (!hubId || !deps.hub || typeof deps.hub.mark !== 'function') return;
    deps.hub.mark(hubId, 'autologinSubmitted');
  });

  // Final snapshot sent by the page on pagehide (reload, disconnect, close).
  ipcMain.on('foundry:layout-snapshot', (event, raw) => {
    const ctx = layoutCtxByWebContents.get(event.sender);
    if (ctx) saveLayoutSnapshot(ctx, raw);
  });

  // A short-lived Foundry prompt opened. Raise that window, or flash it when auto-raise is off.
  ipcMain.on('foundry:prompt-attention', (event) => {
    const found = windowForPrompt(event.sender);
    if (!found) return;
    if (promptAutoRaiseByWin.get(found.host) !== false) {
      if (!promptNeedsRaise(found.surface)) return;
      if (unburyWindow(found.surface)) logInfo('[game-window] prompt raised');
      return;
    }
    if (requestUserAttention(found.surface)) logInfo('[game-window] user attention');
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

/**
 * @param {import('electron').BrowserWindow | null | undefined} win
 * @returns {boolean}
 */
function isGameWindow(win) {
  return Boolean(win) && liveGameWindows.has(win);
}

/**
 * Parent recorded for a popout, including one whose game window is already gone.
 * @param {import('electron').BrowserWindow | null | undefined} win
 * @returns {import('electron').BrowserWindow | null}
 */
function popoutParentOf(win) {
  if (!win) return null;
  if (popoutParentByWin.has(win)) return popoutParentByWin.get(win) || null;
  for (const parent of liveGameWindows) {
    const contents = parent && parent.webContents;
    const ctx = contents && layoutCtxByWebContents.get(contents);
    if (ctx && ctx.popouts && ctx.popouts.has(win)) return parent;
  }
  return null;
}

/**
 * @param {import('electron').BrowserWindow | null | undefined} win
 * @returns {boolean}
 */
function isPopoutWindow(win) {
  if (!win) return false;
  if (popoutParentByWin.has(win)) return true;
  return popoutParentOf(win) != null;
}

/**
 * Live game window that owns this popout, or null when it is not a popout
 * or the parent can no longer be used.
 * @param {import('electron').BrowserWindow | null | undefined} win
 * @returns {import('electron').BrowserWindow | null}
 */
function gameWindowForPopout(win) {
  const parent = popoutParentOf(win);
  if (parent && isGameWindow(parent)) return parent;
  return null;
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
  fullRefresh,
  getCacheInfo,
  clearCache,
  handleStatsGetContext,
  handleStatsGetSnapshot,
  handleStatsSetSampling,
  handleStatsCopyReport,
  handleStatsSaveDiagnostics,
  handleStatsFullRefresh,
  handleStatsBadUrls,
  handleStatsCopyBadUrls,
  windowForServer,
  noteGpuProcessGone,
  noteCertificateError,
  isGameWindow,
  gameWindowForPopout,
  isPopoutWindow,
  menuPlacement,
  loadingBannerEnabled,
};
