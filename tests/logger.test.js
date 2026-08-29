import { describe, expect, it } from 'vitest';
import { safeLogArg, shouldRedactArg } from '../electron/log-format.js';

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
    expect(JSON.stringify(result)).not.toContain('super-secret-123');
    expect(JSON.stringify(result)).not.toContain('alice');
  });

  it('passes plain strings and numbers through unchanged', () => {
    expect(safeLogArg('hello')).toBe('hello');
    expect(safeLogArg(42)).toBe(42);
    expect(safeLogArg('https://example.com/no-creds')).toBe('https://example.com/no-creds');
  });

  it('redacts URLs with embedded userinfo', () => {
    const url = 'https://user:pass@host.example/path';
    expect(safeLogArg(url)).toBe('https://host.example/path');
    expect(shouldRedactArg(url)).toBe(true);
  });

  it('does not redact objects without username/password keys', () => {
    const obj = { id: 'x', label: 'Y' };
    expect(safeLogArg(obj)).toEqual(obj);
  });
});
