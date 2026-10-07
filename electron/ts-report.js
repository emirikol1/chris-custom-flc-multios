'use strict';

/**
 * Plain-text troubleshooting report.
 * Every value is copied field by field from a whitelist. Input objects are never
 * spread or JSON.stringified into the output.
 */

const { formatNetTraceText } = require('./net-trace');

const SAFE_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
const ERROR_NAME = /^[A-Z][A-Za-z0-9_]{0,63}$/;
const NET_ERROR = /^ERR_[A-Z0-9_]{1,80}$/;
const FEATURE_TOKEN = /^[a-z0-9_]{1,64}$/;
const FINDING_ID = /^[a-z0-9-]{1,80}$/;
const IPV4 = /\b(?:\d{1,3}\.){3}\d{1,3}\b/;

const SYNC_STATES = new Set(['synced', 'out-of-sync', 'unknown']);
const CAUSES = new Set(['local-offline', 'server-unreachable', 'socket-stalled']);
const WEBGL_MODES = new Set(['hardware', 'software']);
const UPDATE_STATES = new Set(['current', 'ahead', 'available', 'error']);
const GONE_REASONS = new Set(['clean-exit', 'abnormal-exit', 'killed', 'crashed', 'oom', 'launch-failed', 'integrity-failure']);
const SEVERITIES = new Set(['info', 'warn', 'error']);
const CATEGORIES = new Set(['network', 'server', 'client', 'resources', 'dns']);

const PHASES = ['connect', 'joinPageLoaded', 'autologinArmed', 'autologinSubmitted', 'gameNavigation', 'domReady', 'socketConnected', 'worldDataReceived', 'init', 'i18nInit', 'setup', 'canvasReady', 'ready'];
const DURATIONS = ['loginMs', 'pageLoadMs', 'transfersMs', 'worldDataMs', 'initMs', 'i18nMs', 'setupMs', 'canvasMs', 'totalMs'];
const DOCUMENTS = ['actors', 'items', 'scenes', 'journal', 'tables', 'macros', 'playlists', 'cards', 'folders', 'users', 'messages', 'packs'];
const SCENE = ['tokens', 'tiles', 'lights', 'walls'];
const GPU_FEATURES = ['webgl', 'webgl2', 'gpu_compositing', 'rasterization', 'video_decode'];
const TRANSFER_FIELDS = ['requests', 'transferBytes', 'encodedBytes', 'decodedBytes', 'cachedRequests', 'durationMs'];
const RESOURCE_FIELDS = ['rendererHeapUsedBytes', 'rendererHeapLimitBytes', 'rendererCpuPercent', 'rendererMemoryBytes', 'gpuCpuPercent', 'gpuMemoryBytes', 'systemTotalBytes', 'systemFreeBytes', 'loadAvg1', 'cacheBytes', 'cacheLimitBytes'];
const HISTORY_FIELDS = ['at', 'totalMs', 'transfersMs', 'worldDataMs', 'worldDataBytes', 'setupMs', 'canvasMs', 'requests', 'transferBytes', 'cacheHitRatio', 'docs'];
const MODULE_CAP = 200;
const HISTORY_CAP = 10;

/**
 * Fields the report is allowed to contain. Maps hold only the listed value keys.
 */
const REPORT_FIELDS = {
  root: ['clientVersion', 'generatedAt', 'electronVersion', 'chromeVersion', 'nodeVersion', 'issues', 'system', 'foundry', 'world', 'timeline', 'transfers', 'sync', 'network', 'client', 'resources', 'history', 'serverCache'],
  issue: ['id', 'category', 'severity', 'title', 'evidence', 'suggestion'],
  system: ['osPrettyName', 'osRelease', 'osVersion', 'platform', 'arch', 'cpuModel', 'cpuCount', 'loadAvg1', 'memTotalBytes', 'memFreeBytes', 'memAvailableBytes', 'gpu', 'gpuFeatures', 'webglMode', 'webglFallbackReason', 'displays', 'displayCount'],
  gpu: ['vendor', 'device', 'driverVersion', 'driverVendor', 'glRenderer'],
  display: ['width', 'height', 'scaleFactor'],
  gpuFeature: GPU_FEATURES,
  foundry: ['foundryVersion', 'generation', 'systemId', 'systemVersion', 'activeModuleCount', 'modules'],
  module: ['id', 'version'],
  documents: DOCUMENTS,
  scene: SCENE,
  world: ['documents', 'documentBytes', 'scene', 'performanceMode', 'fps', 'hookTime'],
  phases: PHASES,
  durations: DURATIONS,
  transfers: ['requests', 'transferBytes', 'encodedBytes', 'decodedBytes', 'cachedRequests', 'cacheHitRatio', 'revalidatedRequests', 'durationMs', 'busyMs', 'ttfbP50Ms', 'ttfbP95Ms', 'downloadP95Ms', 'slowDownloads', 'cacheReadBytes', 'cacheReadMs', 'cacheReadP95Ms', 'cacheReadSlow', 'byType', 'protocolH1', 'protocolH2', 'scriptH1'],
  transferType: TRANSFER_FIELDS,
  sync: ['state', 'cause', 'connected', 'rttMs', 'rttMinMs', 'rttP50Ms', 'rttP95Ms', 'latencyFloorMs', 'ackP50Ms', 'ackP95Ms', 'pingJitterP95Ms', 'pingJitterSamples', 'reconnects', 'missedPongs', 'lastPacketAgeMs', 'pingIntervalMs', 'pingTimeoutMs', 'lastChangeAt', 'lastRequestMs', 'requestsPerMin', 'messagesPerMin'],
  network: ['errors', 'status4xx', 'status5xx', 'clockSkewMs'],
  client: ['rendererGone', 'unresponsive', 'pageErrors', 'longTasks', 'webglMode', 'webglFallbackReason', 'updateStatus'],
  rendererGone: ['count', 'lastReason'],
  pageErrors: ['count', 'byName'],
  longTasks: ['count', 'worstMs', 'totalMs', 'byPhase'],
  resources: RESOURCE_FIELDS,
  history: HISTORY_FIELDS,
};

/**
 * True when text contains a URL, a home/user path, a Windows path, or a Foundry document ref.
 * @param {unknown} text
 * @returns {boolean}
 */
function containsSensitivePattern(text) {
  if (typeof text !== 'string' || !text) return false;
  if (/https?:\/\//i.test(text)) return true;
  if (/\/home\//.test(text)) return true;
  if (/\/Users\//.test(text)) return true;
  if (/[A-Za-z]:\\/.test(text)) return true;
  if (/\b[A-Z][A-Za-z]{2,}\.[A-Za-z0-9]{16}\b/.test(text)) return true;
  return false;
}

/**
 * Replace accidental URL, path, and document-ref tokens. The rest of a URL or path
 * is removed with the probe so the host or username does not remain.
 * @param {string} text
 * @returns {string}
 */
function scrubText(text) {
  return text
    .replace(/https?:\/\/\S*/gi, '[removed]')
    .replace(/\/home\/\S*/g, '[removed]')
    .replace(/\/Users\/\S*/g, '[removed]')
    .replace(/[A-Za-z]:\\\S*/g, '[removed]')
    .replace(/\b[A-Z][A-Za-z]{2,}\.[A-Za-z0-9]{16}\b/g, '[removed]');
}

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
function copyNum(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {boolean | null}
 */
function copyBool(value) {
  return typeof value === 'boolean' ? value : null;
}

/**
 * @param {unknown} value
 * @param {Set<string>} allowed
 * @returns {string | null}
 */
function copyEnum(value, allowed) {
  return typeof value === 'string' && allowed.has(value) ? value : null;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function copyToken(value) {
  return typeof value === 'string' && SAFE_TOKEN.test(value) ? value : null;
}

/**
 * Package ids and durations only. Empty input stays null so the report omits the list.
 * @param {unknown} value
 * @returns {{ totalMs: number, packages: number, byPackage: Array<{ id: string, ms: number, count: number }> } | null}
 */
function copyHookTime(value) {
  if (!isPlain(value)) return null;
  const rows = Array.isArray(value.byPackage) ? value.byPackage : [];
  const byPackage = [];
  for (let i = 0; i < rows.length; i += 1) {
    const row = rows[i];
    if (!isPlain(row)) continue;
    const id = copyToken(row.id);
    const ms = copyNum(row.ms);
    const count = copyNum(row.count);
    if (!id || ms == null || ms < 0) continue;
    byPackage.push({ id, ms, count: count != null && count >= 0 ? count : 0 });
  }
  byPackage.sort((a, b) => b.ms - a.ms);
  if (byPackage.length > 15) byPackage.length = 15;
  const totalMs = copyNum(value.totalMs);
  const packages = copyNum(value.packages);
  if (!byPackage.length && !(totalMs > 0)) return null;
  return {
    totalMs: totalMs != null && totalMs >= 0 ? totalMs : 0,
    packages: packages != null && packages >= 0 ? packages : byPackage.length,
    byPackage,
  };
}

/**
 * @param {number} ms
 * @returns {string}
 */
function formatPackageMs(ms) {
  if (typeof ms !== 'number' || !Number.isFinite(ms) || ms < 0) return 'n/a';
  if (ms < 1000) return `${Math.round(ms)} ms`;
  const text = (ms / 1000).toFixed(1);
  const trimmed = text.endsWith('.0') ? text.slice(0, -2) : text;
  return `${trimmed} s`;
}

/**
 * @param {unknown} hookTime
 * @returns {string}
 */
function formatSlowPackages(hookTime) {
  if (!isPlain(hookTime) || !Array.isArray(hookTime.byPackage) || !hookTime.byPackage.length) return '';
  const parts = [];
  for (let i = 0; i < hookTime.byPackage.length; i += 1) {
    const row = hookTime.byPackage[i];
    if (!row || typeof row.id !== 'string') continue;
    parts.push(`${row.id} ${formatPackageMs(row.ms)}`);
  }
  if (!parts.length) return '';
  return `Slowest packages: ${parts.join(', ')}`;
}

/**
 * Present strings that fail the id/version token rule become `[invalid]`.
 * Missing values stay null.
 * @param {unknown} value
 * @param {boolean} present
 * @returns {string | null}
 */
function copyId(value, present) {
  if (!present || value == null || value === '') return null;
  return copyToken(value) || '[invalid]';
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function copyLabel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > 180) return null;
  if (containsSensitivePattern(trimmed)) return null;
  if (trimmed.includes('@') || trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (IPV4.test(trimmed)) return null;
  if (/[^\x20-\x7E]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function copyCpuModel(value) {
  if (typeof value !== 'string') return null;
  const spaced = value.trim().replace(/\s+/g, ' ').replace(/ @ /g, ' at ');
  return copyLabel(spaced);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function sanitizeReportString(value) {
  if (typeof value !== 'string') return '';
  if (containsSensitivePattern(value) || value.includes('@') || IPV4.test(value)) return '[removed]';
  return scrubText(value);
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function generatedIso(value) {
  let date;
  if (value instanceof Date) date = value;
  else if (typeof value === 'number' && Number.isFinite(value)) date = new Date(value);
  else date = new Date();
  const time = date.getTime();
  if (!Number.isFinite(time)) return null;
  return date.toISOString();
}

/**
 * @param {object | null} source
 * @param {string[]} keys
 * @returns {object}
 */
function copyNumbers(source, keys) {
  const bag = isPlain(source) ? source : {};
  const out = {};
  for (const key of keys) out[key] = copyNum(bag[key]);
  return out;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function copyRuntimeVersion(value) {
  return copyToken(value);
}

/**
 * @param {object | null} systemInfo
 * @returns {object}
 */
function copySystem(systemInfo) {
  const info = isPlain(systemInfo) ? systemInfo : {};
  const gpu = isPlain(info.gpu) ? info.gpu : {};
  const featuresIn = isPlain(info.gpuFeatures) ? info.gpuFeatures : {};
  const features = {};
  for (const key of GPU_FEATURES) {
    const value = featuresIn[key];
    features[key] = typeof value === 'string' && FEATURE_TOKEN.test(value) ? value : null;
  }
  const displays = [];
  if (Array.isArray(info.displays)) {
    for (const display of info.displays) {
      if (!isPlain(display)) continue;
      const width = copyNum(display.width);
      const height = copyNum(display.height);
      if (width == null || height == null) continue;
      displays.push({ width, height, scaleFactor: copyNum(display.scaleFactor) });
    }
  }
  return {
    osPrettyName: copyLabel(info.osPrettyName),
    osRelease: copyToken(info.osRelease),
    osVersion: copyLabel(info.osVersion),
    platform: copyToken(info.platform),
    arch: copyToken(info.arch),
    cpuModel: copyCpuModel(info.cpuModel),
    cpuCount: copyNum(info.cpuCount),
    loadAvg1: copyNum(info.loadAvg1),
    memTotalBytes: copyNum(info.memTotalBytes),
    memFreeBytes: copyNum(info.memFreeBytes),
    memAvailableBytes: copyNum(info.memAvailableBytes),
    gpu: {
      vendor: copyLabel(gpu.vendor),
      device: copyLabel(gpu.device),
      driverVersion: copyLabel(gpu.driverVersion),
      driverVendor: copyLabel(gpu.driverVendor),
      glRenderer: copyLabel(gpu.glRenderer),
    },
    gpuFeatures: features,
    webglMode: copyEnum(info.webglMode, WEBGL_MODES),
    webglFallbackReason: copyToken(info.webglFallbackReason),
    displays,
    displayCount: displays.length,
  };
}

/**
 * @param {object} world
 * @returns {object}
 */
function copyFoundry(world) {
  const system = isPlain(world.system) ? world.system : null;
  const modules = [];
  if (Array.isArray(world.modules)) {
    const capped = world.modules.slice(0, MODULE_CAP);
    for (const entry of capped) {
      if (!isPlain(entry)) continue;
      modules.push({
        id: copyId(entry.id, true),
        version: copyId(entry.version, true),
      });
    }
  }
  return {
    foundryVersion: copyToken(world.foundryVersion),
    generation: copyNum(world.generation),
    systemId: system ? copyId(system.id, true) : null,
    systemVersion: system ? copyId(system.version, true) : null,
    activeModuleCount: copyNum(world.activeModuleCount),
    modules,
  };
}

/**
 * @param {object} transfers
 * @returns {object}
 */
function copyByType(transfers) {
  const source = isPlain(transfers.byType) ? transfers.byType : {};
  const names = Object.keys(source).filter((name) => SAFE_TOKEN.test(name)).sort();
  const byType = {};
  for (const name of names) {
    if (!isPlain(source[name])) continue;
    byType[name] = copyNumbers(source[name], TRANSFER_FIELDS);
  }
  return byType;
}

/**
 * @param {object} net
 * @returns {object}
 */
function copyErrors(net) {
  const source = isPlain(net.errors) ? net.errors : {};
  const errors = {};
  for (const name of Object.keys(source).sort()) {
    if (!NET_ERROR.test(name)) continue;
    const count = copyNum(source[name]);
    if (count == null || count < 0) continue;
    errors[name] = count;
  }
  return errors;
}

/**
 * @param {object} client
 * @returns {object}
 */
function copyPageErrors(client) {
  const page = isPlain(client.pageErrors) ? client.pageErrors : {};
  const source = isPlain(page.byName) ? page.byName : {};
  const byName = {};
  for (const name of Object.keys(source).sort()) {
    if (!ERROR_NAME.test(name)) continue;
    const count = copyNum(source[name]);
    if (count == null || count < 0) continue;
    byName[name] = count;
  }
  return { count: copyNum(page.count), byName };
}

/**
 * @param {unknown[]} findings
 * @returns {object[]}
 */
function copyFindings(findings) {
  if (!Array.isArray(findings)) return [];
  const out = [];
  for (const finding of findings) {
    if (!isPlain(finding)) continue;
    if (typeof finding.id !== 'string' || !FINDING_ID.test(finding.id)) continue;
    const category = copyEnum(finding.category, CATEGORIES);
    const severity = copyEnum(finding.severity, SEVERITIES);
    if (!category || !severity) continue;
    out.push({
      id: finding.id,
      category,
      severity,
      title: sanitizeReportString(finding.title),
      evidence: sanitizeReportString(finding.evidence),
      suggestion: sanitizeReportString(finding.suggestion),
    });
  }
  return out;
}

/**
 * @param {unknown[]} history
 * @returns {object[]}
 */
function copyHistory(history) {
  if (!Array.isArray(history)) return [];
  const tail = history.slice(-HISTORY_CAP);
  const out = [];
  for (const row of tail) {
    if (!isPlain(row)) continue;
    out.push(copyNumbers(row, HISTORY_FIELDS));
  }
  return out;
}

/**
 * @param {unknown} value
 * @returns {unknown}
 */
function scrubDeep(value) {
  if (typeof value === 'string') return sanitizeReportString(value);
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'boolean' || value == null) return value;
  if (Array.isArray(value)) return value.map((item) => scrubDeep(item));
  if (isPlain(value)) {
    const out = {};
    for (const key of Object.keys(value)) {
      if (containsSensitivePattern(key) || key.includes('@') || key.includes('/') || key.includes('\\')) continue;
      out[key] = scrubDeep(value[key]);
    }
    return out;
  }
  return null;
}

/**
 * @param {{ snapshot?: object, systemInfo?: object, findings?: object[], history?: object[], generatedAt?: Date | number }} input
 * @returns {object}
 */
function assemble(input) {
  const source = isPlain(input) ? input : {};
  const snapshot = isPlain(source.snapshot) ? source.snapshot : {};
  const world = isPlain(snapshot.world) ? snapshot.world : {};
  const transfers = isPlain(snapshot.transfers) ? snapshot.transfers : {};
  const sync = isPlain(snapshot.sync) ? snapshot.sync : {};
  const net = isPlain(snapshot.net) ? snapshot.net : {};
  const http = isPlain(net.httpStatus) ? net.httpStatus : {};
  const client = isPlain(snapshot.client) ? snapshot.client : {};
  const gone = isPlain(client.rendererGone) ? client.rendererGone : {};
  const system = copySystem(source.systemInfo);
  const info = isPlain(source.systemInfo) ? source.systemInfo : {};

  return scrubDeep({
    clientVersion: copyRuntimeVersion(info.clientVersion),
    generatedAt: generatedIso(source.generatedAt),
    electronVersion: copyRuntimeVersion(info.electronVersion),
    chromeVersion: copyRuntimeVersion(info.chromeVersion),
    nodeVersion: copyRuntimeVersion(info.nodeVersion),
    issues: copyFindings(source.findings),
    system,
    foundry: copyFoundry(world),
    world: {
      documents: copyNumbers(world.documents, DOCUMENTS),
      documentBytes: copyNumbers(world.documentBytes, DOCUMENTS),
      scene: copyNumbers(world.scene, SCENE),
      performanceMode: copyNum(world.performanceMode) ?? copyToken(world.performanceMode),
      fps: copyNum(world.fps),
      hookTime: copyHookTime(world.hookTime),
    },
    timeline: {
      phases: copyNumbers(snapshot.phases, PHASES),
      durations: copyNumbers(snapshot.durations, DURATIONS),
    },
    transfers: {
      requests: copyNum(transfers.requests),
      transferBytes: copyNum(transfers.transferBytes),
      encodedBytes: copyNum(transfers.encodedBytes),
      decodedBytes: copyNum(transfers.decodedBytes),
      cachedRequests: copyNum(transfers.cachedRequests),
      cacheHitRatio: copyNum(transfers.cacheHitRatio),
      revalidatedRequests: copyNum(transfers.revalidatedRequests),
      durationMs: copyNum(transfers.durationMs),
      busyMs: copyNum(transfers.busyMs),
      ttfbP50Ms: copyNum(transfers.ttfbP50Ms),
      ttfbP95Ms: copyNum(transfers.ttfbP95Ms),
      downloadP95Ms: copyNum(transfers.downloadP95Ms),
      slowDownloads: copyNum(transfers.slowDownloads),
      cacheReadBytes: copyNum(transfers.cacheReadBytes),
      cacheReadMs: copyNum(transfers.cacheReadMs),
      cacheReadP95Ms: copyNum(transfers.cacheReadP95Ms),
      cacheReadSlow: copyNum(transfers.cacheReadSlow),
      byType: copyByType(transfers),
      protocolH1: copyNum(transfers.protocolH1),
      protocolH2: copyNum(transfers.protocolH2),
      scriptH1: copyNum(transfers.scriptH1),
    },
    sync: {
      state: copyEnum(sync.state, SYNC_STATES),
      cause: copyEnum(sync.cause, CAUSES),
      connected: copyBool(sync.connected),
      rttMs: copyNum(sync.rttMs),
      rttMinMs: copyNum(sync.rttMinMs),
      rttP50Ms: copyNum(sync.rttP50Ms),
      rttP95Ms: copyNum(sync.rttP95Ms),
      latencyFloorMs: copyNum(sync.latencyFloorMs),
      ackP50Ms: copyNum(sync.ackP50Ms),
      ackP95Ms: copyNum(sync.ackP95Ms),
      pingJitterP95Ms: copyNum(sync.pingJitterP95Ms),
      pingJitterSamples: copyNum(sync.pingJitterSamples),
      reconnects: copyNum(sync.reconnects),
      missedPongs: copyNum(sync.missedPongs),
      lastPacketAgeMs: copyNum(sync.lastPacketAgeMs),
      pingIntervalMs: copyNum(sync.pingIntervalMs),
      pingTimeoutMs: copyNum(sync.pingTimeoutMs),
      lastChangeAt: copyNum(sync.lastChangeAt),
      lastRequestMs: copyNum(isPlain(sync.lastRequest) ? sync.lastRequest.ms : null),
      requestsPerMin: copyNum(sync.requestsPerMin),
      messagesPerMin: copyNum(sync.messagesPerMin),
    },
    network: {
      errors: copyErrors(net),
      status4xx: copyNum(http['4xx']),
      status5xx: copyNum(http['5xx']),
      clockSkewMs: copyNum(net.clockSkewMs),
    },
    client: {
      rendererGone: {
        count: copyNum(gone.count),
        lastReason: copyEnum(gone.lastReason, GONE_REASONS),
      },
      unresponsive: copyNum(client.unresponsive),
      pageErrors: copyPageErrors(client),
      longTasks: Object.assign(copyNumbers(client.longTasks, ['count', 'worstMs', 'totalMs']), {
        byPhase: copyNumbers(client.longTasks && client.longTasks.byPhase, ['pre-init', 'init', 'i18nInit', 'setup', 'canvasReady', 'ready']),
      }),
      webglMode: copyEnum(client.webglMode, WEBGL_MODES),
      webglFallbackReason: copyToken(client.webglFallbackReason),
      updateStatus: copyEnum(client.updateStatus, UPDATE_STATES),
    },
    resources: copyNumbers(snapshot.resources, RESOURCE_FIELDS),
    history: copyHistory(source.history),
    serverCache: copyServerCache(source.slowCache),
  });
}

/**
 * @param {number | null} value
 * @returns {string}
 */
function formatBytes(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  const sign = value < 0 ? '-' : '';
  let abs = Math.abs(value);
  const units = ['B', 'KB', 'MB', 'GB', 'TB'];
  let index = 0;
  while (abs >= 1024 && index < units.length - 1) {
    abs /= 1024;
    index += 1;
  }
  if (index === 0) return `${sign}${Math.round(abs)} B`;
  return `${sign}${abs.toFixed(1)} ${units[index]}`;
}

/**
 * @param {number | null} value
 * @returns {string}
 */
function formatMs(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  const sign = value < 0 ? '-' : '';
  const abs = Math.abs(value);
  if (abs < 1000) return `${sign}${Math.round(abs)} ms`;
  return `${sign}${(abs / 1000).toFixed(2)} s`;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function show(value) {
  if (typeof value !== 'string' || value === '') return 'n/a';
  return value;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function showScalar(value) {
  if (typeof value === 'string') return show(value);
  return showNum(value);
}

function showNum(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  if (Number.isInteger(value)) return String(value);
  return String(Math.round(value * 1000) / 1000);
}

/**
 * @param {number | null} value
 * @returns {string}
 */
function formatRatio(value) {
  if (typeof value !== 'number' || !Number.isFinite(value)) return 'n/a';
  return `${(value * 100).toFixed(1)}%`;
}

/**
 * @param {string | null} id
 * @param {string | null} version
 * @returns {string}
 */
function formatPair(id, version) {
  if (id && version) return `${id} ${version}`;
  return id || version || 'n/a';
}

/**
 * @param {object} bag
 * @returns {string}
 */
function formatCounts(bag) {
  return Object.keys(bag).map((key) => `${key} ${showNum(bag[key])}`).join(', ');
}

function formatDocuments(counts, bytes) {
  const sizes = isPlain(bytes) ? bytes : {};
  return Object.keys(counts).map((key) => {
    const size = sizes[key];
    const count = showNum(counts[key]);
    if (typeof size === 'number' && Number.isFinite(size)) return `${key} ${count} (${formatBytes(size)})`;
    return `${key} ${count}`;
  }).join(', ');
}

/**
 * @param {object} bag
 * @returns {string}
 */
function formatTimed(bag) {
  return Object.keys(bag).map((key) => `${key} ${formatMs(bag[key])}`).join(', ');
}

/**
 * @param {object | null} features
 * @returns {string}
 */
function formatFeatures(features) {
  if (!features) return 'n/a';
  const parts = [];
  for (const key of GPU_FEATURES) {
    if (features[key]) parts.push(`${key}=${features[key]}`);
  }
  return parts.length ? parts.join(' ') : 'n/a';
}

/**
 * @param {object[]} displays
 * @returns {string}
 */
function formatDisplays(displays) {
  if (!displays.length) return 'none';
  return displays.map((display) => {
    const scale = display.scaleFactor == null ? '' : ` scale ${showNum(display.scaleFactor)}`;
    return `${showNum(display.width)}x${showNum(display.height)}${scale}`;
  }).join(' | ');
}

/**
 * @param {unknown} value
 * @returns {{ slow: boolean, proxy: 'nginx' | 'other' }}
 */
function copyServerCache(value) {
  const src = value && typeof value === 'object' ? value : null;
  return {
    slow: !!(src && src.slow === true),
    proxy: src && src.proxy === 'nginx' ? 'nginx' : 'other',
  };
}

/**
 * @param {{ slow?: boolean, proxy?: string } | null | undefined} info
 * @returns {string}
 */
function serverCacheConfigLine(info) {
  if (!info || info.slow !== true) return 'Server cache config: ok';
  if (info.proxy === 'nginx') return 'Server cache config: slow (nginx)';
  return 'Server cache config: slow (other)';
}

/**
 * @param {object} report
 * @returns {string}
 */
function render(report) {
  const lines = [];
  lines.push('Foundry Light Client troubleshooting report');
  lines.push([
    `Client ${show(report.clientVersion)}`,
    `Generated ${show(report.generatedAt)}`,
    `Electron ${show(report.electronVersion)}`,
    `Chromium ${show(report.chromeVersion)}`,
    `Node ${show(report.nodeVersion)}`,
  ].join(' | '));
  lines.push('');
  lines.push('Issues detected');
  if (!report.issues.length) {
    lines.push('None');
  } else {
    for (const issue of report.issues) {
      lines.push(`[${issue.severity}] ${issue.title}`);
      lines.push(issue.evidence || 'n/a');
      lines.push(issue.suggestion || 'n/a');
    }
  }
  lines.push('');
  lines.push('System');
  const system = report.system;
  lines.push(`OS ${show(system.osPrettyName)} | release ${show(system.osRelease)} | version ${show(system.osVersion)} | ${show(system.platform)} ${show(system.arch)}`);
  lines.push(`CPU ${show(system.cpuModel)} x${showNum(system.cpuCount)} | load ${showNum(system.loadAvg1)}`);
  lines.push(`Memory ${formatBytes(system.memTotalBytes)} total | ${formatBytes(system.memAvailableBytes)} available | ${formatBytes(system.memFreeBytes)} free`);
  const gpu = system.gpu;
  lines.push(`GPU ${show(gpu.vendor)} | ${show(gpu.device)} | driver ${show(gpu.driverVersion)} | ${show(gpu.driverVendor)} | gl ${show(gpu.glRenderer)}`);
  lines.push(`WebGL ${show(system.webglMode)} | fallback ${show(system.webglFallbackReason)}`);
  lines.push(`Features ${formatFeatures(system.gpuFeatures)}`);
  lines.push(`Displays ${showNum(system.displayCount)} | ${formatDisplays(system.displays)}`);
  lines.push('');
  lines.push('Foundry');
  const foundry = report.foundry;
  lines.push(`Version ${show(foundry.foundryVersion)} | generation ${showNum(foundry.generation)} | system ${formatPair(foundry.systemId, foundry.systemVersion)} | active modules ${showNum(foundry.activeModuleCount)}`);
  for (const mod of foundry.modules) lines.push(formatPair(mod.id, mod.version));
  lines.push('');
  lines.push('World');
  lines.push(`Documents ${formatDocuments(report.world.documents, report.world.documentBytes)}`);
  lines.push(`Scene ${formatCounts(report.world.scene)}`);
  lines.push(`Performance ${showScalar(report.world.performanceMode)} | fps ${showNum(report.world.fps)}`);
  const slowPackages = formatSlowPackages(report.world.hookTime);
  if (slowPackages) lines.push(slowPackages);
  lines.push('');
  lines.push('Join timeline');
  lines.push(`Phases ${formatTimed(report.timeline.phases)}`);
  lines.push(`Durations ${formatTimed(report.timeline.durations)}`);
  lines.push('');
  lines.push('Transfers');
  const transfers = report.transfers;
  lines.push([
    `requests ${showNum(transfers.requests)}`,
    `transfer ${formatBytes(transfers.transferBytes)}`,
    `encoded ${formatBytes(transfers.encodedBytes)}`,
    `decoded ${formatBytes(transfers.decodedBytes)}`,
    `cached ${showNum(transfers.cachedRequests)}`,
    `cache ${formatRatio(transfers.cacheHitRatio)}`,
    `revalidated ${showNum(transfers.revalidatedRequests)}`,
    `fetching ${formatMs(transfers.busyMs)}`,
    `duration ${formatMs(transfers.durationMs)}`,
  ].join(' | '));
  lines.push(`TTFB p50 ${formatMs(transfers.ttfbP50Ms)} | p95 ${formatMs(transfers.ttfbP95Ms)} | download p95 ${formatMs(transfers.downloadP95Ms)} | slow ${showNum(transfers.slowDownloads)}`);
  lines.push(`cache read ${formatBytes(transfers.cacheReadBytes)} in ${formatMs(transfers.cacheReadMs)} | p95 ${formatMs(transfers.cacheReadP95Ms)} | slow ${showNum(transfers.cacheReadSlow)}`);
  const h1 = transfers.protocolH1;
  const h2 = transfers.protocolH2;
  const scripts = transfers.scriptH1;
  if (typeof h1 === 'number' && h1 > 0 && h2 === 0 && typeof scripts === 'number' && scripts > 0) {
    lines.push(`Server serves ${Math.round(scripts)} scripts with Cache-Control: no-cache over HTTP/1.1; enabling HTTP/2 or max-age on /modules and /systems would cut first-join page load.`);
  }
  for (const name of Object.keys(transfers.byType)) {
    const row = transfers.byType[name];
    lines.push(`${name} requests ${showNum(row.requests)}, transfer ${formatBytes(row.transferBytes)}, encoded ${formatBytes(row.encodedBytes)}, decoded ${formatBytes(row.decodedBytes)}, cached ${showNum(row.cachedRequests)}, ${formatMs(row.durationMs)}`);
  }
  lines.push('');
  lines.push('Sync');
  const sync = report.sync;
  lines.push([
    `state ${show(sync.state)}`,
    `cause ${show(sync.cause)}`,
    `connected ${sync.connected == null ? 'n/a' : String(sync.connected)}`,
    `rtt ${formatMs(sync.rttMs)}`,
    `min ${formatMs(sync.rttMinMs)}`,
    `p50 ${formatMs(sync.rttP50Ms)}`,
    `p95 ${formatMs(sync.rttP95Ms)}`,
    `floor ${formatMs(sync.latencyFloorMs)}`,
    `ack p50 ${formatMs(sync.ackP50Ms)}`,
    `ack p95 ${formatMs(sync.ackP95Ms)}`,
    `ping jitter p95 ${formatMs(sync.pingJitterP95Ms)}`,
    `ping jitter samples ${showNum(sync.pingJitterSamples)}`,
    `reconnects ${showNum(sync.reconnects)}`,
    `missed pongs ${showNum(sync.missedPongs)}`,
    `last packet ${formatMs(sync.lastPacketAgeMs)}`,
    `ping interval ${formatMs(sync.pingIntervalMs)}`,
    `ping timeout ${formatMs(sync.pingTimeoutMs)}`,
    `last request ${formatMs(sync.lastRequestMs)}`,
    `requests/min ${showNum(sync.requestsPerMin)}`,
    `messages/min ${showNum(sync.messagesPerMin)}`,
  ].join(' | '));
  lines.push('');
  lines.push('Network errors');
  const errorNames = Object.keys(report.network.errors);
  lines.push(errorNames.length ? errorNames.map((name) => `${name}: ${showNum(report.network.errors[name])}`).join(', ') : 'none');
  lines.push(`4xx ${showNum(report.network.status4xx)} | 5xx ${showNum(report.network.status5xx)} | clock skew ${formatMs(report.network.clockSkewMs)}`);
  lines.push('');
  lines.push('Client');
  const client = report.client;
  lines.push([
    `crashes ${showNum(client.rendererGone.count)}`,
    `reason ${show(client.rendererGone.lastReason)}`,
    `unresponsive ${showNum(client.unresponsive)}`,
    `long tasks ${showNum(client.longTasks.count)}`,
    `worst ${formatMs(client.longTasks.worstMs)}`,
    `blocked ${formatMs(client.longTasks.totalMs)}`,
    `blocked by phase ${formatTimed(client.longTasks.byPhase)}`,
    `webgl ${show(client.webglMode)}`,
    `update ${show(client.updateStatus)}`,
  ].join(' | '));
  const pageNames = Object.keys(client.pageErrors.byName);
  const pageBits = pageNames.map((name) => `${name} ${showNum(client.pageErrors.byName[name])}`);
  lines.push(`page errors ${showNum(client.pageErrors.count)}${pageBits.length ? ` | ${pageBits.join(', ')}` : ''}`);
  lines.push('');
  lines.push('Resources');
  const resources = report.resources;
  lines.push([
    `heap ${formatBytes(resources.rendererHeapUsedBytes)} / ${formatBytes(resources.rendererHeapLimitBytes)}`,
    `renderer cpu ${showNum(resources.rendererCpuPercent)}%`,
    `renderer mem ${formatBytes(resources.rendererMemoryBytes)}`,
    `gpu cpu ${showNum(resources.gpuCpuPercent)}%`,
    `gpu mem ${formatBytes(resources.gpuMemoryBytes)}`,
    `system ${formatBytes(resources.systemFreeBytes)} free / ${formatBytes(resources.systemTotalBytes)}`,
    `load ${showNum(resources.loadAvg1)}`,
    `cache ${formatBytes(resources.cacheBytes)} / ${formatBytes(resources.cacheLimitBytes)}`,
  ].join(' | '));
  lines.push('');
  lines.push('Join history');
  if (!report.history.length) {
    lines.push('None');
  } else {
    for (const row of report.history) {
      lines.push(`total ${formatMs(row.totalMs)} | transfers ${formatMs(row.transfersMs)} | world ${formatMs(row.worldDataMs)} | setup ${formatMs(row.setupMs)}`);
    }
  }
  lines.push(serverCacheConfigLine(report.serverCache));
  return lines.join('\n');
}

/**
 * @param {{ snapshot?: object, systemInfo?: object, findings?: object[], history?: object[], generatedAt?: Date | number }} input
 * @returns {object}
 */
function buildReportObject(input) {
  return assemble(input);
}

/**
 * @param {{ snapshot?: object, systemInfo?: object, findings?: object[], history?: object[], generatedAt?: Date | number }} input
 * @returns {string}
 */
function netTraceBlock(netTrace) {
  if (typeof netTrace === 'string') return netTrace.trim();
  if (!netTrace || typeof netTrace !== 'object' || Array.isArray(netTrace)) return '';
  try {
    return formatNetTraceText(netTrace).trim();
  } catch {
    return '';
  }
}

function buildTroubleshootingReport(input) {
  const text = scrubText(render(assemble(input)));
  const block = netTraceBlock(input && input.netTrace);
  if (!block) return text;
  return `${text}\n\n${block}`;
}

module.exports = {
  buildTroubleshootingReport,
  buildReportObject,
  REPORT_FIELDS,
  containsSensitivePattern,
};
