import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  attach,
  buildCrashRecord,
  createCrashReport,
  framesFromStack,
  readCrashReportText,
  sanitizeMessage,
  writeCrash,
} from '../electron/crash-report.js';

const dirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-crash-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  attach(null);
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

const env = {
  nowIso: '2026-10-07T09:00:00.000Z',
  client: '0.6.0',
  pid: 42,
  platform: 'linux',
  arch: 'x64',
  uptimeMs: 1500,
  memory: { rss: 1000, heapUsed: 400, heapTotal: 800 },
  versions: { electron: '43.0.0', chrome: '142.0.0', node: '24.14.1' },
};

describe('crash report sanitizing', () => {
  it('keeps the exception text and drops urls, paths, and addresses', () => {
    expect(sanitizeMessage("Cannot read properties of undefined (reading 'map')")).toBe(
      "Cannot read properties of undefined (reading 'map')",
    );
    expect(sanitizeMessage('fetch failed https://forge-vtt.com/join?token=abc')).toBe('fetch failed');
    expect(sanitizeMessage('open /home/cproctor/secret.txt now')).toBe('open now');
    expect(sanitizeMessage('mail chris@example.com failed')).toBe('mail failed');
    expect(sanitizeMessage('https://only.example/a')).toBe('');
  });

  it('keeps basename and line, and drops url frames', () => {
    const stack = [
      'TypeError: boom',
      '    at loadServers (/home/cproctor/proj/electron/main.js:12:5)',
      '    at https://example.com/game.js?token=secret:1:1',
      '    at Object.<anonymous> (/home/cproctor/proj/electron/main.js:40:1)',
    ].join('\n');
    expect(framesFromStack(stack)).toEqual([
      { fn: 'loadServers', file: 'main.js', line: 12, col: 5 },
      { fn: 'Object.<anonymous>', file: 'main.js', line: 40, col: 1 },
    ]);
  });

  it('builds a record without the page address or the absolute path', () => {
    const record = buildCrashRecord({
      kind: 'uncaught-exception',
      errorName: 'TypeError',
      message: 'failed https://secret.example/game?token=abc',
      stack: '    at start (/home/cproctor/proj/electron/main.js:3:2)',
      url: 'https://secret.example/game',
    }, env);
    const blob = JSON.stringify(record);
    expect(record).toMatchObject({
      v: 1,
      kind: 'uncaught-exception',
      errorName: 'TypeError',
      message: 'failed',
      client: '0.6.0',
      pid: 42,
    });
    expect(record.frames).toEqual([{ fn: 'start', file: 'main.js', line: 3, col: 2 }]);
    expect(blob).not.toContain('http');
    expect(blob).not.toContain('secret');
    expect(blob).not.toContain('/home/');
    expect(blob).not.toContain('token');
    expect(buildCrashRecord({ kind: 'renderer-crashed', reason: 'clean-exit' }, env)).toBeNull();
  });
});

describe('createCrashReport', () => {
  it('appends a sanitized line, ignores a clean exit, and rotates', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'crash-reports.jsonl');
    let t = Date.parse('2026-10-07T09:00:00.000Z');
    const report = createCrashReport({
      filePath,
      client: '0.6.0',
      now: () => t,
      maxBytes: 80,
      snapshot: () => ({
        pid: 7,
        platform: 'linux',
        arch: 'x64',
        uptimeMs: 10,
        memory: { rss: 1, heapUsed: 1, heapTotal: 1 },
        versions: { node: '24.14.1' },
      }),
    });
    expect(report.write({ kind: 'renderer-crashed', reason: 'clean-exit' })).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(report.write({
      kind: 'renderer-crashed',
      reason: 'crashed',
      exitCode: 11,
      message: 'gone https://secret.example/a',
    })).toBe(true);
    t += 1000;
    expect(report.write({
      kind: 'gpu-process-gone',
      reason: 'oom',
      exitCode: -9,
    })).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
    }
    const lines = fs.readFileSync(filePath, 'utf8').trim().split('\n');
    expect(lines.length).toBeGreaterThanOrEqual(1);
    const current = lines.map((line) => JSON.parse(line));
    expect(current.some((row) => row.kind === 'gpu-process-gone' && row.reason === 'oom' && row.exitCode === -9)).toBe(true);
    expect(fs.existsSync(path.join(dir, 'crash-reports.1.jsonl'))).toBe(true);
    const text = readCrashReportText(fs, filePath, 20);
    expect(text).not.toContain('http');
    expect(text).not.toContain('secret');
    const recent = report.readRecent(20);
    expect(recent.every((row) => row.v === 1)).toBe(true);
  });

  it('holds a report until the writer is attached, then marks it saved', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'crash-reports.jsonl');
    const report = createCrashReport({
      filePath,
      client: '0.6.0',
      now: () => Date.parse('2026-10-07T09:00:00.000Z'),
      snapshot: () => ({
        pid: 1,
        platform: 'linux',
        arch: 'x64',
        uptimeMs: 1,
        memory: { rss: 1, heapUsed: 1, heapTotal: 1 },
        versions: {},
      }),
    });
    let saved = 0;
    expect(writeCrash({
      kind: 'uncaught-exception',
      errorName: 'TypeError',
      message: 'nope',
      stack: '    at boom (/tmp/app/electron/main.js:8:1)',
    })).toBe(true);
    expect(fs.existsSync(filePath)).toBe(false);
    attach(report, () => { saved += 1; });
    expect(saved).toBe(1);
    const rows = report.readRecent(5);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ kind: 'uncaught-exception', errorName: 'TypeError', message: 'nope' });
    expect(rows[0].frames[0].file).toBe('main.js');
    expect(JSON.stringify(rows[0])).not.toContain('/tmp/');
  });
});
