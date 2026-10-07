import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createProblemLog, safeProfileLabel } from '../electron/problem-log.js';

const dirs = [];

function tempDir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-problem-log-'));
  dirs.push(dir);
  return dir;
}

function tempFile() {
  return path.join(tempDir(), 'problem-log.jsonl');
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

function ctx(extra) {
  return Object.assign({
    profile: 'Tony',
    serverHash: 'srv:abc123',
    foundryVersion: '13.348',
    systemId: 'dnd5e',
    systemVersion: '5.3.3',
  }, extra || {});
}

function finding(extra) {
  return Object.assign({
    id: 'server-slow',
    category: 'server',
    severity: 'warn',
    title: 'Server is slow',
    evidence: 'rtt=40',
    suggestion: 'Wait',
  }, extra || {});
}

function readLines(filePath) {
  if (!fs.existsSync(filePath)) return [];
  return fs.readFileSync(filePath, 'utf8').split('\n').filter((line) => line.trim());
}

describe('safeProfileLabel', () => {
  const hash = 'srv:abc123';

  it('keeps a short plain name and a name with a space', () => {
    expect(safeProfileLabel('Tony', hash)).toBe('Tony');
    expect(safeProfileLabel('Friday 5e', hash)).toBe('Friday 5e');
  });

  it('replaces addresses, hostnames, and oversized labels with the server hash', () => {
    expect(safeProfileLabel('https://exandria.example.net/', hash)).toBe(hash);
    expect(safeProfileLabel('my.server.net', hash)).toBe(hash);
    expect(safeProfileLabel('notes.example.com', hash)).toBe(hash);
    expect(safeProfileLabel('user@table', hash)).toBe(hash);
    expect(safeProfileLabel('10.1.2.3', hash)).toBe(hash);
    expect(safeProfileLabel('campaign/folder', hash)).toBe(hash);
    expect(safeProfileLabel('T'.repeat(49), hash)).toBe(hash);
    expect(safeProfileLabel(null, hash)).toBe(hash);
  });
});

describe('createProblemLog', () => {
  it('writes one record when a warning resolves, with the elapsed duration', () => {
    const filePath = tempFile();
    let t = 1_700_000_000_000;
    const log = createProblemLog({ filePath, now: () => t, clientVersion: '0.5.4' });
    log.observe('srv-1', ctx(), [
      finding(),
      finding({ id: 'page-errors', severity: 'info', title: 'Many page errors', evidence: 'count=9' }),
    ]);
    expect(readLines(filePath)).toEqual([]);
    t += 2500;
    log.observe('srv-1', ctx({ profile: 'Friday 5e' }), [
      finding({ title: 'Server is slower', evidence: 'rtt=90' }),
    ]);
    expect(readLines(filePath)).toEqual([]);
    t += 500;
    log.observe('srv-1', ctx(), []);
    const lines = readLines(filePath);
    expect(lines).toHaveLength(1);
    const rec = JSON.parse(lines[0]);
    expect(rec).toEqual({
      v: 1,
      startedAt: new Date(1_700_000_000_000).toISOString(),
      resolvedAt: new Date(1_700_000_000_000 + 3000).toISOString(),
      durationMs: 3000,
      endedBy: 'resolved',
      profile: 'Friday 5e',
      server: 'srv:abc123',
      id: 'server-slow',
      category: 'server',
      severity: 'warn',
      title: 'Server is slower',
      evidence: 'rtt=90',
      client: '0.5.4',
      foundry: '13.348',
      system: 'dnd5e 5.3.3',
    });
    expect(lines[0]).not.toContain('http');
    expect(lines[0]).not.toContain('://');
  });

  it('closes still-open issues with a null resolved time', () => {
    const filePath = tempFile();
    let t = 5_000;
    const log = createProblemLog({ filePath, now: () => t, clientVersion: '0.5.4' });
    log.observe('srv-1', ctx(), [finding({ id: 'a', severity: 'error' })]);
    log.observe('srv-2', ctx({ profile: 'Tony', serverHash: 'srv:def456' }), [finding({ id: 'b' })]);
    t = 8_000;
    log.closeServer('srv-1', 'closed');
    const closed = JSON.parse(readLines(filePath)[0]);
    expect(closed.endedBy).toBe('closed');
    expect(closed.resolvedAt).toBeNull();
    expect(closed.durationMs).toBe(3000);
    expect(closed.id).toBe('a');
    log.closeAll('quit');
    const lines = readLines(filePath);
    expect(lines).toHaveLength(2);
    const quit = JSON.parse(lines[1]);
    expect(quit.endedBy).toBe('quit');
    expect(quit.resolvedAt).toBeNull();
    expect(quit.durationMs).toBe(3000);
    expect(quit.id).toBe('b');
    expect(quit.server).toBe('srv:def456');
    log.closeServer('srv-1', 'closed');
    expect(readLines(filePath)).toHaveLength(2);
  });

  it('writes crash findings immediately and does not repeat them while they remain', () => {
    const filePath = tempFile();
    let t = 10_000;
    const log = createProblemLog({ filePath, now: () => t, clientVersion: '0.5.4' });
    const crash = finding({
      id: 'renderer-crashed',
      category: 'client',
      severity: 'error',
      title: 'Game page crashed',
      evidence: 'count=1',
    });
    const hung = finding({
      id: 'renderer-unresponsive',
      category: 'client',
      severity: 'warn',
      title: 'Game page was unresponsive',
      evidence: 'count=1',
    });
    const gpu = finding({
      id: 'gpu-process-gone',
      category: 'client',
      severity: 'error',
      title: 'GPU process gone',
      evidence: 'count=1',
    });
    log.observe('srv-1', ctx(), [crash, hung, gpu]);
    log.observe('srv-1', ctx(), [crash, hung, gpu]);
    let lines = readLines(filePath);
    expect(lines).toHaveLength(3);
    const records = lines.map((line) => JSON.parse(line));
    expect(records.map((rec) => rec.id).sort()).toEqual([
      'gpu-process-gone',
      'renderer-crashed',
      'renderer-unresponsive',
    ]);
    for (const rec of records) {
      expect(rec.endedBy).toBe('event');
      expect(rec.durationMs).toBe(0);
      expect(rec.resolvedAt).toBe(rec.startedAt);
    }
    log.observe('srv-1', ctx(), []);
    t += 1000;
    log.observe('srv-1', ctx(), [crash]);
    lines = readLines(filePath);
    expect(lines).toHaveLength(4);
    expect(JSON.parse(lines[3]).id).toBe('renderer-crashed');
    expect(JSON.parse(lines[3]).endedBy).toBe('event');
  });

  it('records a previous-session crash without a server', () => {
    const filePath = tempFile();
    const log = createProblemLog({ filePath, now: () => 5000, clientVersion: '0.6.0' });
    expect(log.recordEvent({
      id: 'app-crashed',
      category: 'client',
      severity: 'error',
      title: 'Previous session ended unexpectedly',
      evidence: 'cause=uncaught-exception.TypeError',
      serverHash: 'srv:none',
    })).toBe(true);
    expect(log.recordEvent({ id: 'nope', severity: 'info' })).toBe(false);
    const rec = JSON.parse(readLines(filePath)[0]);
    expect(rec).toMatchObject({
      endedBy: 'event',
      id: 'app-crashed',
      server: 'srv:none',
      evidence: 'cause=uncaught-exception.TypeError',
      durationMs: 0,
    });
  });

  it('rotates the file once it exceeds maxBytes and overwrites the previous rotation', () => {
    const dir = tempDir();
    const filePath = path.join(dir, 'problem-log.jsonl');
    const rotated = path.join(dir, 'problem-log.1.jsonl');
    fs.writeFileSync(rotated, 'OLD\n', 'utf8');
    let t = 1000;
    const log = createProblemLog({
      filePath,
      now: () => t,
      clientVersion: '0.5.4',
      maxBytes: 80,
    });
    log.observe('srv-1', ctx(), [finding({ id: 'first' })]);
    t += 10;
    log.observe('srv-1', ctx(), []);
    expect(fs.readFileSync(rotated, 'utf8')).toBe('OLD\n');
    expect(readLines(filePath)).toHaveLength(1);
    log.observe('srv-1', ctx(), [finding({ id: 'second' })]);
    t += 10;
    log.observe('srv-1', ctx(), []);
    const archived = fs.readFileSync(rotated, 'utf8');
    expect(archived).not.toContain('OLD');
    expect(archived).toContain('"id":"first"');
    const current = readLines(filePath);
    expect(current).toHaveLength(1);
    expect(JSON.parse(current[0]).id).toBe('second');
  });

  it('warns once per minute when a write fails', () => {
    const warns = [];
    let t = 0;
    const fakeFs = {
      mkdirSync() {},
      statSync() {
        const err = new Error('missing');
        err.code = 'ENOENT';
        throw err;
      },
      appendFileSync() {
        const err = new Error('full');
        err.name = 'IOError';
        throw err;
      },
    };
    const log = createProblemLog({
      filePath: path.join(tempDir(), 'problem-log.jsonl'),
      now: () => t,
      fs: fakeFs,
      clientVersion: '0.5.4',
      log: { warn: (msg, extra) => warns.push({ msg, extra }) },
    });
    log.observe('srv-1', ctx(), [finding()]);
    t = 1000;
    log.observe('srv-1', ctx(), []);
    t = 2000;
    log.observe('srv-1', ctx(), []);
    expect(warns).toEqual([
      { msg: '[problem-log] write failed', extra: { error: 'IOError' } },
    ]);
    t = 61_000;
    log.observe('srv-1', ctx(), []);
    expect(warns).toHaveLength(2);
    expect(warns[1].extra).toEqual({ error: 'IOError' });
  });

  it('reads the last valid lines and stores no address in the file', () => {
    const filePath = tempFile();
    let t = 10_000;
    const hash = 'srv:abc123';
    const log = createProblemLog({ filePath, now: () => t, clientVersion: '0.5.4' });
    const profiles = ['Tony', 'https://exandria.example.net/', 'my.server.net', 'Friday 5e'];
    for (let i = 0; i < profiles.length; i += 1) {
      log.observe('srv-1', ctx({ profile: profiles[i], serverHash: hash }), [finding({ id: `issue-${i}` })]);
      t += 5;
      log.observe('srv-1', ctx({ profile: profiles[i], serverHash: hash }), []);
      t += 5;
    }
    fs.appendFileSync(filePath, '{not json\n', 'utf8');
    const recent = log.readRecent(2);
    expect(recent).toHaveLength(2);
    expect(recent.map((rec) => rec.id)).toEqual(['issue-2', 'issue-3']);
    expect(recent[0].profile).toBe(hash);
    expect(recent[1].profile).toBe('Friday 5e');
    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).not.toContain('http');
    expect(text).not.toContain('://');
    expect(text).not.toContain('.net');
    expect(text).not.toContain('.com');
    expect(log.readRecent(0)).toEqual([]);
    expect(createProblemLog({
      filePath: path.join(tempDir(), 'missing.jsonl'),
      clientVersion: '0.5.4',
    }).readRecent(5)).toEqual([]);
  });

  it('clips evidence to 200 characters and omits a system when it is absent', () => {
    const filePath = tempFile();
    let t = 100;
    const log = createProblemLog({ filePath, now: () => t, clientVersion: '0.5.4' });
    log.observe('srv-1', ctx({ foundryVersion: null, systemId: null, systemVersion: null }), [
      finding({ evidence: 'e'.repeat(240) }),
    ]);
    t += 1;
    log.observe('srv-1', ctx(), []);
    const rec = JSON.parse(readLines(filePath)[0]);
    expect(rec.evidence).toHaveLength(200);
    expect(rec.foundry).toBeNull();
    expect(rec.system).toBeNull();
    expect(log.flush()).toBeUndefined();
  });
});
