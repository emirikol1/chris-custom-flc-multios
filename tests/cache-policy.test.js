import { describe, expect, it } from 'vitest';
import {
  AUTO_CACHE,
  autoDiskCacheBytes,
  chooseDiskCache,
  describeCacheState,
  diskCacheSwitchValue,
  fullRefreshPlan,
  measureFreeBytes,
} from '../electron/cache-policy.js';

const MiB = 1024 * 1024;
const GiB = 1024 * MiB;

describe('AUTO_CACHE', () => {
  it('budgets 10% of free space between 512 MiB and 4 GiB, and shrinks on a low disk', () => {
    expect(AUTO_CACHE).toEqual({
      fractionOfFree: 0.10,
      minBytes: 512 * MiB,
      maxBytes: 4 * GiB,
      lowDiskFreeBytes: 2 * GiB,
      lowDiskCacheBytes: 256 * MiB,
    });
  });
});

describe('autoDiskCacheBytes', () => {
  it('uses the minimum when free space is not finite', () => {
    expect(autoDiskCacheBytes(Number.NaN)).toBe(AUTO_CACHE.minBytes);
    expect(autoDiskCacheBytes(undefined)).toBe(AUTO_CACHE.minBytes);
    expect(autoDiskCacheBytes(null)).toBe(AUTO_CACHE.minBytes);
    expect(autoDiskCacheBytes(Number.POSITIVE_INFINITY)).toBe(AUTO_CACHE.minBytes);
  });

  it('uses the low-disk budget when free space is under 2 GiB', () => {
    expect(autoDiskCacheBytes(GiB)).toBe(AUTO_CACHE.lowDiskCacheBytes);
    expect(autoDiskCacheBytes(AUTO_CACHE.lowDiskFreeBytes - 1)).toBe(AUTO_CACHE.lowDiskCacheBytes);
  });

  it('clamps 10% of free space up to the minimum and down to the maximum', () => {
    expect(autoDiskCacheBytes(AUTO_CACHE.lowDiskFreeBytes)).toBe(AUTO_CACHE.minBytes);
    const plenty = 80 * GiB;
    expect(autoDiskCacheBytes(plenty)).toBe(AUTO_CACHE.maxBytes);
    const mid = 20 * GiB;
    expect(autoDiskCacheBytes(mid)).toBe(Math.round(mid * AUTO_CACHE.fractionOfFree));
    expect(autoDiskCacheBytes(mid)).toBeGreaterThan(AUTO_CACHE.minBytes);
    expect(autoDiskCacheBytes(mid)).toBeLessThan(AUTO_CACHE.maxBytes);
    expect(Number.isInteger(autoDiskCacheBytes(mid))).toBe(true);
  });
});

describe('measureFreeBytes', () => {
  it('returns bavail * bsize and null when statfs throws', () => {
    const dir = '/data';
    expect(measureFreeBytes(dir, { statfs: (got) => {
      expect(got).toBe(dir);
      return { bavail: 10, bsize: 4096 };
    } })).toBe(40960);
    expect(measureFreeBytes(dir, { statfs: () => { throw new Error('statfs failed'); } })).toBeNull();
  });
});

describe('chooseDiskCache', () => {
  it('reports auto, auto-low-disk, and auto-fallback', () => {
    const bytes = (free) => () => ({ bavail: free, bsize: 1 });
    expect(chooseDiskCache('/data', { statfs: bytes(20 * GiB) })).toEqual({
      limitBytes: autoDiskCacheBytes(20 * GiB),
      freeBytes: 20 * GiB,
      mode: 'auto',
    });
    expect(chooseDiskCache('/data', { statfs: bytes(GiB) })).toEqual({
      limitBytes: AUTO_CACHE.lowDiskCacheBytes,
      freeBytes: GiB,
      mode: 'auto-low-disk',
    });
    expect(chooseDiskCache('/data', { statfs: () => { throw new Error('missing'); } })).toEqual({
      limitBytes: AUTO_CACHE.minBytes,
      freeBytes: null,
      mode: 'auto-fallback',
    });
    expect(diskCacheSwitchValue(AUTO_CACHE.minBytes)).toBe(String(AUTO_CACHE.minBytes));
  });
});

describe('describeCacheState', () => {
  it('reports a ratio in 0..1 and near-full only above 90%', () => {
    expect(describeCacheState({ cacheBytes: 0, limitBytes: 100 })).toEqual({ ratio: 0, nearFull: false });
    expect(describeCacheState({ cacheBytes: 50, limitBytes: 100 })).toEqual({ ratio: 0.5, nearFull: false });
    const atEdge = describeCacheState({ cacheBytes: 90, limitBytes: 100 });
    expect(atEdge.ratio).toBeCloseTo(0.9, 10);
    expect(atEdge.nearFull).toBe(false);
    const over = describeCacheState({ cacheBytes: 91, limitBytes: 100 });
    expect(over.ratio).toBeCloseTo(0.91, 10);
    expect(over.nearFull).toBe(true);
    expect(describeCacheState({ cacheBytes: 15, limitBytes: 16 })).toEqual({ ratio: 0.9375, nearFull: true });
    expect(describeCacheState({ cacheBytes: 250, limitBytes: 100 })).toEqual({ ratio: 1, nearFull: true });
    expect(describeCacheState({ cacheBytes: -20, limitBytes: 100 })).toEqual({ ratio: 0, nearFull: false });
  });

  it('returns a null ratio when the sizes cannot be compared', () => {
    expect(describeCacheState({ cacheBytes: null, limitBytes: 100 })).toEqual({ ratio: null, nearFull: false });
    expect(describeCacheState({ cacheBytes: 10, limitBytes: 0 })).toEqual({ ratio: null, nearFull: false });
    expect(describeCacheState({ cacheBytes: 10, limitBytes: -5 })).toEqual({ ratio: null, nearFull: false });
    expect(describeCacheState({ cacheBytes: Number.NaN, limitBytes: 100 })).toEqual({ ratio: null, nearFull: false });
    expect(describeCacheState(undefined)).toEqual({ ratio: null, nearFull: false });
    expect(describeCacheState({})).toEqual({ ratio: null, nearFull: false });
  });
});

describe('fullRefreshPlan', () => {
  it('clears the cache before reloading past it', () => {
    expect(fullRefreshPlan()).toEqual(['clearCache', 'reloadIgnoringCache']);
    const plan = fullRefreshPlan();
    plan.push('nope');
    expect(fullRefreshPlan()).toEqual(['clearCache', 'reloadIgnoringCache']);
  });
});
