const { app, BrowserWindow, ipcMain } = require('electron');
const path = require('path');
const { getGpuPrefsPath, getServersPath } = require('./paths');
const { readGpuPrefs } = require('./gpu-prefs');

const gpuPrefsPath = getGpuPrefsPath();
const gpuPrefsAtStartup = readGpuPrefs(gpuPrefsPath);

const {
  logInfo,
  logError,
  registerRendererLogIpc,
} = require('./logger');

app.commandLine.appendSwitch('class', 'ChrisCustomFLCMultiOS');

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
const { registerGameIpc } = require('./game-window');

const serversFilePath = getServersPath();
const pkg = require('../package.json');

process.on('uncaughtException', (err) => {
  logError('uncaughtException', err);
});

process.on('unhandledRejection', (reason) => {
  logError('unhandledRejection', reason);
});

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

  ipcMain.handle('servers:delete', (_event, id) => {
    ensureServersFile(serversFilePath);
    const servers = loadServers(serversFilePath);
    const next = deleteServer(servers, id);
    saveServers(serversFilePath, next);
    return listServers(next);
  });
}

function createWindow() {
  const win = new BrowserWindow({
    width: 900,
    height: 600,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      preload: path.join(__dirname, 'preload.js'),
    },
  });

  logInfo('Join-list window opened');

  win.on('closed', () => {
    logInfo('Join-list window closed');
  });

  win.loadFile(path.join(__dirname, '..', 'src', 'index.html'));
}

registerServerIpc();
registerRendererLogIpc(ipcMain);
registerGameIpc(gpuPrefsPath);

app.whenReady().then(() => {
  ensureServersFile(serversFilePath);
  const gpuMode = gpuPrefsAtStartup.preferSoftwareWebgl ? 'software' : 'hardware';
  const version = pkg.version || 'unknown';
  logInfo(`Starting ${pkg.name} v${version} (GPU mode: ${gpuMode})`);

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
