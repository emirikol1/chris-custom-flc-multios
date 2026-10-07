import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MEDIA_FILES,
  MEDIA_URLS,
  SCHEME,
  attachMediaProtocol,
  createMediaHandler,
  mediaDirPath,
  mediaResponsePlan,
  packagedMediaDir,
  rewriteAsarRoot,
  parseRange,
  registerMediaSchemes,
  resolveMediaPath,
} from '../electron/media-protocol.js';

describe('resolveMediaPath', () => {
  const dir = path.join(os.tmpdir(), 'flc-media-allow');

  it('allows only the two loading clips inside the media directory', () => {
    expect(MEDIA_URLS).toEqual([
      'flc-media://app/loading-dragon-1.mp4',
      'flc-media://app/loading-dragon-2.mp4',
    ]);
    expect(MEDIA_FILES).toEqual(['loading-dragon-1.mp4', 'loading-dragon-2.mp4']);
    for (let i = 0; i < MEDIA_URLS.length; i += 1) {
      expect(resolveMediaPath(MEDIA_URLS[i], dir)).toBe(path.join(path.resolve(dir), MEDIA_FILES[i]));
      expect(resolveMediaPath(MEDIA_URLS[i], dir + path.sep)).toBe(path.join(path.resolve(dir), MEDIA_FILES[i]));
    }
  });

  it('rejects every other address, including traversal and query strings', () => {
    const rejected = [
      'flc-media://app/../loading-dragon.mp4',
      'flc-media://app/foo/../loading-dragon.mp4',
      'flc-media://app/loading-dragon.mp4/../../etc/passwd',
      'flc-media://app/%2e%2e/loading-dragon.mp4',
      'flc-media://app/%2e%2e%2floading-dragon.mp4',
      'flc-media://app/loading-dragon.mp4?x=1',
      'flc-media://app/loading-dragon.mp4#frag',
      'flc-media://evil/loading-dragon.mp4',
      'flc-media://app/other.mp4',
      'flc-media://app/loading-dragon.mp4',
      'flc-media://app/loading-dragon-1.mp4 ',
      'flc-media://app/loading-dragon-3.mp4',
      'flc-media://app/loading-dragon.mp4/',
      'flc-media://app//loading-dragon.mp4',
      'flc-media://user:pass@app/loading-dragon.mp4',
      'flc-media://app:443/loading-dragon.mp4',
      'FLC-MEDIA://app/loading-dragon.mp4',
      'file:///tmp/loading-dragon.mp4',
      'flc-media:///loading-dragon.mp4',
      '',
      'flc-media://app/loading-dragon.mp4 ',
    ];
    for (let i = 0; i < rejected.length; i += 1) {
      expect(resolveMediaPath(rejected[i], dir)).toBeNull();
    }
    expect(resolveMediaPath(null, dir)).toBeNull();
    expect(resolveMediaPath(MEDIA_URLS[0], '')).toBeNull();
    expect(resolveMediaPath(MEDIA_URLS[0], null)).toBeNull();
    expect(resolveMediaPath(MEDIA_URLS[1], '')).toBeNull();
  });

  it('points at the bundled clips, which stay small mp4s', () => {
    expect(fs.existsSync(path.join(mediaDirPath(), 'loading-dragon.mp4'))).toBe(false);
    for (let i = 0; i < MEDIA_URLS.length; i += 1) {
      const resolved = resolveMediaPath(MEDIA_URLS[i], mediaDirPath());
      expect(resolved).toBe(path.join(mediaDirPath(), MEDIA_FILES[i]));
      const stat = fs.statSync(resolved);
      expect(stat.isFile()).toBe(true);
      expect(stat.size).toBeGreaterThan(1000);
      expect(stat.size).toBeLessThanOrEqual(2 * 1024 * 1024);
    }
  });
});

describe('parseRange', () => {
  it('returns null when the client did not ask for a range', () => {
    expect(parseRange(null, 100)).toBeNull();
    expect(parseRange(undefined, 100)).toBeNull();
    expect(parseRange('', 100)).toBeNull();
    expect(parseRange('   ', 100)).toBeNull();
  });

  it('parses a single satisfiable byte range', () => {
    expect(parseRange('bytes=0-', 100)).toEqual({ start: 0, end: 99 });
    expect(parseRange('bytes=0-9', 100)).toEqual({ start: 0, end: 9 });
    expect(parseRange('bytes=0-0', 100)).toEqual({ start: 0, end: 0 });
    expect(parseRange('bytes=90-200', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange(' bytes=2-5 ', 10)).toEqual({ start: 2, end: 5 });
    expect(parseRange('bytes=-10', 100)).toEqual({ start: 90, end: 99 });
    expect(parseRange('bytes=-500', 100)).toEqual({ start: 0, end: 99 });
  });

  it('rejects malformed or unsatisfiable ranges', () => {
    expect(parseRange('bytes=100-200', 100)).toBe('invalid');
    expect(parseRange('bytes=0-1,2-3', 100)).toBe('invalid');
    expect(parseRange('bytes=5-1', 100)).toBe('invalid');
    expect(parseRange('bytes=abc', 100)).toBe('invalid');
    expect(parseRange('bytes=', 100)).toBe('invalid');
    expect(parseRange('bytes=-', 100)).toBe('invalid');
    expect(parseRange('bytes=-0', 100)).toBe('invalid');
    expect(parseRange('Bytes=0-1', 100)).toBe('invalid');
    expect(parseRange(10, 100)).toBe('invalid');
    expect(parseRange('bytes=0-', -1)).toBe('invalid');
    expect(parseRange('bytes=0-', 1.5)).toBe('invalid');
    expect(parseRange('bytes=0-', Number.NaN)).toBe('invalid');
    expect(parseRange('bytes=0-', 0)).toBe('invalid');
  });
});

describe('mediaResponsePlan', () => {
  it('describes a full response and a 206 slice', () => {
    const full = mediaResponsePlan(null, 310);
    expect(full.status).toBe(200);
    expect(full.headers['Content-Type']).toBe('video/mp4');
    expect(full.headers['Accept-Ranges']).toBe('bytes');
    expect(full.headers['Content-Length']).toBe('310');
    expect(full.headers['Content-Range']).toBeUndefined();

    const partial = mediaResponsePlan('bytes=0-99', 310);
    expect(partial.status).toBe(206);
    expect(partial.headers['Content-Type']).toBe('video/mp4');
    expect(partial.headers['Accept-Ranges']).toBe('bytes');
    expect(partial.headers['Content-Range']).toBe('bytes 0-99/310');
    expect(partial.headers['Content-Length']).toBe('100');
    expect(partial.start).toBe(0);
    expect(partial.end).toBe(99);

    const bad = mediaResponsePlan('bytes=999-1000', 310);
    expect(bad.status).toBe(416);
    expect(bad.headers['Content-Range']).toBe('bytes */310');
    expect(bad.headers['Accept-Ranges']).toBe('bytes');
  });
});

describe('createMediaHandler', () => {
  it('serves only the allow-listed file and honors Range', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-media-'));
    const payload = Buffer.from('0123456789');
    const otherPayload = Buffer.from('abcdefghij');
    fs.writeFileSync(path.join(dir, MEDIA_FILES[0]), payload);
    fs.writeFileSync(path.join(dir, MEDIA_FILES[1]), otherPayload);
    const handler = createMediaHandler(dir);

    const full = await handler({ url: MEDIA_URLS[0], headers: new Headers() });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-length')).toBe('10');
    expect(Buffer.from(await full.arrayBuffer())).toEqual(payload);

    const second = await handler({ url: MEDIA_URLS[1], headers: new Headers() });
    expect(second.status).toBe(200);
    expect(Buffer.from(await second.arrayBuffer())).toEqual(otherPayload);

    const oldClip = await handler({
      url: 'flc-media://app/loading-dragon.mp4',
      headers: new Headers(),
    });
    expect(oldClip.status).toBe(404);

    const slice = await handler({
      url: MEDIA_URLS[0],
      headers: new Headers({ range: 'bytes=2-5' }),
    });
    expect(slice.status).toBe(206);
    expect(slice.headers.get('content-type')).toBe('video/mp4');
    expect(slice.headers.get('accept-ranges')).toBe('bytes');
    expect(slice.headers.get('content-range')).toBe('bytes 2-5/10');
    expect(slice.headers.get('content-length')).toBe('4');
    expect(Buffer.from(await slice.arrayBuffer()).toString()).toBe('2345');

    const missing = await handler({
      url: 'flc-media://app/other.mp4',
      headers: new Headers(),
    });
    expect(missing.status).toBe(404);

    const open = await handler({
      url: MEDIA_URLS[0],
      headers: new Headers({ range: 'bytes=0-' }),
    });
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe('bytes 0-9/10');
    expect(Buffer.from(await open.arrayBuffer())).toEqual(payload);

    const bad = await handler({
      url: MEDIA_URLS[1],
      headers: new Headers({ range: 'bytes=40-50' }),
    });
    expect(bad.status).toBe(416);
    expect(bad.headers.get('content-range')).toBe('bytes */10');

    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('packaged media path', () => {
  it('rewrites an asar app root onto the unpacked banner directory', () => {
    expect(rewriteAsarRoot('/opt/flc/resources/app.asar')).toBe('/opt/flc/resources/app.asar.unpacked');
    expect(rewriteAsarRoot('/opt/flc/resources/app.asar.unpacked')).toBe('/opt/flc/resources/app.asar.unpacked');
    expect(rewriteAsarRoot('C:\\FLC\\resources\\app.asar')).toBe('C:\\FLC\\resources\\app.asar.unpacked');
    expect(rewriteAsarRoot('/home/dev/project')).toBe('/home/dev/project');
    expect(rewriteAsarRoot('')).toBe('');
    expect(packagedMediaDir('/opt/flc/resources/app.asar')).toBe(
      path.join('/opt/flc/resources/app.asar.unpacked', 'src', 'media'),
    );
    expect(packagedMediaDir('/home/dev/project')).toBe(path.join('/home/dev/project', 'src', 'media'));
  });
});

describe('protocol registration', () => {
  it('registers the privileged scheme once and skips a session that already handles it', () => {
    const seen = [];
    expect(registerMediaSchemes({
      registerSchemesAsPrivileged(list) { seen.push(list); },
    })).toBe(true);
    expect(seen[0]).toEqual([
      {
        scheme: SCHEME,
        privileges: {
          standard: true,
          secure: true,
          supportFetchAPI: true,
          corsEnabled: true,
          stream: true,
        },
      },
    ]);
    expect(registerMediaSchemes(null)).toBe(false);

    let handled = false;
    let handlers = 0;
    const api = {
      isProtocolHandled(scheme) {
        expect(scheme).toBe(SCHEME);
        return handled;
      },
      handle(scheme, fn) {
        expect(scheme).toBe(SCHEME);
        expect(typeof fn).toBe('function');
        handled = true;
        handlers += 1;
      },
    };
    expect(attachMediaProtocol(api, os.tmpdir())).toBe(true);
    expect(attachMediaProtocol(api, os.tmpdir())).toBe(false);
    expect(handlers).toBe(1);
    expect(attachMediaProtocol(null)).toBe(false);
  });
});
