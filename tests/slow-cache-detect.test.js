import { describe, expect, it } from 'vitest';
import {
  DECIDE_AT,
  countsFor,
  isNoCacheControl,
  isNginxServer,
  noteCompleted,
  resetCounts,
  summarize,
} from '../electron/slow-cache-detect.js';

const ORIGIN = 'https://play.example';

function response(over) {
  return Object.assign({
    url: `${ORIGIN}/modules/a.js`,
    resourceType: 'script',
    fromCache: false,
    responseHeaders: {
      'cache-control': ['no-cache'],
      server: ['nginx/1.24.0'],
    },
  }, over || {});
}

function feed(win, total, noCache, extra) {
  let last = null;
  for (let i = 0; i < total; i += 1) {
    const headers = {
      server: ['nginx/1.24.0'],
      'cache-control': [i < noCache ? 'no-cache' : 'public, max-age=604800'],
    };
    last = noteCompleted(win, response({
      url: `${ORIGIN}/modules/f${i}.js`,
      responseHeaders: headers,
      ...(extra || {}),
    }), ORIGIN);
  }
  return last;
}

describe('summarize', () => {
  it('stays quiet under 40 and at a ratio under 0.8', () => {
    expect(summarize({ total: 39, noCache: 39, nginx: 39 }).slow).toBe(false);
    expect(summarize({ total: 40, noCache: 31, nginx: 40 })).toEqual({
      slow: false,
      proxy: 'nginx',
      total: 40,
      noCache: 31,
    });
    expect(summarize(null)).toEqual({ slow: false, proxy: 'other', total: 0, noCache: 0 });
  });

  it('flags 40 responses when at least 80% are no-cache', () => {
    expect(summarize({ total: 40, noCache: 32, nginx: 1 })).toEqual({
      slow: true,
      proxy: 'nginx',
      total: 40,
      noCache: 32,
    });
    expect(summarize({ total: 40, noCache: 40, nginx: 0 }).proxy).toBe('other');
    expect(summarize({ total: DECIDE_AT, noCache: DECIDE_AT, nginx: 0 }).slow).toBe(true);
  });
});

describe('header classification', () => {
  it('treats no-cache and max-age=0 as revalidation, and stale-while-revalidate as fine', () => {
    expect(isNoCacheControl('no-cache')).toBe(true);
    expect(isNoCacheControl('public, max-age=0')).toBe(true);
    expect(isNoCacheControl('public, max-age=0, stale-while-revalidate=604800')).toBe(false);
    expect(isNoCacheControl('no-cache, stale-while-revalidate=60')).toBe(false);
    expect(isNoCacheControl('public, max-age=3600')).toBe(false);
    expect(isNoCacheControl('')).toBe(false);
    expect(isNginxServer('nginx/1.24.0 (Ubuntu)')).toBe(true);
    expect(isNginxServer(' Nginx')).toBe(true);
    expect(isNginxServer('cloudflare')).toBe(false);
    expect(isNginxServer('my-nginx')).toBe(false);
  });
});

describe('noteCompleted', () => {
  it('decides at 40 and only counts same-origin package scripts, styles, and fonts', () => {
    const win = {};
    const early = feed(win, 39, 39);
    expect(early.crossed).toBe(false);
    expect(early.summary.slow).toBe(false);
    const hit = noteCompleted(win, response({ url: `${ORIGIN}/css/app.css`, resourceType: 'stylesheet' }), ORIGIN);
    expect(hit.crossed).toBe(true);
    expect(hit.summary).toEqual({ slow: true, proxy: 'nginx', total: 40, noCache: 40 });
    const more = noteCompleted(win, response({ url: `${ORIGIN}/fonts/a.woff`, resourceType: 'font', fromCache: true }), ORIGIN);
    expect(more.crossed).toBe(false);
    expect(countsFor(win).fromCache).toBe(1);
    expect(JSON.stringify(win)).toBe('{}');
    expect(Object.keys(countsFor(win)).sort()).toEqual(['fromCache', 'nginx', 'noCache', 'total']);
  });

  it('ignores other types, other paths, and other origins', () => {
    const win = {};
    noteCompleted(win, response({ resourceType: 'image' }), ORIGIN);
    noteCompleted(win, response({ url: `${ORIGIN}/game` }), ORIGIN);
    noteCompleted(win, response({ url: 'https://cdn.example/modules/a.js' }), ORIGIN);
    noteCompleted(win, response({
      responseHeaders: { 'Cache-Control': ['public, max-age=0, stale-while-revalidate=604800'], Server: ['Apache'] },
    }), ORIGIN);
    const counts = countsFor(win);
    expect(counts.total).toBe(1);
    expect(counts.noCache).toBe(0);
    expect(counts.nginx).toBe(0);
  });

  it('is slow only when the no-cache share stays at or above 0.8', () => {
    const slow = {};
    expect(feed(slow, 40, 32).summary.slow).toBe(true);
    const ok = {};
    expect(feed(ok, 40, 31).summary.slow).toBe(false);
    resetCounts(ok);
    expect(countsFor(ok).total).toBe(0);
  });
});
