import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { failurePathname } from '../electron/bad-urls.js';
import {
  TELEMETRY_VERSION,
  buildLoadingDetailsScript,
  buildReferenceLookupScript,
  buildTelemetryScript,
} from '../electron/foundry-telemetry.js';

const FORBIDDEN = [
  'entry.name',
  '.href',
  'location.',
  'document.title',
  'scene.name',
  'world.title',
  'world.id',
  '.reason',
];

function baseGame(socket) {
  return {
    ready: false,
    view: 'game',
    version: '12.331',
    release: { version: '12.331', generation: 12 },
    system: { id: 'dnd5e', version: '3.1.0', title: 'SECRET_SYSTEM' },
    world: { title: 'SECRET_TITLE', id: 'SECRET_WORLD' },
    modules: {
      forEach(fn) {
        fn({ id: 'dice-so-nice', version: '1.2.3', active: true, title: 'SECRET_MODULE' });
        fn({ id: 'SECRET_INACTIVE', version: '9.9.9', active: false });
      },
    },
    actors: { size: 4, contents: [{ name: 'SECRET_ACTOR' }] },
    items: { size: 9 },
    scenes: { size: 2 },
    journal: { size: 1 },
    tables: { size: 0 },
    macros: { size: 3 },
    playlists: { size: 0 },
    cards: { size: 0 },
    folders: { size: 5 },
    users: { size: 2 },
    messages: { size: 8 },
    packs: { size: 6 },
    socket,
  };
}

function runTelemetry(mutate) {
  const payloads = [];
  const hooks = {};
  const onceNames = [];
  const listeners = {};
  const engineHandlers = {};
  const socketHandlers = {};
  const ioHandlers = {};
  let cleared = 0;
  let bufferSize = 0;
  let intervalFn = null;
  let intervalMs = 0;
  let longCb = null;
  const socket = {
    connected: false,
    on(ev, fn) {
      socketHandlers[ev] = fn;
    },
    io: {
      on(ev, fn) {
        ioHandlers[ev] = fn;
      },
      engine: {
        pingInterval: 25000,
        pingTimeout: 20000,
        on(ev, fn) {
          engineHandlers[ev] = fn;
        },
      },
    },
  };
  const sandbox = {
    _now: 1000,
    performance: {
      now() {
        return sandbox._now;
      },
      memory: { usedJSHeapSize: 4096, jsHeapSizeLimit: 8192 },
      setResourceTimingBufferSize(n) {
        bufferSize = n;
      },
      clearResourceTimings() {
        cleared += 1;
      },
    },
    flcGame: {
      telemetry(payload) {
        payloads.push(JSON.parse(JSON.stringify(payload)));
      },
    },
    Hooks: {
      once(name, fn) {
        onceNames.push(name);
        hooks[name] = fn;
      },
    },
    canvas: {
      ready: false,
      performance: { mode: 2 },
      app: { ticker: { FPS: 60 } },
      scene: {
        name: 'SECRET_SCENE',
        tokens: { size: 7 },
        tiles: { size: 1 },
        lights: { size: 2 },
        walls: { size: 11 },
      },
    },
    addEventListener(type, fn) {
      listeners[type] = fn;
    },
    setTimeout(fn, ms) {
      if (ms === 100) return 1;
      intervalFn = fn;
      intervalMs = ms;
      return 8;
    },
    clearTimeout(id) {
      if (id !== 1) {
        intervalFn = null;
        intervalMs = 0;
      }
    },
    setInterval(fn, ms) {
      intervalFn = fn;
      intervalMs = ms;
      return 7;
    },
    clearInterval() {
      intervalFn = null;
    },
  };
  function PerformanceObserver(cb) {
    this.cb = cb;
  }
  PerformanceObserver.prototype.observe = function observe(opts) {
    if (opts && opts.type === 'longtask') {
      longCb = this.cb;
      return;
    }
    if (opts && opts.type === 'resource') {
      this.cb({
        getEntries() {
          return sandbox._resources || [{
            name: 'http://cdn.example/a.js',
            initiatorType: 'script',
            transferSize: 100,
            encodedBodySize: 80,
            decodedBodySize: 200,
            duration: 12,
            startTime: 3,
            requestStart: 5,
            responseStart: 9,
            responseEnd: 15,
          }];
        },
      });
    }
  };
  PerformanceObserver.prototype.disconnect = function disconnect() {};
  sandbox.PerformanceObserver = PerformanceObserver;
  sandbox.game = baseGame(socket);
  sandbox.window = sandbox;
  if (mutate) mutate(sandbox, socket);
  const script = buildTelemetryScript({ version: '");alert(1);//' });
  vm.createContext(sandbox);
  vm.runInContext(script, sandbox);
  vm.runInContext(script, sandbox);
  return {
    sandbox,
    payloads,
    hooks,
    onceNames,
    listeners,
    engineHandlers,
    socketHandlers,
    ioHandlers,
    socket,
    cleared: () => cleared,
    bufferSize: () => bufferSize,
    intervalMs: () => intervalMs,
    fireInterval() {
      if (intervalFn) intervalFn();
    },
    fireLongTask(duration, startTime) {
      if (!longCb) return;
      longCb({
        getEntries() {
          return [{ duration, startTime: startTime || 0 }];
        },
      });
    },
  };
}

describe('buildTelemetryScript', () => {
  it('is an idempotent probe and does not name content fields', () => {
    const src = buildTelemetryScript({ version: '");alert(1);//' });
    expect(src).toContain('__flcTelemetry');
    expect(src).toContain(String(TELEMETRY_VERSION));
    expect(src).toContain('PerformanceObserver');
    expect(src).toContain('Hooks.once');
    expect(src).toContain('clearResourceTimings');
    expect(src).toContain('setTimeout');
    expect(src).not.toContain('setInterval');
    expect(src).not.toContain('alert');
    expect(src).not.toContain('__FLC_TELEMETRY_VERSION__');
    for (const needle of FORBIDDEN) {
      expect(src.includes(needle), needle).toBe(false);
    }
    expect(() => new Function(src)).not.toThrow();
  });

  it('emits phases, counts, and timings without page content', () => {
    const ctx = runTelemetry();
    expect(ctx.onceNames).toEqual(['init', 'i18nInit', 'setup', 'canvasReady', 'ready']);
    expect(ctx.bufferSize()).toBe(1000);
    expect(ctx.cleared()).toBeGreaterThan(0);
    expect(ctx.sandbox.__flcTelemetry.version).toBe(TELEMETRY_VERSION);

    const dom = ctx.payloads.find((p) => p.type === 'phase' && p.name === 'domReady');
    expect(dom.at).toBe(1000);
    expect(dom.late).toBeUndefined();

    const xfer = ctx.payloads.find((p) => p.type === 'transfers');
    expect(xfer.requests).toBe(1);
    expect(xfer.byType.script.transferBytes).toBe(100);
    expect(xfer.byType.script.name).toBeUndefined();
    expect(xfer.ttfbP50Ms).toBe(4);
    expect(xfer.downloadP95Ms).toBe(6);
    expect(xfer.slowDownloads).toBe(0);

    const cfg = ctx.payloads.find((p) => p.type === 'sync' && p.event === 'config');
    expect(cfg).toMatchObject({ pingIntervalMs: 25000, pingTimeoutMs: 20000 });

    ctx.sandbox._now = 1100;
    ctx.socketHandlers.connect();
    ctx.sandbox._now = 1700;
    const packet = `http://packet.example/world${'Z'.repeat(262144)}`;
    ctx.engineHandlers.packet({ data: packet });
    const worldData = ctx.payloads.filter((p) => p.type === 'worldData');
    expect(worldData).toHaveLength(1);
    expect(worldData[0].bytes).toBe(packet.length);
    expect(worldData[0].sinceConnectMs).toBe(600);
    expect(worldData[0].at).toBe(1700);

    ctx.sandbox._now = 1800;
    ctx.engineHandlers.ping();
    ctx.sandbox._now = 1842;
    ctx.engineHandlers.pong();
    const pong = ctx.payloads.find((p) => p.type === 'sync' && p.event === 'pong');
    expect(pong).toMatchObject({ rttMs: 42, at: 1842 });

    ctx.listeners.error({
      message: 'SECRET_MESSAGE_TEXT',
      error: new TypeError('SECRET_MESSAGE_TEXT'),
    });
    ctx.listeners.unhandledrejection({
      reason: new RangeError('SECRET_MESSAGE_TEXT'),
    });

    ctx.sandbox._now = 2000;
    ctx.hooks.init();
    const initPhase = ctx.payloads.find((p) => p.type === 'phase' && p.name === 'init');
    expect(initPhase.packages).toEqual({
      view: 'game',
      foundryVersion: '12.331',
      system: { id: 'dnd5e', version: '3.1.0' },
      modules: [{ id: 'dice-so-nice', version: '1.2.3' }],
    });
    expect(JSON.stringify(initPhase.packages)).not.toContain('SECRET');
    ctx.hooks.i18nInit();
    ctx.hooks.setup();
    expect(ctx.payloads.filter((p) => p.type === 'worldData')).toHaveLength(1);
    ctx.hooks.canvasReady();
    ctx.hooks.ready();

    const ready = ctx.payloads.find((p) => p.type === 'phase' && p.name === 'ready');
    expect(ready.pageErrors).toEqual({
      error: 1,
      rejection: 1,
      byName: { TypeError: 1, RangeError: 1 },
    });
    expect(ready.late).toBeUndefined();

    const world = ctx.payloads.find((p) => p.type === 'world');
    expect(Object.keys(world).sort()).toEqual([
      'at',
      'documents',
      'foundryVersion',
      'generation',
      'modules',
      'performanceMode',
      'scene',
      'system',
      'type',
    ]);
    expect(world).toMatchObject({
      type: 'world',
      foundryVersion: '12.331',
      generation: 12,
      system: { id: 'dnd5e', version: '3.1.0' },
      modules: [{ id: 'dice-so-nice', version: '1.2.3' }],
      documents: {
        actors: 4,
        items: 9,
        scenes: 2,
        journal: 1,
        tables: 0,
        macros: 3,
        playlists: 0,
        cards: 0,
        folders: 5,
        users: 2,
        messages: 8,
        packs: 6,
      },
      performanceMode: 2,
      scene: { tokens: 7, tiles: 1, lights: 2, walls: 11 },
    });

    const many = [];
    for (let i = 0; i < 210; i += 1) many.push({ id: `mod${i}`, version: '1', active: true });
    ctx.sandbox.game.modules = {
      forEach(fn) {
        many.forEach(fn);
      },
    };
    const snap = ctx.sandbox.__flcTelemetry.snapshot();
    expect(snap.version).toBe(TELEMETRY_VERSION);
    const capped = ctx.payloads.filter((p) => p.type === 'world').pop();
    expect(capped.modules).toHaveLength(200);
    expect(capped.modules[0]).toEqual({ id: 'mod0', version: '1' });

    ctx.socket.connected = true;
    ctx.sandbox._now = 2200;
    ctx.sandbox.__flcTelemetry.start();
    expect(ctx.intervalMs()).toBe(5000);
    ctx.sandbox.__flcTelemetry.start(250);
    expect(ctx.intervalMs()).toBe(250);
    ctx.fireInterval();
    const sample = ctx.payloads.filter((p) => p.type === 'sample').pop();
    expect(sample).toMatchObject({
      heapUsedBytes: 4096,
      heapLimitBytes: 8192,
      fps: 60,
      connected: true,
      lastPacketAgeMs: 500,
      pageErrors: {
        error: 1,
        rejection: 1,
        byName: { TypeError: 1, RangeError: 1 },
      },
      scene: { tokens: 7, tiles: 1, lights: 2, walls: 11 },
    });
    expect(JSON.stringify(sample)).not.toContain('SECRET');

    const leaked = JSON.stringify(ctx.payloads);
    expect(leaked).not.toContain('http');
    expect(leaked).not.toContain('SECRET');
    expect(leaked).not.toContain('ZZZZ');
  });

  it('backs off the next sample after a long task, then returns to the base interval', () => {
    const ctx = runTelemetry();
    ctx.sandbox.__flcTelemetry.start(5000);
    expect(ctx.intervalMs()).toBe(5000);
    ctx.fireInterval();
    expect(ctx.intervalMs()).toBe(5000);
    ctx.fireLongTask(80);
    ctx.fireInterval();
    expect(ctx.intervalMs()).toBe(15000);
    ctx.fireInterval();
    expect(ctx.intervalMs()).toBe(5000);
    ctx.sandbox.__flcTelemetry.stop();
    expect(ctx.intervalMs()).toBe(0);
  });

  it('binds the socket when the page creates it, before window.game exists', () => {
    const ctx = runTelemetry((sandbox) => {
      sandbox.game = undefined;
    });
    expect(Object.keys(ctx.engineHandlers)).toEqual([]);
    const made = [];
    function lookup() {
      made.push(1);
      return ctx.socket;
    }
    lookup.connect = lookup;
    lookup.io = lookup;
    lookup.Manager = function Manager() {};
    lookup.protocol = 5;
    ctx.sandbox.__factory = lookup;
    vm.runInContext('window.io = __factory;', ctx.sandbox);
    expect(ctx.sandbox.io).not.toBe(lookup);
    expect(ctx.sandbox.io.connect).toBe(ctx.sandbox.io);
    expect(ctx.sandbox.io.io).toBe(ctx.sandbox.io);
    expect(ctx.sandbox.io.Manager).toBe(lookup.Manager);
    expect(ctx.sandbox.io.protocol).toBe(5);

    const s = vm.runInContext('io.connect({ path: "/socket.io" })', ctx.sandbox);
    expect(s).toBe(ctx.socket);
    expect(made).toHaveLength(1);
    expect(typeof ctx.engineHandlers.packet).toBe('function');
    expect(typeof ctx.ioHandlers.open).toBe('function');
    ctx.sandbox._now = 1200;
    ctx.socketHandlers.connect();
    ctx.sandbox._now = 1900;
    ctx.engineHandlers.packet({ data: 'Z'.repeat(300000) });
    const wd = ctx.payloads.find((p) => p.type === 'worldData');
    expect(wd).toMatchObject({ bytes: 300000, sinceConnectMs: 700 });

    // Reconnect creates a fresh engine; it is rebound once.
    const rebound = {};
    ctx.socket.io.engine = {
      pingInterval: 1,
      pingTimeout: 1,
      on(ev, fn) { rebound[ev] = fn; },
    };
    ctx.ioHandlers.open();
    ctx.ioHandlers.open();
    expect(Object.keys(rebound).sort()).toEqual(['packet', 'ping', 'pong']);

    // Later page assignment of game.socket does not double-bind.
    ctx.sandbox.game = baseGame(ctx.socket);
    const before = JSON.stringify(ctx.payloads);
    vm.runInContext(buildTelemetryScript(), ctx.sandbox);
    expect(JSON.stringify(ctx.payloads)).toBe(before);
    expect(JSON.stringify(ctx.payloads)).not.toContain('socket.io');
  });

  it('times acks the page already performs, learns ping cadence, and ignores server-initiated pong gaps', () => {
    const sent = [];
    const ctx = runTelemetry((sandbox, socket) => {
      socket.emit = function emit(...args) {
        sent.push(args);
        return this;
      };
      function Engine() {}
      Engine.protocol = 4;
      const engine = new Engine();
      engine.pingInterval = undefined;
      engine.on = (ev, fn) => { sandbox._engineHandlers[ev] = fn; };
      sandbox._engineHandlers = {};
      socket.io.engine = engine;
    });
    const handlers = ctx.sandbox._engineHandlers;
    expect(typeof handlers.packet).toBe('function');

    // Server-initiated ping: the local ping->pong gap is not a round trip.
    ctx.sandbox._now = 3000;
    handlers.ping();
    ctx.sandbox._now = 3000.3;
    handlers.pong();
    const pong = ctx.payloads.find((p) => p.type === 'sync' && p.event === 'pong');
    expect(pong).toBeDefined();
    expect(pong.rttMs).toBeUndefined();

    // Cadence is learned from arrivals (median gap), not read from internals.
    ctx.sandbox._now = 23000;
    handlers.ping();
    ctx.sandbox._now = 43100;
    handlers.ping();
    const cfg = ctx.payloads.filter((p) => p.type === 'sync' && p.event === 'config');
    expect(cfg).toHaveLength(1);
    expect(cfg[0]).toMatchObject({ pingIntervalMs: 20000, observed: true });
    // A clearly different cadence is re-announced.
    ctx.sandbox._now = 93100;
    handlers.ping();
    ctx.sandbox._now = 143100;
    handlers.ping();
    const cfg2 = ctx.payloads.filter((p) => p.type === 'sync' && p.event === 'config');
    expect(cfg2).toHaveLength(2);
    expect(cfg2[1].pingIntervalMs).toBe(35050);

    // Acks: emit(name, data, cb) is timed once the world is ready and no
    // long task overlapped; non-ack emits pass through untouched.
    ctx.sandbox._now = 49000;
    ctx.socket.emit('early', {}, () => {});
    sent[0][2]();
    expect(ctx.payloads.filter((p) => p.event === 'ack')).toHaveLength(0);
    sent.length = 0;
    ctx.sandbox.game.ready = true;
    ctx.hooks.ready();
    ctx.socket.emit('stalled', {}, () => {});
    ctx.fireLongTask(500, 49100);
    sent[0][2]();
    expect(ctx.payloads.filter((p) => p.event === 'ack')).toHaveLength(0);
    sent.length = 0;
    ctx.sandbox._now = 50000;
    ctx.socket.emit('modifyDocument', { secret: 'SECRET_DOC' }, (result) => {
      ctx.sandbox._ackResult = result;
    });
    expect(sent).toHaveLength(1);
    expect(sent[0][0]).toBe('modifyDocument');
    ctx.sandbox._now = 50083;
    sent[0][2]('ok');
    expect(ctx.sandbox._ackResult).toBe('ok');
    const ack = ctx.payloads.find((p) => p.type === 'sync' && p.event === 'ack');
    expect(ack).toMatchObject({ rttMs: 83, at: 50083 });
    ctx.socket.emit('plain', 1);
    expect(sent[1]).toEqual(['plain', 1]);
    // Rate limit: a second ack inside 250 ms is not forwarded.
    ctx.socket.emit('x', {}, () => {});
    sent[2][2]();
    expect(ctx.payloads.filter((p) => p.event === 'ack')).toHaveLength(1);
    expect(JSON.stringify(ctx.payloads)).not.toContain('SECRET');

    ctx.sandbox.__flcTelemetry.start(5000);
    ctx.fireInterval();
    const sample = ctx.payloads.filter((p) => p.type === 'sample').pop();
    expect(sample.pingJitterSamples).toBe(3);
    expect(sample.pingJitterP95Ms).toBe(30000);
    expect(ctx.payloads.filter((p) => p.event === 'missed_ping')).toHaveLength(2);
    const jitterSamples = () => {
      const rows = ctx.payloads.filter((p) => p.event === 'ping_jitter');
      return rows.length ? rows[rows.length - 1].pingJitterSamples : 0;
    };
    expect(jitterSamples()).toBe(3);
    ctx.fireLongTask(250, 143100);
    ctx.sandbox._now = 143100 + 36000;
    handlers.ping();
    expect(jitterSamples()).toBe(3);
    expect(ctx.payloads.filter((p) => p.event === 'missed_ping')).toHaveLength(2);
    ctx.sandbox._now += (35050 * 2) + 100;
    handlers.ping();
    expect(ctx.payloads.filter((p) => p.event === 'missed_ping')).toHaveLength(3);
    expect(jitterSamples()).toBe(4);
  });

  it('wraps an io that already exists at install time', () => {
    const calls = [];
    const ctx = runTelemetry((sandbox, socket) => {
      sandbox.game = undefined;
      function lookup() { calls.push(1); return socket; }
      lookup.connect = lookup;
      sandbox.io = lookup;
    });
    vm.runInContext('io({})', ctx.sandbox);
    expect(calls).toHaveLength(1);
    expect(typeof ctx.engineHandlers.packet).toBe('function');
  });

  it('counts http protocol names as numbers and does not copy the resource name', () => {
    const ctx = runTelemetry((sandbox) => {
      sandbox._resources = [
        {
          initiatorType: 'script',
          nextHopProtocol: 'http/1.1',
          transferSize: 10,
          encodedBodySize: 10,
          decodedBodySize: 10,
          duration: 1,
          startTime: 0,
          responseEnd: 1,
          name: 'http://cdn.example/a.js',
        },
        {
          initiatorType: 'script',
          nextHopProtocol: 'h2',
          transferSize: 10,
          encodedBodySize: 10,
          decodedBodySize: 10,
          duration: 1,
          startTime: 0,
          responseEnd: 1,
        },
        {
          initiatorType: 'font',
          nextHopProtocol: 'http/1.1',
          transferSize: 10,
          encodedBodySize: 10,
          decodedBodySize: 10,
          duration: 1,
          startTime: 0,
          responseEnd: 1,
        },
      ];
    });
    const xfer = ctx.payloads.find((p) => p.type === 'transfers');
    expect(xfer.protocolH1).toBe(2);
    expect(xfer.protocolH2).toBe(1);
    expect(xfer.scriptH1).toBe(1);
    expect(JSON.stringify(xfer)).not.toContain('cdn.example');
    expect(JSON.stringify(xfer)).not.toContain('http://');
  });

  it('sends package ids and versions on init and replaces unsafe tokens', () => {
    const ctx = runTelemetry((sandbox) => {
      sandbox.game.version = 'https://evil.example/foundry';
      sandbox.game.release = { version: 'https://evil.example/foundry', generation: 13 };
      sandbox.game.system = { id: 'dnd5e', version: '3.1.0', title: 'SECRET' };
      sandbox.game.modules = {
        forEach(fn) {
          fn({ id: 'ok-mod', version: '1.0.0+build', active: true, title: 'SECRET' });
          fn({ id: 'https://evil.example/m', version: '1', active: true });
        },
      };
    });
    ctx.hooks.init();
    const init = ctx.payloads.find((p) => p.type === 'phase' && p.name === 'init');
    expect(init.packages).toEqual({
      view: 'game',
      foundryVersion: '?',
      system: { id: 'dnd5e', version: '3.1.0' },
      modules: [
        { id: 'ok-mod', version: '1.0.0+build' },
        { id: '?', version: '1' },
      ],
    });
    expect(JSON.stringify(init)).not.toContain('http');
    expect(JSON.stringify(init)).not.toContain('SECRET');
    expect(JSON.stringify(init)).not.toContain('evil');
  });

  it('prefers the server manifest in game.data and honours core.moduleConfiguration', () => {
    const ctx = runTelemetry((sandbox) => {
      // game.modules is deliberately out of step (as it is mid-init on a real
      // page) to prove the payload does not depend on it.
      sandbox.game.modules = { forEach(fn) { fn({ id: 'late-virtual', version: '0.0.1', active: true }); } };
      sandbox.game.data = {
        world: { coreVersion: '13.351', title: 'SECRET_WORLD' },
        system: { id: 'dnd5e', version: '5.3.3', title: 'SECRET' },
        modules: [
          { id: 'zeta', version: '2.0.0', title: 'SECRET' },
          { id: 'alpha', version: '1.0.0' },
          { id: 'disabled-mod', version: '9.9.9' },
          { id: 'https://evil.example/x', version: '1' },
        ],
        settings: [
          { key: 'core.other', value: '{}' },
          { key: 'core.moduleConfiguration', value: JSON.stringify({ zeta: true, alpha: true, 'disabled-mod': false }) },
        ],
      };
    });
    ctx.hooks.init();
    const init = ctx.payloads.find((p) => p.type === 'phase' && p.name === 'init');
    expect(init.packages).toEqual({
      view: 'game',
      foundryVersion: '13.351',
      system: { id: 'dnd5e', version: '5.3.3' },
      modules: [
        { id: 'zeta', version: '2.0.0' },
        { id: 'alpha', version: '1.0.0' },
        { id: '?', version: '1' },
      ],
    });
    expect(JSON.stringify(init)).not.toContain('SECRET');
    expect(JSON.stringify(init)).not.toContain('evil');
  });

  it('marks the login page view so main ignores its empty package set', () => {
    const ctx = runTelemetry((sandbox) => {
      sandbox.game.view = 'join';
      sandbox.game.system = undefined;
      sandbox.game.modules = { forEach() {} };
    });
    ctx.hooks.init();
    const init = ctx.payloads.find((p) => p.type === 'phase' && p.name === 'init');
    expect(init.packages.view).toBe('join');
    expect(init.packages.modules).toEqual([]);
    expect(init.packages.system.id).toBe('?');
  });

  it('counts cache hits and revalidations and measures on-wire busy time', () => {
    const ctx = runTelemetry((sandbox) => {
      sandbox._resources = [
        { initiatorType: 'script', transferSize: 0, encodedBodySize: 500, decodedBodySize: 900, duration: 10, startTime: 0, responseEnd: 10 },
        { initiatorType: 'script', transferSize: 310, encodedBodySize: 50000, decodedBodySize: 90000, duration: 15, startTime: 5, responseEnd: 20 },
        { initiatorType: 'img', transferSize: 70000, encodedBodySize: 69000, decodedBodySize: 69000, duration: 5, startTime: 30, responseEnd: 35 },
        { initiatorType: 'img', deliveryType: 'cache', transferSize: 0, encodedBodySize: 0, decodedBodySize: 0, duration: 1, startTime: 40, responseEnd: 41 },
      ];
    });
    const xfer = ctx.payloads.find((p) => p.type === 'transfers');
    expect(xfer.requests).toBe(4);
    expect(xfer.cachedRequests).toBe(3);
    expect(xfer.revalidatedRequests).toBe(1);
    expect(xfer.byType.script.cachedRequests).toBe(2);
    expect(xfer.byType.img.cachedRequests).toBe(1);
    expect(xfer.busyMs).toBe(26);
    expect(xfer.durationMs).toBe(31);
  });

  it('attributes long tasks to the join phase they started in, from install', () => {
    const ctx = runTelemetry();
    ctx.fireLongTask(50, 900);
    ctx.sandbox._now = 1500;
    ctx.hooks.init();
    ctx.fireLongTask(80, 1600);
    ctx.fireLongTask(30, 1700);
    ctx.sandbox._now = 2000;
    ctx.hooks.i18nInit();
    ctx.hooks.setup();
    ctx.hooks.canvasReady();
    ctx.sandbox.game.ready = true;
    ctx.hooks.ready();
    const ready = ctx.payloads.find((p) => p.type === 'phase' && p.name === 'ready');
    expect(ready.longTasks).toEqual({
      count: 3,
      worstMs: 80,
      totalMs: 160,
      byPhase: { 'pre-init': 50, init: 110 },
    });
    // Starting sampling later keeps the history rather than resetting it.
    ctx.sandbox.__flcTelemetry.start(5000);
    ctx.fireInterval();
    const sample = ctx.payloads.filter((p) => p.type === 'sample').pop();
    expect(sample.longTasks.count).toBe(3);
  });

  it('emits already-fired hooks as late and no-ops without a bridge', () => {
    const late = runTelemetry((sandbox) => {
      sandbox.game.ready = true;
      sandbox.canvas.ready = true;
    });
    expect(late.onceNames).toEqual([]);
    const lateNames = late.payloads
      .filter((p) => p.type === 'phase' && p.late)
      .map((p) => p.name)
      .sort();
    expect(lateNames).toEqual(['canvasReady', 'i18nInit', 'init', 'ready', 'setup']);
    expect(JSON.stringify(late.payloads)).not.toContain('SECRET');
    expect(JSON.stringify(late.payloads)).not.toContain('http');

    expect(() => runTelemetry((sandbox) => {
      sandbox.flcGame = undefined;
    })).not.toThrow();
  });

  it('measures collection sizes in idle slices and does not emit document text', () => {
    const idle = [];
    const timers = [];
    const ctx = runTelemetry((sandbox) => {
      const origTimeout = sandbox.setTimeout;
      sandbox.setTimeout = (fn, ms) => {
        timers.push({ fn, ms });
        return origTimeout(fn, ms);
      };
      sandbox.requestIdleCallback = (fn) => {
        idle.push(fn);
        return idle.length;
      };
      const docs = [];
      for (let i = 0; i < 60; i += 1) docs.push({ _source: { n: i } });
      docs.push({ toObject() { throw new Error('SECRET_BOOM'); } });
      sandbox.game.actors = { size: docs.length, contents: docs };
    });
    ctx.hooks.ready();
    const start = timers.filter((timer) => timer.ms === 3000).pop();
    expect(start).toBeTruthy();
    start.fn();
    expect(idle).toHaveLength(1);
    idle[0]({ timeRemaining() { return 40; } });
    expect(ctx.payloads.filter((payload) => payload.type === 'worldSizes')).toHaveLength(0);
    idle[idle.length - 1]({ timeRemaining() { return 40; } });
    const sizes = ctx.payloads.filter((payload) => payload.type === 'worldSizes');
    let expected = 0;
    for (let i = 0; i < 60; i += 1) expected += JSON.stringify({ n: i }).length;
    expect(sizes[0].sizes.actors).toBe(expected);
    expect(sizes[0].complete).toBe(false);
    expect(sizes[sizes.length - 1].complete).toBe(true);
    expect(sizes[sizes.length - 1].sizes.messages).toBe(0);
    expect(sizes[sizes.length - 1].sizes.packs).toBeUndefined();
    expect(JSON.stringify(sizes)).not.toContain('SECRET');
  });

  it('counts cache reads separately from revalidations', () => {
    const ctx = runTelemetry((sandbox) => {
      sandbox._resources = [
        { initiatorType: 'script', deliveryType: 'cache', transferSize: 0, decodedBodySize: 1000, duration: 2500, startTime: 0, fetchStart: 0, responseStart: 100, responseEnd: 450 },
        { initiatorType: 'script', deliveryType: 'cache', transferSize: 0, decodedBodySize: 2 * 1024 * 1024, duration: 400, startTime: 0, responseStart: 0, responseEnd: 400 },
        { initiatorType: 'script', deliveryType: 'cache', transferSize: 0, decodedBodySize: 800, duration: 2539, startTime: 10, fetchStart: 10, requestStart: 0, responseStart: 0, responseEnd: 2549 },
        { initiatorType: 'script', deliveryType: 'cache', transferSize: 0, decodedBodySize: 900, duration: 2600, startTime: 0, fetchStart: 2500, responseStart: 2520, responseEnd: 2540 },
        { initiatorType: 'script', transferSize: 100, encodedBodySize: 5000, decodedBodySize: 5000, duration: 800, startTime: 0, responseEnd: 800 },
      ];
    });
    const xfer = ctx.payloads.find((payload) => payload.type === 'transfers');
    expect(xfer.cacheReadBytes).toBe(1000 + 2 * 1024 * 1024 + 800 + 900);
    expect(xfer.cacheReadMs).toBe(370);
    expect(xfer.cacheReadSlow).toBe(1);
    expect(xfer.cacheReadP95Ms).toBe(333.5);
    expect(xfer.revalidatedRequests).toBe(1);
  });

  it('samples the last request and inbound messages without the payload body', () => {
    const sent = [];
    const ctx = runTelemetry((sandbox, socket) => {
      socket.emit = function emit(...args) {
        sent.push(args);
        return this;
      };
    });
    ctx.sandbox.game.ready = true;
    ctx.hooks.ready();
    ctx.sandbox._now = 10000;
    ctx.socket.emit('modifyDocument', { secret: 'SECRET_DOC' }, () => {});
    ctx.sandbox._now = 10083;
    sent[0][2]();
    ctx.engineHandlers.packet({ data: 'abc' });
    ctx.sandbox.__flcTelemetry.start(5000);
    ctx.fireInterval();
    const sample = ctx.payloads.filter((payload) => payload.type === 'sample').pop();
    expect(sample.lastRequestName).toBe('modifyDocument');
    expect(sample.lastRequestMs).toBe(83);
    expect(sample.lastRequestAgeMs).toBe(83);
    expect(sample.requestsOut).toBe(1);
    expect(sample.messagesIn).toBeGreaterThan(0);
    expect(sample.lastMessageAgeMs).toBe(0);
    expect(JSON.stringify(sample)).not.toContain('SECRET');
    ctx.sandbox._now = 12000;
    ctx.socket.emit('https://secret.example/a', 1);
    ctx.fireInterval();
    const next = ctx.payloads.filter((payload) => payload.type === 'sample').pop();
    expect(next.lastRequestName).toBe('other');
    expect(next.lastRequestMs).toBeUndefined();
    expect(next.requestsOut).toBe(2);
    expect(JSON.stringify(next)).not.toContain('secret.example');
  });

  it('times hook callbacks by package until ready and keeps off working', () => {
    const registered = [];
    let seq = 1;
    const offArgs = [];
    const ctx = runTelemetry((sandbox) => {
      sandbox._stack = 'Error\n    at go (https://game.example/modules/chris-premades/scripts/a.js:1:1)';
      sandbox.Error = function Error() {
        this.stack = sandbox._stack || '';
      };
      sandbox.Hooks = {
        on(hook, fn) {
          const id = seq;
          seq += 1;
          registered.push({ id, hook, fn });
          return id;
        },
        once(hook, fn) {
          const id = seq;
          seq += 1;
          registered.push({ id, hook, fn, once: true });
          return id;
        },
        off(hook, fnOrId) {
          offArgs.push(fnOrId);
          for (let i = registered.length - 1; i >= 0; i -= 1) {
            const row = registered[i];
            if (row.hook !== hook) continue;
            if (row.id === fnOrId || row.fn === fnOrId) registered.splice(i, 1);
          }
        },
      };
      sandbox._offArgs = offArgs;
    });

    function call(hook) {
      registered.filter((row) => row.hook === hook).forEach((row) => row.fn());
    }

    const during = [];
    const fn = function pkgFn() {
      during.push(ctx.sandbox.__flcTelemetry.active());
      ctx.sandbox._now += 25;
    };
    const id = ctx.sandbox.Hooks.on('setup', fn);
    expect(typeof id).toBe('number');
    call('setup');
    call('setup');
    expect(during).toEqual([
      { package: 'chris-premades', hook: 'setup' },
      { package: 'chris-premades', hook: 'setup' },
    ]);
    ctx.sandbox.Hooks.off('setup', id);
    expect(offArgs[0]).toBe(id);
    expect(registered.some((row) => row.id === id)).toBe(false);

    const onceFn = function onceFn() { ctx.sandbox._now += 10; };
    ctx.sandbox._stack = 'Error\n    at go (https://game.example/systems/dnd5e/dnd5e.js:2:2)';
    ctx.sandbox.Hooks.once('canvasInit', onceFn);
    ctx.sandbox.Hooks.off('canvasInit', onceFn);
    expect(typeof offArgs[1]).toBe('function');
    expect(offArgs[1]).not.toBe(onceFn);
    expect(registered.some((row) => row.fn === offArgs[1])).toBe(false);

    let afterReady = null;
    ctx.sandbox._stack = 'Error\n    at go (https://game.example/modules/bad id/a.js:1:1)';
    const otherFn = function otherFn() {
      afterReady = ctx.sandbox.__flcTelemetry.active();
      ctx.sandbox._now += 5;
    };
    ctx.sandbox.Hooks.on('i18nInit', otherFn);
    call('i18nInit');
    expect(afterReady).toEqual({ package: 'other', hook: 'i18nInit' });

    const ready = registered.find((row) => row.hook === 'ready');
    ready.fn();
    const hooks = ctx.payloads.find((p) => p.type === 'phase' && p.name === 'ready').hooks;
    expect(hooks).toEqual({
      byPackage: [
        { id: 'chris-premades', ms: 50, count: 2 },
        { id: 'other', ms: 5, count: 1 },
      ],
      totalMs: 55,
      packages: 2,
    });
    afterReady = { package: 'stale', hook: 'stale' };
    call('i18nInit');
    expect(afterReady).toEqual({ package: null, hook: null });
    const dumped = JSON.stringify(ctx.payloads);
    expect(dumped).not.toContain('https://');
    expect(dumped).not.toContain('scripts/a.js');
    expect(dumped).not.toContain('bad id');
  });

  it('advances the join step and reports a loading package without its path', () => {
    const ctx = runTelemetry((sandbox) => {
      sandbox.document = {
        readyState: 'loading',
        hidden: false,
        addEventListener(type, fn) {
          sandbox._dom = sandbox._dom || {};
          sandbox._dom[type] = fn;
        },
      };
      sandbox._resources = [{
        name: 'https://cdn.example/systems/dnd5e/dnd5e.css',
        initiatorType: 'link',
        transferSize: 20,
        encodedBodySize: 20,
        decodedBodySize: 20,
        duration: 3,
        startTime: 1,
        requestStart: 1,
        responseStart: 2,
        responseEnd: 4,
      }, {
        name: 'https://cdn.example/modules/ignore-me/icon.png',
        initiatorType: 'img',
        transferSize: 20,
        encodedBodySize: 20,
        decodedBodySize: 20,
        duration: 3,
        startTime: 1,
        requestStart: 1,
        responseStart: 2,
        responseEnd: 4,
      }];
    });
    expect(ctx.sandbox.__flcTelemetry.step()).toEqual({ index: 1, total: 8, name: 'connecting' });
    expect(ctx.sandbox.__flcTelemetry.active()).toEqual({ package: 'dnd5e', hook: null });
    ctx.sandbox._dom.DOMContentLoaded();
    expect(ctx.sandbox.__flcTelemetry.step()).toEqual({ index: 2, total: 8, name: 'loading page' });
    ctx.socketHandlers.connect();
    expect(ctx.sandbox.__flcTelemetry.step().index).toBe(2);
    ctx.engineHandlers.packet({ data: 'x'.repeat(262145) });
    expect(ctx.sandbox.__flcTelemetry.step()).toEqual({ index: 3, total: 8, name: 'receiving world data' });
    ctx.hooks.init();
    expect(ctx.sandbox.__flcTelemetry.step()).toEqual({ index: 4, total: 8, name: 'initializing' });
    ctx.hooks.i18nInit();
    expect(ctx.sandbox.__flcTelemetry.step()).toEqual({ index: 5, total: 8, name: 'loading languages' });
    ctx.hooks.setup();
    expect(ctx.sandbox.__flcTelemetry.step()).toEqual({ index: 6, total: 8, name: 'setting up world' });
    ctx.hooks.canvasReady();
    expect(ctx.sandbox.__flcTelemetry.step()).toEqual({ index: 7, total: 8, name: 'drawing scene' });
    ctx.hooks.ready();
    expect(ctx.sandbox.__flcTelemetry.step()).toEqual({ index: 8, total: 8, name: 'ready' });
    expect(ctx.sandbox.__flcTelemetry.active()).toEqual({ package: null, hook: null });
    const dumped = JSON.stringify(ctx.payloads);
    expect(dumped).not.toContain('https://');
    expect(dumped).not.toContain('dnd5e.css');
    expect(dumped).not.toContain('cdn.example');
    expect(dumped).not.toContain('ignore-me');
  });

  it('emits a numeric progress snapshot every 250 ms until ready', () => {
    const ticks = [];
    const ctx = runTelemetry((sandbox) => {
      const orig = sandbox.setTimeout;
      sandbox.setTimeout = (fn, ms) => {
        if (ms === 250) {
          ticks.push(fn);
          return 250;
        }
        return orig(fn, ms);
      };
      sandbox.canvas = {
        ready: false,
        performance: { mode: 2 },
        app: { ticker: { FPS: 60 } },
        scene: { tokens: { size: 1 }, tiles: { size: 0 }, lights: { size: 0 }, walls: { size: 0 } },
        loadTexturesTask: { loaded: 3, total: 12 },
      };
    });
    expect(ticks.length).toBe(1);
    ticks[0]();
    const progress = ctx.payloads.filter((p) => p.type === 'progress');
    expect(progress).toHaveLength(1);
    expect(progress[0]).toMatchObject({
      requests: 1,
      cachedRequests: 0,
      docs: 40,
      packages: 0,
      packagesTotal: 1,
      textures: 3,
      texturesTotal: 12,
    });
    expect(Object.keys(progress[0]).sort()).toEqual([
      'at', 'cachedRequests', 'docs', 'packages', 'packagesTotal', 'requests', 'textures', 'texturesTotal', 'type',
    ]);
    expect(JSON.stringify(progress[0])).not.toContain('http');
    expect(JSON.stringify(progress[0])).not.toContain('dice');
    ctx.hooks.ready();
    ticks[0]();
    expect(ctx.payloads.filter((p) => p.type === 'progress')).toHaveLength(1);
    const src = buildTelemetryScript();
    expect(src).not.toMatch(/=>/);
    expect(src).not.toMatch(/\blet\s/);
    expect(src).not.toMatch(/\bconst\s/);
    expect(() => new Function(src)).not.toThrow();
  });
});

describe('buildLoadingDetailsScript', () => {
  it('guards install and points Details at openStats', () => {
    const src = buildLoadingDetailsScript();
    expect(src).toContain('openStats');
    expect(src).toContain('Details');
    expect(src).toContain('margin-left:0.75em;cursor:pointer;opacity:0.7');
    expect(src).toContain('Show join details');
    expect(src).toContain('__flcLoadingDetails');
    expect(src).toContain('setJoin');
    expect(src).toContain('data-flc-join-clock');
    expect(src).toContain('font-variant-numeric:tabular-nums');
    expect(src).toContain('first join here, no estimate yet');
    expect(src).toContain('a bit longer than usual');
    expect(src).toContain('slower than usual');
    expect(src).toContain('Startup is taking longer');
    expect(src).toContain('900000');
    expect(src).toContain('MutationObserver');
    expect(src).not.toContain('document.title');
    expect(src).not.toContain('.href');
    expect(src).not.toContain('location.');
    expect(src).not.toContain('http');
    expect(src).not.toMatch(/=>/);
    expect(src).not.toMatch(/\blet\s/);
    expect(src).not.toMatch(/\bconst\s/);
    expect(() => new Function(src)).not.toThrow();
  });

  it('inserts Details and a join clock and does not read text back out', () => {
    function makeEl() {
      return {
        className: '',
        id: '',
        textContent: '',
        parentElement: null,
        parentNode: null,
        nextSibling: null,
        attrs: {},
        children: [],
        listeners: {},
        setAttribute(k, v) {
          this.attrs[k] = v;
        },
        getAttribute(k) {
          return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
        },
        addEventListener(type, fn) {
          this.listeners[type] = fn;
        },
        querySelector(sel) {
          if (sel === '[data-flc-details]') {
            return this.children.find((child) => child.attrs && child.attrs['data-flc-details']) || null;
          }
          return null;
        },
        appendChild(node) {
          node.parentNode = this;
          node.parentElement = this;
          this.children.push(node);
        },
        insertBefore(node) {
          this.appendChild(node);
        },
      };
    }

    const body = makeEl();
    const overlay = makeEl();
    overlay.className = 'loading-overlay';
    overlay.parentElement = body;
    overlay.parentNode = body;
    const hide = makeEl();
    hide.textContent = ' Hide ';
    hide.parentElement = overlay;
    hide.parentNode = overlay;
    const created = [];
    let observed = null;
    let timeoutMs = 0;
    let intervalMs = 0;
    let disconnected = false;
    let opened = 0;
    const sandbox = {
      document: {
        body,
        querySelectorAll() {
          return [hide];
        },
        createElement() {
          const el = makeEl();
          created.push(el);
          return el;
        },
      },
      flcGame: {
        openStats() {
          opened += 1;
        },
      },
      MutationObserver: function MutationObserver(cb) {
        this.cb = cb;
      },
      setTimeout(fn, ms) {
        timeoutMs = ms;
        return 4;
      },
      clearTimeout() {},
      setInterval(fn, ms) {
        intervalMs = ms;
        return 9;
      },
      clearInterval() {},
    };
    sandbox.MutationObserver.prototype.observe = function observe(target, opts) {
      observed = { target, opts };
    };
    sandbox.MutationObserver.prototype.disconnect = function disconnect() {
      disconnected = true;
    };
    sandbox.window = sandbox;
    const script = buildLoadingDetailsScript();
    vm.createContext(sandbox);
    vm.runInContext(script, sandbox);
    vm.runInContext(script, sandbox);

    expect(created).toHaveLength(2);
    expect(overlay.children).toHaveLength(2);
    expect(overlay.children[0].textContent).toBe('Details');
    expect(overlay.children[0].attrs['data-flc-details']).toBe('1');
    expect(overlay.children[0].attrs.style).toBe('margin-left:0.75em;cursor:pointer;opacity:0.7');
    expect(overlay.children[0].attrs.title).toBe('Show join details');
    expect(overlay.children[0].title).toBe('Show join details');
    expect(overlay.children[1].attrs['data-flc-join-clock']).toBe('1');
    expect(overlay.children[1].attrs.style).toBe('margin-left:0.75em;opacity:0.7;font-variant-numeric:tabular-nums');
    expect(overlay.children[1].textContent).toBe('0:00 \u00b7 first join here, no estimate yet');
    expect(timeoutMs).toBe(900000);
    expect(intervalMs).toBe(1000);
    expect(observed.opts).toEqual({ childList: true, characterData: true, subtree: true });
    expect(disconnected).toBe(true);
    expect(sandbox.__flcLoadingDetails.version).toBe(1);
    expect(typeof sandbox.__flcLoadingDetails.setJoin).toBe('function');
    overlay.children[0].listeners.click({ preventDefault() {} });
    expect(opened).toBe(1);
    expect(JSON.stringify(overlay.children[0].attrs)).not.toContain('http');
  });

  const CANNED = 'Startup is taking longer than expected. You can hide this overlay and check the browser console for errors.';

  function relink(parent) {
    for (let i = 0; i < parent.children.length; i += 1) {
      const child = parent.children[i];
      child.parentNode = parent;
      child.parentElement = parent;
      child.nextSibling = parent.children[i + 1] || null;
    }
  }

  function querySel(root, sel) {
    const want = sel === '[data-flc-details]'
      ? 'data-flc-details'
      : (sel === '[data-flc-join-clock]' ? 'data-flc-join-clock' : '');
    if (!want) return null;
    const stack = root.children.slice();
    while (stack.length) {
      const el = stack.shift();
      if (el.attrs && el.attrs[want]) return el;
      if (el.children && el.children.length) stack.push(...el.children);
    }
    return null;
  }

  function makeEl() {
    const el = {
      className: '',
      id: '',
      _text: '',
      parentElement: null,
      parentNode: null,
      nextSibling: null,
      attrs: {},
      children: [],
      listeners: {},
      onText: null,
      setAttribute(k, v) {
        this.attrs[k] = v;
      },
      getAttribute(k) {
        return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null;
      },
      addEventListener(type, fn) {
        this.listeners[type] = fn;
      },
      querySelector(sel) {
        return querySel(this, sel);
      },
      appendChild(node) {
        this.insertBefore(node, null);
      },
      insertBefore(node, ref) {
        if (node && node.parentNode && node.parentNode.children) {
          const old = node.parentNode.children.indexOf(node);
          if (old >= 0) node.parentNode.children.splice(old, 1);
          relink(node.parentNode);
        }
        const at = ref ? this.children.indexOf(ref) : -1;
        if (at >= 0) this.children.splice(at, 0, node);
        else this.children.push(node);
        relink(this);
      },
    };
    Object.defineProperty(el, 'textContent', {
      configurable: true,
      enumerable: true,
      get() {
        return el._text;
      },
      set(v) {
        el._text = v == null ? '' : String(v);
        if (typeof el.onText === 'function') el.onText();
      },
    });
    return el;
  }

  function runDetails(opts) {
    const options = opts || {};
    const created = [];
    const timers = [];
    const observers = [];
    const observations = [];
    const payloads = [];
    const controls = [];
    let seq = 1;
    let opened = 0;
    const body = makeEl();
    const overlay = makeEl();
    overlay.className = 'loading-overlay';
    overlay.id = 'fvtt-loading-progress';
    const row = makeEl();
    const detail = makeEl();
    detail.className = 'flp-detail';
    detail.textContent = options.detailText == null ? '' : options.detailText;
    const meta = makeEl();
    meta.className = 'flp-meta';
    meta.textContent = 'http://cdn.example/pack.js';
    meta.attrs.title = 'SECRET_TITLE';
    const hide = makeEl();
    hide.textContent = ' Hide ';
    const stray = makeEl();
    stray.textContent = 'Hide';
    const decoy = makeEl();
    decoy.textContent = 'Cancel';
    body.appendChild(overlay);
    body.appendChild(stray);
    body.appendChild(decoy);
    overlay.appendChild(row);
    row.appendChild(detail);
    overlay.appendChild(meta);
    overlay.appendChild(hide);
    controls.push(stray, decoy);
    if (options.hide !== false) controls.push(hide);

    function MutationObserver(cb) {
      this.cb = cb;
      this.disconnected = false;
      this.target = null;
      this.opts = null;
      observers.push(this);
    }
    MutationObserver.prototype.observe = function observe(target, observeOpts) {
      this.target = target;
      this.opts = observeOpts;
      observations.push({ target, opts: observeOpts });
    };
    MutationObserver.prototype.disconnect = function disconnect() {
      this.disconnected = true;
    };

    const sandbox = {
      _now: Number.isFinite(options.now) ? options.now : 0,
      document: {
        body,
        querySelectorAll(sel) {
          if (sel === 'a, button') return controls.slice();
          return [];
        },
        createElement() {
          const el = makeEl();
          created.push(el);
          return el;
        },
      },
      flcGame: {
        openStats() {
          opened += 1;
        },
        telemetry(payload) {
          payloads.push(JSON.parse(JSON.stringify(payload)));
        },
      },
      MutationObserver,
      setTimeout(fn, ms) {
        const id = seq;
        seq += 1;
        timers.push({ id, fn, ms, kind: 'timeout', cleared: false });
        return id;
      },
      clearTimeout(id) {
        const t = timers.find((item) => item.id === id);
        if (t) t.cleared = true;
      },
      setInterval(fn, ms) {
        const id = seq;
        seq += 1;
        timers.push({ id, fn, ms, kind: 'interval', cleared: false });
        return id;
      },
      clearInterval(id) {
        const t = timers.find((item) => item.id === id);
        if (t) t.cleared = true;
      },
    };
    sandbox.performance = {
      now() {
        return sandbox._now;
      },
    };
    sandbox.window = sandbox;
    const script = buildLoadingDetailsScript();
    vm.createContext(sandbox);
    vm.runInContext(script, sandbox);
    vm.runInContext(script, sandbox);

    function live(kind, ms) {
      return timers.filter((item) => item.kind === kind && !item.cleared && (ms == null || item.ms === ms)).pop() || null;
    }

    return {
      sandbox,
      script,
      body,
      overlay,
      detail,
      meta,
      hide,
      controls,
      created,
      timers,
      observers,
      observations,
      payloads,
      opened: () => opened,
      clock() {
        return querySel(overlay, '[data-flc-join-clock]');
      },
      details() {
        return querySel(overlay, '[data-flc-details]');
      },
      interval() {
        return live('interval');
      },
      fireInterval() {
        const t = live('interval');
        if (t) t.fn();
      },
      fireTimeout(ms) {
        const t = live('timeout', ms);
        if (t) t.fn();
      },
      fireBody() {
        observers.forEach((obs) => {
          if (!obs.disconnected && obs.target === body && typeof obs.cb === 'function') obs.cb();
        });
      },
      fireOverlay() {
        observers.forEach((obs) => {
          if (!obs.disconnected && obs.target === overlay && typeof obs.cb === 'function') obs.cb();
        });
      },
    };
  }

  it('setJoin accepts numbers only and formats the clock from history', () => {
    const ctx = runDetails({ hide: false, detailText: 'Loading packages', now: 100000 });
    const api = ctx.sandbox.__flcLoadingDetails;
    expect(ctx.clock()).toBeNull();
    expect(() => api.setJoin()).not.toThrow();
    api.setJoin('42000', '60000', '2');
    api.setJoin(Number.NaN, Number.NaN, Number.NaN);
    api.setJoin(Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY, Number.POSITIVE_INFINITY);
    api.setJoin(undefined, undefined, undefined);
    api.setJoin(42000, 60000, 2);
    ctx.controls.push(ctx.hide);
    ctx.fireBody();
    const clock = ctx.clock();
    const link = ctx.details();
    expect(link.textContent).toBe('Details');
    expect(clock.parentNode).toBe(ctx.hide.parentNode);
    expect(ctx.overlay.children.indexOf(link)).toBe(ctx.overlay.children.indexOf(ctx.hide) + 1);
    expect(ctx.overlay.children.indexOf(clock)).toBe(ctx.overlay.children.indexOf(link) + 1);
    expect(clock.attrs.style).toBe('margin-left:0.75em;opacity:0.7;font-variant-numeric:tabular-nums');
    expect(clock.textContent).toBe('0:42 \u00b7 usually ~1:00 \u00b7 about 20 s left');
    expect(ctx.detail.textContent).toBe('Loading packages');

    ctx.sandbox._now = 101000;
    api.setJoin(Number.NaN, 'nope', Number.POSITIVE_INFINITY);
    expect(clock.textContent).toBe('0:43 \u00b7 usually ~1:00 \u00b7 about 15 s left');
    api.setJoin(72000, 60000, 3);
    expect(clock.textContent).toBe('1:12 \u00b7 usually ~1:00 \u00b7 a bit longer than usual');
    api.setJoin(125000, 60000, 4);
    expect(clock.textContent).toBe('2:05 \u00b7 usually ~1:00 \u00b7 slower than usual');
    api.setJoin(107999, 60000, 1);
    expect(clock.textContent).toBe('1:48 \u00b7 usually ~1:00 \u00b7 a bit longer than usual');
    api.setJoin(108000, 60000, 1);
    expect(clock.textContent).toBe('1:48 \u00b7 usually ~1:00 \u00b7 slower than usual');
    api.setJoin(59000, 60000, 1);
    expect(clock.textContent).toBe('0:59 \u00b7 usually ~1:00 \u00b7 about 0 s left');
    api.setJoin(42000, 0, 1);
    expect(clock.textContent).toBe('0:42 \u00b7 first join here, no estimate yet');
    api.setJoin(42000, null, null);
    expect(clock.textContent).toBe('0:42 \u00b7 first join here, no estimate yet');
    api.setJoin(42000, 60000, 5);
    expect(clock.textContent).toBe('0:42 \u00b7 usually ~1:00 \u00b7 about 20 s left');

    const ticking = ctx.interval();
    expect(ticking.ms).toBe(1000);
    ctx.fireTimeout(60000);
    expect(ticking.cleared).toBe(false);
    ctx.sandbox._now = 104000;
    ticking.fn();
    expect(clock.textContent).toBe('0:45 \u00b7 usually ~1:00 \u00b7 about 15 s left');
    const same = ctx.sandbox.__flcLoadingDetails.setJoin;
    vm.runInContext(ctx.script, ctx.sandbox);
    expect(ctx.sandbox.__flcLoadingDetails.setJoin).toBe(same);
    expect(ctx.created).toHaveLength(2);
    expect(ctx.payloads).toEqual([]);
  });

  it('replaces the slow notice when the module writes it back', () => {
    const ctx = runDetails({
      hide: false,
      detailText: CANNED,
      now: 100000,
    });
    let writes = 0;
    ctx.detail.onText = () => {
      writes += 1;
      if (writes > 40) return;
      ctx.fireOverlay();
    };
    ctx.sandbox.__flcLoadingDetails.setJoin(48000, 60000, 3);
    ctx.controls.push(ctx.hide);
    ctx.fireBody();
    expect(ctx.detail.textContent).toBe('Still loading \u2014 0:48 so far; this server usually takes about 1:00.');
    expect(ctx.clock().textContent).toBe('0:48 \u00b7 usually ~1:00 \u00b7 about 10 s left');

    ctx.sandbox._now = 101000;
    ctx.fireInterval();
    expect(ctx.detail.textContent).toBe('Still loading \u2014 0:49 so far; this server usually takes about 1:00.');
    expect(ctx.clock().textContent).toBe('0:49 \u00b7 usually ~1:00 \u00b7 about 10 s left');

    ctx.detail.textContent = CANNED;
    expect(ctx.detail.textContent).toBe('Still loading \u2014 0:49 so far; this server usually takes about 1:00.');

    ctx.sandbox.__flcLoadingDetails.setJoin(125000, 60000, 4);
    expect(ctx.detail.textContent).toBe(
      'This join is slower than usual for this server (2:05 so far, usually about 1:00). Open Details for what is taking time.',
    );
    ctx.detail.textContent = 'Fetching 3 packages';
    expect(ctx.detail.textContent).toBe('Fetching 3 packages');
    ctx.detail.textContent = CANNED;
    expect(ctx.detail.textContent).toBe(
      'This join is slower than usual for this server (2:05 so far, usually about 1:00). Open Details for what is taking time.',
    );

    ctx.sandbox.__flcLoadingDetails.setJoin(48000, null, 0);
    expect(ctx.detail.textContent).toBe(
      'Still loading \u2014 0:48 so far. First join on this server; later joins will show an estimate.',
    );
    ctx.detail.textContent = 'Note: Startup is taking longer than expected.';
    expect(ctx.detail.textContent).toBe('Note: Startup is taking longer than expected.');
    ctx.detail.textContent = CANNED;
    expect(ctx.detail.textContent).toBe(
      'Still loading \u2014 0:48 so far. First join on this server; later joins will show an estimate.',
    );

    ctx.details().listeners.click({ preventDefault() {} });
    expect(ctx.opened()).toBe(1);
    expect(writes).toBeLessThan(20);
    expect(ctx.meta.textContent).toContain('http');
    expect(ctx.meta.attrs.title).toBe('SECRET_TITLE');
    const dumped = JSON.stringify(ctx.payloads);
    expect(dumped).not.toContain('http');
    expect(dumped).not.toContain('SECRET');
    expect(dumped).not.toContain('Startup');
    expect(dumped).not.toContain('Fetching');
    expect(ctx.payloads).toEqual([]);
    expect(ctx.clock().textContent).not.toContain('http');
    expect(ctx.detail.textContent).not.toContain('http');
  });

  it('stops ticking when the overlay gets a finished class', () => {
    const ctx = runDetails({ detailText: 'Loading packages', now: 100000 });
    ctx.sandbox.__flcLoadingDetails.setJoin(42000, 60000, 2);
    const clock = ctx.clock();
    expect(clock.textContent).toBe('0:42 \u00b7 usually ~1:00 \u00b7 about 20 s left');
    const ticking = ctx.interval();
    ctx.overlay.className = 'loading-overlay flp-finished';
    ctx.sandbox._now = 160000;
    ticking.fn();
    expect(ticking.cleared).toBe(true);
    expect(clock.textContent).toBe('0:42 \u00b7 usually ~1:00 \u00b7 about 20 s left');
    ctx.sandbox._now = 200000;
    ticking.fn();
    expect(clock.textContent).toBe('0:42 \u00b7 usually ~1:00 \u00b7 about 20 s left');
    expect(ctx.payloads).toEqual([]);
  });

  it('stops ticking when the overlay leaves or the lifetime ends', () => {
    const removed = runDetails({ now: 5000 });
    removed.sandbox.__flcLoadingDetails.setJoin(2000, 0, 0);
    const removedTick = removed.interval();
    const removedText = removed.clock().textContent;
    removed.overlay.parentNode = null;
    removed.overlay.parentElement = null;
    const at = removed.body.children.indexOf(removed.overlay);
    if (at >= 0) removed.body.children.splice(at, 1);
    removed.sandbox._now = 20000;
    removedTick.fn();
    expect(removedTick.cleared).toBe(true);
    expect(removed.clock().textContent).toBe(removedText);

    const detached = runDetails({ now: 5000 });
    detached.sandbox.__flcLoadingDetails.setJoin(2000, 0, 0);
    const detachedTick = detached.interval();
    const detachedText = detached.clock().textContent;
    const link = detached.details();
    link.parentNode = null;
    link.parentElement = null;
    detached.sandbox._now = 20000;
    detachedTick.fn();
    expect(detachedTick.cleared).toBe(true);
    expect(detached.clock().textContent).toBe(detachedText);

    const aged = runDetails({ now: 5000 });
    aged.sandbox.__flcLoadingDetails.setJoin(2000, 60000, 1);
    const agedTick = aged.interval();
    const agedText = aged.clock().textContent;
    aged.fireTimeout(900000);
    expect(agedTick.cleared).toBe(true);
    aged.sandbox._now = 30000;
    agedTick.fn();
    expect(aged.clock().textContent).toBe(agedText);
  });

  it('prefixes the clock with the join step and package id', () => {
    const ctx = runDetails({ now: 100000 });
    ctx.sandbox.__flcTelemetry = {
      step() {
        return { index: 6, total: 8, name: 'setting up world' };
      },
      active() {
        return { package: 'chris-premades', hook: 'setup' };
      },
    };
    ctx.sandbox.__flcLoadingDetails.setJoin(42000, 60000, 2);
    expect(ctx.clock().textContent).toBe(
      'Step 6/8 · setting up world · chris-premades · 0:42 · usually ~1:00 · about 20 s left',
    );
    ctx.sandbox.__flcTelemetry.active = function active() {
      return { package: null, hook: null };
    };
    ctx.sandbox.__flcLoadingDetails.setJoin(42000, 60000, 2);
    expect(ctx.clock().textContent).toBe(
      'Step 6/8 · setting up world · 0:42 · usually ~1:00 · about 20 s left',
    );
    ctx.sandbox.__flcTelemetry.active = function activeBad() {
      return { package: 'not a package', hook: 'setup' };
    };
    ctx.sandbox.__flcLoadingDetails.setJoin(42000, 0, 1);
    expect(ctx.clock().textContent).toBe(
      'Step 6/8 · setting up world · 0:42 · first join here, no estimate yet',
    );
  });
});

function lookupBag(docs) {
  return { contents: docs };
}

function runReferenceLookup(paths, game, page, href) {
  const sandbox = {
    URL,
    game,
    document: page || { querySelectorAll() { return []; } },
    location: { href: href || 'https://table.example/game' },
  };
  vm.createContext(sandbox);
  return vm.runInContext(buildReferenceLookupScript(paths), sandbox);
}

describe('buildReferenceLookupScript', () => {
  it('embeds paths as JSON and stays ES5', () => {
    const nasty = 'https://x.test/a");alert(1);/*.webp';
    const src = buildReferenceLookupScript([nasty, 'x'.repeat(2049), 12]);
    expect(src.startsWith('(function (paths) {')).toBe(true);
    expect(src.endsWith(`)(${JSON.stringify([nasty])})`)).toBe(true);
    expect(src).not.toMatch(/\b(const|let)\b/);
    expect(src).not.toContain('=>');
    expect(src).not.toContain('`');
    const empty = buildReferenceLookupScript([]);
    expect(empty.endsWith(')([])')).toBe(true);
    expect(() => new Function(`return ${empty}`)).not.toThrow();
  });

  it('matches decoded pathnames to documents and page elements', () => {
    const title = { textContent: '\n Actor Sheet \n' };
    const win = {
      className: 'app window-app',
      parentElement: null,
      querySelector(sel) { return sel === '.window-title' ? title : null; },
    };
    const img = {
      tagName: 'IMG',
      className: '',
      parentElement: win,
      getAttribute(name) { return name === 'src' ? '/assets/dom/portrait.webp' : null; },
      querySelector() { return null; },
    };
    const loose = {
      tagName: 'AUDIO',
      className: '',
      parentElement: null,
      getAttribute(name) { return name === 'src' ? '/assets/dom/loose.ogg' : null; },
      querySelector() { return null; },
    };
    const game = {
      scenes: lookupBag([
        {
          name: 'Cave',
          background: { src: '/assets/maps/cave.webp' },
          foreground: { src: 'https://table.example/assets/maps/fg.webp' },
          tokens: lookupBag([
            { name: 'Goblin', texture: { src: 'assets/tokens/goblin.webp' } },
          ]),
          tiles: lookupBag([
            { texture: { src: '/assets/tiles/rug.webp' } },
          ]),
          sounds: lookupBag([
            { path: '/assets/sounds/drip.ogg' },
          ]),
        },
        {
          name: 'Encoded',
          background: { src: '/assets/My Map.webp' },
          tokens: lookupBag([]),
          tiles: lookupBag([]),
          sounds: lookupBag([]),
        },
      ]),
      actors: lookupBag([{
        name: 'Hero',
        img: '/assets/actors/hero.webp',
        prototypeToken: { texture: { src: '/assets/tokens/hero-proto.webp' } },
        items: lookupBag([
          { name: 'Sword', img: '/assets/items/sword.webp' },
        ]),
      }]),
      items: lookupBag([
        { name: 'Potion', img: '/assets/items/potion.webp' },
      ]),
      journal: lookupBag([{
        name: 'Notes',
        pages: lookupBag([
          { name: 'Map', type: 'image', src: '/assets/journal/map.webp' },
          { name: 'Text', type: 'text', src: '/assets/journal/secret.webp' },
          { name: 'Clip', type: 'video', src: '/assets/journal/clip.webm' },
        ]),
      }]),
      playlists: lookupBag([{
        name: 'Tavern',
        sounds: lookupBag([
          { name: 'Lute', path: '/assets/music/lute.ogg' },
        ]),
      }]),
      macros: lookupBag([
        { name: 'Heal', img: '/assets/macros/heal.webp' },
      ]),
      users: lookupBag([
        { name: 'Chris', avatar: '/assets/avatars/chris.webp' },
      ]),
      cards: lookupBag([
        { name: 'Deck', img: '/assets/cards/deck.webp' },
      ]),
    };
    const paths = [
      'https://table.example/assets/maps/cave.webp',
      'https://table.example/assets/maps/fg.webp',
      'https://table.example/assets/tokens/goblin.webp',
      'https://table.example/assets/tiles/rug.webp',
      'https://table.example/assets/sounds/drip.ogg',
      'https://table.example/assets/My%20Map.webp?v=1',
      'https://table.example/assets/actors/hero.webp',
      'https://table.example/assets/tokens/hero-proto.webp',
      'https://table.example/assets/items/sword.webp',
      'https://table.example/assets/items/potion.webp',
      'https://table.example/assets/journal/map.webp',
      'https://table.example/assets/journal/secret.webp',
      'https://table.example/assets/journal/clip.webm',
      'https://table.example/assets/music/lute.ogg',
      'https://table.example/assets/macros/heal.webp',
      'https://table.example/assets/avatars/chris.webp',
      'https://table.example/assets/cards/deck.webp',
      'https://table.example/assets/dom/portrait.webp',
      'https://table.example/assets/dom/loose.ogg',
    ];
    const found = runReferenceLookup(paths, game, {
      querySelectorAll() { return [img, loose]; },
    });
    expect(Object.keys(found)).toEqual(paths.map((url) => failurePathname(url)));
    expect(found['/assets/maps/cave.webp']).toEqual(['Scene \u201cCave\u201d background']);
    expect(found['/assets/maps/fg.webp']).toEqual(['Scene \u201cCave\u201d foreground']);
    expect(found['/assets/tokens/goblin.webp']).toEqual(['Token \u201cGoblin\u201d on scene \u201cCave\u201d']);
    expect(found['/assets/tiles/rug.webp']).toEqual(['Tile on scene \u201cCave\u201d']);
    expect(found['/assets/sounds/drip.ogg']).toEqual(['Ambient sound on scene \u201cCave\u201d']);
    expect(found['/assets/My Map.webp']).toEqual(['Scene \u201cEncoded\u201d background']);
    expect(found['/assets/actors/hero.webp']).toEqual(['Actor \u201cHero\u201d image']);
    expect(found['/assets/tokens/hero-proto.webp']).toEqual(['Actor \u201cHero\u201d prototype token']);
    expect(found['/assets/items/sword.webp']).toEqual(['Item \u201cSword\u201d on actor \u201cHero\u201d']);
    expect(found['/assets/items/potion.webp']).toEqual(['Item \u201cPotion\u201d image']);
    expect(found['/assets/journal/map.webp']).toEqual(['Journal \u201cNotes\u201d page \u201cMap\u201d']);
    expect(found['/assets/journal/secret.webp']).toEqual([]);
    expect(found['/assets/journal/clip.webm']).toEqual(['Journal \u201cNotes\u201d page \u201cClip\u201d']);
    expect(found['/assets/music/lute.ogg']).toEqual(['Playlist \u201cTavern\u201d track \u201cLute\u201d']);
    expect(found['/assets/macros/heal.webp']).toEqual(['Macro \u201cHeal\u201d image']);
    expect(found['/assets/avatars/chris.webp']).toEqual(['User avatar']);
    expect(found['/assets/cards/deck.webp']).toEqual(['Cards \u201cDeck\u201d image']);
    expect(found['/assets/dom/portrait.webp']).toEqual(['img element in the page in window \u201cActor Sheet\u201d']);
    expect(found['/assets/dom/loose.ogg']).toEqual(['audio element in the page']);
  });

  it('keeps at most five references and stops a collection after 20000 documents', () => {
    const tokens = [];
    for (let i = 0; i < 6; i += 1) {
      tokens.push({ name: `T${i}`, texture: { src: '/same.webp' } });
    }
    const capped = runReferenceLookup(['https://table.example/same.webp'], {
      scenes: lookupBag([{
        name: 'S',
        tokens: lookupBag(tokens),
      }]),
    });
    expect(capped['/same.webp']).toHaveLength(5);
    expect(capped['/same.webp'][0]).toBe('Token \u201cT0\u201d on scene \u201cS\u201d');
    expect(capped['/same.webp'].some((row) => row.includes('T5'))).toBe(false);

    const many = [];
    for (let i = 0; i < 20001; i += 1) {
      let src = '';
      if (i === 19999) src = '/keep.webp';
      if (i === 20000) src = '/drop.webp';
      many.push({ name: `N${i}`, texture: { src } });
    }
    const limited = runReferenceLookup([
      'https://table.example/keep.webp',
      'https://table.example/drop.webp',
    ], {
      scenes: lookupBag([{ name: 'Big', tokens: lookupBag(many) }]),
    });
    expect(limited['/keep.webp']).toEqual(['Token \u201cN19999\u201d on scene \u201cBig\u201d']);
    expect(limited['/drop.webp']).toEqual([]);
  });

  it('returns an object when the page has no Foundry game', () => {
    const found = runReferenceLookup(['https://table.example/missing.webp'], undefined, {
      querySelectorAll() { return []; },
    });
    expect(found['/missing.webp']).toEqual([]);
    expect(runReferenceLookup(null, undefined, undefined)).toEqual({});
  });
});
