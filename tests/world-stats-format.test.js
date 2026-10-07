import { describe, expect, it } from 'vitest';
import {
  barLevel,
  compareLine,
  formatBytes,
  formatMs,
  formatPercent,
  formatRate,
  phaseSegments,
  rateFromSamples,
  severityOrder,
  syncLabel,
  createIssueTracker,
  formatIssueForClipboard,
  formatBadUrlButton,
  formatBadUrlLine,
  formatIssueSummary,
  formatResolvedAgo,
  syncLatencyLabel,
  formatDocLine,
  formatThroughput,
  formatAgo,
  formatLastRequest,
  formatTraffic,
  slowPackageLines,
  formatNetTraceSummary,
} from '../src/world-stats-format.js';

describe('formatBytes', () => {
  it('renders an em dash for missing or non-finite values', () => {
    expect(formatBytes(null)).toBe('—');
    expect(formatBytes(undefined)).toBe('—');
    expect(formatBytes(Number.NaN)).toBe('—');
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe('—');
  });

  it('uses binary units and one decimal when needed', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(1.2 * 1024 * 1024 * 1024)).toBe('1.2 GB');
    expect(formatBytes(-1536)).toBe('-1.5 KB');
  });
});

describe('formatMs', () => {
  it('renders an em dash for missing or non-finite values', () => {
    expect(formatMs(null)).toBe('—');
    expect(formatMs(undefined)).toBe('—');
    expect(formatMs(Number.NaN)).toBe('—');
  });

  it('uses milliseconds under one second and seconds at or above', () => {
    expect(formatMs(0)).toBe('0 ms');
    expect(formatMs(999)).toBe('999 ms');
    expect(formatMs(1000)).toBe('1 s');
    expect(formatMs(1500)).toBe('1.5 s');
    expect(formatMs(-1500)).toBe('-1.5 s');
  });
});

describe('formatPercent', () => {
  it('treats the input as a 0..1 ratio', () => {
    expect(formatPercent(null)).toBe('—');
    expect(formatPercent(0)).toBe('0%');
    expect(formatPercent(0.5)).toBe('50%');
    expect(formatPercent(0.318)).toBe('31.8%');
    expect(formatPercent(1)).toBe('100%');
  });
});

describe('formatRate', () => {
  it('appends a per-second unit to a byte size', () => {
    expect(formatRate(null)).toBe('—');
    expect(formatRate(0)).toBe('0 B/s');
    expect(formatRate(1536)).toBe('1.5 KB/s');
  });
});

describe('phaseSegments', () => {
  it('hides null durations and proportions the rest', () => {
    const segments = phaseSegments({
      durations: {
        loginMs: 200,
        pageLoadMs: null,
        transfersMs: 5000,
        worldDataMs: null,
        initMs: 100,
        i18nMs: undefined,
        setupMs: 100,
        canvasMs: 0,
      },
    });
    expect(segments.map((row) => row.key)).toEqual(['login', 'init', 'setup', 'canvas']);
    expect(segments.map((row) => row.label)).toEqual(['login', 'init', 'setup', 'canvas']);
    expect(segments.map((row) => row.ms)).toEqual([200, 100, 100, 0]);
    expect(segments.map((row) => row.fraction)).toEqual([0.5, 0.25, 0.25, 0]);
  });

  it('returns an empty list when nothing has arrived', () => {
    expect(phaseSegments(null)).toEqual([]);
    expect(phaseSegments({})).toEqual([]);
    expect(phaseSegments({ durations: { transfersMs: -1, initMs: Number.NaN } })).toEqual([]);
  });
});

describe('syncLabel', () => {
  it('maps sync state onto the status light and a cause only when out of sync', () => {
    expect(syncLabel({ state: 'synced', cause: 'local-offline' })).toEqual({
      state: 'ok',
      text: 'Synced',
      cause: '',
    });
    expect(syncLabel({ state: 'out-of-sync', cause: 'local-offline' })).toEqual({
      state: 'bad',
      text: 'Out of sync',
      cause: 'this computer is offline',
    });
    expect(syncLabel({ state: 'out-of-sync', cause: 'server-unreachable' }).cause).toBe(
      'server unreachable',
    );
    expect(syncLabel({ state: 'out-of-sync', cause: 'socket-stalled' }).cause).toBe(
      'connected, but no data from server',
    );
    expect(syncLabel({ state: 'out-of-sync', cause: null }).cause).toBe('');
    expect(syncLabel(null)).toEqual({ state: 'unknown', text: 'Unknown', cause: '' });
    expect(syncLabel({ state: 'unknown' }).state).toBe('unknown');
  });
});

describe('severityOrder', () => {
  it('ranks error, then warn, then info', () => {
    expect(severityOrder('error')).toBeLessThan(severityOrder('warn'));
    expect(severityOrder('warn')).toBeLessThan(severityOrder('info'));
    expect(severityOrder('info')).toBeLessThan(severityOrder('other'));
  });
});

describe('barLevel', () => {
  it('stays ok until over 70 percent and turns bad over 85 percent', () => {
    expect(barLevel(null)).toBe('ok');
    expect(barLevel(0)).toBe('ok');
    expect(barLevel(0.7)).toBe('ok');
    expect(barLevel(0.7001)).toBe('warn');
    expect(barLevel(0.85)).toBe('warn');
    expect(barLevel(0.8501)).toBe('bad');
    expect(barLevel(1)).toBe('bad');
  });
});

describe('rateFromSamples', () => {
  it('returns bytes per second from consecutive transfer counters', () => {
    expect(rateFromSamples(
      { transferBytes: 1000, updatedAt: 0 },
      { transferBytes: 2500, updatedAt: 2000 },
    )).toBe(750);
    expect(rateFromSamples(
      { snapshot: { transfers: { transferBytes: 1000 }, updatedAt: 1000 }, updatedAt: 1000 },
      { snapshot: { transfers: { transferBytes: 3000 } }, updatedAt: 3000 },
    )).toBe(1000);
  });

  it('returns null until two increasing samples exist', () => {
    expect(rateFromSamples(null, { transferBytes: 10, updatedAt: 1 })).toBeNull();
    expect(rateFromSamples(
      { transferBytes: 10, updatedAt: 1000 },
      { transferBytes: 10, updatedAt: 1000 },
    )).toBeNull();
    expect(rateFromSamples(
      { transferBytes: 50, updatedAt: 0 },
      { transferBytes: 10, updatedAt: 1000 },
    )).toBeNull();
    expect(rateFromSamples(
      { transferBytes: null, updatedAt: 0 },
      { transferBytes: 10, updatedAt: 1000 },
    )).toBeNull();
  });
});

describe('compareLine', () => {
  it('formats this, typical, first, and fastest', () => {
    expect(compareLine({
      thisMs: 1500,
      typicalMs: 2000,
      firstMs: 3000,
      fastestMs: 1000,
    }, { joins: 3, needed: 3 })).toBe(
      'this join 1.5 s · typical 2 s · first 3 s · fastest 1 s',
    );
  });

  it('hides typical while the baseline is still building', () => {
    expect(compareLine({
      thisMs: 1500,
      typicalMs: 2000,
      firstMs: null,
      fastestMs: null,
    }, { joins: 1, needed: 3 })).toBe(
      'this join 1.5 s · typical — · first — · fastest —',
    );
  });

  it('renders dashes when compare is missing', () => {
    expect(compareLine(null, null)).toBe(
      'this join — · typical — · first — · fastest —',
    );
  });
});

function finding(id, extra = {}) {
  return {
    id,
    category: 'client',
    severity: 'warn',
    title: 'Game is stalling',
    evidence: 'count=16 worstMs=20075',
    suggestion: 'The game is stalling on long tasks.',
    ...extra,
  };
}

describe('createIssueTracker', () => {
  it('records a present finding as an active row', () => {
    const tracker = createIssueTracker({ now: () => 0 });
    const rows = tracker.apply([finding('game-stalling')], 1000);
    expect(rows).toEqual([{
      id: 'game-stalling',
      category: 'client',
      severity: 'warn',
      title: 'Game is stalling',
      evidence: 'count=16 worstMs=20075',
      suggestion: 'The game is stalling on long tasks.',
      state: 'active',
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      resolvedAt: null,
    }]);
    expect(tracker.rows()).toEqual(rows);
  });

  it('updates fields and lastSeenAt while a finding stays active', () => {
    const tracker = createIssueTracker({ now: () => 0 });
    tracker.apply([finding('game-stalling', { title: 'Old' })], 1000);
    const rows = tracker.apply([finding('game-stalling', {
      title: 'New',
      evidence: 'count=20',
      severity: 'error',
    })], 2500);
    expect(rows[0].title).toBe('New');
    expect(rows[0].evidence).toBe('count=20');
    expect(rows[0].severity).toBe('error');
    expect(rows[0].state).toBe('active');
    expect(rows[0].firstSeenAt).toBe(1000);
    expect(rows[0].lastSeenAt).toBe(2500);
    expect(rows[0].resolvedAt).toBeNull();
  });

  it('marks a missing active finding resolved and leaves it unchanged while it stays gone', () => {
    const tracker = createIssueTracker({ now: () => 0 });
    tracker.apply([finding('game-stalling')], 1000);
    const resolved = tracker.apply([], 4000);
    expect(resolved).toEqual([{
      id: 'game-stalling',
      category: 'client',
      severity: 'warn',
      title: 'Game is stalling',
      evidence: 'count=16 worstMs=20075',
      suggestion: 'The game is stalling on long tasks.',
      state: 'resolved',
      firstSeenAt: 1000,
      lastSeenAt: 1000,
      resolvedAt: 4000,
    }]);
    const again = tracker.apply(null, 9000);
    expect(again).toEqual(resolved);
  });

  it('turns a resolved finding red again when it recurs, keeping firstSeenAt', () => {
    const tracker = createIssueTracker({ now: () => 0 });
    tracker.apply([finding('game-stalling', { title: 'Old' })], 1000);
    tracker.apply([], 4000);
    const rows = tracker.apply([finding('game-stalling', { title: 'Back', severity: 'error' })], 7000);
    expect(rows).toHaveLength(1);
    expect(rows[0].state).toBe('active');
    expect(rows[0].title).toBe('Back');
    expect(rows[0].severity).toBe('error');
    expect(rows[0].firstSeenAt).toBe(1000);
    expect(rows[0].lastSeenAt).toBe(7000);
    expect(rows[0].resolvedAt).toBeNull();
  });

  it('drops a cleared id while it is still reported, then starts a fresh row after it returns', () => {
    const tracker = createIssueTracker({ now: () => 0 });
    tracker.apply([finding('game-stalling', { title: 'Old' })], 1000);
    tracker.clear('game-stalling');
    expect(tracker.rows()).toEqual([]);
    expect(tracker.apply([finding('game-stalling', { title: 'Still' })], 2000)).toEqual([]);
    expect(tracker.apply([], 3000)).toEqual([]);
    const rows = tracker.apply([finding('game-stalling', { title: 'Again' })], 5000);
    expect(rows).toEqual([{
      id: 'game-stalling',
      category: 'client',
      severity: 'warn',
      title: 'Again',
      evidence: 'count=16 worstMs=20075',
      suggestion: 'The game is stalling on long tasks.',
      state: 'active',
      firstSeenAt: 5000,
      lastSeenAt: 5000,
      resolvedAt: null,
    }]);
  });

  it('clears only resolved rows and lets a later detection start fresh', () => {
    const tracker = createIssueTracker({ now: () => 0 });
    tracker.apply([
      finding('active-one'),
      finding('gone', { title: 'Gone' }),
    ], 1000);
    tracker.apply([finding('active-one')], 2000);
    tracker.clearResolved();
    expect(tracker.rows().map((row) => row.id)).toEqual(['active-one']);
    tracker.apply([], 3000);
    tracker.clearResolved();
    expect(tracker.rows()).toEqual([]);
    const rows = tracker.apply([finding('gone', { title: 'Gone again' })], 4000);
    expect(rows.map((row) => row.id)).toEqual(['gone']);
    expect(rows[0].state).toBe('active');
    expect(rows[0].firstSeenAt).toBe(4000);
    expect(rows[0].resolvedAt).toBeNull();
  });

  it('orders active rows by severity then title, then resolved rows newest first', () => {
    const tracker = createIssueTracker({ now: () => 0 });
    tracker.apply([
      finding('warn-b', { severity: 'warn', title: 'Beta' }),
      finding('info-a', { severity: 'info', title: 'Alpha' }),
      finding('error-z', { severity: 'error', title: 'Zed' }),
      finding('warn-a', { severity: 'warn', title: 'Alpha' }),
      finding('old-resolved', { severity: 'error', title: 'Old' }),
      finding('new-resolved', { severity: 'info', title: 'New' }),
    ], 1000);
    tracker.apply([
      finding('warn-b', { severity: 'warn', title: 'Beta' }),
      finding('info-a', { severity: 'info', title: 'Alpha' }),
      finding('error-z', { severity: 'error', title: 'Zed' }),
      finding('warn-a', { severity: 'warn', title: 'Alpha' }),
      finding('new-resolved', { severity: 'info', title: 'New' }),
    ], 2000);
    const rows = tracker.apply([
      finding('warn-b', { severity: 'warn', title: 'Beta' }),
      finding('info-a', { severity: 'info', title: 'Alpha' }),
      finding('error-z', { severity: 'error', title: 'Zed' }),
      finding('warn-a', { severity: 'warn', title: 'Alpha' }),
    ], 3000);
    expect(rows.map((row) => row.id)).toEqual([
      'error-z',
      'warn-a',
      'warn-b',
      'info-a',
      'new-resolved',
      'old-resolved',
    ]);
    expect(rows.map((row) => row.state)).toEqual([
      'active',
      'active',
      'active',
      'active',
      'resolved',
      'resolved',
    ]);
    expect(rows[4].resolvedAt).toBe(3000);
    expect(rows[5].resolvedAt).toBe(2000);
  });

  it('ignores findings without an id and uses the clock when at is omitted', () => {
    let now = 42;
    const tracker = createIssueTracker({ now: () => now });
    const rows = tracker.apply([null, { title: 'missing' }, finding('kept'), finding('kept', { title: 'Last' })]);
    expect(rows).toHaveLength(1);
    expect(rows[0].id).toBe('kept');
    expect(rows[0].title).toBe('Last');
    expect(rows[0].firstSeenAt).toBe(42);
    now = 90;
    tracker.clear('missing');
    expect(tracker.rows()).toHaveLength(1);
  });
});

describe('formatIssueForClipboard', () => {
  it('renders a plain-text block and never the word undefined', () => {
    expect(formatIssueForClipboard({
      severity: 'warn',
      category: 'client',
      title: 'Game is stalling',
      evidence: 'count=16 worstMs=20075',
      suggestion: 'The game is stalling...',
      state: 'active',
    })).toBe(
      '[WARN] client — Game is stalling\nevidence: count=16 worstMs=20075\nsuggestion: The game is stalling...\nstatus: active',
    );
    expect(formatIssueForClipboard({
      severity: 'error',
      category: 'network',
      title: 'Dropped',
      evidence: 'count=1',
      suggestion: 'Check the link.',
      state: 'resolved',
    })).toBe(
      '[ERROR] network — Dropped\nevidence: count=1\nsuggestion: Check the link.\nstatus: resolved',
    );
    const blank = formatIssueForClipboard(null);
    expect(blank).toBe('[]  — \nevidence: \nsuggestion: \nstatus: active');
    expect(blank).not.toContain('undefined');
    expect(formatIssueForClipboard({})).not.toContain('undefined');
  });
});

describe('formatIssueSummary', () => {
  it('counts active and resolved rows, or reports none', () => {
    expect(formatIssueSummary(null)).toBe('No issues detected');
    expect(formatIssueSummary([])).toBe('No issues detected');
    expect(formatIssueSummary([
      { state: 'active' },
      { state: 'active' },
      { state: 'resolved' },
    ])).toBe('2 active · 1 resolved');
    expect(formatIssueSummary([{ state: 'resolved' }])).toBe('0 active · 1 resolved');
  });
});

describe('formatResolvedAgo', () => {
  it('formats elapsed time as m:ss or h:mm:ss', () => {
    expect(formatResolvedAgo(0, 42000)).toBe('0:42');
    expect(formatResolvedAgo(0, 5000)).toBe('0:05');
    expect(formatResolvedAgo(0, 65000)).toBe('1:05');
    expect(formatResolvedAgo(0, 3661000)).toBe('1:01:01');
    expect(formatResolvedAgo(5000, 1000)).toBe('0:00');
    expect(formatResolvedAgo(null, 1000)).toBe('');
    expect(formatResolvedAgo(0, null)).toBe('');
    expect(formatResolvedAgo(undefined, undefined)).not.toContain('undefined');
  });
});

describe('formatBadUrlButton', () => {
  it('shows a count only when files have failed', () => {
    expect(formatBadUrlButton(0)).toBe('Bad URLs');
    expect(formatBadUrlButton(null)).toBe('Bad URLs');
    expect(formatBadUrlButton(Number.NaN)).toBe('Bad URLs');
    expect(formatBadUrlButton(-2)).toBe('Bad URLs');
    expect(formatBadUrlButton(3)).toBe('Bad URLs · 3');
    expect(formatBadUrlButton(3.9)).toBe('Bad URLs · 3');
  });
});

describe('formatBadUrlLine', () => {
  it('shows the pathname and keeps the full URL for hover', () => {
    const view = formatBadUrlLine({
      status: 404,
      resourceType: 'image',
      url: 'https://secret.example/assets/My%20Map.webp?x=1',
      refs: ['Scene \u201cCave\u201d background'],
    });
    expect(view.line).toBe('404 image  /assets/My Map.webp');
    expect(view.line).not.toContain('secret.example');
    expect(view.title).toBe('https://secret.example/assets/My%20Map.webp?x=1');
    expect(view.refs).toBe('referenced by: Scene \u201cCave\u201d background');
  });

  it('uses the error name and a fallback reference', () => {
    const view = formatBadUrlLine({
      status: null,
      error: 'ERR_NAME_NOT_RESOLVED',
      resourceType: 'script',
      url: 'https://cdn.example/modules/missing.js',
    });
    expect(view.line).toBe('ERR_NAME_NOT_RESOLVED script  /modules/missing.js');
    expect(view.refs).toBe('referenced by: (no in-world reference found; may be CSS/module asset)');
  });
});

describe('syncLatencyLabel', () => {
  it('shows the latency floor and appends a slow server ack', () => {
    expect(syncLatencyLabel({ latencyFloorMs: 78, rttMs: 87, ackP95Ms: 1700 })).toBe(
      'latency ~78 ms · server ack p95 1.7 s',
    );
  });

  it('falls back to round-trip time when the floor is missing', () => {
    expect(syncLatencyLabel({ rttMs: 87 })).toBe('latency ~87 ms');
    expect(syncLatencyLabel({ ackP95Ms: 1700 })).toBe('server ack p95 1.7 s');
  });

  it('renders a dash when latency is missing', () => {
    expect(syncLatencyLabel(null)).toBe('—');
    expect(syncLatencyLabel({})).toBe('—');
    expect(syncLatencyLabel({ latencyFloorMs: Number.NaN, rttMs: Number.POSITIVE_INFINITY })).toBe('—');
  });
});

describe('formatDocLine', () => {
  it('shows the count and appends a size once measured', () => {
    expect(formatDocLine(358, 43201331)).toBe('358 · 41.2 MB');
    expect(formatDocLine(358, null)).toBe('358');
    expect(formatDocLine(null, null)).toBe('—');
  });
});

describe('slowPackageLines', () => {
  it('shows the eight slowest package ids and hides invalid ones', () => {
    expect(slowPackageLines(null)).toEqual([]);
    expect(slowPackageLines({})).toEqual([]);
    const rows = [];
    for (let i = 0; i < 9; i += 1) rows.push({ id: `mod-${i}`, ms: 1000 + i * 100, count: 1 });
    rows.push({ id: 'not ok', ms: 99999, count: 1 });
    rows.push({ id: 'chris-premades', ms: 4200, count: 3 });
    const lines = slowPackageLines({ byPackage: rows });
    expect(lines).toHaveLength(8);
    expect(lines[0]).toBe('chris-premades 4.2 s');
    expect(lines[1]).toBe('mod-8 1.8 s');
    expect(lines.join(' ')).not.toContain('not ok');
    expect(lines.join(' ')).not.toContain('http');
  });
});

describe('formatThroughput', () => {
  it('renders cache bytes, time, and a per-second rate', () => {
    expect(formatThroughput(140 * 1024 * 1024, 2100)).toBe('cache served 140 MB in 2.1 s (66.7 MB/s)');
    expect(formatThroughput(null, 2100)).toBe('—');
    expect(formatThroughput(100, 0)).toBe('—');
  });
});

describe('formatAgo', () => {
  it('appends ago to a duration', () => {
    expect(formatAgo(2000)).toBe('2 s ago');
    expect(formatAgo(400)).toBe('400 ms ago');
    expect(formatAgo(null)).toBe('—');
  });
});

describe('sync activity lines', () => {
  it('formats the last request and the traffic line', () => {
    expect(formatLastRequest({
      lastRequest: { name: 'modifyDocument', ms: 83, ageMs: 2000 },
    })).toBe('Last request: modifyDocument · 83 ms · 2 s ago');
    expect(formatLastRequest(null)).toBe('—');
    expect(formatTraffic({
      lastMessageAgeMs: 400,
      requestsPerMin: 12,
      messagesPerMin: 240,
    })).toBe('Last server message: 400 ms ago · requests 12/min · messages 240/min');
    expect(formatTraffic({})).toBe('—');
  });
});

describe('formatNetTraceSummary', () => {
  it('summarizes a finished trace and an empty one', () => {
    expect(formatNetTraceSummary(null)).toBe('not run');
    expect(formatNetTraceSummary({})).toBe('not run');
    expect(formatNetTraceSummary({
      summary: { hopCount: 12, reached: true },
      ping: { lossPct: 0, jitterMs: 4.2 },
    })).toBe('reached in 12 hops · 0% loss · jitter 4 ms');
    expect(formatNetTraceSummary({
      summary: { hopCount: 9, reached: false },
      ping: { lossPct: 3.34, jitterMs: 8 },
    })).toBe('not reached in 9 hops · 3.3% loss · jitter 8 ms');
  });
});
