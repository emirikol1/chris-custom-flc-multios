'use strict';

const fs = require('fs');
const path = require('path');

const SCHEME = 'flc-media';
const MEDIA_URL = 'flc-media://app/loading-dragon.mp4';
const MEDIA_FILE = 'loading-dragon.mp4';

/**
 * Packaged builds keep the Loading banner clip outside app.asar.
 * Electron 43's fs.createReadStream on an asar path extracts via copyFileOut
 * rather than honoring start/end against the archive, so range reads use the
 * unpacked file. A dev tree has no app.asar segment and is returned as-is.
 * @param {unknown} appPath app.getAppPath() or the project root
 * @returns {string}
 */
function rewriteAsarRoot(appPath) {
  if (typeof appPath !== 'string' || appPath.length === 0) return '';
  if (appPath.indexOf('app.asar.unpacked') !== -1) return appPath;
  if (appPath.indexOf('app.asar') === -1) return appPath;
  return appPath.replace('app.asar', 'app.asar.unpacked');
}

/**
 * Directory of the Loading banner clip. appPath is the app root
 * (app.getAppPath() in a packaged build, which ends in app.asar).
 * @param {unknown} [appPath]
 * @returns {string}
 */
function packagedMediaDir(appPath) {
  const root = rewriteAsarRoot(typeof appPath === 'string' && appPath ? appPath : path.join(__dirname, '..'));
  return path.join(root, 'src', 'media');
}

/**
 * @returns {string}
 */
function appRootPath() {
  try {
    const electron = require('electron');
    const app = electron && electron.app;
    if (app && typeof app.getAppPath === 'function') {
      const got = app.getAppPath();
      if (typeof got === 'string' && got) return got;
    }
  } catch {
    /* not running inside Electron */
  }
  return path.join(__dirname, '..');
}

/**
 * Directory of bundled Loading banner media (ships via package.json src/**).
 * @returns {string}
 */
function mediaDirPath() {
  return packagedMediaDir(appRootPath());
}

/**
 * Allow-list: only flc-media://app/loading-dragon.mp4, and only as a file
 * directly inside mediaDir. Query strings, fragments, and any other path
 * (including traversal that a URL parser would normalize away) return null.
 * @param {unknown} urlString
 * @param {unknown} mediaDir
 * @returns {string | null}
 */
function resolveMediaPath(urlString, mediaDir) {
  if (urlString !== MEDIA_URL) return null;
  if (typeof mediaDir !== 'string' || mediaDir.length === 0) return null;
  const root = path.resolve(mediaDir);
  const filePath = path.join(root, MEDIA_FILE);
  const relative = path.relative(root, filePath);
  if (relative !== MEDIA_FILE) return null;
  return filePath;
}

/**
 * Parse one HTTP Range header.
 * No header → null (send the whole file). One satisfiable byte range →
 * {start, end} inclusive. Anything else, including an unsatisfiable range,
 * → 'invalid'.
 * @param {unknown} headerValue
 * @param {unknown} size
 * @returns {{ start: number, end: number } | null | 'invalid'}
 */
function parseRange(headerValue, size) {
  if (typeof size !== 'number' || Number.isInteger(size) === false || size < 0) return 'invalid';
  if (headerValue == null) return null;
  if (typeof headerValue !== 'string') return 'invalid';
  const raw = headerValue.trim();
  if (raw === '') return null;
  if (raw.length > 64) return 'invalid';
  const ranged = /^bytes=(\d{0,15})-(\d{0,15})$/.exec(raw);
  if (!ranged) return 'invalid';
  const startText = ranged[1];
  const endText = ranged[2];
  if (startText === '' && endText === '') return 'invalid';
  if (startText === '') {
    const suffix = Number(endText);
    if (Number.isInteger(suffix) === false || suffix <= 0) return 'invalid';
    if (size === 0) return 'invalid';
    if (suffix >= size) return { start: 0, end: size - 1 };
    return { start: size - suffix, end: size - 1 };
  }
  const start = Number(startText);
  if (Number.isInteger(start) === false || start < 0) return 'invalid';
  if (size === 0 || start >= size) return 'invalid';
  let end = size - 1;
  if (endText !== '') {
    end = Number(endText);
    if (Number.isInteger(end) === false || end < start) return 'invalid';
    if (end >= size) end = size - 1;
  }
  return { start, end };
}

/**
 * Status and headers for one media response. Body bytes are filled by the handler.
 * @param {unknown} rangeHeader
 * @param {number} size
 * @returns {{ status: number, headers: Record<string, string>, start: number | null, end: number | null }}
 */
function mediaResponsePlan(rangeHeader, size) {
  const range = parseRange(rangeHeader, size);
  if (range === 'invalid') {
    const known = typeof size === 'number' && Number.isInteger(size) && size >= 0 ? String(size) : '*';
    return {
      status: 416,
      headers: {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Range': 'bytes */' + known,
      },
      start: null,
      end: null,
    };
  }
  if (range == null) {
    return {
      status: 200,
      headers: {
        'Content-Type': 'video/mp4',
        'Accept-Ranges': 'bytes',
        'Content-Length': String(size),
      },
      start: 0,
      end: size > 0 ? size - 1 : 0,
    };
  }
  const length = range.end - range.start + 1;
  return {
    status: 206,
    headers: {
      'Content-Type': 'video/mp4',
      'Accept-Ranges': 'bytes',
      'Content-Range': 'bytes ' + range.start + '-' + range.end + '/' + size,
      'Content-Length': String(length),
    },
    start: range.start,
    end: range.end,
  };
}

/**
 * @param {unknown} request
 * @returns {string | null}
 */
function readRangeHeader(request) {
  if (!request || !request.headers || typeof request.headers.get !== 'function') return null;
  try {
    const value = request.headers.get('range');
    return typeof value === 'string' ? value : null;
  } catch {
    return null;
  }
}

/**
 * @param {string} filePath
 * @param {number} start
 * @param {number} end
 * @returns {Promise<Buffer>}
 */
function readSlice(filePath, start, end) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    const stream = fs.createReadStream(filePath, { start, end });
    stream.on('data', (chunk) => {
      chunks.push(chunk);
    });
    stream.on('error', reject);
    stream.on('end', () => {
      resolve(Buffer.concat(chunks));
    });
  });
}

/**
 * protocol.handle callback. Serves only the allow-listed clip, with Range.
 * Never logs the request. The clip is read with fs.createReadStream start/end
 * (a real file when the banner is unpacked from app.asar).
 * @param {string} mediaDir
 * @returns {(request: { url?: string, headers?: { get: (name: string) => string | null } }) => Promise<Response>}
 */
function createMediaHandler(mediaDir) {
  return function handleFlcMedia(request) {
    try {
      const urlString = request && typeof request.url === 'string' ? request.url : '';
      const filePath = resolveMediaPath(urlString, mediaDir);
      if (!filePath) return Promise.resolve(new Response(null, { status: 404 }));
      let size = 0;
      try {
        const stat = fs.statSync(filePath);
        if (!stat || stat.isFile() !== true || Number.isInteger(stat.size) === false || stat.size < 0) {
          return Promise.resolve(new Response(null, { status: 404 }));
        }
        size = stat.size;
      } catch {
        return Promise.resolve(new Response(null, { status: 404 }));
      }
      const plan = mediaResponsePlan(readRangeHeader(request), size);
      if (plan.status === 416 || size === 0) {
        return Promise.resolve(new Response(null, { status: plan.status, headers: plan.headers }));
      }
      return readSlice(filePath, plan.start, plan.end).then((buf) => {
        const headers = {};
        const keys = Object.keys(plan.headers);
        for (let i = 0; i < keys.length; i += 1) headers[keys[i]] = plan.headers[keys[i]];
        headers['Content-Length'] = String(buf.length);
        return new Response(buf, { status: plan.status, headers });
      }, () => new Response(null, { status: 404 }));
    } catch {
      return Promise.resolve(new Response(null, { status: 404 }));
    }
  };
}

/**
 * Must run before the app ready event. Replaces the privileged-scheme list,
 * so this app registers only this one scheme here.
 * @param {{ registerSchemesAsPrivileged?: Function }} protocolApi
 * @returns {boolean}
 */
function registerMediaSchemes(protocolApi) {
  if (!protocolApi || typeof protocolApi.registerSchemesAsPrivileged !== 'function') return false;
  protocolApi.registerSchemesAsPrivileged([
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
  return true;
}

/**
 * Register the handler on a session protocol (default session or a game partition).
 * A second call is a no-op when the scheme is already handled.
 * @param {{ handle?: Function, isProtocolHandled?: Function }} protocolApi
 * @param {string} [dir]
 * @returns {boolean}
 */
function attachMediaProtocol(protocolApi, dir) {
  const root = typeof dir === 'string' && dir ? dir : mediaDirPath();
  if (!protocolApi || typeof protocolApi.handle !== 'function') return false;
  try {
    if (typeof protocolApi.isProtocolHandled === 'function' && protocolApi.isProtocolHandled(SCHEME) === true) {
      return false;
    }
  } catch {
    /* try to register anyway */
  }
  protocolApi.handle(SCHEME, createMediaHandler(root));
  return true;
}

module.exports = {
  SCHEME,
  MEDIA_URL,
  MEDIA_FILE,
  rewriteAsarRoot,
  packagedMediaDir,
  mediaDirPath,
  resolveMediaPath,
  parseRange,
  mediaResponsePlan,
  createMediaHandler,
  registerMediaSchemes,
  attachMediaProtocol,
};
