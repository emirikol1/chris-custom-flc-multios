'use strict';

/**
 * Fetch the list of user names offered on a Foundry VTT server's join page.
 *
 * Only the option labels of `select[name="userid"]` are extracted. The page
 * HTML is parsed in memory and discarded; nothing from it is logged or stored.
 */

const MAX_HTML_BYTES = 2 * 1024 * 1024;
const DEFAULT_TIMEOUT_MS = 10000;

/**
 * @param {string} text
 * @returns {string}
 */
function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;|&apos;/g, "'")
    .replace(/&#(\d+);/g, (_m, n) => String.fromCodePoint(Number(n)))
    .replace(/&#x([0-9a-f]+);/gi, (_m, h) => String.fromCodePoint(parseInt(h, 16)));
}

/**
 * Pure: extract user names from join-page HTML.
 * @param {string} html
 * @returns {string[]}
 */
function parseJoinPageUsers(html) {
  const src = String(html || '');
  const selectMatch = src.match(/<select[^>]*\bname=["']userid["'][^>]*>([\s\S]*?)<\/select>/i);
  if (!selectMatch) {
    return [];
  }
  const names = [];
  const optionRe = /<option\b([^>]*)>([\s\S]*?)<\/option>/gi;
  let m;
  while ((m = optionRe.exec(selectMatch[1])) !== null) {
    const attrs = m[1] || '';
    const valueMatch = attrs.match(/\bvalue=["']([^"']*)["']/i);
    const value = valueMatch ? valueMatch[1].trim() : '';
    const text = decodeEntities(m[2].replace(/<[^>]*>/g, '')).trim();
    if (!text || !value) {
      continue; // placeholder option
    }
    if (!names.includes(text)) {
      names.push(text);
    }
  }
  return names;
}

/**
 * @param {string} serverUrl
 * @returns {string}
 */
function joinPageUrl(serverUrl) {
  let raw = String(serverUrl || '').trim();
  if (!raw) {
    throw Object.assign(new Error('URL is required'), { code: 'invalid_url' });
  }
  const hasScheme = /^[a-z][a-z0-9+.-]*:/i.test(raw);
  if (hasScheme && !/^https?:\/\//i.test(raw)) {
    throw Object.assign(new Error('URL must be http or https'), { code: 'invalid_url' });
  }
  if (!hasScheme) {
    raw = `https://${raw}`;
  }
  const u = new URL(raw);
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw Object.assign(new Error('URL must be http or https'), { code: 'invalid_url' });
  }
  u.search = '';
  u.hash = '';
  const base = u.pathname.replace(/\/+$/, '');
  u.pathname = /\/join$/.test(base) ? base : `${base}/join`;
  return u.toString();
}

/**
 * @param {string} serverUrl
 * @param {{ fetchImpl?: typeof fetch, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, users: string[] } | { ok: false, error: string }>}
 */
async function fetchJoinPageUsers(serverUrl, opts = {}) {
  const fetchImpl = opts.fetchImpl || fetch;
  let url;
  try {
    url = joinPageUrl(serverUrl);
  } catch {
    return { ok: false, error: 'invalid_url' };
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), opts.timeoutMs || DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(url, {
      method: 'GET',
      redirect: 'follow',
      signal: controller.signal,
      headers: { Accept: 'text/html' },
    });
    if (!res.ok) {
      return { ok: false, error: res.status === 404 ? 'not_found' : 'http_error' };
    }
    const text = await res.text();
    const users = parseJoinPageUsers(text.slice(0, MAX_HTML_BYTES));
    if (users.length === 0) {
      return { ok: false, error: 'no_users' };
    }
    return { ok: true, users };
  } catch {
    return { ok: false, error: 'unreachable' };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = {
  parseJoinPageUsers,
  joinPageUrl,
  fetchJoinPageUsers,
};
