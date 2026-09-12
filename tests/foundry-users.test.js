import { describe, expect, it } from 'vitest';
import { fetchJoinPageUsers, joinPageUrl, parseJoinPageUsers } from '../electron/foundry-users.js';

const HTML = `
<html><body><form id="join-game">
<select name="userid">
  <option value="">Select a user</option>
  <option value="abc123">Gamemaster</option>
  <option value="def456" selected>Vex &amp; Vax</option>
  <option value="ghi789">  Percy  </option>
  <option value="ghi789">Percy</option>
</select>
<input name="password"><button name="join">Join</button>
</form></body></html>`;

describe('parseJoinPageUsers', () => {
  it('extracts trimmed, decoded, de-duplicated names and skips placeholders', () => {
    expect(parseJoinPageUsers(HTML)).toEqual(['Gamemaster', 'Vex & Vax', 'Percy']);
  });
  it('returns [] when there is no userid select', () => {
    expect(parseJoinPageUsers('<html><select name="other"><option value="1">x</option></select>')).toEqual([]);
    expect(parseJoinPageUsers('')).toEqual([]);
  });
});

describe('joinPageUrl', () => {
  it('appends /join and strips query/hash', () => {
    expect(joinPageUrl('https://example.com')).toBe('https://example.com/join');
    expect(joinPageUrl('https://example.com/')).toBe('https://example.com/join');
    expect(joinPageUrl('example.com/foundry?x=1#y')).toBe('https://example.com/foundry/join');
    expect(joinPageUrl('https://example.com/join')).toBe('https://example.com/join');
  });
  it('rejects non-http schemes', () => {
    expect(() => joinPageUrl('ftp://example.com')).toThrow();
  });
});

describe('fetchJoinPageUsers', () => {
  const okFetch = async () => ({ ok: true, status: 200, text: async () => HTML });
  it('returns users on success', async () => {
    const r = await fetchJoinPageUsers('https://example.com', { fetchImpl: okFetch });
    expect(r).toEqual({ ok: true, users: ['Gamemaster', 'Vex & Vax', 'Percy'] });
  });
  it('maps HTTP and network failures to safe error names', async () => {
    expect(await fetchJoinPageUsers('https://example.com', { fetchImpl: async () => ({ ok: false, status: 404 }) })).toEqual({ ok: false, error: 'not_found' });
    expect(await fetchJoinPageUsers('https://example.com', { fetchImpl: async () => ({ ok: false, status: 500 }) })).toEqual({ ok: false, error: 'http_error' });
    expect(await fetchJoinPageUsers('https://example.com', { fetchImpl: async () => { throw new Error('ECONNREFUSED'); } })).toEqual({ ok: false, error: 'unreachable' });
    expect(await fetchJoinPageUsers('https://example.com', { fetchImpl: async () => ({ ok: true, status: 200, text: async () => '<html></html>' }) })).toEqual({ ok: false, error: 'no_users' });
    expect(await fetchJoinPageUsers('ftp://x', { fetchImpl: okFetch })).toEqual({ ok: false, error: 'invalid_url' });
  });
});
