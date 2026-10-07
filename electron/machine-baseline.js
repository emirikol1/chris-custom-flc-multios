'use strict';

/**
 * A short deterministic CPU micro-benchmark stored as ops per millisecond.
 * The file holds only speedIndex, measuredAt, and cpuCount.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

/** Inner-loop count chosen so one run is about 50 ms on a typical desktop. */
const DEFAULT_ITERATIONS = 20000;
const RUNS = 5;

const BENCH = Object.freeze({
  n: 7,
  flag: true,
  values: Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15, 16]),
  nested: Object.freeze({ a: 1, b: 2, c: 3, d: 4 }),
});

/**
 * @param {number[]} values
 * @returns {number}
 */
function median(values) {
  const xs = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  if (xs.length % 2 === 1) return xs[mid];
  return (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * @param {number} iterations
 * @returns {number} ops per millisecond
 */
function runOnce(iterations) {
  const n = iterations;
  const started = performance.now();
  let acc = 0;
  for (let i = 0; i < n; i += 1) {
    const text = JSON.stringify(BENCH);
    const parsed = JSON.parse(text);
    const base = parsed.values[i % 16] + (i % 17);
    acc += Math.sqrt(base) + Math.sin(i % 11);
  }
  if (acc === Number.POSITIVE_INFINITY) acc = 0;
  const elapsed = performance.now() - started;
  const ms = elapsed > 0 ? elapsed : 0.001;
  return n / ms;
}

/**
 * Median ops/ms of five runs. `iterations` overrides the inner loop count
 * (tests pass a small count). The default is a ~50 ms run.
 * @param {{ iterations?: number }} [opts]
 * @returns {number}
 */
function measureSpeedIndex(opts) {
  const requested = opts && opts.iterations;
  const iterations = typeof requested === 'number' && Number.isFinite(requested) && requested > 0
    ? Math.floor(requested)
    : DEFAULT_ITERATIONS;
  const samples = [];
  for (let i = 0; i < RUNS; i += 1) samples.push(runOnce(iterations));
  const value = median(samples);
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0;
}

/**
 * @param {unknown} parsed
 * @returns {{ speedIndex: number, measuredAt: number, cpuCount: number | null } | null}
 */
function sanitize(parsed) {
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
  const speedIndex = parsed.speedIndex;
  const measuredAt = parsed.measuredAt;
  if (typeof speedIndex !== 'number' || !Number.isFinite(speedIndex) || !(speedIndex > 0)) return null;
  if (typeof measuredAt !== 'number' || !Number.isFinite(measuredAt)) return null;
  let cpuCount = null;
  if (typeof parsed.cpuCount === 'number' && Number.isFinite(parsed.cpuCount) && parsed.cpuCount >= 0) {
    cpuCount = parsed.cpuCount;
  }
  return { speedIndex, measuredAt, cpuCount };
}

/**
 * @param {{
 *   filePath: string,
 *   now?: () => number,
 *   cpuCount?: () => number | null,
 *   measure?: () => number,
 * }} opts
 */
function createMachineBaseline(opts) {
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : '';
  const clock = opts && typeof opts.now === 'function' ? opts.now : Date.now;
  const cpuCount = opts && typeof opts.cpuCount === 'function' ? opts.cpuCount : () => {
    try {
      const list = os.cpus();
      return Array.isArray(list) ? list.length : null;
    } catch {
      return null;
    }
  };
  const measure = opts && typeof opts.measure === 'function' ? opts.measure : () => measureSpeedIndex();

  /** @type {{ speedIndex: number, measuredAt: number, cpuCount: number | null } | null} */
  let current = null;

  function readFile() {
    if (!filePath) return null;
    try {
      if (!fs.existsSync(filePath)) return null;
      return sanitize(JSON.parse(fs.readFileSync(filePath, 'utf8')));
    } catch {
      return null;
    }
  }

  /**
   * @param {{ speedIndex: number, measuredAt: number, cpuCount: number | null }} record
   */
  function writeFile(record) {
    if (!filePath) return;
    const dir = path.dirname(filePath);
    const tmp = `${filePath}.${process.pid}.tmp`;
    fs.mkdirSync(dir, { recursive: true });
    const body = JSON.stringify({
      speedIndex: record.speedIndex,
      measuredAt: record.measuredAt,
      cpuCount: record.cpuCount,
    });
    fs.writeFileSync(tmp, body, { encoding: 'utf8', mode: 0o600 });
    fs.renameSync(tmp, filePath);
  }

  function load() {
    try {
      current = readFile();
    } catch {
      current = null;
    }
    return get();
  }

  function get() {
    if (!current) return null;
    return {
      speedIndex: current.speedIndex,
      measuredAt: current.measuredAt,
      cpuCount: current.cpuCount,
    };
  }

  function refresh() {
    try {
      const speedIndex = measure();
      if (typeof speedIndex !== 'number' || !Number.isFinite(speedIndex) || !(speedIndex > 0)) {
        return get();
      }
      let count = null;
      try {
        const raw = cpuCount();
        if (typeof raw === 'number' && Number.isFinite(raw) && raw >= 0) count = raw;
      } catch {
        count = null;
      }
      let measuredAt = Date.now();
      try {
        const stamp = clock();
        if (typeof stamp === 'number' && Number.isFinite(stamp)) measuredAt = stamp;
      } catch {
        measuredAt = Date.now();
      }
      current = { speedIndex, measuredAt, cpuCount: count };
      try {
        writeFile(current);
      } catch {
        /* keep the in-memory sample */
      }
      return get();
    } catch {
      return get();
    }
  }

  load();

  return { load, refresh, get };
}

module.exports = {
  DEFAULT_ITERATIONS,
  measureSpeedIndex,
  createMachineBaseline,
};
