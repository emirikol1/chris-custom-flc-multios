import { describe, expect, it } from 'vitest';
import { safeLogArg, safeLogArgs, shouldRedactArg } from '../electron/log-format.js';
import { getLogLevel, logInfo, logger, setLogLevel } from '../electron/logger.js';

describe('safeLogArg', () => {
  it('redacts server-shaped objects with credentials', () => {
    const server = {
      id: '1',
      label: 'Mine',
      url: 'https://example.com',
      username: 'alice',
      password: 'super-secret-123',
    };
    const result = safeLogArg(server);
    expect(result).not.toBe(server);
    expect(result.password).toBe('[REDACTED]');
    expect(result.username).toBe('[REDACTED]');
    expect(result.url).toBe('[url]');
    expect(JSON.stringify(result)).not.toContain('super-secret-123');
    expect(JSON.stringify(result)).not.toContain('alice');
    expect(JSON.stringify(result)).not.toContain('example.com');
  });

  it('passes plain strings and numbers through unchanged', () => {
    expect(safeLogArg('hello')).toBe('hello');
    expect(safeLogArg(42)).toBe(42);
    expect(safeLogArg('https://example.com/no-creds')).toBe('[url]');
  });

  it('redacts URLs with embedded userinfo', () => {
    const url = 'https://user:pass@host.example/path';
    expect(safeLogArg(url)).toBe('[url]');
    expect(shouldRedactArg(url)).toBe(true);
    expect(safeLogArg(url)).not.toContain('user');
    expect(safeLogArg(url)).not.toContain('host.example');
  });

  it('scrubs every arg passed through safeLogArgs', () => {
    expect(safeLogArgs(['https://example.com/a', 1, 'ok'])).toEqual(['[url]', 1, 'ok']);
  });

  it('does not redact objects without username/password keys', () => {
    const obj = { id: 'x', label: 'Y' };
    expect(safeLogArg(obj)).toEqual(obj);
  });
});

describe('logger runtime level', () => {
  it('validates levels and applies them to the file and console transports', () => {
    const before = getLogLevel();
    try {
      expect(() => setLogLevel('nope')).toThrow(RangeError);
      expect(getLogLevel()).toBe(before);

      setLogLevel('DEBUG');
      expect(getLogLevel()).toBe('debug');
      expect(logger.transports.file.level).toBe('debug');
      expect(logger.transports.console.level).toBe('debug');

      setLogLevel('off');
      expect(getLogLevel()).toBe('off');
      expect(logger.transports.file.level).toBe(false);
      expect(logger.transports.console.level).toBe(false);

      setLogLevel('false');
      expect(getLogLevel()).toBe('false');
      expect(logger.transports.file.level).toBe(false);
      expect(logger.transports.console.level).toBe(false);
    } finally {
      setLogLevel(before);
    }
  });

  it('scrubs the message and the args before electron-log sees them', () => {
    const seen = [];
    const hook = (msg) => {
      seen.push(msg.data);
      return false;
    };
    const before = getLogLevel();
    logger.hooks.push(hook);
    try {
      setLogLevel('info');
      logInfo('open https://example.com/secret and Actor.9X9JkctFMogBiagD', {
        url: 'https://example.com/secret',
        password: 'super-secret-123',
      });
    } finally {
      const idx = logger.hooks.indexOf(hook);
      if (idx >= 0) logger.hooks.splice(idx, 1);
      setLogLevel(before);
    }
    expect(seen.length).toBeGreaterThan(0);
    const data = seen[0];
    expect(data[0]).toBe('open [url] and [doc]');
    expect(data[1]).toEqual({ url: '[url]', password: '[REDACTED]' });
    expect(JSON.stringify(data)).not.toContain('example.com');
    expect(JSON.stringify(data)).not.toContain('super-secret-123');
    expect(JSON.stringify(data)).not.toContain('9X9JkctFMogBiagD');
  });
});
