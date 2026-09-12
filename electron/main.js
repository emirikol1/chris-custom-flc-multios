const { app, BrowserWindow, dialog, ipcMain, net, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const {
  getGpuPrefsPath,
  getServersPath,
  getAppPrefsPath,
  getAiProviderPath,
  getWindowStatePath,
  getNarratorRoot,
} = require('./paths');
const { readGpuPrefs } = require('./gpu-prefs');
const { browserLikeUserAgent } = require('./user-agent');

const gpuPrefsPath = getGpuPrefsPath();
const gpuPrefsAtStartup = readGpuPrefs(gpuPrefsPath);

const {
  logInfo,
  logError,
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

const {
  loadServers,
  saveServers,
  ensureServersFile,
  addServer,
  updateServer,
  deleteServer,
  listServers,
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
const { loadSettings: loadNarratorSettings } = require('./narrator-store');
const {
  registerGameIpc,
  injectCaptureIntoLiveWindows,
  runInLiveGameWindows,
  hasLiveGameWindows,
  getAutologinContext,
} = require('./game-window');
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
const appPrefsPath = getAppPrefsPath();
const aiProviderPath = getAiProviderPath();
const narratorRoot = getNarratorRoot();
const pkg = require('../package.json');

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
  logError('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
});

function sendToJoinWindow(channel, payload) {
  if (joinWindow && !joinWindow.isDestroyed()) {
    joinWindow.webContents.send(channel, payload);
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
    return listServers(next);
  });

  ipcMain.handle('servers:update', (_event, id, patch) => {
    ensureServersFile(serversFilePath);
    const servers = loadServers(serversFilePath);
    const next = updateServer(servers, id, patch);
    saveServers(serversFilePath, next);
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
    return listServers(next);
  });
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
        appVersion: pkg.version,
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
registerGameIpc(gpuPrefsPath, {
  windowState,
  isMudEnabled,
  buildCaptureScript: () => buildCaptureSource(loadScoreboard(narratorRoot)),
  onGameWindowOpened: () => {
    if (isMudEnabled()) {
      const mudWin = ensureNarratorWindow(windowState);
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

app.whenReady().then(() => {
  ensureServersFile(serversFilePath);
  const gpuMode = gpuPrefsAtStartup.preferSoftwareWebgl ? 'software' : 'hardware';
  const version = pkg.version || 'unknown';
  logInfo(`Starting ${pkg.name} v${version} (GPU mode: ${gpuMode}, mud: ${isMudEnabled() ? 'on' : 'off'})`);

  createWindow();

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
