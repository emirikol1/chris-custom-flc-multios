import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { DEFAULT_APP_PREFS, readAppPrefs, writeAppPrefs } from '../electron/app-prefs.js';

const dirs = [];
function tmpPrefsPath() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-prefs-'));
  dirs.push(dir);
  return path.join(dir, 'nested', 'app-prefs.json');
}

const DEFAULTS = {
  mudEnabled: false,
  serversCollapsed: false,
  mudCollapsed: false,
  loadingBannerEnabled: true,
};

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('app-prefs', () => {
  it('mud is disabled and panels expanded by default and when the file is missing', () => {
    expect(DEFAULT_APP_PREFS).toEqual(DEFAULTS);
    expect(readAppPrefs(tmpPrefsPath())).toEqual(DEFAULTS);
  });

  it('round-trips mudEnabled and creates parent dirs', () => {
    const p = tmpPrefsPath();
    expect(writeAppPrefs(p, { mudEnabled: true })).toEqual({ ...DEFAULTS, mudEnabled: true });
    expect(readAppPrefs(p)).toEqual({ ...DEFAULTS, mudEnabled: true });
    expect(writeAppPrefs(p, {})).toEqual({ ...DEFAULTS, mudEnabled: true });
    expect(writeAppPrefs(p, { mudEnabled: false })).toEqual(DEFAULTS);
  });

  it('patches collapsed flags independently', () => {
    const p = tmpPrefsPath();
    writeAppPrefs(p, { mudEnabled: true });
    expect(writeAppPrefs(p, { serversCollapsed: true })).toEqual({
      ...DEFAULTS,
      mudEnabled: true,
      serversCollapsed: true,
    });
    expect(writeAppPrefs(p, { mudCollapsed: 1 })).toEqual({
      ...DEFAULTS,
      mudEnabled: true,
      serversCollapsed: true,
      mudCollapsed: true,
    });
    expect(writeAppPrefs(p, { serversCollapsed: false })).toEqual({
      ...DEFAULTS,
      mudEnabled: true,
      mudCollapsed: true,
    });
  });

  it('reads older files that only have mudEnabled', () => {
    const p = tmpPrefsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ mudEnabled: true }));
    expect(readAppPrefs(p)).toEqual({ ...DEFAULTS, mudEnabled: true });
  });

  it('tolerates a corrupt file', () => {
    const p = tmpPrefsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    expect(readAppPrefs(p)).toEqual(DEFAULTS);
  });

  it('ignores a leftover diskCacheMb and does not write it back', () => {
    const p = tmpPrefsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ mudEnabled: true, diskCacheMb: 4096, extra: true }));
    expect(readAppPrefs(p)).toEqual({ ...DEFAULTS, mudEnabled: true });
    expect(readAppPrefs(p).diskCacheMb).toBeUndefined();
    writeAppPrefs(p, { serversCollapsed: true });
    expect(JSON.parse(fs.readFileSync(p, 'utf8'))).toEqual({
      mudEnabled: true,
      serversCollapsed: true,
      mudCollapsed: false,
      loadingBannerEnabled: true,
    });
  });

  it('defaults a missing loading-banner key to true and coerces non-booleans', () => {
    const p = tmpPrefsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, JSON.stringify({ mudEnabled: true }));
    const read = readAppPrefs(p);
    expect(read.loadingBannerEnabled).toBe(true);
    expect(writeAppPrefs(p, { loadingBannerEnabled: 'yes' })).toMatchObject({
      loadingBannerEnabled: true,
    });
    expect(writeAppPrefs(p, { loadingBannerEnabled: '' })).toMatchObject({
      loadingBannerEnabled: false,
    });
  });
});
