import { describe, expect, it } from 'vitest';
import { redactForLog } from '../electron/log-redact.js';

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
