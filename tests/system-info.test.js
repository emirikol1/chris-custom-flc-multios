import { describe, expect, it } from 'vitest';
import { collectSystemInfo, summarizeAppMetrics } from '../electron/system-info.js';

const TOP_KEYS = [
  'appMetrics',
  'arch',
  'chromeVersion',
  'clientVersion',
  'cpuCount',
  'cpuModel',
  'displayCount',
  'displays',
  'electronVersion',
  'gpu',
  'gpuFeatures',
  'loadAvg1',
  'memAvailableBytes',
  'memFreeBytes',
  'memTotalBytes',
  'nodeVersion',
  'osPrettyName',
  'osRelease',
  'osVersion',
  'platform',
  'webglFallbackReason',
  'webglMode',
];

const GPU_KEYS = ['device', 'driverVendor', 'driverVersion', 'glRenderer', 'vendor'];

function osDouble() {
  return {
    release: () => '6.8.0-40-generic',
    version: () => 'Linux Mint 22.1 kernel',
    cpus: () => [{ model: '  AMD Ryzen 7 5800X  ' }, { model: 'other' }],
    loadavg: () => [0.42, 0.2, 0.1],
    totalmem: () => 999,
    freemem: () => 111,
    hostname: () => 'chris-desktop',
    userInfo: () => ({ username: 'cproctor', homedir: '/home/cproctor' }),
  };
}

function processDouble(extra = {}) {
  return {
    platform: 'linux',
    arch: 'x64',
    pid: 424242,
    versions: { electron: '35.1.2', chrome: '134.0.6998.165', node: '24.14.1' },
    getSystemMemoryInfo: () => ({ total: 1000, free: 400, avail: 700 }),
    env: { USER: 'cproctor', HOME: '/home/cproctor', SECRET: 'flc-secret-token-zz' },
    ...extra,
  };
}

function appDouble(extra = {}) {
  return {
    getGPUInfo: async () => ({
      gpuDevice: [{
        vendorId: 0x10de,
        deviceId: 0x1b80,
        driverVersion: '535.183.01',
        driverVendor: 'NVIDIA',
        vendorString: 'chris-desktop',
        pid: 424242,
      }],
      auxAttributes: {
        glRenderer: 'NVIDIA GeForce GTX 1080',
        glVersion: '/home/cproctor/gl',
      },
    }),
    getGPUFeatureStatus: () => ({
      webgl: 'enabled',
      webgl2: 'enabled_readback',
      gpu_compositing: 'enabled',
      rasterization: 'enabled_on',
      video_decode: 'enabled',
      flash_stage3d: 'disabled',
      info: '/home/cproctor/secret',
    }),
    getAppMetrics: () => {
      extra.metricsCalled = true;
      return [{ pid: 424242, type: 'GPU' }];
    },
    ...extra,
  };
}

describe('collectSystemInfo', () => {
  it('returns only the whitelist, with hex gpu ids and memory from getSystemMemoryInfo', async () => {
    const flags = { metricsCalled: false };
    const seen = [];
    const info = await collectSystemInfo({
      os: osDouble(),
      process: processDouble(),
      app: appDouble(flags),
      screen: {
        getAllDisplays: () => [
          { size: { width: 1920, height: 1080 }, scaleFactor: 1, id: 7, label: 'chris-desktop' },
          { size: { width: 1280, height: 800 }, scaleFactor: 1.5 },
          { label: 'chris-desktop' },
        ],
      },
      gpuPrefs: { preferSoftwareWebgl: true, lastFallbackReason: 'crashed' },
      clientVersion: '0.5.4',
      readFile: (filePath) => {
        seen.push(filePath);
        return 'NAME="Linux Mint"\nPRETTY_NAME="Linux Mint 22.1"\nHOME_URL="https://linuxmint.com/"\n';
      },
    });

    expect(Object.keys(info).sort()).toEqual(TOP_KEYS);
    expect(Object.keys(info.gpu).sort()).toEqual(GPU_KEYS);
    expect(info.clientVersion).toBe('0.5.4');
    expect(info.electronVersion).toBe('35.1.2');
    expect(info.chromeVersion).toBe('134.0.6998.165');
    expect(info.nodeVersion).toBe('24.14.1');
    expect(info.platform).toBe('linux');
    expect(info.arch).toBe('x64');
    expect(info.osRelease).toBe('6.8.0-40-generic');
    expect(info.osVersion).toBe('Linux Mint 22.1 kernel');
    expect(info.osPrettyName).toBe('Linux Mint 22.1');
    expect(info.cpuModel).toBe('AMD Ryzen 7 5800X');
    expect(info.cpuCount).toBe(2);
    expect(info.loadAvg1).toBe(0.42);
    expect(info.memTotalBytes).toBe(1000 * 1024);
    expect(info.memFreeBytes).toBe(400 * 1024);
    expect(info.memAvailableBytes).toBe(700 * 1024);
    expect(info.gpu).toEqual({
      vendor: 'vendorId 0x10de',
      device: 'deviceId 0x1b80',
      driverVersion: '535.183.01',
      driverVendor: 'NVIDIA',
      glRenderer: 'NVIDIA GeForce GTX 1080',
    });
    expect(info.gpuFeatures).toEqual({
      webgl: 'enabled',
      webgl2: 'enabled_readback',
      gpu_compositing: 'enabled',
      rasterization: 'enabled_on',
      video_decode: 'enabled',
    });
    expect(info.webglMode).toBe('software');
    expect(info.webglFallbackReason).toBe('crashed');
    expect(info.displays).toEqual([
      { width: 1920, height: 1080, scaleFactor: 1 },
      { width: 1280, height: 800, scaleFactor: 1.5 },
    ]);
    expect(info.displayCount).toBe(2);
    expect(info.appMetrics).toBeNull();
    expect(flags.metricsCalled).toBe(false);
    expect(seen).toEqual(['/etc/os-release']);

    const blob = JSON.stringify(info);
    expect(blob).not.toContain('chris-desktop');
    expect(blob).not.toContain('cproctor');
    expect(blob).not.toContain('/home/');
    expect(blob).not.toContain('/etc/');
    expect(blob).not.toContain('flc-secret-token-zz');
    expect(blob).not.toContain('424242');
    expect(blob).not.toContain('https://');
    expect(blob).not.toContain('flash_stage3d');
  });

  it('uses null fallbacks when app, screen, and gpu prefs are missing', async () => {
    const info = await collectSystemInfo({
      os: osDouble(),
      process: processDouble(),
      app: null,
      screen: null,
      gpuPrefs: null,
      clientVersion: '/home/cproctor/x',
      readFile: () => 'PRETTY_NAME="Linux Mint 22.1"\n',
    });
    expect(info.gpu).toEqual({
      vendor: null,
      device: null,
      driverVersion: null,
      driverVendor: null,
      glRenderer: null,
    });
    expect(info.gpuFeatures).toBeNull();
    expect(info.webglMode).toBeNull();
    expect(info.webglFallbackReason).toBeNull();
    expect(info.displays).toEqual([]);
    expect(info.displayCount).toBe(0);
    expect(info.clientVersion).toBe('');
    expect(JSON.stringify(info)).not.toContain('/home/');
  });

  it('keeps going when getGPUInfo rejects', async () => {
    const info = await collectSystemInfo({
      os: osDouble(),
      process: processDouble(),
      app: {
        getGPUInfo: async () => {
          throw new Error('/home/cproctor/gpu-failed');
        },
        getGPUFeatureStatus: () => ({ webgl: 'enabled' }),
      },
      gpuPrefs: { preferSoftwareWebgl: false, lastFallbackReason: 'not a token!' },
      clientVersion: '0.5.4',
      readFile: () => 'PRETTY_NAME="Linux Mint 22.1"\n',
    });
    expect(info.gpu.vendor).toBeNull();
    expect(info.gpu.glRenderer).toBeNull();
    expect(info.gpuFeatures).toEqual({ webgl: 'enabled' });
    expect(info.webglMode).toBe('hardware');
    expect(info.webglFallbackReason).toBeNull();
    expect(JSON.stringify(info)).not.toContain('/home/');
  });

  it('omits load and the pretty name on Windows', async () => {
    let read = false;
    const info = await collectSystemInfo({
      os: { ...osDouble(), release: () => '10.0.22631' },
      process: processDouble({ platform: 'win32' }),
      app: null,
      screen: null,
      gpuPrefs: null,
      clientVersion: '0.5.4',
      readFile: () => {
        read = true;
        return 'PRETTY_NAME="Windows"\n';
      },
    });
    expect(info.platform).toBe('win32');
    expect(info.loadAvg1).toBeNull();
    expect(info.osPrettyName).toBeNull();
    expect(info.osRelease).toBe('10.0.22631');
    expect(read).toBe(false);
  });

  it('falls back to os.totalmem and os.freemem when process memory info is missing', async () => {
    const proc = processDouble();
    delete proc.getSystemMemoryInfo;
    const info = await collectSystemInfo({
      os: osDouble(),
      process: proc,
      app: null,
      readFile: () => '',
    });
    expect(info.memTotalBytes).toBe(999);
    expect(info.memFreeBytes).toBe(111);
    expect(info.memAvailableBytes).toBeNull();
  });

  it('falls back to os memory when getSystemMemoryInfo throws', async () => {
    const info = await collectSystemInfo({
      os: osDouble(),
      process: processDouble({
        getSystemMemoryInfo: () => {
          throw new Error('nope');
        },
      }),
      app: null,
      readFile: () => '',
    });
    expect(info.memTotalBytes).toBe(999);
    expect(info.memFreeBytes).toBe(111);
    expect(info.memAvailableBytes).toBeNull();
  });
});

describe('summarizeAppMetrics', () => {
  const metrics = [
    { pid: 11111, type: 'Browser', cpu: { percentCPUUsage: 5 }, memory: { workingSetSize: 1000, peakWorkingSetSize: 99999 } },
    { pid: 22222, type: 'Tab', cpu: { percentCPUUsage: 40 }, memory: { workingSetSize: 2000, peakWorkingSetSize: 99999 } },
    { pid: 33333, type: 'GPU', cpu: { percentCPUUsage: 12 }, memory: { workingSetSize: 500, peakWorkingSetSize: 99999 } },
    { pid: 44444, type: 'Utility', cpu: { percentCPUUsage: 1 }, memory: { workingSetSize: 100, peakWorkingSetSize: 99999 } },
  ];

  it('sums the renderer pid, the gpu process, and every process', () => {
    const summary = summarizeAppMetrics(metrics, { rendererPid: 22222, gpu: true });
    expect(summary).toEqual({
      renderer: { cpuPercent: 40, memoryBytes: 2000 * 1024 },
      gpu: { cpuPercent: 12, memoryBytes: 500 * 1024 },
      total: { cpuPercent: 58, memoryBytes: 3600 * 1024 },
    });
    const blob = JSON.stringify(summary);
    expect(blob).not.toContain('pid');
    expect(blob).not.toContain('11111');
    expect(blob).not.toContain('22222');
    expect(blob).not.toContain('33333');
    expect(blob).not.toContain('44444');
    expect(blob).not.toContain('99999');
  });

  it('drops gpu when asked and leaves renderer null when the pid is absent', () => {
    expect(summarizeAppMetrics(metrics, { rendererPid: 22222, gpu: false }).gpu).toBeNull();
    const missing = summarizeAppMetrics(metrics, { rendererPid: 55555 });
    expect(missing.renderer).toBeNull();
    expect(missing.gpu).toEqual({ cpuPercent: 12, memoryBytes: 500 * 1024 });
    expect(missing.total.cpuPercent).toBe(58);
    expect(summarizeAppMetrics(null)).toEqual({
      renderer: null,
      gpu: null,
      total: { cpuPercent: 0, memoryBytes: 0 },
    });
  });
});
