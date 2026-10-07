'use strict';

/**
 * Fuel-gauge math for one world join. Pure: no Electron, no I/O.
 *
 * expectedTotals(historyRecordOrNull)
 *   Last join for this server. Pass a flat history row, a snapshot, or the
 *   server's row list (the last row is used). Unknown totals stay null.
 *   requests  ← requests, else transfers.requests
 *   docs      ← docs, else world.docs, else the sum of world.documents
 *   packages  ← packages, else activeModuleCount, else world.activeModuleCount,
 *               else world.modules.length, else world.hookTime.packages
 *   textures  ← textures, else world.textures
 *   phaseMs   ← durations.*Ms, else the flat *Ms fields:
 *               login, pageLoad, transfers, worldData, init, i18n, setup, canvas
 *   worldBytesEstimate, worldDataBytes, and transferBytes are not counts.
 *
 * computeFills(live, expected, nowMs) → { files, cache, objects, modules, scene }
 *   cache is null until at least CACHE_MIN_REQUESTS requests have been seen,
 *   then cachedRequests / requests. Phase completion does not force cache to 1.
 *   For the other gauges the first match wins:
 *     1. The gauge's phase is complete → 1
 *     2. live count / live total (total must be > 0)
 *     3. live count / expected total from history
 *     4. elapsed phase ms / expected phase ms, capped at 0.95 until the phase completes
 *     5. 0
 *   A live count of 0 with a positive total stays 0. It does not fall through to the clock.
 *
 *   Completion comes from live.done[id] === true, a name in live.completedPhases
 *   (array or map of true), or phases[clock].done === true on the primary clock:
 *     files:   pageLoad, socketConnected
 *     objects: setup
 *     modules: setup
 *     scene:   canvas, canvasReady
 *     ready:   files, objects, modules, and scene
 *   `init` and `worldDataReceived` do not finish a gauge. Module hooks keep
 *   running through setup, so objects and modules complete together and the
 *   row does not fill from the right.
 *
 *   Clocks use the same timeline as nowMs. The first present start is used.
 *     files:   phases.pageLoad or phaseStart.pageLoad; duration pageLoad, else transfers
 *     objects: phases.setup; duration setup
 *     modules: phases.setup, else phases.init; duration setup, else init
 *     scene:   phases.canvas; duration canvas
 *   startMs may also live on live.phaseStart[clock].
 *
 *   Counts, nested box winning only when both count and total are usable:
 *     files:   requests / requestsTotal, or files.count / files.total
 *     cache:   cachedRequests and requests, or cache.cached / cache.requests
 *              (cache.count / cache.total are accepted aliases)
 *     objects: docs / docsTotal, or objects.count / objects.total
 *     modules: packages / packagesTotal, or modules.count / modules.total
 *     scene:   textures / texturesTotal, or scene.count / scene.total
 *
 * monotonic(prev, next) keeps the higher number. A null cache does not erase
 * a ratio already seen, and a ratio does not erase a higher one.
 * gaugeColor(fill) blends #d9372b → #e0a100 → #2fb344 in HSL.
 */

const CACHE_MIN_REQUESTS = 5;

const GAUGES = Object.freeze([
  Object.freeze({ id: 'files', label: 'Files', shortLabel: 'Files' }),
  Object.freeze({ id: 'cache', label: 'Cache hit', shortLabel: 'Cache' }),
  Object.freeze({ id: 'objects', label: 'Objects', shortLabel: 'Objects' }),
  Object.freeze({ id: 'modules', label: 'Modules', shortLabel: 'Modules' }),
  Object.freeze({ id: 'scene', label: 'Scene', shortLabel: 'Scene' }),
]);

const PHASE_NAMES = Object.freeze([
  'login',
  'pageLoad',
  'transfers',
  'worldData',
  'init',
  'i18n',
  'setup',
  'canvas',
]);

const PHASE_FIELDS = Object.freeze({
  login: 'loginMs',
  pageLoad: 'pageLoadMs',
  transfers: 'transfersMs',
  worldData: 'worldDataMs',
  init: 'initMs',
  i18n: 'i18nMs',
  setup: 'setupMs',
  canvas: 'canvasMs',
});

/** Primary clock, then fallbacks. Completion uses only the primary name plus DONE_NAMES. */
const CLOCKS = Object.freeze({
  files: Object.freeze(['pageLoad']),
  objects: Object.freeze(['setup']),
  modules: Object.freeze(['setup', 'init']),
  scene: Object.freeze(['canvas']),
});

const DURATION_KEYS = Object.freeze({
  files: Object.freeze(['pageLoad', 'transfers']),
  objects: Object.freeze(['setup']),
  modules: Object.freeze(['setup', 'init']),
  scene: Object.freeze(['canvas']),
});

const DONE_NAMES = Object.freeze({
  files: Object.freeze(['pageLoad', 'socketConnected']),
  objects: Object.freeze(['setup']),
  modules: Object.freeze(['setup']),
  scene: Object.freeze(['canvas', 'canvasReady']),
});

const COUNT_FIELDS = Object.freeze({
  files: Object.freeze({ box: 'files', count: 'requests', total: 'requestsTotal' }),
  objects: Object.freeze({ box: 'objects', count: 'docs', total: 'docsTotal' }),
  modules: Object.freeze({ box: 'modules', count: 'packages', total: 'packagesTotal' }),
  scene: Object.freeze({ box: 'scene', count: 'textures', total: 'texturesTotal' }),
});

const RED = '#d9372b';
const AMBER = '#e0a100';
const GREEN = '#2fb344';

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function positive(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function nonNeg(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} input
 * @returns {object | null}
 */
function recordOf(input) {
  if (Array.isArray(input)) {
    if (!input.length) return null;
    const last = input[input.length - 1];
    return isPlain(last) ? last : null;
  }
  return isPlain(input) ? input : null;
}

/**
 * @param {object | null} documents
 * @returns {number | null}
 */
function sumDocs(documents) {
  if (!isPlain(documents)) return null;
  const keys = Object.keys(documents);
  let total = 0;
  let any = false;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    if (key === '__proto__' || key === 'constructor' || key === 'prototype') continue;
    const n = nonNeg(documents[key]);
    if (n == null) continue;
    total += n;
    any = true;
  }
  return any && total > 0 ? total : null;
}

/**
 * @param {object} record
 * @returns {number | null}
 */
function requestsOf(record) {
  const direct = positive(record.requests);
  if (direct != null) return direct;
  if (!isPlain(record.transfers)) return null;
  return positive(record.transfers.requests);
}

/**
 * @param {object} record
 * @returns {number | null}
 */
function docsOf(record) {
  const direct = positive(record.docs);
  if (direct != null) return direct;
  if (!isPlain(record.world)) return null;
  const nested = positive(record.world.docs);
  if (nested != null) return nested;
  return sumDocs(record.world.documents);
}

/**
 * @param {object} record
 * @returns {number | null}
 */
function packagesOf(record) {
  const direct = positive(record.packages);
  if (direct != null) return direct;
  const active = positive(record.activeModuleCount);
  if (active != null) return active;
  const world = isPlain(record.world) ? record.world : null;
  if (world) {
    const worldActive = positive(world.activeModuleCount);
    if (worldActive != null) return worldActive;
    if (Array.isArray(world.modules) && world.modules.length > 0) return world.modules.length;
    if (isPlain(world.hookTime)) {
      const hooked = positive(world.hookTime.packages);
      if (hooked != null) return hooked;
    }
  }
  if (isPlain(record.hookTime)) return positive(record.hookTime.packages);
  return null;
}

/**
 * @param {object} record
 * @returns {number | null}
 */
function texturesOf(record) {
  const direct = positive(record.textures);
  if (direct != null) return direct;
  if (!isPlain(record.world)) return null;
  return positive(record.world.textures);
}

/**
 * @param {object} record
 * @returns {Record<string, number | null>}
 */
function phaseMsOf(record) {
  const durations = isPlain(record.durations) ? record.durations : null;
  const nested = isPlain(record.phaseMs) ? record.phaseMs : null;
  /** @type {Record<string, number | null>} */
  const out = {};
  for (let i = 0; i < PHASE_NAMES.length; i += 1) {
    const name = PHASE_NAMES[i];
    const field = PHASE_FIELDS[name];
    let value = durations ? positive(durations[field]) : null;
    if (value == null) value = positive(record[field]);
    if (value == null && nested) value = positive(nested[name]);
    out[name] = value;
  }
  return out;
}

/**
 * @param {unknown} historyRecordOrNull
 * @returns {{ requests: number | null, docs: number | null, packages: number | null, textures: number | null, phaseMs: Record<string, number | null> }}
 */
function expectedTotals(historyRecordOrNull) {
  const record = recordOf(historyRecordOrNull);
  if (!record) {
    return {
      requests: null,
      docs: null,
      packages: null,
      textures: null,
      phaseMs: phaseMsOf({}),
    };
  }
  return {
    requests: requestsOf(record),
    docs: docsOf(record),
    packages: packagesOf(record),
    textures: texturesOf(record),
    phaseMs: phaseMsOf(record),
  };
}

/**
 * @param {unknown} expected
 * @returns {ReturnType<typeof expectedTotals>}
 */
function asExpected(expected) {
  if (!isPlain(expected) || !isPlain(expected.phaseMs)) return expectedTotals(expected);
  return {
    requests: positive(expected.requests),
    docs: positive(expected.docs),
    packages: positive(expected.packages),
    textures: positive(expected.textures),
    phaseMs: phaseMsOf(expected),
  };
}

/**
 * @param {object} live
 * @param {string} boxKey
 * @param {string} countKey
 * @param {string} totalKey
 * @returns {{ count: number | null, total: number | null }}
 */
function readPair(live, boxKey, countKey, totalKey) {
  const box = live[boxKey];
  if (isPlain(box)) {
    const count = nonNeg(box.count);
    const total = positive(box.total);
    if (count != null && total != null) return { count, total };
  }
  return {
    count: nonNeg(live[countKey]),
    total: positive(live[totalKey]),
  };
}

/**
 * @param {number | null} count
 * @param {number | null} total
 * @returns {number | null}
 */
function ratio(count, total) {
  if (count == null || total == null || !(total > 0)) return null;
  if (count <= 0) return 0;
  if (count >= total) return 1;
  return count / total;
}

/**
 * @param {object} live
 * @param {string[]} names
 * @returns {boolean}
 */
function hasPhase(live, names) {
  const list = live.completedPhases;
  for (let i = 0; i < names.length; i += 1) {
    const name = names[i];
    if (Array.isArray(list)) {
      for (let j = 0; j < list.length; j += 1) {
        if (list[j] === name) return true;
      }
    } else if (isPlain(list) && list[name] === true) {
      return true;
    }
  }
  return false;
}

/**
 * @param {object} live
 * @param {string} id
 * @returns {boolean}
 */
function isDone(live, id) {
  if (isPlain(live.done) && live.done[id] === true) return true;
  if (hasPhase(live, ['ready'])) return true;
  if (hasPhase(live, DONE_NAMES[id])) return true;
  const primary = CLOCKS[id][0];
  const phases = isPlain(live.phases) ? live.phases : null;
  const node = phases ? phases[primary] : null;
  if (isPlain(node) && node.done === true) return true;
  return false;
}

/**
 * @param {object} live
 * @param {string} id
 * @returns {number | null}
 */
function clockStart(live, id) {
  const keys = CLOCKS[id];
  const phases = isPlain(live.phases) ? live.phases : null;
  const phaseStart = isPlain(live.phaseStart) ? live.phaseStart : null;
  for (let i = 0; i < keys.length; i += 1) {
    const key = keys[i];
    const node = phases ? phases[key] : null;
    if (isPlain(node) && nonNeg(node.startMs) != null) return node.startMs;
    if (phaseStart && nonNeg(phaseStart[key]) != null) return phaseStart[key];
  }
  return null;
}

/**
 * @param {ReturnType<typeof expectedTotals>} expected
 * @param {string} id
 * @returns {number | null}
 */
function durationOf(expected, id) {
  const keys = DURATION_KEYS[id];
  const phaseMs = expected.phaseMs;
  for (let i = 0; i < keys.length; i += 1) {
    const n = positive(phaseMs[keys[i]]);
    if (n != null) return n;
  }
  return null;
}

/**
 * @param {number | null} elapsed
 * @param {number | null} expectedMs
 * @returns {number | null}
 */
function timeFill(elapsed, expectedMs) {
  if (elapsed == null || expectedMs == null || !(expectedMs > 0)) return null;
  if (elapsed <= 0) return 0;
  const t = elapsed / expectedMs;
  if (t >= 0.95) return 0.95;
  return t;
}

/**
 * @param {object} live
 * @returns {number | null}
 */
function cacheFill(live) {
  const box = isPlain(live.cache) ? live.cache : null;
  let cached = null;
  let requests = null;
  if (box) {
    cached = nonNeg(box.cached);
    if (cached == null) cached = nonNeg(box.count);
    requests = nonNeg(box.requests);
    if (requests == null) requests = nonNeg(box.total);
  }
  if (requests == null) {
    requests = nonNeg(live.requests);
    if (cached == null) cached = nonNeg(live.cachedRequests);
  } else if (cached == null) {
    cached = nonNeg(live.cachedRequests);
  }
  if (requests == null || requests < CACHE_MIN_REQUESTS || cached == null) return null;
  return ratio(cached, requests);
}

/**
 * @param {object} live
 * @param {ReturnType<typeof expectedTotals>} expected
 * @param {unknown} nowMs
 * @param {string} id
 * @returns {number}
 */
function gaugeFill(live, expected, nowMs, id) {
  if (isDone(live, id)) return 1;
  const fields = COUNT_FIELDS[id];
  const pair = readPair(live, fields.box, fields.count, fields.total);
  const liveRatio = ratio(pair.count, pair.total);
  if (liveRatio != null) return liveRatio;
  const expectedTotal = positive(expected[id === 'files' ? 'requests' : id === 'objects' ? 'docs' : id === 'modules' ? 'packages' : 'textures']);
  const historyRatio = ratio(pair.count, expectedTotal);
  if (historyRatio != null) return historyRatio;
  const start = clockStart(live, id);
  const now = typeof nowMs === 'number' && Number.isFinite(nowMs) ? nowMs : null;
  const elapsed = start == null || now == null ? null : now - start;
  const timed = timeFill(elapsed, durationOf(expected, id));
  return timed == null ? 0 : timed;
}

/**
 * @param {unknown} live
 * @param {unknown} expected
 * @param {unknown} nowMs
 * @returns {{ files: number, cache: number | null, objects: number, modules: number, scene: number }}
 */
function computeFills(live, expected, nowMs) {
  const row = isPlain(live) ? live : {};
  const totals = asExpected(expected);
  return {
    files: gaugeFill(row, totals, nowMs, 'files'),
    cache: cacheFill(row),
    objects: gaugeFill(row, totals, nowMs, 'objects'),
    modules: gaugeFill(row, totals, nowMs, 'modules'),
    scene: gaugeFill(row, totals, nowMs, 'scene'),
  };
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function unit(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null;
  if (value < 0) return 0;
  if (value > 1) return 1;
  return value;
}

/**
 * @param {unknown} prevFills
 * @param {unknown} nextFills
 * @returns {{ files: number, cache: number | null, objects: number, modules: number, scene: number }}
 */
function monotonic(prevFills, nextFills) {
  const prev = isPlain(prevFills) ? prevFills : {};
  const next = isPlain(nextFills) ? nextFills : {};
  const ids = ['files', 'objects', 'modules', 'scene'];
  /** @type {{ files: number, cache: number | null, objects: number, modules: number, scene: number }} */
  const out = { files: 0, cache: null, objects: 0, modules: 0, scene: 0 };
  for (let i = 0; i < ids.length; i += 1) {
    const id = ids[i];
    const prior = unit(prev[id]);
    const step = unit(next[id]);
    const base = prior == null ? 0 : prior;
    out[id] = Math.max(base, step == null ? base : step);
  }
  const priorCache = unit(prev.cache);
  const nextCache = unit(next.cache);
  if (priorCache == null) out.cache = nextCache;
  else if (nextCache == null) out.cache = priorCache;
  else out.cache = Math.max(priorCache, nextCache);
  return out;
}

/**
 * @param {string} hex
 * @returns {[number, number, number]}
 */
function hexToRgb(hex) {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

/**
 * @param {number} r
 * @param {number} g
 * @param {number} b
 * @returns {[number, number, number]}
 */
function rgbToHsl(r, g, b) {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h;
  if (max === rn) h = (gn - bn) / d + (gn < bn ? 6 : 0);
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  return [h * 60, s, l];
}

/**
 * @param {number} h
 * @param {number} s
 * @param {number} l
 * @returns {[number, number, number]}
 */
function hslToRgb(h, s, l) {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = (((h % 360) + 360) % 360) / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) { r = c; g = x; }
  else if (hp < 2) { r = x; g = c; }
  else if (hp < 3) { g = c; b = x; }
  else if (hp < 4) { g = x; b = c; }
  else if (hp < 5) { r = x; b = c; }
  else { r = c; b = x; }
  const m = l - c / 2;
  return [
    Math.round((r + m) * 255),
    Math.round((g + m) * 255),
    Math.round((b + m) * 255),
  ];
}

/**
 * @param {number} n
 * @returns {string}
 */
function hexByte(n) {
  const s = n.toString(16);
  return s.length < 2 ? `0${s}` : s;
}

/**
 * @param {string} from
 * @param {string} to
 * @param {number} t
 * @returns {string}
 */
function lerpHex(from, to, t) {
  const fromRgb = hexToRgb(from);
  const toRgb = hexToRgb(to);
  const a = rgbToHsl(fromRgb[0], fromRgb[1], fromRgb[2]);
  const b = rgbToHsl(toRgb[0], toRgb[1], toRgb[2]);
  let hueDelta = b[0] - a[0];
  if (hueDelta > 180) hueDelta -= 360;
  if (hueDelta < -180) hueDelta += 360;
  const hue = (a[0] + hueDelta * t + 360) % 360;
  const sat = a[1] + (b[1] - a[1]) * t;
  const light = a[2] + (b[2] - a[2]) * t;
  const rgb = hslToRgb(hue, sat, light);
  return `#${hexByte(rgb[0])}${hexByte(rgb[1])}${hexByte(rgb[2])}`;
}

/**
 * @param {unknown} fill
 * @returns {string}
 */
function gaugeColor(fill) {
  const t = typeof fill === 'number' && Number.isFinite(fill) ? fill : 0;
  if (t <= 0) return RED;
  if (t >= 1) return GREEN;
  if (t > 0.499999 && t < 0.500001) return AMBER;
  if (t < 0.5) return lerpHex(RED, AMBER, t / 0.5);
  return lerpHex(AMBER, GREEN, (t - 0.5) / 0.5);
}

module.exports = {
  CACHE_MIN_REQUESTS,
  GAUGES,
  expectedTotals,
  computeFills,
  monotonic,
  gaugeColor,
};
