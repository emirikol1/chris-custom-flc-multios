'use strict';

const fsDefault = require('fs');
const path = require('path');

const KIND = /^(uncaught-exception|unhandled-rejection|renderer-crashed|renderer-unresponsive|gpu-process-gone)$/;
const NAME = /^[A-Za-z_$][A-Za-z0-9_$]{0,63}$/;
const TOKEN = /^[A-Za-z0-9_-]{1,40}$/;
const FILE_NAME = /^[A-Za-z0-9._-]{1,80}$/;
const FN_NAME = /^[A-Za-z0-9_$.<>[\] ]{1,80}$/;
const VERSION = /^[A-Za-z0-9._+-]{1,40}$/;
const WHEN = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}/;
const MAX_FRAMES = 16;
const MAX_MESSAGE = 180;
const MAX_QUEUED = 8;
const DEFAULT_MAX_BYTES = 256 * 1024;

/**
 * Drop URLs, addresses, absolute paths, and query strings. What remains is
 * the exception text that is still useful after those pieces are gone.
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeMessage(value) {
  if (typeof value !== 'string' || !value) return '';
  const stripped = value
    .replace(/[A-Za-z][A-Za-z0-9+.-]*:\/\/\S+/g, ' ')
    .replace(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g, ' ')
    .replace(/(?:[A-Za-z]:\\[^\s)]+|\/(?:[^\s)]*\/)+[^\s)]*)/g, ' ')
    .replace(/[?&][^\s)]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_MESSAGE);
  if (stripped.length < 3) return '';
  if (/[\\/]/.test(stripped) || /:\/\//.test(stripped) || stripped.includes('@')) return '';
  return stripped;
}

/**
 * @param {string} location
 * @returns {string}
 */
function frameFile(location) {
  if (typeof location !== 'string' || !location) return '';
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(location)) return '';
  const base = path.posix.basename(location.replace(/\\/g, '/'));
  if (!FILE_NAME.test(base)) return '';
  return base;
}

/**
 * @param {unknown} stack
 * @returns {Array<{ fn?: string, file: string, line: number, col: number }>}
 */
function framesFromStack(stack) {
  if (typeof stack !== 'string' || !stack) return [];
  /** @type {Array<{ fn?: string, file: string, line: number, col: number }>} */
  const frames = [];
  const lines = stack.split('\n');
  for (let i = 0; i < lines.length && frames.length < MAX_FRAMES; i += 1) {
    const line = lines[i].trim();
    const match = /^at\s+(?:async\s+)?(?:(.+?)\s+\()?(.+):(\d+):(\d+)\)?$/.exec(line);
    if (!match) continue;
    const file = frameFile(match[2]);
    if (!file) continue;
    const lineNo = Number(match[3]);
    const col = Number(match[4]);
    if (!Number.isInteger(lineNo) || lineNo < 0 || lineNo > 1000000) continue;
    if (!Number.isInteger(col) || col < 0 || col > 1000000) continue;
    /** @type {{ fn?: string, file: string, line: number, col: number }} */
    const frame = { file, line: lineNo, col };
    const fn = match[1] && FN_NAME.test(match[1]) ? match[1] : '';
    if (fn) frame.fn = fn;
    frames.push(frame);
  }
  return frames;
}

/**
 * @param {unknown} frames
 * @returns {Array<{ fn?: string, file: string, line: number, col: number }>}
 */
function cleanFrames(frames) {
  if (!Array.isArray(frames)) return [];
  /** @type {Array<{ fn?: string, file: string, line: number, col: number }>} */
  const out = [];
  for (let i = 0; i < frames.length && out.length < MAX_FRAMES; i += 1) {
    const frame = frames[i];
    if (!frame || typeof frame !== 'object') continue;
    const file = typeof frame.file === 'string' && FILE_NAME.test(frame.file) ? frame.file : '';
    if (!file) continue;
    const lineNo = frame.line;
    const col = frame.col;
    if (!Number.isInteger(lineNo) || lineNo < 0 || lineNo > 1000000) continue;
    if (!Number.isInteger(col) || col < 0 || col > 1000000) continue;
    /** @type {{ fn?: string, file: string, line: number, col: number }} */
    const next = { file, line: lineNo, col };
    if (typeof frame.fn === 'string' && FN_NAME.test(frame.fn)) next.fn = frame.fn;
    out.push(next);
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function whole(value) {
  return typeof value === 'number' && Number.isInteger(value) && value >= 0 && value < 1e15
    ? value
    : 0;
}

/**
 * @param {unknown} raw
 * @param {{
 *   nowIso?: string,
 *   client?: string,
 *   pid?: number,
 *   platform?: string,
 *   arch?: string,
 *   uptimeMs?: number,
 *   memory?: { rss?: number, heapUsed?: number, heapTotal?: number },
 *   versions?: { electron?: string, chrome?: string, node?: string },
 * }} env
 * @returns {object | null}
 */
function buildCrashRecord(raw, env) {
  const src = raw && typeof raw === 'object' ? raw : null;
  const context = env && typeof env === 'object' ? env : {};
  if (!src || typeof src.kind !== 'string' || !KIND.test(src.kind)) return null;
  if (src.reason === 'clean-exit') return null;
  const at = typeof context.nowIso === 'string' && WHEN.test(context.nowIso) ? context.nowIso : '';
  if (!at) return null;
  /** @type {Record<string, unknown>} */
  const record = {
    v: 1,
    at,
    client: typeof context.client === 'string' && VERSION.test(context.client) ? context.client : '',
    pid: whole(context.pid),
    kind: src.kind,
    platform: typeof context.platform === 'string' && TOKEN.test(context.platform) ? context.platform : '',
    arch: typeof context.arch === 'string' && TOKEN.test(context.arch) ? context.arch : '',
    uptimeMs: whole(context.uptimeMs),
    memory: {
      rss: whole(context.memory && context.memory.rss),
      heapUsed: whole(context.memory && context.memory.heapUsed),
      heapTotal: whole(context.memory && context.memory.heapTotal),
    },
    versions: {},
  };
  const versions = context.versions && typeof context.versions === 'object' ? context.versions : {};
  for (const key of ['electron', 'chrome', 'node']) {
    const value = versions[key];
    if (typeof value === 'string' && VERSION.test(value)) record.versions[key] = value;
  }
  if (typeof src.reason === 'string' && TOKEN.test(src.reason)) record.reason = src.reason;
  if (typeof src.exitCode === 'number' && Number.isInteger(src.exitCode) && Math.abs(src.exitCode) < 1000000) {
    record.exitCode = src.exitCode;
  }
  if (typeof src.errorName === 'string' && NAME.test(src.errorName)) record.errorName = src.errorName;
  const message = sanitizeMessage(src.message);
  if (message) record.message = message;
  const frames = Array.isArray(src.frames) ? cleanFrames(src.frames) : framesFromStack(src.stack);
  if (frames.length) record.frames = frames;
  return record;
}

/**
 * @returns {{
 *   nowIso: string,
 *   pid: number,
 *   platform: string,
 *   arch: string,
 *   uptimeMs: number,
 *   memory: { rss: number, heapUsed: number, heapTotal: number },
 *   versions: { electron?: string, chrome?: string, node?: string },
 * }}
 */
function defaultSnapshot() {
  /** @type {{ rss: number, heapUsed: number, heapTotal: number }} */
  let memory = { rss: 0, heapUsed: 0, heapTotal: 0 };
  try {
    const usage = process.memoryUsage();
    memory = { rss: usage.rss, heapUsed: usage.heapUsed, heapTotal: usage.heapTotal };
  } catch {
    /* numbers stay zero */
  }
  let uptimeMs = 0;
  try {
    uptimeMs = Math.round(process.uptime() * 1000);
  } catch {
    uptimeMs = 0;
  }
  return {
    nowIso: new Date().toISOString(),
    pid: process.pid,
    platform: process.platform,
    arch: process.arch,
    uptimeMs,
    memory,
    versions: {
      electron: process.versions && process.versions.electron,
      chrome: process.versions && process.versions.chrome,
      node: process.versions && process.versions.node,
    },
  };
}

/**
 * Append-only crash reports. Each line is one sanitized record.
 * @param {{
 *   filePath: string,
 *   client?: string,
 *   fs?: object,
 *   now?: () => number,
 *   snapshot?: () => object,
 *   maxBytes?: number,
 * }} opts
 */
function createCrashReport(opts) {
  const fs = opts && opts.fs && typeof opts.fs === 'object' ? opts.fs : fsDefault;
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : '';
  const client = opts && typeof opts.client === 'string' ? opts.client : '';
  const clock = opts && typeof opts.now === 'function' ? opts.now : () => Date.now();
  const snapshot = opts && typeof opts.snapshot === 'function' ? opts.snapshot : defaultSnapshot;
  const maxBytes = opts && typeof opts.maxBytes === 'number' && opts.maxBytes >= 0
    ? opts.maxBytes
    : DEFAULT_MAX_BYTES;

  function env() {
    const snap = snapshot() || {};
    let at = '';
    try {
      at = new Date(clock()).toISOString();
    } catch {
      at = '';
    }
    return Object.assign({}, snap, {
      client: client || snap.client || '',
      nowIso: at,
    });
  }

  /**
   * @param {object} record
   */
  function append(record) {
    if (!filePath) {
      const err = new Error('missing path');
      err.name = 'Error';
      throw err;
    }
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    let size = 0;
    let exists = false;
    try {
      size = fs.statSync(filePath).size;
      exists = true;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    if (exists && size > maxBytes) {
      const rotated = path.join(dir, 'crash-reports.1.jsonl');
      fs.rmSync(rotated, { force: true });
      fs.renameSync(filePath, rotated);
    }
    fs.appendFileSync(filePath, `${JSON.stringify(record)}\n`, { encoding: 'utf8', mode: 0o600 });
    try {
      fs.chmodSync(filePath, 0o600);
    } catch {
      /* mode is already requested on create */
    }
  }

  /**
   * @param {unknown} raw
   * @returns {boolean}
   */
  function write(raw) {
    const record = buildCrashRecord(raw, env());
    if (!record) return false;
    append(record);
    return true;
  }

  /**
   * @param {number} [limit]
   * @returns {object[]}
   */
  function readRecent(limit) {
    const count = typeof limit === 'number' && Number.isFinite(limit) ? Math.max(0, Math.floor(limit)) : 20;
    if (!count || !filePath) return [];
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return [];
    }
    /** @type {object[]} */
    const valid = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        const record = buildCrashRecord(parsed, {
          nowIso: parsed && parsed.at,
          client: parsed && parsed.client,
          pid: parsed && parsed.pid,
          platform: parsed && parsed.platform,
          arch: parsed && parsed.arch,
          uptimeMs: parsed && parsed.uptimeMs,
          memory: parsed && parsed.memory,
          versions: parsed && parsed.versions,
        });
        if (record) valid.push(record);
      } catch {
        /* skip a damaged line */
      }
    }
    return valid.slice(-count);
  }

  return { write, append, readRecent };
}

/** @type {ReturnType<typeof createCrashReport> | null} */
let active = null;
/** @type {(() => void) | null} */
let onSaved = null;
/** @type {object[]} */
const queued = [];

/**
 * @param {ReturnType<typeof createCrashReport>} writer
 * @param {() => void} [saved]
 */
function attach(writer, saved) {
  active = writer && typeof writer.write === 'function' ? writer : null;
  onSaved = typeof saved === 'function' ? saved : null;
  if (!active) {
    queued.length = 0;
    return;
  }
  while (queued.length && active) {
    const raw = queued.shift();
    try {
      if (active.write(raw) && onSaved) onSaved();
    } catch {
      /* a later record can still land */
    }
  }
}

/**
 * @param {unknown} raw
 * @returns {boolean}
 */
function writeCrash(raw) {
  const src = raw && typeof raw === 'object' ? raw : null;
  if (!src || src.reason === 'clean-exit') return false;
  if (!active) {
    if (queued.length < MAX_QUEUED) queued.push(src);
    return true;
  }
  try {
    const ok = active.write(src);
    if (ok && onSaved) onSaved();
    return ok;
  } catch {
    return false;
  }
}

/**
 * Validated crash records already on disk, one JSON object per line.
 * @param {object} fs
 * @param {string} filePath
 * @param {number} [limit]
 * @returns {string}
 */
function readCrashReportText(fs, filePath, limit) {
  const store = createCrashReport({
    filePath: typeof filePath === 'string' ? filePath : '',
    fs,
  });
  return store.readRecent(limit).map((record) => JSON.stringify(record)).join('\n');
}

module.exports = {
  sanitizeMessage,
  framesFromStack,
  buildCrashRecord,
  createCrashReport,
  attach,
  writeCrash,
  readCrashReportText,
};
