/**
 * Automatic HTTP disk-cache budget for the Chromium process.
 * The persistent game partition already revalidates with ETag / Last-Modified.
 * This module only picks a byte limit from free space. It does not rewrite Cache-Control.
 */

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

const AUTO_CACHE = {
  fractionOfFree: 0.10,
  minBytes: 512 * MiB,
  maxBytes: 4 * GiB,
  lowDiskFreeBytes: 2 * GiB,
  lowDiskCacheBytes: 256 * MiB,
};

/**
 * @param {number} value
 * @param {number} min
 * @param {number} max
 * @returns {number}
 */
function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/**
 * Integer byte budget for the given free space.
 * Non-finite free space uses the normal minimum. A nearly full disk uses the low-disk budget.
 * Otherwise the budget is 10% of free space, clamped to the min/max.
 * @param {unknown} freeBytes
 * @param {typeof AUTO_CACHE} [policy]
 * @returns {number}
 */
function autoDiskCacheBytes(freeBytes, policy = AUTO_CACHE) {
  const rules = policy || AUTO_CACHE;
  if (!Number.isFinite(freeBytes)) return Math.round(rules.minBytes);
  if (freeBytes < rules.lowDiskFreeBytes) return Math.round(rules.lowDiskCacheBytes);
  return Math.round(clamp(freeBytes * rules.fractionOfFree, rules.minBytes, rules.maxBytes));
}

/**
 * Free bytes available to non-root users on the filesystem that holds `dirPath`.
 * @param {string} dirPath
 * @param {{ statfs?: (dir: string) => { bavail?: number, bsize?: number } }} [options]
 * @returns {number | null}
 */
function measureFreeBytes(dirPath, { statfs = require('fs').statfsSync } = {}) {
  try {
    // First run: the data folder may not exist yet. Measure the nearest
    // existing ancestor, which sits on the same volume.
    const path = require('path');
    let probe = String(dirPath);
    let stats = null;
    for (let i = 0; i < 32; i += 1) {
      try {
        stats = statfs(probe);
        break;
      } catch {
        const parent = path.dirname(probe);
        if (parent === probe) throw new Error('no ancestor');
        probe = parent;
      }
    }
    const bavail = Number(stats && stats.bavail);
    const bsize = Number(stats && stats.bsize);
    if (!Number.isFinite(bavail) || !Number.isFinite(bsize)) return null;
    const bytes = bavail * bsize;
    return Number.isFinite(bytes) ? bytes : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} dataDir
 * @param {{ statfs?: (dir: string) => { bavail?: number, bsize?: number }, measureFreeBytes?: (dir: string) => number | null }} [deps]
 * @returns {{ limitBytes: number, freeBytes: number | null, mode: 'auto' | 'auto-low-disk' | 'auto-fallback' }}
 */
function chooseDiskCache(dataDir, deps) {
  const options = deps && typeof deps === 'object' ? deps : {};
  let freeBytes = null;
  try {
    freeBytes = typeof options.measureFreeBytes === 'function'
      ? options.measureFreeBytes(dataDir)
      : measureFreeBytes(dataDir, options.statfs ? { statfs: options.statfs } : {});
  } catch {
    freeBytes = null;
  }
  if (!Number.isFinite(freeBytes)) {
    return { limitBytes: autoDiskCacheBytes(Number.NaN), freeBytes: null, mode: 'auto-fallback' };
  }
  const mode = freeBytes < AUTO_CACHE.lowDiskFreeBytes ? 'auto-low-disk' : 'auto';
  return { limitBytes: autoDiskCacheBytes(freeBytes), freeBytes, mode };
}

/**
 * Chromium `--disk-cache-size` value, in bytes.
 * @param {number} limitBytes
 * @returns {string}
 */
function diskCacheSwitchValue(limitBytes) {
  const n = Number.isFinite(limitBytes) ? Math.round(limitBytes) : AUTO_CACHE.minBytes;
  return String(n);
}

/**
 * How full the HTTP cache is relative to the configured limit.
 * `ratio` is null when either side is missing or the limit is not a positive finite number.
 * `nearFull` is true only when ratio is above 0.9.
 * @param {{ cacheBytes?: number | null, limitBytes?: number | null } | null | undefined} state
 * @returns {{ ratio: number | null, nearFull: boolean }}
 */
function describeCacheState(state) {
  const cacheBytes = state && state.cacheBytes;
  const limitBytes = state && state.limitBytes;
  if (!Number.isFinite(cacheBytes) || !Number.isFinite(limitBytes) || limitBytes <= 0) {
    return { ratio: null, nearFull: false };
  }
  const ratio = Math.min(1, Math.max(0, cacheBytes / limitBytes));
  return { ratio, nearFull: ratio > 0.9 };
}

/**
 * Order of a Full Refresh: drop the HTTP cache, then reload past it.
 * Cookies and other storage are not part of this plan.
 * @returns {['clearCache', 'reloadIgnoringCache']}
 */
function fullRefreshPlan() {
  return ['clearCache', 'reloadIgnoringCache'];
}

module.exports = {
  AUTO_CACHE,
  autoDiskCacheBytes,
  measureFreeBytes,
  chooseDiskCache,
  diskCacheSwitchValue,
  describeCacheState,
  fullRefreshPlan,
};
