'use strict';

/**
 * Main-process join telemetry. Pure functions: no Electron, no I/O.
 * Page `at` values are performance.now() milliseconds. The first page payload
 * of a load anchors them to this collector's wall clock.
 * Snapshot numbers are null when unknown — never undefined.
 */

const PHASES = Object.freeze([
  'connect',
  'joinPageLoaded',
  'autologinArmed',
  'autologinSubmitted',
  'gameNavigation',
  'domReady',
  'socketConnected',
  'worldDataReceived',
  'init',
  'i18nInit',
  'setup',
  'canvasReady',
  'ready',
]);

const PHASE_SET = new Set(PHASES);

/** Phases that arrive from the page script. Main marks the earlier ones. */
const PAGE_PHASES = new Set([
  'domReady',
  'init',
  'i18nInit',
  'setup',
  'canvasReady',
  'ready',
]);

const DOC_KEYS = Object.freeze([
  'actors',
  'items',
  'scenes',
  'journal',
  'tables',
  'macros',
  'playlists',
  'cards',
  'folders',
  'users',
  'messages',
  'packs',
]);

const SCENE_KEYS = Object.freeze(['tokens', 'tiles', 'lights', 'walls']);

const RESOURCE_KEYS = Object.freeze([
  'rendererHeapUsedBytes',
  'rendererHeapLimitBytes',
  'rendererCpuPercent',
  'rendererMemoryBytes',
  'gpuCpuPercent',
  'gpuMemoryBytes',
  'systemTotalBytes',
  'systemFreeBytes',
  'loadAvg1',
  'cacheBytes',
  'cacheLimitBytes',
]);

const TRANSFER_BUCKET_KEYS = Object.freeze([
  'requests',
  'transferBytes',
  'encodedBytes',
  'decodedBytes',
  'cachedRequests',
  'durationMs',
]);

const SYNC_CAUSES = new Set(['local-offline', 'server-unreachable', 'socket-stalled']);

const REQUEST_NAME = /^[A-Za-z0-9._-]{1,48}$/;
const PACKAGE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const RATE_WINDOW_MS = 30000;
const RATE_KEEP_MS = 90000;
const RTT_CAP = 200;
const NAME_CAP = 20;
const STRING_CAP = 64;
const URL_RE = /^[a-z]+:\/\//i;

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function finiteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * Short token strings only. Drops URLs, blanks, and anything over 64 chars.
 * @param {unknown} value
 * @returns {string | null}
 */
function safeString(value) {
  if (typeof value !== 'string') return null;
  const s = value.trim();
  if (!s || s.length > STRING_CAP || URL_RE.test(s)) return null;
  if (s === '__proto__' || s === 'constructor' || s === 'prototype') return null;
  return s;
}

/**
 * @param {number[]} values sorted or unsorted
 * @param {number} p percentile in the range 0..100
 * @returns {number | null}
 */
function percentile(values, p) {
  if (!Array.isArray(values) || typeof p !== 'number' || !Number.isFinite(p)) return null;
  const nums = [];
  for (let i = 0; i < values.length; i += 1) {
    const n = values[i];
    if (typeof n === 'number' && Number.isFinite(n)) nums.push(n);
  }
  if (!nums.length) return null;
  nums.sort((a, b) => a - b);
  const pct = Math.min(100, Math.max(0, p)) / 100;
  if (nums.length === 1) return nums[0];
  const rank = pct * (nums.length - 1);
  const lo = Math.floor(rank);
  const hi = Math.ceil(rank);
  if (lo === hi) return nums[lo];
  const w = rank - lo;
  return nums[lo] * (1 - w) + nums[hi] * w;
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatBytes(n) {
  if (typeof n !== 'number' || !Number.isFinite(n) || n < 0) return '0 B';
  const units = ['B', 'KB', 'MB', 'GB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  if (i === 0) return `${Math.round(v)} B`;
  const rounded = Math.round(v * 10) / 10;
  return `${rounded.toFixed(1)} ${units[i]}`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms)) return '0ms';
  const sign = ms < 0 ? '-' : '';
  const abs = Math.abs(ms);
  if (abs >= 1000) return `${sign}${(abs / 1000).toFixed(1)}s`;
  return `${sign}${Math.round(abs)}ms`;
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatSeconds(ms) {
  return `${(ms / 1000).toFixed(1)}s`;
}

/**
 * @param {number} n
 * @returns {string}
 */
function formatCount(n) {
  const sign = n < 0 ? '-' : '';
  const digits = Math.round(Math.abs(n)).toString();
  return sign + digits.replace(/\B(?=(\d{3})+(?!\d))/g, ',');
}

/**
 * @param {Record<string, unknown> | null | undefined} documents
 * @returns {number | null}
 */
function sumDocs(documents) {
  if (!isObject(documents)) return null;
  let sum = 0;
  let any = false;
  for (let i = 0; i < DOC_KEYS.length; i += 1) {
    const n = documents[DOC_KEYS[i]];
    if (typeof n === 'number' && Number.isFinite(n)) {
      sum += n;
      any = true;
    }
  }
  return any ? sum : null;
}

function sumDocumentBytes(bytes) {
  if (!isObject(bytes)) return null;
  let sum = 0;
  let any = false;
  for (let i = 0; i < DOC_KEYS.length; i += 1) {
    const n = bytes[DOC_KEYS[i]];
    if (typeof n === 'number' && Number.isFinite(n) && n >= 0) {
      sum += n;
      any = true;
    }
  }
  return any ? sum : null;
}

function emptyDocuments() {
  const docs = {};
  for (let i = 0; i < DOC_KEYS.length; i += 1) docs[DOC_KEYS[i]] = null;
  return docs;
}

function emptyScene() {
  return { tokens: null, tiles: null, lights: null, walls: null };
}

function emptyDocumentBytes() {
  const bytes = {};
  for (let i = 0; i < DOC_KEYS.length; i += 1) bytes[DOC_KEYS[i]] = null;
  return bytes;
}

function emptyWorld() {
  return {
    foundryVersion: null,
    generation: null,
    system: { id: null, version: null },
    modules: [],
    activeModuleCount: 0,
    documents: emptyDocuments(),
    documentBytes: emptyDocumentBytes(),
    documentBytesComplete: false,
    scene: emptyScene(),
    performanceMode: null,
    fps: null,
    hookTime: null,
  };
}

function emptyTransfers() {
  return {
    requests: null,
    transferBytes: null,
    encodedBytes: null,
    decodedBytes: null,
    cachedRequests: null,
    cacheHitRatio: null,
    revalidatedRequests: null,
    durationMs: null,
    busyMs: null,
    byType: {},
    ttfbP50Ms: null,
    ttfbP95Ms: null,
    downloadP95Ms: null,
    slowDownloads: null,
    cacheReadBytes: null,
    cacheReadMs: null,
    cacheReadP95Ms: null,
    cacheReadSlow: null,
    protocolH1: null,
    protocolH2: null,
    scriptH1: null,
  };
}

function emptySync() {
  return {
    state: 'unknown',
    connected: null,
    rttMs: null,
    rttMinMs: null,
    rttP50Ms: null,
    rttP95Ms: null,
    ackMinMs: null,
    pingJitterP95Ms: null,
    pingJitterSamples: 0,
    reconnects: 0,
    missedPongs: 0,
    lastPacketAgeMs: null,
    pingIntervalMs: null,
    pingTimeoutMs: null,
    cause: null,
    lastChangeAt: null,
    lastRequest: { name: null, ageMs: null, ms: null },
    lastMessageAgeMs: null,
    requestsPerMin: null,
    messagesPerMin: null,
  };
}

function emptyResources() {
  const resources = {};
  for (let i = 0; i < RESOURCE_KEYS.length; i += 1) resources[RESOURCE_KEYS[i]] = null;
  return resources;
}

function emptyClient() {
  return {
    rendererGone: { count: 0, lastReason: null },
    unresponsive: 0,
    pageErrors: { count: 0, byName: {} },
    longTasks: { count: 0, worstMs: null, totalMs: null, byPhase: {} },
    webglMode: null,
    webglFallbackReason: null,
    updateStatus: null,
    gpuGone: false,
  };
}

/**
 * @param {number | null} start
 * @param {number | null} end
 * @returns {number | null}
 */
/**
 * Silence longer than this on a connected socket means the link is stalled.
 * A live socket hears a server ping every interval, so two missed pings plus
 * slack is enough; the server's own timeout (Foundry sets minutes) is far too
 * lax to be useful here, so it only bounds the answer when known.
 * @param {number | null} pingIntervalMs
 * @param {number | null} pingTimeoutMs
 * @returns {number | null}
 */
/** Long tasks are keyed by the phase they started in; name the interval instead. */
const BLOCKED_INTERVALS = {
  'pre-init': 'before init',
  init: 'init→i18n',
  i18nInit: 'i18n→setup',
  setup: 'setup→canvas',
  canvasReady: 'canvas→ready',
  ready: 'after ready',
};

function staleThresholdMs(pingIntervalMs, pingTimeoutMs) {
  const pi = Number.isFinite(pingIntervalMs) && pingIntervalMs > 0 ? pingIntervalMs : null;
  const pt = Number.isFinite(pingTimeoutMs) && pingTimeoutMs > 0 ? pingTimeoutMs : null;
  if (pi == null && pt == null) return null;
  if (pi == null) return pt;
  const fromInterval = pi * 2 + 5000;
  if (pt == null) return fromInterval;
  return Math.min(fromInterval, pi + pt);
}

function lowerMs(a, b) {
  const x = finiteNumber(a);
  const y = finiteNumber(b);
  if (x == null) return y;
  if (y == null) return x;
  return x < y ? x : y;
}

function span(start, end) {
  if (start == null || end == null) return null;
  if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
  return end - start;
}

/**
 * @param {unknown} byType
 * @returns {Record<string, Record<string, number | null>>}
 */
function sanitizeByType(byType) {
  const out = {};
  if (!isObject(byType)) return out;
  const keys = Object.keys(byType);
  for (let i = 0; i < keys.length; i += 1) {
    const key = safeString(keys[i]);
    if (!key) continue;
    const src = byType[keys[i]];
    if (!isObject(src)) continue;
    const bucket = {};
    for (let k = 0; k < TRANSFER_BUCKET_KEYS.length; k += 1) {
      const field = TRANSFER_BUCKET_KEYS[k];
      bucket[field] = finiteNumber(src[field]);
    }
    out[key] = bucket;
  }
  return out;
}

/**
 * @param {{ now?: () => number }} [opts]
 */
function createCollector(opts) {
  const clockNow = opts && typeof opts.now === 'function' ? opts.now : Date.now;

  function now() {
    try {
      const n = clockNow();
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    } catch (err) {
      /* clock failed; fall through */
    }
    return Date.now();
  }

  let loadSeq = 0;
  let resetAt = now();
  let startedAt = null;
  /** @type {Record<string, number>} */
  let wallPhases = {};
  /** Wall clock ms corresponding to page performance.now() === 0. */
  let pageAnchor = null;
  let transfers = emptyTransfers();
  let worldData = { bytes: null, ms: null };
  let world = emptyWorld();
  let progress = emptyProgress();
  /** @type {number[]} */
  let rttSamples = [];
  /** @type {number[]} */
  let ackSamples = [];
  /** @type {Array<{ at: number, requestsOut: number, messagesIn: number }>} */
  let ratePoints = [];
  let sync = emptySync();
  let net = { errors: {}, httpStatus: { '4xx': 0, '5xx': 0 }, clockSkewMs: null };
  let client = emptyClient();
  let resources = emptyResources();
  let updatedAt = resetAt;

  function touch() {
    updatedAt = now();
  }

  function origin() {
    return startedAt != null ? startedAt : resetAt;
  }

  /**
   * @param {unknown} at
   * @returns {number | null}
   */
  function pageWall(at) {
    const n = finiteNumber(at);
    if (n == null) return null;
    if (pageAnchor == null) pageAnchor = now() - n;
    return pageAnchor + n;
  }

  /**
   * @param {string} name
   * @param {number} wall
   * @param {boolean} overwrite
   */
  function setPhaseWall(name, wall, overwrite) {
    if (!PHASE_SET.has(name) || !Number.isFinite(wall)) return;
    if (!overwrite && Object.prototype.hasOwnProperty.call(wallPhases, name)) return;
    wallPhases[name] = wall;
  }

  /**
   * @param {boolean | null} connected
   * @param {'synced' | 'out-of-sync' | 'unknown'} [state]
   */
  function assignLink(connected, state) {
    let changed = false;
    if (connected !== undefined && connected !== sync.connected) {
      sync.connected = connected;
      changed = true;
    }
    if (state !== undefined && state !== sync.state) {
      sync.state = state;
      changed = true;
    }
    if (changed) sync.lastChangeAt = now();
  }

  function applyScene(scene) {
    if (!isObject(scene)) return;
    for (let i = 0; i < SCENE_KEYS.length; i += 1) {
      const key = SCENE_KEYS[i];
      const n = finiteNumber(scene[key]);
      if (n != null) world.scene[key] = n;
    }
  }

  function applyPageErrors(pe) {
    if (!isObject(pe)) return;
    const byName = {};
    const keys = Object.keys(pe.byName && isObject(pe.byName) ? pe.byName : {});
    for (let i = 0; i < keys.length; i += 1) {
      if (Object.keys(byName).length >= NAME_CAP) break;
      const name = safeString(keys[i]);
      if (!name) continue;
      const n = finiteNumber(pe.byName[keys[i]]);
      if (n == null) continue;
      byName[name] = (byName[name] || 0) + n;
    }
    const err = finiteNumber(pe.error);
    const rejection = finiteNumber(pe.rejection);
    const warn = finiteNumber(pe.warn);
    let count = 0;
    if (err != null || rejection != null || warn != null) {
      count = (err || 0) + (rejection || 0) + (warn || 0);
    } else {
      const names = Object.keys(byName);
      for (let i = 0; i < names.length; i += 1) count += byName[names[i]];
    }
    client.pageErrors = { count, byName };
  }

  function applyLongTasks(lt) {
    if (!isObject(lt)) return;
    const count = finiteNumber(lt.count);
    const worst = finiteNumber(lt.worstMs);
    const total = finiteNumber(lt.totalMs);
    if (count != null) client.longTasks.count = count;
    if (worst != null) client.longTasks.worstMs = worst;
    if (total != null) client.longTasks.totalMs = total;
    if (isObject(lt.byPhase)) {
      const byPhase = {};
      const keys = Object.keys(lt.byPhase).slice(0, 8);
      for (let i = 0; i < keys.length; i += 1) {
        const v = finiteNumber(lt.byPhase[keys[i]]);
        if (v != null && /^[A-Za-z0-9-]{1,16}$/.test(keys[i])) byPhase[keys[i]] = v;
      }
      client.longTasks.byPhase = byPhase;
    }
  }

  function applyHookTime(hooks) {
    if (!isObject(hooks)) return;
    const totalMs = finiteNumber(hooks.totalMs);
    const packages = finiteNumber(hooks.packages);
    const source = Array.isArray(hooks.byPackage) ? hooks.byPackage : [];
    const ranked = [];
    let sum = 0;
    for (let i = 0; i < source.length; i += 1) {
      const row = source[i];
      if (!isObject(row)) continue;
      const id = typeof row.id === 'string' && PACKAGE_ID.test(row.id) ? row.id : '';
      const ms = finiteNumber(row.ms);
      const count = finiteNumber(row.count);
      if (!id || ms == null || ms < 0) continue;
      sum += ms;
      ranked.push({ id, ms, count: count != null && count >= 0 ? count : 0 });
    }
    ranked.sort((a, b) => b.ms - a.ms);
    const byPackage = ranked.slice(0, 15);
    if (!byPackage.length && !(totalMs > 0)) return;
    world.hookTime = {
      totalMs: totalMs != null && totalMs >= 0 ? totalMs : sum,
      packages: packages != null && packages >= 0 ? packages : ranked.length,
      byPackage,
    };
  }

  function ingestPhase(payload) {
    const name = safeString(payload.name);
    if (!name || !PAGE_PHASES.has(name)) return;
    const wall = pageWall(payload.at);
    if (wall == null) return;
    setPhaseWall(name, wall, false);
    if (name === 'ready') {
      applyPageErrors(payload.pageErrors);
      applyLongTasks(payload.longTasks);
      applyHookTime(payload.hooks);
    }
  }

  function applyPingJitter(payload) {
    const p95 = finiteNumber(payload.pingJitterP95Ms);
    const count = finiteNumber(payload.pingJitterSamples);
    if (p95 != null) sync.pingJitterP95Ms = p95;
    if (count != null) sync.pingJitterSamples = count;
  }

  function ingestSync(payload) {
    const event = safeString(payload.event);
    if (!event) return;
    const wall = pageWall(payload.at);
    if (event === 'connect') {
      if (wall != null) setPhaseWall('socketConnected', wall, false);
      assignLink(true, 'synced');
    } else if (event === 'disconnect') {
      if (wall != null) pageWall(payload.at);
      assignLink(false, 'out-of-sync');
    } else if (event === 'reconnect_attempt') {
      sync.reconnects += 1;
    } else if (event === 'pong') {
      const rtt = finiteNumber(payload.rttMs);
      if (rtt != null) {
        sync.rttMs = rtt;
        if (sync.rttMinMs == null || rtt < sync.rttMinMs) sync.rttMinMs = rtt;
        rttSamples.push(rtt);
        if (rttSamples.length > RTT_CAP) rttSamples.shift();
      }
    } else if (event === 'ack') {
      const ack = finiteNumber(payload.rttMs);
      if (ack != null) {
        if (sync.ackMinMs == null || ack < sync.ackMinMs) sync.ackMinMs = ack;
        ackSamples.push(ack);
        if (ackSamples.length > RTT_CAP) ackSamples.shift();
      }
    } else if (event === 'missed_ping') {
      sync.missedPongs += 1;
    } else if (event === 'config') {
      const pi = finiteNumber(payload.pingIntervalMs);
      const pt = finiteNumber(payload.pingTimeoutMs);
      if (pi != null) sync.pingIntervalMs = pi;
      if (pt != null) sync.pingTimeoutMs = pt;
    }
    applyPingJitter(payload);
  }

  function ingestWorldData(payload) {
    const wall = pageWall(payload.at);
    if (wall != null) setPhaseWall('worldDataReceived', wall, false);
    const bytes = finiteNumber(payload.bytes);
    const ms = finiteNumber(payload.sinceConnectMs);
    if (bytes != null) worldData.bytes = bytes;
    if (ms != null) worldData.ms = ms;
  }

  function ingestTransfers(payload) {
    pageWall(payload.at);
    const requests = finiteNumber(payload.requests);
    const cached = finiteNumber(payload.cachedRequests);
    let ratio = null;
    if (requests != null && requests > 0 && cached != null) {
      ratio = cached / requests;
      if (ratio < 0) ratio = 0;
      if (ratio > 1) ratio = 1;
    }
    transfers = {
      requests,
      transferBytes: finiteNumber(payload.transferBytes),
      encodedBytes: finiteNumber(payload.encodedBytes),
      decodedBytes: finiteNumber(payload.decodedBytes),
      cachedRequests: cached,
      cacheHitRatio: ratio,
      revalidatedRequests: finiteNumber(payload.revalidatedRequests),
      durationMs: finiteNumber(payload.durationMs),
      busyMs: finiteNumber(payload.busyMs),
      byType: sanitizeByType(payload.byType),
      ttfbP50Ms: finiteNumber(payload.ttfbP50Ms),
      ttfbP95Ms: finiteNumber(payload.ttfbP95Ms),
      downloadP95Ms: finiteNumber(payload.downloadP95Ms),
      slowDownloads: finiteNumber(payload.slowDownloads),
      cacheReadBytes: finiteNumber(payload.cacheReadBytes),
      cacheReadMs: finiteNumber(payload.cacheReadMs),
      cacheReadP95Ms: finiteNumber(payload.cacheReadP95Ms),
      cacheReadSlow: finiteNumber(payload.cacheReadSlow),
      protocolH1: finiteNumber(payload.protocolH1),
      protocolH2: finiteNumber(payload.protocolH2),
      scriptH1: finiteNumber(payload.scriptH1),
    };
  }

  function ingestWorld(payload) {
    pageWall(payload.at);
    const version = safeString(payload.foundryVersion);
    if (version) world.foundryVersion = version;
    const generation = finiteNumber(payload.generation);
    if (generation != null) world.generation = generation;
    if (isObject(payload.system)) {
      world.system = {
        id: safeString(payload.system.id),
        version: safeString(payload.system.version),
      };
    }
    if (Array.isArray(payload.modules)) {
      const modules = [];
      for (let i = 0; i < payload.modules.length && modules.length < 200; i += 1) {
        const m = payload.modules[i];
        if (!isObject(m)) continue;
        const id = safeString(m.id);
        if (!id) continue;
        modules.push({ id, version: safeString(m.version) });
      }
      world.modules = modules;
      const declared = finiteNumber(payload.activeModuleCount);
      world.activeModuleCount = declared != null ? declared : modules.length;
    } else if (finiteNumber(payload.activeModuleCount) != null) {
      world.activeModuleCount = finiteNumber(payload.activeModuleCount);
    }
    if (isObject(payload.documents)) {
      for (let i = 0; i < DOC_KEYS.length; i += 1) {
        const key = DOC_KEYS[i];
        const n = finiteNumber(payload.documents[key]);
        if (n != null) world.documents[key] = n;
      }
    }
    if (typeof payload.performanceMode === 'number' && Number.isFinite(payload.performanceMode)) {
      world.performanceMode = payload.performanceMode;
    } else {
      const mode = safeString(payload.performanceMode);
      if (mode) world.performanceMode = mode;
    }
    applyScene(payload.scene);
  }

  function requestToken(value) {
    return typeof value === 'string' && REQUEST_NAME.test(value) ? value : null;
  }

  function ingestWorldSizes(payload) {
    pageWall(payload.at);
    if (!isObject(payload.sizes)) return;
    for (let i = 0; i < DOC_KEYS.length; i += 1) {
      const key = DOC_KEYS[i];
      if (key === 'packs') continue;
      const n = finiteNumber(payload.sizes[key]);
      if (n != null && n >= 0) world.documentBytes[key] = n;
    }
    if (payload.complete === true) world.documentBytesComplete = true;
  }

  function noteRates(requestsOut, messagesIn) {
    const req = finiteNumber(requestsOut);
    const msg = finiteNumber(messagesIn);
    if (req == null && msg == null) return;
    const at = now();
    const prev = ratePoints.length ? ratePoints[ratePoints.length - 1] : null;
    if (prev && ((req != null && req < prev.requestsOut) || (msg != null && msg < prev.messagesIn))) {
      ratePoints = [];
    }
    const prior = ratePoints.length ? ratePoints[ratePoints.length - 1] : null;
    ratePoints.push({
      at,
      requestsOut: req != null ? req : (prior ? prior.requestsOut : 0),
      messagesIn: msg != null ? msg : (prior ? prior.messagesIn : 0),
    });
    const newest = ratePoints[ratePoints.length - 1].at;
    if (ratePoints.length > 1) {
      const kept = [];
      for (let i = 0; i < ratePoints.length; i += 1) {
        if (newest - ratePoints[i].at <= RATE_KEEP_MS) kept.push(ratePoints[i]);
      }
      ratePoints = kept;
    }
    const first = ratePoints[0];
    const last = ratePoints[ratePoints.length - 1];
    if (ratePoints.length < 2 || last.at - first.at < RATE_WINDOW_MS) {
      sync.requestsPerMin = null;
      sync.messagesPerMin = null;
      return;
    }
    const span = last.at - first.at;
    sync.requestsPerMin = ((last.requestsOut - first.requestsOut) / span) * 60000;
    sync.messagesPerMin = ((last.messagesIn - first.messagesIn) / span) * 60000;
  }

  function noteLastTraffic(payload) {
    const name = requestToken(payload.lastRequestName);
    const age = finiteNumber(payload.lastRequestAgeMs);
    const ms = finiteNumber(payload.lastRequestMs);
    if (name) sync.lastRequest.name = name;
    if (age != null && age >= 0) sync.lastRequest.ageMs = age;
    if (ms != null && ms >= 0) sync.lastRequest.ms = ms;
    const messageAge = finiteNumber(payload.lastMessageAgeMs);
    if (messageAge != null && messageAge >= 0) sync.lastMessageAgeMs = messageAge;
    noteRates(payload.requestsOut, payload.messagesIn);
  }

  function ingestSample(payload) {
    pageWall(payload.at);
    const heapUsed = finiteNumber(payload.heapUsedBytes);
    const heapLimit = finiteNumber(payload.heapLimitBytes);
    if (heapUsed != null) resources.rendererHeapUsedBytes = heapUsed;
    if (heapLimit != null) resources.rendererHeapLimitBytes = heapLimit;
    const fps = finiteNumber(payload.fps);
    if (fps != null) world.fps = fps;
    applyLongTasks(payload.longTasks);
    applyPageErrors(payload.pageErrors);
    applyScene(payload.scene);
    const age = finiteNumber(payload.lastPacketAgeMs);
    if (age != null) sync.lastPacketAgeMs = age;
    const stale = staleThresholdMs(sync.pingIntervalMs, sync.pingTimeoutMs);
    if (typeof payload.connected === 'boolean') {
      const connected = payload.connected;
      let state = 'synced';
      const ageKnown = age != null ? age : sync.lastPacketAgeMs;
      if (!connected) state = 'out-of-sync';
      else if (stale != null && ageKnown != null && ageKnown > stale) state = 'out-of-sync';
      assignLink(connected, state);
    } else if (age != null) {
      if (sync.connected === false) assignLink(sync.connected, 'out-of-sync');
      else if (stale != null && age > stale) assignLink(sync.connected, 'out-of-sync');
      else if (sync.connected === true) assignLink(sync.connected, 'synced');
    }
    applyPingJitter(payload);
    noteLastTraffic(payload);
  }

  /**
   * A new document started inside the same join (join page -> /game).
   * The page clock restarts, so drop the anchor and every page-side phase,
   * but keep the main-side marks (connect, joinPageLoaded, autologin*,
   * gameNavigation) so the timeline still spans the whole join.
   */
  function newDocument() {
    pageAnchor = null;
    const kept = {};
    for (let i = 0; i < PHASES.length; i += 1) {
      const name = PHASES[i];
      if (PAGE_PHASES.has(name) || name === 'socketConnected' || name === 'worldDataReceived') continue;
      if (Object.prototype.hasOwnProperty.call(wallPhases, name)) kept[name] = wallPhases[name];
    }
    wallPhases = kept;
    transfers = emptyTransfers();
    worldData = { bytes: null, ms: null };
    world = emptyWorld();
    progress = emptyProgress();
    rttSamples = [];
    ackSamples = [];
    ratePoints = [];
    sync = emptySync();
    client.pageErrors = { count: 0, byName: {} };
    client.longTasks = { count: 0, worstMs: null, totalMs: null, byPhase: {} };
    touch();
  }

  function reset(loadSeqArg) {
    loadSeq = finiteNumber(loadSeqArg) != null ? loadSeqArg : 0;
    resetAt = now();
    startedAt = null;
    wallPhases = {};
    pageAnchor = null;
    transfers = emptyTransfers();
    worldData = { bytes: null, ms: null };
    world = emptyWorld();
    progress = emptyProgress();
    rttSamples = [];
    ackSamples = [];
    ratePoints = [];
    sync = emptySync();
    net = { errors: {}, httpStatus: { '4xx': 0, '5xx': 0 }, clockSkewMs: null };
    client.pageErrors = { count: 0, byName: {} };
    client.longTasks = { count: 0, worstMs: null, totalMs: null, byPhase: {} };
    touch();
  }

  /**
   * @param {string} name
   * @param {number} [atMs] wall clock; defaults to now()
   */
  function mark(name, atMs) {
    try {
      const phase = safeString(name);
      if (!phase || !PHASE_SET.has(phase)) return;
      const wall = finiteNumber(atMs) != null ? atMs : now();
      if (phase === 'connect') startedAt = wall;
      setPhaseWall(phase, wall, true);
      touch();
    } catch (err) {
      /* ignore malformed marks */
    }
  }

  function ingestProgress(payload) {
    pageWall(payload.at);
    progress = {
      requests: nonNegCount(payload.requests),
      cachedRequests: nonNegCount(payload.cachedRequests),
      docs: nonNegCount(payload.docs),
      packages: nonNegCount(payload.packages),
      packagesTotal: nonNegCount(payload.packagesTotal),
      textures: nonNegCount(payload.textures),
      texturesTotal: nonNegCount(payload.texturesTotal),
      at: finiteNumber(payload.at),
    };
  }

  function ingest(payload) {
    try {
      if (!isObject(payload)) return;
      const type = safeString(payload.type);
      if (!type) return;
      if (type === 'phase') ingestPhase(payload);
      else if (type === 'sync') ingestSync(payload);
      else if (type === 'worldData') ingestWorldData(payload);
      else if (type === 'transfers') ingestTransfers(payload);
      else if (type === 'world') ingestWorld(payload);
      else if (type === 'worldSizes') ingestWorldSizes(payload);
      else if (type === 'sample') ingestSample(payload);
      else if (type === 'progress') ingestProgress(payload);
      else return;
      touch();
    } catch (err) {
      /* malformed payloads are dropped */
    }
  }

  function snapshot() {
    const phases = {};
    const base = origin();
    for (let i = 0; i < PHASES.length; i += 1) {
      const name = PHASES[i];
      const wall = wallPhases[name];
      phases[name] = Number.isFinite(wall) ? wall - base : null;
    }
    // init is measured from the world payload when that landed before init;
    // otherwise from domReady. Never report a negative phase.
    let initMs = null;
    if (phases.worldDataReceived != null && phases.init != null && phases.worldDataReceived <= phases.init) {
      initMs = span(phases.worldDataReceived, phases.init);
    } else {
      initMs = span(phases.domReady, phases.init);
    }
    if (initMs != null && initMs < 0) initMs = null;
    const transfersMs = Number.isFinite(transfers.busyMs)
      ? transfers.busyMs
      : span(phases.gameNavigation, phases.socketConnected);
    const byType = {};
    const typeKeys = Object.keys(transfers.byType);
    for (let i = 0; i < typeKeys.length; i += 1) {
      byType[typeKeys[i]] = Object.assign({}, transfers.byType[typeKeys[i]]);
    }
    return {
      loadSeq,
      startedAt,
      phases,
      durations: {
        loginMs: span(phases.connect, phases.gameNavigation),
        pageLoadMs: span(phases.gameNavigation, phases.socketConnected),
        transfersMs,
        worldDataMs: span(phases.socketConnected, phases.worldDataReceived),
        initMs,
        i18nMs: span(phases.init, phases.i18nInit),
        setupMs: span(phases.i18nInit, phases.setup),
        canvasMs: span(phases.setup, phases.canvasReady),
        totalMs: span(phases.connect, phases.ready),
      },
      transfers: {
        requests: transfers.requests,
        transferBytes: transfers.transferBytes,
        encodedBytes: transfers.encodedBytes,
        decodedBytes: transfers.decodedBytes,
        cachedRequests: transfers.cachedRequests,
        cacheHitRatio: transfers.cacheHitRatio,
        revalidatedRequests: transfers.revalidatedRequests,
        durationMs: transfers.durationMs,
        busyMs: transfers.busyMs,
        byType,
        ttfbP50Ms: transfers.ttfbP50Ms,
        ttfbP95Ms: transfers.ttfbP95Ms,
        downloadP95Ms: transfers.downloadP95Ms,
        slowDownloads: transfers.slowDownloads,
        cacheReadBytes: transfers.cacheReadBytes,
        cacheReadMs: transfers.cacheReadMs,
        cacheReadP95Ms: transfers.cacheReadP95Ms,
        cacheReadSlow: transfers.cacheReadSlow,
        protocolH1: transfers.protocolH1,
        protocolH2: transfers.protocolH2,
        scriptH1: transfers.scriptH1,
      },
      worldData: { bytes: worldData.bytes, ms: worldData.ms },
      world: {
        foundryVersion: world.foundryVersion,
        generation: world.generation,
        system: { id: world.system.id, version: world.system.version },
        modules: world.modules.map((m) => ({ id: m.id, version: m.version })),
        activeModuleCount: world.activeModuleCount,
        documents: Object.assign({}, world.documents),
        documentBytes: Object.assign({}, world.documentBytes),
        documentBytesComplete: world.documentBytesComplete === true,
        scene: Object.assign({}, world.scene),
        performanceMode: world.performanceMode,
        fps: world.fps,
        hookTime: world.hookTime ? {
          totalMs: world.hookTime.totalMs,
          packages: world.hookTime.packages,
          byPackage: world.hookTime.byPackage.map((row) => ({ id: row.id, ms: row.ms, count: row.count })),
        } : null,
      },
      sync: {
        state: sync.state,
        connected: sync.connected,
        rttMs: sync.rttMs,
        rttMinMs: sync.rttMinMs,
        rttP50Ms: rttSamples.length ? percentile(rttSamples, 50) : null,
        rttP95Ms: rttSamples.length ? percentile(rttSamples, 95) : null,
        latencyFloorMs: lowerMs(sync.rttMinMs, sync.ackMinMs),
        ackMinMs: sync.ackMinMs,
        ackP50Ms: ackSamples.length ? percentile(ackSamples, 50) : null,
        ackP95Ms: ackSamples.length ? percentile(ackSamples, 95) : null,
        ackSamples: ackSamples.length,
        pingJitterP95Ms: sync.pingJitterP95Ms,
        pingJitterSamples: sync.pingJitterSamples,
        reconnects: sync.reconnects,
        missedPongs: sync.missedPongs,
        lastPacketAgeMs: sync.lastPacketAgeMs,
        pingIntervalMs: sync.pingIntervalMs,
        pingTimeoutMs: sync.pingTimeoutMs,
        cause: sync.cause,
        lastChangeAt: sync.lastChangeAt,
        lastRequest: {
          name: sync.lastRequest.name,
          ageMs: sync.lastRequest.ageMs,
          ms: sync.lastRequest.ms,
        },
        lastMessageAgeMs: sync.lastMessageAgeMs,
        requestsPerMin: sync.requestsPerMin,
        messagesPerMin: sync.messagesPerMin,
      },
      net: {
        errors: Object.assign({}, net.errors),
        httpStatus: { '4xx': net.httpStatus['4xx'], '5xx': net.httpStatus['5xx'] },
        clockSkewMs: net.clockSkewMs,
      },
      client: {
        rendererGone: {
          count: client.rendererGone.count,
          lastReason: client.rendererGone.lastReason,
        },
        unresponsive: client.unresponsive,
        pageErrors: {
          count: client.pageErrors.count,
          byName: Object.assign({}, client.pageErrors.byName),
        },
        longTasks: {
          count: client.longTasks.count,
          worstMs: client.longTasks.worstMs,
          totalMs: client.longTasks.totalMs,
          byPhase: Object.assign({}, client.longTasks.byPhase),
        },
        webglMode: client.webglMode,
        webglFallbackReason: client.webglFallbackReason,
        updateStatus: client.updateStatus,
        gpuGone: client.gpuGone === true,
      },
      resources: Object.assign({}, resources),
      progress: {
        requests: progress.requests,
        cachedRequests: progress.cachedRequests,
        docs: progress.docs,
        packages: progress.packages,
        packagesTotal: progress.packagesTotal,
        textures: progress.textures,
        texturesTotal: progress.texturesTotal,
        at: progress.at,
      },
      updatedAt,
    };
  }

  /**
   * @param {string} errName
   * @param {string} [resourceType] accepted for the caller; not stored (names only)
   */
  function netError(errName, resourceType) {
    try {
      void resourceType;
      const name = safeString(errName);
      if (!name) return;
      if (!Object.prototype.hasOwnProperty.call(net.errors, name) && Object.keys(net.errors).length >= NAME_CAP) {
        return;
      }
      net.errors[name] = (net.errors[name] || 0) + 1;
      touch();
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * @param {number} code
   */
  function httpStatus(code) {
    try {
      if (typeof code !== 'number' || !Number.isFinite(code)) return;
      const n = Math.trunc(code);
      if (n >= 400 && n <= 499) net.httpStatus['4xx'] += 1;
      else if (n >= 500 && n <= 599) net.httpStatus['5xx'] += 1;
      else return;
      touch();
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * @param {string} reason Electron render-process-gone reason enum
   */
  function rendererGone(reason) {
    try {
      client.rendererGone.count += 1;
      client.rendererGone.lastReason = safeString(reason);
      touch();
    } catch (err) {
      /* ignore */
    }
  }

  function unresponsive() {
    try {
      client.unresponsive += 1;
      touch();
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * @param {'local-offline' | 'server-unreachable' | 'socket-stalled' | null} cause
   */
  function setSyncCause(cause) {
    try {
      if (cause == null) sync.cause = null;
      else if (SYNC_CAUSES.has(cause)) sync.cause = cause;
      else return;
      touch();
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * @param {object} partial
   */
  function setClient(partial) {
    try {
      if (!isObject(partial)) return;
      if (Object.prototype.hasOwnProperty.call(partial, 'webglMode')) {
        const mode = partial.webglMode;
        client.webglMode = mode === 'hardware' || mode === 'software' ? mode : null;
      }
      if (Object.prototype.hasOwnProperty.call(partial, 'webglFallbackReason')) {
        client.webglFallbackReason = partial.webglFallbackReason == null
          ? null
          : safeString(partial.webglFallbackReason);
      }
      if (Object.prototype.hasOwnProperty.call(partial, 'updateStatus')) {
        client.updateStatus = partial.updateStatus == null ? null : safeString(partial.updateStatus);
      }
      if (Object.prototype.hasOwnProperty.call(partial, 'gpuGone')) {
        client.gpuGone = partial.gpuGone === true;
      }
      touch();
    } catch (err) {
      /* ignore */
    }
  }

  /**
   * @param {object} partial
   */
  /**
   * Local clock minus the main-frame Date header, once per load.
   * Later calls are ignored until reset().
   * @param {number} ms
   */
  function setClockSkew(ms) {
    try {
      if (net.clockSkewMs != null) return;
      const n = finiteNumber(ms);
      if (n == null) return;
      net.clockSkewMs = n;
      touch();
    } catch (err) {
      /* ignore */
    }
  }

  function resourcesUpdate(partial) {
    try {
      if (!isObject(partial)) return;
      for (let i = 0; i < RESOURCE_KEYS.length; i += 1) {
        const key = RESOURCE_KEYS[i];
        if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;
        if (partial[key] == null) {
          resources[key] = null;
          continue;
        }
        const n = finiteNumber(partial[key]);
        if (n != null) resources[key] = n;
      }
      touch();
    } catch (err) {
      /* ignore */
    }
  }

  reset(0);

  return {
    reset,
    newDocument,
    mark,
    ingest,
    snapshot,
    resourcesUpdate,
    netError,
    httpStatus,
    rendererGone,
    unresponsive,
    setSyncCause,
    setClient,
    setClockSkew,
  };
}

/**
 * @param {object | null | undefined} snapshot
 * @returns {string}
 */
function formatJoinSummary(snapshot) {
  try {
    const s = isObject(snapshot) ? snapshot : {};
    const d = isObject(s.durations) ? s.durations : {};
    const t = isObject(s.transfers) ? s.transfers : {};
    const wd = isObject(s.worldData) ? s.worldData : {};
    const docs = sumDocs(isObject(s.world) ? s.world.documents : null);
    const parts = [];

    const transferBits = [];
    const hasReq = Number.isFinite(t.requests);
    const hasBytes = Number.isFinite(t.transferBytes);
    if (hasReq && hasBytes) transferBits.push(`${formatCount(t.requests)} req, ${formatBytes(t.transferBytes)}`);
    else if (hasReq) transferBits.push(`${formatCount(t.requests)} req`);
    else if (hasBytes) transferBits.push(formatBytes(t.transferBytes));
    if (Number.isFinite(t.cacheHitRatio)) {
      const reval = Number.isFinite(t.revalidatedRequests) && t.revalidatedRequests > 0
        ? `, ${formatCount(t.revalidatedRequests)} revalidated`
        : '';
      transferBits.push(`(${Math.round(t.cacheHitRatio * 100)}% cached${reval})`);
    }
    if (Number.isFinite(d.transfersMs)) transferBits.push(`${formatSeconds(d.transfersMs)} fetching`);
    if (transferBits.length) parts.push(`transfers ${transferBits.join(' ')}`);

    if (Number.isFinite(d.pageLoadMs)) parts.push(`page load ${formatSeconds(d.pageLoadMs)}`);

    const worldBits = [];
    if (Number.isFinite(d.worldDataMs)) worldBits.push(formatSeconds(d.worldDataMs));
    else if (Number.isFinite(wd.ms)) worldBits.push(formatSeconds(wd.ms));
    if (Number.isFinite(wd.bytes)) worldBits.push(formatBytes(wd.bytes));
    if (Number.isFinite(docs)) worldBits.push(`${formatCount(docs)} docs`);
    if (worldBits.length) parts.push(`world data ${worldBits.join(' ')}`);

    if (Number.isFinite(d.initMs)) parts.push(`init ${formatSeconds(d.initMs)}`);
    if (Number.isFinite(d.i18nMs)) parts.push(`i18n ${formatSeconds(d.i18nMs)}`);
    if (Number.isFinite(d.setupMs)) parts.push(`setup ${formatSeconds(d.setupMs)}`);
    if (Number.isFinite(d.canvasMs)) parts.push(`canvas ${formatSeconds(d.canvasMs)}`);
    const lt = isObject(s.client) && isObject(s.client.longTasks) ? s.client.longTasks : {};
    if (Number.isFinite(lt.totalMs) && lt.totalMs > 0) {
      let worstPhase = '';
      let worstMs = 0;
      const byPhase = isObject(lt.byPhase) ? lt.byPhase : {};
      for (const key of Object.keys(byPhase)) {
        if (Number.isFinite(byPhase[key]) && byPhase[key] > worstMs) {
          worstMs = byPhase[key];
          worstPhase = key;
        }
      }
      const where = BLOCKED_INTERVALS[worstPhase] || worstPhase;
      parts.push(`blocked ${formatSeconds(lt.totalMs)}${where ? ` (mostly ${where})` : ''}`);
    }
    if (Number.isFinite(d.totalMs)) parts.push(`ready ${formatSeconds(d.totalMs)} total`);

    return parts.length ? `join summary: ${parts.join(' | ')}` : 'join summary:';
  } catch (err) {
    return 'join summary:';
  }
}

/**
 * @param {object | null | undefined} snapshot
 */
function summarizeForHistory(snapshot) {
  const s = isObject(snapshot) ? snapshot : {};
  const d = isObject(s.durations) ? s.durations : {};
  const t = isObject(s.transfers) ? s.transfers : {};
  const wd = isObject(s.worldData) ? s.worldData : {};
  const world = isObject(s.world) ? s.world : {};
  const docs = sumDocs(world.documents);
  const sync = isObject(s.sync) ? s.sync : {};
  const bytes = finiteNumber(wd.bytes);
  const estimate = sumDocumentBytes(world.documentBytes);
  return {
    at: finiteNumber(s.updatedAt),
    totalMs: finiteNumber(d.totalMs),
    transfersMs: finiteNumber(d.transfersMs),
    worldDataMs: finiteNumber(d.worldDataMs),
    worldDataBytes: bytes,
    setupMs: finiteNumber(d.setupMs),
    canvasMs: finiteNumber(d.canvasMs),
    requests: finiteNumber(t.requests),
    transferBytes: finiteNumber(t.transferBytes),
    cacheHitRatio: finiteNumber(t.cacheHitRatio),
    docs,
    ttfbP50Ms: finiteNumber(t.ttfbP50Ms),
    rttP50Ms: finiteNumber(sync.rttP50Ms),
    ackP50Ms: finiteNumber(sync.ackP50Ms),
    worldBytesEstimate: estimate,
    worldDataMsPerMb: perUnit(finiteNumber(wd.ms), bytes != null && bytes > 0 ? bytes / 1e6 : null),
    setupMsPerDoc: perUnit(finiteNumber(d.setupMs), docs),
    hookTotalMs: isObject(world.hookTime) ? finiteNumber(world.hookTime.totalMs) : null,
  };
}

/**
 * @param {number | null} part
 * @param {number | null} whole
 * @returns {number | null}
 */
function emptyProgress() {
  return {
    requests: null,
    cachedRequests: null,
    docs: null,
    packages: null,
    packagesTotal: null,
    textures: null,
    texturesTotal: null,
    at: null,
  };
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function nonNegCount(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/**
 * @param {object | null | undefined} snap
 * @param {string} name
 * @returns {number | null}
 */
function phaseStartMs(snap, name) {
  if (!snap || typeof snap.startedAt !== 'number' || !Number.isFinite(snap.startedAt)) return null;
  const phases = snap.phases;
  const offset = phases && phases[name];
  if (typeof offset !== 'number' || !Number.isFinite(offset)) return null;
  return snap.startedAt + offset;
}

/**
 * @param {object | null | undefined} snap
 * @param {string} name
 * @returns {boolean}
 */
function phaseSeen(snap, name) {
  const phases = snap && snap.phases;
  const offset = phases && phases[name];
  return typeof offset === 'number' && Number.isFinite(offset);
}

/**
 * Gauge `live` row. Phase clocks are wall times (`startedAt + phases[name]`).
 * Files finish only at ready. Objects and modules finish at setup. Scene finishes
 * at canvasReady. `packagesTotal` is the live module denominator.
 * @param {object | null | undefined} snapshot
 */
function liveFromSnapshot(snapshot) {
  const snap = snapshot && typeof snapshot === 'object' ? snapshot : {};
  const row = snap.progress && typeof snap.progress === 'object' ? snap.progress : {};
  const transfers = snap.transfers && typeof snap.transfers === 'object' ? snap.transfers : {};
  const ready = phaseSeen(snap, 'ready');
  const setup = phaseSeen(snap, 'setup');
  const canvasReady = phaseSeen(snap, 'canvasReady');
  const completed = [];
  if (setup) completed.push('setup');
  if (canvasReady) completed.push('canvasReady');
  if (ready) completed.push('ready');
  const pageLoadStart = phaseStartMs(snap, 'gameNavigation') ?? phaseStartMs(snap, 'domReady');
  const initStart = phaseStartMs(snap, 'init');
  const setupStart = phaseStartMs(snap, 'i18nInit') ?? phaseStartMs(snap, 'setup');
  const canvasStart = phaseStartMs(snap, 'setup');
  /** @type {Record<string, { startMs?: number, done?: boolean }>} */
  const phases = {};
  phases.pageLoad = {};
  if (pageLoadStart != null) phases.pageLoad.startMs = pageLoadStart;
  if (ready) phases.pageLoad.done = true;
  if (initStart != null) phases.init = { startMs: initStart };
  if (setupStart != null || setup) {
    phases.setup = {};
    if (setupStart != null) phases.setup.startMs = setupStart;
    if (setup) phases.setup.done = true;
  }
  if (canvasStart != null || canvasReady) {
    phases.canvas = {};
    if (canvasStart != null) phases.canvas.startMs = canvasStart;
    if (canvasReady) phases.canvas.done = true;
  }
  return {
    requests: nonNegCount(row.requests) ?? nonNegCount(transfers.requests),
    cachedRequests: nonNegCount(row.cachedRequests) ?? nonNegCount(transfers.cachedRequests),
    docs: nonNegCount(row.docs),
    packages: nonNegCount(row.packages),
    packagesTotal: nonNegCount(row.packagesTotal),
    textures: nonNegCount(row.textures),
    texturesTotal: nonNegCount(row.texturesTotal),
    completedPhases: completed,
    phases,
  };
}

function perUnit(part, whole) {
  if (part == null || whole == null) return null;
  if (!Number.isFinite(part) || !Number.isFinite(whole) || !(whole > 0)) return null;
  return part / whole;
}

/**
 * @param {object | null | undefined} current snapshot or history record
 * @param {Array<{ totalMs?: number | null }> | null | undefined} records oldest first
 */
function compareWithHistory(current, records) {
  let thisMs = null;
  if (isObject(current)) {
    if (Number.isFinite(current.totalMs)) thisMs = current.totalMs;
    else if (isObject(current.durations) && Number.isFinite(current.durations.totalMs)) {
      thisMs = current.durations.totalMs;
    }
  }
  const list = Array.isArray(records) ? records : [];
  const totals = [];
  for (let i = 0; i < list.length; i += 1) {
    const n = list[i] && list[i].totalMs;
    if (typeof n === 'number' && Number.isFinite(n)) totals.push(n);
  }
  const oldest = list.length ? list[0] : null;
  const firstMs = oldest && typeof oldest.totalMs === 'number' && Number.isFinite(oldest.totalMs)
    ? oldest.totalMs
    : null;
  return {
    thisMs,
    typicalMs: totals.length ? percentile(totals, 50) : null,
    firstMs,
    fastestMs: totals.length ? Math.min.apply(null, totals) : null,
  };
}

module.exports = {
  PHASES,
  createCollector,
  percentile,
  formatBytes,
  formatMs,
  formatJoinSummary,
  staleThresholdMs,
  summarizeForHistory,
  compareWithHistory,
  liveFromSnapshot,
};
