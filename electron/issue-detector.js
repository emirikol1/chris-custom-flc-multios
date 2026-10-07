'use strict';

/**
 * Turn a telemetry snapshot into whitelist findings.
 * Evidence is built from numbers and known enums only. Input objects are never copied.
 *
 * Initial thresholds are guesses to tune after real join profiles exist.
 * A snapshot that stays inside every limit produces no findings.
 */

const DEFAULT_THRESHOLDS = {
  /** Timeout-class net errors above this count are a warning. */
  netTimeoutCount: 1,
  /** Missed websocket pongs at or above this means an unstable link. */
  missedPongs: 2,
  /** Reconnects at or above this means an unstable link. */
  reconnects: 2,
  /** Ping-arrival deviation p95 above this (ms) is uneven connection timing. */
  pingJitterMs: 400,
  /** Ack p95 above this (ms), with a fast latency floor, means a slow server. */
  ackSlowMs: 2000,
  /** Slow downloads at or above this, with a fast TTFB, means bandwidth. */
  slowDownloads: 5,
  /** TTFB p50 above this (ms) looks like a slow server when RTT is fine. */
  serverTtfbMs: 600,
  /** HTTP 5xx responses at or above this are a server warning. */
  http5xx: 1,
  /** RTT p50 under this (ms) counts as a fast path to the server. */
  rttOkMs: 150,
  /** Extra milliseconds allowed per megabyte of world data. */
  worldDataMsPerMb: 1500,
  /** Base milliseconds allowed for world data before the per-MB term. */
  worldDataBaseMs: 1000,
  /** Absolute clock skew above this (ms) explains certificate failures. */
  clockSkewMs: 120000,
  /** Page errors at or above this are noted. */
  pageErrors: 10,
  /** Local phase sum above this (ms), with a fast transfer, is local work. */
  localPhasesMs: 6000,
  /** Transfer time under this (ms) counts as fast. */
  transfersFastMs: 3000,
  /** Long tasks at or above this mean the page is stalling. */
  longTasks: 20,
  /** One long task at or above this (ms) means a stall. */
  worstLongTaskMs: 1000,
  /** Blocked time after ready at or above this (ms) can be an in-game stall. */
  inGameStallMs: 3000,
  /** ...when it is also at least this share of the time spent in game. */
  inGameStallRatio: 0.02,
  /** Heap used/limit above this is memory pressure. */
  heapRatio: 0.85,
  /** Free/total system memory under this is low memory. */
  systemFreeRatio: 0.08,
  /** GPU memory above this (bytes) is noted. */
  gpuMemoryBytes: 2.5e9,
  /** Renderer CPU percent above this is a warning. */
  rendererCpuPercent: 85,
  /** loadavg / cpuCount above this means the machine is busy. */
  loadPerCore: 1.5,
  /** Current join slower than this times the historical median is noted. */
  slowerThanTypicalFactor: 1.8,
  /** Cache bytes/limit above this, with a low hit ratio, means a full cache. */
  cacheFullRatio: 0.9,
  /** Cache hit ratio below this counts as missing the cache. */
  cacheHitRatioLow: 0.5,
  /** Slow small cache-service times at or above this mean the cache read itself was slow. */
  cacheReadSlowCount: 20,
};

const DOC_KEYS = ['actors', 'items', 'scenes', 'journal', 'tables', 'macros', 'playlists', 'cards', 'folders', 'users', 'messages', 'packs'];
const SEVERITY_RANK = { error: 0, warn: 1, info: 2 };
const CATEGORY_RANK = { network: 0, server: 1, client: 2, resources: 3, dns: 4 };
const SAFE_ENUM = /^[A-Za-z0-9._-]+$/;
const PACKAGE_ID = /^[A-Za-z0-9._-]{1,64}$/;
const ERROR_NAME = /^[A-Z][A-Za-z0-9_]{0,63}$/;
const CERT_KEY = /^ERR_CERT_[A-Z0-9_]+$/;
const CAUSES = new Set(['local-offline', 'server-unreachable', 'socket-stalled']);
const GONE_REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure']);

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isPlain(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

/**
 * @param {unknown} value
 * @returns {number | null}
 */
function num(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {object} snapshot
 * @param {string} key
 * @returns {object}
 */
function section(snapshot, key) {
  const value = snapshot && snapshot[key];
  return isPlain(value) ? value : {};
}

/**
 * @param {object} thresholds
 * @param {string} key
 * @returns {number}
 */
function limit(thresholds, key) {
  const value = thresholds && thresholds[key];
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return DEFAULT_THRESHOLDS[key];
}

/**
 * @param {object} bag
 * @param {string} key
 * @returns {number}
 */
function positive(bag, key) {
  if (!isPlain(bag) || !Object.prototype.hasOwnProperty.call(bag, key)) return 0;
  const value = num(bag[key]);
  return value != null && value > 0 ? value : 0;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function formatEvidenceNumber(value) {
  if (Object.is(value, -0)) return '0';
  if (Number.isInteger(value)) return String(value);
  const rounded = Math.round(value * 1000) / 1000;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/**
 * @param {Array<[string, number | string | null]>} entries
 * @returns {string}
 */
const BYTE_KEYS = new Set(['free', 'total', 'used', 'limit', 'bytes']);

/** Byte-valued evidence reads as "1.2 GB" once it is large enough to be unreadable raw. */
function humanBytes(n) {
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let v = n;
  let i = 0;
  while (v >= 1024 && i < units.length - 1) {
    v /= 1024;
    i += 1;
  }
  return `${(Math.round(v * 10) / 10).toFixed(1)} ${units[i]}`;
}

function pairs(entries) {
  const parts = [];
  for (const [key, value] of entries) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (BYTE_KEYS.has(key) && value >= 1024 * 1024) parts.push(`${key}=${humanBytes(value)}`);
      else parts.push(`${key}=${formatEvidenceNumber(value)}`);
    } else if (typeof value === 'string' && SAFE_ENUM.test(value)) {
      parts.push(`${key}=${value}`);
    }
  }
  return parts.join(' ');
}

/**
 * @param {string} id
 * @param {'network'|'server'|'client'|'resources'|'dns'} category
 * @param {'info'|'warn'|'error'} severity
 * @param {string} title
 * @param {string} evidence
 * @param {string} suggestion
 */
function make(id, category, severity, title, evidence, suggestion) {
  return { id, category, severity, title, evidence, suggestion };
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function knownCause(value) {
  return typeof value === 'string' && CAUSES.has(value) ? value : null;
}

/**
 * @param {object} errors
 * @returns {number}
 */
function certCount(errors) {
  if (!isPlain(errors)) return 0;
  let total = 0;
  for (const key of Object.keys(errors)) {
    if (!CERT_KEY.test(key)) continue;
    total += positive(errors, key);
  }
  return total;
}

/**
 * @param {object} snapshot
 * @returns {number}
 */
function documentTotal(snapshot) {
  const docs = section(section(snapshot, 'world'), 'documents');
  let total = 0;
  for (const key of DOC_KEYS) {
    const value = num(docs[key]);
    if (value != null && value > 0) total += value;
  }
  return total;
}

/**
 * @param {number} part
 * @param {number} whole
 * @param {number} ratio
 * @returns {boolean}
 */
function exceedsRatio(part, whole, ratio) {
  if (!(whole > 0)) return false;
  const slack = Math.max(Math.abs(whole) * 1e-9, 1e-6);
  return part > ratio * whole + slack;
}

/**
 * @param {number} part
 * @param {number} whole
 * @param {number} ratio
 * @returns {boolean}
 */
function belowRatio(part, whole, ratio) {
  if (!(whole > 0)) return false;
  const slack = Math.max(Math.abs(whole) * 1e-9, 1e-6);
  return part < ratio * whole - slack;
}

/**
 * @param {number[]} values
 * @returns {number | null}
 */
function median(values) {
  if (!values.length) return null;
  const xs = values.slice().sort((a, b) => a - b);
  const mid = Math.floor(xs.length / 2);
  if (xs.length % 2 === 1) return xs[mid];
  return (xs[mid - 1] + xs[mid]) / 2;
}

/**
 * @param {unknown[]} history
 * @param {string} field
 * @returns {number | null}
 */
function historyMedian(history, field) {
  const values = [];
  for (const row of history) {
    if (!isPlain(row)) continue;
    const value = num(row[field]);
    if (value != null && value >= 0) values.push(value);
  }
  return median(values);
}

/**
 * Relative to the historical median when one exists.
 * Both the absolute bound and the relative bound -> warn.
 * Relative only -> info. Absolute only, once a median exists, is not a finding.
 * With no median, the previous absolute severity is kept.
 * @param {number | null} current
 * @param {number | null} medianValue
 * @param {boolean} absoluteHit
 * @param {object} thresholds
 * @param {'warn'|'info'} fallbackSeverity
 * @returns {'warn'|'info'|null}
 */
function relativeSeverity(current, medianValue, absoluteHit, thresholds, fallbackSeverity) {
  if (medianValue == null || current == null) return absoluteHit ? fallbackSeverity : null;
  const relativeHit = current > medianValue * limit(thresholds, 'slowerThanTypicalFactor');
  if (!relativeHit) return null;
  return absoluteHit ? 'warn' : 'info';
}

/**
 * @param {object} opts
 * @returns {{ suppressSoft: boolean, relative: boolean }}
 */
function baselineFlags(opts) {
  if (!isPlain(opts) || (opts.baselineReady !== true && opts.baselineReady !== false)) {
    return { suppressSoft: false, relative: false };
  }
  return {
    suppressSoft: opts.baselineReady === false,
    relative: opts.baselineReady === true,
  };
}

/**
 * @param {object} snap
 */
function dnsFinding(snap) {
  const count = positive(section(snap, 'net').errors, 'ERR_NAME_NOT_RESOLVED');
  if (count <= 0) return null;
  return make(
    'dns-unresolved',
    'dns',
    'error',
    'Server name could not be resolved (DNS)',
    pairs([['count', count]]),
    'Check DNS and the server address.',
  );
}

/**
 * @param {object} snap
 */
function offlineFinding(snap) {
  const count = positive(section(snap, 'net').errors, 'ERR_INTERNET_DISCONNECTED');
  const cause = knownCause(section(snap, 'sync').cause);
  if (count <= 0 && cause !== 'local-offline') return null;
  return make(
    'local-offline',
    'network',
    'error',
    'This computer is offline',
    pairs([
      ['ERR_INTERNET_DISCONNECTED', count > 0 ? count : null],
      ['cause', cause === 'local-offline' ? cause : null],
    ]),
    'Reconnect this computer to the network and try again.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function timeoutFinding(snap, thresholds) {
  const errors = section(snap, 'net').errors;
  const timedOut = positive(errors, 'ERR_CONNECTION_TIMED_OUT');
  const timed = positive(errors, 'ERR_TIMED_OUT');
  const changed = positive(errors, 'ERR_NETWORK_CHANGED');
  const total = timedOut + timed + changed;
  if (!(total > limit(thresholds, 'netTimeoutCount'))) return null;
  return make(
    'network-timeouts',
    'network',
    'warn',
    'Connections are timing out',
    pairs([
      ['ERR_CONNECTION_TIMED_OUT', timedOut],
      ['ERR_TIMED_OUT', timed],
      ['ERR_NETWORK_CHANGED', changed],
      ['total', total],
    ]),
    'The connection is timing out; try a more stable network.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function unstableFinding(snap, thresholds, suppressJitterOnly) {
  const sync = section(snap, 'sync');
  const missed = num(sync.missedPongs);
  const reconnects = num(sync.reconnects);
  const p50 = num(sync.rttP50Ms);
  const p95 = num(sync.rttP95Ms);
  const missedHit = missed != null && missed >= limit(thresholds, 'missedPongs');
  const reconnectHit = reconnects != null && reconnects >= limit(thresholds, 'reconnects');
  if (missedHit || reconnectHit) {
    return make(
      'network-unstable',
      'network',
      'warn',
      'Unstable connection',
      pairs([
        ['rttP50Ms', p50],
        ['rttP95Ms', p95],
        ['reconnects', reconnects],
        ['missedPongs', missed],
      ]),
      'Try a more stable network path to the server.',
    );
  }
  if (suppressJitterOnly) return null;
  const jitter = num(sync.pingJitterP95Ms);
  const samples = num(sync.pingJitterSamples);
  if (jitter == null || samples == null || samples < 5) return null;
  if (!(jitter > limit(thresholds, 'pingJitterMs'))) return null;
  return make(
    'network-timing',
    'network',
    'info',
    'Connection timing is uneven',
    pairs([
      ['pingJitterP95Ms', jitter],
      ['samples', samples],
    ]),
    'Ping timing is uneven; a noisy network path can delay packets.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function bandwidthFinding(snap, thresholds) {
  const transfers = section(snap, 'transfers');
  const slow = num(transfers.slowDownloads);
  const ttfb = num(transfers.ttfbP50Ms);
  if (slow == null || ttfb == null) return null;
  if (slow < limit(thresholds, 'slowDownloads')) return null;
  if (!(ttfb < limit(thresholds, 'serverTtfbMs'))) return null;
  return make(
    'bandwidth-limited',
    'network',
    'info',
    'Downloads are bandwidth-limited',
    pairs([['slowDownloads', slow], ['ttfbP50Ms', ttfb]]),
    'Downloads look limited by bandwidth rather than server think time.',
  );
}

/**
 * @param {object} snap
 */
function unreachableFinding(snap) {
  const errors = section(snap, 'net').errors;
  const refused = positive(errors, 'ERR_CONNECTION_REFUSED');
  const reset = positive(errors, 'ERR_CONNECTION_RESET');
  const cause = knownCause(section(snap, 'sync').cause);
  if (refused <= 0 && reset <= 0 && cause !== 'server-unreachable') return null;
  return make(
    'server-unreachable',
    'server',
    'error',
    'Server could not be reached',
    pairs([
      ['ERR_CONNECTION_REFUSED', refused],
      ['ERR_CONNECTION_RESET', reset],
      ['cause', cause === 'server-unreachable' ? cause : null],
    ]),
    'The server refused the connection or could not be reached.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function serverErrorFinding(snap, thresholds) {
  const count = positive(section(section(snap, 'net'), 'httpStatus'), '5xx');
  if (!(count >= limit(thresholds, 'http5xx'))) return null;
  return make(
    'server-5xx',
    'server',
    'warn',
    'Server returned errors',
    pairs([['5xx', count]]),
    'The server returned errors; check the server status.',
  );
}

/**
 * Slow TTFB with a fast RTT is the server. When RTT is missing the TTFB check still applies.
 * A known RTT that is not fast suppresses this finding.
 *
 * @param {object} snap
 * @param {object} thresholds
 */
function serverSlowFinding(snap, thresholds, rel) {
  const ttfb = num(section(snap, 'transfers').ttfbP50Ms);
  if (ttfb == null) return null;
  const rtt = num(section(snap, 'sync').rttP50Ms);
  if (rtt != null && !(rtt < limit(thresholds, 'rttOkMs'))) return null;
  const absoluteHit = ttfb > limit(thresholds, 'serverTtfbMs');
  const medianTtfb = rel ? rel.ttfbMedian : null;
  if (!rel) {
    if (!absoluteHit) return null;
  }
  const severity = rel
    ? relativeSeverity(ttfb, medianTtfb, absoluteHit, thresholds, 'warn')
    : (absoluteHit ? 'warn' : null);
  if (!severity) return null;
  const evidence = rel && medianTtfb != null
    ? pairs([['ttfbP50Ms', ttfb], ['rttP50Ms', rtt], ['medianTtfbP50Ms', medianTtfb]])
    : pairs([['ttfbP50Ms', ttfb], ['rttP50Ms', rtt]]);
  return make(
    'server-slow',
    'server',
    severity,
    'Server is slow to respond',
    evidence,
    'The server is responding slowly compared with the network round trip.',
  );
}

/** Fastest observed round trip under this (ms) means the link is not the slow part. */
const ACK_LINK_OK_MS = 300;

/**
 * Slow acks with a fast latency floor are server work, not the network.
 * Ack percentiles are never used as a network finding.
 *
 * @param {object} snap
 * @param {object} thresholds
 */
function serverAckFinding(snap, thresholds) {
  const sync = section(snap, 'sync');
  const ackP95 = num(sync.ackP95Ms);
  const ackP50 = num(sync.ackP50Ms);
  const floor = num(sync.latencyFloorMs);
  const samples = num(sync.ackSamples);
  if (ackP95 == null || floor == null || samples == null) return null;
  if (samples < 5) return null;
  if (!(ackP95 > limit(thresholds, 'ackSlowMs'))) return null;
  if (!(floor < ACK_LINK_OK_MS)) return null;
  return make(
    'server-ack-slow',
    'server',
    'warn',
    'Server is slow to acknowledge actions',
    pairs([
      ['ackP50Ms', ackP50],
      ['ackP95Ms', ackP95],
      ['latencyFloorMs', floor],
    ]),
    'The server is slow to acknowledge actions; check server load and active modules.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function worldSlowFinding(snap, thresholds, rel) {
  const worldData = section(snap, 'worldData');
  const ms = num(worldData.ms);
  const bytes = num(worldData.bytes);
  if (ms == null || bytes == null) return null;
  const allowed = limit(thresholds, 'worldDataMsPerMb') * (bytes / 1e6) + limit(thresholds, 'worldDataBaseMs');
  const absoluteHit = ms > allowed;
  const perMb = bytes > 0 ? ms / (bytes / 1e6) : null;
  if (!rel && !absoluteHit) return null;
  const medianPerMb = rel ? rel.worldMedian : null;
  const severity = rel
    ? relativeSeverity(perMb, medianPerMb, absoluteHit, thresholds, 'warn')
    : (absoluteHit ? 'warn' : null);
  if (!severity) return null;
  const evidence = rel && medianPerMb != null && perMb != null
    ? pairs([['ms', ms], ['bytes', bytes], ['msPerMb', perMb], ['medianMsPerMb', medianPerMb]])
    : pairs([['ms', ms], ['bytes', bytes]]);
  return make(
    'world-data-slow',
    'server',
    severity,
    'World data took longer than expected',
    evidence,
    'World data arrived slower than expected for its size.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function tlsFinding(snap, thresholds) {
  const certErrors = certCount(section(snap, 'net').errors);
  if (certErrors <= 0) return null;
  const skew = num(section(snap, 'net').clockSkewMs);
  const skewAbs = skew == null ? 0 : Math.abs(skew);
  if (skewAbs > limit(thresholds, 'clockSkewMs')) {
    return make(
      'system-clock-wrong',
      'client',
      'error',
      'System clock is wrong',
      pairs([['clockSkewMs', skew], ['certErrors', certErrors]]),
      'Set the system clock accurately and try again.',
    );
  }
  return make(
    'server-certificate',
    'server',
    'error',
    'Server certificate problem',
    pairs([['certErrors', certErrors], ['clockSkewMs', skew]]),
    'The server certificate could not be validated.',
  );
}

/**
 * @param {object} snap
 */
/**
 * The previous process did not shut down cleanly. Causes are safe tokens
 * noted before it died (renderer, GPU, or an exception name).
 * @param {unknown} info
 */
function previousSessionFinding(info) {
  if (!isPlain(info) || !Array.isArray(info.causes) || !info.causes.length) return null;
  /** @type {Array<[string, string]>} */
  const entries = [];
  const labels = ['cause', 'cause2', 'cause3', 'cause4'];
  for (let i = 0; i < info.causes.length && entries.length < labels.length; i += 1) {
    const cause = info.causes[i];
    if (typeof cause === 'string' && SAFE_ENUM.test(cause)) entries.push([labels[entries.length], cause]);
  }
  if (typeof info.client === 'string' && SAFE_ENUM.test(info.client)) entries.push(['previousClient', info.client]);
  if (info.reported === true) entries.push(['report', 'saved']);
  if (!entries.length) return null;
  const suggestion = info.reported === true
    ? 'The last session did not shut down cleanly. A crash report was saved for later analysis.'
    : 'The last session did not shut down cleanly.';
  return make(
    'app-crashed',
    'client',
    'error',
    'Previous session ended unexpectedly',
    pairs(entries),
    suggestion,
  );
}

/**
 * @param {object} snap
 */
function crashFinding(snap) {
  const gone = section(section(snap, 'client'), 'rendererGone');
  const count = num(gone.count);
  if (count == null || !(count > 0)) return null;
  const reason = typeof gone.lastReason === 'string' && GONE_REASONS.has(gone.lastReason) ? gone.lastReason : null;
  return make(
    'renderer-crashed',
    'client',
    'error',
    'Game page crashed',
    pairs([['count', count], ['lastReason', reason]]),
    'The game page crashed; retry the join.',
  );
}

/**
 * @param {object} snap
 */
function unresponsiveFinding(snap) {
  const count = num(section(snap, 'client').unresponsive);
  if (count == null || !(count > 0)) return null;
  return make(
    'renderer-unresponsive',
    'client',
    'warn',
    'Game page was unresponsive',
    pairs([['count', count]]),
    'The game page stopped responding; retry the join.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function pageErrorFinding(snap, thresholds) {
  const pageErrors = section(section(snap, 'client'), 'pageErrors');
  const count = num(pageErrors.count);
  if (count == null || count < limit(thresholds, 'pageErrors')) return null;
  const rows = [];
  const byName = isPlain(pageErrors.byName) ? pageErrors.byName : {};
  for (const name of Object.keys(byName)) {
    if (!ERROR_NAME.test(name)) continue;
    const value = num(byName[name]);
    if (value == null || !(value > 0)) continue;
    rows.push({ name, value });
  }
  rows.sort((a, b) => b.value - a.value || (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  const top = rows.slice(0, 3).map((row) => [row.name, row.value]);
  return make(
    'page-errors',
    'client',
    'info',
    'Many page errors during join',
    pairs([['count', count], ...top]),
    'The page reported many errors during startup.',
  );
}

/**
 * @param {object} snap
 */
function softwareWebglFinding(snap) {
  const client = section(snap, 'client');
  if (client.webglMode !== 'software') return null;
  const reason = typeof client.webglFallbackReason === 'string' && SAFE_ENUM.test(client.webglFallbackReason)
    ? client.webglFallbackReason
    : null;
  return make(
    'software-webgl',
    'client',
    'warn',
    'Software rendering in use',
    pairs([['webglMode', 'software'], ['webglFallbackReason', reason]]),
    'Software rendering is on; graphics will be slower.',
  );
}

/**
 * Slowest package during join, as evidence pairs. Ids use the package-id
 * pattern, which pairs() also accepts (SAFE_ENUM allows dots).
 * @param {object} snap
 * @returns {Array<[string, string | number]>}
 */
function topPackagePairs(snap) {
  const world = section(snap, 'world');
  const hookTime = isPlain(world.hookTime) ? world.hookTime : null;
  const rows = hookTime && Array.isArray(hookTime.byPackage) ? hookTime.byPackage : [];
  let top = null;
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!isPlain(row) || typeof row.id !== 'string' || !PACKAGE_ID.test(row.id)) continue;
    const ms = num(row.ms);
    if (ms == null || ms < 0) continue;
    if (!top || ms > top.ms) top = { id: row.id, ms };
  }
  if (!top) return [];
  return [['topPackage', top.id], ['topPackageMs', top.ms]];
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function localPhaseFinding(snap, thresholds, rel) {
  const durations = section(snap, 'durations');
  const setup = num(durations.setupMs);
  const canvas = num(durations.canvasMs);
  const init = num(durations.initMs);
  const i18n = num(durations.i18nMs);
  const transfers = num(durations.transfersMs);
  const docs = documentTotal(snap);
  const perDoc = setup != null && docs > 0 ? setup / docs : null;
  let localMs = null;
  let absoluteHit = false;
  if (setup != null && canvas != null && init != null && i18n != null && transfers != null) {
    localMs = setup + canvas + init + i18n;
    absoluteHit = localMs > limit(thresholds, 'localPhasesMs')
      && transfers < limit(thresholds, 'transfersFastMs');
  }
  if (!rel && !absoluteHit) return null;
  const medianPerDoc = rel ? rel.setupMedian : null;
  const severity = rel
    ? relativeSeverity(perDoc, medianPerDoc, absoluteHit, thresholds, 'info')
    : (absoluteHit ? 'info' : null);
  if (!severity) return null;
  const extra = topPackagePairs(snap);
  const evidence = rel && medianPerDoc != null && perDoc != null
    ? pairs([
      ['localMs', localMs],
      ['transfersMs', transfers],
      ['docs', docs],
      ['setupMsPerDoc', perDoc],
      ['medianSetupMsPerDoc', medianPerDoc],
    ].concat(extra))
    : pairs([['localMs', localMs], ['transfersMs', transfers], ['docs', docs]].concat(extra));
  return make(
    'local-phases',
    'client',
    severity,
    'Startup time is spent locally (large world or slow CPU)',
    evidence,
    'Most of the startup time was spent locally, which points to a large world or a slow CPU.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function stallFinding(snap, thresholds) {
  const tasks = section(section(snap, 'client'), 'longTasks');
  const count = num(tasks.count);
  const worst = num(tasks.worstMs);
  const byPhase = isPlain(tasks.byPhase) ? tasks.byPhase : null;
  if (byPhase) {
    // Join-time blocking is the "startup time is spent locally" finding.
    // In-game stalls are long tasks after ready, judged against time in game.
    const after = num(byPhase.ready) ?? 0;
    const phases = section(snap, 'phases');
    const readyAt = num(phases.ready);
    const startedAt = num(snap.startedAt);
    const updatedAt = num(snap.updatedAt);
    let inGameMs = null;
    if (readyAt != null && startedAt != null && updatedAt != null) inGameMs = updatedAt - (startedAt + readyAt);
    const enoughMs = after >= limit(thresholds, 'inGameStallMs');
    const enoughShare = inGameMs == null || inGameMs <= 0 || (after / inGameMs) >= limit(thresholds, 'inGameStallRatio');
    if (!enoughMs || !enoughShare) return null;
    return make(
      'game-stalling',
      'client',
      'warn',
      'Game is stalling',
      pairs([['blockedAfterReadyMs', after], ['inGameMs', inGameMs], ['worstMs', worst]]),
      'The game is stalling on long tasks after loading; a busy scene, module, or slow CPU.',
    );
  }
  const countHit = count != null && count >= limit(thresholds, 'longTasks');
  const worstHit = worst != null && worst >= limit(thresholds, 'worstLongTaskMs');
  if (!countHit && !worstHit) return null;
  return make(
    'game-stalling',
    'client',
    'warn',
    'Game is stalling',
    pairs([['count', count], ['worstMs', worst]]),
    'The game is stalling on long tasks.',
  );
}

/**
 * @param {object} snap
 */
function outdatedFinding(snap) {
  if (section(snap, 'client').updateStatus !== 'available') return null;
  return make(
    'update-available',
    'client',
    'info',
    'A client update is available',
    pairs([['updateStatus', 'available']]),
    'A client update is available.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function heapFinding(snap, thresholds) {
  const resources = section(snap, 'resources');
  const used = num(resources.rendererHeapUsedBytes);
  const cap = num(resources.rendererHeapLimitBytes);
  if (used == null || cap == null || !exceedsRatio(used, cap, limit(thresholds, 'heapRatio'))) return null;
  return make(
    'renderer-heap',
    'resources',
    'warn',
    'Renderer heap is nearly full',
    pairs([['used', used], ['limit', cap]]),
    'The renderer heap is nearly full.',
  );
}

/**
 * Prefer snapshot available bytes when present, then snapshot free bytes,
 * then the same fields on systemInfo.
 *
 * @param {object} snap
 * @param {object | null} systemInfo
 * @param {object} thresholds
 */
function systemMemoryFinding(snap, systemInfo, thresholds) {
  const resources = section(snap, 'resources');
  const info = isPlain(systemInfo) ? systemInfo : {};
  const free = num(resources.systemAvailableBytes)
    ?? num(resources.systemFreeBytes)
    ?? num(info.memAvailableBytes)
    ?? num(info.memFreeBytes);
  const total = num(resources.systemTotalBytes) ?? num(info.memTotalBytes);
  if (free == null || total == null || !belowRatio(free, total, limit(thresholds, 'systemFreeRatio'))) return null;
  return make(
    'system-memory-low',
    'resources',
    'warn',
    'System memory is low',
    pairs([['free', free], ['total', total]]),
    'Close other programs to free system memory.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function gpuMemoryFinding(snap, thresholds) {
  const bytes = num(section(snap, 'resources').gpuMemoryBytes);
  if (bytes == null || !(bytes > limit(thresholds, 'gpuMemoryBytes'))) return null;
  return make(
    'gpu-memory',
    'resources',
    'info',
    'GPU memory use is high',
    pairs([['gpuMemoryBytes', bytes]]),
    'GPU memory use is high.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function cpuFinding(snap, thresholds) {
  const cpu = num(section(snap, 'resources').rendererCpuPercent);
  if (cpu == null || !(cpu > limit(thresholds, 'rendererCpuPercent'))) return null;
  return make(
    'renderer-cpu',
    'resources',
    'warn',
    'Renderer CPU is high',
    pairs([['rendererCpuPercent', cpu]]),
    'The renderer is using a lot of CPU.',
  );
}

/**
 * cpuCount comes from systemInfo. loadAvg1 prefers the snapshot, then systemInfo.
 *
 * @param {object} snap
 * @param {object | null} systemInfo
 * @param {object} thresholds
 */
function loadFinding(snap, systemInfo, thresholds) {
  const info = isPlain(systemInfo) ? systemInfo : null;
  if (!info) return null;
  const cpuCount = num(info.cpuCount);
  const load = num(section(snap, 'resources').loadAvg1) ?? num(info.loadAvg1);
  if (cpuCount == null || !(cpuCount > 0) || load == null) return null;
  if (!(load / cpuCount > limit(thresholds, 'loadPerCore'))) return null;
  return make(
    'system-busy',
    'resources',
    'info',
    'System is busy',
    pairs([['loadAvg1', load], ['cpuCount', cpuCount]]),
    'The system is busy with other work.',
  );
}

/**
 * @param {object} snap
 * @param {object} thresholds
 */
function cacheFinding(snap, thresholds) {
  const resources = section(snap, 'resources');
  const cacheBytes = num(resources.cacheBytes);
  const cacheLimit = num(resources.cacheLimitBytes);
  const hit = num(section(snap, 'transfers').cacheHitRatio);
  if (cacheBytes == null || cacheLimit == null || hit == null) return null;
  if (!exceedsRatio(cacheBytes, cacheLimit, limit(thresholds, 'cacheFullRatio'))) return null;
  if (!(hit < limit(thresholds, 'cacheHitRatioLow'))) return null;
  return make(
    'cache-full',
    'resources',
    'info',
    'Cache is full; files are being re-downloaded',
    pairs([['cacheBytes', cacheBytes], ['cacheLimitBytes', cacheLimit], ['cacheHitRatio', hit]]),
    'Raise the cache limit or clear old cache data so files are not downloaded again.',
  );
}

/**
 * Small cached files whose cache service time is long, while the network TTFB
 * is fine. Service time is the cache read, not the browser queue, so a busy
 * join on a fast disk does not qualify.
 *
 * @param {object} snap
 * @param {object} thresholds
 */
function localDiskFinding(snap, thresholds) {
  const transfers = section(snap, 'transfers');
  const slow = num(transfers.cacheReadSlow);
  const cached = num(transfers.cachedRequests);
  const ttfb = num(transfers.ttfbP50Ms);
  const p95 = num(transfers.cacheReadP95Ms);
  const bytes = num(transfers.cacheReadBytes);
  if (slow == null || cached == null || ttfb == null) return null;
  if (slow < limit(thresholds, 'cacheReadSlowCount')) return null;
  if (cached < 50) return null;
  if (!(ttfb < 300)) return null;
  return make(
    'local-disk-slow',
    'resources',
    'warn',
    'Cached files are slow to read',
    pairs([
      ['cacheReadSlow', slow],
      ['cacheReadP95Ms', p95],
      ['cacheReadBytes', bytes],
    ]),
    'The local cache was slow to return these files. That time is the cache read itself, not time spent waiting behind other files. Antivirus scanning can cause it.',
  );
}

/**
 * @param {object} snap
 * @param {unknown[]} history
 * @param {object} thresholds
 */
function historyFinding(snap, history, thresholds) {
  if (!Array.isArray(history) || history.length < 3) return null;
  const samples = [];
  for (const row of history) {
    if (!isPlain(row)) continue;
    const total = num(row.totalMs);
    if (total != null && total >= 0) samples.push(total);
  }
  const typical = median(samples);
  const current = num(section(snap, 'durations').totalMs);
  if (typical == null || current == null) return null;
  if (!(current > typical * limit(thresholds, 'slowerThanTypicalFactor') + 1e-6)) return null;
  return make(
    'slower-than-usual',
    'client',
    'info',
    'This join was slower than usual',
    pairs([['totalMs', current], ['typicalMs', typical]]),
    'This join was slower than the recent typical join.',
  );
}

/**
 * When server-slow and network-unstable would both fire, replace them with one info finding.
 *
 * @param {object[]} findings
 * @returns {object[]}
 */
function applyAmbiguity(findings) {
  const slow = findings.find((item) => item.id === 'server-slow');
  const unstable = findings.find((item) => item.id === 'network-unstable');
  if (!slow || !unstable) return findings.slice();
  const rest = findings.filter((item) => item.id !== 'server-slow' && item.id !== 'network-unstable');
  rest.push(make(
    'slow-connection-ambiguous',
    'network',
    'info',
    'Slow server or unstable connection',
    `${slow.evidence}; ${unstable.evidence}`,
    'Candidates: "Server is slow to respond" or "Unstable connection".',
  ));
  return rest;
}

/**
 * Error, then warning, then info. Within a severity: network, server, client, resources, dns.
 *
 * @param {object} a
 * @param {object} b
 * @returns {number}
 */
function compareFindings(a, b) {
  const severity = (SEVERITY_RANK[a.severity] ?? 9) - (SEVERITY_RANK[b.severity] ?? 9);
  if (severity) return severity;
  const category = (CATEGORY_RANK[a.category] ?? 9) - (CATEGORY_RANK[b.category] ?? 9);
  if (category) return category;
  if (a.id < b.id) return -1;
  if (a.id > b.id) return 1;
  return 0;
}

/**
 * @param {object | null | undefined} snapshot
 * @param {{
 *   thresholds?: object,
 *   systemInfo?: object | null,
 *   history?: object[],
 *   baselineReady?: boolean,
 *   speedIndex?: number | null,
 * }} [options]
 * `speedIndex` is accepted for callers. Comparisons use join history from this
 * machine, so the index does not move a threshold by itself.
 * When `baselineReady` is false, rate-based findings are replaced by one
 * baseline-building info. When it is omitted, absolute thresholds are used.
 * @returns {Array<{ id: string, category: string, severity: string, title: string, evidence: string, suggestion: string }>}
 */
function detectIssues(snapshot, options) {
  const opts = isPlain(options) ? options : {};
  const thresholds = isPlain(opts.thresholds) ? opts.thresholds : DEFAULT_THRESHOLDS;
  const systemInfo = isPlain(opts.systemInfo) ? opts.systemInfo : null;
  const history = Array.isArray(opts.history) ? opts.history : [];
  const snap = isPlain(snapshot) ? snapshot : {};
  const flags = baselineFlags(opts);
  const rel = flags.relative
    ? {
      ttfbMedian: historyMedian(history, 'ttfbP50Ms'),
      worldMedian: historyMedian(history, 'worldDataMsPerMb'),
      setupMedian: historyMedian(history, 'setupMsPerDoc'),
    }
    : null;
  const found = [
    dnsFinding(snap),
    offlineFinding(snap),
    timeoutFinding(snap, thresholds),
    unstableFinding(snap, thresholds, flags.suppressSoft),
    flags.suppressSoft ? null : bandwidthFinding(snap, thresholds),
    unreachableFinding(snap, thresholds),
    serverErrorFinding(snap, thresholds),
    flags.suppressSoft ? null : serverSlowFinding(snap, thresholds, rel),
    serverAckFinding(snap, thresholds),
    flags.suppressSoft ? null : worldSlowFinding(snap, thresholds, rel),
    tlsFinding(snap, thresholds),
    crashFinding(snap),
    previousSessionFinding(opts.previousCrash),
    unresponsiveFinding(snap),
    pageErrorFinding(snap, thresholds),
    softwareWebglFinding(snap),
    flags.suppressSoft ? null : localPhaseFinding(snap, thresholds, rel),
    stallFinding(snap, thresholds),
    outdatedFinding(snap),
    heapFinding(snap, thresholds),
    systemMemoryFinding(snap, systemInfo, thresholds),
    gpuMemoryFinding(snap, thresholds),
    cpuFinding(snap, thresholds),
    loadFinding(snap, systemInfo, thresholds),
    cacheFinding(snap, thresholds),
    localDiskFinding(snap, thresholds),
    flags.suppressSoft ? null : historyFinding(snap, history, thresholds),
  ].filter(Boolean);
  if (flags.suppressSoft) {
    found.push(make(
      'baseline-building',
      'client',
      'info',
      'Baseline building',
      `joins=${history.length} needed=3`,
      'Join a few more times so later joins can be compared with this machine.',
    ));
  }
  const resolved = applyAmbiguity(found);
  resolved.sort(compareFindings);
  return resolved;
}

/**
 * @param {object[] | null | undefined} findings
 * @returns {string}
 */
function summarizeFindings(findings) {
  const list = Array.isArray(findings) ? findings : [];
  if (list.length === 0) return 'No issues detected';
  const errors = list.filter((item) => item && item.severity === 'error').length;
  const warnings = list.filter((item) => item && item.severity === 'warn').length;
  const infos = list.filter((item) => item && item.severity === 'info').length;
  const parts = [];
  if (errors) parts.push(`${errors} ${errors === 1 ? 'error' : 'errors'}`);
  if (warnings) parts.push(`${warnings} ${warnings === 1 ? 'warning' : 'warnings'}`);
  if (infos) parts.push(`${infos} ${infos === 1 ? 'info' : 'infos'}`);
  const noun = list.length === 1 ? 'issue' : 'issues';
  if (!parts.length) return `${list.length} ${noun}`;
  return `${list.length} ${noun}: ${parts.join(', ')}`;
}

/**
 * @param {object[] | null | undefined} findings
 * @returns {{ network: number, server: number, client: number, resources: number, dns: number }}
 */
function categoryCounts(findings) {
  const counts = { network: 0, server: 0, client: 0, resources: 0, dns: 0 };
  const list = Array.isArray(findings) ? findings : [];
  for (const item of list) {
    if (!item || !Object.prototype.hasOwnProperty.call(counts, item.category)) continue;
    counts[item.category] += 1;
  }
  return counts;
}

module.exports = {
  DEFAULT_THRESHOLDS,
  detectIssues,
  summarizeFindings,
  categoryCounts,
};
