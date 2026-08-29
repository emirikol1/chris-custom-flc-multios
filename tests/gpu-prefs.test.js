import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { readGpuPrefs, writeGpuPrefs } from '../electron/gpu-prefs.js';

function tempGpuPrefsFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-gpu-prefs-'));
  return {
    dir,
    filePath: path.join(dir, 'gpu-prefs.json'),
  };
}

describe('readGpuPrefs', () => {
  it('returns defaults when file is missing', () => {
    const { dir, filePath } = tempGpuPrefsFile();
    try {
      const prefs = readGpuPrefs(filePath);
      expect(prefs).toEqual({
        preferSoftwareWebgl: false,
        lastFallbackReason: null,
        lastFallbackAt: null,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('returns defaults when file contains corrupt JSON', () => {
    const { dir, filePath } = tempGpuPrefsFile();
    try {
      fs.writeFileSync(filePath, '{not valid json', 'utf8');
      const prefs = readGpuPrefs(filePath);
      expect(prefs).toEqual({
        preferSoftwareWebgl: false,
        lastFallbackReason: null,
        lastFallbackAt: null,
      });
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('writeGpuPrefs / readGpuPrefs round-trip', () => {
  const cleanups = [];

  afterEach(() => {
    for (const dir of cleanups) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanups.length = 0;
  });

  it('persists and reloads gpu preferences', () => {
    const { dir, filePath } = tempGpuPrefsFile();
    cleanups.push(dir);
    const written = {
      preferSoftwareWebgl: true,
      lastFallbackReason: 'WebGL context creation failed',
      lastFallbackAt: '2026-08-07T12:00:00.000Z',
    };
    writeGpuPrefs(filePath, written);
    expect(fs.existsSync(filePath)).toBe(true);
    const loaded = readGpuPrefs(filePath);
    expect(loaded).toEqual(written);
  });

  it('coerces preferSoftwareWebgl to boolean on write', () => {
    const { dir, filePath } = tempGpuPrefsFile();
    cleanups.push(dir);
    writeGpuPrefs(filePath, {
      preferSoftwareWebgl: 1,
      lastFallbackReason: null,
      lastFallbackAt: null,
    });
    const loaded = readGpuPrefs(filePath);
    expect(loaded.preferSoftwareWebgl).toBe(true);
  });
});
