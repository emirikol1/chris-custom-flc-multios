import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  addServer,
  deleteServer,
  listServers,
  loadServers,
  normalizeUrl,
  saveServers,
  ensureServersFile,
  updateServer,
} from '../electron/store.js';

function tempServersFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-test-'));
  return {
    dir,
    filePath: path.join(dir, 'servers.json'),
  };
}

describe('normalizeUrl', () => {
  it('passes through valid https URLs', () => {
    expect(normalizeUrl('https://sample.forge-vtt.com/')).toBe('https://sample.forge-vtt.com/');
  });

  it('passes through valid http URLs', () => {
    expect(normalizeUrl('http://localhost:30000')).toBe('http://localhost:30000/');
  });

  it('prefixes bare host with https://', () => {
    expect(normalizeUrl('example.com')).toBe('https://example.com/');
    expect(normalizeUrl('  forge.example.com/path  ')).toBe('https://forge.example.com/path');
  });

  it('rejects invalid strings', () => {
    expect(() => normalizeUrl('')).toThrow(/URL is required/);
    expect(() => normalizeUrl('not a valid url !!!')).toThrow(/Invalid URL/);
  });
});

describe('server list operations', () => {
  const base = [
    { id: 'a', label: 'B', url: 'https://b.example', notes: '', order: 2 },
    { id: 'b', label: 'A', url: 'https://a.example', notes: '', order: 1 },
    { id: 'c', label: 'C', url: 'https://c.example', notes: '', order: 1 },
  ];

  it('listServers sorts by order then label', () => {
    const sorted = listServers(base);
    expect(sorted.map((s) => s.id)).toEqual(['b', 'c', 'a']);
  });

  it('addServer appends with generated id and normalized url', () => {
    const next = addServer([], {
      label: 'New',
      url: 'host.example',
      notes: 'n',
      order: 0,
    });
    expect(next).toHaveLength(1);
    expect(next[0].id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    );
    expect(next[0].url).toBe('https://host.example/');
    expect(next[0].label).toBe('New');
  });

  it('updateServer patches fields and normalizes url', () => {
    const servers = [{ id: 'x', label: 'Old', url: 'https://old.example', notes: '', order: 0 }];
    const next = updateServer(servers, 'x', { label: 'New', url: 'new.example' });
    expect(next[0].label).toBe('New');
    expect(next[0].url).toBe('https://new.example/');
    expect(next[0].id).toBe('x');
  });

  it('deleteServer removes by id', () => {
    const next = deleteServer(base, 'b');
    expect(next).toHaveLength(2);
    expect(next.find((s) => s.id === 'b')).toBeUndefined();
  });
});

describe('save/load round-trip', () => {
  const cleanups = [];

  afterEach(() => {
    for (const dir of cleanups) {
      fs.rmSync(dir, { recursive: true, force: true });
    }
    cleanups.length = 0;
  });

  it('persists servers to disk and reloads', () => {
    const { dir, filePath } = tempServersFile();
    cleanups.push(dir);
    const servers = [
      {
        id: '1',
        label: 'Sample Server',
        url: 'https://sample.forge-vtt.com/',
        notes: '',
        order: 0,
        username: 'u',
        password: 'p',
      },
    ];
    saveServers(filePath, servers);
    expect(fs.existsSync(filePath)).toBe(true);
    const loaded = loadServers(filePath);
    expect(loaded).toEqual(servers);
  });

  it('ensureServersFile creates empty list when missing', () => {
    const { dir, filePath } = tempServersFile();
    cleanups.push(dir);
    ensureServersFile(filePath);
    expect(loadServers(filePath)).toEqual([]);
    ensureServersFile(filePath);
    expect(loadServers(filePath)).toEqual([]);
  });
});
