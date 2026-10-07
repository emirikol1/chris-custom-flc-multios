'use strict';

/**
 * One join collector per game window. Electron stays outside: the caller
 * passes a clock, a logger, join history, and the issue detector.
 * Listeners are throttled to one call per 1000 ms. Problem-log updates use
 * that same cadence. The ready phase logs one summary and records history
 * once per load.
 */

const { shortServerHash } = require('./log-ids');
const { safeProfileLabel } = require('./problem-log');
const {
  PHASES,
  createCollector,
  formatJoinSummary,
  summarizeForHistory,
  compareWithHistory,
} = require('./join-telemetry');
const { summarizeFindings } = require('./issue-detector');

const THROTTLE_MS = 1000;

/**
 * @param {{
 *   now?: () => number,
 *   log?: { info?: Function, debug?: Function, warn?: Function },
 *   history?: { record?: Function, list?: Function },
 *   detector?: Function,
 *   thresholds?: object,
 *   problemLog?: { observe?: Function, closeServer?: Function },
 *   profileFor?: (serverId: string) => string,
 * }} [opts]
 */
function createTelemetryHub(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const log = options.log && typeof options.log === 'object' ? options.log : {};
  const history = options.history && typeof options.history === 'object' ? options.history : null;
  const detector = typeof options.detector === 'function' ? options.detector : () => [];
  const thresholds = options.thresholds && typeof options.thresholds === 'object' ? options.thresholds : undefined;
  const problemLog = options.problemLog && typeof options.problemLog === 'object' ? options.problemLog : null;
  const profileFor = typeof options.profileFor === 'function' ? options.profileFor : null;

  /** @type {Map<string, object>} */
  const collectors = new Map();
  /** @type {Map<string, number>} */
  const lastProblemAt = new Map();

  function now() {
    try {
      const n = clock();
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    } catch {
      /* fall through */
    }
    return Date.now();
  }

  /**
   * @param {unknown} err
   */
  function warn(err) {
    const name = err && err.name ? String(err.name) : 'Error';
    try {
      if (typeof log.warn === 'function') log.warn(name);
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {object} ctx
   * @param {object} [extras]
   */
  function buildPayload(ctx, extras) {
    const extra = extras && typeof extras === 'object' ? extras : {};
    const snap = ctx.collector.snapshot();
    let list = [];
    try {
      if (ctx.serverId && history && typeof history.list === 'function') {
        const rows = history.list(ctx.serverId);
        if (Array.isArray(rows)) list = rows;
      }
    } catch (err) {
      warn(err);
      list = [];
    }
    const speedIndex = typeof extra.speedIndex === 'number' && Number.isFinite(extra.speedIndex)
      ? extra.speedIndex
      : null;
    const sampling = typeof extra.sampling === 'boolean' ? extra.sampling : ctx.sampling === true;
    const intervalMs = typeof extra.intervalMs === 'number' && Number.isFinite(extra.intervalMs) && extra.intervalMs > 0
      ? extra.intervalMs
      : (ctx.intervalMs > 0 ? ctx.intervalMs : 5000);
    const baselineReady = list.length >= 3;
    let findings = [];
    try {
      const found = detector(snap, {
        thresholds,
        systemInfo: extra.systemInfo || null,
        history: list,
        baselineReady,
        speedIndex,
      });
      if (Array.isArray(found)) findings = found;
    } catch (err) {
      warn(err);
      findings = [];
    }
    let summary = '';
    try {
      summary = summarizeFindings(findings);
    } catch (err) {
      warn(err);
      summary = '';
    }
    return {
      serverHash: shortServerHash(ctx.serverId),
      snapshot: snap,
      findings,
      summary,
      history: list.slice(-10),
      compare: compareWithHistory(snap, list),
      baseline: {
        joins: list.length,
        ready: baselineReady,
        needed: 3,
        speedIndex,
      },
      live: {
        sampling,
        intervalMs,
      },
      updatedAt: now(),
    };
  }

  /**
   * @param {object} ctx
   */
  function flush(ctx) {
    if (ctx.emitTimer) {
      clearTimeout(ctx.emitTimer);
      ctx.emitTimer = null;
    }
    ctx.dirty = false;
    ctx.lastEmitAt = now();
    let body = null;
    try {
      body = buildPayload(ctx, {
        sampling: ctx.sampling,
        intervalMs: ctx.intervalMs,
      });
    } catch (err) {
      warn(err);
    }
    if (body) noteProblems(ctx, body);
    const listeners = ctx.listeners.slice();
    for (let i = 0; i < listeners.length; i += 1) {
      try {
        listeners[i](body);
      } catch (err) {
        warn(err);
      }
    }
  }

  /**
   * @param {object} ctx
   */
  function emitChange(ctx) {
    ctx.dirty = true;
    const stamp = now();
    const elapsed = ctx.lastEmitAt == null ? THROTTLE_MS : stamp - ctx.lastEmitAt;
    if (elapsed >= THROTTLE_MS) {
      flush(ctx);
      return;
    }
    if (ctx.emitTimer) return;
    const wait = Math.max(0, THROTTLE_MS - elapsed);
    ctx.emitTimer = setTimeout(() => {
      ctx.emitTimer = null;
      if (ctx.dirty) flush(ctx);
    }, wait);
  }

  /**
   * @param {object} ctx
   * @returns {string}
   */
  function serverKeyFor(ctx) {
    return typeof ctx.serverId === 'string' && ctx.serverId ? ctx.serverId : ctx.id;
  }

  /**
   * One problem-log sample per server per throttle window. `body` is the
   * payload just built for the listener flush.
   * @param {object} ctx
   * @param {object} body
   */
  function noteProblems(ctx, body) {
    if (!problemLog || typeof problemLog.observe !== 'function') return;
    const serverKey = serverKeyFor(ctx);
    const stamp = now();
    const prev = lastProblemAt.get(serverKey);
    if (typeof prev === 'number' && stamp - prev < THROTTLE_MS) return;
    lastProblemAt.set(serverKey, stamp);
    const snap = body && body.snapshot && typeof body.snapshot === 'object' ? body.snapshot : {};
    const world = snap.world && typeof snap.world === 'object' ? snap.world : {};
    const system = world.system && typeof world.system === 'object' ? world.system : {};
    let label = typeof ctx.label === 'string' ? ctx.label : '';
    if (!label && profileFor) {
      try {
        const got = profileFor(ctx.serverId);
        if (typeof got === 'string') label = got;
      } catch (err) {
        warn(err);
      }
    }
    const serverHash = shortServerHash(ctx.serverId);
    try {
      problemLog.observe(serverKey, {
        profile: safeProfileLabel(label, serverHash),
        serverHash,
        foundryVersion: typeof world.foundryVersion === 'string' ? world.foundryVersion : null,
        systemId: typeof system.id === 'string' ? system.id : null,
        systemVersion: typeof system.version === 'string' ? system.version : null,
      }, Array.isArray(body.findings) ? body.findings : []);
    } catch (err) {
      warn(err);
    }
  }

  /**
   * @param {object} ctx
   * @param {object} snap
   */
  function debugPhases(ctx, snap) {
    const prev = ctx.lastPhases || {};
    const next = snap && snap.phases ? snap.phases : {};
    ctx.lastPhases = Object.assign({}, next);
    if (typeof log.debug !== 'function') return;
    for (let i = 0; i < PHASES.length; i += 1) {
      const name = PHASES[i];
      if (next[name] != null && next[name] !== prev[name]) {
        try {
          log.debug('join phase', { phase: name, server: shortServerHash(ctx.serverId) });
        } catch {
          /* ignore */
        }
      }
    }
  }

  /**
   * Log and record the first ready phase of this load.
   * @param {object} ctx
   */
  function noteReady(ctx) {
    let snap;
    try {
      snap = ctx.collector.snapshot();
    } catch (err) {
      warn(err);
      return;
    }
    debugPhases(ctx, snap);
    const ready = snap.phases && snap.phases.ready != null;
    if (!ready || ctx.readyLogged) return;
    ctx.readyLogged = true;
    try {
      if (typeof log.info === 'function') log.info(formatJoinSummary(snap));
    } catch (err) {
      warn(err);
    }
    try {
      if (ctx.serverId && history && typeof history.record === 'function') {
        history.record(ctx.serverId, summarizeForHistory(snap));
      }
    } catch (err) {
      warn(err);
    }
  }

  /**
   * @param {string} id
   * @param {{ serverId?: string, label?: string }} [info]
   */
  function attach(id, info) {
    if (typeof id !== 'string' || !id) return null;
    detach(id);
    const serverId = info && typeof info.serverId === 'string' ? info.serverId : '';
    const label = info && typeof info.label === 'string' ? info.label : '';
    const ctx = {
      id,
      serverId,
      label,
      collector: createCollector({ now }),
      listeners: [],
      readyLogged: false,
      lastPhases: {},
      lastEmitAt: null,
      emitTimer: null,
      dirty: false,
      sampling: false,
      intervalMs: 5000,
    };
    collectors.set(id, ctx);
    return ctx;
  }

  /**
   * @param {string} id
   */
  function detach(id) {
    const ctx = collectors.get(id);
    if (!ctx) return;
    if (ctx.emitTimer) {
      clearTimeout(ctx.emitTimer);
      ctx.emitTimer = null;
    }
    ctx.listeners = [];
    const serverKey = serverKeyFor(ctx);
    lastProblemAt.delete(serverKey);
    collectors.delete(id);
    if (problemLog && typeof problemLog.closeServer === 'function') {
      try {
        problemLog.closeServer(serverKey, 'closed');
      } catch (err) {
        warn(err);
      }
    }
  }

  /**
   * @param {string} id
   * @returns {object | null}
   */
  function ctxFor(id) {
    return collectors.get(id) || null;
  }

  /**
   * @param {string} id
   * @param {string} phase
   * @param {number} [atMs]
   */
  function mark(id, phase, atMs) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.mark(phase, atMs);
    noteReady(ctx);
    emitChange(ctx);
  }

  /**
   * @param {string} id
   * @param {object} payloadIn
   */
  function ingest(id, payloadIn) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.ingest(payloadIn);
    noteReady(ctx);
    emitChange(ctx);
  }

  /**
   * @param {string} id
   */
  function newDocument(id) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.newDocument();
    ctx.readyLogged = false;
    try {
      ctx.lastPhases = Object.assign({}, ctx.collector.snapshot().phases);
    } catch {
      ctx.lastPhases = {};
    }
    emitChange(ctx);
  }

  /**
   * @param {string} id
   * @param {number} loadSeq
   */
  function resetLoad(id, loadSeq) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.reset(loadSeq);
    ctx.readyLogged = false;
    ctx.lastPhases = {};
    emitChange(ctx);
  }

  /**
   * @param {string} id
   * @param {string} name
   */
  function netError(id, name) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.netError(name);
    emitChange(ctx);
  }

  /**
   * @param {string} id
   * @param {number} code
   */
  function httpStatus(id, code) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.httpStatus(code);
    emitChange(ctx);
  }

  /**
   * @param {string} id
   * @param {string} reason
   */
  function rendererGone(id, reason) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.rendererGone(reason);
    emitChange(ctx);
  }

  /**
   * @param {string} id
   */
  function unresponsive(id) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.unresponsive();
    emitChange(ctx);
  }

  /**
   * @param {string} id
   * @param {string | null} cause
   */
  function setSyncCause(id, cause) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.setSyncCause(cause);
    emitChange(ctx);
  }

  /**
   * @param {string} id
   * @param {object} partial
   */
  function setClient(id, partial) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.setClient(partial);
    emitChange(ctx);
  }

  /**
   * @param {string} id
   * @param {object} partial
   * @param {boolean} [notify] pass false to update the snapshot without a push
   */
  function resourcesUpdate(id, partial, notify) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.resourcesUpdate(partial);
    if (notify !== false) emitChange(ctx);
  }

  /**
   * @param {string} id
   * @param {number} ms
   */
  function setClockSkew(id, ms) {
    const ctx = ctxFor(id);
    if (!ctx) return;
    ctx.collector.setClockSkew(ms);
    emitChange(ctx);
  }

  /**
   * @param {string} id
   * @param {{ sampling?: boolean, intervalMs?: number }} live
   */
  function setLive(id, live) {
    const ctx = ctxFor(id);
    if (!ctx || !live || typeof live !== 'object') return;
    if (typeof live.sampling === 'boolean') ctx.sampling = live.sampling;
    if (typeof live.intervalMs === 'number' && Number.isFinite(live.intervalMs) && live.intervalMs > 0) {
      ctx.intervalMs = live.intervalMs;
    }
    emitChange(ctx);
  }

  /**
   * @param {string} id
   */
  function snapshot(id) {
    const ctx = ctxFor(id);
    if (!ctx) return null;
    try {
      return ctx.collector.snapshot();
    } catch (err) {
      warn(err);
      return null;
    }
  }

  /**
   * Stats payload without `system` and `cache` (the caller adds those).
   * @param {string} id
   * @param {object} [extras]
   */
  function payload(id, extras) {
    const ctx = ctxFor(id);
    if (!ctx) return null;
    try {
      return buildPayload(ctx, extras);
    } catch (err) {
      warn(err);
      return null;
    }
  }

  /**
   * @param {string} id
   * @param {(payload: object | null) => void} cb
   * @returns {() => void}
   */
  function onChange(id, cb) {
    const ctx = ctxFor(id);
    if (!ctx || typeof cb !== 'function') return () => {};
    ctx.listeners.push(cb);
    return () => {
      const index = ctx.listeners.indexOf(cb);
      if (index >= 0) ctx.listeners.splice(index, 1);
    };
  }

  return {
    attach,
    detach,
    ingest,
    mark,
    newDocument,
    resetLoad,
    netError,
    httpStatus,
    rendererGone,
    unresponsive,
    setSyncCause,
    setClient,
    resourcesUpdate,
    setClockSkew,
    setLive,
    snapshot,
    payload,
    onChange,
  };
}

module.exports = {
  THROTTLE_MS,
  createTelemetryHub,
};
