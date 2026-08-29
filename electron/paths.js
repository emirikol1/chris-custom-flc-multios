const path = require('path');
const { app } = require('electron');

const PROJECT_ROOT = path.join(__dirname, '..');

function isPackaged() {
  return Boolean(app && app.isPackaged);
}

function getDataDir() {
  if (isPackaged()) {
    return path.join(app.getPath('userData'), 'data');
  }
  return path.join(PROJECT_ROOT, 'data');
}

function getLogsDir() {
  if (isPackaged()) {
    return path.join(app.getPath('userData'), 'logs');
  }
  return path.join(PROJECT_ROOT, 'logs');
}

function getServersPath() {
  return path.join(getDataDir(), 'servers.json');
}

function getGpuPrefsPath() {
  return path.join(getDataDir(), 'gpu-prefs.json');
}

module.exports = {
  PROJECT_ROOT,
  isPackaged,
  getDataDir,
  getLogsDir,
  getServersPath,
  getGpuPrefsPath,
};
