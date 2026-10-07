import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MEDIA_FILE,
  MEDIA_URL,
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

  it('allows only the one loading clip inside the media directory', () => {
    expect(MEDIA_URL).toBe('flc-media://app/loading-dragon.mp4');
    expect(resolveMediaPath(MEDIA_URL, dir)).toBe(path.join(path.resolve(dir), MEDIA_FILE));
    expect(resolveMediaPath(MEDIA_URL, dir + path.sep)).toBe(path.join(path.resolve(dir), MEDIA_FILE));
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
    expect(resolveMediaPath(MEDIA_URL, '')).toBeNull();
    expect(resolveMediaPath(MEDIA_URL, null)).toBeNull();
  });

  it('points at the bundled file, which stays a small mp4', () => {
    const resolved = resolveMediaPath(MEDIA_URL, mediaDirPath());
    expect(resolved).toBe(path.join(mediaDirPath(), MEDIA_FILE));
    const stat = fs.statSync(resolved);
    expect(stat.isFile()).toBe(true);
    expect(stat.size).toBeGreaterThan(1000);
    expect(stat.size).toBeLessThanOrEqual(400 * 1024);
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
    fs.writeFileSync(path.join(dir, MEDIA_FILE), payload);
    const handler = createMediaHandler(dir);

    const full = await handler({ url: MEDIA_URL, headers: new Headers() });
    expect(full.status).toBe(200);
    expect(full.headers.get('content-type')).toBe('video/mp4');
    expect(full.headers.get('accept-ranges')).toBe('bytes');
    expect(full.headers.get('content-length')).toBe('10');
    expect(Buffer.from(await full.arrayBuffer())).toEqual(payload);

    const slice = await handler({
      url: MEDIA_URL,
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
      url: MEDIA_URL,
      headers: new Headers({ range: 'bytes=0-' }),
    });
    expect(open.status).toBe(206);
    expect(open.headers.get('content-range')).toBe('bytes 0-9/10');
    expect(Buffer.from(await open.arrayBuffer())).toEqual(payload);

    const bad = await handler({
      url: MEDIA_URL,
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
