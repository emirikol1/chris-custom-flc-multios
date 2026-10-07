'use strict';

/**
 * Pure helpers for the troubleshooting clipboard and save-file actions.
 * Electron `clipboard` and `dialog` are injected so tests do not load Electron.
 */

/**
 * Last `n` lines. A trailing empty line from a final newline is dropped first.
 * @param {unknown} text
 * @param {number} n
 * @returns {string}
 */
function tailLines(text, n) {
  const count = typeof n === 'number' && Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
  const src = typeof text === 'string' ? text : '';
  if (!count || !src) return '';
  const parts = src.split(/\r?\n/);
  if (parts.length && parts[parts.length - 1] === '') parts.pop();
  if (!parts.length) return '';
  return parts.slice(-count).join('\n');
}

/**
 * @param {Date | number | string} [date]
 * @returns {string}
 */
function diagnosticsFileName(date) {
  const d = date instanceof Date ? date : new Date(date == null ? Date.now() : date);
  const when = Number.isNaN(d.getTime()) ? new Date() : d;
  const y = when.getFullYear();
  const m = String(when.getMonth() + 1).padStart(2, '0');
  const day = String(when.getDate()).padStart(2, '0');
  return `flc-diagnostics-${y}-${m}-${day}.txt`;
}

/**
 * Report text plus a labeled log tail. The log is already scrubbed on disk.
 * @param {{ report?: unknown, logTail?: unknown }} [input]
 * @returns {string}
 */
function buildDiagnosticsText(input) {
  const report = input && typeof input.report === 'string' ? input.report : '';
  const logTail = input && typeof input.logTail === 'string' ? input.logTail : '';
  return `${report}\n\n--- main.log (last 200 lines) ---\n${logTail}`;
}

/**
 * @param {{ clipboard?: { writeText?: (text: string) => void } }} deps
 * @param {string} text
 * @returns {{ ok: boolean, bytes: number }}
 */
function copyDiagnosticsText(deps, text) {
  const value = typeof text === 'string' ? text : '';
  const clipboard = deps && deps.clipboard;
  if (!clipboard || typeof clipboard.writeText !== 'function') {
    return { ok: false, bytes: 0 };
  }
  try {
    clipboard.writeText(value);
    return { ok: true, bytes: Buffer.byteLength(value, 'utf8') };
  } catch {
    return { ok: false, bytes: 0 };
  }
}

/**
 * @param {{ dialog?: { showSaveDialog?: (opts: object) => Promise<{ canceled?: boolean, filePath?: string }> }, fs?: { promises?: { writeFile?: Function }, writeFileSync?: Function } }} deps
 * @param {string} text
 * @param {{ defaultPath?: string }} [opts]
 * @returns {Promise<{ ok: boolean, canceled?: boolean, error?: string }>}
 */
async function saveDiagnosticsText(deps, text, opts) {
  const dialog = deps && deps.dialog;
  const fsMod = deps && deps.fs;
  if (!dialog || typeof dialog.showSaveDialog !== 'function' || !fsMod) {
    return { ok: false, error: 'Error' };
  }
  try {
    const chosen = await dialog.showSaveDialog({
      defaultPath: opts && typeof opts.defaultPath === 'string' ? opts.defaultPath : undefined,
      filters: [{ name: 'Text', extensions: ['txt'] }],
    });
    if (!chosen || chosen.canceled || !chosen.filePath) {
      return { ok: false, canceled: true };
    }
    const body = typeof text === 'string' ? text : '';
    if (fsMod.promises && typeof fsMod.promises.writeFile === 'function') {
      await fsMod.promises.writeFile(chosen.filePath, body, 'utf8');
    } else if (typeof fsMod.writeFileSync === 'function') {
      fsMod.writeFileSync(chosen.filePath, body, 'utf8');
    } else {
      return { ok: false, error: 'Error' };
    }
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err && err.name ? String(err.name) : 'Error' };
  }
}

module.exports = {
  tailLines,
  diagnosticsFileName,
  buildDiagnosticsText,
  copyDiagnosticsText,
  saveDiagnosticsText,
};
