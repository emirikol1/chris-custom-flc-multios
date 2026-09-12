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

afterEach(() => {
  for (const d of dirs) fs.rmSync(d, { recursive: true, force: true });
  dirs.length = 0;
});

describe('app-prefs', () => {
  it('mud is disabled by default and when the file is missing', () => {
    expect(DEFAULT_APP_PREFS.mudEnabled).toBe(false);
    expect(readAppPrefs(tmpPrefsPath())).toEqual({ mudEnabled: false });
  });

  it('round-trips mudEnabled and creates parent dirs', () => {
    const p = tmpPrefsPath();
    expect(writeAppPrefs(p, { mudEnabled: true })).toEqual({ mudEnabled: true });
    expect(readAppPrefs(p)).toEqual({ mudEnabled: true });
    expect(writeAppPrefs(p, {})).toEqual({ mudEnabled: true });
    expect(writeAppPrefs(p, { mudEnabled: false })).toEqual({ mudEnabled: false });
  });

  it('tolerates a corrupt file', () => {
    const p = tmpPrefsPath();
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, '{not json');
    expect(readAppPrefs(p)).toEqual({ mudEnabled: false });
  });
});
