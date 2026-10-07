import { describe, expect, it } from 'vitest';
import {
  createBadUrlStore,
  failurePathname,
  formatBadUrlsText,
  shouldRecordFailure,
} from '../electron/bad-urls.js';

function entry(over) {
  return {
    url: 'https://example.com/a.webp',
    status: 404,
    error: null,
    resourceType: 'image',
    referrer: 'https://example.com/game',
    at: 1000,
    ...over,
  };
}

describe('shouldRecordFailure', () => {
  const types = ['xhr', 'fetch', 'image', 'media', 'font', 'stylesheet', 'script', 'other', 'subFrame'];

  it('records HTTP failures at 400 and above except auth challenges', () => {
    for (const resourceType of types) {
      expect(shouldRecordFailure({ statusCode: 400, resourceType })).toBe(true);
      expect(shouldRecordFailure({ statusCode: 403, resourceType })).toBe(true);
      expect(shouldRecordFailure({ statusCode: 404, resourceType })).toBe(true);
      expect(shouldRecordFailure({ statusCode: 500, resourceType })).toBe(true);
      expect(shouldRecordFailure({ statusCode: 401, resourceType })).toBe(false);
      expect(shouldRecordFailure({ statusCode: 407, resourceType })).toBe(false);
      expect(shouldRecordFailure({ statusCode: 304, resourceType })).toBe(false);
      expect(shouldRecordFailure({ statusCode: 200, resourceType })).toBe(false);
    }
  });

  it('records network errors other than cache, abort, and client blocks', () => {
    expect(shouldRecordFailure({ errorName: 'ERR_NAME_NOT_RESOLVED', resourceType: 'script' })).toBe(true);
    expect(shouldRecordFailure({ errorName: 'net::ERR_CONNECTION_REFUSED', resourceType: 'fetch' })).toBe(true);
    expect(shouldRecordFailure({ errorName: 'ERR_CACHE_MISS', resourceType: 'image' })).toBe(false);
    expect(shouldRecordFailure({ errorName: 'ERR_ABORTED', resourceType: 'image' })).toBe(false);
    expect(shouldRecordFailure({ errorName: 'net::ERR_ABORTED', resourceType: 'script' })).toBe(false);
    expect(shouldRecordFailure({ errorName: 'ERR_BLOCKED_BY_CLIENT', resourceType: 'script' })).toBe(false);
    expect(shouldRecordFailure({ errorName: 'ERR_BLOCKED_BY_RESPONSE', resourceType: 'xhr' })).toBe(false);
  });

  it('ignores the main frame, including a 401', () => {
    expect(shouldRecordFailure({ statusCode: 401, resourceType: 'mainFrame' })).toBe(false);
    expect(shouldRecordFailure({ statusCode: 404, resourceType: 'mainFrame' })).toBe(false);
    expect(shouldRecordFailure({ errorName: 'ERR_NAME_NOT_RESOLVED', resourceType: 'mainFrame' })).toBe(false);
  });

  it('prefers a real HTTP failure over a skipped error name', () => {
    expect(shouldRecordFailure({
      statusCode: 404,
      errorName: 'ERR_ABORTED',
      resourceType: 'image',
    })).toBe(true);
  });

  it('rejects missing input', () => {
    expect(shouldRecordFailure(null)).toBe(false);
    expect(shouldRecordFailure({})).toBe(false);
    expect(shouldRecordFailure({ statusCode: 404 })).toBe(false);
    expect(shouldRecordFailure({ statusCode: Number.NaN, resourceType: 'image' })).toBe(false);
  });
});

describe('createBadUrlStore', () => {
  it('dedupes by url, keeps the first record, and bumps hits', () => {
    let clock = 5000;
    const store = createBadUrlStore({ now: () => clock });
    store.note('hub', entry({ at: 1000, status: 404, error: 'ERR_FAILED' }));
    store.note('hub', entry({
      at: 2000,
      status: 500,
      error: null,
      resourceType: 'script',
      referrer: 'https://example.com/other',
    }));
    const rows = store.list('hub');
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      url: 'https://example.com/a.webp',
      status: 404,
      error: 'ERR_FAILED',
      resourceType: 'image',
      referrer: 'https://example.com/game',
      at: 1000,
      lastAt: 2000,
      hits: 2,
    });
    expect(store.count('hub')).toBe(1);
    expect(store.dropped('hub')).toBe(0);
    rows[0].hits = 99;
    expect(store.list('hub')[0].hits).toBe(2);
  });

  it('uses the clock when at is missing and isolates hubs', () => {
    const store = createBadUrlStore({ now: () => 42 });
    store.note('a', entry({ at: undefined }));
    store.note('b', entry({ url: 'https://example.com/b.webp' }));
    expect(store.list('a')[0].at).toBe(42);
    expect(store.list('a')[0].lastAt).toBe(42);
    expect(store.count('b')).toBe(1);
    expect(store.list('missing')).toEqual([]);
    expect(store.count('')).toBe(0);
    expect(store.dropped(null)).toBe(0);
  });

  it('drops new urls once the cap is full and counts each unique url once', () => {
    const store = createBadUrlStore({ cap: 2, now: () => 1 });
    store.note('hub', entry({ url: 'https://example.com/1.webp' }));
    store.note('hub', entry({ url: 'https://example.com/2.webp' }));
    store.note('hub', entry({ url: 'https://example.com/3.webp' }));
    store.note('hub', entry({ url: 'https://example.com/3.webp', at: 9 }));
    store.note('hub', entry({ url: 'https://example.com/4.webp' }));
    store.note('hub', entry({ url: 'https://example.com/1.webp', at: 8 }));
    expect(store.list('hub').map((row) => row.url)).toEqual([
      'https://example.com/1.webp',
      'https://example.com/2.webp',
    ]);
    expect(store.list('hub')[0].hits).toBe(2);
    expect(store.list('hub')[0].lastAt).toBe(8);
    expect(store.count('hub')).toBe(2);
    expect(store.dropped('hub')).toBe(2);
  });

  it('rejects invalid fields and does not count them as dropped', () => {
    const store = createBadUrlStore({ cap: 1 });
    store.note('', entry());
    store.note('hub', entry({ url: '' }));
    store.note('hub', entry({ url: 12 }));
    store.note('hub', entry({ url: 'x'.repeat(2049) }));
    store.note('hub', entry({ resourceType: 'y'.repeat(2049) }));
    store.note('hub', entry({ status: Number.POSITIVE_INFINITY }));
    store.note('hub', entry({ referrer: 'z'.repeat(2049) }));
    store.note('hub', null);
    expect(store.count('hub')).toBe(0);
    expect(store.dropped('hub')).toBe(0);
    store.note('hub', entry());
    store.note('hub', entry({ referrer: 'z'.repeat(2049), at: 7 }));
    expect(store.list('hub')[0].hits).toBe(2);
    expect(store.list('hub')[0].lastAt).toBe(7);
    expect(store.dropped('hub')).toBe(0);
  });

  it('clears and forgets one hub', () => {
    const store = createBadUrlStore({ cap: 1 });
    store.note('hub', entry());
    store.note('hub', entry({ url: 'https://example.com/extra.webp' }));
    store.note('other', entry({ url: 'https://example.com/b.webp' }));
    expect(store.dropped('hub')).toBe(1);
    expect(store.count('hub')).toBe(1);
    store.clear('hub');
    expect(store.count('hub')).toBe(0);
    expect(store.dropped('hub')).toBe(0);
    expect(store.count('other')).toBe(1);
    store.forget('other');
    expect(store.list('other')).toEqual([]);
  });
});

describe('failurePathname', () => {
  it('decodes the pathname and drops the query', () => {
    expect(failurePathname('https://example.com/assets/My%20Map.webp?x=1')).toBe('/assets/My Map.webp');
    expect(failurePathname('')).toBe('');
    expect(failurePathname('not a url')).toBe('not a url');
    expect(failurePathname('x'.repeat(2049))).toBe('');
  });
});

describe('formatBadUrlsText', () => {
  it('writes a clipboard report for two failing files', () => {
    const text = formatBadUrlsText({
      label: 'Sunday Game',
      generatedAt: '2026-10-06T21:00:00.000Z',
      foundryVersion: '13.348',
      systemId: 'dnd5e',
      systemVersion: '4.1.0',
      dropped: 1,
      entries: [
        {
          url: 'https://example.com/assets/maps/cave.webp',
          status: 404,
          error: null,
          resourceType: 'image',
          referrer: 'https://example.com/game',
          hits: 3,
          refs: ['Scene \u201cCave\u201d background', 'Token \u201cGoblin\u201d on scene \u201cCave\u201d'],
        },
        {
          url: 'https://cdn.example/modules/missing.js',
          status: null,
          error: 'ERR_NAME_NOT_RESOLVED',
          resourceType: 'script',
          referrer: null,
          hits: 1,
          refs: [],
        },
      ],
    });
    expect(text).toBe([
      'Missing or failing files — Sunday Game — 2026-10-06T21:00:00.000Z',
      'Foundry 13.348, system dnd5e 4.1.0',
      '',
      '404 image  https://example.com/assets/maps/cave.webp',
      '  referenced by: Scene \u201cCave\u201d background, Token \u201cGoblin\u201d on scene \u201cCave\u201d',
      '  referrer: https://example.com/game',
      '  seen 3\u00d7',
      '',
      'ERR_NAME_NOT_RESOLVED script  https://cdn.example/modules/missing.js',
      '  referenced by: (no in-world reference found; may be CSS/module asset)',
      '',
      '2 entries (1 more not recorded)',
      '',
    ].join('\n'));
  });

  it('omits the footer, referrer, and seen line when they do not apply', () => {
    const text = formatBadUrlsText({
      label: 'Sunday Game',
      generatedAt: '2026-10-06T21:00:00.000Z',
      foundryVersion: '13.348',
      systemId: 'dnd5e',
      systemVersion: '4.1.0',
      dropped: 0,
      entries: [{
        url: 'https://example.com/a.webp',
        status: 403,
        resourceType: 'image',
        hits: 1,
      }],
    });
    expect(text).toBe([
      'Missing or failing files — Sunday Game — 2026-10-06T21:00:00.000Z',
      'Foundry 13.348, system dnd5e 4.1.0',
      '',
      '403 image  https://example.com/a.webp',
      '  referenced by: (no in-world reference found; may be CSS/module asset)',
      '',
    ].join('\n'));
    expect(text).not.toContain('more not recorded');
    expect(text).not.toContain('seen ');
    expect(text).not.toContain('referrer:');
  });

  it('fills missing identity with dashes', () => {
    const text = formatBadUrlsText({});
    expect(text.startsWith('Missing or failing files — — — ')).toBe(true);
    expect(text).toContain('Foundry —, system — —\n');
    expect(text).not.toContain('more not recorded');
  });
});
