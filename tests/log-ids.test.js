import { createHash } from 'crypto';
import { describe, expect, it } from 'vitest';
import { describeStateKey, shortServerHash } from '../electron/log-ids.js';

const ID_A = '6ba7b810-9dad-11d1-80b4-00c04fd430c8';
const ID_B = '6ba7b811-9dad-11d1-80b4-00c04fd430c8';
const DOC = 'Actor.9X9JkctFMogBiagD';

function sha(id) {
  return `srv:${createHash('sha256').update(id).digest('hex').slice(0, 6)}`;
}

describe('shortServerHash', () => {
  it('is the first 6 hex chars of sha256 and is stable', () => {
    expect(shortServerHash(ID_A)).toBe(sha(ID_A));
    expect(shortServerHash(ID_A)).toBe(shortServerHash(ID_A));
    expect(shortServerHash(ID_A)).toMatch(/^srv:[0-9a-f]{6}$/);
  });

  it('differs for different ids', () => {
    expect(shortServerHash(ID_A)).not.toBe(shortServerHash(ID_B));
  });

  it('returns srv:none for empty and non-strings', () => {
    expect(shortServerHash('')).toBe('srv:none');
    expect(shortServerHash(null)).toBe('srv:none');
    expect(shortServerHash(undefined)).toBe('srv:none');
    expect(shortServerHash(1)).toBe('srv:none');
    expect(shortServerHash({})).toBe('srv:none');
  });
});

describe('describeStateKey', () => {
  it('keeps bare kind words', () => {
    expect(describeStateKey('join')).toBe('join');
    expect(describeStateKey('main')).toBe('main');
    expect(describeStateKey('mud')).toBe('mud');
    expect(describeStateKey('game')).toBe('game');
    expect(describeStateKey('server-config')).toBe('server-config');
  });

  it('hashes the server id and drops document ids', () => {
    const hash = shortServerHash(ID_A);
    expect(describeStateKey(`game:${ID_A}`)).toBe(`game ${hash}`);
    expect(describeStateKey(`game:${ID_A}:mud`)).toBe(`game ${hash} mud`);
    expect(describeStateKey(`game:${ID_A}:stats`)).toBe(`game ${hash} stats`);
    expect(describeStateKey(`game:${ID_A}:layout`)).toBe(`game ${hash} layout`);
    expect(describeStateKey(`game:${ID_A}:popout-3`)).toBe(`game ${hash} popout-3`);
    expect(describeStateKey(`game:${ID_A}:popout:document:${DOC}`)).toBe(`game ${hash} popout:document`);
    expect(describeStateKey(`game:${ID_A}:popout:sidebar:chat`)).toBe(`game ${hash} popout:sidebar:chat`);
    expect(describeStateKey(`game:${ID_A}:popout:app:ActorSheet`)).toBe(`game ${hash} popout:app:ActorSheet`);

    const compendium = `Compendium.world.actors.${DOC}`;
    const described = describeStateKey(`game:${ID_A}:popout:document:${compendium}`);
    expect(described).toBe(`game ${hash} popout:document`);
    expect(described).not.toContain(ID_A);
    expect(described).not.toContain(DOC);
    expect(described).not.toContain('9X9JkctFMogBiagD');
    expect(described).not.toContain('Compendium');
  });

  it('does not treat a suffix on the anonymous game key as a server id', () => {
    expect(describeStateKey('game:layout')).toBe('game:layout');
    expect(describeStateKey('game:popout-3')).toBe('game:popout-3');
    expect(describeStateKey(`game:popout:document:${DOC}`)).toBe('game:popout:document');
    expect(describeStateKey(`game:popout:document:${DOC}`)).not.toContain('9X9JkctFMogBiagD');
  });

  it('hashes unknown segments longer than 12 characters and keeps short ones', () => {
    const long = 'not-a-known-word-segment';
    const described = describeStateKey(`custom:${long}:ok`);
    expect(described).toBe(`custom ${shortServerHash(long)} ok`);
    expect(described).not.toContain(long);
    expect(describeStateKey('custom:abcdefghijkl:ok')).toBe('custom:abcdefghijkl:ok');
    expect(describeStateKey('custom:abcdefghijklm:ok')).toBe(`custom ${shortServerHash('abcdefghijklm')} ok`);
  });

  it('hashes different server ids differently and never throws', () => {
    expect(describeStateKey(`game:${ID_A}`)).not.toBe(describeStateKey(`game:${ID_B}`));
    expect(describeStateKey(null)).toBe('unknown');
    expect(describeStateKey('')).toBe('unknown');
    expect(describeStateKey(42)).toBe('unknown');
  });
});
