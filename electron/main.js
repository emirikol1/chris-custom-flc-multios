const { app, BrowserWindow, clipboard, dialog, ipcMain, net, protocol, shell, session, screen } = require('electron');
const { registerMediaSchemes, attachMediaProtocol } = require('./media-protocol');

registerMediaSchemes(protocol);
const fs = require('fs');
const path = require('path');
const {
  getGpuPrefsPath,
  getServersPath,
  getAppPrefsPath,
  getAiProviderPath,
  getWindowStatePath,
  getNarratorRoot,
  getDataDir,
} = require('./paths');
const { readGpuPrefs } = require('./gpu-prefs');
const { browserLikeUserAgent } = require('./user-agent');
const { APP_VERSION } = require('./app-version');
const { PROJECT_PAGE, launchProjectPage } = require('./project-link');

const gpuPrefsPath = getGpuPrefsPath();
const gpuPrefsAtStartup = readGpuPrefs(gpuPrefsPath);

const {
  logInfo,
  logError,
  logWarn,
  logDebug,
  registerRendererLogIpc,
} = require('./logger');

app.commandLine.appendSwitch('class', 'ChrisCustomFLCMultiOS');

// Present as plain Chrome: Foundry's PopOut! module refuses to open windows
// when it sees " Electron/" in navigator.userAgent. Applies to every session
// (game windows, popouts, hidden Get Users window) created after this point.
app.userAgentFallback = browserLikeUserAgent(app.userAgentFallback, app.name);

if (gpuPrefsAtStartup.preferSoftwareWebgl) {
  app.commandLine.appendSwitch('enable-unsafe-swiftshader');
  app.commandLine.appendSwitch('use-gl', 'angle');
  app.commandLine.appendSwitch('use-angle', 'swiftshader');
  logInfo('[main] Software WebGL (SwiftShader) enabled from gpu-prefs');
}

const { chooseDiskCache, diskCacheSwitchValue } = require('./cache-policy');
const diskCache = chooseDiskCache(getDataDir());
app.commandLine.appendSwitch('disk-cache-size', diskCacheSwitchValue(diskCache.limitBytes));

const {
  loadServers,
  saveServers,
  ensureServersFile,
  addServer,
  updateServer,
  deleteServer,
  listServers,
  clearPromptAppearance,
} = require('./store');
const { readAppPrefs, writeAppPrefs } = require('./app-prefs');
const { fetchJoinPageUsers } = require('./foundry-users');
const { fetchUsersViaHiddenWindow } = require('./foundry-users-window');
const {
  PRESETS,
  getPreset,
  readProviderConfig,
  writeProviderConfig,
  publicProviderConfig,
  loadProvider,
  testConnection,
} = require('./ai-provider');
const {
  createWindowStateStore,
  readStates: readWindowStates,
  writeStates: writeWindowStates,
} = require('./window-state');
const { buildExport, parseImport, mergeServers } = require('./settings-transfer');
const { isKnownPromptGlow, normalizePromptGlowStrength } = require('./center-prompts');
const { loadSettings: loadNarratorSettings } = require('./narrator-store');
const {
  openServerConfigWindow,
  getServerConfigContext,
  closeServerConfigWindow,
} = require('./server-config-window');
const {
  flushSessionLayoutsForQuit,
  registerGameIpc,
  injectCaptureIntoLiveWindows,
  runInLiveGameWindows,
  hasLiveGameWindows,
  getAutologinContext,
  handleStatsGetContext,
  handleStatsGetSnapshot,
  handleStatsSetSampling,
  handleStatsCopyReport,
  handleStatsSaveDiagnostics,
  handleStatsFullRefresh,
  handleStatsBadUrls,
  handleStatsCopyBadUrls,
  noteGpuProcessGone,
  noteCertificateError,
  isGameWindow,
  gameWindowForPopout,
  isPopoutWindow,
  menuPlacement,
  windowForServer,
} = require('./game-window');
const { registerNetTraceIpc } = require('./net-trace-ipc');
const { createJoinHistory } = require('./join-history');
const { initSlowCache } = require('./slow-cache-runtime');
const { createProblemLog } = require('./problem-log');
const { createIssueAckStore } = require('./issue-acks');
const { createSessionGuard, attach: attachSessionGuard, note: noteSessionCause } = require('./session-guard');
const { createCrashReport, attach: attachCrashReports, writeCrash } = require('./crash-report');
const { createMachineBaseline } = require('./machine-baseline');
const { createTelemetryHub } = require('./telemetry-hub');
const { detectIssues, DEFAULT_THRESHOLDS } = require('./issue-detector');
const { collectSystemInfo } = require('./system-info');
const { createNarratorService } = require('./narrator-service');
const { mudToAnsi, mudToHtml } = require('./mud-color');
const {
  sendNarratorLine,
  sendNarratorStatus,
  ensureNarratorWindow,
  closeNarratorWindow,
} = require('./narrator-window');
const {
  buildCaptureSource,
  FOUNDRY_POST_SOURCE,
  describeTokenMove,
  sanitizeChatLine,
} = require('./foundry-chat-bridge');
const { loadScoreboard } = require('./combat-stats');

const serversFilePath = getServersPath();

const joinHistory = createJoinHistory({
  filePath: path.join(getDataDir(), 'join-history.json'),
  log: {
    warn: (name) => logWarn('[join-history] failed', { error: name }),
  },
});

initSlowCache({
  filePath: path.join(getDataDir(), 'slow-cache-notice.json'),
  logInfo,
  clipboard,
  notify() {
    sendToJoinWindow('slowcache:updated', {});
  },
});

try {
  fs.unlinkSync(path.join(app.getPath('userData'), 'asset-cache-state.json'));
} catch {
  /* stale state file is already gone */
}

const problemLog = createProblemLog({
  filePath: path.join(getDataDir(), 'problem-log.jsonl'),
  clientVersion: APP_VERSION,
  log: {
    warn: (msg, extra) => logWarn(msg, extra),
  },
});

const machineBaseline = createMachineBaseline({
  filePath: path.join(getDataDir(), 'machine-baseline.json'),
});

/** @type {{ causes: string[], client: string, reported?: boolean } | null} */
let previousCrashInfo = null;
/** @type {ReturnType<typeof createSessionGuard> | null} */
let sessionGuard = null;

const telemetryHub = createTelemetryHub({
  log: { info: logInfo, debug: logDebug, warn: logWarn },
  history: joinHistory,
  detector: detectIssues,
  thresholds: DEFAULT_THRESHOLDS,
  problemLog,
  previousCrash: () => previousCrashInfo,
});

const issueAcks = createIssueAckStore({
  filePath: path.join(getDataDir(), 'issue-acks.json'),
});

const crashReports = createCrashReport({
  filePath: path.join(getDataDir(), 'crash-reports.jsonl'),
  client: APP_VERSION,
});

/** @type {Promise<object | null> | null} */
let systemInfoPromise = null;

function getSystemInfo() {
  if (!systemInfoPromise) {
    systemInfoPromise = collectSystemInfo({
      app,
      screen,
      gpuPrefs: readGpuPrefs(gpuPrefsPath),
      clientVersion: APP_VERSION,
    }).catch((err) => {
      systemInfoPromise = null;
      logWarn('[main] system info failed', { error: err && err.name ? err.name : 'Error' });
      return null;
    });
  }
  return systemInfoPromise;
}
const appPrefsPath = getAppPrefsPath();
const aiProviderPath = getAiProviderPath();
const narratorRoot = getNarratorRoot();
const pkg = require('../package.json');
const { checkForAppUpdate, publicApprovalCommands } = require('./app-update');

const windowState = createWindowStateStore({ filePath: getWindowStatePath() });

/** @type {import('electron').BrowserWindow | null} */
let joinWindow = null;

function isMudEnabled() {
  return readAppPrefs(appPrefsPath).mudEnabled;
}

/**
 * Posts using Foundry's own ChatMessage.create / processMessage in the game page.
 * @param {{ content: string, speakAs: string, alias: string }} payload
 */
async function postMudToFoundryChat(payload) {
  const json = JSON.stringify(payload);
  await runInLiveGameWindows(`(${FOUNDRY_POST_SOURCE})(${json})`);
}

const narratorService = createNarratorService({
  rootDir: narratorRoot,
  credsLoader: () => loadProvider(aiProviderPath),
  postToFoundry: postMudToFoundryChat,
});

process.on('uncaughtException', (err) => {
  noteSessionCause('uncaught-exception', err && err.name);
  writeCrash({
    kind: 'uncaught-exception',
    errorName: err && err.name,
    message: err && err.message,
    stack: err && err.stack,
  });
  logError('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  const err = reason instanceof Error ? reason : null;
  noteSessionCause('unhandled-rejection', err && err.name);
  writeCrash({
    kind: 'unhandled-rejection',
    errorName: err ? err.name : 'Error',
    message: err ? err.message : (typeof reason === 'string' ? reason : ''),
    stack: err ? err.stack : '',
  });
  logError('unhandledRejection', { name: reason && reason.name ? reason.name : typeof reason });
});

function sendToJoinWindow(channel, payload) {
  if (joinWindow && !joinWindow.isDestroyed()) {
    joinWindow.webContents.send(channel, payload);
  }
}

/**
 * Persist one server-profile choice. A missing server id is session-only.
 * @param {string} serverId
 * @param {Record<string, unknown>} patch
 * @param {string} label
 */
function saveServerChoice(serverId, patch, label) {
  if (!serverId) return;
  if (Object.prototype.hasOwnProperty.call(patch, 'promptGlow') && !isKnownPromptGlow(patch.promptGlow)) return;
  try {
    ensureServersFile(serversFilePath);
    const servers = loadServers(serversFilePath);
    if (!servers.some((s) => s.id === serverId)) return;
    const next = updateServer(servers, serverId, patch);
    saveServers(serversFilePath, next);
    sendToJoinWindow('servers:changed', {});
    logInfo(`[main] ${label}`);
  } catch (err) {
    logWarn('[main] server choice save failed', {
      error: err && err.name ? err.name : 'Error',
    });
  }
}

function registerServerIpc() {
  ipcMain.handle('servers:list', () => {
    ensureServersFile(serversFilePath);
    const servers = loadServers(serversFilePath);
    return listServers(servers);
  });

  ipcMain.handle('servers:add', (_event, data) => {
    ensureServersFile(serversFilePath);
    const servers = loadServers(serversFilePath);
    const next = addServer(servers, data);
    saveServers(serversFilePath, next);
    sendToJoinWindow('servers:changed', {});
    return listServers(next);
  });

  ipcMain.handle('servers:update', (_event, id, patch) => {
    ensureServersFile(serversFilePath);
    const servers = loadServers(serversFilePath);
    const next = updateServer(servers, id, patch);
    saveServers(serversFilePath, next);
    sendToJoinWindow('servers:changed', {});
    return listServers(next);
  });

  ipcMain.handle('servers:get-users', async (_event, url, serverId) => {
    const started = Date.now();
    // Fast path: server-rendered join page (older Foundry). Uses Chromium's
    // network stack so certificate handling matches the game window.
    let result = await fetchJoinPageUsers(String(url || ''), {
      fetchImpl: (input, init) => net.fetch(input, init),
    });
    if (!result.ok && result.error === 'no_users') {
      // Foundry V12+ renders the user list client-side: load it in a hidden window.
      result = await fetchUsersViaHiddenWindow(String(url || ''), {
        partition: serverId ? `persist:game-${serverId}` : undefined,
      });
    }
    logInfo(
      `[main] get-users ok=${result.ok ? 1 : 0}${result.ok ? ` count=${result.users.length}` : ` error=${result.error}`} (${Date.now() - started}ms)`,
    );
    return result;
  });

  ipcMain.handle('servers:delete', (_event, id) => {
    ensureServersFile(serversFilePath);
    const servers = loadServers(serversFilePath);
    const next = deleteServer(servers, id);
    saveServers(serversFilePath, next);
    sendToJoinWindow('servers:changed', {});
    return listServers(next);
  });
}

function registerServerConfigIpc() {
  ipcMain.handle('server-config:open', (_event, mode, id) => {
    const m = mode === 'edit' || mode === 'clone' ? mode : 'add';
    let server = null;
    if (m !== 'add') {
      ensureServersFile(serversFilePath);
      server = loadServers(serversFilePath).find((s) => s.id === String(id)) || null;
      if (!server) return { ok: false, error: 'not_found' };
    }
    openServerConfigWindow({ mode: m, server }, { windowState, parent: joinWindow });
    return { ok: true };
  });
  ipcMain.handle('server-config:get-context', () => getServerConfigContext());
  ipcMain.on('server-config:close', () => closeServerConfigWindow());
}

function applyMudEnabled(enabled) {
  if (enabled) {
    if (hasLiveGameWindows()) {
      ensureNarratorWindow(windowState);
      injectCaptureIntoLiveWindows();
    }
    const provider = loadProvider(aiProviderPath);
    if (!provider.ok) {
      sendNarratorStatus({ text: 'AI server not set up — press Setup' });
    }
  } else {
    closeNarratorWindow();
  }
}

function registerPrefsIpc() {
  ipcMain.handle('prefs:get', () => readAppPrefs(appPrefsPath));
  ipcMain.handle('prefs:set', (_event, patch) => {
    const before = readAppPrefs(appPrefsPath);
    const next = writeAppPrefs(appPrefsPath, patch || {});
    if (before.mudEnabled !== next.mudEnabled) {
      logInfo(`[main] mudEnabled=${next.mudEnabled ? 1 : 0}`);
      applyMudEnabled(next.mudEnabled);
    }
    return next;
  });
}

function registerAiIpc() {
  ipcMain.handle('ai:get-presets', () => PRESETS);
  ipcMain.handle('ai:get-settings', () =>
    publicProviderConfig(readProviderConfig(aiProviderPath)),
  );
  ipcMain.handle('ai:save-settings', (_event, cfg) => {
    const saved = writeProviderConfig(aiProviderPath, cfg || {});
    logInfo(`[main] AI provider saved (preset=${saved.preset})`);
    if (isMudEnabled()) {
      sendNarratorStatus({ text: 'AI server ready' });
    }
    return publicProviderConfig(saved);
  });
  ipcMain.handle('ai:test-connection', async (_event, cfg) => {
    const input = cfg || {};
    // undefined apiKey means "use the saved one" so the user can test without re-typing it.
    if (input.apiKey === undefined) {
      input.apiKey = readProviderConfig(aiProviderPath).apiKey;
    }
    const started = Date.now();
    const result = await testConnection(input);
    logInfo(
      `[main] AI test-connection ok=${result.ok ? 1 : 0}${result.ok ? '' : ` error=${result.error}`} (${Date.now() - started}ms)`,
    );
    return result;
  });
  ipcMain.handle('ai:open-signup', (_event, presetId) => {
    const preset = getPreset(String(presetId || ''));
    if (preset && /^https:\/\//.test(preset.signupUrl || '')) {
      return shell.openExternal(preset.signupUrl);
    }
    return undefined;
  });
}

function registerSettingsTransferIpc() {
  const filters = [{ name: 'FLC settings (JSON)', extensions: ['json'] }];

  ipcMain.handle('settings:export', async () => {
    const parent = joinWindow && !joinWindow.isDestroyed() ? joinWindow : undefined;
    const pick = await dialog.showSaveDialog(parent, {
      title: 'Export FLC settings',
      defaultPath: path.join(app.getPath('documents'), `flc-settings-${isoDateStamp()}.json`),
      filters,
    });
    if (pick.canceled || !pick.filePath) return { ok: false, canceled: true };
    try {
      ensureServersFile(serversFilePath);
      const bundle = buildExport({
        servers: loadServers(serversFilePath),
        aiProvider: readProviderConfig(aiProviderPath),
        appPrefs: readAppPrefs(appPrefsPath),
        narratorSettings: loadNarratorSettings(narratorRoot),
        windowState: readWindowStates(getWindowStatePath()),
        appVersion: APP_VERSION,
      });
      // Contains credentials (server passwords, API key): owner-only file.
      fs.writeFileSync(pick.filePath, JSON.stringify(bundle, null, 2), { mode: 0o600 });
      logInfo(`[main] settings exported (servers=${bundle.servers.length})`);
      return { ok: true, servers: bundle.servers.length };
    } catch (err) {
      logError('[main] settings export failed', err);
      return { ok: false, error: 'write_failed' };
    }
  });

  ipcMain.handle('settings:import', async () => {
    const parent = joinWindow && !joinWindow.isDestroyed() ? joinWindow : undefined;
    const pick = await dialog.showOpenDialog(parent, {
      title: 'Import FLC settings',
      properties: ['openFile'],
      filters,
    });
    if (pick.canceled || !pick.filePaths || !pick.filePaths[0]) {
      return { ok: false, canceled: true };
    }
    let text;
    try {
      text = fs.readFileSync(pick.filePaths[0], 'utf8');
    } catch (err) {
      logError('[main] settings import read failed', err);
      return { ok: false, error: 'read_failed' };
    }
    const parsed = parseImport(text);
    if (!parsed.ok) {
      logInfo(`[main] settings import rejected: ${parsed.error}`);
      return { ok: false, error: parsed.error };
    }
    const b = parsed.bundle;
    /** @type {{ ok: true, servers: { added: number, updated: number, skipped: number }, applied: string[] }} */
    const summary = { ok: true, servers: { added: 0, updated: 0, skipped: 0 }, applied: [] };
    try {
      if (b.servers) {
        ensureServersFile(serversFilePath);
        const merged = mergeServers(loadServers(serversFilePath), b.servers);
        saveServers(serversFilePath, merged.servers);
        summary.servers = { added: merged.added, updated: merged.updated, skipped: merged.skipped };
        summary.applied.push('servers');
      }
      if (b.aiProvider) {
        // Explicit apiKey (even empty) replaces; missing keeps the current one.
        writeProviderConfig(aiProviderPath, b.aiProvider);
        summary.applied.push('aiProvider');
      }
      if (b.narratorSettings) {
        narratorService.setSettings(b.narratorSettings);
        summary.applied.push('narratorSettings');
      }
      if (b.windowState) {
        writeWindowStates(getWindowStatePath(), {
          ...readWindowStates(getWindowStatePath()),
          ...b.windowState,
        });
        summary.applied.push('windowState');
      }
      if (b.appPrefs) {
        const before = readAppPrefs(appPrefsPath);
        const next = writeAppPrefs(appPrefsPath, b.appPrefs);
        if (before.mudEnabled !== next.mudEnabled) applyMudEnabled(next.mudEnabled);
        summary.applied.push('appPrefs');
      }
    } catch (err) {
      logError('[main] settings import apply failed', err);
      return { ok: false, error: 'apply_failed', partial: summary.applied };
    }
    logInfo(
      `[main] settings imported (${summary.applied.join(',')}; servers +${summary.servers.added} ~${summary.servers.updated} !${summary.servers.skipped})`,
    );
    return summary;
  });
}

function isoDateStamp() {
  return new Date().toISOString().slice(0, 10);
}

function registerNarratorIpc() {
  ipcMain.handle('narrator:ask', async (_event, text) => {
    const result = await narratorService.handleUserQuestion(text);
    if (!result.ok) {
      sendNarratorStatus({ text: result.message || 'ask failed' });
      return { ok: false, message: result.message };
    }
    return {
      ok: true,
      text: result.text,
      html: mudToHtml(result.text),
      ansi: mudToAnsi(result.text),
    };
  });
  ipcMain.handle('narrator:get-settings', () => narratorService.getSettings());
  ipcMain.handle('narrator:set-post-to-foundry', (_event, enabled) =>
    narratorService.setPostToFoundry(enabled),
  );
  ipcMain.handle('narrator:set-settings', (_event, patch) =>
    narratorService.setSettings(patch),
  );
  ipcMain.on('narrator:open-setup', () => {
    if (joinWindow && !joinWindow.isDestroyed()) {
      joinWindow.show();
      joinWindow.focus();
      sendToJoinWindow('mud:open-setup', {});
    }
  });

  ipcMain.on('foundry:autologin-status', (event, status) => {
    const ctx = getAutologinContext(event.sender) || { username: '', label: '' };
    const matched = Boolean(status && status.matched);
    logInfo(`[autologin] matched=${matched ? 1 : 0}${status && status.error ? ` error=${status.error}` : ''}`);
    sendToJoinWindow('autologin:status', {
      matched,
      userCount: status && status.userCount,
      error: status && status.error,
      username: ctx.username,
      label: ctx.label,
    });
  });

  let chatQueue = Promise.resolve();
  /** @type {Array<{ speaker: string, text: string, kind: string }>} */
  let historyBuffer = [];
  /** @type {ReturnType<typeof setTimeout> | null} */
  let historyTimer = null;
  let capturedCount = 0;

  function pushMud(mudText, source) {
    sendNarratorLine({
      channel: 'commentary',
      html: mudToHtml(mudText),
      ansi: mudToAnsi(mudText),
      byline: source === 'foundry' ? '' : narratorService.getSettings().localByline,
      source,
    });
  }

  function flushHistoryRecap() {
    const batch = historyBuffer;
    historyBuffer = [];
    historyTimer = null;
    if (batch.length === 0) {
      return;
    }
    sendNarratorStatus({ text: `rewriting Foundry log in MUD voice · ${batch.length} lines` });
    chatQueue = chatQueue
      .then(async () => {
        const recap = await narratorService.handleHistoryRecap(batch, (mudText) => {
          pushMud(mudText, 'mud');
        });
        if (!recap.ok) {
          sendNarratorStatus({ text: recap.message || 'AI server error' });
        } else {
          sendNarratorStatus({ text: `watching chat · ${capturedCount} loaded` });
        }
      })
      .catch(() => {
        sendNarratorStatus({ text: 'AI server error' });
      });
  }

  ipcMain.on('foundry:capture-status', (_event, payload) => {
    if (!isMudEnabled()) return;
    const hooked = Boolean(payload && payload.hooked);
    const historical = Number(payload && payload.historical) || 0;
    logInfo(`[narrator] capture hooked=${hooked ? 1 : 0} historical=${historical}`);
    sendNarratorStatus({
      text: hooked
        ? `watching chat · ${historical} loaded from Foundry`
        : 'chat hook not ready',
    });
  });

  ipcMain.on('foundry:token-move', (_event, payload) => {
    if (!isMudEnabled()) return;
    const mud = describeTokenMove(payload || {});
    if (!mud) {
      return;
    }
    pushMud(mud, 'move');
  });

  ipcMain.on('foundry:chat-line', (_event, payload) => {
    if (!isMudEnabled()) return;
    chatQueue = chatQueue
      .then(async () => {
        const sanitized = sanitizeChatLine(payload);
        if (!sanitized) {
          return;
        }
        capturedCount += 1;
        sendNarratorStatus({
          text: payload && payload.historical
            ? `rewriting Foundry log in MUD voice · ${capturedCount} loaded`
            : `watching chat · last ${sanitized.kind} · ${capturedCount} lines`,
        });

        if (payload && payload.historical) {
          historyBuffer.push({
            speaker: sanitized.speaker,
            text: sanitized.text,
            kind: sanitized.kind,
            id: payload && payload.id,
            timestamp: payload && payload.timestamp,
          });
          if (historyTimer) {
            clearTimeout(historyTimer);
          }
          historyTimer = setTimeout(flushHistoryRecap, 800);
          return;
        }

        const result = await narratorService.handleFoundryLine(payload);
        if (result.ok && result.mudText) {
          pushMud(result.mudText, 'mud');
        } else if (!result.ok) {
          sendNarratorStatus({ text: result.message || 'AI server error' });
        }
      })
      .catch(() => {
        sendNarratorStatus({ text: 'chat capture error' });
      });
  });
}

function createWindow() {
  const bounds = windowState.restore('join', { width: 900, height: 600 });
  const win = new BrowserWindow({
    width: bounds.width,
    height: bounds.height,
    x: bounds.x,
    y: bounds.y,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      spellcheck: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });
  if (bounds.maximized) {
    win.maximize();
  }
  windowState.track(win, 'join');
  joinWindow = win;
  const openProjectPage = () => {
    shell.openExternal(PROJECT_PAGE).catch((err) => {
      logWarn('[main] project page failed', { error: err && err.name ? err.name : 'Error' });
    });
  };
  win.webContents.on('will-navigate', (event, target) => {
    event.preventDefault();
    launchProjectPage(target, openProjectPage);
  });
  win.webContents.setWindowOpenHandler((details) => {
    launchProjectPage(details && details.url, openProjectPage);
    return { action: 'deny' };
  });

  logInfo('Join-list window opened');

  win.on('closed', () => {
    logInfo('Join-list window closed');
    if (joinWindow === win) {
      joinWindow = null;
    }
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

registerServerIpc();
registerRendererLogIpc(ipcMain);
registerPrefsIpc();
registerAiIpc();
registerSettingsTransferIpc();
registerServerConfigIpc();
registerGameIpc(gpuPrefsPath, {
  windowState,
  isMudEnabled,
  buildCaptureScript: () => buildCaptureSource(loadScoreboard(narratorRoot)),
  setCenterPrompts: (serverId, enabled) => {
    saveServerChoice(serverId, { centerPrompts: enabled === true }, `centerPrompts=${enabled === true ? 1 : 0}`);
  },
  setPromptHighlight: (serverId, enabled) => {
    saveServerChoice(serverId, { promptHighlight: enabled === true }, `promptHighlight=${enabled === true ? 1 : 0}`);
  },
  setPromptAutoRaise: (serverId, enabled) => {
    saveServerChoice(serverId, { promptAutoRaise: enabled === true }, `promptAutoRaise=${enabled === true ? 1 : 0}`);
  },
  setPromptGlow: (serverId, glow) => {
    saveServerChoice(serverId, { promptGlow: glow }, 'promptGlow');
  },
  setPromptGlowStrength: (serverId, strength) => {
    const n = normalizePromptGlowStrength(strength);
    saveServerChoice(serverId, { promptGlowStrength: n }, `promptGlowStrength=${n}`);
  },
  getDiskCache: () => ({ limitBytes: diskCache.limitBytes, mode: diskCache.mode }),
  hub: telemetryHub,
  joinHistory,
  appPrefs: { get: () => readAppPrefs(appPrefsPath) },
  machineBaseline,
  getSystemInfo,
  notifyJoinWindow: sendToJoinWindow,
  forgetPromptAppearance: (serverId) => {
    if (!serverId) return false;
    try {
      ensureServersFile(serversFilePath);
      const servers = loadServers(serversFilePath);
      const result = clearPromptAppearance(servers, serverId);
      if (!result.changed) return false;
      saveServers(serversFilePath, result.servers);
      sendToJoinWindow('servers:changed', {});
      logInfo('[main] prompt appearance reset');
      return true;
    } catch (err) {
      logWarn('[main] prompt appearance reset failed', {
        error: err && err.name ? err.name : 'Error',
      });
      return false;
    }
  },
  onGameWindowOpened: (_win, info) => {
    if (isMudEnabled()) {
      const mudWin = ensureNarratorWindow(windowState, info && info.layoutKey);
      if (!loadProvider(aiProviderPath).ok && mudWin) {
        const notify = () => sendNarratorStatus({ text: 'AI server not set up — press Setup' });
        if (mudWin.webContents.isLoading()) {
          mudWin.webContents.once('did-finish-load', notify);
        } else {
          notify();
        }
      }
    }
  },
});
registerNarratorIpc();

ipcMain.handle('stats:get-context', (event) => handleStatsGetContext(event.sender));
ipcMain.handle('stats:get-snapshot', (_event, serverId) => handleStatsGetSnapshot(serverId));
ipcMain.handle('stats:set-sampling', (_event, serverId, enabled, intervalMs) => (
  handleStatsSetSampling(serverId, enabled === true, intervalMs)
));
ipcMain.handle('stats:copy-report', (_event, serverId, opts) => handleStatsCopyReport(serverId, opts));
ipcMain.handle('stats:save-diagnostics', (_event, serverId) => handleStatsSaveDiagnostics(serverId));
ipcMain.handle('stats:full-refresh', (_event, serverId) => handleStatsFullRefresh(serverId));
ipcMain.handle('stats:list-issue-acks', (_event, serverId) => issueAcks.list(serverId));
ipcMain.handle('stats:ack-issue', (_event, serverId, findingId) => issueAcks.ack(serverId, findingId));
ipcMain.handle('stats:release-issue', (_event, serverId, findingId) => issueAcks.release(serverId, findingId));
ipcMain.handle('stats:bad-urls', (_event, serverId) => handleStatsBadUrls(serverId));
ipcMain.handle('stats:copy-bad-urls', (_event, serverId) => handleStatsCopyBadUrls(serverId));
const { createAdminContactHandlers } = require('./admin-contact');
const { formatBadUrlsText } = require('./bad-urls');
const { buildTroubleshootingReport } = require('./ts-report');
const { formatJoinSummary } = require('./join-telemetry');
const adminContact = createAdminContactHandlers({
  serversFilePath,
  loadServers,
  saveServers,
  ensureServersFile,
  windowForServer,
  getSnapshot: handleStatsGetSnapshot,
  getBadUrls: handleStatsBadUrls,
  formatBadUrlsText,
  buildReport: buildTroubleshootingReport,
  formatJoinSummary,
  clipboard,
  openExternal: (url) => shell.openExternal(url),
  clientVersion: APP_VERSION,
  onSaved: () => sendToJoinWindow('servers:changed', {}),
  logWarn,
});
ipcMain.handle('stats:get-admin-email', (_event, serverId) => adminContact.getAdminEmail(serverId));
ipcMain.handle('stats:set-admin-email', (_event, serverId, email) => adminContact.setAdminEmail(serverId, email));
ipcMain.handle('stats:email-admin', (_event, serverId) => adminContact.emailAdmin(serverId));
registerNetTraceIpc({
  ipcMain,
  clipboard,
  windowForServer,
  getServerHost(serverId) {
    if (typeof serverId !== 'string' || !serverId) return null;
    let servers;
    try {
      servers = loadServers(serversFilePath);
    } catch {
      return null;
    }
    const server = Array.isArray(servers) ? servers.find((row) => row && row.id === serverId) : null;
    if (!server || typeof server.url !== 'string') return null;
    let parsed;
    try {
      parsed = new URL(server.url);
    } catch {
      return null;
    }
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') return null;
    const host = parsed.hostname;
    if (!host) return null;
    const port = parsed.port ? Number(parsed.port) : (parsed.protocol === 'https:' ? 443 : 80);
    if (!Number.isInteger(port) || port < 1 || port > 65535) return null;
    const { shortServerHash } = require('./log-ids');
    return { host, port, serverHash: shortServerHash(serverId) };
  },
});
ipcMain.handle('servers:cache-info', async () => {
  const out = {};
  try {
    const servers = loadServers(serversFilePath);
    const rows = Array.isArray(servers) ? servers : [];
    await Promise.all(rows.map(async (server) => {
      const id = server && typeof server.id === 'string' ? server.id : '';
      if (!id) return;
      let cacheBytes = null;
      let objects = null;
      try {
        const gameSession = session.fromPartition(`persist:game-${id}`);
        const size = await gameSession.getCacheSize();
        cacheBytes = typeof size === 'number' && Number.isFinite(size) ? size : null;
      } catch {
        cacheBytes = null;
      }
      try {
        const history = joinHistory.list(id);
        const last = history.length ? history[history.length - 1] : null;
        const requests = last && last.requests;
        objects = typeof requests === 'number' && Number.isFinite(requests) ? requests : null;
      } catch {
        objects = null;
      }
      out[id] = { cacheBytes, objects };
    }));
  } catch (err) {
    logWarn('[main] cache info failed', { error: err && err.name ? err.name : 'Error' });
  }
  return out;
});

app.on('child-process-gone', (_event, details) => {
  if (!details || details.type !== 'GPU') return;
  const reason = typeof details.reason === 'string' && details.reason ? details.reason : 'unknown';
  noteSessionCause('gpu-process-gone', reason);
  writeCrash({
    kind: 'gpu-process-gone',
    reason,
    exitCode: details && details.exitCode,
  });
  logWarn('[main] gpu process gone', { reason });
  noteGpuProcessGone();
});

app.on('certificate-error', (_event, webContents, _url, error) => {
  const name = typeof error === 'string' && error ? error : 'ERR_CERT';
  noteCertificateError(webContents, name);
});

ipcMain.handle('app:get-version', () => APP_VERSION);

function registerUpdateIpc() {
  async function runAppUpdate(download) {
    let osRelease = '';
    if (process.platform === 'linux') {
      try {
        osRelease = fs.readFileSync('/etc/os-release', 'utf8');
      } catch {
        osRelease = '';
      }
    }
    const result = await checkForAppUpdate({
      currentVersion: APP_VERSION,
      platform: process.platform,
      osRelease,
      downloadsDir: app.getPath('downloads'),
      download: download === true,
    });
    if (result.status === 'downloaded') logInfo('[update] installer saved');
    else if (result.status === 'current' || result.status === 'ahead' || result.status === 'available') {
      logInfo(`[update] ${result.status}`);
    } else logWarn(download ? '[update] download failed' : '[update] check failed');
    const payload = {
      status: result.status,
      message: result.message,
      version: result.version,
      fileName: result.fileName,
    };
    if (result.status === 'downloaded') {
      payload.approvalCommands = publicApprovalCommands(result.approvalCommands);
    }
    return payload;
  }

  ipcMain.handle('app:check-update', () => runAppUpdate(false));
  ipcMain.handle('app:download-update', () => runAppUpdate(true));
}
registerUpdateIpc();

app.on('browser-window-focus', (_event, win) => {
  if (isGameWindow(win)) {
    menuPlacement.onFocus(win);
    return;
  }
  const parent = gameWindowForPopout(win);
  if (parent) {
    menuPlacement.onFocus(parent);
    return;
  }
  if (isPopoutWindow(win)) return;
  menuPlacement.setPlain();
});

app.whenReady().then(() => {
  try {
    sessionGuard = createSessionGuard({
      filePath: path.join(getDataDir(), 'session-state.json'),
      client: APP_VERSION,
    });
    attachSessionGuard(sessionGuard);
    attachCrashReports(crashReports, () => sessionGuard.markReported());
    if (sessionGuard.previous) {
      const causes = sessionGuard.previous.causes.length ? sessionGuard.previous.causes : ['unclean-exit'];
      previousCrashInfo = {
        causes,
        client: sessionGuard.previous.client,
        reported: sessionGuard.previous.reported === true,
      };
      const evidence = causes.map((cause) => `cause=${cause}`).join(' ');
      problemLog.recordEvent({
        id: 'app-crashed',
        category: 'client',
        severity: 'error',
        title: 'Previous session ended unexpectedly',
        evidence,
        serverHash: 'srv:none',
      });
    }
  } catch (err) {
    logWarn('[main] session guard failed', { error: err && err.name ? err.name : 'Error' });
  }
  try {
    attachMediaProtocol(protocol);
  } catch (err) {
    logWarn('[main] media protocol failed', { error: err && err.name ? err.name : 'Error' });
  }
  menuPlacement.setPlain();
  ensureServersFile(serversFilePath);
  const gpuMode = gpuPrefsAtStartup.preferSoftwareWebgl ? 'software' : 'hardware';
  const cacheMb = Math.round(diskCache.limitBytes / (1024 * 1024));
  logInfo(`Starting ${pkg.name} v${APP_VERSION} (GPU mode: ${gpuMode}, mud: ${isMudEnabled() ? 'on' : 'off'}, cache: ${cacheMb} MB (${diskCache.mode}))`);

  createWindow();

  // Machine speed is learned from observed join work (join history). The
  // micro-benchmark is only a fallback before any join has been recorded.
  setTimeout(() => {
    try {
      const hasHistory = Object.keys(joinHistory.all() || {}).length > 0;
      if (hasHistory || machineBaseline.get()) return;
      machineBaseline.refresh();
    } catch (err) {
      logWarn('[main] baseline refresh failed', { error: err && err.name ? err.name : 'Error' });
    }
  }, 3000);

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    app.quit();
  }
});

let quitLayoutFlushed = false;
app.on('before-quit', (event) => {
  try {
    problemLog.closeAll('quit');
  } catch (err) {
    logWarn('[problem-log] close failed', { error: err && err.name ? err.name : 'Error' });
  }
  try {
    if (sessionGuard) sessionGuard.markClean();
  } catch (err) {
    logWarn('[main] session clean mark failed', { error: err && err.name ? err.name : 'Error' });
  }
  if (quitLayoutFlushed) return;
  quitLayoutFlushed = true;
  event.preventDefault();
  Promise.resolve()
    .then(() => flushSessionLayoutsForQuit())
    .catch((err) => {
      logWarn('[main] layout flush failed', { error: err && err.name ? err.name : 'Error' });
    })
    .then(() => app.quit());
});

ipcMain.handle('app:copy-text', (_event, text) => {
  if (typeof text !== 'string' || text.length > 2000) return false;
  try {
    clipboard.writeText(text);
  } catch {
    return false;
  }
  return true;
});
