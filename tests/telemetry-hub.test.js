import { afterEach, describe, expect, it, vi } from 'vitest';
import { shortServerHash } from '../electron/log-ids.js';
import { createTelemetryHub } from '../electron/telemetry-hub.js';

function fakeHistory() {
  const rows = new Map();
  return {
    record(id, rec) {
      const list = rows.get(id) || [];
      list.push(rec);
      rows.set(id, list);
    },
    list(id) {
      return (rows.get(id) || []).map((row) => Object.assign({}, row));
    },
    rows,
  };
}

afterEach(() => {
  vi.useRealTimers();
});

describe('createTelemetryHub', () => {
  it('logs one join summary per ready load and records history', () => {
    const info = [];
    const debug = [];
    const history = fakeHistory();
    let t = 1000;
    const hub = createTelemetryHub({
      now: () => t,
      log: {
        info: (line) => info.push(line),
        debug: (line) => debug.push(line),
        warn: () => {},
      },
      history,
      detector: () => [],
    });
    hub.attach('w1', { serverId: 'srv-1' });
    hub.mark('w1', 'connect');
    t = 1500;
    hub.ingest('w1', { type: 'phase', name: 'ready', at: 0 });
    hub.ingest('w1', { type: 'phase', name: 'ready', at: 0 });
    expect(info).toHaveLength(1);
    expect(info[0].startsWith('join summary:')).toBe(true);
    expect(info.join('\n')).not.toContain('srv-1');
    expect(info.join('\n')).not.toContain('http');
    expect(history.rows.get('srv-1')).toHaveLength(1);
    expect(debug.some((line) => line === 'join phase')).toBe(true);

    hub.resetLoad('w1', 2);
    t = 2000;
    hub.mark('w1', 'connect');
    t = 2600;
    hub.ingest('w1', { type: 'phase', name: 'ready', at: 0 });
    expect(info).toHaveLength(2);
    expect(history.rows.get('srv-1')).toHaveLength(2);

    const body = hub.payload('w1', { speedIndex: 42, systemInfo: { cpuCount: 4 } });
    expect(Object.keys(body).sort()).toEqual([
      'baseline',
      'compare',
      'findings',
      'history',
      'live',
      'serverHash',
      'snapshot',
      'summary',
      'updatedAt',
    ]);
    expect(body.serverHash).toBe(shortServerHash('srv-1'));
    expect(body.baseline).toEqual({ joins: 2, ready: false, needed: 3, speedIndex: 42 });
    expect(body.system).toBeUndefined();
    expect(body.cache).toBeUndefined();
    expect(body.history).toHaveLength(2);
    expect(body.compare).toEqual(expect.objectContaining({
      thisMs: expect.any(Number),
    }));
    expect(body.live).toEqual({ sampling: false, intervalMs: 5000 });
    hub.detach('w1');
    hub.mark('w1', 'connect');
    expect(info).toHaveLength(2);
  });

  it('throttles change listeners to one per second', () => {
    vi.useFakeTimers();
    let t = 5000;
    const seen = [];
    const hub = createTelemetryHub({
      now: () => t,
      log: { info() {}, debug() {}, warn() {} },
      history: fakeHistory(),
      detector: () => [],
    });
    hub.attach('w', { serverId: 's' });
    hub.onChange('w', () => seen.push(t));
    hub.mark('w', 'connect');
    expect(seen).toEqual([5000]);
    t = 5500;
    hub.mark('w', 'joinPageLoaded');
    hub.netError('w', 'ERR_TIMED_OUT');
    expect(seen).toEqual([5000]);
    t = 6000;
    vi.advanceTimersByTime(500);
    expect(seen).toEqual([5000, 6000]);
    expect(hub.snapshot('w').net.errors.ERR_TIMED_OUT).toBe(1);
    hub.setLive('w', { sampling: true, intervalMs: 5000 });
    expect(hub.payload('w').live).toEqual({ sampling: true, intervalMs: 5000 });
  });

  it('reports a ready baseline after three recorded joins', () => {
    let t = 1000;
    const history = fakeHistory();
    const seen = [];
    const hub = createTelemetryHub({
      now: () => t,
      log: { info() {}, debug() {}, warn() {} },
      history,
      detector: (_snap, options) => {
        seen.push(options.baselineReady);
        return [];
      },
    });
    hub.attach('w1', { serverId: 'srv-1' });
    for (let i = 0; i < 3; i += 1) {
      hub.resetLoad('w1', i);
      t += 1000;
      hub.mark('w1', 'connect');
      t += 100;
      hub.ingest('w1', { type: 'phase', name: 'ready', at: 0 });
    }
    const body = hub.payload('w1');
    expect(body.baseline).toEqual({ joins: 3, ready: true, needed: 3, speedIndex: null });
    expect(seen[seen.length - 1]).toBe(true);
    expect(() => hub.ingest('missing', { type: 'phase', name: 'ready', at: 1 })).not.toThrow();
    expect(hub.payload('missing')).toBeNull();
  });

  it('observes problem-log findings with a sanitized profile and closes on detach', () => {
    const calls = [];
    const problemLog = {
      observe(serverKey, row, findings) {
        calls.push({
          type: 'observe',
          serverKey,
          row,
          ids: findings.map((item) => item.id),
        });
      },
      closeServer(serverKey, reason) {
        calls.push({ type: 'close', serverKey, reason });
      },
    };
    let t = 4000;
    const hub = createTelemetryHub({
      now: () => t,
      log: { info() {}, debug() {}, warn() {} },
      history: fakeHistory(),
      detector: () => [{
        id: 'server-slow',
        category: 'server',
        severity: 'warn',
        title: 'Slow',
        evidence: 'ms=9',
        suggestion: 'wait',
      }],
      problemLog,
    });
    hub.attach('w1', { serverId: 'srv-1', label: 'https://exandria.example.net/' });
    hub.ingest('w1', {
      type: 'world',
      at: 1,
      foundryVersion: '13.348',
      system: { id: 'dnd5e', version: '5.3.3' },
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({
      type: 'observe',
      serverKey: 'srv-1',
      ids: ['server-slow'],
    });
    expect(calls[0].row.profile).toBe(shortServerHash('srv-1'));
    expect(calls[0].row.serverHash).toBe(shortServerHash('srv-1'));
    expect(calls[0].row.foundryVersion).toBe('13.348');
    expect(calls[0].row.systemId).toBe('dnd5e');
    expect(calls[0].row.systemVersion).toBe('5.3.3');
    expect(JSON.stringify(calls[0].row)).not.toContain('http');
    expect(JSON.stringify(calls[0].row)).not.toContain('://');

    t = 4500;
    hub.mark('w1', 'connect');
    expect(calls.filter((entry) => entry.type === 'observe')).toHaveLength(1);

    hub.detach('w1');
    expect(calls[calls.length - 1]).toEqual({ type: 'close', serverKey: 'srv-1', reason: 'closed' });

    const named = [];
    const friendly = createTelemetryHub({
      now: () => 9000,
      log: { info() {}, debug() {}, warn() {} },
      history: fakeHistory(),
      detector: () => [],
      problemLog: {
        observe(serverKey, row) {
          named.push({ serverKey, profile: row.profile, serverHash: row.serverHash });
        },
        closeServer() {},
      },
      profileFor(id) {
        return id === 'srv-9' ? 'Friday 5e' : '';
      },
    });
    friendly.attach('w9', { serverId: 'srv-9' });
    friendly.mark('w9', 'connect');
    expect(named).toEqual([{
      serverKey: 'srv-9',
      profile: 'Friday 5e',
      serverHash: shortServerHash('srv-9'),
    }]);
    friendly.detach('w9');
  });
});
