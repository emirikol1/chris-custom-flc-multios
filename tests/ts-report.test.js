import { describe, expect, it } from 'vitest';
import {
  REPORT_FIELDS,
  buildReportObject,
  buildTroubleshootingReport,
  containsSensitivePattern,
} from '../electron/ts-report.js';
import { redactReport } from '../electron/net-trace.js';

const GENERATED = new Date('2026-10-06T20:00:00.000Z');

const TOKENS = [
  'https://exandria.example.net/ secret',
  'exandria.example.net',
  '../../etc/passwd',
  'passwd',
  'secret-label',
  'gm-username',
  'chris-desktop',
  'cproctor',
  'Actor.9X9JkctFMogBiagD',
  'chris@example.com',
  '203.0.113.10',
  '/home/cproctor/x',
  '/home/',
  'page blew up at login',
];

function poisonedSnapshot() {
  return {
    serverUrl: 'https://exandria.example.net/ secret',
    label: 'secret-label',
    email: 'chris@example.com',
    ip: '203.0.113.10',
    path: '/home/cproctor/x',
    hostname: 'chris-desktop',
    username: 'cproctor',
    loadSeq: 4,
    startedAt: 1700000000000,
    phases: {
      connect: 5,
      joinPageLoaded: 80,
      autologinArmed: 90,
      autologinSubmitted: 100,
      gameNavigation: 150,
      domReady: 200,
      socketConnected: 240,
      worldDataReceived: 400,
      init: 450,
      i18nInit: 470,
      setup: 520,
      canvasReady: 700,
      ready: 760,
      worldTitle: 'https://exandria.example.net/ secret',
    },
    durations: {
      transfersMs: 400,
      worldDataMs: 180,
      initMs: 50,
      i18nMs: 20,
      setupMs: 70,
      canvasMs: 90,
      totalMs: 760,
      note: '/home/cproctor/x',
    },
    transfers: {
      requests: 40,
      transferBytes: 1200000,
      encodedBytes: 1100000,
      decodedBytes: 3000000,
      cachedRequests: 10,
      cacheHitRatio: 0.25,
      durationMs: 400,
      ttfbP50Ms: 40,
      ttfbP95Ms: 90,
      downloadP95Ms: 200,
      slowDownloads: 1,
      url: 'https://exandria.example.net/ secret',
      byType: {
        script: {
          requests: 4,
          transferBytes: 1000,
          encodedBytes: 800,
          decodedBytes: 2000,
          cachedRequests: 1,
          durationMs: 20,
          url: 'https://exandria.example.net/ secret',
        },
        'https://exandria.example.net/secret': { requests: 9, transferBytes: 9, encodedBytes: 9, decodedBytes: 9, cachedRequests: 0, durationMs: 9 },
        '../../etc/passwd': { requests: 8, transferBytes: 8, encodedBytes: 8, decodedBytes: 8, cachedRequests: 0, durationMs: 8 },
      },
    },
    worldData: { bytes: 500000, ms: 180, worldTitle: 'Exandria' },
    world: {
      title: 'https://exandria.example.net/ secret',
      id: 'Actor.9X9JkctFMogBiagD',
      name: 'gm-username',
      foundryVersion: '13.348',
      generation: 12,
      system: { id: 'dnd5e', version: '3.3.1', title: 'https://exandria.example.net/ secret' },
      modules: [
        { id: 'dnd5e', version: '3.3.1', title: 'https://exandria.example.net/ secret' },
        { id: '../../etc/passwd', version: '9.9.9', name: 'cproctor' },
      ],
      activeModuleCount: 2,
      userNames: ['cproctor', 'gm-username'],
      documents: {
        actors: 42,
        items: 3,
        scenes: 2,
        journal: 1,
        tables: 0,
        macros: 0,
        playlists: 0,
        cards: 0,
        folders: 1,
        users: 7,
        messages: 11,
        packs: 1,
        actorIds: ['Actor.9X9JkctFMogBiagD'],
      },
      documentBytes: { actors: 43201331 },
      scene: {
        tokens: 5,
        tiles: 3,
        lights: 2,
        walls: 40,
        background: '/home/cproctor/x',
      },
      performanceMode: 1,
      performanceLabel: 'secret-label',
      fps: 60,
    },
    sync: {
      state: 'synced',
      connected: true,
      rttMs: 30,
      rttMinMs: 22,
      rttP50Ms: 28,
      rttP95Ms: 45,
      latencyFloorMs: 22,
      ackP50Ms: 40,
      ackP95Ms: 1700,
      pingJitterP95Ms: 12,
      pingJitterSamples: 6,
      lastRequest: { name: 'modifyDocument', ms: 83, ageMs: 2000 },
      requestsPerMin: 12,
      messagesPerMin: 240,
      reconnects: 0,
      missedPongs: 0,
      lastPacketAgeMs: 100,
      pingIntervalMs: 5000,
      pingTimeoutMs: 20000,
      cause: 'https://exandria.example.net/ secret',
      lastChangeAt: 5,
      user: 'gm-username',
    },
    net: {
      errors: {
        ERR_CONNECTION_RESET: 2,
        'https://exandria.example.net/secret': 4,
        'chris@example.com': 1,
      },
      httpStatus: { '4xx': 1, '5xx': 0, 'https://exandria.example.net/': 6 },
      clockSkewMs: 12,
      host: 'chris-desktop',
    },
    client: {
      rendererGone: { count: 0, lastReason: 'https://exandria.example.net/ secret', detail: 'page blew up at login' },
      unresponsive: 0,
      pageErrors: {
        count: 3,
        lastMessage: 'page blew up at login',
        byName: {
          TypeError: 3,
          'page blew up at login': 8,
          'Actor.9X9JkctFMogBiagD': 2,
        },
      },
      longTasks: { count: 1, worstMs: 40, stack: '/home/cproctor/x' },
      webglMode: 'hardware',
      webglFallbackReason: 'crashed',
      updateStatus: 'current',
      label: 'secret-label',
    },
    resources: {
      rendererHeapUsedBytes: 100000000,
      rendererHeapLimitBytes: 1000000000,
      rendererCpuPercent: 12,
      rendererMemoryBytes: 200000000,
      gpuCpuPercent: 5,
      gpuMemoryBytes: 100000000,
      systemTotalBytes: 32000000000,
      systemFreeBytes: 4000000000,
      loadAvg1: 0.42,
      cacheBytes: 10000000,
      cacheLimitBytes: 100000000,
      note: 'chris@example.com',
    },
    updatedAt: 9,
  };
}

function poisonedSystemInfo() {
  return {
    clientVersion: '0.5.4',
    electronVersion: '35.1.2',
    chromeVersion: '134.0.6998.165',
    nodeVersion: '24.14.1',
    platform: 'linux',
    arch: 'x64',
    osRelease: '6.8.0-40-generic',
    osVersion: 'Linux Mint 22.1 kernel',
    osPrettyName: 'Linux Mint 22.1',
    cpuModel: 'AMD Ryzen 7 5800X',
    cpuCount: 8,
    loadAvg1: 0.42,
    memTotalBytes: 32 * 1024 * 1024 * 1024,
    memFreeBytes: 4 * 1024 * 1024 * 1024,
    memAvailableBytes: 20 * 1024 * 1024 * 1024,
    gpu: {
      vendor: 'vendorId 0x1002',
      device: 'deviceId 0x73bf',
      driverVersion: '535.183.01',
      driverVendor: 'AMD',
      glRenderer: 'AMD Radeon RX 6800',
      secretPath: '/home/cproctor/x',
    },
    gpuFeatures: {
      webgl: 'enabled',
      webgl2: 'enabled',
      gpu_compositing: 'enabled',
      rasterization: 'enabled_on',
      video_decode: 'enabled',
      flash_stage3d: 'disabled',
      note: 'https://exandria.example.net/ secret',
    },
    webglMode: 'hardware',
    webglFallbackReason: 'crashed',
    displays: [
      { width: 1920, height: 1080, scaleFactor: 1, label: 'chris-desktop', bounds: { x: 0 } },
    ],
    displayCount: 99,
    appMetrics: { pid: 4242, path: '/home/cproctor/x' },
    hostname: 'chris-desktop',
    username: 'cproctor',
    homedir: '/home/cproctor/x',
    email: 'chris@example.com',
    ip: '203.0.113.10',
  };
}

function historyRows() {
  const rows = [];
  for (let index = 1; index <= 12; index += 1) {
    rows.push({
      at: 1000 + index,
      totalMs: 80000 + index,
      transfersMs: 100 + index,
      worldDataMs: 200 + index,
      worldDataBytes: 5000 + index,
      setupMs: 300 + index,
      canvasMs: 40 + index,
      requests: 10 + index,
      transferBytes: 1000 + index,
      cacheHitRatio: 0.5,
      docs: 20 + index,
      url: 'https://exandria.example.net/ secret',
      user: 'cproctor',
      worldTitle: 'gm-username',
      path: '/home/cproctor/x',
    });
  }
  return rows;
}

function input(extra = {}) {
  return {
    snapshot: poisonedSnapshot(),
    systemInfo: poisonedSystemInfo(),
    findings: [
      {
        id: 'dns-unresolved',
        category: 'dns',
        severity: 'error',
        title: 'Server name could not be resolved (DNS)',
        evidence: 'count=2',
        suggestion: 'Check DNS and the server address.',
        detail: 'https://exandria.example.net/ secret',
      },
    ],
    history: historyRows(),
    generatedAt: GENERATED,
    ...extra,
  };
}

function assertClean(blob) {
  for (const token of TOKENS) expect(blob).not.toContain(token);
  expect(blob.toLowerCase()).not.toContain('http');
  expect(blob).not.toContain('@');
  expect(blob).not.toContain('/home/');
}

describe('containsSensitivePattern', () => {
  it('matches urls, home paths, and foundry document refs only', () => {
    expect(containsSensitivePattern('ok')).toBe(false);
    expect(containsSensitivePattern('13.348')).toBe(false);
    expect(containsSensitivePattern('dnd5e 3.3.1')).toBe(false);
    expect(containsSensitivePattern('')).toBe(false);
    expect(containsSensitivePattern(null)).toBe(false);
    expect(containsSensitivePattern('see https://example.com/a')).toBe(true);
    expect(containsSensitivePattern('see http://example.com/a')).toBe(true);
    expect(containsSensitivePattern('file /home/cproctor/x')).toBe(true);
    expect(containsSensitivePattern('file /Users/cproctor/x')).toBe(true);
    expect(containsSensitivePattern('C:\\Windows\\System32')).toBe(true);
    expect(containsSensitivePattern('Actor.9X9JkctFMogBiagD')).toBe(true);
  });
});

describe('buildTroubleshootingReport', () => {
  it('keeps versions and counts and drops every poisoned string', () => {
    const report = buildReportObject(input());
    const text = buildTroubleshootingReport(input());
    assertClean(text);
    assertClean(JSON.stringify(report));

    expect(text).toContain('Foundry Light Client troubleshooting report');
    expect(text).toContain('2026-10-06T20:00:00.000Z');
    expect(text).toContain('0.5.4');
    expect(text).toContain('35.1.2');
    expect(text).toContain('134.0.6998.165');
    expect(text).toContain('24.14.1');
    expect(text).toContain('13.348');
    expect(text).toContain('dnd5e 3.3.1');
    expect(text).toContain('[invalid] 9.9.9');
    expect(text).toContain('actors 42');
    expect(text).toContain('AMD Ryzen 7 5800X');
    expect(text).toContain('Linux Mint 22.1');
    expect(text).toContain('vendorId 0x1002');
    expect(text).toContain('TypeError 3');
    expect(text).toContain('ERR_CONNECTION_RESET: 2');
    expect(text).toContain('Server name could not be resolved (DNS)');
    for (const header of ['Issues detected', 'System', 'Foundry', 'World', 'Join timeline', 'Transfers', 'Sync', 'Network errors', 'Client', 'Resources', 'Join history']) {
      expect(text).toContain(`\n${header}\n`);
    }
    const lineCount = text.split('\n').length;
    expect(lineCount).toBeGreaterThanOrEqual(40);
    expect(lineCount).toBeLessThanOrEqual(80);

    expect(Object.keys(report)).toEqual(REPORT_FIELDS.root);
    expect(Object.keys(report.system)).toEqual(REPORT_FIELDS.system);
    expect(Object.keys(report.system.gpu)).toEqual(REPORT_FIELDS.gpu);
    expect(Object.keys(report.system.gpuFeatures)).toEqual(REPORT_FIELDS.gpuFeature);
    expect(report.system.gpuFeatures).not.toHaveProperty('flash_stage3d');
    expect(Object.keys(report.system.displays[0])).toEqual(REPORT_FIELDS.display);
    expect(report.system.displayCount).toBe(1);
    expect(Object.keys(report.foundry)).toEqual(REPORT_FIELDS.foundry);
    expect(report.foundry.modules.map((mod) => mod.id)).toEqual(['dnd5e', '[invalid]']);
    expect(Object.keys(report.foundry.modules[0])).toEqual(REPORT_FIELDS.module);
    expect(Object.keys(report.world)).toEqual(REPORT_FIELDS.world);
    expect(Object.keys(report.world.documents)).toEqual(REPORT_FIELDS.documents);
    expect(report.world.documents.actors).toBe(42);
    expect(report.world.fps).toBe(60);
    expect(report.foundry.generation).toBe(12);
    expect(Object.keys(report.timeline.phases)).toEqual(REPORT_FIELDS.phases);
    expect(Object.keys(report.transfers.byType)).toEqual(['script']);
    expect(report.sync.cause).toBeNull();
    expect(report.sync.state).toBe('synced');
    expect(Object.keys(report.sync)).toEqual(REPORT_FIELDS.sync);
    expect(report.sync.latencyFloorMs).toBe(22);
    expect(report.sync.ackP50Ms).toBe(40);
    expect(report.sync.ackP95Ms).toBe(1700);
    expect(report.sync.pingJitterP95Ms).toBe(12);
    expect(report.sync.pingJitterSamples).toBe(6);
    expect(text).toContain('ack p95 1.70 s');
    expect(text).toContain('ping jitter samples 6');
    expect(text).toContain('actors 42 (41.2 MB)');
    expect(text).toContain('last request 83 ms');
    expect(text).toContain('requests/min 12');
    expect(text).toContain('messages/min 240');
    expect(report.sync.lastRequestMs).toBe(83);
    expect(report.sync.requestsPerMin).toBe(12);
    expect(report.sync.messagesPerMin).toBe(240);
    expect(JSON.stringify(report.sync)).not.toContain('modifyDocument');
    expect(Object.keys(report.world)).toEqual(REPORT_FIELDS.world);
    expect(Object.keys(report.transfers)).toEqual(REPORT_FIELDS.transfers);
    expect(Object.keys(report.network.errors)).toEqual(['ERR_CONNECTION_RESET']);
    expect(report.client.pageErrors.byName).toEqual({ TypeError: 3 });
    expect(report.client.rendererGone.lastReason).toBeNull();
    expect(Object.keys(report.issues[0])).toEqual(REPORT_FIELDS.issue);
    expect(report.history).toHaveLength(10);
    expect(report.history[0].at).toBe(1003);
    expect(report.history[9].totalMs).toBe(80012);
    expect(report.history.some((row) => row.totalMs === 80001)).toBe(false);
    expect(Object.keys(report.history[0])).toEqual(REPORT_FIELDS.history);
    expect(JSON.stringify(report)).not.toContain('80001');
    expect(JSON.stringify(report)).toContain('80012');
  });

  it('drops free-text system fields that contain a url, path, email, ip, or document ref', () => {
    const report = buildReportObject({
      snapshot: { world: { foundryVersion: '13.348', generation: 12 } },
      systemInfo: {
        ...poisonedSystemInfo(),
        cpuModel: 'chris-desktop https://exandria.example.net/ secret',
        osPrettyName: '/home/cproctor/x',
        osVersion: 'chris@example.com',
        gpu: {
          vendor: 'vendorId 0x10de',
          device: null,
          driverVersion: '203.0.113.10',
          driverVendor: 'AMD',
          glRenderer: 'Actor.9X9JkctFMogBiagD',
        },
      },
      findings: [],
      history: [],
      generatedAt: GENERATED,
    });
    const text = buildTroubleshootingReport({
      snapshot: { world: { foundryVersion: '13.348', generation: 12 } },
      systemInfo: report.system.cpuModel,
      findings: [],
      generatedAt: GENERATED,
    });
    const blob = JSON.stringify(report);
    assertClean(blob);
    expect(report.system.cpuModel).toBeNull();
    expect(report.system.osPrettyName).toBeNull();
    expect(report.system.osVersion).toBeNull();
    expect(report.system.gpu.vendor).toBe('vendorId 0x10de');
    expect(report.system.gpu.driverVersion).toBeNull();
    expect(report.system.gpu.glRenderer).toBeNull();
    expect(report.foundry.foundryVersion).toBe('13.348');
    expect(text).not.toContain('http');
  });

  it('scrubs a finding that still contains a url, a path, or a document ref', () => {
    const text = buildTroubleshootingReport({
      snapshot: {},
      systemInfo: { clientVersion: '0.5.4' },
      findings: [{
        id: 'page-errors',
        category: 'client',
        severity: 'info',
        title: 'see https://exandria.example.net/ secret',
        evidence: 'Actor.9X9JkctFMogBiagD',
        suggestion: 'path /home/cproctor/x and chris@example.com',
      }],
      generatedAt: GENERATED,
    });
    expect(text).toContain('[removed]');
    expect(text).not.toContain('http');
    expect(text).not.toContain('exandria');
    expect(text).not.toContain('Actor.9X9JkctFMogBiagD');
    expect(text).not.toContain('/home/');
    expect(text).not.toContain('@');
    expect(text).toContain('0.5.4');
  });

  it('caps the module list at 200 and keeps the last 10 joins', () => {
    const modules = [];
    for (let index = 0; index <= 200; index += 1) {
      modules.push({ id: `mod${index}`, version: '1.0.0' });
    }
    const report = buildReportObject({
      snapshot: { world: { modules, activeModuleCount: 201, foundryVersion: '13.348' } },
      systemInfo: { clientVersion: '0.5.4' },
      findings: [],
      history: historyRows(),
      generatedAt: GENERATED,
    });
    expect(report.foundry.modules).toHaveLength(200);
    expect(report.foundry.modules[0].id).toBe('mod0');
    expect(report.foundry.modules[199].id).toBe('mod199');
    expect(report.foundry.modules.some((mod) => mod.id === 'mod200')).toBe(false);
    expect(report.history).toHaveLength(10);
    const text = buildTroubleshootingReport({
      snapshot: { world: { modules, foundryVersion: '13.348' } },
      systemInfo: { clientVersion: '0.5.4' },
      findings: [],
      history: [],
      generatedAt: GENERATED,
    });
    expect(text).toContain('mod199 1.0.0');
    expect(text).not.toContain('mod200 1.0.0');
    expect(text).toContain('\nJoin history\nNone');
  });

  it('lists the slowest packages by id and duration', () => {
    const report = buildReportObject({
      snapshot: {
        world: {
          foundryVersion: '13.348',
          hookTime: {
            totalMs: 6300,
            packages: 2,
            byPackage: [
              { id: 'dnd5e', ms: 2100, count: 2 },
              { id: 'chris-premades', ms: 4200, count: 4 },
              { id: 'not ok', ms: 9, count: 1 },
              { id: 'https://no.example/a', ms: 8, count: 1 },
            ],
          },
        },
      },
      generatedAt: GENERATED,
    });
    expect(report.world.hookTime.byPackage.map((row) => row.id)).toEqual(['chris-premades', 'dnd5e']);
    expect(report.world.hookTime.totalMs).toBe(6300);
    const text = buildTroubleshootingReport({
      snapshot: { world: { foundryVersion: '13.348', hookTime: report.world.hookTime } },
      generatedAt: GENERATED,
    });
    expect(text).toContain('Slowest packages: chris-premades 4.2 s, dnd5e 2.1 s');
    expect(text).not.toContain('not ok');
    expect(text).not.toContain('http');
  });
});

describe('network trace section', () => {
  const base = {
    snapshot: { world: { foundryVersion: '13.348' } },
    systemInfo: { clientVersion: '0.5.4' },
    findings: [],
    history: [],
    generatedAt: GENERATED,
  };
  const trace = {
    serverHash: 'srv:abc123',
    generatedAt: '2026-10-06T22:00:00.000Z',
    sweeps: 3,
    dns: {
      ms: [12],
      a: 1,
      aaaa: 1,
      consistent: true,
      error: null,
      addresses: ['198.51.100.8', '2001:db8::10'],
    },
    destinationAddresses: ['198.51.100.8'],
    connect: { tcpMs: [20], tlsMs: [22], errors: [] },
    ping: { lossPct: 0, jitterMs: 4, rttMinMs: 11, rttAvgMs: 12, rttMaxMs: 15, available: true },
    mtu: { mtuBytes: 1400, method: 'ping-df', error: null, probes: [] },
    hops: [
      {
        n: 1,
        class: 'lan',
        addresses: ['192.168.1.50', '100.64.12.1'],
        names: {},
        rttMinMs: 1,
        rttAvgMs: 1,
        rttMaxMs: 1,
        jitterMs: 0,
        lossPct: 0,
      },
      {
        n: 2,
        class: 'isp',
        addresses: ['198.51.100.8', '2001:db8::10'],
        names: { '198.51.100.8': 'gw.example.net' },
        rttMinMs: 8,
        rttAvgMs: 8,
        rttMaxMs: 8,
        jitterMs: 0,
        lossPct: 0,
      },
    ],
    summary: {
      hopCount: 2,
      reached: true,
      firstFilteredHop: null,
      lossStartsAtHop: null,
      destinationLossPct: 0,
      pathChanged: false,
    },
    findings: [],
  };

  it('omits the section until a trace is supplied', () => {
    expect(buildTroubleshootingReport(base)).not.toContain('Network trace');
  });

  it('keeps addresses and names out unless the user opted in', () => {
    const hidden = buildTroubleshootingReport({
      ...base,
      netTrace: redactReport(trace, { includeAddresses: false }),
    });
    expect(hidden).toContain('Network trace — srv:abc123');
    expect(hidden).toContain('addresses: hidden');
    expect(hidden).toContain('Path MTU ~1400 — below 1500');
    expect(hidden).not.toMatch(/\b(?:\d{1,3}\.){3}\d{1,3}\b/);
    expect(hidden).not.toContain('2001:db8::10');
    expect(hidden).not.toContain('gw.example.net');
    expect(hidden).not.toContain('192.168.1.50');
    expect(hidden).not.toContain('100.64.12.1');

    const opted = buildTroubleshootingReport({
      ...base,
      netTrace: redactReport(trace, { includeAddresses: true }),
    });
    expect(opted).toContain('addresses: included');
    expect(opted).toContain('198.51.100.8 (gw.example.net)');
    expect(opted).toContain('2001:db8::10');
    expect(opted).toContain('(private)');
    expect(opted).not.toContain('192.168.1.50');
    expect(opted).not.toContain('100.64.12.1');
  });
});

describe('http/1.1 script note', () => {
  it('prints an http/1.1 suggestion with counts only', () => {
    const text = buildTroubleshootingReport({
      snapshot: {
        transfers: { protocolH1: 12, protocolH2: 0, scriptH1: 1072 },
      },
      generatedAt: GENERATED,
    });
    expect(text).toContain(
      'Server serves 1072 scripts with Cache-Control: no-cache over HTTP/1.1; enabling HTTP/2 or max-age on /modules and /systems would cut first-join page load.',
    );
    expect(text).not.toContain('https://');

    const mixed = buildTroubleshootingReport({
      snapshot: {
        transfers: { protocolH1: 4, protocolH2: 2, scriptH1: 4 },
      },
      generatedAt: GENERATED,
    });
    expect(mixed).not.toContain('Server serves');
  });
});
