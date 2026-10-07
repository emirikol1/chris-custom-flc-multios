'use strict';

/**
 * Per-server join history on disk. Oldest record first, 10 per server.
 * The file is `{ [serverId]: HistoryRecord[] }`. Writes are temp-file then
 * rename. Failures are swallowed and reported by error name only.
 */

const fs = require('fs');
const path = require('path');

/** Records kept per server. */
const MAX_RECORDS = 10;
const MAX_ID = 200;

const FIELDS = Object.freeze([
  'at',
  'totalMs',
  'transfersMs',
  'worldDataMs',
  'worldDataBytes',
  'setupMs',
  'canvasMs',
  'requests',
  'transferBytes',
  'cacheHitRatio',
  'docs',
  'ttfbP50Ms',
  'rttP50Ms',
  'worldDataMsPerMb',
  'setupMsPerDoc',
]);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function validId(value) {
  return typeof value === 'string'
    && value.length > 0
    && value.length <= MAX_ID
    && value !== '__proto__'
    && value !== 'constructor'
    && value !== 'prototype';
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} rec
 * @returns {Record<string, number | null> | null}
 */
function sanitizeRecord(rec) {
  if (!rec || typeof rec !== 'object' || Array.isArray(rec)) return null;
  /** @type {Record<string, number | null>} */
  const out = {};
  for (let i = 0; i < FIELDS.length; i += 1) {
    const key = FIELDS[i];
    out[key] = finiteOrNull(rec[key]);
  }
  return out;
}

/**
 * Median total join time across the given rows.
 * @param {unknown} rows
 * @returns {number | null}
 */
function typicalTotalMs(rows) {
  const totals = (Array.isArray(rows) ? rows : [])
    .map((row) => (row ? finiteOrNull(row.totalMs) : null))
    .filter((v) => v != null && v >= 0)
    .sort((a, b) => a - b);
  if (!totals.length) return null;
  const mid = Math.floor(totals.length / 2);
  return totals.length % 2 ? totals[mid] : (totals[mid - 1] + totals[mid]) / 2;
}

/**
 * @param {unknown} parsed
 * @returns {Record<string, Array<Record<string, number | null>>>}
 */
function sanitizeStore(parsed) {
  /** @type {Record<string, Array<Record<string, number | null>>>} */
  const out = Object.create(null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  const keys = Object.keys(parsed);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!validId(key)) continue;
    const rows = parsed[key];
    if (!Array.isArray(rows)) continue;
    const kept = [];
    const start = Math.max(0, rows.length - MAX_RECORDS);
    for (let r = start; r < rows.length; r += 1) {
      const clean = sanitizeRecord(rows[r]);
      if (clean) kept.push(clean);
    }
    if (kept.length) out[key] = kept;
  }
  return out;
}

/**
 * @param {{ filePath: string, log?: { warn?: (name: string) => void } }} opts
 */
function createJoinHistory(opts) {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : '';
  const logger = opts && opts.log && typeof opts.log === 'object' ? opts.log : null;

  /** @type {Record<string, Array<Record<string, number | null>>>} */
  let store = Object.create(null);

  /**
   * @param {unknown} err
   */
  function report(err) {
    const name = err && err.name ? String(err.name) : 'Error';
    try {
      if (logger && typeof logger.warn === 'function') logger.warn(name);
    } catch {
      /* logger failed */
    }
  }

  function readStore() {
    if (!filePath) return Object.create(null);
    try {
      if (!fs.existsSync(filePath)) return Object.create(null);
      const text = fs.readFileSync(filePath, 'utf8');
      return sanitizeStore(JSON.parse(text));
    } catch (err) {
      if (err && err.code === 'ENOENT') return Object.create(null);
      report(err);
      return Object.create(null);
    }
  }

  function writeStore() {
    if (!filePath) return;
    const dir = path.dirname(filePath);
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(tmp, JSON.stringify(store), { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  function persist() {
    try {
      writeStore();
    } catch (err) {
      report(err);
    }
  }

  /**
   * @param {string} serverId
   * @returns {Array<Record<string, number | null>>}
   */
  function list(serverId) {
    try {
      if (!validId(serverId) || !store[serverId]) return [];
      return store[serverId].map((row) => Object.assign({}, row));
    } catch (err) {
      report(err);
      return [];
    }
  }

  /**
   * @param {string} serverId
   * @param {object} rec
   */
  function record(serverId, rec) {
    try {
      if (!validId(serverId)) return;
      const clean = sanitizeRecord(rec);
      if (!clean) return;
      const rows = store[serverId] ? store[serverId].slice() : [];
      rows.push(clean);
      store[serverId] = rows.length > MAX_RECORDS ? rows.slice(rows.length - MAX_RECORDS) : rows;
      persist();
    } catch (err) {
      report(err);
    }
  }

  /**
   * @param {string} serverId
   */
  function forget(serverId) {
    try {
      if (!validId(serverId) || !Object.prototype.hasOwnProperty.call(store, serverId)) return;
      delete store[serverId];
      persist();
    } catch (err) {
      report(err);
    }
  }

  function all() {
    try {
      /** @type {Record<string, Array<Record<string, number | null>>>} */
      const out = Object.create(null);
      const keys = Object.keys(store);
      for (let i = 0; i < keys.length; i += 1) out[keys[i]] = list(keys[i]);
      return out;
    } catch (err) {
      report(err);
      return Object.create(null);
    }
  }

  store = readStore();

  return { record, list, forget, all };
}

module.exports = {
  MAX_RECORDS,
  createJoinHistory,
  typicalTotalMs,
};
