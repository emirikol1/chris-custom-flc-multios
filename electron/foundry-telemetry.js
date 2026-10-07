'use strict';

/**
 * Page-side join telemetry for the Foundry VTT renderer.
 * The telemetry and loading-details scripts are ES5 and report only counts,
 * timings, versions, and module/system ids. They never read URLs, titles,
 * names, or packet bodies.
 * buildReferenceLookupScript is separate: it runs only when the user opens
 * Bad URLs, and it may return document names. Callers must not log or store
 * that result.
 */

const TELEMETRY_VERSION = 1;

const TELEMETRY_SCRIPT = `(function () {
  var VERSION = __FLC_TELEMETRY_VERSION__;
  var timer = null;
  var pollN = 0;
  var hooksBound = false;
  var socketBound = false;
  var configSent = false;
  var worldDataSent = false;
  var setupSeen = false;
  var connectAt = 0;
  var lastPacketAt = 0;
  var largestBytes = 0;
  var largestAt = 0;
  var pingAt = 0;
  var slowDownloads = 0;
  var errorCount = 0;
  var rejectionCount = 0;
  var longObs = null;
  var seenPhase = {};
  var errorByName = {};
  var ttfbSamples = [];
  var downloadSamples = [];
  var byType = {};
  var totals = {
    requests: 0,
    transferBytes: 0,
    encodedBytes: 0,
    decodedBytes: 0,
    cachedRequests: 0,
    durationMs: 0
  };
  var longTasks = { count: 0, worstMs: 0, totalMs: 0, byPhase: {} };
  var phaseAt = {};
  var spans = [];
  var revalidated = 0;
  var protocolH1 = 0;
  var protocolH2 = 0;
  var scriptH1 = 0;
  var ioValue;
  var ioTrapped = false;
  var boundEngine = null;
  var pingTimes = [];
  var observedPingMs = 0;
  var lastAckEmitAt = 0;
  var readySeen = false;
  var pingJitterDevs = [];
  var prevPingAt = 0;
  var prevPingBlockedMs = 0;
  var lastJitterAt = -1;
  var cacheReadBytes = 0;
  var cacheReadMs = 0;
  var cacheReadSlow = 0;
  var cacheReadSamples = [];
  var lastRequestAt = 0;
  var lastRequestName = '';
  var lastRequestMs = null;
  var lastMessageAt = 0;
  var requestsOut = 0;
  var messagesIn = 0;
  var sizeScan = null;
  var SIZE_KEYS = ['actors', 'items', 'scenes', 'journal', 'tables', 'macros', 'playlists', 'cards', 'folders', 'users', 'messages'];

  function emit(payload) {
    try {
      var bridge = window.flcGame;
      if (!bridge || typeof bridge.telemetry !== 'function') return;
      bridge.telemetry(payload);
    } catch (e) {}
  }

  function nowMs() {
    try {
      var p = (typeof performance !== 'undefined' && performance) ? performance : window.performance;
      if (p && typeof p.now === 'function') {
        var n = p.now();
        if (typeof n === 'number' && isFinite(n)) return n;
      }
    } catch (e) {}
    return 0;
  }

  function num(v) {
    return (typeof v === 'number' && isFinite(v)) ? v : 0;
  }

  function pushSample(arr, value) {
    if (typeof value !== 'number' || !isFinite(value)) return;
    arr.push(value);
    if (arr.length > 500) arr.shift();
  }

  function percentile(values, p) {
    var nums = [];
    var i = 0;
    var rank = 0;
    var lo = 0;
    var hi = 0;
    var w = 0;
    for (i = 0; i < values.length; i++) {
      if (typeof values[i] === 'number' && isFinite(values[i])) nums.push(values[i]);
    }
    if (!nums.length || typeof p !== 'number' || !isFinite(p)) return null;
    nums.sort(function (a, b) { return a - b; });
    if (p < 0) p = 0;
    if (p > 100) p = 100;
    if (nums.length === 1) return nums[0];
    rank = (p / 100) * (nums.length - 1);
    lo = Math.floor(rank);
    hi = Math.ceil(rank);
    if (lo === hi) return nums[lo];
    w = rank - lo;
    return nums[lo] * (1 - w) + nums[hi] * w;
  }

  // Time the cache spent returning the body. Resource duration includes the
  // wait in the browser queue, which is long when a join requests hundreds of
  // files at once, so duration is not a disk measurement. Returns -1 when the
  // entry does not separate that wait from the read.
  function cacheServiceMs(rec) {
    var start = num(rec.startTime);
    var fetchStart = num(rec.fetchStart);
    var reqStart = num(rec.requestStart);
    var respStart = num(rec.responseStart);
    var respEnd = num(rec.responseEnd);
    if (respEnd > respStart && respStart > 0) return respEnd - respStart;
    if (respEnd > reqStart && reqStart > 0) return respEnd - reqStart;
    if (respEnd > fetchStart && fetchStart > start) return respEnd - fetchStart;
    return -1;
  }

  function bucket(initiatorType) {
    var t = typeof initiatorType === 'string' ? initiatorType : '';
    if (t === 'script') return 'script';
    if (t === 'link' || t === 'css') return 'link';
    if (t === 'img') return 'img';
    if (t === 'font') return 'font';
    if (t === 'fetch') return 'fetch';
    if (t === 'xmlhttprequest') return 'xmlhttprequest';
    return 'other';
  }

  function consumeResources(list) {
    var i = 0;
    var rec = null;
    var kind = '';
    var b = null;
    var transfer = 0;
    var encoded = 0;
    var decoded = 0;
    var dur = 0;
    var reqStart = 0;
    var respStart = 0;
    var respEnd = 0;
    var ttfb = null;
    var download = 0;
    if (!list || !list.length) return;
    for (i = 0; i < list.length; i++) {
      rec = list[i];
      if (!rec) continue;
      kind = bucket(rec.initiatorType);
      if (!byType[kind]) {
        byType[kind] = {
          requests: 0,
          transferBytes: 0,
          encodedBytes: 0,
          decodedBytes: 0,
          cachedRequests: 0,
          durationMs: 0
        };
      }
      b = byType[kind];
      transfer = num(rec.transferSize);
      encoded = num(rec.encodedBodySize);
      decoded = num(rec.decodedBodySize);
      dur = num(rec.duration);
      b.requests += 1;
      b.transferBytes += transfer;
      b.encodedBytes += encoded;
      b.decodedBytes += decoded;
      b.durationMs += dur;
      totals.requests += 1;
      totals.transferBytes += transfer;
      totals.encodedBytes += encoded;
      totals.decodedBytes += decoded;
      totals.durationMs += dur;
      // Cache hit: served from HTTP cache (deliveryType, Chromium 123+) or
      // nothing crossed the wire. A 304 revalidation moves only headers, so
      // transferSize is far below encodedBodySize; count it as cached too but
      // keep a separate tally because it still costs a round trip.
      if (rec.deliveryType === 'cache' || (transfer === 0 && decoded > 0)) {
        b.cachedRequests += 1;
        totals.cachedRequests += 1;
        cacheReadBytes += decoded;
        var service = cacheServiceMs(rec);
        if (service >= 0) {
          cacheReadMs += service;
          pushSample(cacheReadSamples, service);
          if (service > 250 && decoded < 1048576) cacheReadSlow += 1;
        }
      } else if (encoded > 0 && transfer > 0 && transfer < encoded) {
        b.cachedRequests += 1;
        totals.cachedRequests += 1;
        revalidated += 1;
      }
      if (spans.length < 4000) {
        var st = num(rec.startTime);
        var en = num(rec.responseEnd);
        if (en > st) spans.push([st, en]);
      }
      reqStart = num(rec.requestStart);
      respStart = num(rec.responseStart);
      respEnd = num(rec.responseEnd);
      ttfb = null;
      if (respStart > 0 && reqStart > 0) {
        ttfb = respStart - reqStart;
        pushSample(ttfbSamples, ttfb);
      }
      if (respEnd > 0 && respStart > 0) {
        download = respEnd - respStart;
        pushSample(downloadSamples, download);
        if (ttfb !== null && ttfb < 300 && download > 2000) slowDownloads += 1;
      }
      try {
        var hop = (typeof rec.nextHopProtocol === 'string') ? rec.nextHopProtocol : '';
        var h1 = hop.length === 8 && hop.charAt(0) === 'h' && hop.charAt(1) === 't' && hop.charAt(2) === 't' && hop.charAt(3) === 'p' && hop.charAt(4) === '/' && hop.charAt(5) === '1' && hop.charAt(6) === '.' && hop.charAt(7) === '1';
        if (h1) {
          protocolH1 += 1;
          if (kind === 'script') scriptH1 += 1;
        } else if (hop.length === 2 && hop.charAt(0) === 'h' && hop.charAt(1) === '2') {
          protocolH2 += 1;
        }
      } catch (eHop) {}
      try { noteLoadingPackage(rec, kind); } catch (ePack) {}
    }
  }

  function copyBuckets() {
    var out = {};
    var k = '';
    var b = null;
    for (k in byType) {
      if (!Object.prototype.hasOwnProperty.call(byType, k)) continue;
      b = byType[k];
      out[k] = {
        requests: b.requests,
        transferBytes: b.transferBytes,
        encodedBytes: b.encodedBytes,
        decodedBytes: b.decodedBytes,
        cachedRequests: b.cachedRequests,
        durationMs: b.durationMs
      };
    }
    return out;
  }

  // Wall-clock time during which at least one transfer was in flight.
  function busyMs() {
    var total = 0;
    var i = 0;
    var curS = 0;
    var curE = 0;
    if (!spans.length) return 0;
    spans.sort(function (a, b) { return a[0] - b[0]; });
    curS = spans[0][0];
    curE = spans[0][1];
    for (i = 1; i < spans.length; i++) {
      if (spans[i][0] <= curE) {
        if (spans[i][1] > curE) curE = spans[i][1];
      } else {
        total += curE - curS;
        curS = spans[i][0];
        curE = spans[i][1];
      }
    }
    total += curE - curS;
    return total;
  }

  function flushTransfers() {
    emit({
      type: 'transfers',
      requests: totals.requests,
      transferBytes: totals.transferBytes,
      encodedBytes: totals.encodedBytes,
      decodedBytes: totals.decodedBytes,
      cachedRequests: totals.cachedRequests,
      revalidatedRequests: revalidated,
      durationMs: totals.durationMs,
      busyMs: busyMs(),
      byType: copyBuckets(),
      ttfbP50Ms: percentile(ttfbSamples, 50),
      ttfbP95Ms: percentile(ttfbSamples, 95),
      downloadP95Ms: percentile(downloadSamples, 95),
      slowDownloads: slowDownloads,
      cacheReadBytes: cacheReadBytes,
      cacheReadMs: cacheReadMs,
      cacheReadP95Ms: percentile(cacheReadSamples, 95),
      cacheReadSlow: cacheReadSlow,
      protocolH1: protocolH1,
      protocolH2: protocolH2,
      scriptH1: scriptH1,
      at: nowMs()
    });
  }

  function startResourceObserver() {
    try {
      if (typeof performance !== 'undefined' && performance && typeof performance.setResourceTimingBufferSize === 'function') {
        performance.setResourceTimingBufferSize(1000);
      }
    } catch (e0) {}
    if (typeof PerformanceObserver !== 'function') return;
    try {
      var po = new PerformanceObserver(function (list) {
        try {
          var items = (list && typeof list.getEntries === 'function') ? list.getEntries() : [];
          consumeResources(items);
          if (typeof performance.clearResourceTimings === 'function') performance.clearResourceTimings();
        } catch (e1) {}
      });
      po.observe({ type: 'resource', buffered: true });
    } catch (e2) {}
  }

  function token(v) {
    if (typeof v === 'string') return v;
    if (typeof v === 'number' && isFinite(v)) return String(v);
    return '';
  }

  function readSize(obj, key) {
    try {
      var c = obj && obj[key];
      if (c && typeof c.size === 'number' && isFinite(c.size)) return c.size;
    } catch (e) {}
    return 0;
  }

  function readFoundryVersion(g) {
    try {
      if (g && typeof g.version === 'string' && g.version) return g.version;
      if (g && g.release && typeof g.release.version === 'string' && g.release.version) return g.release.version;
    } catch (e) {}
    return '';
  }

  function readGeneration(g) {
    try {
      var n = g && g.release ? g.release.generation : null;
      if (typeof n === 'number' && isFinite(n)) return n;
    } catch (e) {}
    return null;
  }

  function readSystem(g) {
    var id = '';
    var version = '';
    try {
      if (g && g.system) {
        if (typeof g.system.id === 'string') id = g.system.id;
        if (typeof g.system.version === 'string') version = g.system.version;
      }
    } catch (e) {}
    return { id: id, version: version };
  }

  function collectModules(g) {
    var out = [];
    var mods = g && g.modules;
    function consider(m) {
      var id = '';
      var version = '';
      if (!m || !m.active) return;
      if (out.length >= 200) return;
      id = token(m.id);
      version = token(m.version);
      if (!id) return;
      out.push({ id: id, version: version });
    }
    if (!mods) return out;
    try {
      if (typeof mods.forEach === 'function') mods.forEach(function (m) { consider(m); });
      else if (typeof mods.length === 'number') {
        for (var i = 0; i < mods.length; i++) consider(mods[i]);
      }
    } catch (e) {}
    return out;
  }

  function countActiveModules(g) {
    var n = 0;
    var mods = g && g.modules;
    function consider(m) {
      if (!m || !m.active) return;
      if (n >= 200) return;
      if (!token(m.id)) return;
      n += 1;
    }
    if (!mods) return 0;
    try {
      if (typeof mods.forEach === 'function') mods.forEach(function (m) { consider(m); });
      else if (typeof mods.length === 'number') {
        var i = 0;
        for (i = 0; i < mods.length; i++) consider(mods[i]);
      }
    } catch (e) {}
    return n;
  }

  function readTextures() {
    var task = null;
    var loaded = null;
    var total = null;
    // Only canvas.loadTexturesTask.loaded/total. Other Foundry v13 texture
    // globals were not confirmed on a live page, so they stay null.
    try { task = window.canvas && window.canvas.loadTexturesTask; } catch (e) { task = null; }
    try {
      if (task && typeof task.loaded === 'number' && typeof task.total === 'number'
        && isFinite(task.loaded) && isFinite(task.total) && task.loaded >= 0 && task.total >= 0) {
        loaded = task.loaded;
        total = task.total;
      }
    } catch (e2) {}
    return { loaded: loaded, total: total };
  }

  function readMode() {
    try {
      var c = window.canvas;
      var m = c && c.performance ? c.performance.mode : null;
      if (typeof m === 'number' && isFinite(m)) return m;
      if (typeof m === 'string' && m && m.length <= 64 && m.indexOf('://') < 0) return m;
    } catch (e) {}
    return null;
  }

  function readFps() {
    try {
      var c = window.canvas;
      var fps = c && c.app && c.app.ticker ? c.app.ticker.FPS : null;
      if (typeof fps === 'number' && isFinite(fps)) return fps;
    } catch (e) {}
    return null;
  }

  function readScene() {
    try {
      var c = window.canvas;
      var sc = c && c.scene;
      if (!sc) return null;
      return {
        tokens: readSize(sc, 'tokens'),
        tiles: readSize(sc, 'tiles'),
        lights: readSize(sc, 'lights'),
        walls: readSize(sc, 'walls')
      };
    } catch (e) {}
    return null;
  }

  function readHeap() {
    var used = null;
    var limit = null;
    try {
      var mem = (typeof performance !== 'undefined' && performance) ? performance.memory : null;
      if (mem) {
        if (typeof mem.usedJSHeapSize === 'number' && isFinite(mem.usedJSHeapSize)) used = mem.usedJSHeapSize;
        if (typeof mem.jsHeapSizeLimit === 'number' && isFinite(mem.jsHeapSizeLimit)) limit = mem.jsHeapSizeLimit;
      }
    } catch (e) {}
    return { used: used, limit: limit };
  }

  function readConnected() {
    try {
      return !!(window.game && window.game.socket && window.game.socket.connected);
    } catch (e) {}
    return false;
  }

  function copyByName() {
    var out = {};
    var keys = Object.keys(errorByName);
    var i = 0;
    for (i = 0; i < keys.length; i++) out[keys[i]] = errorByName[keys[i]];
    return out;
  }

  function pageErrorPayload() {
    return { error: errorCount, rejection: rejectionCount, byName: copyByName() };
  }

  function noteErrorName(err) {
    var name = 'Unknown';
    try {
      if (err && typeof err.name === 'string' && err.name) name = err.name;
      else if (err && err.constructor && typeof err.constructor.name === 'string' && err.constructor.name) {
        name = err.constructor.name;
      }
    } catch (e) {}
    if (!name || name.length > 64 || name.indexOf('://') >= 0) name = 'Unknown';
    if (!Object.prototype.hasOwnProperty.call(errorByName, name)) {
      if (Object.keys(errorByName).length >= 20) return;
      errorByName[name] = 0;
    }
    errorByName[name] += 1;
  }

  function bindPageErrors() {
    if (!window.addEventListener) return;
    window.addEventListener('error', function (ev) {
      try {
        errorCount += 1;
        noteErrorName(ev && ev.error);
      } catch (e) {}
    });
    window.addEventListener('unhandledrejection', function (ev) {
      try {
        rejectionCount += 1;
        noteErrorName(ev && ev['reason']);
      } catch (e2) {}
    });
  }

  function emitWorld() {
    var g = {};
    var payload = null;
    var scene = null;
    try {
      g = window.game || {};
      payload = {
        type: 'world',
        foundryVersion: readFoundryVersion(g),
        generation: readGeneration(g),
        system: readSystem(g),
        modules: collectModules(g),
        documents: {
          actors: readSize(g, 'actors'),
          items: readSize(g, 'items'),
          scenes: readSize(g, 'scenes'),
          journal: readSize(g, 'journal'),
          tables: readSize(g, 'tables'),
          macros: readSize(g, 'macros'),
          playlists: readSize(g, 'playlists'),
          cards: readSize(g, 'cards'),
          folders: readSize(g, 'folders'),
          users: readSize(g, 'users'),
          messages: readSize(g, 'messages'),
          packs: readSize(g, 'packs')
        },
        performanceMode: readMode(),
        at: nowMs()
      };
      scene = readScene();
      if (scene) payload.scene = scene;
      emit(payload);
    } catch (e) {}
  }

  function sendWorldData(bytes, at) {
    var t = 0;
    var since = 0;
    var size = 0;
    if (worldDataSent) return;
    worldDataSent = true;
    t = (typeof at === 'number' && isFinite(at)) ? at : nowMs();
    since = connectAt > 0 ? (t - connectAt) : 0;
    size = (typeof bytes === 'number' && isFinite(bytes)) ? bytes : 0;
    emit({ type: 'worldData', bytes: size, at: t, sinceConnectMs: since });
  }

  function measureDoc(doc) {
    var src = null;
    var text = '';
    try {
      if (!doc) return 0;
      if (doc._source) src = doc._source;
      else if (typeof doc.toObject === 'function') src = doc.toObject();
      else return 0;
      text = JSON.stringify(src);
      if (typeof text !== 'string') return 0;
      return text.length;
    } catch (e) {
      return 0;
    }
  }

  function sizePayload(complete) {
    var out = {};
    var i = 0;
    var k = '';
    for (i = 0; i < SIZE_KEYS.length; i++) {
      k = SIZE_KEYS[i];
      if (typeof sizeScan.sizes[k] === 'number' && isFinite(sizeScan.sizes[k])) out[k] = sizeScan.sizes[k];
    }
    return { type: 'worldSizes', sizes: out, complete: complete === true, at: nowMs() };
  }

  function scheduleSizeSlice() {
    try {
      if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(function (deadline) {
          try { runSizeSlice(deadline); } catch (e) { scheduleSizeSlice(); }
        }, { timeout: 1000 });
        return;
      }
    } catch (e0) {}
    try { setTimeout(function () { try { runSizeSlice(null); } catch (e1) {} }, 250); } catch (e2) {}
  }

  function runSizeSlice(deadline) {
    var started = 0;
    var processed = 0;
    var key = '';
    var col = null;
    var contents = null;
    var n = 0;
    if (!sizeScan || sizeScan.done) return;
    started = nowMs();
    while (sizeScan.index < SIZE_KEYS.length) {
      key = SIZE_KEYS[sizeScan.index];
      col = null;
      try { col = window.game && window.game[key]; } catch (e) { col = null; }
      contents = col && col.contents;
      n = (contents && typeof contents.length === 'number') ? contents.length : 0;
      while (sizeScan.doc < n) {
        if (processed >= 50 || (processed > 0 && nowMs() - started >= 50)) {
          scheduleSizeSlice();
          return;
        }
        if (deadline && typeof deadline.timeRemaining === 'function' && deadline.timeRemaining() <= 0 && processed > 0) {
          scheduleSizeSlice();
          return;
        }
        sizeScan.bytes += measureDoc(contents[sizeScan.doc]);
        sizeScan.doc += 1;
        processed += 1;
      }
      sizeScan.sizes[key] = sizeScan.bytes;
      sizeScan.index += 1;
      sizeScan.doc = 0;
      sizeScan.bytes = 0;
      emit(sizePayload(sizeScan.index >= SIZE_KEYS.length));
      if (sizeScan.index >= SIZE_KEYS.length) {
        sizeScan.done = true;
        return;
      }
    }
  }

  function startWorldSizes() {
    if (sizeScan) return;
    sizeScan = { index: 0, doc: 0, bytes: 0, sizes: {}, done: false };
    try {
      setTimeout(function () { try { scheduleSizeSlice(); } catch (e) {} }, 3000);
    } catch (e2) {}
  }

  function packageId(value) {
    var s = token(value);
    if (!/^[A-Za-z0-9._-]{1,64}$/.test(s)) return '?';
    return s;
  }

  function packageVersion(value) {
    var s = token(value);
    if (!/^[A-Za-z0-9._+-]{1,40}$/.test(s)) return '?';
    return s;
  }

  // Active-module map from the world's core.moduleConfiguration setting, or
  // null when it cannot be read (then every installed module is included).
  function activeModuleMap(data) {
    var settings = data && data.settings;
    var i = 0;
    var row = null;
    var value = null;
    if (!settings || typeof settings.length !== 'number') return null;
    for (i = 0; i < settings.length; i++) {
      row = settings[i];
      if (!row || row.key !== 'core.moduleConfiguration') continue;
      value = row.value;
      if (typeof value === 'string') {
        try { value = JSON.parse(value); } catch (e) { return null; }
      }
      return value && typeof value === 'object' ? value : null;
    }
    return null;
  }

  // Package set (view, core, system, modules). Sourced from the server's
  // world payload (game.data), which is complete before init and does not
  // depend on hook ordering; game.modules is only a fallback because its
  // active flags are still settling while init hooks run.
  function packagesPayload() {
    var g = {};
    var data = null;
    var system = { id: '', version: '' };
    var mods = [];
    var active = null;
    var out = [];
    var i = 0;
    var row = null;
    var id = '';
    var core = '';
    try { g = window.game || {}; } catch (e0) { g = {}; }
    try { data = g && g.data && typeof g.data === 'object' ? g.data : null; } catch (e1) { data = null; }
    try {
      if (data && data.modules && typeof data.modules.length === 'number') {
        active = activeModuleMap(data);
        for (i = 0; i < data.modules.length && out.length < 400; i++) {
          row = data.modules[i] || {};
          id = packageId(row.id);
          if (active && active[id] === false) continue;
          out.push({ id: id, version: packageVersion(row.version) });
        }
        mods = null;
      }
    } catch (e2) { out = []; mods = []; }
    if (mods) {
      try { mods = collectModules(g); } catch (e3) { mods = []; }
      if (!mods || typeof mods.length !== 'number') mods = [];
      for (i = 0; i < mods.length; i++) {
        row = mods[i] || {};
        out.push({ id: packageId(row.id), version: packageVersion(row.version) });
      }
    }
    try {
      if (data && data.system && typeof data.system === 'object') {
        system = { id: token(data.system.id), version: token(data.system.version) };
      } else {
        system = readSystem(g);
      }
    } catch (e4) { system = { id: '', version: '' }; }
    try { core = data && data.world ? token(data.world.coreVersion) : ''; } catch (e5) { core = ''; }
    if (!core) core = readFoundryVersion(g);
    return {
      // Foundry's login page is also a Game view (init fires there with no
      // system and no modules); the main side ignores anything but 'game'.
      view: packageId(g && g.view),
      foundryVersion: packageVersion(core),
      system: { id: packageId(system && system.id), version: packageVersion(system && system.version) },
      modules: out
    };
  }

  function onPhase(name, late) {
    var payload = null;
    var at = 0;
    try {
      if (seenPhase[name]) return;
      seenPhase[name] = true;
      if (name === 'setup') setupSeen = true;
      at = nowMs();
      phaseAt[name] = at;
      if (name === 'ready') {
        // Counts and transfers go first so the main side records history
        // from a complete picture when the phase itself lands.
        readySeen = true;
        hookTiming = false;
        loadingPackage = '';
        stopProgress();
        emitWorld();
        flushTransfers();
        startWorldSizes();
        payload = { type: 'phase', name: name, at: at, pageErrors: pageErrorPayload(), longTasks: longTasksPayload(), hooks: hookTimePayload() };
        if (late) payload.late = true;
        emit(payload);
        return;
      }
      payload = { type: 'phase', name: name, at: at };
      if (name === 'init') {
        try { payload.packages = packagesPayload(); } catch (ePkg) {}
      }
      if (late) payload.late = true;
      emit(payload);
      if (name === 'setup') sendWorldData(largestBytes, largestAt || at);
      flushTransfers();
    } catch (e) {}
  }

  function hookAlready(name) {
    var g = null;
    try { g = window.game; } catch (e) { return false; }
    if (!g) return false;
    if (name === 'ready') return g.ready === true;
    if (name === 'canvasReady') {
      try { return !!(window.canvas && window.canvas.ready === true); } catch (e2) { return false; }
      return false;
    }
    if (g.ready === true && (name === 'init' || name === 'i18nInit' || name === 'setup')) return true;
    return false;
  }

  var hookMsByPackage = Object.create(null);
  var hookCountByPackage = Object.create(null);
  var activePackage = '';
  var activeHook = '';
  var loadingPackage = '';
  var hookTiming = true;
  var hooksTrapped = false;
  var hooksValue = null;
  var fnToWrap = null;
  try { if (typeof WeakMap === 'function') fnToWrap = new WeakMap(); } catch (eMap) { fnToWrap = null; }

  function validToken(value) {
    return typeof value === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(value);
  }

  function packageIdFromStack() {
    var err = null;
    var stack = '';
    var match = null;
    var id = 'foundry';
    try {
      err = new Error();
      stack = err && err.stack ? String(err.stack) : '';
      match = /\\/(modules|systems)\\/([^\\/?#]+)\\//.exec(stack);
      if (match && match[2]) id = String(match[2]);
    } catch (e) {
      id = 'foundry';
    }
    stack = '';
    err = null;
    match = null;
    if (!validToken(id)) id = 'other';
    return id;
  }

  function noteLoadingPackage(rec, kind) {
    var name = '';
    var match = null;
    var id = '';
    if (hookTiming !== true) return;
    if (kind !== 'script' && kind !== 'link' && kind !== 'other') return;
    try { name = rec && typeof rec.name === 'string' ? rec.name : ''; } catch (e) { name = ''; }
    match = /\\/(modules|systems)\\/([^\\/?#]+)\\//.exec(name);
    name = '';
    if (!match || !match[2]) return;
    id = String(match[2]);
    match = null;
    if (!validToken(id)) return;
    loadingPackage = id;
  }

  function noteHookTime(id, ms) {
    var prev = 0;
    var count = 0;
    if (!validToken(id)) return;
    if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) ms = 0;
    prev = Object.prototype.hasOwnProperty.call(hookMsByPackage, id) ? hookMsByPackage[id] : 0;
    hookMsByPackage[id] = prev + ms;
    count = Object.prototype.hasOwnProperty.call(hookCountByPackage, id) ? hookCountByPackage[id] : 0;
    hookCountByPackage[id] = count + 1;
  }

  function rememberWrap(fn, hookName, wrapped) {
    var bag = null;
    if (!fnToWrap || typeof fn !== 'function' || !validToken(hookName)) return;
    try {
      bag = fnToWrap.get(fn);
      if (!bag) {
        bag = Object.create(null);
        fnToWrap.set(fn, bag);
      }
      bag[hookName] = wrapped;
    } catch (e) {}
  }

  function recallWrap(fn, hookName) {
    var bag = null;
    if (!fnToWrap || typeof fn !== 'function') return null;
    try {
      bag = fnToWrap.get(fn);
      if (bag && validToken(hookName) && bag[hookName]) return bag[hookName];
    } catch (e) {}
    return null;
  }

  function wrapHookFn(hookName, fn, pkg) {
    var wrapped = null;
    if (typeof fn !== 'function') return fn;
    if (fn.__flcHookWrapped) return fn;
    wrapped = function () {
      var t0 = 0;
      var result = null;
      var delta = 0;
      var prevPkg = '';
      var prevHook = '';
      if (hookTiming !== true) return fn.apply(this, arguments);
      prevPkg = activePackage;
      prevHook = activeHook;
      activePackage = pkg;
      activeHook = validToken(hookName) ? hookName : '';
      t0 = nowMs();
      try {
        result = fn.apply(this, arguments);
      } finally {
        delta = nowMs() - t0;
        if (typeof delta !== 'number' || !isFinite(delta) || delta < 0) delta = 0;
        noteHookTime(pkg, delta);
        activePackage = prevPkg;
        activeHook = prevHook;
      }
      return result;
    };
    wrapped.__flcHookWrapped = true;
    rememberWrap(fn, hookName, wrapped);
    return wrapped;
  }

  function callHook(orig, owner, hookName, fn) {
    var name = '';
    var pkg = 'foundry';
    var wrapped = fn;
    if (typeof orig !== 'function') return 0;
    if (fn && fn.__flcPhase) {
      try { return orig.call(owner, hookName, fn); } catch (e0) { return 0; }
    }
    try { name = typeof hookName === 'string' ? hookName : ''; } catch (e1) { name = ''; }
    try { pkg = packageIdFromStack(); } catch (e2) { pkg = 'foundry'; }
    if (typeof fn === 'function') {
      try { wrapped = wrapHookFn(name, fn, pkg); } catch (e3) { wrapped = fn; }
    }
    try { return orig.call(owner, hookName, wrapped); } catch (e4) { return 0; }
  }

  function wrapHooks(hooks) {
    var origOn = null;
    var origOnce = null;
    var origOff = null;
    if (!hooks || typeof hooks !== 'object' || hooks.__flcWrapped) return hooks;
    origOn = hooks.on;
    origOnce = hooks.once;
    origOff = hooks.off;
    if (typeof origOn !== 'function' && typeof origOnce !== 'function') return hooks;
    if (typeof origOn === 'function') {
      hooks.on = function (hookName, fn) { return callHook(origOn, hooks, hookName, fn); };
    }
    if (typeof origOnce === 'function') {
      hooks.once = function (hookName, fn) { return callHook(origOnce, hooks, hookName, fn); };
    }
    if (typeof origOff === 'function') {
      hooks.off = function (hookName, fnOrId) {
        var wrapped = fnOrId;
        var name = '';
        var found = null;
        if (typeof fnOrId === 'function') {
          try { name = typeof hookName === 'string' ? hookName : ''; } catch (e0) { name = ''; }
          try { found = recallWrap(fnOrId, name); } catch (e1) { found = null; }
          if (found) wrapped = found;
        }
        try { return origOff.call(hooks, hookName, wrapped); } catch (e2) { return 0; }
      };
    }
    try { hooks.__flcWrapped = true; } catch (e3) {}
    return hooks;
  }

  function trapHooks() {
    if (hooksTrapped) return;
    hooksTrapped = true;
    try {
      if (window.Hooks) {
        wrapHooks(window.Hooks);
        return;
      }
      Object.defineProperty(window, 'Hooks', {
        configurable: true,
        enumerable: true,
        get: function () { return hooksValue; },
        set: function (v) {
          hooksValue = v;
          try { wrapHooks(v); } catch (e) {}
        }
      });
    } catch (e2) {}
  }

  function hookTimePayload() {
    var rows = [];
    var i = 0;
    var total = 0;
    var ms = 0;
    var count = 0;
    var k = '';
    var packages = 0;
    try {
      for (k in hookMsByPackage) {
        if (!Object.prototype.hasOwnProperty.call(hookMsByPackage, k)) continue;
        if (!validToken(k)) continue;
        ms = hookMsByPackage[k];
        if (typeof ms !== 'number' || !isFinite(ms) || ms < 0) continue;
        count = hookCountByPackage[k];
        if (typeof count !== 'number' || !isFinite(count) || count < 0) count = 0;
        packages += 1;
        total += ms;
        rows.push({ id: k, ms: ms, count: count });
      }
    } catch (e) {}
    rows.sort(function (a, b) { return b.ms - a.ms; });
    if (rows.length > 15) rows = rows.slice(0, 15);
    return { byPackage: rows, totalMs: total, packages: packages };
  }

  function stepInfo() {
    var index = 1;
    var names = ['connecting', 'loading page', 'receiving world data', 'initializing', 'loading languages', 'setting up world', 'drawing scene', 'ready'];
    if (seenPhase.domReady || connectAt) index = 2;
    if (worldDataSent) index = 3;
    if (seenPhase.init) index = 4;
    if (seenPhase.i18nInit) index = 5;
    if (seenPhase.setup) index = 6;
    if (seenPhase.canvasReady) index = 7;
    if (seenPhase.ready) index = 8;
    return { index: index, total: 8, name: names[index - 1] };
  }

  function activeInfo() {
    var pkg = activePackage || loadingPackage || '';
    var hook = activeHook || '';
    return {
      package: validToken(pkg) ? pkg : null,
      hook: validToken(hook) ? hook : null
    };
  }

  function armHook(name) {
    var cb = null;
    try {
      if (hookAlready(name)) {
        onPhase(name, true);
        return;
      }
      cb = function () { onPhase(name, false); };
      cb.__flcPhase = true;
      window.Hooks.once(name, cb);
    } catch (e) {}
  }

  function bindHooks() {
    var names = ['init', 'i18nInit', 'setup', 'canvasReady', 'ready'];
    var i = 0;
    if (hooksBound) return;
    if (!window.Hooks || typeof window.Hooks.once !== 'function') return;
    hooksBound = true;
    for (i = 0; i < names.length; i++) armHook(names[i]);
  }

  function emitConfig() {
    var engine = null;
    var pi = 0;
    var pt = 0;
    var hasPi = false;
    var hasPt = false;
    var payload = null;
    if (configSent) return;
    try {
      engine = window.game && window.game.socket && window.game.socket.io && window.game.socket.io.engine;
    } catch (e) {}
    if (!engine) return;
    pi = engine.pingInterval;
    pt = engine.pingTimeout;
    hasPi = typeof pi === 'number' && isFinite(pi);
    hasPt = typeof pt === 'number' && isFinite(pt);
    if (!hasPi && !hasPt) return;
    configSent = true;
    payload = { type: 'sync', event: 'config', at: nowMs() };
    if (hasPi) payload.pingIntervalMs = pi;
    if (hasPt) payload.pingTimeoutMs = pt;
    emit(payload);
  }

  function onConnect() {
    var at = 0;
    try {
      at = nowMs();
      if (!connectAt) connectAt = at;
      emit({ type: 'sync', event: 'connect', at: at });
      emitConfig();
    } catch (e) {}
  }

  function onDisconnect() {
    try {
      emit({ type: 'sync', event: 'disconnect', at: nowMs() });
    } catch (e) {}
  }

  function onReconnectAttempt() {
    try {
      emit({ type: 'sync', event: 'reconnect_attempt', at: nowMs() });
    } catch (e) {}
  }

  // engine.io protocol 4+ pings from the server: the client's "ping" event is
  // the receipt and "pong" is its immediate reply, so that gap is not an RTT.
  function serverPings() {
    var proto = null;
    try {
      proto = boundEngine && boundEngine.constructor ? boundEngine.constructor.protocol : null;
    } catch (e) { proto = null; }
    return typeof proto === 'number' && proto >= 4;
  }

  function median(values) {
    var sorted = values.slice().sort(function (a, b) { return a - b; });
    var mid = Math.floor(sorted.length / 2);
    if (!sorted.length) return 0;
    return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  }

  function pageHidden() {
    try {
      return !!(document && document.hidden);
    } catch (e) {
      return false;
    }
  }

  function jitterStats() {
    var n = 0;
    var p95 = null;
    try {
      n = pingJitterDevs.length;
      if (n) p95 = percentile(pingJitterDevs, 95);
    } catch (e) {}
    return { pingJitterP95Ms: p95, pingJitterSamples: n };
  }

  // One jitter report per ping arrival. Samples stay on their own timer.
  function emitPingJitter(at) {
    var stats = null;
    try {
      if (lastJitterAt === at) return;
      stats = jitterStats();
      if (!stats.pingJitterSamples) return;
      lastJitterAt = at;
      emit({
        type: 'sync',
        event: 'ping_jitter',
        at: at,
        pingJitterP95Ms: stats.pingJitterP95Ms,
        pingJitterSamples: stats.pingJitterSamples
      });
    } catch (e) {}
  }

  // Deviation from the cadence known before this arrival. A long task or a
  // hidden page makes the gap local scheduling, not the network.
  function recordPingGap(at) {
    var gap = 0;
    var dev = 0;
    var blockedNow = 0;
    var overlapped = false;
    var known = 0;
    known = observedPingMs;
    if (!(prevPingAt > 0) || !(known > 0)) return;
    blockedNow = longTasks.totalMs;
    overlapped = blockedNow !== prevPingBlockedMs;
    gap = at - prevPingAt;
    if (gap > known * 2 && !overlapped) {
      emit({ type: 'sync', event: 'missed_ping', at: at });
    }
    if (overlapped || pageHidden()) return;
    if (typeof gap !== 'number' || !isFinite(gap)) return;
    dev = Math.abs(gap - known);
    if (!isFinite(dev)) return;
    pingJitterDevs.push(dev);
    if (pingJitterDevs.length > 30) pingJitterDevs.shift();
  }

  // The server's ping cadence is learned from arrivals, not read from
  // (often minified) client internals.
  function notePingArrival(at) {
    var gaps = [];
    var i = 0;
    var m = 0;
    try { recordPingGap(at); } catch (e) {}
    prevPingAt = at;
    try { prevPingBlockedMs = longTasks.totalMs; } catch (e2) {}
    try {
      pingTimes.push(at);
      if (pingTimes.length > 8) pingTimes.shift();
      if (pingTimes.length >= 2) {
        for (i = 1; i < pingTimes.length; i++) gaps.push(pingTimes[i] - pingTimes[i - 1]);
        m = Math.round(median(gaps));
        if (m > 0 && !(observedPingMs && Math.abs(m - observedPingMs) < observedPingMs * 0.1)) {
          observedPingMs = m;
          emit({ type: 'sync', event: 'config', at: at, pingIntervalMs: m, observed: true });
        }
      }
    } catch (e3) {}
    emitPingJitter(at);
  }

  function onPing() {
    pingAt = nowMs();
    try { notePingArrival(pingAt); } catch (e) {}
  }

  function onPong() {
    var at = 0;
    var payload = null;
    try {
      at = nowMs();
      payload = { type: 'sync', event: 'pong', at: at };
      if (pingAt > 0 && !serverPings()) {
        var rtt = at - pingAt;
        if (rtt >= 1) payload.rttMs = rtt;
      }
      emit(payload);
    } catch (e) {}
  }

  // Round trips the page already performs (emit with an ack callback) are the
  // operational latency signal; at most four samples a second are forwarded.
  function noteAck(rttMs) {
    var at = nowMs();
    if (typeof rttMs !== 'number' || !isFinite(rttMs) || rttMs < 0) return;
    if (at - lastAckEmitAt < 250) return;
    lastAckEmitAt = at;
    emit({ type: 'sync', event: 'ack', at: at, rttMs: rttMs });
  }

  function requestToken(v) {
    if (typeof v === 'string' && /^[A-Za-z0-9._-]{1,48}$/.test(v)) return v;
    return 'other';
  }

  // A sample is only a latency sample when the page itself did not stall
  // in between: acks issued during the join, or overlapping a long task,
  // measure local work and are dropped. Argument copying happens only when
  // the page passed an ack callback.
  function wrapEmit(socket) {
    var orig = null;
    try {
      orig = socket.emit;
      if (typeof orig !== 'function' || orig.__flcWrapped) return;
      var wrapped = function () {
        var last = arguments.length ? arguments[arguments.length - 1] : null;
        var t0 = 0;
        var blockedAt0 = 0;
        var args = null;
        requestsOut += 1;
        t0 = nowMs();
        lastRequestAt = t0;
        lastRequestName = requestToken(arguments.length ? arguments[0] : '');
        lastRequestMs = null;
        if (typeof last !== 'function') return orig.apply(this, arguments);
        args = Array.prototype.slice.call(arguments);
        blockedAt0 = longTasks.totalMs;
        args[args.length - 1] = function () {
          var ms = 0;
          try {
            ms = nowMs() - t0;
            if (lastRequestAt === t0) lastRequestMs = ms;
            if (readySeen && longTasks.totalMs === blockedAt0) noteAck(ms);
          } catch (e) {}
          return last.apply(this, arguments);
        };
        return orig.apply(this, args);
      };
      wrapped.__flcWrapped = true;
      socket.emit = wrapped;
    } catch (e2) {}
  }

  function onPacket(p) {
    var at = 0;
    var data = null;
    var bytes = 0;
    try {
      at = nowMs();
      lastPacketAt = at;
      lastMessageAt = at;
      messagesIn += 1;
      data = p ? p.data : null;
      if (typeof data === 'string') bytes = data.length;
      else bytes = (data && data.byteLength) || 0;
      if (!setupSeen && bytes > largestBytes) {
        largestBytes = bytes;
        largestAt = at;
      }
      if (!worldDataSent && bytes > 262144) sendWorldData(bytes, at);
    } catch (e) {}
  }

  // The manager creates a fresh engine on every (re)open; rebind each time.
  function bindEngine(manager) {
    var engine = null;
    try {
      engine = manager && manager.engine;
      if (!engine || engine === boundEngine || typeof engine.on !== 'function') return;
      boundEngine = engine;
      engine.on('ping', onPing);
      engine.on('pong', onPong);
      engine.on('packet', onPacket);
    } catch (e) {}
  }

  function bindSocketObject(socket) {
    var io = null;
    if (socketBound) return;
    if (!socket || typeof socket.on !== 'function') return;
    socketBound = true;
    try {
      socket.on('connect', onConnect);
      socket.on('disconnect', onDisconnect);
    } catch (e1) {}
    wrapEmit(socket);
    try {
      io = socket.io;
      if (io && typeof io.on === 'function') {
        io.on('reconnect_attempt', onReconnectAttempt);
        io.on('open', function () { bindEngine(io); emitConfig(); });
      }
      bindEngine(io);
    } catch (e2) {}
    emitConfig();
    try {
      if (socket.connected) onConnect();
    } catch (e3) {}
  }

  // Wrap the socket.io client factory so the socket is bound the moment the
  // page creates it (before window.game exists and the world payload lands).
  function wrapIo(orig) {
    var wrapped = null;
    var keys = [];
    var i = 0;
    if (typeof orig !== 'function' || orig.__flcWrapped) return orig;
    wrapped = function () {
      var s = orig.apply(this, arguments);
      try { bindSocketObject(s); } catch (e) {}
      return s;
    };
    try {
      keys = Object.keys(orig);
      for (i = 0; i < keys.length; i++) {
        if (keys[i] === 'connect' || keys[i] === 'io') continue;
        wrapped[keys[i]] = orig[keys[i]];
      }
      wrapped.connect = (orig.connect === orig || typeof orig.connect !== 'function') ? wrapped : wrapIo(orig.connect);
      wrapped.io = wrapped;
      wrapped.__flcWrapped = true;
    } catch (e2) {}
    return wrapped;
  }

  function trapIo() {
    if (ioTrapped) return;
    ioTrapped = true;
    try {
      if (window.io) {
        window.io = wrapIo(window.io);
        return;
      }
      Object.defineProperty(window, 'io', {
        configurable: true,
        enumerable: true,
        get: function () { return ioValue; },
        set: function (v) { ioValue = wrapIo(v); }
      });
    } catch (e) {}
  }

  function bindSocket() {
    var socket = null;
    if (socketBound) return;
    try { socket = window.game && window.game.socket; } catch (e) { return; }
    bindSocketObject(socket);
  }

  function emitSample() {
    var heap = null;
    var payload = null;
    var scene = null;
    try {
      heap = readHeap();
      payload = {
        type: 'sample',
        at: nowMs(),
        heapUsedBytes: heap.used,
        heapLimitBytes: heap.limit,
        fps: readFps(),
        longTasks: longTasksPayload(),
        connected: readConnected(),
        lastPacketAgeMs: lastPacketAt > 0 ? (nowMs() - lastPacketAt) : null,
        pageErrors: pageErrorPayload()
      };
      var jitter = jitterStats();
      if (jitter && jitter.pingJitterSamples) {
        payload.pingJitterP95Ms = jitter.pingJitterP95Ms;
        payload.pingJitterSamples = jitter.pingJitterSamples;
      }
      if (lastRequestAt > 0) {
        payload.lastRequestName = lastRequestName || 'other';
        payload.lastRequestAgeMs = nowMs() - lastRequestAt;
        if (typeof lastRequestMs === 'number' && isFinite(lastRequestMs)) payload.lastRequestMs = lastRequestMs;
      }
      if (lastMessageAt > 0) payload.lastMessageAgeMs = nowMs() - lastMessageAt;
      payload.requestsOut = requestsOut;
      payload.messagesIn = messagesIn;
      scene = readScene();
      if (scene) payload.scene = scene;
      emit(payload);
      flushTransfers();
    } catch (e) {}
  }

  // Name of the join phase a long task started in ("pre-init", "init", ...).
  function phaseFor(startTime) {
    var order = ['init', 'i18nInit', 'setup', 'canvasReady', 'ready'];
    var best = 'pre-init';
    var i = 0;
    for (i = 0; i < order.length; i++) {
      if (typeof phaseAt[order[i]] === 'number' && phaseAt[order[i]] <= startTime) best = order[i];
    }
    return best;
  }

  function longTasksPayload() {
    var out = {};
    var k = '';
    for (k in longTasks.byPhase) {
      if (Object.prototype.hasOwnProperty.call(longTasks.byPhase, k)) out[k] = longTasks.byPhase[k];
    }
    return { count: longTasks.count, worstMs: longTasks.worstMs, totalMs: longTasks.totalMs, byPhase: out };
  }

  function beginLongTasks() {
    if (longObs) return;
    if (typeof PerformanceObserver !== 'function') return;
    try {
      longObs = new PerformanceObserver(function (list) {
        try {
          var items = (list && typeof list.getEntries === 'function') ? list.getEntries() : [];
          var i = 0;
          var task = null;
          var dur = 0;
          var ph = '';
          for (i = 0; i < items.length; i++) {
            task = items[i];
            dur = task && task.duration;
            if (typeof dur !== 'number' || !isFinite(dur)) continue;
            longTasks.count += 1;
            longTasks.totalMs += dur;
            if (dur > longTasks.worstMs) longTasks.worstMs = dur;
            ph = phaseFor(num(task.startTime));
            longTasks.byPhase[ph] = (longTasks.byPhase[ph] || 0) + dur;
          }
        } catch (e) {}
      });
      longObs.observe({ type: 'longtask', buffered: true });
    } catch (e2) {
      longObs = null;
    }
  }

  function start(intervalMs) {
    var ms = 5000;
    var base = 5000;
    var prevLong = 0;
    function arm(delay) {
      try {
        timer = setTimeout(function () {
          var next = base;
          try {
            emitSample();
            if (longTasks.count > prevLong) next = Math.max(base * 3, 15000);
            else next = base;
            prevLong = longTasks.count;
          } catch (e) {}
          arm(next);
        }, delay);
      } catch (e2) {}
    }
    try {
      stop();
      beginLongTasks();
      if (typeof intervalMs === 'number' && isFinite(intervalMs) && intervalMs > 0) ms = intervalMs;
      base = ms;
      prevLong = longTasks.count;
      arm(base);
    } catch (e3) {}
  }

  function stop() {
    try {
      if (timer != null) {
        clearTimeout(timer);
        timer = null;
      }
    } catch (e) {}
  }

  function takeSnapshot() {
    try {
      emitWorld();
      return {
        version: VERSION,
        pageErrors: pageErrorPayload(),
        longTasks: longTasksPayload()
      };
    } catch (e) {
      return { version: VERSION };
    }
  }

  function poll() {
    try { bindHooks(); } catch (e) {}
    try { bindSocket(); } catch (e2) {}
    if (hooksBound && socketBound) return;
    pollN += 1;
    if (pollN >= 400) return;
    try { setTimeout(poll, pollN < 100 ? 100 : 500); } catch (e3) {}
  }

  var progressTimer = null;

  function stopProgress() {
    if (progressTimer != null) {
      try { clearTimeout(progressTimer); } catch (e) {}
      progressTimer = null;
    }
  }

  function sumCollections(g) {
    var i = 0;
    var total = 0;
    for (i = 0; i < SIZE_KEYS.length; i++) total += readSize(g, SIZE_KEYS[i]);
    total += readSize(g, 'packs');
    return total;
  }

  function emitProgress() {
    var g = null;
    var tex = null;
    var packages = 0;
    if (readySeen || seenPhase.ready) {
      stopProgress();
      return;
    }
    try { g = window.game; } catch (e) { g = null; }
    try { packages = hookTimePayload().packages; } catch (e2) { packages = 0; }
    try { tex = readTextures(); } catch (e3) { tex = { loaded: null, total: null }; }
    if (!tex) tex = { loaded: null, total: null };
    emit({
      type: 'progress',
      requests: totals.requests,
      cachedRequests: totals.cachedRequests,
      docs: sumCollections(g),
      packages: packages,
      packagesTotal: countActiveModules(g),
      textures: tex.loaded,
      texturesTotal: tex.total,
      at: nowMs()
    });
  }

  function armProgress() {
    if (progressTimer != null || readySeen || seenPhase.ready) return;
    try {
      progressTimer = setTimeout(function tick() {
        progressTimer = null;
        try { emitProgress(); } catch (e) {}
        if (readySeen || seenPhase.ready) return;
        try { progressTimer = setTimeout(tick, 250); } catch (e2) {}
      }, 250);
    } catch (e3) {}
  }

  function install() {
    window.__flcTelemetry = {
      version: VERSION,
      start: start,
      stop: stop,
      snapshot: takeSnapshot,
      step: stepInfo,
      active: activeInfo
    };
    trapHooks();
    trapIo();
    startResourceObserver();
    beginLongTasks();
    bindPageErrors();
    try {
      if (document && document.readyState === 'loading' && document.addEventListener) {
        document.addEventListener('DOMContentLoaded', function () { onPhase('domReady', false); });
      } else {
        onPhase('domReady', false);
      }
    } catch (e) {
      onPhase('domReady', false);
    }
    poll();
    if (!readySeen) armProgress();
  }

  try {
    if (window.__flcTelemetry && window.__flcTelemetry.version === VERSION) return;
    install();
  } catch (e) {}
})();`;

/**
 * Build the injected telemetry probe. `opts` is ignored so caller strings
 * cannot be interpolated into the page.
 * @param {object} [opts]
 * @returns {string}
 */
function buildTelemetryScript(opts) {
  void opts;
  return TELEMETRY_SCRIPT.replace('__FLC_TELEMETRY_VERSION__', String(TELEMETRY_VERSION));
}

/**
 * Insert a Details control and a join clock beside Foundry's loading-card Hide link.
 * When a loading notice says startup is taking longer, replace that sentence with
 * this join's elapsed time and, when known, this server's usual duration.
 * Reads those two labels only to find the nodes; sends no text.
 * @returns {string}
 */
function buildLoadingDetailsScript() {
  return `(function () {
  try {
    if (window.__flcLoadingDetails) return;
    var anchor = null;
    var typical = 0;
    var joinCount = 0;
    var placed = false;
    var stopped = false;
    var writing = false;
    var detailsEl = null;
    var clockEl = null;
    var overlayEl = null;
    var slowEl = null;
    var slowStamp = '';
    var bodyObserver = null;
    var overlayObserver = null;
    var clockTimer = null;
    var searchTimer = null;
    var lifeTimer = null;

    function nowMs() {
      try {
        if (typeof performance !== 'undefined' && performance && typeof performance.now === 'function') {
          var n = performance.now();
          if (typeof n === 'number' && isFinite(n)) return n;
        }
      } catch (e) {}
      return 0;
    }

    function nodeText(el) {
      try {
        if (!el || el.textContent == null) return '';
        return String(el.textContent);
      } catch (e2) {
        return '';
      }
    }

    function classText(el) {
      var cls = '';
      try {
        if (el && typeof el.className === 'string') cls = el.className;
      } catch (e3) {}
      return cls;
    }

    function hasLoadMark(el) {
      var id = '';
      var role = '';
      if (!el || el === document) return false;
      try { id = el.id ? String(el.id) : ''; } catch (e1) {}
      try { role = el.getAttribute ? (el.getAttribute('role') || '') : ''; } catch (e2) {}
      return (classText(el) + ' ' + id + ' ' + role).toLowerCase().indexOf('load') >= 0;
    }

    function attached(el) {
      var cur = el;
      var guard = 0;
      if (!el) return false;
      while (cur && guard < 48) {
        if (cur === document || cur === document.body || cur === document.documentElement) return true;
        cur = cur.parentNode;
        guard += 1;
      }
      return false;
    }

    function finishedTree() {
      var cur = overlayEl;
      var guard = 0;
      while (cur && cur !== document && guard < 24) {
        if (classText(cur).toLowerCase().indexOf('finished') >= 0) return true;
        cur = cur.parentElement || cur.parentNode;
        guard += 1;
      }
      return false;
    }

    function shouldStop() {
      if (!placed) return false;
      if (!overlayEl || !attached(overlayEl)) return true;
      if (!detailsEl || !attached(detailsEl)) return true;
      if (finishedTree()) return true;
      return false;
    }

    function fmt(ms) {
      var sec = Math.round(ms / 1000);
      var m = 0;
      var s = 0;
      if (!isFinite(sec) || sec < 0) sec = 0;
      m = Math.floor(sec / 60);
      s = sec - (m * 60);
      return m + ':' + (s < 10 ? '0' : '') + s;
    }

    function elapsedNow() {
      var d = 0;
      if (anchor == null) return 0;
      d = nowMs() - anchor;
      if (typeof d !== 'number' || !isFinite(d) || d < 0) return 0;
      return d;
    }

    function etaSeconds(remainMs) {
      var sec = remainMs / 1000;
      var rounded = 0;
      if (!isFinite(sec) || sec < 0) sec = 0;
      rounded = Math.round(sec / 5) * 5;
      if (!isFinite(rounded) || rounded < 0) rounded = 0;
      return rounded;
    }

    function joinHead() {
      var step = null;
      var active = null;
      var index = 0;
      var names = ['', 'connecting', 'loading page', 'receiving world data', 'initializing', 'loading languages', 'setting up world', 'drawing scene', 'ready'];
      var head = '';
      var pkg = '';
      try {
        if (window.__flcTelemetry && typeof window.__flcTelemetry.step === 'function') step = window.__flcTelemetry.step();
      } catch (e0) { step = null; }
      if (!step || typeof step.index !== 'number' || !isFinite(step.index)) return '';
      index = Math.round(step.index);
      if (index < 1 || index > 8) return '';
      head = 'Step ' + index + '/8 · ' + names[index];
      try {
        if (window.__flcTelemetry && typeof window.__flcTelemetry.active === 'function') active = window.__flcTelemetry.active();
      } catch (e1) { active = null; }
      pkg = active && typeof active.package === 'string' ? active.package : '';
      if (/^[A-Za-z0-9._-]{1,64}$/.test(pkg)) head = head + ' · ' + pkg;
      return head + ' · ';
    }

    function clockLine() {
      var el = elapsedNow();
      var shown = fmt(el);
      var usual = '';
      var body = '';
      if (!(typical > 0)) body = shown + ' · first join here, no estimate yet';
      else {
        usual = fmt(typical);
        if (el < typical) body = shown + ' · usually ~' + usual + ' · about ' + etaSeconds(typical - el) + ' s left';
        else if (el < typical * 1.8) body = shown + ' · usually ~' + usual + ' · a bit longer than usual';
        else body = shown + ' · usually ~' + usual + ' · slower than usual';
      }
      return joinHead() + body;
    }

    function slowLine() {
      var el = elapsedNow();
      var shown = fmt(el);
      var usual = '';
      if (!(typical > 0)) {
        return 'Still loading — ' + shown + ' so far. First join on this server; later joins will show an estimate.';
      }
      usual = fmt(typical);
      if (el < typical * 1.8) {
        return 'Still loading — ' + shown + ' so far; this server usually takes about ' + usual + '.';
      }
      return 'This join is slower than usual for this server (' + shown + ' so far, usually about ' + usual + '). Open Details for what is taking time.';
    }

    function isCanned(el) {
      return /^Startup is taking longer/.test(nodeText(el));
    }

    function findCanned(root) {
      var best = null;
      var bestDepth = -1;
      function visit(el, depth) {
        var kids = null;
        var i = 0;
        if (!el || depth > 24) return;
        try {
          if (el !== root && depth > bestDepth && isCanned(el)) {
            best = el;
            bestDepth = depth;
          }
          kids = el.children;
        } catch (e) {
          kids = null;
        }
        if (!kids || typeof kids.length !== 'number') return;
        for (i = 0; i < kids.length; i++) visit(kids[i], depth + 1);
      }
      if (root) visit(root, 0);
      return best;
    }

    function setText(el, next) {
      if (!el || writing) return;
      if (nodeText(el) === next) return;
      writing = true;
      try { el.textContent = next; } catch (e) {}
      writing = false;
    }

    function refreshClock() {
      if (stopped || !clockEl) return;
      setText(clockEl, clockLine());
    }

    function refreshSlow() {
      var el = null;
      var next = '';
      var cur = '';
      if (writing || stopped || !overlayEl) return;
      el = findCanned(overlayEl);
      if (!el && slowEl && nodeText(slowEl) === slowStamp) el = slowEl;
      if (!el) return;
      next = slowLine();
      cur = nodeText(el);
      if (cur === next) {
        slowEl = el;
        slowStamp = next;
        return;
      }
      if (!isCanned(el) && cur !== slowStamp) return;
      setText(el, next);
      if (nodeText(el) === next) {
        slowEl = el;
        slowStamp = next;
      }
    }

    function applyJoin(elapsedMs, typicalMs, joins) {
      var now = nowMs();
      var elapsed = 0;
      if (typeof elapsedMs === 'number' && isFinite(elapsedMs)) {
        elapsed = elapsedMs < 0 ? 0 : elapsedMs;
        anchor = now - elapsed;
      }
      if (typicalMs === 0 || typicalMs === null) {
        typical = 0;
      } else if (typeof typicalMs === 'number' && isFinite(typicalMs)) {
        typical = typicalMs > 0 ? typicalMs : 0;
      }
      if (typeof joins === 'number' && isFinite(joins)) joinCount = joins < 0 ? 0 : joins;
      if (placed && !stopped) {
        refreshClock();
        refreshSlow();
      }
    }

    function findHide() {
      var nodes = [];
      var i = 0;
      var n = null;
      var text = '';
      var anc = null;
      var guard = 0;
      try { nodes = document.querySelectorAll('a, button'); } catch (e) { return null; }
      for (i = 0; i < nodes.length; i++) {
        n = nodes[i];
        text = '';
        try { text = String(n.textContent || '').trim(); } catch (e2) { text = ''; }
        if (text !== 'Hide') continue;
        anc = n.parentElement || n.parentNode;
        guard = 0;
        while (anc && guard < 16) {
          if (hasLoadMark(anc)) return n;
          anc = anc.parentElement || anc.parentNode;
          guard += 1;
        }
      }
      return null;
    }

    function overlayOf(hide) {
      var anc = hide ? (hide.parentElement || hide.parentNode) : null;
      var guard = 0;
      while (anc && guard < 16) {
        if (hasLoadMark(anc)) return anc;
        anc = anc.parentElement || anc.parentNode;
        guard += 1;
      }
      return hide ? hide.parentNode : null;
    }

    function makeClock() {
      var span = document.createElement('span');
      span.setAttribute('data-flc-join-clock', '1');
      span.setAttribute('style', 'margin-left:0.75em;opacity:0.7;font-variant-numeric:tabular-nums');
      return span;
    }

    function insertAfter(node, after) {
      if (!node || !after || !after.parentNode) return;
      if (after.nextSibling) after.parentNode.insertBefore(node, after.nextSibling);
      else after.parentNode.appendChild(node);
    }

    function stopAll() {
      stopped = true;
      if (bodyObserver) {
        try { bodyObserver.disconnect(); } catch (e) {}
        bodyObserver = null;
      }
      if (overlayObserver) {
        try { overlayObserver.disconnect(); } catch (e2) {}
        overlayObserver = null;
      }
      if (clockTimer != null) {
        try { clearInterval(clockTimer); } catch (e3) {}
        clockTimer = null;
      }
      if (searchTimer != null) {
        try { clearTimeout(searchTimer); } catch (e4) {}
        searchTimer = null;
      }
      if (lifeTimer != null) {
        try { clearTimeout(lifeTimer); } catch (e5) {}
        lifeTimer = null;
      }
    }

    function beginTracking() {
      if (stopped) return;
      if (bodyObserver) {
        try { bodyObserver.disconnect(); } catch (e) {}
        bodyObserver = null;
      }
      if (overlayEl && typeof MutationObserver !== 'undefined' && !overlayObserver) {
        overlayObserver = new MutationObserver(function () {
          if (writing) return;
          try {
            if (shouldStop()) {
              stopAll();
              return;
            }
            refreshSlow();
          } catch (e1) {}
        });
        try {
          overlayObserver.observe(overlayEl, { childList: true, characterData: true, subtree: true });
        } catch (e2) {}
      }
      refreshClock();
      refreshSlow();
      if (shouldStop()) {
        stopAll();
        return;
      }
      if (clockTimer == null && typeof setInterval === 'function') {
        try { clockTimer = setInterval(function () { onTick(); }, 1000); } catch (e3) {}
      }
      if (lifeTimer == null && typeof setTimeout === 'function') {
        try { lifeTimer = setTimeout(function () { stopAll(); }, 900000); } catch (e4) {}
      }
    }

    function onTick() {
      try {
        if (stopped) return;
        if (shouldStop()) {
          stopAll();
          return;
        }
        refreshClock();
        refreshSlow();
      } catch (e) {}
    }

    function place() {
      var hide = null;
      var a = null;
      var root = null;
      if (placed) return true;
      hide = findHide();
      if (!hide || !hide.parentNode) return false;
      root = overlayOf(hide);
      try {
        if (hide.parentNode.querySelector && hide.parentNode.querySelector('[data-flc-details]')) {
          detailsEl = hide.parentNode.querySelector('[data-flc-details]');
          try { clockEl = hide.parentNode.querySelector('[data-flc-join-clock]'); } catch (e1) { clockEl = null; }
          if (!clockEl) {
            clockEl = makeClock();
            insertAfter(clockEl, detailsEl || hide);
          }
          overlayEl = root;
          placed = true;
          return true;
        }
      } catch (e0) {}
      a = document.createElement('a');
      a.setAttribute('data-flc-details', '1');
      a.setAttribute('style', 'margin-left:0.75em;cursor:pointer;opacity:0.7');
      a.setAttribute('title', 'Show join details');
      a.title = 'Show join details';
      a.textContent = 'Details';
      a.addEventListener('click', function (ev) {
        try {
          if (ev && typeof ev.preventDefault === 'function') ev.preventDefault();
          if (window.flcGame && typeof window.flcGame.openStats === 'function') window.flcGame.openStats();
        } catch (e1) {}
      });
      insertAfter(a, hide);
      clockEl = makeClock();
      insertAfter(clockEl, a);
      detailsEl = a;
      overlayEl = root;
      placed = true;
      return true;
    }

    function tickSearch() {
      try {
        if (stopped || placed) return;
        if (place()) beginTracking();
      } catch (e) {}
    }

    window.__flcLoadingDetails = {
      version: 1,
      setJoin: function (elapsedMs, typicalMs, joins) {
        try { applyJoin(elapsedMs, typicalMs, joins); } catch (e) {}
      }
    };

    if (document.body && typeof MutationObserver !== 'undefined') {
      bodyObserver = new MutationObserver(function () {
        if (writing) return;
        tickSearch();
      });
      try { bodyObserver.observe(document.body, { childList: true, subtree: true }); } catch (e) {}
    }
    if (typeof setTimeout === 'function') {
      searchTimer = setTimeout(function () {
        if (!placed && bodyObserver) {
          try { bodyObserver.disconnect(); } catch (e2) {}
          bodyObserver = null;
        }
      }, 60000);
    }
    tickSearch();
  } catch (e) {}
})();`;
}

const MAX_LOOKUP_PATHS = 200;
const MAX_LOOKUP_CHARS = 2048;

/**
 * ES5 page script. `paths` is embedded with JSON.stringify so it is data, not
 * source. The script matches decoded pathnames and returns `{ [path]: string[] }`.
 * @param {unknown} paths
 * @returns {string}
 */
function buildReferenceLookupScript(paths) {
  const clean = [];
  const list = Array.isArray(paths) ? paths : [];
  for (let i = 0; i < list.length && clean.length < MAX_LOOKUP_PATHS; i += 1) {
    const item = list[i];
    if (typeof item !== 'string' || !item || item.length > MAX_LOOKUP_CHARS) continue;
    clean.push(item);
  }
  return `(function (paths) {
  var MAX_REFS = 5;
  var MAX_DOCS = 20000;
  var out = Object.create(null);
  try {
    function pathnameOf(value) {
      try {
        if (typeof value !== 'string' || !value || value.length > 2048) return '';
        var parsed = new URL(value, location.href);
        var path = parsed.pathname || '';
        try { path = decodeURIComponent(path); } catch (e) {}
        return path;
      } catch (e2) {
        return '';
      }
    }

    function considerPaths() {
      try {
        var incoming = paths;
        var count = 0;
        if (!incoming || typeof incoming.length !== 'number') return;
        for (var i = 0; i < incoming.length && count < 200; i++) {
          try {
            var raw = incoming[i];
            if (typeof raw !== 'string' || !raw || raw.length > 2048) continue;
            var key = pathnameOf(raw) || raw;
            if (Object.prototype.hasOwnProperty.call(out, key)) continue;
            out[key] = [];
            count++;
          } catch (e) {}
        }
      } catch (e2) {}
    }

    function capped() {
      try {
        var keys = Object.keys(out);
        if (!keys.length) return false;
        for (var i = 0; i < keys.length; i++) {
          var arr = out[keys[i]];
          if (!arr || arr.length < MAX_REFS) return false;
        }
        return true;
      } catch (e) {
        return false;
      }
    }

    function addRef(key, label) {
      try {
        if (!key || !label || !Object.prototype.hasOwnProperty.call(out, key)) return;
        var arr = out[key];
        if (!arr || arr.length >= MAX_REFS) return;
        for (var i = 0; i < arr.length; i++) {
          if (arr[i] === label) return;
        }
        arr.push(label);
      } catch (e) {}
    }

    function consider(value, label) {
      try {
        var key = pathnameOf(value);
        if (key) addRef(key, label);
      } catch (e) {}
    }

    function docName(doc) {
      try {
        if (!doc) return '';
        var name = doc['name'];
        return typeof name === 'string' ? name : '';
      } catch (e) {
        return '';
      }
    }

    function child(doc, a, b, c) {
      try {
        var cur = doc;
        if (cur == null) return '';
        cur = cur[a];
        if (b) {
          if (cur == null) return '';
          cur = cur[b];
        }
        if (c) {
          if (cur == null) return '';
          cur = cur[c];
        }
        return typeof cur === 'string' ? cur : '';
      } catch (e) {
        return '';
      }
    }

    function walk(collection, fn) {
      var checked = 0;
      try {
        if (!collection || capped()) return;
        var list = null;
        if (Object.prototype.toString.call(collection) === '[object Array]') list = collection;
        else if (collection['contents'] && typeof collection['contents'] !== 'function' && typeof collection['contents'].length === 'number') {
          list = collection['contents'];
        }
        if (list) {
          var limit = list.length > MAX_DOCS ? MAX_DOCS : list.length;
          for (var i = 0; i < limit; i++) {
            if (capped()) return;
            checked++;
            try { fn(list[i]); } catch (e1) {}
          }
          return;
        }
        if (typeof collection.forEach === 'function') {
          collection.forEach(function (doc) {
            if (checked >= MAX_DOCS || capped()) return;
            checked++;
            try { fn(doc); } catch (e2) {}
          });
        }
      } catch (e) {}
    }

    considerPaths();

    var g = null;
    try { g = game; } catch (e) { g = null; }
    if (g) {
      try {
        walk(g['scenes'], function (scene) {
          var sname = docName(scene);
          consider(child(scene, 'background', 'src'), 'Scene \\u201c' + sname + '\\u201d background');
          consider(child(scene, 'foreground', 'src'), 'Scene \\u201c' + sname + '\\u201d foreground');
          var tokens = null;
          var tiles = null;
          var sounds = null;
          try { tokens = scene['tokens']; } catch (e1) {}
          try { tiles = scene['tiles']; } catch (e2) {}
          try { sounds = scene['sounds']; } catch (e3) {}
          walk(tokens, function (token) {
            consider(child(token, 'texture', 'src'), 'Token \\u201c' + docName(token) + '\\u201d on scene \\u201c' + sname + '\\u201d');
          });
          walk(tiles, function (tile) {
            consider(child(tile, 'texture', 'src'), 'Tile on scene \\u201c' + sname + '\\u201d');
          });
          walk(sounds, function (sound) {
            consider(child(sound, 'path'), 'Ambient sound on scene \\u201c' + sname + '\\u201d');
          });
        });
      } catch (e) {}

      try {
        walk(g['actors'], function (actor) {
          var aname = docName(actor);
          consider(child(actor, 'img'), 'Actor \\u201c' + aname + '\\u201d image');
          consider(child(actor, 'prototypeToken', 'texture', 'src'), 'Actor \\u201c' + aname + '\\u201d prototype token');
          var items = null;
          try { items = actor['items']; } catch (e1) {}
          walk(items, function (item) {
            consider(child(item, 'img'), 'Item \\u201c' + docName(item) + '\\u201d on actor \\u201c' + aname + '\\u201d');
          });
        });
      } catch (e) {}

      try {
        walk(g['items'], function (item) {
          consider(child(item, 'img'), 'Item \\u201c' + docName(item) + '\\u201d image');
        });
      } catch (e) {}

      try {
        walk(g['journal'], function (journal) {
          var jname = docName(journal);
          var pages = null;
          try { pages = journal['pages']; } catch (e1) {}
          walk(pages, function (page) {
            var kind = '';
            try { kind = page['type']; } catch (e2) {}
            if (kind !== 'image' && kind !== 'video') return;
            consider(child(page, 'src'), 'Journal \\u201c' + jname + '\\u201d page \\u201c' + docName(page) + '\\u201d');
          });
        });
      } catch (e) {}

      try {
        walk(g['playlists'], function (playlist) {
          var pname = docName(playlist);
          var tracks = null;
          try { tracks = playlist['sounds']; } catch (e1) {}
          walk(tracks, function (track) {
            consider(child(track, 'path'), 'Playlist \\u201c' + pname + '\\u201d track \\u201c' + docName(track) + '\\u201d');
          });
        });
      } catch (e) {}

      try {
        walk(g['macros'], function (macro) {
          consider(child(macro, 'img'), 'Macro \\u201c' + docName(macro) + '\\u201d image');
        });
      } catch (e) {}

      try {
        walk(g['users'], function (user) {
          consider(child(user, 'avatar'), 'User avatar');
        });
      } catch (e) {}

      try {
        walk(g['cards'], function (stack) {
          consider(child(stack, 'img'), 'Cards \\u201c' + docName(stack) + '\\u201d image');
        });
      } catch (e) {}
    }

    try {
      if (document && document.querySelectorAll && !capped()) {
        var nodes = document.querySelectorAll('img[src], video[src], audio[src], source[src]');
        var domLimit = nodes && typeof nodes.length === 'number' ? nodes.length : 0;
        if (domLimit > MAX_DOCS) domLimit = MAX_DOCS;
        for (var d = 0; d < domLimit; d++) {
          if (capped()) break;
          try {
            var el = nodes[d];
            if (!el) continue;
            var src = '';
            try { src = el.getAttribute ? el.getAttribute('src') : ''; } catch (e1) {}
            if (!src) {
              try { src = el.src || ''; } catch (e2) {}
            }
            var tag = 'element';
            try { if (el.tagName) tag = String(el.tagName).toLowerCase(); } catch (e3) {}
            var label = tag + ' element in the page';
            try {
              var node = el;
              var hops = 0;
              while (node && hops < 30) {
                var cls = '';
                try {
                  if (typeof node.className === 'string') cls = node.className;
                  else if (node.className && typeof node.className.baseVal === 'string') cls = node.className.baseVal;
                } catch (e4) {}
                if (cls.indexOf('window-app') !== -1 || cls.indexOf('app') !== -1) {
                  var title = '';
                  try {
                    var titleEl = node.querySelector ? node.querySelector('.window-title') : null;
                    if (titleEl && titleEl.textContent) {
                      title = String(titleEl.textContent);
                      var start = 0;
                      var end = title.length;
                      while (start < end && (title.charAt(start) === ' ' || title.charAt(start) === '\\n' || title.charAt(start) === '\\r' || title.charAt(start) === '\\t')) start++;
                      while (end > start && (title.charAt(end - 1) === ' ' || title.charAt(end - 1) === '\\n' || title.charAt(end - 1) === '\\r' || title.charAt(end - 1) === '\\t')) end--;
                      title = title.substring(start, end);
                    }
                  } catch (e5) {}
                  if (title) {
                    label = tag + ' element in the page in window \\u201c' + title + '\\u201d';
                    break;
                  }
                }
                node = node.parentElement || null;
                hops++;
              }
            } catch (e6) {}
            consider(src, label);
          } catch (e7) {}
        }
      }
    } catch (e) {}
  } catch (e) {}
  return out;
})(${JSON.stringify(clean)})`;
}

module.exports = {
  TELEMETRY_VERSION,
  buildTelemetryScript,
  buildLoadingDetailsScript,
  buildReferenceLookupScript,
};
