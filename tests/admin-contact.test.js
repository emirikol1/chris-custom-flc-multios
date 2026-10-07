import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  MAILTO_URL_CAP,
  PASTE_LINE,
  WORLD_AUTHOR_EMAIL_SCRIPT,
  buildAdminMail,
  createAdminContactHandlers,
  isValidAdminEmail,
  normalizeAdminEmail,
  pickAuthorEmail,
} from '../electron/admin-contact.js';
import { ensureServersFile, loadServers, saveServers } from '../electron/store.js';

const FORBIDDEN = ['203.0.113.50', 'localuser', '/home/localuser', 'C:\\Users\\localuser'];

describe('isValidAdminEmail', () => {
  it('accepts ordinary addresses', () => {
    expect(isValidAdminEmail('admin@example.com')).toBe(true);
    expect(isValidAdminEmail('a.b+tag@mail.example.co')).toBe(true);
    expect(normalizeAdminEmail('  GM@Example.com  ')).toBe('GM@Example.com');
  });

  it('rejects missing, malformed, and header-breaking values', () => {
    expect(isValidAdminEmail('')).toBe(false);
    expect(isValidAdminEmail('not-an-email')).toBe(false);
    expect(isValidAdminEmail('a@b')).toBe(false);
    expect(isValidAdminEmail('user@')).toBe(false);
    expect(isValidAdminEmail('@host.com')).toBe(false);
    expect(isValidAdminEmail('a @b.co')).toBe(false);
    expect(isValidAdminEmail('admin@example.com\n')).toBe(false);
    expect(normalizeAdminEmail('admin@ex\nample.com')).toBe('');
    expect(isValidAdminEmail('admin@example.com?subject=hack')).toBe(false);
    expect(isValidAdminEmail('admin@example.com&bcc=evil@x.com')).toBe(false);
    expect(isValidAdminEmail(`a@${'b'.repeat(250)}.com`)).toBe(false);
    expect(normalizeAdminEmail(null)).toBe('');
    expect(normalizeAdminEmail(42)).toBe('');
  });
});

describe('pickAuthorEmail', () => {
  it('uses the first valid author email', () => {
    expect(pickAuthorEmail(['', 'not-an-email', 'gm@example.com', 'other@example.com'])).toBe('gm@example.com');
    expect(pickAuthorEmail(null)).toBe('');
    expect(pickAuthorEmail(['nope'])).toBe('');
  });

  it('keeps the world-author lookup as a fixed script', () => {
    expect(WORLD_AUTHOR_EMAIL_SCRIPT).toBe(
      'try{return (game.world.authors||[]).map(a=>a&&a.email).filter(Boolean)}catch(e){return []}',
    );
  });
});

describe('buildAdminMail', () => {
  const base = {
    to: 'admin@example.com',
    label: 'A & B',
    clientVersion: '0.5.4',
    foundryVersion: '13.348',
    joinSummary: 'join summary: ready 4s',
    issuesSummary: '1 issue: 1 warning',
    badUrlsText: '404 image  https://files.example/missing.webp\n  referenced by: Token\n',
    reportText: 'Foundry Light Client troubleshooting report\nClient 0.5.4\n',
  };

  it('encodes the subject and body and keeps the mailto under the cap', () => {
    const mail = buildAdminMail(base);
    expect(mail.ok).toBe(true);
    expect(mail.url.startsWith('mailto:admin%40example.com?')).toBe(true);
    expect(mail.url.length).toBeLessThanOrEqual(MAILTO_URL_CAP);
    expect(mail.url).not.toContain('+');
    const parsed = new URL(mail.url);
    expect(parsed.protocol).toBe('mailto:');
    expect(parsed.searchParams.get('subject')).toBe('Foundry performance report: A & B');
    const body = parsed.searchParams.get('body') || '';
    expect(body).toContain('Client 0.5.4 | Foundry 13.348');
    expect(body).toContain('Server A & B');
    expect(body).toContain('join summary: ready 4s');
    expect(body).toContain('Issues 1 issue: 1 warning');
    expect(body).toContain('https://files.example/missing.webp');
    expect(body).toContain(PASTE_LINE);
    expect(body.includes('%')).toBe(false);
    expect(mail.clipboardText).toContain('troubleshooting report');
    expect(mail.clipboardText).toContain('https://files.example/missing.webp');
    expect(mail.truncated).toBe(false);
  });

  it('truncates the bad-url list to fit and leaves the full list on the clipboard', () => {
    const lines = [];
    for (let i = 0; i < 80; i += 1) {
      lines.push(`404 image  https://world.example/assets/file-${String(i).padStart(3, '0')}.webp`);
    }
    const mail = buildAdminMail({
      ...base,
      label: 'Campaign',
      badUrlsText: lines.join('\n'),
    });
    expect(mail.url.length).toBeLessThanOrEqual(MAILTO_URL_CAP);
    expect(mail.truncated).toBe(true);
    expect(mail.body).toContain(PASTE_LINE);
    expect(mail.body).toContain('file-000.webp');
    expect(mail.body).not.toContain('file-079.webp');
    expect(mail.body).toContain('(list truncated)');
    expect(mail.clipboardText).toContain('file-000.webp');
    expect(mail.clipboardText).toContain('file-079.webp');
  });

  it('drops one oversized bad-url line instead of exceeding the cap', () => {
    const huge = `404 image  https://world.example/${'a'.repeat(4000)}.webp`;
    const mail = buildAdminMail({
      ...base,
      badUrlsText: huge,
      reportText: 'report only\n',
    });
    expect(mail.url.length).toBeLessThanOrEqual(MAILTO_URL_CAP);
    expect(mail.body).toContain(PASTE_LINE);
    expect(mail.body).not.toContain('aaaa');
    expect(mail.clipboardText).toContain(huge.slice(0, 80));
  });

  it('leaves forbidden machine details out of the body when the report does not contain them', () => {
    const mail = buildAdminMail({
      ...base,
      label: 'Campaign',
      badUrlsText: '404 image  https://world.example/assets/token.webp\n  referenced by: Actor\n',
      reportText: 'Foundry Light Client troubleshooting report\nClient 0.5.4\n',
      username: 'localuser',
      user: 'localuser',
      ip: '203.0.113.50',
      home: '/home/localuser',
      osUser: 'localuser',
      path: 'C:\\Users\\localuser',
      system: {
        username: 'localuser',
        ip: '203.0.113.50',
        home: '/home/localuser',
      },
    });
    expect(mail.ok).toBe(true);
    expect(mail.body).toContain('https://world.example/assets/token.webp');
    for (const item of FORBIDDEN) {
      expect(mail.body).not.toContain(item);
      expect(mail.url).not.toContain(item);
      expect(mail.url).not.toContain(encodeURIComponent(item));
      expect(mail.clipboardText).not.toContain(item);
    }
  });
});

describe('createAdminContactHandlers', () => {
  const cleanups = [];

  afterEach(() => {
    while (cleanups.length) {
      fs.rmSync(cleanups.pop(), { recursive: true, force: true });
    }
  });

  function tempFile() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-admin-'));
    cleanups.push(dir);
    return path.join(dir, 'servers.json');
  }

  function quietLog(bucket) {
    return (message, extra) => {
      const blob = `${message} ${JSON.stringify(extra || {})}`;
      bucket.push(blob);
      if (/@|https?:|localuser|203\.0\.113\.50|\/home\/localuser/i.test(blob)) {
        throw new Error('sensitive log');
      }
    };
  }

  it('stores, prefills, and clears adminEmail without touching other profile fields', async () => {
    const filePath = tempFile();
    saveServers(filePath, [
      {
        id: 'srv-1',
        label: 'Campaign',
        url: 'https://example.com/',
        notes: '',
        order: 0,
        username: 'player',
        password: 'secret',
      },
      { id: 'srv-2', label: 'Other', url: 'https://other.example/', order: 1 },
    ]);
    let scriptRuns = 0;
    const logs = [];
    const handlers = createAdminContactHandlers({
      serversFilePath: filePath,
      loadServers,
      saveServers,
      ensureServersFile,
      windowForServer: () => ({
        isDestroyed: () => false,
        webContents: {
          executeJavaScript: async (source) => {
            scriptRuns += 1;
            expect(source).toBe(WORLD_AUTHOR_EMAIL_SCRIPT);
            return ['not-an-email', 'gm@example.com'];
          },
        },
      }),
      logWarn: quietLog(logs),
      onSaved: () => logs.push('saved'),
    });

    const prefill = await handlers.getAdminEmail('srv-1');
    expect(prefill).toEqual({ ok: true, email: 'gm@example.com', saved: '', source: 'author' });
    expect(scriptRuns).toBe(1);

    const saved = await handlers.setAdminEmail('srv-1', ' admin@example.com ');
    expect(saved).toEqual({ ok: true, email: 'admin@example.com' });
    const stored = loadServers(filePath);
    expect(stored[0].adminEmail).toBe('admin@example.com');
    expect(stored[0].password).toBe('secret');
    expect(stored[0].username).toBe('player');
    expect(stored[1].adminEmail).toBeUndefined();

    const again = await handlers.getAdminEmail('srv-1');
    expect(again.source).toBe('profile');
    expect(again.email).toBe('admin@example.com');
    expect(scriptRuns).toBe(1);

    expect(await handlers.setAdminEmail('srv-1', 'nope')).toEqual({ ok: false, reason: 'invalid-email' });
    expect(await handlers.setAdminEmail('missing', 'admin@example.com')).toEqual({ ok: false, reason: 'no-profile' });

    const cleared = await handlers.setAdminEmail('srv-1', '');
    expect(cleared).toEqual({ ok: true, email: '' });
    expect(loadServers(filePath)[0].adminEmail).toBeUndefined();
    expect(loadServers(filePath)[0].url).toBe('https://example.com/');
  });

  it('opens a mailto and copies the report without leaking extra machine fields', async () => {
    const filePath = tempFile();
    saveServers(filePath, [
      { id: 'srv-1', label: 'Campaign', url: 'https://example.com/', adminEmail: 'admin@example.com', order: 0 },
    ]);
    const logs = [];
    let opened = '';
    let copied = '';
    let formatted = null;
    const handlers = createAdminContactHandlers({
      serversFilePath: filePath,
      loadServers,
      saveServers,
      ensureServersFile,
      windowForServer: () => {
        throw new Error('should not read authors when an address is saved');
      },
      getSnapshot: async () => ({
        snapshot: { world: { foundryVersion: '13.1' }, durations: { totalMs: 4000 } },
        findings: [{ title: 'Slow canvas', severity: 'warn' }, { title: 'See https://evil.example/x', severity: 'warn' }],
        summary: '1 issue: 1 warning',
        system: { username: 'localuser', ip: '203.0.113.50', home: '/home/localuser' },
        history: [],
      }),
      getBadUrls: async () => ({
        count: 1,
        label: 'Campaign',
        foundryVersion: '13.1',
        username: 'localuser',
        entries: [{ url: 'https://world.example/assets/token.webp', status: 404 }],
        dropped: 0,
      }),
      formatBadUrlsText: (input) => {
        formatted = input;
        return '404 image  https://world.example/assets/token.webp\n';
      },
      buildReport: (input) => {
        expect(input.systemInfo.username).toBe('localuser');
        return 'Foundry Light Client troubleshooting report\nClient 0.5.4\n';
      },
      formatJoinSummary: () => 'join summary: ready 4s',
      clipboard: {
        writeText(text) {
          copied = text;
        },
      },
      openExternal: async (url) => {
        opened = url;
      },
      clientVersion: '0.5.4',
      logWarn: quietLog(logs),
      logInfo: quietLog(logs),
    });

    const result = await handlers.emailAdmin('srv-1');
    expect(result.ok).toBe(true);
    expect(opened.startsWith('mailto:admin%40example.com?')).toBe(true);
    expect(opened.length).toBeLessThanOrEqual(MAILTO_URL_CAP);
    const body = new URL(opened).searchParams.get('body') || '';
    expect(body).toContain('https://world.example/assets/token.webp');
    expect(body).toContain('Server Campaign');
    expect(body).toContain('join summary: ready 4s');
    expect(body).toContain('Slow canvas');
    expect(body).not.toContain('https://evil.example/x');
    expect(body).toContain(PASTE_LINE);
    expect(copied).toContain('troubleshooting report');
    expect(copied).toContain('https://world.example/assets/token.webp');
    expect(formatted.username).toBeUndefined();
    for (const item of FORBIDDEN) {
      expect(body).not.toContain(item);
      expect(opened).not.toContain(item);
      expect(copied).not.toContain(item);
    }
    expect(logs.some((line) => line.includes('[admin-contact] mailto'))).toBe(true);
  });

  it('does not open mail or copy when no address is known', async () => {
    const filePath = tempFile();
    saveServers(filePath, [{ id: 'srv-1', label: 'Campaign', url: 'https://example.com/', order: 0 }]);
    let opened = 0;
    let copied = 0;
    const handlers = createAdminContactHandlers({
      serversFilePath: filePath,
      loadServers,
      saveServers,
      ensureServersFile,
      windowForServer: () => ({
        isDestroyed: () => false,
        webContents: { executeJavaScript: async () => [] },
      }),
      clipboard: { writeText() { copied += 1; } },
      openExternal: async () => { opened += 1; },
    });
    const result = await handlers.emailAdmin('srv-1');
    expect(result).toEqual({ ok: false, reason: 'need-email' });
    expect(opened).toBe(0);
    expect(copied).toBe(0);
  });
});
