'use strict';

/**
 * Whitelisted system facts for a troubleshooting report.
 * The returned object never includes hostname, username, env vars, pids, or paths.
 * Callers pass Electron and OS objects in so tests can run without Electron.
 */

const OS_RELEASE_PATH = '/etc/os-release';
const GPU_FEATURE_KEYS = ['webgl', 'webgl2', 'gpu_compositing', 'rasterization', 'video_decode'];
const VERSION_TOKEN = /^[A-Za-z0-9.+_-]{1,64}$/;
const PLATFORM_TOKEN = /^[a-z0-9]+$/;
const ARCH_TOKEN = /^[a-z0-9_]+$/;
const FALLBACK_TOKEN = /^[A-Za-z0-9._-]{1,64}$/;
const FEATURE_TOKEN = /^[a-z0-9_]{1,64}$/;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {Function} fn
 * @returns {unknown}
 */
function safeCall(fn) {
  try {
    return fn();
  } catch {
    return undefined;
  }
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string | null}
 */
function cleanLabel(value, max) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > max) return null;
  if (trimmed.includes('/') || trimmed.includes('\\') || trimmed.includes('@')) return null;
  if (/https?:/i.test(trimmed)) return null;
  if (/[\u0000-\u001f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function cleanVersion(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim();
  return VERSION_TOKEN.test(trimmed) ? trimmed : null;
}

/**
 * @param {string} label
 * @param {unknown} value
 * @returns {string | null}
 */
function formatPciId(label, value) {
  if (!isFiniteNumber(value) || !Number.isInteger(value) || value < 0 || value > 0xffffffff) return null;
  return `${label} 0x${value.toString(16).padStart(4, '0')}`;
}

/**
 * @param {string} text
 * @returns {string | null}
 */
function parsePrettyName(text) {
  const source = String(text || '').replace(/^\uFEFF/, '');
  for (const rawLine of source.split(/\r?\n/)) {
    const line = rawLine.trim();
    const match = /^PRETTY_NAME=(?:"([^"]*)"|'([^']*)'|(\S+))\s*$/.exec(line);
    if (!match) continue;
    return cleanLabel(match[1] || match[2] || match[3] || '', 120);
  }
  return null;
}

/**
 * @param {string} filePath
 * @returns {string}
 */
function defaultReadOsRelease(filePath) {
  const fs = require('fs');
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * @param {unknown} data
 * @returns {string}
 */
function asText(data) {
  if (typeof data === 'string') return data;
  if (typeof Buffer !== 'undefined' && Buffer.isBuffer(data)) return data.toString('utf8');
  return '';
}

/**
 * @param {{ platform?: string, readFile?: Function }} options
 * @returns {Promise<string | null>}
 */
async function readPrettyName(options) {
  if (options.platform !== 'linux') return null;
  const readFile = typeof options.readFile === 'function' ? options.readFile : defaultReadOsRelease;
  try {
    const data = await readFile(OS_RELEASE_PATH);
    return parsePrettyName(asText(data));
  } catch {
    return null;
  }
}

/**
 * @param {object | null} app
 * @returns {Promise<{ vendor: string | null, device: string | null, driverVersion: string | null, driverVendor: string | null, glRenderer: string | null }>}
 */
async function readGpu(app) {
  const empty = {
    vendor: null,
    device: null,
    driverVersion: null,
    driverVendor: null,
    glRenderer: null,
  };
  if (!app || typeof app.getGPUInfo !== 'function') return empty;
  let info;
  try {
    info = await app.getGPUInfo('basic');
  } catch {
    return empty;
  }
  const device = info && Array.isArray(info.gpuDevice) ? info.gpuDevice[0] : null;
  const aux = info && info.auxAttributes && typeof info.auxAttributes === 'object' ? info.auxAttributes : null;
  return {
    vendor: formatPciId('vendorId', device && device.vendorId),
    device: formatPciId('deviceId', device && device.deviceId),
    driverVersion: cleanLabel(device && device.driverVersion, 80),
    driverVendor: cleanLabel(device && device.driverVendor, 80),
    glRenderer: cleanLabel(aux && aux.glRenderer, 160),
  };
}

/**
 * @param {object | null} app
 * @returns {Promise<object | null>}
 */
async function readGpuFeatures(app) {
  if (!app || typeof app.getGPUFeatureStatus !== 'function') return null;
  let status;
  try {
    status = await app.getGPUFeatureStatus();
  } catch {
    return null;
  }
  if (!status || typeof status !== 'object') return null;
  const out = {};
  for (const key of GPU_FEATURE_KEYS) {
    const value = status[key];
    if (typeof value === 'string' && FEATURE_TOKEN.test(value)) out[key] = value;
  }
  return out;
}

/**
 * @param {object | null} screen
 * @returns {{ width: number, height: number, scaleFactor: number | null }[]}
 */
function readDisplays(screen) {
  if (!screen || typeof screen.getAllDisplays !== 'function') return [];
  const list = safeCall(() => screen.getAllDisplays());
  if (!Array.isArray(list)) return [];
  const displays = [];
  for (const display of list) {
    const size = display && display.size;
    const width = size && isFiniteNumber(size.width) ? size.width : null;
    const height = size && isFiniteNumber(size.height) ? size.height : null;
    if (width == null || height == null) continue;
    displays.push({
      width,
      height,
      scaleFactor: isFiniteNumber(display.scaleFactor) ? display.scaleFactor : null,
    });
  }
  return displays;
}

/**
 * @param {object} proc
 * @param {object} osMod
 * @returns {{ memTotalBytes: number | null, memFreeBytes: number | null, memAvailableBytes: number | null }}
 */
function readMemory(proc, osMod, options) {
  const mem = { memTotalBytes: null, memFreeBytes: null, memAvailableBytes: null };
  if (proc && typeof proc.getSystemMemoryInfo === 'function') {
    const info = safeCall(() => proc.getSystemMemoryInfo());
    if (info && typeof info === 'object') {
      if (isFiniteNumber(info.total)) mem.memTotalBytes = info.total * 1024;
      if (isFiniteNumber(info.free)) mem.memFreeBytes = info.free * 1024;
      const avail = isFiniteNumber(info.avail) ? info.avail : (isFiniteNumber(info.available) ? info.available : null);
      if (avail != null) mem.memAvailableBytes = avail * 1024;
    }
  }
  if (mem.memTotalBytes == null && osMod && typeof osMod.totalmem === 'function') {
    const total = safeCall(() => osMod.totalmem());
    if (isFiniteNumber(total)) mem.memTotalBytes = total;
  }
  if (mem.memFreeBytes == null && osMod && typeof osMod.freemem === 'function') {
    const free = safeCall(() => osMod.freemem());
    if (isFiniteNumber(free)) mem.memFreeBytes = free;
  }
  if (mem.memAvailableBytes == null) {
    mem.memAvailableBytes = readMemAvailableBytes({
      platform: proc && proc.platform,
      readFile: options && typeof options.readFile === 'function' ? options.readFile : undefined,
    });
  }
  return mem;
}

/**
 * Memory the OS could hand out right now. On Linux "free" (MemFree) excludes
 * reclaimable page cache and badly understates headroom, so use MemAvailable.
 * Other platforms return null; callers fall back to free.
 * @param {{ platform?: string, readFile?: (p: string, enc: string) => string }} [deps]
 * @returns {number | null}
 */
function readMemAvailableBytes(deps) {
  const d = deps || {};
  const platform = typeof d.platform === 'string' ? d.platform : process.platform;
  if (platform !== 'linux') return null;
  const read = typeof d.readFile === 'function' ? d.readFile : (p, enc) => require('fs').readFileSync(p, enc);
  const text = safeCall(() => read('/proc/meminfo', 'utf8'));
  if (typeof text !== 'string') return null;
  const m = /^MemAvailable:\s+(\d+)\s*kB/m.exec(text);
  if (!m) return null;
  const kb = Number(m[1]);
  return Number.isFinite(kb) ? kb * 1024 : null;
}

/**
 * CPU marketing strings often contain "@". Paths and URLs still do not pass.
 * @param {unknown} value
 * @returns {string | null}
 */
function cleanCpuModel(value) {
  if (typeof value !== 'string') return null;
  const trimmed = value.trim().replace(/\s+/g, ' ');
  if (!trimmed || trimmed.length > 160) return null;
  if (trimmed.includes('/') || trimmed.includes('\\')) return null;
  if (/https?:/i.test(trimmed)) return null;
  if (/[\u0000-\u001f]/.test(trimmed)) return null;
  return trimmed;
}

/**
 * @param {object} osMod
 * @returns {{ cpuModel: string | null, cpuCount: number }}
 */
function readCpu(osMod) {
  const cpus = osMod && typeof osMod.cpus === 'function' ? safeCall(() => osMod.cpus()) : [];
  const list = Array.isArray(cpus) ? cpus : [];
  const model = list[0] && typeof list[0].model === 'string' ? cleanCpuModel(list[0].model) : null;
  return { cpuModel: model, cpuCount: list.length };
}

/**
 * @param {object} osMod
 * @param {string | null} platform
 * @returns {number | null}
 */
function readLoad(osMod, platform) {
  if (platform === 'win32') return null;
  if (!osMod || typeof osMod.loadavg !== 'function') return null;
  const loads = safeCall(() => osMod.loadavg());
  if (!Array.isArray(loads) || !isFiniteNumber(loads[0])) return null;
  return loads[0];
}

/**
 * Collect a whitelist of client and machine facts.
 * `appMetrics` is always null; use {@link summarizeAppMetrics} with a renderer pid.
 * `readFile` is optional and is only called on Linux, with `/etc/os-release`.
 *
 * @param {{
 *   os?: object,
 *   process?: object,
 *   app?: object | null,
 *   screen?: object | null,
 *   gpuPrefs?: { preferSoftwareWebgl?: boolean, lastFallbackReason?: string | null } | null,
 *   clientVersion?: string,
 *   readFile?: (filePath: string) => string | Promise<string>,
 * }} [deps]
 * @returns {Promise<object>}
 */
async function collectSystemInfo(deps) {
  const options = deps && typeof deps === 'object' ? deps : {};
  const osMod = options.os || require('os');
  const proc = options.process || process;
  const versions = proc && proc.versions && typeof proc.versions === 'object' ? proc.versions : {};
  const platform = proc && typeof proc.platform === 'string' && PLATFORM_TOKEN.test(proc.platform) ? proc.platform : null;
  const arch = proc && typeof proc.arch === 'string' && ARCH_TOKEN.test(proc.arch) ? proc.arch : null;
  const clientVersion = typeof options.clientVersion === 'string' && VERSION_TOKEN.test(options.clientVersion)
    ? options.clientVersion
    : '';
  const gpuPrefs = options.gpuPrefs == null ? null : options.gpuPrefs;
  const cpu = readCpu(osMod);
  const memory = readMemory(proc, osMod, options);
  const displays = readDisplays(options.screen || null);
  const release = osMod && typeof osMod.release === 'function' ? safeCall(() => osMod.release()) : null;
  const version = osMod && typeof osMod.version === 'function' ? safeCall(() => osMod.version()) : null;
  const fallback = gpuPrefs && gpuPrefs.lastFallbackReason;

  return {
    clientVersion,
    electronVersion: cleanVersion(versions.electron),
    chromeVersion: cleanVersion(versions.chrome),
    nodeVersion: cleanVersion(versions.node),
    platform,
    arch,
    osRelease: cleanLabel(release, 80),
    osVersion: cleanLabel(version, 180),
    osPrettyName: await readPrettyName({ platform, readFile: options.readFile }),
    cpuModel: cpu.cpuModel,
    cpuCount: cpu.cpuCount,
    loadAvg1: readLoad(osMod, platform),
    memTotalBytes: memory.memTotalBytes,
    memFreeBytes: memory.memFreeBytes,
    memAvailableBytes: memory.memAvailableBytes,
    gpu: await readGpu(options.app || null),
    gpuFeatures: await readGpuFeatures(options.app || null),
    webglMode: gpuPrefs == null ? null : (gpuPrefs.preferSoftwareWebgl ? 'software' : 'hardware'),
    webglFallbackReason: typeof fallback === 'string' && FALLBACK_TOKEN.test(fallback) ? fallback : null,
    displays,
    displayCount: displays.length,
    appMetrics: null,
  };
}

/**
 * Sum CPU and memory from `app.getAppMetrics()`. Pids are used only to match
 * the renderer and are never copied into the result.
 *
 * @param {unknown} metrics
 * @param {{ rendererPid?: number, gpu?: boolean }} [options]
 * @returns {{
 *   renderer: { cpuPercent: number, memoryBytes: number } | null,
 *   gpu: { cpuPercent: number, memoryBytes: number } | null,
 *   total: { cpuPercent: number, memoryBytes: number },
 * }}
 */
function summarizeAppMetrics(metrics, options) {
  const opts = options && typeof options === 'object' ? options : {};
  const includeGpu = opts.gpu !== false;
  const rendererPid = isFiniteNumber(opts.rendererPid) ? opts.rendererPid : null;
  const list = Array.isArray(metrics) ? metrics : [];
  let totalCpu = 0;
  let totalMem = 0;
  let rendererCpu = 0;
  let rendererMem = 0;
  let rendererFound = false;
  let gpuCpu = 0;
  let gpuMem = 0;
  let gpuFound = false;

  for (const metric of list) {
    if (!metric || typeof metric !== 'object') continue;
    const cpu = metric.cpu && isFiniteNumber(metric.cpu.percentCPUUsage) ? metric.cpu.percentCPUUsage : 0;
    const mem = metric.memory && isFiniteNumber(metric.memory.workingSetSize) ? metric.memory.workingSetSize * 1024 : 0;
    totalCpu += cpu;
    totalMem += mem;
    if (rendererPid != null && metric.pid === rendererPid) {
      rendererFound = true;
      rendererCpu += cpu;
      rendererMem += mem;
    }
    if (includeGpu && typeof metric.type === 'string' && metric.type.toLowerCase() === 'gpu') {
      gpuFound = true;
      gpuCpu += cpu;
      gpuMem += mem;
    }
  }

  return {
    renderer: rendererFound ? { cpuPercent: rendererCpu, memoryBytes: rendererMem } : null,
    gpu: gpuFound ? { cpuPercent: gpuCpu, memoryBytes: gpuMem } : null,
    total: { cpuPercent: totalCpu, memoryBytes: totalMem },
  };
}

module.exports = {
  collectSystemInfo,
  readMemAvailableBytes,
  summarizeAppMetrics,
};
