'use strict';

/**
 * Per-server slow-cache verdict. The file is `{ [serverId]: Verdict }` with
 * booleans, counts, and a timestamp only. Writes are temp-file then rename.
 * Failures are swallowed and reported by error name only.
 */

const fs = require('fs');
const path = require('path');

const MAX_ID = 200;
const MAX_COUNT = 1000000;

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
    && value !== 'prototype'
    && value.indexOf('://') === -1
    && !/[\s/?#@\\]/.test(value);
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function countOf(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return 0;
  return Math.min(MAX_COUNT, Math.floor(value));
}

/**
 * @param {unknown} value
 * @param {boolean} dismissed
 * @returns {{ slow: boolean, proxy: 'nginx' | 'other', total: number, noCache: number, dismissed: boolean, at: number } | null}
 */
function sanitizeVerdict(value, dismissed) {
  const src = value && typeof value === 'object' && !Array.isArray(value) ? value : null;
  if (!src && !dismissed) return null;
  const at = src && typeof src.at === 'number' && Number.isFinite(src.at) && src.at >= 0
    ? src.at
    : Date.now();
  return {
    slow: !!(src && src.slow === true),
    proxy: src && src.proxy === 'nginx' ? 'nginx' : 'other',
    total: countOf(src && src.total),
    noCache: countOf(src && src.noCache),
    dismissed: dismissed === true,
    at,
  };
}

/**
 * @param {unknown} parsed
 * @returns {Record<string, { slow: boolean, proxy: 'nginx' | 'other', total: number, noCache: number, dismissed: boolean, at: number }>}
 */
function sanitizeStore(parsed) {
  /** @type {Record<string, ReturnType<typeof sanitizeVerdict>>} */
  const out = Object.create(null);
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return out;
  const keys = Object.keys(parsed);
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (!validId(key)) continue;
    const row = parsed[key];
    const clean = sanitizeVerdict(row, !!(row && row.dismissed === true));
    if (clean) out[key] = clean;
  }
  return out;
}

/**
 * @param {{ filePath?: string, log?: { warn?: (name: string) => void } }} opts
 */
function createSlowCacheStore(opts) {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : '';
  const logger = opts && opts.log && typeof opts.log === 'object' ? opts.log : null;
  /** @type {Record<string, { slow: boolean, proxy: 'nginx' | 'other', total: number, noCache: number, dismissed: boolean, at: number }>} */
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
   * @param {object} verdict
   * @returns {boolean}
   */
  function saveVerdict(serverId, verdict) {
    try {
      if (!validId(serverId)) return false;
      const prev = store[serverId];
      const clean = sanitizeVerdict(verdict, !!(prev && prev.dismissed === true));
      if (!clean) return false;
      store[serverId] = clean;
      persist();
      return true;
    } catch (err) {
      report(err);
      return false;
    }
  }

  /**
   * @param {string} serverId
   * @returns {boolean}
   */
  function dismiss(serverId) {
    try {
      if (!validId(serverId)) return false;
      const prev = store[serverId];
      const clean = sanitizeVerdict(prev || { slow: false, proxy: 'other', total: 0, noCache: 0 }, true);
      if (!clean) return false;
      if (prev && typeof prev.at === 'number') clean.at = prev.at;
      store[serverId] = clean;
      persist();
      return true;
    } catch (err) {
      report(err);
      return false;
    }
  }

  /**
   * @param {string} serverId
   */
  function get(serverId) {
    try {
      if (!validId(serverId) || !store[serverId]) return null;
      return Object.assign({}, store[serverId]);
    } catch (err) {
      report(err);
      return null;
    }
  }

  /**
   * Flags the join window is allowed to see.
   * @returns {Record<string, { slow: boolean, proxy: 'nginx' | 'other', dismissed: boolean }>}
   */
  function list() {
    try {
      /** @type {Record<string, { slow: boolean, proxy: 'nginx' | 'other', dismissed: boolean }>} */
      const out = Object.create(null);
      const keys = Object.keys(store);
      for (let i = 0; i < keys.length; i += 1) {
        const row = store[keys[i]];
        out[keys[i]] = {
          slow: row.slow === true,
          proxy: row.proxy === 'nginx' ? 'nginx' : 'other',
          dismissed: row.dismissed === true,
        };
      }
      return out;
    } catch (err) {
      report(err);
      return Object.create(null);
    }
  }

  store = readStore();

  return { saveVerdict, dismiss, get, list, validId };
}

module.exports = {
  createSlowCacheStore,
  validId,
};
