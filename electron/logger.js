const fs = require('fs');
const path = require('path');
const log = require('electron-log');
const { safeLogArgs } = require('./log-format');
const { getLogsDir } = require('./paths');

const LOGS_DIR = getLogsDir();
const MAIN_LOG_PATH = path.join(LOGS_DIR, 'main.log');
const RENDERER_LOG_PATH = path.join(LOGS_DIR, 'renderer.log');

const VALID_LEVELS = new Set(['error', 'warn', 'info', 'verbose', 'debug', 'silly']);
const envLevel = (process.env.FOUNDRY_JOIN_LOG_LEVEL || 'info').toLowerCase();
const logLevel = VALID_LEVELS.has(envLevel) ? envLevel : 'info';

fs.mkdirSync(LOGS_DIR, { recursive: true });

log.transports.file.resolvePathFn = () => MAIN_LOG_PATH;
log.transports.file.level = logLevel;
log.transports.console.level = logLevel;

/**
 * @param {'info' | 'warn' | 'error' | 'debug'} fn
 * @param {string} msg
 * @param {unknown[]} args
 */
function writeLog(fn, msg, args) {
  const safe = safeLogArgs(args);
  log[fn](msg, ...safe);
}

function logInfo(msg, ...args) {
  writeLog('info', msg, args);
}

function logWarn(msg, ...args) {
  writeLog('warn', msg, args);
}

function logError(msg, ...args) {
  writeLog('error', msg, args);
}

function logDebug(msg, ...args) {
  writeLog('debug', msg, args);
}

/**
 * @param {string} level
 * @param {string} message
 */
function appendRendererLog(level, message) {
  const line = `[${new Date().toISOString()}] [${level}] ${message}\n`;
  try {
    fs.appendFileSync(RENDERER_LOG_PATH, line, 'utf8');
  } catch (err) {
    log.error('Failed to write renderer.log', err.message);
  }
}

/**
 * @param {import('electron').IpcMain} ipcMain
 */
function registerRendererLogIpc(ipcMain) {
  ipcMain.on('renderer-log:write', (_event, level, message) => {
    const lvl = String(level || 'info').toLowerCase();
    appendRendererLog(lvl, String(message));
  });
}

module.exports = {
  logger: log,
  logLevel,
  logInfo,
  logWarn,
  logError,
  logDebug,
  registerRendererLogIpc,
  MAIN_LOG_PATH,
  RENDERER_LOG_PATH,
};
