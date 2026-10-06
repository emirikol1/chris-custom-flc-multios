import { describe, expect, it } from 'vitest';
import {
  APP_ID,
  FORMAT_VERSION,
  buildExport,
  mergeServers,
  parseImport,
} from '../electron/settings-transfer.js';

const SERVER_A = {
  id: 'a',
  label: 'Alpha',
  url: 'https://alpha.example/',
  notes: '',
  order: 0,
  username: 'Quinn',
  autoJoin: true,
};

describe('buildExport', () => {
  it('wraps every settings store with app/format metadata', () => {
    const out = buildExport({
      servers: [SERVER_A],
      aiProvider: { preset: 'lmstudio', baseUrl: 'http://h/v1', apiKey: 'k', model: 'm' },
      appPrefs: { mudEnabled: true },
      narratorSettings: { speakAs: 'ooc' },
      windowState: { join: { x: 1, y: 2, width: 300, height: 400 } },
      appVersion: '0.3.0',
      now: () => '2026-09-12T00:00:00.000Z',
    });
    expect(out).toEqual({
      app: APP_ID,
      format: FORMAT_VERSION,
      exportedAt: '2026-09-12T00:00:00.000Z',
      appVersion: '0.3.0',
      servers: [SERVER_A],
      aiProvider: { preset: 'lmstudio', baseUrl: 'http://h/v1', apiKey: 'k', model: 'm' },
      appPrefs: { mudEnabled: true },
      narratorSettings: { speakAs: 'ooc' },
      windowState: { join: { x: 1, y: 2, width: 300, height: 400 } },
    });
  });

  it('tolerates missing parts', () => {
    const out = buildExport({});
    expect(out.servers).toEqual([]);
    expect(out.windowState).toEqual({});
  });
});

describe('parseImport', () => {
  it('round-trips an export', () => {
    const doc = buildExport({ servers: [SERVER_A], windowState: { game: { width: 1 } } });
    const res = parseImport(JSON.stringify(doc));
    expect(res.ok).toBe(true);
    expect(res.bundle.servers).toEqual([SERVER_A]);
    expect(res.bundle.windowState).toEqual({ game: { width: 1 } });
  });

  it('rejects invalid JSON, foreign files, and unknown formats', () => {
    expect(parseImport('{nope')).toEqual({ ok: false, error: 'invalid_json' });
    expect(parseImport('[]')).toEqual({ ok: false, error: 'not_settings_file' });
    expect(parseImport(JSON.stringify({ app: 'other', format: 1 }))).toEqual({
      ok: false,
      error: 'not_settings_file',
    });
    expect(parseImport(JSON.stringify({ app: APP_ID, format: 99 }))).toEqual({
      ok: false,
      error: 'unsupported_format',
    });
  });

  it('drops malformed sections instead of failing', () => {
    const res = parseImport(
      JSON.stringify({
        app: APP_ID,
        format: 1,
        servers: [SERVER_A, 'junk', 5],
        aiProvider: 'nope',
        windowState: { join: { x: 1 }, bad: 3 },
      }),
    );
    expect(res.ok).toBe(true);
    expect(res.bundle.servers).toEqual([SERVER_A]);
    expect(res.bundle.aiProvider).toBeUndefined();
    expect(res.bundle.windowState).toEqual({ join: { x: 1 } });
  });
});

describe('mergeServers', () => {
  it('updates by id, updates by URL, adds new, skips invalid', () => {
    const existing = [SERVER_A, { id: 'b', label: 'Beta', url: 'https://beta.example/', order: 1 }];
    const incoming = [
      { id: 'a', label: 'Alpha renamed', url: 'https://alpha.example/', password: 'pw' },
      { label: 'Beta again', url: 'beta.example', username: 'Bob' },
      { label: 'Gamma', url: 'https://gamma.example/', autoJoin: false },
      { label: 'no url' },
      { label: 'bad url', url: 'https://' },
    ];
    const res = mergeServers(existing, incoming);
    expect(res).toMatchObject({ added: 1, updated: 2, skipped: 2 });
    expect(res.servers).toHaveLength(3);
    const a = res.servers.find((s) => s.id === 'a');
    expect(a.label).toBe('Alpha renamed');
    expect(a.password).toBe('pw');
    expect(a.username).toBe('Quinn');
    const b = res.servers.find((s) => s.id === 'b');
    expect(b.label).toBe('Beta again');
    expect(b.username).toBe('Bob');
    const g = res.servers.find((s) => s.label === 'Gamma');
    expect(g.id).toBeTruthy();
    expect(g.autoJoin).toBe(false);
    expect(g.order).toBe(2);
  });

  it('keeps an explicit centerPrompts false and does not invent one', () => {
    const existing = [{ id: 'a', label: 'A', url: 'https://a.example/', order: 0 }];
    const res = mergeServers(existing, [
      { id: 'a', url: 'https://a.example/', label: 'A', centerPrompts: false },
      { label: 'New', url: 'https://n.example/' },
    ]);
    expect(res.servers.find((s) => s.id === 'a').centerPrompts).toBe(false);
    expect(res.servers.find((s) => s.label === 'New').centerPrompts).toBeUndefined();
  });

  it('keeps an explicit prompt glow and does not invent one', () => {
    const existing = [{ id: 'a', label: 'A', url: 'https://a.example/', order: 0 }];
    const res = mergeServers(existing, [
      { id: 'a', url: 'https://a.example/', label: 'A', promptHighlight: false, promptAutoRaise: false, promptGlow: 'green', promptGlowStrength: 150 },
      { label: 'New', url: 'https://n.example/', promptGlow: 'chartreuse' },
    ]);
    expect(res.servers.find((s) => s.id === 'a').promptHighlight).toBe(false);
    expect(res.servers.find((s) => s.id === 'a').promptAutoRaise).toBe(false);
    expect(res.servers.find((s) => s.id === 'a').promptGlow).toBe('green');
    expect(res.servers.find((s) => s.id === 'a').promptGlowStrength).toBe(150);
    expect(res.servers.find((s) => s.label === 'New').promptGlow).toBeUndefined();
    expect(res.servers.find((s) => s.label === 'New').promptHighlight).toBeUndefined();
    expect(res.servers.find((s) => s.label === 'New').promptAutoRaise).toBeUndefined();
  });

  it('imports into an empty list', () => {
    const res = mergeServers([], [SERVER_A]);
    expect(res.added).toBe(1);
    expect(res.servers[0].url).toBe('https://alpha.example/');
    expect(res.servers[0].id).not.toBe('a'); // fresh id on add
  });
});
