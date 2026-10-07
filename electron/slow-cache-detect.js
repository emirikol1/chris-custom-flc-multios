'use strict';

/**
 * Decide whether a Foundry server is forcing browsers to revalidate package
 * assets one at a time. Counters only: the request address and headers are
 * read to classify one response and then dropped.
 */

const ASSET_TYPES = Object.freeze(['script', 'stylesheet', 'font']);
const ASSET_PREFIXES = Object.freeze([
  '/scripts/',
  '/css/',
  '/fonts/',
  '/icons/',
  '/ui/',
  '/sounds/',
  '/lang/',
  '/systems/',
  '/modules/',
]);
const DECIDE_AT = 40;
const SLOW_RATIO = 0.8;

/** @type {WeakMap<object, { total: number, noCache: number, nginx: number, fromCache: number }>} */
const countsByWin = new WeakMap();

/**
 * @returns {{ total: number, noCache: number, nginx: number, fromCache: number }}
 */
function emptyCounts() {
  return { total: 0, noCache: 0, nginx: 0, fromCache: 0 };
}

/**
 * @param {unknown} headers
 * @param {string} name
 * @returns {string}
 */
function headerText(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = name.toLowerCase();
  const keys = Object.keys(headers);
  for (let i = 0; i < keys.length; i += 1) {
    if (keys[i].toLowerCase() !== want) continue;
    const value = headers[keys[i]];
    if (Array.isArray(value)) {
      return value.filter((part) => typeof part === 'string').join(', ');
    }
    return typeof value === 'string' ? value : '';
  }
  return '';
}

/**
 * no-cache, or max-age=0, unless the response also allows stale-while-revalidate.
 * @param {unknown} value
 * @returns {boolean}
 */
function isNoCacheControl(value) {
  const text = String(value || '').toLowerCase();
  if (!text) return false;
  if (text.indexOf('stale-while-revalidate') !== -1) return false;
  if (text.indexOf('no-cache') !== -1) return true;
  return /(?:^|[\s,;])max-age\s*=\s*0(?:$|[\s,;])/.test(text);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isNginxServer(value) {
  return String(value || '').trim().toLowerCase().startsWith('nginx');
}

/**
 * Pathname of a same-origin package asset, or '' when the response does not count.
 * The address is not retained by the caller.
 * @param {unknown} url
 * @param {unknown} origin
 * @returns {string}
 */
function assetPathname(url, origin) {
  if (typeof url !== 'string' || typeof origin !== 'string' || !origin) return '';
  let parsed;
  try {
    parsed = new URL(url);
  } catch {
    return '';
  }
  if (parsed.origin !== origin) return '';
  const path = parsed.pathname || '';
  for (let i = 0; i < ASSET_PREFIXES.length; i += 1) {
    if (path.startsWith(ASSET_PREFIXES[i])) return path;
  }
  return '';
}

/**
 * @param {{ total: number, noCache: number, nginx: number, fromCache: number }} counts
 * @param {unknown} details
 * @param {unknown} origin
 * @returns {boolean} true when this response was counted
 */
function noteResponse(counts, details, origin) {
  if (!counts || !details || typeof details !== 'object') return false;
  const type = details.resourceType;
  if (ASSET_TYPES.indexOf(type) === -1) return false;
  if (!assetPathname(details.url, origin)) return false;
  const cacheControl = headerText(details.responseHeaders, 'cache-control');
  const server = headerText(details.responseHeaders, 'server');
  counts.total += 1;
  if (isNoCacheControl(cacheControl)) counts.noCache += 1;
  if (isNginxServer(server)) counts.nginx += 1;
  if (details.fromCache === true) counts.fromCache += 1;
  return true;
}

/**
 * @param {unknown} counts
 * @returns {{ slow: boolean, proxy: 'nginx' | 'other', total: number, noCache: number }}
 */
function summarize(counts) {
  const src = counts && typeof counts === 'object' ? counts : emptyCounts();
  const total = typeof src.total === 'number' && Number.isFinite(src.total) ? src.total : 0;
  const noCache = typeof src.noCache === 'number' && Number.isFinite(src.noCache) ? src.noCache : 0;
  const nginx = typeof src.nginx === 'number' && Number.isFinite(src.nginx) ? src.nginx : 0;
  const slow = total >= DECIDE_AT && total > 0 && noCache / total >= SLOW_RATIO;
  return {
    slow,
    proxy: nginx > 0 ? 'nginx' : 'other',
    total,
    noCache,
  };
}

/**
 * @param {object} win
 * @returns {{ total: number, noCache: number, nginx: number, fromCache: number }}
 */
function liveCounts(win) {
  let row = countsByWin.get(win);
  if (!row) {
    row = emptyCounts();
    countsByWin.set(win, row);
  }
  return row;
}

/**
 * @param {object} win
 * @returns {{ total: number, noCache: number, nginx: number, fromCache: number }}
 */
function countsFor(win) {
  const row = win ? countsByWin.get(win) : null;
  const src = row || emptyCounts();
  return {
    total: src.total,
    noCache: src.noCache,
    nginx: src.nginx,
    fromCache: src.fromCache,
  };
}

/**
 * @param {object} win
 */
function resetCounts(win) {
  if (!win) return;
  countsByWin.set(win, emptyCounts());
}

/**
 * Count one completed response for this window.
 * @param {object} win
 * @param {unknown} details
 * @param {unknown} origin inspected, not retained
 * @returns {{ counted: boolean, crossed: boolean, summary: ReturnType<typeof summarize> }}
 */
function noteCompleted(win, details, origin) {
  if (!win) {
    return { counted: false, crossed: false, summary: summarize(null) };
  }
  const counts = liveCounts(win);
  const before = counts.total;
  const counted = noteResponse(counts, details, origin);
  const summary = summarize(counts);
  const crossed = counted && before < DECIDE_AT && counts.total >= DECIDE_AT;
  return { counted, crossed, summary };
}

module.exports = {
  ASSET_PREFIXES,
  ASSET_TYPES,
  DECIDE_AT,
  SLOW_RATIO,
  emptyCounts,
  isNoCacheControl,
  isNginxServer,
  noteResponse,
  summarize,
  noteCompleted,
  countsFor,
  resetCounts,
};
