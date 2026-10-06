'use strict';

const fs = require('fs');
const https = require('https');
const path = require('path');

/**
 * Manual update check. Nothing in this module runs until checkForAppUpdate
 * is called. It talks only to the public GitHub release for this app, saves
 * the matching installer into a chosen directory, and does not launch it.
 * Returned messages never include a URL, a host, or a filesystem path.
 */

const RELEASE_API = 'https://api.github.com/repos/emirikol1/chris-custom-flc-multios/releases/latest';
const USER_AGENT = 'chris-custom-flc-multios';
const MAX_INSTALLER_BYTES = 250 * 1024 * 1024;
const MAX_RELEASE_JSON_BYTES = 1024 * 1024;
const MAX_REDIRECTS = 5;

const ALLOWED_HOSTS = new Set([
  'api.github.com',
  'github.com',
  'objects.githubusercontent.com',
  'release-assets.githubusercontent.com',
]);

const INSTALLER_NAME = /^ChrisCustomFLC-MultiOS-(\d+\.\d+\.\d+)-(windows-setup\.exe|mac\.dmg|linux\.deb|linux\.AppImage)$/;

const DEB_IDS = new Set(['debian', 'ubuntu', 'linuxmint', 'pop', 'elementary', 'zorin', 'neon']);

/**
 * @param {string} code
 * @returns {Error & { code: string }}
 */
function fail(code) {
  const err = new Error(code);
  err.code = code;
  return err;
}

/**
 * @param {unknown} value
 * @returns {[number, number, number] | null}
 */
function parseVersion(value) {
  const match = String(value == null ? '' : value).trim().replace(/^v/i, '').match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!match) return null;
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

/**
 * @param {unknown} left
 * @param {unknown} right
 * @returns {-1 | 0 | 1 | null}
 */
function compareVersions(left, right) {
  const a = parseVersion(left);
  const b = parseVersion(right);
  if (!a || !b) return null;
  for (let i = 0; i < 3; i += 1) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

/**
 * Debian-family Linux gets the .deb. Everyone else on Linux gets the AppImage.
 * @param {string} osReleaseText
 * @returns {boolean}
 */
function prefersDebInstaller(osReleaseText) {
  const ids = [];
  for (const line of String(osReleaseText || '').split('\n')) {
    const match = /^(?:ID|ID_LIKE)=(?:"([^"]*)"|(\S+))/.exec(line.trim());
    if (!match) continue;
    ids.push(String(match[1] || match[2] || '').toLowerCase());
  }
  return ids.join(' ').split(/\s+/).some((id) => DEB_IDS.has(id));
}

/**
 * @param {string} urlString
 * @returns {URL | null}
 */
function parseAllowedUpdateUrl(urlString) {
  let parsed;
  try {
    parsed = new URL(urlString);
  } catch {
    return null;
  }
  if (parsed.protocol !== 'https:') return null;
  if (parsed.username || parsed.password) return null;
  if (!ALLOWED_HOSTS.has(parsed.hostname)) return null;
  return parsed;
}

/**
 * @param {string} current
 * @param {string} location
 * @returns {string | null}
 */
function resolveAllowedRedirect(current, location) {
  let next;
  try {
    next = new URL(location, current).href;
  } catch {
    return null;
  }
  return parseAllowedUpdateUrl(next) ? next : null;
}

/**
 * @param {string} platform
 * @param {boolean} deb
 * @returns {string | null}
 */
function installerSuffix(platform, deb) {
  if (platform === 'win32') return 'windows-setup.exe';
  if (platform === 'darwin') return 'mac.dmg';
  if (platform === 'linux') return deb ? 'linux.deb' : 'linux.AppImage';
  return null;
}

/**
 * @param {string} downloadsDir
 * @param {string} fileName
 * @returns {string}
 */
function installerDestination(downloadsDir, fileName) {
  if (typeof downloadsDir !== 'string' || downloadsDir.trim() === '') throw fail('bad-name');
  if (!INSTALLER_NAME.test(fileName)) throw fail('bad-name');
  const root = path.resolve(downloadsDir);
  const dest = path.resolve(root, fileName);
  if (path.dirname(dest) !== root) throw fail('bad-name');
  return dest;
}

/**
 * @param {unknown} release
 * @param {{ currentVersion: string, platform: string, osRelease?: string }} opts
 * @returns {{ action: 'current' | 'ahead', version: string, current: string } | { action: 'download', version: string, fileName: string, url: string } | { action: 'error', code: string }}
 */
function planUpdate(release, opts) {
  const current = parseVersion(opts && opts.currentVersion);
  if (!current) return { action: 'error', code: 'no-version' };
  const tag = release && typeof release === 'object' ? /** @type {{ tag_name?: unknown, assets?: unknown }} */ (release).tag_name : '';
  const remote = parseVersion(tag);
  if (!remote) return { action: 'error', code: 'bad-release' };
  const currentText = current.join('.');
  const remoteText = remote.join('.');
  const order = compareVersions(currentText, remoteText);
  if (order === 0) return { action: 'current', version: remoteText, current: currentText };
  if (order === 1) return { action: 'ahead', version: remoteText, current: currentText };
  const suffix = installerSuffix(opts.platform, opts.platform === 'linux' && prefersDebInstaller(opts.osRelease || ''));
  if (!suffix) return { action: 'error', code: 'no-asset' };
  const fileName = `ChrisCustomFLC-MultiOS-${remoteText}-${suffix}`;
  const assets = release && Array.isArray(/** @type {{ assets?: unknown }} */ (release).assets)
    ? /** @type {Array<{ name?: unknown, browser_download_url?: unknown }>} */ (/** @type {{ assets: unknown[] }} */ (release).assets)
    : [];
  const asset = assets.find((item) => item && item.name === fileName);
  const url = asset && typeof asset.browser_download_url === 'string' ? asset.browser_download_url : '';
  if (!asset || !parseAllowedUpdateUrl(url)) return { action: 'error', code: 'no-asset' };
  return { action: 'download', version: remoteText, fileName, url };
}

/**
 * @param {string} code
 * @param {{ version?: string, current?: string, fileName?: string }} [extra]
 * @returns {{ status: string, message: string, version?: string, fileName?: string }}
 */
function publicResult(code, extra) {
  const version = extra && extra.version ? extra.version : '';
  const current = extra && extra.current ? extra.current : '';
  const fileName = extra && extra.fileName ? extra.fileName : '';
  if (code === 'current') {
    return { status: 'current', version, message: `This copy is already the latest version (${version}).` };
  }
  if (code === 'ahead') {
    return {
      status: 'ahead',
      version,
      message: `This copy (${current}) is newer than the published release (${version}).`,
    };
  }
  if (code === 'downloaded') {
    return {
      status: 'downloaded',
      version,
      fileName,
      message: `Version ${version} was saved as ${fileName} in your Downloads folder. Close this app, then run that file from your Downloads folder.`,
    };
  }
  const messages = {
    network: 'Could not reach the update server.',
    http: 'The update server did not return an installer.',
    'too-large': 'The installer was larger than expected and was not saved.',
    'bad-url': 'The update server did not offer a usable installer.',
    'bad-name': 'The update server did not offer a usable installer.',
    'bad-release': 'The published release could not be read.',
    'no-asset': 'No installer for this system was published.',
    'no-version': 'This copy of the app has no version.',
  };
  return { status: 'error', message: messages[code] || messages.network };
}

/**
 * @param {string} urlString
 * @param {Record<string, string>} headers
 * @param {(url: string, headers: Record<string, string>) => Promise<{ statusCode: number, headers: Record<string, string | string[] | undefined>, stream: NodeJS.ReadableStream }>} request
 * @param {number} redirectsLeft
 */
async function follow(urlString, headers, request, redirectsLeft) {
  if (!parseAllowedUpdateUrl(urlString)) throw fail('bad-url');
  const res = await request(urlString, headers);
  const code = res && res.statusCode;
  const location = res && res.headers && (res.headers.location || res.headers.Location);
  if (code >= 300 && code < 400 && location) {
    if (res.stream && typeof res.stream.resume === 'function') res.stream.resume();
    if (redirectsLeft <= 0) throw fail('http');
    const next = resolveAllowedRedirect(urlString, Array.isArray(location) ? location[0] : String(location));
    if (!next) throw fail('bad-url');
    return follow(next, headers, request, redirectsLeft - 1);
  }
  return res;
}

/**
 * @param {string} url
 * @param {string} dest
 * @param {(url: string, headers: Record<string, string>) => Promise<{ statusCode: number, headers: Record<string, string | string[] | undefined>, stream: NodeJS.ReadableStream }>} request
 */
async function saveUrlToFile(url, dest, request) {
  const partial = `${dest}.partial`;
  const res = await follow(url, { 'User-Agent': USER_AGENT }, request, MAX_REDIRECTS);
  if (!res || res.statusCode !== 200 || !res.stream) {
    if (res && res.stream && typeof res.stream.resume === 'function') res.stream.resume();
    throw fail('http');
  }
  const declared = Number(res.headers && (res.headers['content-length'] || res.headers['Content-Length']));
  if (Number.isFinite(declared) && declared > MAX_INSTALLER_BYTES) {
    if (typeof res.stream.resume === 'function') res.stream.resume();
    throw fail('too-large');
  }
  await new Promise((resolve, reject) => {
    let settled = false;
    const failWrite = (err) => {
      if (settled) return;
      settled = true;
      if (typeof res.stream.destroy === 'function') res.stream.destroy();
      out.destroy();
      fs.rm(partial, { force: true }, () => reject(err));
    };
    const out = fs.createWriteStream(partial, { flags: 'w', mode: 0o644 });
    let total = 0;
    res.stream.on('data', (chunk) => {
      if (settled) return;
      const size = chunk && chunk.length ? chunk.length : 0;
      total += size;
      if (total > MAX_INSTALLER_BYTES) {
        failWrite(fail('too-large'));
        return;
      }
      if (!out.write(chunk)) {
        if (typeof res.stream.pause === 'function') res.stream.pause();
        out.once('drain', () => {
          if (!settled && typeof res.stream.resume === 'function') res.stream.resume();
        });
      }
    });
    res.stream.on('end', () => {
      if (!settled) out.end();
    });
    res.stream.on('error', () => failWrite(fail('network')));
    out.on('error', () => failWrite(fail('network')));
    out.on('finish', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
  if (!fs.existsSync(partial)) throw fail('network');
  if (fs.existsSync(dest)) fs.rmSync(dest, { force: true });
  fs.renameSync(partial, dest);
}

/**
 * @param {string} urlString
 * @param {Record<string, string>} [headers]
 * @param {number} [redirectsLeft]
 * @param {number} [timeoutMs]
 * @returns {Promise<{ statusCode: number, headers: Record<string, string | string[] | undefined>, stream: import('http').IncomingMessage }>}
 */
function httpsRequest(urlString, headers, redirectsLeft = MAX_REDIRECTS, timeoutMs = 20000) {
  const parsed = parseAllowedUpdateUrl(urlString);
  if (!parsed) return Promise.reject(fail('bad-url'));
  return new Promise((resolve, reject) => {
    const req = https.get(parsed, {
      headers: Object.assign({ 'User-Agent': USER_AGENT }, headers || {}),
      timeout: timeoutMs,
    }, (res) => {
      const location = res.headers.location;
      const code = res.statusCode || 0;
      if (code >= 300 && code < 400 && location) {
        res.resume();
        if (redirectsLeft <= 0) {
          reject(fail('http'));
          return;
        }
        const next = resolveAllowedRedirect(parsed.href, Array.isArray(location) ? location[0] : location);
        if (!next) {
          reject(fail('bad-url'));
          return;
        }
        resolve(httpsRequest(next, headers, redirectsLeft - 1, timeoutMs));
        return;
      }
      resolve({ statusCode: code, headers: res.headers, stream: res });
    });
    req.on('timeout', () => {
      req.destroy();
      reject(fail('network'));
    });
    req.on('error', () => reject(fail('network')));
  });
}

/**
 * @param {(url: string, headers: Record<string, string>) => Promise<{ statusCode: number, headers: Record<string, string | string[] | undefined>, stream: NodeJS.ReadableStream }>} [request]
 */
async function fetchLatestRelease(request = httpsRequest) {
  const res = await follow(RELEASE_API, {
    'User-Agent': USER_AGENT,
    Accept: 'application/vnd.github+json',
  }, request, MAX_REDIRECTS);
  if (!res || res.statusCode !== 200 || !res.stream) {
    if (res && res.stream && typeof res.stream.resume === 'function') res.stream.resume();
    throw fail('http');
  }
  const chunks = [];
  let total = 0;
  for await (const chunk of res.stream) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    total += buf.length;
    if (total > MAX_RELEASE_JSON_BYTES) throw fail('too-large');
    chunks.push(buf);
  }
  try {
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
  } catch {
    throw fail('bad-release');
  }
}

/**
 * Called only from the Check for updates button.
 * @param {{
 *   currentVersion: string,
 *   platform: string,
 *   osRelease?: string,
 *   downloadsDir: string,
 *   fetchRelease?: () => Promise<unknown>,
 *   request?: (url: string, headers: Record<string, string>) => Promise<{ statusCode: number, headers: Record<string, string | string[] | undefined>, stream: NodeJS.ReadableStream }>,
 * }} opts
 */
async function checkForAppUpdate(opts) {
  try {
    const fetchRelease = opts.fetchRelease || (() => fetchLatestRelease(opts.request));
    const release = await fetchRelease();
    const plan = planUpdate(release, opts);
    if (plan.action === 'error') return publicResult(plan.code);
    if (plan.action === 'current') return publicResult('current', plan);
    if (plan.action === 'ahead') return publicResult('ahead', plan);
    const dest = installerDestination(opts.downloadsDir, plan.fileName);
    await saveUrlToFile(plan.url, dest, opts.request || httpsRequest);
    return publicResult('downloaded', plan);
  } catch (err) {
    const code = err && err.code && typeof err.code === 'string' ? err.code : 'network';
    return publicResult(code);
  }
}

module.exports = {
  RELEASE_API,
  compareVersions,
  prefersDebInstaller,
  parseAllowedUpdateUrl,
  resolveAllowedRedirect,
  installerDestination,
  planUpdate,
  checkForAppUpdate,
  fetchLatestRelease,
  saveUrlToFile,
};
