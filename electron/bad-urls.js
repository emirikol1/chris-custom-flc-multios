'use strict';

/**
 * In-memory list of files a Foundry server referenced that failed to load.
 * Records stay in the main process until the game window closes or the user
 * full-refreshes. Do not log, persist, or put these records in a report.
 */

const MAX_CHARS = 2048;
const DEFAULT_CAP = 200;
/** Unique URLs refused after the cap, so a retry does not inflate the footer. */
const DROPPED_TRACK_CAP = 5000;

const SKIP_ERROR_NAMES = new Set([
  'ERR_CACHE_MISS',
  'ERR_ABORTED',
  'ERR_BLOCKED_BY_CLIENT',
  'ERR_BLOCKED_BY_RESPONSE',
]);

const RECORD_RESOURCE_TYPES = new Set([
  'xhr',
  'fetch',
  'image',
  'media',
  'font',
  'stylesheet',
  'script',
  'other',
  'subFrame',
]);

/**
 * @param {unknown} input
 * @returns {boolean}
 */
function shouldRecordFailure(input) {
  const row = input && typeof input === 'object' ? input : {};
  const resourceType = typeof row.resourceType === 'string' ? row.resourceType : '';
  const statusCode = row.statusCode;
  const hasStatus = typeof statusCode === 'number' && Number.isFinite(statusCode);
  if (resourceType === 'mainFrame' && hasStatus && statusCode === 401) return false;
  if (!RECORD_RESOURCE_TYPES.has(resourceType)) return false;
  if (hasStatus && (statusCode === 401 || statusCode === 407)) return false;
  if (hasStatus && statusCode >= 400) return true;
  let errorName = typeof row.errorName === 'string' ? row.errorName : '';
  if (errorName.startsWith('net::')) errorName = errorName.slice(5);
  if (!errorName || SKIP_ERROR_NAMES.has(errorName)) return false;
  return true;
}

/**
 * Decoded pathname for matching a failing file to in-world references.
 * Absolute URLs only. Invalid values come back unchanged when they are short
 * enough to have been stored; empty when they are not a usable string.
 * @param {unknown} url
 * @returns {string}
 */
function failurePathname(url) {
  if (typeof url !== 'string' || !url || url.length > MAX_CHARS) return '';
  try {
    const parsed = new URL(url);
    let path = parsed.pathname || '';
    try {
      path = decodeURIComponent(path);
    } catch {
      /* keep the encoded pathname */
    }
    return path || url;
  } catch {
    return url;
  }
}

/**
 * @param {unknown} value
 * @returns {number}
 */
function resolveCap(value) {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) return DEFAULT_CAP;
  return Math.floor(value);
}

/**
 * @param {{ cap?: number, now?: () => number }} [options]
 * @returns {{
 *   note: (hubId: unknown, entry: object) => void,
 *   list: (hubId: unknown) => object[],
 *   clear: (hubId: unknown) => void,
 *   forget: (hubId: unknown) => void,
 *   count: (hubId: unknown) => number,
 *   dropped: (hubId: unknown) => number,
 * }}
 */
function createBadUrlStore(options) {
  const opts = options && typeof options === 'object' ? options : {};
  const cap = resolveCap(opts.cap);
  const now = typeof opts.now === 'function' ? opts.now : Date.now;
  /** @type {Map<string, { order: object[], byUrl: Map<string, object>, dropped: number, droppedUrls: Set<string> }>} */
  const hubs = new Map();

  function stamp(at) {
    if (typeof at === 'number' && Number.isFinite(at)) return at;
    try {
      const value = now();
      if (typeof value === 'number' && Number.isFinite(value)) return value;
    } catch {
      /* clock hook failed */
    }
    return Date.now();
  }

  /**
   * @param {unknown} hubId
   * @returns {string}
   */
  function hubKey(hubId) {
    if (typeof hubId !== 'string' || !hubId || hubId.length > MAX_CHARS) return '';
    return hubId;
  }

  /**
   * @param {string} hubId
   */
  function bucketFor(hubId) {
    let bucket = hubs.get(hubId);
    if (!bucket) {
      bucket = {
        order: [],
        byUrl: new Map(),
        dropped: 0,
        droppedUrls: new Set(),
      };
      hubs.set(hubId, bucket);
    }
    return bucket;
  }

  /**
   * @param {unknown} value
   * @param {boolean} required
   * @returns {{ ok: true, value: string | null } | { ok: false }}
   */
  function readString(value, required) {
    if (value == null || value === '') return required ? { ok: false } : { ok: true, value: null };
    if (typeof value !== 'string' || value.length > MAX_CHARS) return { ok: false };
    return { ok: true, value };
  }

  /**
   * @param {unknown} hubId
   * @param {object} entry
   */
  function note(hubId, entry) {
    const key = hubKey(hubId);
    if (!key || !entry || typeof entry !== 'object') return;
    const url = readString(entry.url, true);
    if (!url.ok || !url.value) return;
    const at = stamp(entry.at);
    const existingBucket = hubs.get(key);
    if (existingBucket) {
      const existing = existingBucket.byUrl.get(url.value);
      if (existing) {
        existing.hits += 1;
        existing.lastAt = at;
        return;
      }
    }
    const resourceType = readString(entry.resourceType, true);
    if (!resourceType.ok || resourceType.value == null) return;
    let status = null;
    if (entry.status != null) {
      if (typeof entry.status !== 'number' || !Number.isFinite(entry.status)) return;
      status = entry.status;
    }
    const error = readString(entry.error, false);
    if (!error.ok) return;
    const referrer = readString(entry.referrer, false);
    if (!referrer.ok) return;
    const bucket = bucketFor(key);
    if (bucket.order.length >= cap) {
      if (bucket.droppedUrls.has(url.value)) return;
      if (bucket.droppedUrls.size >= DROPPED_TRACK_CAP) return;
      bucket.droppedUrls.add(url.value);
      bucket.dropped += 1;
      return;
    }
    const row = {
      url: url.value,
      status,
      error: error.value,
      resourceType: resourceType.value,
      referrer: referrer.value,
      at,
      lastAt: at,
      hits: 1,
    };
    bucket.byUrl.set(url.value, row);
    bucket.order.push(row);
  }

  /**
   * @param {unknown} hubId
   * @returns {object[]}
   */
  function list(hubId) {
    const key = hubKey(hubId);
    const bucket = key ? hubs.get(key) : null;
    if (!bucket) return [];
    return bucket.order.map((row) => ({
      url: row.url,
      status: row.status,
      error: row.error,
      resourceType: row.resourceType,
      referrer: row.referrer,
      at: row.at,
      lastAt: row.lastAt,
      hits: row.hits,
    }));
  }

  /**
   * @param {unknown} hubId
   */
  function clear(hubId) {
    const key = hubKey(hubId);
    if (key) hubs.delete(key);
  }

  /**
   * @param {unknown} hubId
   */
  function forget(hubId) {
    clear(hubId);
  }

  /**
   * @param {unknown} hubId
   * @returns {number}
   */
  function count(hubId) {
    const key = hubKey(hubId);
    const bucket = key ? hubs.get(key) : null;
    return bucket ? bucket.order.length : 0;
  }

  /**
   * @param {unknown} hubId
   * @returns {number}
   */
  function dropped(hubId) {
    const key = hubKey(hubId);
    const bucket = key ? hubs.get(key) : null;
    return bucket ? bucket.dropped : 0;
  }

  return {
    note,
    list,
    clear,
    forget,
    count,
    dropped,
  };
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function oneLine(value) {
  return String(value).replace(/[\r\n\u2028\u2029]+/g, ' ').trim();
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function showPart(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return oneLine(value);
  if (typeof value === 'string' && value.trim()) return oneLine(value);
  return '—';
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function isoStamp(value) {
  let date = null;
  if (value instanceof Date) date = value;
  else if (typeof value === 'number' && Number.isFinite(value)) date = new Date(value);
  else if (typeof value === 'string' && value) date = new Date(value);
  if (date && !Number.isNaN(date.getTime())) return date.toISOString();
  return new Date().toISOString();
}

/**
 * @param {object | null | undefined} entry
 * @returns {string}
 */
function statusLabel(entry) {
  if (entry && typeof entry.status === 'number' && Number.isFinite(entry.status)) {
    return String(entry.status);
  }
  if (entry && typeof entry.error === 'string' && entry.error.trim()) return oneLine(entry.error);
  return '—';
}

/**
 * Plain text for the clipboard. Includes URLs and document names the user
 * asked to copy; callers must not write this string to disk or a log.
 * @param {{
 *   label?: unknown,
 *   generatedAt?: unknown,
 *   foundryVersion?: unknown,
 *   systemId?: unknown,
 *   systemVersion?: unknown,
 *   entries?: unknown,
 *   dropped?: unknown,
 * }} [input]
 * @returns {string}
 */
function formatBadUrlsText(input) {
  const row = input && typeof input === 'object' ? input : {};
  const header = `Missing or failing files — ${showPart(row.label)} — ${isoStamp(row.generatedAt)}`;
  const version = `Foundry ${showPart(row.foundryVersion)}, system ${showPart(row.systemId)} ${showPart(row.systemVersion)}`;
  const entries = Array.isArray(row.entries) ? row.entries : [];
  const blocks = [];
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i] && typeof entries[i] === 'object' ? entries[i] : {};
    const type = typeof entry.resourceType === 'string' && entry.resourceType.trim()
      ? oneLine(entry.resourceType)
      : '—';
    const url = typeof entry.url === 'string' ? oneLine(entry.url) : '';
    const lines = [`${statusLabel(entry)} ${type}  ${url}`];
    const refs = Array.isArray(entry.refs)
      ? entry.refs
        .filter((item) => typeof item === 'string' && item.trim())
        .slice(0, 5)
        .map((item) => oneLine(item))
      : [];
    const refText = refs.length
      ? refs.join(', ')
      : '(no in-world reference found; may be CSS/module asset)';
    lines.push(`  referenced by: ${refText}`);
    if (typeof entry.referrer === 'string' && entry.referrer.trim()) {
      lines.push(`  referrer: ${oneLine(entry.referrer)}`);
    }
    if (typeof entry.hits === 'number' && Number.isFinite(entry.hits) && entry.hits > 1) {
      lines.push(`  seen ${Math.floor(entry.hits)}\u00d7`);
    }
    blocks.push(lines.join('\n'));
  }
  const parts = [header, version];
  if (blocks.length) {
    parts.push('');
    parts.push(blocks.join('\n\n'));
  }
  const dropped = typeof row.dropped === 'number' && Number.isFinite(row.dropped) && row.dropped > 0
    ? Math.floor(row.dropped)
    : 0;
  if (dropped > 0) {
    parts.push('');
    parts.push(`${entries.length} entries (${dropped} more not recorded)`);
  }
  return `${parts.join('\n')}\n`;
}

module.exports = {
  createBadUrlStore,
  shouldRecordFailure,
  failurePathname,
  formatBadUrlsText,
};
