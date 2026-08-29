import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { importFromFlc } from '../electron/flc-import.js';

describe('importFromFlc', () => {
  const cleanups = [];

  afterEach(() => {
    for (const dir of cleanups) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanups.length = 0;
  });

  it('returns empty array when file is missing', () => {
    const missing = path.join(os.tmpdir(), `flc-missing-${Date.now()}.json`);
    expect(importFromFlc(missing)).toEqual([]);
  });

  it('maps FLC-shaped JSON to our schema', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-test-'));
    cleanups.push(dir);
    const filePath = path.join(dir, 'servers.json');
    const fixture = {
      servers: [
        {
          id: 'abc123examplefixtureid',
          label: 'Sample Server',
          notes: '',
          order: 0,
          url: 'https://sample.example.test/',
        },
      ],
    };
    fs.writeFileSync(filePath, JSON.stringify(fixture), 'utf8');
    const imported = importFromFlc(filePath);
    expect(imported).toHaveLength(1);
    expect(imported[0]).toEqual({
      id: 'abc123examplefixtureid',
      label: 'Sample Server',
      url: 'https://sample.example.test/',
      notes: '',
      order: 0,
    });
    expect(imported[0].username).toBeUndefined();
    expect(imported[0].password).toBeUndefined();
  });

  it('returns empty array for malformed JSON', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-test-'));
    cleanups.push(dir);
    const filePath = path.join(dir, 'bad.json');
    fs.writeFileSync(filePath, '{ not json', 'utf8');
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(importFromFlc(filePath)).toEqual([]);
    expect(warn).toHaveBeenCalled();
    warn.mockRestore();
  });
});
