import { describe, expect, it } from 'vitest';
import { redactForLog } from '../electron/log-redact.js';
import { scrubForLog } from '../electron/log-format.js';

describe('redactForLog', () => {
  it('redacts username and password on server objects', () => {
    const server = {
      id: '1',
      label: 'Test',
      url: 'https://example.com',
      notes: '',
      order: 0,
      username: 'alice',
      password: 'secret',
    };
    const redacted = redactForLog(server);
    expect(redacted.username).toBe('[REDACTED]');
    expect(redacted.password).toBe('[REDACTED]');
    expect(redacted.label).toBe('Test');
    expect(server.username).toBe('alice');
  });

  it('strips userinfo from URLs', () => {
    expect(redactForLog('https://user:pass@example.com/path')).toBe(
      'https://example.com/path',
    );
  });

  it('leaves URLs without userinfo unchanged', () => {
    const url = 'https://sample.forge-vtt.com/';
    expect(redactForLog(url)).toBe(url);
  });

  it('leaves server objects without credentials unchanged except copy', () => {
    const server = { id: '1', label: 'X', url: 'https://x.com', notes: '', order: 0 };
    const redacted = redactForLog(server);
    expect(redacted).toEqual(server);
    expect(redacted).not.toBe(server);
  });
});

const opts = { hostname: 'box.local', username: 'pat' };

describe('scrubForLog', () => {
  it('replaces URL schemes and leaves bare hosts and version strings', () => {
    expect(scrubForLog('see https://example.com/a?q=1', opts)).toBe('see [url]');
    expect(scrubForLog('wss://game.example/socket', opts)).toBe('[url]');
    expect(scrubForLog('ftp://files.example/a', opts)).toBe('[url]');
    expect(scrubForLog('file:///home/me/secret.txt', opts)).toBe('[url]');
    expect(scrubForLog('open example.com and v24.14.1', opts)).toBe('open example.com and v24.14.1');
    expect(scrubForLog('Electron 28.2.1 Chromium 120.0.6099.109', opts)).toBe(
      'Electron 28.2.1 Chromium 120.0.6099.109',
    );
  });

  it('replaces filesystem paths, emails, ipv4, and Foundry document refs', () => {
    expect(scrubForLog('read /home/me/world.json', opts)).toBe('read [path]');
    expect(scrubForLog('read /Users/me/a /root/b /tmp/c /var/log/d /opt/e /mnt/f /media/g', opts)).toBe(
      'read [path] [path] [path] [path] [path] [path] [path]',
    );
    expect(scrubForLog('open C:\\Users\\me\\a.txt', opts)).toBe('open [path]');
    expect(scrubForLog('mail pat.smith+x@host.example please', opts)).toBe('mail [email] please');
    expect(scrubForLog('dns 8.8.8.8 and 192.168.0.1', opts)).toBe('dns [ip] and [ip]');
    expect(scrubForLog('opened Actor.9X9JkctFMogBiagD', opts)).toBe('opened [doc]');
  });

  it('replaces the machine hostname and a username of length >= 3', () => {
    expect(scrubForLog('from box.local today', opts)).toBe('from [host] today');
    expect(scrubForLog('BOX.LOCAL down', opts)).toBe('[host] down');
    expect(scrubForLog('notbox.local stays', opts)).toBe('notbox.local stays');
    expect(scrubForLog('pat said hello', opts)).toBe('[user] said hello');
    expect(scrubForLog('Patrick and spatial', opts)).toBe('Patrick and spatial');
    expect(scrubForLog('ab sees ab', { hostname: 'box.local', username: 'ab' })).toBe('ab sees ab');
  });

  it('scrubs nested objects and arrays without dropping ordinary string fields', () => {
    const input = {
      url: 'https://example.com/a',
      href: 'https://example.com/b',
      host: 'example.com',
      hostname: 'other.example',
      label: 'My World',
      title: 'Actor.9X9JkctFMogBiagD',
      path: '/home/me/world',
      filePath: 'C:\\Users\\me\\a.txt',
      name: 'hello',
      nested: [{ ok: true, n: 0, url: 'wss://x.example/s' }],
    };
    const out = scrubForLog(input, opts);
    expect(out).toEqual({
      url: '[url]',
      href: '[url]',
      host: 'example.com',
      hostname: 'other.example',
      label: 'My World',
      title: '[doc]',
      path: '[path]',
      filePath: '[path]',
      name: 'hello',
      nested: [{ ok: true, n: 0, url: '[url]' }],
    });
    expect(input.url).toBe('https://example.com/a');
  });

  it('redacts username and password keys and keeps numbers, booleans, and null', () => {
    const out = scrubForLog({
      username: 'alice',
      password: 'secret',
      nested: { username: 'bob', count: 2, flag: false, empty: null },
    }, opts);
    expect(out).toEqual({
      username: '[REDACTED]',
      password: '[REDACTED]',
      nested: { username: '[REDACTED]', count: 2, flag: false, empty: null },
    });
    expect(JSON.stringify(out)).not.toContain('alice');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('bob');
    expect(scrubForLog(0, opts)).toBe(0);
    expect(scrubForLog(true, opts)).toBe(true);
    expect(scrubForLog(null, opts)).toBe(null);
  });

  it('replaces functions and symbols', () => {
    expect(scrubForLog({ fn: () => 1, sym: Symbol('a') }, opts)).toEqual({ fn: '[fn]', sym: '[fn]' });
  });

  it('logs only the error name', () => {
    const err = new SyntaxError('secret page text https://hidden.example/a');
    const out = scrubForLog(err, opts);
    expect(out).toEqual({ name: 'SyntaxError' });
    expect(out).not.toHaveProperty('message');
    expect(out).not.toHaveProperty('stack');
    expect(JSON.stringify(out)).not.toContain('secret');
    expect(JSON.stringify(out)).not.toContain('hidden');
  });

  it('stops walking objects nested six levels below the root', () => {
    const leaf = { url: 'https://hidden.example/secret' };
    let shallow = leaf;
    for (let i = 0; i < 5; i += 1) shallow = { child: shallow };
    let deep = leaf;
    for (let i = 0; i < 6; i += 1) deep = { child: deep };

    let cur = scrubForLog(shallow, opts);
    for (let i = 0; i < 5; i += 1) cur = cur.child;
    expect(cur).toEqual({ url: '[url]' });

    cur = scrubForLog(deep, opts);
    for (let i = 0; i < 6; i += 1) cur = cur.child;
    expect(cur).toBe('[depth]');
    expect(JSON.stringify(scrubForLog(deep, opts))).not.toContain('hidden');
  });

  it('copies at most 200 keys and array elements', () => {
    const obj = {};
    for (let i = 0; i < 205; i += 1) obj[`k${String(i).padStart(3, '0')}`] = i;
    const keys = Object.keys(scrubForLog(obj, opts));
    expect(keys).toHaveLength(200);
    expect(keys[0]).toBe('k000');
    expect(keys[199]).toBe('k199');

    const arr = Array.from({ length: 205 }, (_, i) => i);
    const scrubbed = scrubForLog(arr, opts);
    expect(scrubbed).toHaveLength(200);
    expect(scrubbed[199]).toBe(199);
  });

  it('does not throw on circular references', () => {
    const child = { label: 'x' };
    child.up = child;
    const out = scrubForLog({ child }, opts);
    expect(out.child.label).toBe('x');
    expect(out.child.up).toBe('[circular]');

    const arr = ['ok'];
    arr.push(arr);
    expect(() => scrubForLog(arr, opts)).not.toThrow();
    expect(scrubForLog(arr, opts)[1]).toBe('[circular]');
  });

  it('returns a placeholder when a value throws while being read', () => {
    const evil = {};
    Object.defineProperty(evil, 'boom', {
      enumerable: true,
      get() {
        throw new Error('nope');
      },
    });
    expect(scrubForLog(evil, opts)).toBe('[unloggable]');
  });
});
