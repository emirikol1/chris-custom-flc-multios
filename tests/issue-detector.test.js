import { describe, expect, it } from 'vitest';
import {
  DEFAULT_THRESHOLDS,
  categoryCounts,
  detectIssues,
  summarizeFindings,
} from '../electron/issue-detector.js';

const POISON = [
  'ExandriaSecret',
  'chris-desktop',
  'cproctor',
  'secret-label',
  'chris@example.com',
  '203.0.113.10',
  '/home/cproctor',
  'Actor.9X9JkctFMogBiagD',
  'https://exandria.example.net',
];

function healthy() {
  return {
    title: 'https://exandria.example.net/ secret',
    label: 'secret-label',
    hostname: 'chris-desktop',
    username: 'cproctor',
    email: 'chris@example.com',
    ip: '203.0.113.10',
    path: '/home/cproctor/x',
    doc: 'Actor.9X9JkctFMogBiagD',
    loadSeq: 1,
    startedAt: 1700000000000,
    phases: {
      connect: 0,
      joinPageLoaded: 100,
      autologinArmed: 120,
      autologinSubmitted: 140,
      gameNavigation: 200,
      domReady: 300,
      socketConnected: 400,
      worldDataReceived: 800,
      init: 900,
      i18nInit: 950,
      setup: 1100,
      canvasReady: 1400,
      ready: 1500,
    },
    durations: {
      transfersMs: 500,
      worldDataMs: 400,
      initMs: 100,
      i18nMs: 50,
      setupMs: 200,
      canvasMs: 300,
      totalMs: 1500,
    },
    transfers: {
      requests: 20,
      transferBytes: 1000000,
      encodedBytes: 900000,
      decodedBytes: 2000000,
      cachedRequests: 15,
      cacheHitRatio: 0.8,
      durationMs: 500,
      byType: {},
      ttfbP50Ms: 40,
      ttfbP95Ms: 80,
      downloadP95Ms: 100,
      slowDownloads: 0,
    },
    worldData: { bytes: 500000, ms: 400 },
    world: {
      title: 'ExandriaSecret',
      id: 'Actor.9X9JkctFMogBiagD',
      foundryVersion: '13.348',
      generation: 13,
      system: { id: 'dnd5e', version: '3.3.1' },
      modules: [{ id: 'dnd5e', version: '3.3.1' }],
      activeModuleCount: 1,
      documents: {
        actors: 2,
        items: 2,
        scenes: 1,
        journal: 1,
        tables: 0,
        macros: 0,
        playlists: 0,
        cards: 0,
        folders: 1,
        users: 2,
        messages: 0,
        packs: 0,
        names: ['cproctor'],
      },
      scene: { tokens: 1, tiles: 0, lights: 0, walls: 4 },
      performanceMode: 1,
      fps: 60,
    },
    sync: {
      state: 'synced',
      connected: true,
      rttMs: 30,
      rttP50Ms: 28,
      rttP95Ms: 40,
      latencyFloorMs: 28,
      ackP50Ms: 35,
      ackP95Ms: 40,
      ackSamples: 8,
      pingJitterP95Ms: 20,
      pingJitterSamples: 8,
      reconnects: 0,
      missedPongs: 0,
      lastPacketAgeMs: 100,
      pingIntervalMs: 5000,
      pingTimeoutMs: 20000,
      cause: null,
      lastChangeAt: 1,
    },
    net: {
      errors: {},
      httpStatus: { '4xx': 0, '5xx': 0 },
      clockSkewMs: 10,
    },
    client: {
      rendererGone: { count: 0, lastReason: null },
      unresponsive: 0,
      pageErrors: { count: 0, byName: {} },
      longTasks: { count: 0, worstMs: 40 },
      webglMode: 'hardware',
      webglFallbackReason: null,
      updateStatus: 'current',
    },
    resources: {
      rendererHeapUsedBytes: 100000000,
      rendererHeapLimitBytes: 1000000000,
      rendererCpuPercent: 10,
      rendererMemoryBytes: 200000000,
      gpuCpuPercent: 5,
      gpuMemoryBytes: 100000000,
      systemTotalBytes: 32e9,
      systemFreeBytes: 16e9,
      loadAvg1: 0.5,
      cacheBytes: 10000000,
      cacheLimitBytes: 100000000,
    },
    updatedAt: 2,
  };
}

function run(snapshot, options) {
  const findings = detectIssues(snapshot, options);
  const blob = JSON.stringify(findings);
  for (const token of POISON) expect(blob).not.toContain(token);
  expect(blob).not.toContain('http');
  expect(blob).not.toContain('@');
  expect(blob).not.toContain('/home/');
  return findings;
}

function ids(findings) {
  return findings.map((finding) => finding.id);
}

describe('detectIssues', () => {
  it('emits nothing for a healthy snapshot', () => {
    expect(run(healthy())).toEqual([]);
    const stalled = healthy();
    stalled.sync.cause = 'socket-stalled';
    expect(run(stalled)).toEqual([]);
    expect(run(null)).toEqual([]);
    expect(run({ net: null, sync: null, world: null })).toEqual([]);
  });

  it('publishes the initial thresholds in one object', () => {
    expect(DEFAULT_THRESHOLDS).toEqual({
      netTimeoutCount: 1,
      missedPongs: 2,
      reconnects: 2,
      pingJitterMs: 400,
      ackSlowMs: 2000,
      slowDownloads: 5,
      serverTtfbMs: 600,
      http5xx: 1,
      rttOkMs: 150,
      worldDataMsPerMb: 1500,
      worldDataBaseMs: 1000,
      clockSkewMs: 120000,
      pageErrors: 10,
      localPhasesMs: 6000,
      transfersFastMs: 3000,
      longTasks: 20,
      worstLongTaskMs: 1000,
      inGameStallMs: 3000,
      inGameStallRatio: 0.02,
      heapRatio: 0.85,
      systemFreeRatio: 0.08,
      gpuMemoryBytes: 2.5e9,
      rendererCpuPercent: 85,
      loadPerCore: 1.5,
      slowerThanTypicalFactor: 1.8,
      cacheFullRatio: 0.9,
      cacheHitRatioLow: 0.5,
      cacheReadSlowCount: 20,
    });
  });

  it('flags DNS resolution failures', () => {
    const snapshot = healthy();
    snapshot.net.errors.ERR_NAME_NOT_RESOLVED = 2;
    snapshot.net.errors['https://exandria.example.net/secret'] = 9;
    const findings = run(snapshot);
    expect(findings).toEqual([expect.objectContaining({
      id: 'dns-unresolved',
      category: 'dns',
      severity: 'error',
      title: 'Server name could not be resolved (DNS)',
      evidence: 'count=2',
    })]);
    expect(findings[0].suggestion).toMatch(/DNS/);
  });

  it('flags an offline computer from the error or the sync cause', () => {
    const byError = healthy();
    byError.net.errors.ERR_INTERNET_DISCONNECTED = 1;
    expect(run(byError)[0]).toMatchObject({
      id: 'local-offline',
      category: 'network',
      severity: 'error',
      title: 'This computer is offline',
      evidence: 'ERR_INTERNET_DISCONNECTED=1',
    });
    const byCause = healthy();
    byCause.sync.cause = 'local-offline';
    expect(run(byCause)[0]).toMatchObject({
      id: 'local-offline',
      evidence: 'cause=local-offline',
    });
  });

  it('flags timeout-class errors only above the threshold', () => {
    const below = healthy();
    below.net.errors.ERR_CONNECTION_TIMED_OUT = 1;
    expect(run(below)).toEqual([]);
    const above = healthy();
    above.net.errors.ERR_TIMED_OUT = 1;
    above.net.errors.ERR_NETWORK_CHANGED = 1;
    const finding = run(above)[0];
    expect(finding).toMatchObject({
      id: 'network-timeouts',
      category: 'network',
      severity: 'warn',
      title: 'Connections are timing out',
    });
    expect(finding.evidence).toContain('total=2');
  });

  it('flags an unstable link from pongs, reconnects, or jitter', () => {
    const quiet = healthy();
    quiet.sync.missedPongs = 1;
    quiet.sync.reconnects = 1;
    quiet.sync.rttP50Ms = 40;
    quiet.sync.rttP95Ms = 190;
    expect(run(quiet)).toEqual([]);

    const pongs = healthy();
    pongs.sync.missedPongs = 2;
    const byPongs = run(pongs)[0];
    expect(byPongs).toMatchObject({
      id: 'network-unstable',
      category: 'network',
      severity: 'warn',
      title: 'Unstable connection',
    });
    expect(byPongs.evidence).toContain('missedPongs=2');
    expect(byPongs.evidence).not.toContain('inferred from jitter');
    expect(byPongs.evidence).toContain('rttP50Ms=28');

    const reconnects = healthy();
    reconnects.sync.reconnects = 2;
    expect(run(reconnects)[0].evidence).toContain('reconnects=2');

    const spread = healthy();
    spread.sync.rttP50Ms = 40;
    spread.sync.rttP95Ms = 5000;
    spread.sync.ackP50Ms = 40;
    spread.sync.ackP95Ms = 8000;
    spread.sync.ackSamples = 20;
    spread.sync.latencyFloorMs = 400;
    expect(ids(run(spread))).not.toContain('network-unstable');
    expect(ids(run(spread))).not.toContain('network-timing');
    expect(ids(run(spread))).not.toContain('server-ack-slow');

    const unknownRtt = healthy();
    unknownRtt.sync.rttP50Ms = null;
    unknownRtt.sync.rttP95Ms = 5000;
    expect(run(unknownRtt)).toEqual([]);
  });

  it('notes uneven ping timing only after enough samples', () => {
    const few = healthy();
    few.sync.pingJitterP95Ms = 900;
    few.sync.pingJitterSamples = 4;
    expect(run(few)).toEqual([]);

    const onLimit = healthy();
    onLimit.sync.pingJitterP95Ms = 400;
    onLimit.sync.pingJitterSamples = 5;
    expect(run(onLimit)).toEqual([]);

    const uneven = healthy();
    uneven.sync.pingJitterP95Ms = 401;
    uneven.sync.pingJitterSamples = 5;
    const finding = run(uneven)[0];
    expect(finding).toMatchObject({
      id: 'network-timing',
      category: 'network',
      severity: 'info',
      title: 'Connection timing is uneven',
    });
    expect(finding.evidence).toContain('pingJitterP95Ms=401');
    expect(finding.evidence).toContain('samples=5');
    expect(ids(run(uneven))).not.toContain('network-unstable');
  });

  it('blames slow acks on the server when the link floor is fast', () => {
    const slowAcks = healthy();
    slowAcks.sync.ackP50Ms = 800;
    slowAcks.sync.ackP95Ms = 2001;
    slowAcks.sync.ackSamples = 5;
    slowAcks.sync.latencyFloorMs = 78;
    slowAcks.sync.rttP50Ms = 28;
    slowAcks.sync.rttP95Ms = 4000;
    const findings = run(slowAcks);
    expect(ids(findings)).not.toContain('network-unstable');
    expect(ids(findings)).not.toContain('network-timing');
    expect(findings[0]).toMatchObject({
      id: 'server-ack-slow',
      category: 'server',
      severity: 'warn',
      title: 'Server is slow to acknowledge actions',
    });
    expect(findings[0].evidence).toContain('ackP50Ms=800');
    expect(findings[0].evidence).toContain('ackP95Ms=2001');
    expect(findings[0].evidence).toContain('latencyFloorMs=78');
    expect(findings[0].suggestion).toMatch(/module/i);
    expect(findings[0].suggestion).toMatch(/load/i);

    const few = healthy();
    few.sync.ackP95Ms = 5000;
    few.sync.ackSamples = 4;
    few.sync.latencyFloorMs = 40;
    expect(ids(run(few))).not.toContain('server-ack-slow');

    const slowLink = healthy();
    slowLink.sync.ackP95Ms = 5000;
    slowLink.sync.ackSamples = 8;
    slowLink.sync.latencyFloorMs = 300;
    expect(ids(run(slowLink))).not.toContain('server-ack-slow');
  });

  it('flags bandwidth-limited downloads when the server TTFB is still fast', () => {
    const slowServer = healthy();
    slowServer.transfers.slowDownloads = 5;
    slowServer.transfers.ttfbP50Ms = 600;
    expect(run(slowServer)).toEqual([]);
    const few = healthy();
    few.transfers.slowDownloads = 4;
    few.transfers.ttfbP50Ms = 40;
    expect(run(few)).toEqual([]);
    const hit = healthy();
    hit.transfers.slowDownloads = 5;
    hit.transfers.ttfbP50Ms = 599;
    expect(run(hit)[0]).toMatchObject({
      id: 'bandwidth-limited',
      category: 'network',
      severity: 'info',
      title: 'Downloads are bandwidth-limited',
      evidence: 'slowDownloads=5 ttfbP50Ms=599',
    });
  });

  it('flags a server that refuses, resets, or is marked unreachable', () => {
    const refused = healthy();
    refused.net.errors.ERR_CONNECTION_REFUSED = 1;
    expect(run(refused)[0]).toMatchObject({
      id: 'server-unreachable',
      category: 'server',
      severity: 'error',
      title: 'Server could not be reached',
    });
    expect(run(refused)[0].evidence).toContain('ERR_CONNECTION_REFUSED=1');
    const reset = healthy();
    reset.net.errors.ERR_CONNECTION_RESET = 2;
    expect(run(reset)[0].evidence).toContain('ERR_CONNECTION_RESET=2');
    const cause = healthy();
    cause.sync.cause = 'server-unreachable';
    expect(run(cause)[0].evidence).toContain('cause=server-unreachable');
  });

  it('flags HTTP 5xx responses', () => {
    const snapshot = healthy();
    snapshot.net.httpStatus['5xx'] = 1;
    expect(run(snapshot)[0]).toMatchObject({
      id: 'server-5xx',
      category: 'server',
      severity: 'warn',
      title: 'Server returned errors',
      evidence: '5xx=1',
    });
  });

  it('flags a slow server when TTFB is high and RTT is fast or unknown', () => {
    const fast = healthy();
    fast.transfers.ttfbP50Ms = 601;
    fast.sync.rttP50Ms = 149;
    fast.sync.rttP95Ms = 160;
    expect(run(fast)[0]).toMatchObject({
      id: 'server-slow',
      category: 'server',
      severity: 'warn',
      title: 'Server is slow to respond',
    });
    expect(run(fast)[0].evidence).toContain('ttfbP50Ms=601');
    expect(run(fast)[0].evidence).toContain('rttP50Ms=149');

    const slowPath = healthy();
    slowPath.transfers.ttfbP50Ms = 800;
    slowPath.sync.rttP50Ms = 400;
    slowPath.sync.rttP95Ms = 420;
    expect(ids(run(slowPath))).not.toContain('server-slow');

    const unknown = healthy();
    unknown.transfers.ttfbP50Ms = 800;
    unknown.sync.rttP50Ms = null;
    expect(run(unknown)[0].id).toBe('server-slow');

    const equal = healthy();
    equal.transfers.ttfbP50Ms = 600;
    expect(ids(run(equal))).not.toContain('server-slow');
  });

  it('flags world data that exceeds the size budget', () => {
    const onBudget = healthy();
    onBudget.worldData.bytes = 1000000;
    onBudget.worldData.ms = 2500;
    expect(run(onBudget)).toEqual([]);
    const over = healthy();
    over.worldData.bytes = 1000000;
    over.worldData.ms = 2501;
    expect(run(over)[0]).toMatchObject({
      id: 'world-data-slow',
      category: 'server',
      severity: 'warn',
      title: 'World data took longer than expected',
      evidence: 'ms=2501 bytes=1000000',
    });
    const missing = healthy();
    missing.worldData.bytes = null;
    missing.worldData.ms = 999999;
    expect(run(missing)).toEqual([]);
  });

  it('splits certificate failures into clock skew versus the server', () => {
    const skewedOnly = healthy();
    skewedOnly.net.clockSkewMs = 999999;
    expect(run(skewedOnly)).toEqual([]);

    const server = healthy();
    server.net.errors.ERR_CERT_AUTHORITY_INVALID = 1;
    server.net.clockSkewMs = 120000;
    expect(run(server)[0]).toMatchObject({
      id: 'server-certificate',
      category: 'server',
      severity: 'error',
      title: 'Server certificate problem',
    });

    const clock = healthy();
    clock.net.errors.ERR_CERT_DATE_INVALID = 2;
    clock.net.clockSkewMs = -120001;
    const finding = run(clock)[0];
    expect(finding).toMatchObject({
      id: 'system-clock-wrong',
      category: 'client',
      severity: 'error',
      title: 'System clock is wrong',
    });
    expect(finding.evidence).toContain('clockSkewMs=-120001');
    expect(finding.evidence).toContain('certErrors=2');
    expect(ids(run(clock))).not.toContain('server-certificate');
  });

  it('flags a crashed game page and keeps the reason enum', () => {
    const crashed = healthy();
    crashed.client.rendererGone = { count: 1, lastReason: 'crashed' };
    expect(run(crashed)[0]).toMatchObject({
      id: 'renderer-crashed',
      category: 'client',
      severity: 'error',
      title: 'Game page crashed',
      evidence: 'count=1 lastReason=crashed',
    });
    const poisoned = healthy();
    poisoned.client.rendererGone = { count: 1, lastReason: 'crashed /home/cproctor/x' };
    const finding = run(poisoned)[0];
    expect(finding.evidence).toBe('count=1');
    expect(finding.evidence).not.toContain('cproctor');
  });

  it('flags an unresponsive game page', () => {
    const snapshot = healthy();
    snapshot.client.unresponsive = 1;
    expect(run(snapshot)[0]).toMatchObject({
      id: 'renderer-unresponsive',
      category: 'client',
      severity: 'warn',
      title: 'Game page was unresponsive',
      evidence: 'count=1',
    });
  });

  it('notes page errors with the top three safe names', () => {
    const below = healthy();
    below.client.pageErrors.count = 9;
    expect(run(below)).toEqual([]);
    const snapshot = healthy();
    snapshot.client.pageErrors = {
      count: 12,
      message: 'page blew up at login',
      byName: {
        TypeError: 8,
        ReferenceError: 5,
        RangeError: 3,
        SyntaxError: 1,
        'page blew up at login': 20,
        'https://exandria.example.net/secret': 15,
      },
    };
    const finding = run(snapshot)[0];
    expect(finding).toMatchObject({
      id: 'page-errors',
      category: 'client',
      severity: 'info',
      title: 'Many page errors during join',
      evidence: 'count=12 TypeError=8 ReferenceError=5 RangeError=3',
    });
    expect(finding.evidence).not.toContain('blew');
    expect(finding.evidence).not.toContain('SyntaxError');
  });

  it('flags software WebGL', () => {
    const snapshot = healthy();
    snapshot.client.webglMode = 'software';
    snapshot.client.webglFallbackReason = 'gpu-process-crashed';
    expect(run(snapshot)[0]).toMatchObject({
      id: 'software-webgl',
      category: 'client',
      severity: 'warn',
      title: 'Software rendering in use',
      evidence: 'webglMode=software webglFallbackReason=gpu-process-crashed',
    });
  });

  it('flags startup time that is spent in local phases', () => {
    const onBudget = healthy();
    onBudget.durations.initMs = 1500;
    onBudget.durations.i18nMs = 1500;
    onBudget.durations.setupMs = 1500;
    onBudget.durations.canvasMs = 1500;
    onBudget.durations.transfersMs = 1000;
    expect(run(onBudget)).toEqual([]);
    const slowTransfer = healthy();
    slowTransfer.durations.initMs = 2000;
    slowTransfer.durations.i18nMs = 2000;
    slowTransfer.durations.setupMs = 2000;
    slowTransfer.durations.canvasMs = 2000;
    slowTransfer.durations.transfersMs = 3000;
    expect(run(slowTransfer)).toEqual([]);
    const hit = healthy();
    hit.durations.initMs = 2000;
    hit.durations.i18nMs = 1000;
    hit.durations.setupMs = 2000;
    hit.durations.canvasMs = 2000;
    hit.durations.transfersMs = 1000;
    hit.world.documents.actors = 500;
    hit.world.hookTime = {
      totalMs: 5000,
      packages: 2,
      byPackage: [
        { id: 'pkg.with.dots', ms: 5000, count: 2 },
        { id: 'not ok', ms: 9000, count: 1 },
      ],
    };
    const finding = run(hit)[0];
    expect(finding).toMatchObject({
      id: 'local-phases',
      category: 'client',
      severity: 'info',
      title: 'Startup time is spent locally (large world or slow CPU)',
    });
    expect(finding.evidence).toContain('localMs=7000');
    expect(finding.evidence).toContain('transfersMs=1000');
    expect(finding.evidence).toContain('docs=507');
    expect(finding.evidence).toContain('topPackage=pkg.with.dots');
    expect(finding.evidence).toContain('topPackageMs=5000');
    expect(finding.evidence).not.toContain('not ok');
  });

  it('flags game stalls from long-task count or the worst task', () => {
    const quiet = healthy();
    quiet.client.longTasks = { count: 19, worstMs: 999 };
    expect(run(quiet)).toEqual([]);
    const counted = healthy();
    counted.client.longTasks = { count: 20, worstMs: 40 };
    expect(run(counted)[0]).toMatchObject({
      id: 'game-stalling',
      category: 'client',
      severity: 'warn',
      title: 'Game is stalling',
      evidence: 'count=20 worstMs=40',
    });
    const worst = healthy();
    worst.client.longTasks = { count: 1, worstMs: 1000 };
    expect(run(worst)[0].evidence).toContain('worstMs=1000');
  });

  it('separates join-time blocking from in-game stalls when phases are known', () => {
    const joinOnly = healthy();
    joinOnly.client.longTasks = { count: 16, worstMs: 20000, totalMs: 25000, byPhase: { i18nInit: 20000, setup: 5000 } };
    expect(run(joinOnly).map((f) => f.id)).not.toContain('game-stalling');

    const inGame = healthy();
    inGame.startedAt = 1000;
    inGame.phases.ready = 60000;
    inGame.updatedAt = 1000 + 60000 + 100000;
    inGame.client.longTasks = { count: 30, worstMs: 400, totalMs: 4000, byPhase: { setup: 1000, ready: 3000 } };
    const finding = run(inGame).find((f) => f.id === 'game-stalling');
    expect(finding).toBeDefined();
    expect(finding.evidence).toBe('blockedAfterReadyMs=3000 inGameMs=100000 worstMs=400');

    const longSession = healthy();
    longSession.startedAt = 1000;
    longSession.phases.ready = 60000;
    longSession.updatedAt = 1000 + 60000 + 3600000;
    longSession.client.longTasks = { count: 30, worstMs: 400, totalMs: 4000, byPhase: { ready: 3000 } };
    expect(run(longSession).map((f) => f.id)).not.toContain('game-stalling');
  });

  it('notes an available client update', () => {
    const ahead = healthy();
    ahead.client.updateStatus = 'ahead';
    expect(run(ahead)).toEqual([]);
    const snapshot = healthy();
    snapshot.client.updateStatus = 'available';
    expect(run(snapshot)[0]).toMatchObject({
      id: 'update-available',
      category: 'client',
      severity: 'info',
      title: 'A client update is available',
      evidence: 'updateStatus=available',
    });
  });

  it('flags renderer heap pressure above the ratio', () => {
    const onLimit = healthy();
    onLimit.resources.rendererHeapUsedBytes = 850;
    onLimit.resources.rendererHeapLimitBytes = 1000;
    expect(run(onLimit)).toEqual([]);
    const over = healthy();
    over.resources.rendererHeapUsedBytes = 851;
    over.resources.rendererHeapLimitBytes = 1000;
    expect(run(over)[0]).toMatchObject({
      id: 'renderer-heap',
      category: 'resources',
      severity: 'warn',
      title: 'Renderer heap is nearly full',
      evidence: 'used=851 limit=1000',
    });
  });

  it('flags low system memory', () => {
    const ok = healthy();
    ok.resources.systemFreeBytes = 8;
    ok.resources.systemTotalBytes = 100;
    expect(run(ok)).toEqual([]);
    const low = healthy();
    low.resources.systemFreeBytes = 7;
    low.resources.systemTotalBytes = 100;
    expect(run(low)[0]).toMatchObject({
      id: 'system-memory-low',
      category: 'resources',
      severity: 'warn',
      title: 'System memory is low',
      evidence: 'free=7 total=100',
    });
  });

  it('notes high GPU memory', () => {
    const onLimit = healthy();
    onLimit.resources.gpuMemoryBytes = 2.5e9;
    expect(run(onLimit)).toEqual([]);
    const over = healthy();
    over.resources.gpuMemoryBytes = 2.5e9 + 1;
    expect(run(over)[0]).toMatchObject({
      id: 'gpu-memory',
      category: 'resources',
      severity: 'info',
      title: 'GPU memory use is high',
      evidence: 'gpuMemoryBytes=2500000001',
    });
  });

  it('flags high renderer CPU', () => {
    const onLimit = healthy();
    onLimit.resources.rendererCpuPercent = 85;
    expect(run(onLimit)).toEqual([]);
    const over = healthy();
    over.resources.rendererCpuPercent = 86;
    expect(run(over)[0]).toMatchObject({
      id: 'renderer-cpu',
      category: 'resources',
      severity: 'warn',
      title: 'Renderer CPU is high',
      evidence: 'rendererCpuPercent=86',
    });
  });

  it('flags slow cache reads when the link itself is fast', () => {
    const few = healthy();
    few.transfers.cacheReadSlow = 20;
    few.transfers.cachedRequests = 49;
    few.transfers.ttfbP50Ms = 40;
    expect(ids(run(few))).not.toContain('local-disk-slow');

    const slowLink = healthy();
    slowLink.transfers.cacheReadSlow = 20;
    slowLink.transfers.cachedRequests = 50;
    slowLink.transfers.ttfbP50Ms = 300;
    expect(ids(run(slowLink))).not.toContain('local-disk-slow');

    const below = healthy();
    below.transfers.cacheReadSlow = 19;
    below.transfers.cachedRequests = 80;
    below.transfers.ttfbP50Ms = 40;
    expect(ids(run(below))).not.toContain('local-disk-slow');

    const hit = healthy();
    hit.transfers.cacheReadSlow = 20;
    hit.transfers.cachedRequests = 50;
    hit.transfers.ttfbP50Ms = 299;
    hit.transfers.cacheReadP95Ms = 400;
    hit.transfers.cacheReadBytes = 1000;
    const finding = run(hit).find((item) => item.id === 'local-disk-slow');
    expect(finding).toMatchObject({
      id: 'local-disk-slow',
      category: 'resources',
      severity: 'warn',
      title: 'Cached files are slow to read',
    });
    expect(finding.evidence).toContain('cacheReadSlow=20');
    expect(finding.evidence).toContain('cacheReadP95Ms=400');
    expect(finding.evidence).toContain('cacheReadBytes=1000');
    expect(finding.suggestion).toMatch(/antivirus/);
    expect(finding.suggestion).toMatch(/slow drive/);
  });

  it('notes a busy system from load average per core', () => {
    const noInfo = healthy();
    noInfo.resources.loadAvg1 = 100;
    expect(run(noInfo)).toEqual([]);
    const onLimit = healthy();
    onLimit.resources.loadAvg1 = 6;
    expect(run(onLimit, { systemInfo: { cpuCount: 4 } })).toEqual([]);
    const busy = healthy();
    busy.resources.loadAvg1 = 7;
    expect(run(busy, { systemInfo: { cpuCount: 4, hostname: 'chris-desktop' } })[0]).toMatchObject({
      id: 'system-busy',
      category: 'resources',
      severity: 'info',
      title: 'System is busy',
      evidence: 'loadAvg1=7 cpuCount=4',
    });
  });

  it('notes a full cache that is missing', () => {
    const notFull = healthy();
    notFull.resources.cacheBytes = 90;
    notFull.resources.cacheLimitBytes = 100;
    notFull.transfers.cacheHitRatio = 0.49;
    expect(run(notFull)).toEqual([]);
    const hitting = healthy();
    hitting.resources.cacheBytes = 95;
    hitting.resources.cacheLimitBytes = 100;
    hitting.transfers.cacheHitRatio = 0.5;
    expect(run(hitting)).toEqual([]);
    const full = healthy();
    full.resources.cacheBytes = 95;
    full.resources.cacheLimitBytes = 100;
    full.transfers.cacheHitRatio = 0.49;
    expect(run(full)[0]).toMatchObject({
      id: 'cache-full',
      category: 'resources',
      severity: 'info',
      title: 'Cache is full; files are being re-downloaded',
    });
    expect(run(full)[0].evidence).toContain('cacheHitRatio=0.49');
  });

  it('replaces slow-server plus unstable with one ambiguous finding', () => {
    const snapshot = healthy();
    snapshot.net.errors.ERR_NAME_NOT_RESOLVED = 1;
    snapshot.sync.missedPongs = 2;
    snapshot.transfers.ttfbP50Ms = 800;
    snapshot.sync.rttP50Ms = 40;
    snapshot.sync.rttP95Ms = 50;
    const findings = run(snapshot);
    expect(ids(findings)).toEqual(['dns-unresolved', 'slow-connection-ambiguous']);
    expect(findings[1]).toMatchObject({
      id: 'slow-connection-ambiguous',
      category: 'network',
      severity: 'info',
      title: 'Slow server or unstable connection',
    });
    expect(findings[1].evidence).toContain('ttfbP50Ms=800');
    expect(findings[1].evidence).toContain('missedPongs=2');
    expect(findings[1].suggestion).toContain('Server is slow to respond');
    expect(findings[1].suggestion).toContain('Unstable connection');
    expect(ids(findings)).not.toContain('server-slow');
    expect(ids(findings)).not.toContain('network-unstable');
  });

  it('notes a join that is slower than the recent median', () => {
    const history = [{ totalMs: 1000 }, { totalMs: 1000 }, { totalMs: 1000, url: 'https://exandria.example.net/secret' }];
    const typical = healthy();
    typical.durations.totalMs = 1000;
    expect(run(typical, { history })).toEqual([]);
    const short = healthy();
    short.durations.totalMs = 99999;
    expect(run(short, { history: history.slice(0, 2) })).toEqual([]);
    const slow = healthy();
    slow.durations.totalMs = 1900;
    expect(run(slow, { history })[0]).toMatchObject({
      id: 'slower-than-usual',
      category: 'client',
      severity: 'info',
      title: 'This join was slower than usual',
      evidence: 'totalMs=1900 typicalMs=1000',
    });
    const boundary = healthy();
    boundary.durations.totalMs = 2000;
    expect(run(boundary, { history, thresholds: { slowerThanTypicalFactor: 2 } })).toEqual([]);
    boundary.durations.totalMs = 2001;
    expect(run(boundary, { history, thresholds: { slowerThanTypicalFactor: 2 } })[0].id).toBe('slower-than-usual');
  });

  it('orders errors before warnings before info, then by category', () => {
    const snapshot = healthy();
    snapshot.net.errors.ERR_NAME_NOT_RESOLVED = 1;
    snapshot.net.errors.ERR_CONNECTION_REFUSED = 1;
    snapshot.net.httpStatus['5xx'] = 1;
    snapshot.client.webglMode = 'software';
    snapshot.client.updateStatus = 'available';
    expect(ids(run(snapshot))).toEqual([
      'server-unreachable',
      'dns-unresolved',
      'server-5xx',
      'software-webgl',
      'update-available',
    ]);
    expect(run(snapshot).map((finding) => finding.severity)).toEqual(['error', 'error', 'warn', 'warn', 'info']);
  });
});

describe('summarizeFindings', () => {
  it('counts issues by severity', () => {
    expect(summarizeFindings([])).toBe('No issues detected');
    expect(summarizeFindings(null)).toBe('No issues detected');
    expect(summarizeFindings([{ severity: 'error' }])).toBe('1 issue: 1 error');
    expect(summarizeFindings([
      { severity: 'error' },
      { severity: 'warn' },
      { severity: 'warn' },
    ])).toBe('3 issues: 1 error, 2 warnings');
    expect(summarizeFindings([{ severity: 'warn' }])).toBe('1 issue: 1 warning');
    expect(summarizeFindings([{ severity: 'info' }, { severity: 'info' }])).toBe('2 issues: 2 infos');
  });
});

describe('categoryCounts', () => {
  it('counts the five categories', () => {
    expect(categoryCounts([
      { category: 'dns' },
      { category: 'dns' },
      { category: 'network' },
      { category: 'nope' },
    ])).toEqual({ network: 1, server: 0, client: 0, resources: 0, dns: 2 });
    expect(categoryCounts(null)).toEqual({ network: 0, server: 0, client: 0, resources: 0, dns: 0 });
  });
});

describe('baseline modes', () => {
  it('replaces rate findings with baseline-building until three joins exist', () => {
    const snap = healthy();
    snap.net.errors.ERR_NAME_NOT_RESOLVED = 2;
    snap.transfers.ttfbP50Ms = 900;
    snap.sync.rttP50Ms = 40;
    snap.sync.rttP95Ms = 400;
    snap.worldData = { bytes: 1e6, ms: 8000 };
    snap.durations.totalMs = 20000;
    const history = [
      { totalMs: 1000, ttfbP50Ms: 50, worldDataMsPerMb: 100, setupMsPerDoc: 1 },
    ];
    const findings = run(snap, { baselineReady: false, speedIndex: 12.5, history });
    expect(ids(findings)).toContain('dns-unresolved');
    expect(ids(findings)).toContain('baseline-building');
    expect(ids(findings)).not.toContain('server-slow');
    expect(ids(findings)).not.toContain('world-data-slow');
    expect(ids(findings)).not.toContain('network-unstable');
    expect(ids(findings)).not.toContain('slower-than-usual');
    const building = findings.find((item) => item.id === 'baseline-building');
    expect(building).toMatchObject({
      category: 'client',
      severity: 'info',
      title: 'Baseline building',
      evidence: 'joins=1 needed=3',
    });

    const band = healthy();
    band.transfers.slowDownloads = 8;
    band.transfers.ttfbP50Ms = 40;
    expect(ids(run(band, { baselineReady: false, history: [] }))).not.toContain('bandwidth-limited');

    const uneven = healthy();
    uneven.sync.pingJitterP95Ms = 900;
    uneven.sync.pingJitterSamples = 8;
    expect(ids(run(uneven, { baselineReady: false, history: [] }))).not.toContain('network-timing');

    const dropped = healthy();
    dropped.sync.reconnects = 3;
    const kept = run(dropped, { baselineReady: false, history: [] });
    expect(ids(kept)).toContain('network-unstable');
    expect(ids(kept)).toContain('baseline-building');
    expect(kept.find((item) => item.id === 'baseline-building').evidence).toBe('joins=0 needed=3');
  });

  it('judges server, world, and local phases against history medians', () => {
    const history = [
      { ttfbP50Ms: 80, worldDataMsPerMb: 100, setupMsPerDoc: 10, totalMs: 1500 },
      { ttfbP50Ms: 120, worldDataMsPerMb: 100, setupMsPerDoc: 10, totalMs: 1500 },
    ];
    const serverOnly = healthy();
    serverOnly.transfers.ttfbP50Ms = 200;
    serverOnly.sync.rttP50Ms = 40;
    const serverInfo = run(serverOnly, { baselineReady: true, speedIndex: null, history });
    expect(serverInfo.find((item) => item.id === 'server-slow')).toMatchObject({ severity: 'info' });

    const serverBoth = healthy();
    serverBoth.transfers.ttfbP50Ms = 700;
    serverBoth.sync.rttP50Ms = 40;
    expect(run(serverBoth, { baselineReady: true, history }).find((item) => item.id === 'server-slow').severity).toBe('warn');

    const serverAbsoluteOnly = healthy();
    serverAbsoluteOnly.transfers.ttfbP50Ms = 700;
    serverAbsoluteOnly.sync.rttP50Ms = 40;
    const highTtfb = history.map((row) => Object.assign({}, row, { ttfbP50Ms: 500 }));
    expect(ids(run(serverAbsoluteOnly, { baselineReady: true, history: highTtfb }))).not.toContain('server-slow');

    const worldInfo = healthy();
    worldInfo.worldData = { bytes: 1e6, ms: 200 };
    expect(run(worldInfo, { baselineReady: true, history }).find((item) => item.id === 'world-data-slow').severity).toBe('info');

    const worldWarn = healthy();
    worldWarn.worldData = { bytes: 1e6, ms: 3000 };
    expect(run(worldWarn, { baselineReady: true, history }).find((item) => item.id === 'world-data-slow').severity).toBe('warn');

    const localInfo = healthy();
    localInfo.durations.setupMs = 500;
    const local = run(localInfo, { baselineReady: true, history }).find((item) => item.id === 'local-phases');
    expect(local.severity).toBe('info');
    expect(local.evidence).toContain('setupMsPerDoc=');

    const localWarn = healthy();
    localWarn.durations.initMs = 2000;
    localWarn.durations.i18nMs = 1000;
    localWarn.durations.setupMs = 2000;
    localWarn.durations.canvasMs = 2000;
    localWarn.durations.transfersMs = 1000;
    localWarn.world.documents.actors = 500;
    const tight = history.map((row) => Object.assign({}, row, { setupMsPerDoc: 1 }));
    expect(run(localWarn, { baselineReady: true, history: tight }).find((item) => item.id === 'local-phases').severity).toBe('warn');

    const localAbsoluteOnly = healthy();
    localAbsoluteOnly.durations.initMs = 2000;
    localAbsoluteOnly.durations.i18nMs = 1000;
    localAbsoluteOnly.durations.setupMs = 200;
    localAbsoluteOnly.durations.canvasMs = 3000;
    localAbsoluteOnly.durations.transfersMs = 1000;
    localAbsoluteOnly.world.documents.actors = 5000;
    expect(ids(run(localAbsoluteOnly, { baselineReady: true, history }))).not.toContain('local-phases');

    const fallback = healthy();
    fallback.transfers.ttfbP50Ms = 601;
    fallback.sync.rttP50Ms = 40;
    expect(run(fallback, { baselineReady: true, history: [{ totalMs: 1 }, { totalMs: 1 }, { totalMs: 1 }] })
      .find((item) => item.id === 'server-slow').severity).toBe('warn');
  });
});
