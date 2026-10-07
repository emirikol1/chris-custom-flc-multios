import { describe, expect, it } from 'vitest';
import {
  PHASES,
  staleThresholdMs,
  compareWithHistory,
  createCollector,
  formatBytes,
  formatJoinSummary,
  formatMs,
  percentile,
  summarizeForHistory,
  liveFromSnapshot,
} from '../electron/join-telemetry.js';

function clock(start) {
  let t = start;
  return {
    now() {
      return t;
    },
    set(n) {
      t = n;
    },
  };
}

function assertNoUndefined(value, path) {
  expect(value, path).not.toBeUndefined();
  if (!value || typeof value !== 'object') return;
  for (const key of Object.keys(value)) {
    assertNoUndefined(value[key], `${path}.${key}`);
  }
}

const DOC_NULLS = {
  actors: null,
  items: null,
  scenes: null,
  journal: null,
  tables: null,
  macros: null,
  playlists: null,
  cards: null,
  folders: null,
  users: null,
  messages: null,
  packs: null,
};

describe('percentile / formatters', () => {
  it('interpolates percentiles on unsorted numbers', () => {
    expect(percentile([5, 1, 3], 0)).toBe(1);
    expect(percentile([5, 1, 3], 100)).toBe(5);
    expect(percentile([1, 2, 3, 4, 5], 50)).toBe(3);
    expect(percentile([10], 95)).toBe(10);
    expect(percentile([], 50)).toBeNull();
    expect(percentile(null, 50)).toBeNull();
  });

  it('formats bytes and milliseconds', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1.0 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(Math.round(6.8 * 1024 * 1024))).toBe('6.8 MB');
    expect(formatBytes(Math.round(42.1 * 1024 * 1024))).toBe('42.1 MB');
    expect(formatMs(320)).toBe('320ms');
    expect(formatMs(2000)).toBe('2.0s');
    expect(formatMs(1500)).toBe('1.5s');
  });
});

describe('empty snapshot', () => {
  it('exports phases in join order and nulls every unknown number', () => {
    expect(PHASES).toEqual([
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
    const c = createCollector({ now: () => 42 });
    const snap = c.snapshot();
    assertNoUndefined(snap, 'snapshot');
    const phases = {};
    for (const name of PHASES) phases[name] = null;
    expect(snap).toEqual({
      loadSeq: 0,
      startedAt: null,
      phases,
      durations: {
        loginMs: null,
        pageLoadMs: null,
        transfersMs: null,
        worldDataMs: null,
        initMs: null,
        i18nMs: null,
        setupMs: null,
        canvasMs: null,
        totalMs: null,
      },
      transfers: {
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
      },
      worldData: { bytes: null, ms: null },
      world: {
        foundryVersion: null,
        generation: null,
        hookTime: null,
        system: { id: null, version: null },
        modules: [],
        activeModuleCount: 0,
        documents: DOC_NULLS,
        documentBytes: { ...DOC_NULLS },
        documentBytesComplete: false,
        scene: { tokens: null, tiles: null, lights: null, walls: null },
        performanceMode: null,
        fps: null,
      },
      sync: {
        state: 'unknown',
        connected: null,
        rttMs: null,
        rttMinMs: null,
        rttP50Ms: null,
        rttP95Ms: null,
        latencyFloorMs: null,
        ackMinMs: null,
        ackP50Ms: null,
        ackP95Ms: null,
        ackSamples: 0,
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
      },
      net: { errors: {}, httpStatus: { '4xx': 0, '5xx': 0 }, clockSkewMs: null },
      client: {
        rendererGone: { count: 0, lastReason: null },
        unresponsive: 0,
        pageErrors: { count: 0, byName: {} },
        longTasks: { count: 0, worstMs: null, totalMs: null, byPhase: {} },
        webglMode: null,
        webglFallbackReason: null,
        updateStatus: null,
        gpuGone: false,
      },
      resources: {
        rendererHeapUsedBytes: null,
        rendererHeapLimitBytes: null,
        rendererCpuPercent: null,
        rendererMemoryBytes: null,
        gpuCpuPercent: null,
        gpuMemoryBytes: null,
        systemTotalBytes: null,
        systemFreeBytes: null,
        loadAvg1: null,
        cacheBytes: null,
        cacheLimitBytes: null,
      },
      progress: {
        requests: null,
        cachedRequests: null,
        docs: null,
        packages: null,
        packagesTotal: null,
        textures: null,
        texturesTotal: null,
        at: null,
      },
      updatedAt: 42,
    });
    expect(Object.keys(snap.phases)).toEqual([...PHASES]);
  });
});

describe('timeline', () => {
  function loadCollector() {
    const ck = clock(100000);
    const c = createCollector({ now: ck.now });
    c.reset(4);
    c.mark('connect');
    c.mark('joinPageLoaded', 100050);
    c.mark('autologinArmed', 100080);
    c.mark('autologinSubmitted', 100090);
    c.mark('gameNavigation', 100100);
    ck.set(100400);
    c.ingest({ type: 'phase', name: 'domReady', at: 400 });
    c.ingest({ type: 'sync', event: 'connect', at: 1000 });
    c.ingest({ type: 'worldData', bytes: 5000, at: 2000, sinceConnectMs: 1000 });
    c.ingest({ type: 'phase', name: 'init', at: 2400 });
    c.ingest({ type: 'phase', name: 'i18nInit', at: 2700 });
    c.ingest({ type: 'phase', name: 'setup', at: 3900 });
    c.ingest({ type: 'phase', name: 'canvasReady', at: 4700 });
    c.ingest({ type: 'phase', name: 'ready', at: 9200 });
    return { c, ck };
  }

  it('anchors page performance.now() to the first payload and stores ms since connect', () => {
    const ck = clock(10000);
    const c = createCollector({ now: ck.now });
    c.reset(1);
    c.mark('connect');
    ck.set(20000);
    c.ingest({ type: 'phase', name: 'domReady', at: 500 });
    ck.set(99999);
    c.ingest({ type: 'phase', name: 'init', at: 800 });
    const snap = c.snapshot();
    expect(snap.startedAt).toBe(10000);
    expect(snap.phases.domReady).toBe(10000);
    expect(snap.phases.init).toBe(10300);
    expect(snap.durations.initMs).toBe(300);
    expect(snap.durations.totalMs).toBeNull();
  });

  it('computes join durations from phase spans', () => {
    const { c } = loadCollector();
    c.ingest({ type: 'sync', event: 'connect', at: 5000 });
    c.ingest({ type: 'phase', name: 'init', at: 9999 });
    const snap = c.snapshot();
    assertNoUndefined(snap, 'snapshot');
    expect(snap.loadSeq).toBe(4);
    expect(snap.startedAt).toBe(100000);
    expect(snap.phases).toEqual({
      connect: 0,
      joinPageLoaded: 50,
      autologinArmed: 80,
      autologinSubmitted: 90,
      gameNavigation: 100,
      domReady: 400,
      socketConnected: 1000,
      worldDataReceived: 2000,
      init: 2400,
      i18nInit: 2700,
      setup: 3900,
      canvasReady: 4700,
      ready: 9200,
    });
    expect(snap.durations).toEqual({
      loginMs: 100,
      pageLoadMs: 900,
      transfersMs: 900,
      worldDataMs: 1000,
      initMs: 400,
      i18nMs: 300,
      setupMs: 1200,
      canvasMs: 800,
      totalMs: 9200,
    });
    expect(snap.worldData).toEqual({ bytes: 5000, ms: 1000 });
    expect(summarizeForHistory(snap)).toMatchObject({
      at: 100400,
      totalMs: 9200,
      transfersMs: 900,
      worldDataMs: 1000,
      worldDataBytes: 5000,
      setupMs: 1200,
      canvasMs: 800,
    });
  });

  it('measures init from domReady when world data never arrives', () => {
    const ck = clock(100000);
    const c = createCollector({ now: ck.now });
    c.reset(1);
    c.mark('connect');
    ck.set(100400);
    c.ingest({ type: 'phase', name: 'domReady', at: 400 });
    c.ingest({ type: 'phase', name: 'init', at: 2400 });
    expect(c.snapshot().durations.initMs).toBe(2000);
    expect(c.snapshot().durations.worldDataMs).toBeNull();
  });

  it('re-anchors after reset', () => {
    const ck = clock(1000);
    const c = createCollector({ now: ck.now });
    c.reset(1);
    c.mark('connect');
    ck.set(2000);
    c.ingest({ type: 'phase', name: 'domReady', at: 100 });
    expect(c.snapshot().phases.domReady).toBe(1000);
    ck.set(3000);
    c.reset(2);
    c.mark('connect');
    ck.set(3500);
    c.ingest({ type: 'phase', name: 'domReady', at: 50 });
    expect(c.snapshot().loadSeq).toBe(2);
    expect(c.snapshot().phases.domReady).toBe(500);
    expect(c.snapshot().phases.init).toBeNull();
  });

  it('newDocument re-anchors the page clock but keeps main-side marks', () => {
    const ck = clock(1000);
    const c = createCollector({ now: ck.now });
    c.reset(1);
    c.mark('connect');
    ck.set(1200);
    // Join page document: its own clock, its own domReady and transfers.
    c.ingest({ type: 'phase', name: 'domReady', at: 200 });
    c.ingest({ type: 'transfers', requests: 20, cachedRequests: 10, at: 250 });
    c.mark('autologinSubmitted', 1500);
    c.mark('gameNavigation', 1600);
    // /game document: performance.now() restarts at zero.
    c.newDocument();
    ck.set(1700);
    c.ingest({ type: 'phase', name: 'domReady', at: 100 });
    c.ingest({ type: 'phase', name: 'ready', at: 5100 });
    const snap = c.snapshot();
    expect(snap.loadSeq).toBe(1);
    expect(snap.phases.connect).toBe(0);
    expect(snap.phases.autologinSubmitted).toBe(500);
    expect(snap.phases.gameNavigation).toBe(600);
    expect(snap.phases.domReady).toBe(700);
    expect(snap.phases.ready).toBe(5700);
    expect(snap.durations.totalMs).toBe(5700);
    expect(snap.transfers.requests).toBeNull();
  });

  it('uses on-wire busy time for transfers, never reports a negative init, and keeps long-task phases', () => {
    const ck = clock(1000);
    const c = createCollector({ now: ck.now });
    c.reset(1);
    c.mark('connect');
    c.mark('gameNavigation', 1200);
    c.newDocument();
    ck.set(1300);
    c.ingest({ type: 'phase', name: 'domReady', at: 100 });
    c.ingest({ type: 'phase', name: 'init', at: 2100 });
    // World payload only noticed at setup (late detection) must not make init negative.
    c.ingest({ type: 'worldData', at: 4000, bytes: 10, sinceConnectMs: 0 });
    c.ingest({ type: 'phase', name: 'setup', at: 4000 });
    c.ingest({
      type: 'transfers', at: 4000, requests: 10, cachedRequests: 6, revalidatedRequests: 2,
      transferBytes: 100, encodedBytes: 900, decodedBytes: 1000, durationMs: 9999, busyMs: 1234,
    });
    c.ingest({
      type: 'phase', name: 'ready', at: 5000,
      longTasks: { count: 2, worstMs: 900, totalMs: 1100, byPhase: { init: 200, setup: 900, 'bad key!': 1 } },
    });
    const snap = c.snapshot();
    expect(snap.durations.initMs).toBe(2000);
    expect(snap.durations.transfersMs).toBe(1234);
    expect(snap.transfers.revalidatedRequests).toBe(2);
    expect(snap.transfers.busyMs).toBe(1234);
    expect(snap.client.longTasks).toEqual({ count: 2, worstMs: 900, totalMs: 1100, byPhase: { init: 200, setup: 900 } });
    const line = formatJoinSummary(snap);
    expect(line).toContain('(60% cached, 2 revalidated) 1.2s fetching');
    expect(line).toContain('blocked 1.1s (mostly setup→canvas)');
    expect(line).not.toContain('-');
  });
});

describe('staleThresholdMs', () => {
  it('derives a stall limit from the observed ping cadence and bounds it by server config', () => {
    expect(staleThresholdMs(null, null)).toBeNull();
    expect(staleThresholdMs(20000, null)).toBe(45000);
    expect(staleThresholdMs(null, 7000)).toBe(7000);
    expect(staleThresholdMs(20000, 600000)).toBe(45000);
    expect(staleThresholdMs(1000, 500)).toBe(1500);
    expect(staleThresholdMs(0, -1)).toBeNull();
  });
});

describe('sync', () => {
  it('takes latency from acks and the ping cadence from observed config', () => {
    const c = createCollector({ now: () => 5000 });
    c.reset(1);
    c.ingest({ type: 'sync', event: 'connect', at: 0 });
    c.ingest({ type: 'sync', event: 'config', at: 0, pingIntervalMs: 20000, observed: true });
    c.ingest({ type: 'sync', event: 'ack', at: 10, rttMs: 48 });
    c.ingest({ type: 'sync', event: 'ack', at: 20, rttMs: 30 });
    c.ingest({ type: 'sync', event: 'pong', at: 30 });
    let snap = c.snapshot();
    expect(snap.sync.rttMs).toBeNull();
    expect(snap.sync.rttMinMs).toBeNull();
    expect(snap.sync.rttP50Ms).toBeNull();
    expect(snap.sync.ackMinMs).toBe(30);
    expect(snap.sync.ackP50Ms).toBe(39);
    expect(snap.sync.latencyFloorMs).toBe(30);
    expect(snap.sync.pingIntervalMs).toBe(20000);
    expect(snap.sync.pingTimeoutMs).toBeNull();
    c.ingest({ type: 'sample', at: 40, connected: true, lastPacketAgeMs: 45000 });
    expect(c.snapshot().sync.state).toBe('synced');
    c.ingest({ type: 'sample', at: 50, connected: true, lastPacketAgeMs: 45001 });
    snap = c.snapshot();
    expect(snap.sync.state).toBe('out-of-sync');
  });

  it('goes out of sync on disconnect and on a stale packet', () => {
    const ck = clock(5000);
    const c = createCollector({ now: ck.now });
    c.reset(1);
    c.mark('connect');
    c.ingest({ type: 'sync', event: 'config', at: 0, pingIntervalMs: 1000, pingTimeoutMs: 500 });
    c.ingest({ type: 'sync', event: 'connect', at: 0 });
    let snap = c.snapshot();
    expect(snap.sync.state).toBe('synced');
    expect(snap.sync.connected).toBe(true);
    expect(snap.sync.pingIntervalMs).toBe(1000);
    expect(snap.sync.pingTimeoutMs).toBe(500);
    expect(snap.phases.socketConnected).toBe(0);

    c.ingest({ type: 'sample', at: 10, connected: true, lastPacketAgeMs: 1500 });
    expect(c.snapshot().sync.state).toBe('synced');
    c.ingest({ type: 'sample', at: 20, connected: true, lastPacketAgeMs: 1501 });
    expect(c.snapshot().sync.state).toBe('out-of-sync');
    expect(c.snapshot().sync.lastPacketAgeMs).toBe(1501);

    ck.set(6100);
    c.ingest({ type: 'sync', event: 'disconnect', at: 30 });
    snap = c.snapshot();
    expect(snap.sync.connected).toBe(false);
    expect(snap.sync.state).toBe('out-of-sync');
    expect(snap.sync.lastChangeAt).toBe(6100);

    c.ingest({ type: 'sync', event: 'reconnect_attempt', at: 40 });
    c.ingest({ type: 'sync', event: 'reconnect_attempt', at: 41 });
    c.ingest({ type: 'sync', event: 'connect', at: 50 });
    snap = c.snapshot();
    expect(snap.sync.reconnects).toBe(2);
    expect(snap.sync.connected).toBe(true);
    expect(snap.sync.state).toBe('synced');
    expect(snap.phases.socketConnected).toBe(0);
  });

  it('keeps a capped rtt reservoir for p50 and p95', () => {
    const c = createCollector({ now: () => 1000 });
    c.reset(1);
    for (const rtt of [10, 20, 30, 40, 100]) {
      c.ingest({ type: 'sync', event: 'pong', at: 5, rttMs: rtt });
    }
    const snap = c.snapshot();
    expect(snap.sync.rttMs).toBe(100);
    expect(snap.sync.rttP50Ms).toBe(30);
    expect(snap.sync.rttP95Ms).toBeCloseTo(88);

    c.ingest({ type: 'sync', event: 'pong', at: 6, rttMs: 1000 });
    for (let i = 0; i < 200; i += 1) {
      c.ingest({ type: 'sync', event: 'pong', at: 7, rttMs: 1 });
    }
    expect(c.snapshot().sync.rttMs).toBe(1);
    expect(c.snapshot().sync.rttP95Ms).toBe(1);
  });

  it('keeps ack time out of the rtt reservoir and counts each missed ping once', () => {
    const c = createCollector({ now: () => 1000 });
    c.reset(1);
    c.ingest({ type: 'sync', event: 'pong', at: 1, rttMs: 80 });
    c.ingest({ type: 'sync', event: 'pong', at: 2, rttMs: 100 });
    c.ingest({ type: 'sync', event: 'ack', at: 3, rttMs: 40 });
    c.ingest({ type: 'sync', event: 'ack', at: 4, rttMs: 1700 });
    c.ingest({ type: 'sync', event: 'missed_ping', at: 5 });
    c.ingest({ type: 'sync', event: 'missed_ping', at: 6 });
    c.ingest({ type: 'sample', at: 7, pingJitterP95Ms: 120, pingJitterSamples: 6 });
    let snap = c.snapshot();
    expect(snap.sync.rttMs).toBe(100);
    expect(snap.sync.rttMinMs).toBe(80);
    expect(snap.sync.rttP50Ms).toBe(90);
    expect(snap.sync.rttP95Ms).toBe(99);
    expect(snap.sync.ackMinMs).toBe(40);
    expect(snap.sync.ackP50Ms).toBe(870);
    expect(snap.sync.ackSamples).toBe(2);
    expect(snap.sync.latencyFloorMs).toBe(40);
    expect(snap.sync.missedPongs).toBe(2);
    expect(snap.sync.pingJitterP95Ms).toBe(120);
    expect(snap.sync.pingJitterSamples).toBe(6);

    c.ingest({ type: 'sync', event: 'pong', at: 8 });
    c.ingest({ type: 'sync', event: 'ping_jitter', at: 9, pingJitterP95Ms: 90, pingJitterSamples: 7 });
    snap = c.snapshot();
    expect(snap.sync.rttMs).toBe(100);
    expect(snap.sync.pingJitterP95Ms).toBe(90);
    expect(snap.sync.pingJitterSamples).toBe(7);

    for (let i = 0; i < 205; i += 1) {
      c.ingest({ type: 'sync', event: 'ack', at: 10, rttMs: 5 });
    }
    snap = c.snapshot();
    expect(snap.sync.ackSamples).toBe(200);
    expect(snap.sync.ackMinMs).toBe(5);
    expect(snap.sync.rttP95Ms).toBe(99);
    expect(snap.sync.latencyFloorMs).toBe(5);

    c.newDocument();
    snap = c.snapshot();
    expect(snap.sync.ackSamples).toBe(0);
    expect(snap.sync.ackP50Ms).toBeNull();
    expect(snap.sync.missedPongs).toBe(0);
    expect(snap.sync.latencyFloorMs).toBeNull();
    expect(snap.sync.pingJitterSamples).toBe(0);
  });
});

describe('transfers', () => {
  it('replaces totals and computes a 0..1 cache ratio', () => {
    const c = createCollector({ now: () => 50 });
    c.reset(1);
    c.ingest({
      type: 'transfers',
      at: 10,
      requests: 10,
      cachedRequests: 7,
      transferBytes: 100,
      encodedBytes: 80,
      decodedBytes: 200,
      durationMs: 40,
      slowDownloads: 1,
      ttfbP50Ms: 12,
      ttfbP95Ms: 40,
      downloadP95Ms: 90,
      byType: {
        script: {
          requests: 2,
          transferBytes: 100,
          encodedBytes: 80,
          decodedBytes: 200,
          cachedRequests: 0,
          durationMs: 40,
          name: 'http://cdn.example/a.js',
        },
      },
    });
    let snap = c.snapshot();
    expect(snap.transfers.cacheHitRatio).toBeCloseTo(0.7);
    expect(snap.transfers.requests).toBe(10);
    expect(snap.transfers.byType.script).toEqual({
      requests: 2,
      transferBytes: 100,
      encodedBytes: 80,
      decodedBytes: 200,
      cachedRequests: 0,
      durationMs: 40,
    });
    expect(JSON.stringify(snap)).not.toContain('http://');

    c.ingest({
      type: 'transfers',
      at: 11,
      requests: 4,
      cachedRequests: 0,
      transferBytes: 40,
      encodedBytes: 40,
      decodedBytes: 40,
      durationMs: 9,
      slowDownloads: 0,
      ttfbP50Ms: 1,
      ttfbP95Ms: 2,
      downloadP95Ms: 3,
      byType: {},
    });
    snap = c.snapshot();
    expect(snap.transfers.requests).toBe(4);
    expect(snap.transfers.cacheHitRatio).toBe(0);
    expect(snap.transfers.byType).toEqual({});

    c.ingest({ type: 'transfers', at: 12, requests: 0, cachedRequests: 0, transferBytes: 0 });
    expect(c.snapshot().transfers.cacheHitRatio).toBeNull();
  });
});

describe('world, sample, and main-side signals', () => {
  it('stores versions, counts, heap, and fps without content fields', () => {
    const c = createCollector({ now: () => 80 });
    c.reset(3);
    const modules = [];
    for (let i = 0; i < 250; i += 1) modules.push({ id: `m${i}`, version: '1.0.0', title: 'SECRET_MOD' });
    c.ingest({
      type: 'world',
      at: 20,
      foundryVersion: '12.331',
      generation: 12,
      system: { id: 'dnd5e', version: '3.1.0', title: 'SECRET_SYSTEM' },
      modules,
      activeModuleCount: 250,
      documents: { actors: 4, items: 9, scenes: 2 },
      performanceMode: 2,
      scene: { tokens: 7, tiles: 1, lights: 2, walls: 11, name: 'SECRET_SCENE' },
    });
    c.ingest({
      type: 'sample',
      at: 30,
      heapUsedBytes: 111,
      heapLimitBytes: 222,
      fps: 59.5,
      longTasks: { count: 2, worstMs: 80 },
      connected: true,
      lastPacketAgeMs: 15,
      pageErrors: { error: 2, rejection: 1, byName: { TypeError: 2, RangeError: 1 } },
      scene: { tokens: 8, tiles: 1, lights: 2, walls: 11 },
    });
    c.ingest({
      type: 'phase',
      name: 'ready',
      at: 40,
      pageErrors: { error: 2, rejection: 1, byName: { TypeError: 2 } },
    });
    c.resourcesUpdate({ rendererCpuPercent: 12.5, loadAvg1: 0.4, nope: 1, rendererHeapUsedBytes: NaN });
    c.setClient({ webglMode: 'hardware', webglFallbackReason: 'swiftshader', updateStatus: 'current' });
    c.unresponsive();
    c.unresponsive();
    c.rendererGone('crashed');
    c.setSyncCause('socket-stalled');
    c.netError('ERR_CONNECTION_RESET', 'script');
    c.httpStatus(404);
    c.httpStatus(503);
    c.httpStatus(200);

    const snap = c.snapshot();
    assertNoUndefined(snap, 'snapshot');
    expect(snap.world.foundryVersion).toBe('12.331');
    expect(snap.world.generation).toBe(12);
    expect(snap.world.system).toEqual({ id: 'dnd5e', version: '3.1.0' });
    expect(snap.world.modules).toHaveLength(200);
    expect(snap.world.modules[0]).toEqual({ id: 'm0', version: '1.0.0' });
    expect(snap.world.activeModuleCount).toBe(250);
    expect(snap.world.documents.actors).toBe(4);
    expect(snap.world.documents.items).toBe(9);
    expect(snap.world.fps).toBe(59.5);
    expect(snap.world.performanceMode).toBe(2);
    expect(snap.world.scene).toEqual({ tokens: 8, tiles: 1, lights: 2, walls: 11 });
    expect(snap.resources.rendererHeapUsedBytes).toBe(111);
    expect(snap.resources.rendererHeapLimitBytes).toBe(222);
    expect(snap.resources.rendererCpuPercent).toBe(12.5);
    expect(snap.resources.loadAvg1).toBe(0.4);
    expect(snap.client.longTasks).toEqual({ count: 2, worstMs: 80, totalMs: null, byPhase: {} });
    expect(snap.client.pageErrors).toEqual({ count: 3, byName: { TypeError: 2 } });
    expect(snap.client.webglMode).toBe('hardware');
    expect(snap.client.webglFallbackReason).toBe('swiftshader');
    expect(snap.client.updateStatus).toBe('current');
    expect(snap.client.unresponsive).toBe(2);
    expect(snap.client.rendererGone).toEqual({ count: 1, lastReason: 'crashed' });
    expect(snap.sync.cause).toBe('socket-stalled');
    expect(snap.sync.state).toBe('synced');
    expect(snap.net.errors).toEqual({ ERR_CONNECTION_RESET: 1 });
    expect(snap.net.httpStatus).toEqual({ '4xx': 1, '5xx': 1 });
    expect(JSON.stringify(snap)).not.toContain('SECRET');
    expect(JSON.stringify(snap)).not.toContain('http://');

    const copy = c.snapshot();
    copy.world.documents.actors = 99;
    copy.net.errors.NOPE = 4;
    expect(c.snapshot().world.documents.actors).toBe(4);
    expect(c.snapshot().net.errors.NOPE).toBeUndefined();

    c.reset(9);
    const cleared = c.snapshot();
    expect(cleared.loadSeq).toBe(9);
    expect(cleared.phases.ready).toBeNull();
    expect(cleared.client.pageErrors).toEqual({ count: 0, byName: {} });
    expect(cleared.sync.state).toBe('unknown');
    expect(cleared.client.rendererGone).toEqual({ count: 1, lastReason: 'crashed' });
    expect(cleared.resources.rendererCpuPercent).toBe(12.5);
    expect(cleared.resources.rendererHeapUsedBytes).toBe(111);
  });

  it('stores validated per-package hook time from the ready phase', () => {
    const rows = [];
    for (let i = 0; i < 16; i += 1) rows.push({ id: `mod-${i}`, ms: i * 10, count: i });
    rows.push({ id: 'not ok', ms: 99999, count: 1 });
    rows.push({ id: 'chris-premades', ms: 4200, count: 4 });
    const c = createCollector({ now: () => 5000 });
    c.mark('connect');
    c.ingest({
      type: 'phase',
      name: 'ready',
      at: 1000,
      hooks: { byPackage: rows, totalMs: 9999, packages: 20 },
    });
    const hookTime = c.snapshot().world.hookTime;
    expect(hookTime.totalMs).toBe(9999);
    expect(hookTime.packages).toBe(20);
    expect(hookTime.byPackage).toHaveLength(15);
    expect(hookTime.byPackage[0]).toEqual({ id: 'chris-premades', ms: 4200, count: 4 });
    expect(hookTime.byPackage.some((row) => row.id === 'not ok')).toBe(false);
    expect(JSON.stringify(hookTime)).not.toContain('http');
    expect(summarizeForHistory(c.snapshot()).hookTotalMs).toBe(9999);
    c.ingest({ type: 'phase', name: 'init', at: 50, hooks: { totalMs: 5, byPackage: [{ id: 'dnd5e', ms: 5, count: 1 }] } });
    expect(c.snapshot().world.hookTime.byPackage[0].id).toBe('chris-premades');
  });

  it('keeps progress counts numeric and maps gauge clocks from the snapshot', () => {
    const ck = clock(100000);
    const c = createCollector({ now: ck.now });
    c.reset(1);
    c.mark('connect');
    c.mark('gameNavigation', 100100);
    ck.set(100400);
    c.ingest({ type: 'phase', name: 'domReady', at: 400 });
    c.ingest({
      type: 'progress',
      requests: 12,
      cachedRequests: 3,
      docs: 9,
      packages: 2,
      packagesTotal: 8,
      textures: 'nope',
      texturesTotal: -4,
      at: 500,
      title: 'secret world',
    });
    expect(c.snapshot().progress).toEqual({
      requests: 12,
      cachedRequests: 3,
      docs: 9,
      packages: 2,
      packagesTotal: 8,
      textures: null,
      texturesTotal: null,
      at: 500,
    });
    expect(JSON.stringify(c.snapshot().progress)).not.toContain('secret');
    const early = liveFromSnapshot(c.snapshot());
    expect(early.requests).toBe(12);
    expect(early.packages).toBe(2);
    expect(early.packagesTotal).toBe(8);
    expect(early.textures).toBeNull();
    expect(early.completedPhases).toEqual([]);
    expect(early.phases.pageLoad.done).toBeUndefined();
    expect(early.phases.pageLoad.startMs).toBe(100100);
    c.ingest({ type: 'phase', name: 'setup', at: 900 });
    c.ingest({ type: 'phase', name: 'canvasReady', at: 1200 });
    const mid = liveFromSnapshot(c.snapshot());
    expect(mid.completedPhases).toEqual(['setup', 'canvasReady']);
    expect(mid.phases.pageLoad.done).toBeUndefined();
    expect(mid.phases.setup.done).toBe(true);
    expect(mid.phases.canvas.done).toBe(true);
    c.ingest({ type: 'phase', name: 'ready', at: 2000 });
    const done = liveFromSnapshot(c.snapshot());
    expect(done.phases.pageLoad.done).toBe(true);
    expect(done.completedPhases).toContain('ready');
    expect(done.completedPhases).not.toContain('socketConnected');
    c.newDocument();
    expect(c.snapshot().progress.requests).toBeNull();
  });
});

describe('malformed payloads', () => {
  it('drops urls, long strings, and non-finite numbers without throwing', () => {
    const c = createCollector({ now: () => 1000 });
    c.reset(1);
    expect(() => {
      c.ingest(null);
      c.ingest(undefined);
      c.ingest('phase');
      c.ingest(42);
      c.ingest({ type: 'phase', name: 'init', at: NaN });
      c.ingest({ type: 'phase', name: 'http://evil.test/a', at: 10 });
      c.ingest({
        type: 'phase',
        name: 'init',
        at: 10,
        leak: 'http://evil.test/secret',
        big: `SECRET${'y'.repeat(80)}`,
      });
      c.ingest({
        type: 'transfers',
        at: 11,
        requests: NaN,
        transferBytes: Infinity,
        cachedRequests: '3',
        byType: { script: { requests: 1, name: 'http://cdn.example/x.js' } },
      });
      c.ingest({
        type: 'world',
        at: 12,
        foundryVersion: 'http://world.example/w',
        generation: NaN,
        system: { id: 'dnd5e', title: 'SECRET_SYSTEM' },
        modules: [
          { id: 'http://mod.example/a', version: '1' },
          { id: 'ok-mod', version: '1.2.3', title: 'SECRET_MODULE' },
        ],
        documents: { actors: NaN, items: 4, scenes: 'nope' },
      });
      c.ingest({
        type: 'sample',
        at: 'soon',
        connected: 'yes',
        lastPacketAgeMs: NaN,
        heapUsedBytes: '1024',
        fps: Infinity,
        pageErrors: { error: '1', byName: { 'http://e': 2, TypeError: 1 } },
        longTasks: 'x',
        scene: [],
      });
      c.mark('http://nope');
      c.mark('not-a-phase', 5);
      c.netError('http://err', 'script');
      c.netError('ERR_CONNECTION_RESET', 'script');
      c.netError('x'.repeat(100), 'img');
      c.httpStatus('500');
      c.httpStatus(404);
      c.rendererGone('http://crash');
      c.rendererGone('crashed');
      c.setSyncCause('hacked');
      c.setSyncCause('socket-stalled');
      c.setClient({
        webglMode: 'software',
        webglFallbackReason: 'http://nope.example/g',
        updateStatus: 'current',
      });
      c.resourcesUpdate(null);
    }).not.toThrow();

    const snap = c.snapshot();
    assertNoUndefined(snap, 'snapshot');
    const json = JSON.stringify(snap);
    expect(json).not.toContain('http://');
    expect(json).not.toContain('SECRET');
    expect(json).not.toContain('yyyy');
    expect(snap.phases.init).toBe(0);
    expect(snap.world.foundryVersion).toBeNull();
    expect(snap.world.system).toEqual({ id: 'dnd5e', version: null });
    expect(snap.world.modules).toEqual([{ id: 'ok-mod', version: '1.2.3' }]);
    expect(snap.world.documents.items).toBe(4);
    expect(snap.world.documents.actors).toBeNull();
    expect(snap.client.pageErrors).toEqual({ count: 1, byName: { TypeError: 1 } });
    expect(snap.net.errors).toEqual({ ERR_CONNECTION_RESET: 1 });
    expect(snap.net.httpStatus).toEqual({ '4xx': 1, '5xx': 0 });
    expect(snap.client.rendererGone).toEqual({ count: 2, lastReason: 'crashed' });
    expect(snap.sync.cause).toBe('socket-stalled');
    expect(snap.client.webglMode).toBe('software');
    expect(snap.client.webglFallbackReason).toBeNull();
    expect(snap.client.updateStatus).toBe('current');
    expect(Object.keys(snap.phases)).toEqual([...PHASES]);
  });
});

describe('summaries', () => {
  const transferBytes = Math.round(42.1 * 1024 * 1024);
  const worldBytes = Math.round(6.8 * 1024 * 1024);
  const fixture = {
    updatedAt: 123,
    durations: {
      transfersMs: 3100,
      worldDataMs: 2000,
      initMs: 400,
      i18nMs: 300,
      setupMs: 1200,
      canvasMs: 800,
      totalMs: 9200,
    },
    transfers: {
      requests: 318,
      transferBytes,
      cacheHitRatio: 0.71,
    },
    worldData: { bytes: worldBytes, ms: 2000 },
    world: {
      foundryVersion: 'http://should-not-appear.example/world',
      documents: { actors: 4000, items: 300, scenes: 12 },
    },
  };

  it('formats one join summary line and omits null segments', () => {
    expect(formatJoinSummary(fixture)).toBe(
      'join summary: transfers 318 req, 42.1 MB (71% cached) 3.1s fetching | world data 2.0s 6.8 MB 4,312 docs | init 0.4s | i18n 0.3s | setup 1.2s | canvas 0.8s | ready 9.2s total',
    );
    expect(formatJoinSummary(fixture)).not.toContain('http');
    expect(formatJoinSummary({ durations: { totalMs: 1500 } })).toBe('join summary: ready 1.5s total');
    expect(formatJoinSummary({})).toBe('join summary:');
    expect(formatJoinSummary(null)).toBe('join summary:');
    expect(formatJoinSummary({
      durations: { totalMs: 1000 },
      world: { documents: { actors: 2 } },
    })).toBe('join summary: world data 2 docs | ready 1.0s total');
  });

  it('summarizes numbers for history and compares them', () => {
    expect(summarizeForHistory(fixture)).toEqual({
      at: 123,
      totalMs: 9200,
      transfersMs: 3100,
      worldDataMs: 2000,
      worldDataBytes: worldBytes,
      setupMs: 1200,
      canvasMs: 800,
      requests: 318,
      transferBytes,
      cacheHitRatio: 0.71,
      docs: 4312,
      ttfbP50Ms: null,
      rttP50Ms: null,
      ackP50Ms: null,
      worldBytesEstimate: null,
      hookTotalMs: null,
      worldDataMsPerMb: 2000 / (worldBytes / 1e6),
      setupMsPerDoc: 1200 / 4312,
    });
    expect(summarizeForHistory(null).totalMs).toBeNull();
    expect(compareWithHistory({ durations: { totalMs: 9200 } }, [
      { totalMs: 8000 },
      { totalMs: 10000 },
      { totalMs: 12000 },
    ])).toEqual({
      thisMs: 9200,
      typicalMs: 10000,
      firstMs: 8000,
      fastestMs: 8000,
    });
    expect(compareWithHistory({ totalMs: 5 }, [
      { totalMs: null },
      { totalMs: 9 },
      { totalMs: 3 },
    ])).toEqual({
      thisMs: 5,
      typicalMs: 6,
      firstMs: null,
      fastestMs: 3,
    });
    expect(compareWithHistory(null, [])).toEqual({
      thisMs: null,
      typicalMs: null,
      firstMs: null,
      fastestMs: null,
    });
  });

  it('adds null-safe rate fields for later joins', () => {
    const rated = summarizeForHistory({
      updatedAt: 5,
      durations: { setupMs: 400, totalMs: 1000 },
      transfers: { ttfbP50Ms: 80 },
      sync: { rttP50Ms: 25, ackP50Ms: 400 },
      worldData: { bytes: 2e6, ms: 500 },
      world: { documents: { actors: 4 } },
    });
    expect(rated.ttfbP50Ms).toBe(80);
    expect(rated.rttP50Ms).toBe(25);
    expect(rated.ackP50Ms).toBe(400);
    expect(rated.worldDataMsPerMb).toBe(250);
    expect(rated.setupMsPerDoc).toBe(100);
    const empty = summarizeForHistory({
      durations: { setupMs: 10 },
      worldData: { bytes: 0, ms: 10 },
      world: { documents: {} },
    });
    expect(empty.ttfbP50Ms).toBeNull();
    expect(empty.rttP50Ms).toBeNull();
    expect(empty.ackP50Ms).toBeNull();
    expect(empty.worldDataMsPerMb).toBeNull();
    expect(empty.setupMsPerDoc).toBeNull();
  });
});

describe('clock skew and gpu process', () => {
  it('records clock skew once per load and keeps a gpu-gone flag', () => {
    const c = createCollector({ now: () => 10 });
    c.setClockSkew(40);
    c.setClockSkew(90);
    c.setClient({ gpuGone: true });
    expect(c.snapshot().net.clockSkewMs).toBe(40);
    expect(c.snapshot().client.gpuGone).toBe(true);
    c.setClockSkew(Number.NaN);
    expect(c.snapshot().net.clockSkewMs).toBe(40);
    c.reset(3);
    expect(c.snapshot().net.clockSkewMs).toBeNull();
    expect(c.snapshot().client.gpuGone).toBe(true);
    c.setClockSkew(-15);
    expect(c.snapshot().net.clockSkewMs).toBe(-15);
    c.setClient({ gpuGone: false });
    expect(c.snapshot().client.gpuGone).toBe(false);
  });
});

describe('world sizes and traffic', () => {
  it('stores collection bytes without replacing counts and sums them for history', () => {
    const c = createCollector({ now: () => 1000 });
    c.reset(1);
    c.ingest({ type: 'world', at: 1, documents: { actors: 358, packs: 4 } });
    c.ingest({ type: 'worldSizes', at: 2, sizes: { actors: 43201331, packs: 9 }, complete: false });
    let snap = c.snapshot();
    expect(snap.world.documents.actors).toBe(358);
    expect(snap.world.documents.packs).toBe(4);
    expect(snap.world.documentBytes.actors).toBe(43201331);
    expect(snap.world.documentBytes.packs).toBeNull();
    expect(snap.world.documentBytesComplete).toBe(false);
    c.ingest({ type: 'worldSizes', at: 3, sizes: { items: 10 }, complete: true });
    snap = c.snapshot();
    expect(snap.world.documentBytes.items).toBe(10);
    expect(snap.world.documentBytesComplete).toBe(true);
    expect(summarizeForHistory(snap).worldBytesEstimate).toBe(43201341);
  });

  it('passes cache-read totals through and rates traffic over a 30 second window', () => {
    const ck = clock(0);
    const c = createCollector({ now: ck.now });
    c.reset(1);
    c.ingest({
      type: 'transfers',
      at: 1,
      requests: 80,
      cachedRequests: 60,
      cacheReadBytes: 1000,
      cacheReadMs: 700,
      cacheReadP95Ms: 395,
      cacheReadSlow: 3,
    });
    expect(c.snapshot().transfers).toMatchObject({
      cacheReadBytes: 1000,
      cacheReadMs: 700,
      cacheReadP95Ms: 395,
      cacheReadSlow: 3,
    });
    c.ingest({
      type: 'sample',
      at: 1,
      requestsOut: 0,
      messagesIn: 0,
      lastRequestName: 'https://secret.example/a',
      lastRequestAgeMs: 10,
      lastRequestMs: 4,
    });
    expect(c.snapshot().sync.lastRequest.name).toBeNull();
    expect(c.snapshot().sync.requestsPerMin).toBeNull();
    expect(JSON.stringify(c.snapshot())).not.toContain('secret.example');
    c.ingest({
      type: 'sample',
      at: 2,
      requestsOut: 0,
      messagesIn: 0,
      lastRequestName: 'modifyDocument',
      lastRequestAgeMs: 2000,
      lastRequestMs: 83,
      lastMessageAgeMs: 400,
    });
    ck.set(30000);
    c.ingest({ type: 'sample', at: 3, requestsOut: 30, messagesIn: 300 });
    const sync = c.snapshot().sync;
    expect(sync.lastRequest).toEqual({ name: 'modifyDocument', ageMs: 2000, ms: 83 });
    expect(sync.lastMessageAgeMs).toBe(400);
    expect(sync.requestsPerMin).toBe(60);
    expect(sync.messagesPerMin).toBe(600);
  });
});

describe('protocol counts', () => {
  it('stores http version and script counts on transfers', () => {
    const c = createCollector({ now: () => 10 });
    c.ingest({
      type: 'transfers',
      at: 8,
      requests: 3,
      protocolH1: 2,
      protocolH2: 0,
      scriptH1: 2,
    });
    expect(c.snapshot().transfers).toMatchObject({ protocolH1: 2, protocolH2: 0, scriptH1: 2 });
  });
});
