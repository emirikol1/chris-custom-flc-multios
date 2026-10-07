'use strict';

const dns = require('dns');
const { logInfo, logWarn } = require('./logger');
const {
  attachReverseNames,
  formatNetTraceText,
  redactReport,
  runNetTrace,
} = require('./net-trace');

/** @type {Map<string, object>} */
const results = new Map();
/** @type {Map<string, { abort: AbortController }>} */
const running = new Map();
/** @type {Map<string, number>} */
const epochs = new Map();

/** @type {(addr: string) => Promise<string[]>} */
let reverseFn = (addr) => dns.promises.reverse(addr);

/**
 * @param {unknown} serverId
 * @returns {string}
 */
function serverKey(serverId) {
  return typeof serverId === 'string' ? serverId : '';
}

/**
 * Drop an in-memory trace and cancel one that is still running.
 * @param {unknown} serverId
 */
function forgetNetTrace(serverId) {
  const key = serverKey(serverId);
  if (!key) return;
  const row = running.get(key);
  if (row) {
    try { row.abort.abort(); } catch { /* already finished */ }
  }
  running.delete(key);
  results.delete(key);
  epochs.set(key, (epochs.get(key) || 0) + 1);
}

/**
 * Redacted view. Reverse lookups run only when includeAddresses is true.
 * @param {unknown} serverId
 * @param {boolean} includeAddresses
 * @returns {Promise<{ report: object, text: string } | null>}
 */
async function viewNetTrace(serverId, includeAddresses) {
  const key = serverKey(serverId);
  const report = key ? results.get(key) : null;
  if (!report) return null;
  if (includeAddresses === true) await attachReverseNames(report, { reverse: reverseFn });
  const redacted = redactReport(report, { includeAddresses: includeAddresses === true });
  return { report: redacted, text: formatNetTraceText(redacted) };
}

/**
 * Last redacted trace as plain text, or null when this server has no result.
 * @param {unknown} serverId
 * @param {{ includeAddresses?: boolean }} [opts]
 * @returns {Promise<string | null>}
 */
async function redactedNetTraceText(serverId, opts) {
  const view = await viewNetTrace(serverId, Boolean(opts && opts.includeAddresses));
  return view ? view.text : null;
}

/**
 * @param {{
 *   ipcMain: { handle: Function },
 *   clipboard?: { writeText?: Function },
 *   windowForServer?: Function,
 *   getServerHost?: Function,
 *   reverse?: Function,
 *   spawn?: Function,
 *   platform?: string,
 *   dns?: object,
 *   connect?: Function,
 *   tlsConnect?: Function,
 *   log?: { info?: Function, warn?: Function },
 * }} deps
 */
function registerNetTraceIpc(deps) {
  const ipcMain = deps && deps.ipcMain;
  if (!ipcMain || typeof ipcMain.handle !== 'function') {
    const err = new Error('ipcMain');
    err.name = 'TypeError';
    throw err;
  }
  if (typeof deps.reverse === 'function') reverseFn = deps.reverse;
  const clipboard = deps.clipboard;
  const windowForServer = deps.windowForServer;
  const getServerHost = deps.getServerHost;
  const info = deps.log && typeof deps.log.info === 'function' ? deps.log.info : logInfo;
  const warn = deps.log && typeof deps.log.warn === 'function' ? deps.log.warn : logWarn;

  ipcMain.handle('nettrace:run', async (event, serverId) => {
    const key = serverKey(serverId);
    if (!key) return { ok: false, reason: 'Error' };
    if (running.has(key)) return { ok: false, reason: 'busy' };
    if (typeof windowForServer === 'function' && !windowForServer(key)) return { ok: false, reason: 'Error' };
    let target = null;
    try {
      target = typeof getServerHost === 'function' ? getServerHost(key) : null;
    } catch (err) {
      warn('[nettrace] run failed', { error: err && err.name ? err.name : 'Error' });
      return { ok: false, reason: 'Error' };
    }
    if (!target || typeof target.host !== 'string' || !target.host) return { ok: false, reason: 'Error' };
    const epoch = epochs.get(key) || 0;
    const abort = new AbortController();
    running.set(key, { abort });
    const started = Date.now();
    try {
      const report = await runNetTrace({
        host: target.host,
        port: target.port,
        platform: deps.platform || process.platform,
        serverHash: target.serverHash,
        spawn: deps.spawn,
        dns: deps.dns,
        connect: deps.connect,
        tlsConnect: deps.tlsConnect,
        signal: abort.signal,
        onProgress: (progress) => {
          try {
            if (event && event.sender && typeof event.sender.send === 'function') {
              event.sender.send('nettrace:progress', {
                serverId: key,
                step: progress.step,
                of: progress.of,
                label: progress.label,
              });
            }
          } catch {
            /* sender gone */
          }
        },
      });
      if (abort.signal.aborted || (epochs.get(key) || 0) !== epoch) {
        return { ok: false, reason: 'cancelled' };
      }
      results.set(key, report);
      const redacted = redactReport(report, { includeAddresses: false });
      info('[nettrace] run', {
        durationMs: Date.now() - started,
        hops: report.summary ? report.summary.hopCount : 0,
        reached: Boolean(report.summary && report.summary.reached),
      });
      return { ok: true, report: redacted, text: formatNetTraceText(redacted) };
    } catch (err) {
      const name = err && err.name ? err.name : 'Error';
      if (name === 'AbortError' || abort.signal.aborted) return { ok: false, reason: 'cancelled' };
      warn('[nettrace] run failed', { error: name, durationMs: Date.now() - started });
      return { ok: false, reason: name };
    } finally {
      const row = running.get(key);
      if (row && row.abort === abort) running.delete(key);
    }
  });

  ipcMain.handle('nettrace:cancel', (_event, serverId) => {
    const row = running.get(serverKey(serverId));
    if (row) {
      try { row.abort.abort(); } catch { /* already finished */ }
    }
    return { ok: true };
  });

  ipcMain.handle('nettrace:get', (_event, serverId, opts) => (
    viewNetTrace(serverId, Boolean(opts && opts.includeAddresses))
  ));

  ipcMain.handle('nettrace:copy', async (_event, serverId, opts) => {
    try {
      const view = await viewNetTrace(serverId, Boolean(opts && opts.includeAddresses));
      if (!view) return { ok: false, reason: 'empty' };
      if (!clipboard || typeof clipboard.writeText !== 'function') return { ok: false, reason: 'Error' };
      clipboard.writeText(view.text);
      return { ok: true };
    } catch (err) {
      warn('[nettrace] copy failed', { error: err && err.name ? err.name : 'Error' });
      return { ok: false, reason: 'Error' };
    }
  });
}

module.exports = {
  registerNetTraceIpc,
  forgetNetTrace,
  redactedNetTraceText,
};
