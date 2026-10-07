import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createJoinHistory, typicalTotalMs } from '../electron/join-history.js';

const dirs = [];

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-join-history-'));
  dirs.push(dir);
  return path.join(dir, 'join-history.json');
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function rec(totalMs) {
  return {
    at: totalMs,
    totalMs,
    transfersMs: 1,
    worldDataMs: 2,
    worldDataBytes: 3,
    setupMs: 4,
    canvasMs: 5,
    requests: 6,
    transferBytes: 7,
    cacheHitRatio: 0.5,
    docs: 8,
    ttfbP50Ms: 9,
    rttP50Ms: 10,
    worldDataMsPerMb: 11,
    setupMsPerDoc: 12,
    label: 'https://secret.example/world',
  };
}

describe('createJoinHistory', () => {
  it('keeps ten oldest-first records per server and forgets them', () => {
    const warns = [];
    const history = createJoinHistory({
      filePath: tempFile(),
      log: { warn: (name) => warns.push(name) },
    });
    for (let i = 0; i < 12; i += 1) history.record('server-a', rec(i));
    history.record('server-b', rec(50));
    const listed = history.list('server-a');
    expect(listed).toHaveLength(10);
    expect(listed.map((row) => row.totalMs)).toEqual([2, 3, 4, 5, 6, 7, 8, 9, 10, 11]);
    expect(listed[0].label).toBeUndefined();
    expect(JSON.stringify(listed)).not.toContain('http');
    expect(history.list('server-b')).toHaveLength(1);
    expect(history.list('missing')).toEqual([]);
    history.record('__proto__', rec(1));
    history.record('', rec(1));
    expect(history.all()['server-b'][0].totalMs).toBe(50);
    history.forget('server-a');
    expect(history.list('server-a')).toEqual([]);
    expect(Object.keys(history.all())).toEqual(['server-b']);
    expect(warns).toEqual([]);
  });

  it('reloads from disk and survives a bad file', () => {
    const filePath = tempFile();
    const warns = [];
    const first = createJoinHistory({ filePath, log: { warn: (name) => warns.push(name) } });
    first.record('srv', rec(4));
    const second = createJoinHistory({ filePath, log: { warn: (name) => warns.push(name) } });
    expect(second.list('srv')[0].totalMs).toBe(4);
    expect(second.list('srv')[0]).not.toBe(first.list('srv')[0]);
    fs.writeFileSync(filePath, '{', 'utf8');
    const third = createJoinHistory({ filePath, log: { warn: (name) => warns.push(name) } });
    expect(third.list('srv')).toEqual([]);
    expect(warns).toEqual(['SyntaxError']);
    expect(() => third.record('srv', rec(1))).not.toThrow();
    expect(third.list('srv')).toHaveLength(1);
  });
});

describe('typicalTotalMs', () => {
  it('is the median of one population', () => {
    expect(typicalTotalMs([rec(60), rec(70), rec(80)])).toBe(70);
    expect(typicalTotalMs([rec(20), rec(30)])).toBe(25);
    expect(typicalTotalMs([])).toBeNull();
    expect(typicalTotalMs(null)).toBeNull();
    expect(typicalTotalMs([{ ...rec(5), totalMs: null }])).toBeNull();
  });
});
