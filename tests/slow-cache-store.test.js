import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createSlowCacheStore } from '../electron/slow-cache-store.js';

const dirs = [];

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-slow-cache-'));
  dirs.push(dir);
  return path.join(dir, 'slow-cache-notice.json');
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('createSlowCacheStore', () => {
  it('persists a verdict, keeps dismissed, and never writes an address', () => {
    const filePath = tempFile();
    const store = createSlowCacheStore({ filePath });
    expect(store.saveVerdict('srv:2de5ad', {
      slow: true,
      proxy: 'nginx',
      total: 40,
      noCache: 38,
      url: 'http://secret.example/join',
      host: 'secret.example',
      at: 1000,
    })).toBe(true);
    store.dismiss('srv:2de5ad');
    store.saveVerdict('srv:2de5ad', { slow: true, proxy: 'nginx', total: 90, noCache: 80, at: 2000 });

    const text = fs.readFileSync(filePath, 'utf8');
    expect(text).not.toMatch(/https?:/i);
    expect(text).not.toContain('secret');
    expect(text).not.toContain('host');
    expect(text).not.toContain('"url"');
    expect(text).toContain('srv:2de5ad');
    // Windows has no POSIX mode bits; only assert the owner-only mode elsewhere.
    if (process.platform !== 'win32') expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);

    const again = createSlowCacheStore({ filePath });
    expect(again.get('srv:2de5ad')).toMatchObject({
      slow: true,
      proxy: 'nginx',
      total: 90,
      noCache: 80,
      dismissed: true,
      at: 2000,
    });
    expect(again.list()).toEqual({
      'srv:2de5ad': { slow: true, proxy: 'nginx', dismissed: true },
    });
  });

  it('rejects ids that could carry an address', () => {
    const filePath = tempFile();
    const store = createSlowCacheStore({ filePath });
    expect(store.saveVerdict('http://play.example/game', { slow: true, proxy: 'nginx', total: 40, noCache: 40 })).toBe(false);
    expect(store.saveVerdict('__proto__', { slow: true })).toBe(false);
    expect(store.dismiss('not a id')).toBe(false);
    expect(fs.existsSync(filePath)).toBe(false);
    expect(store.list()).toEqual({});
  });
});
