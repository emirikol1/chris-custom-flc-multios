'use strict';

/**
 * Admin-contact mailto for World Statistics.
 * Builds a short mail draft and a clipboard payload. Callers must not log
 * addresses, URLs, report text, or message bodies — only error names, counts,
 * and durations.
 */

/** Many mail clients drop mailto links past about 2000 characters. */
const MAILTO_URL_CAP = 1800;

const PASTE_LINE = 'Full report copied to clipboard — paste it below.';

/** Reads Foundry world-author emails only. Constant source; never interpolated. */
const WORLD_AUTHOR_EMAIL_SCRIPT = 'try{return (game.world.authors||[]).map(a=>a&&a.email).filter(Boolean)}catch(e){return []}';

const EMAIL = /^[A-Za-z0-9](?:[A-Za-z0-9._+-]{0,62}[A-Za-z0-9])?@[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)+$/;

const HEADER_LEAK = /https?:\/\/|\/home\/|\/Users\/|[A-Za-z]:\\|@|\b(?:\d{1,3}\.){3}\d{1,3}\b/i;

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidAdminEmail(value) {
  if (typeof value !== 'string') return false;
  if (value.length < 3 || value.length > 254) return false;
  if (value !== value.trim() || /\s/.test(value) || value.includes('..')) return false;
  const at = value.lastIndexOf('@');
  if (at <= 0 || at !== value.indexOf('@')) return false;
  const domain = value.slice(at + 1);
  const dot = domain.lastIndexOf('.');
  if (dot <= 0 || domain.length - dot - 1 < 2) return false;
  return EMAIL.test(value);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function normalizeAdminEmail(value) {
  if (typeof value !== 'string') return '';
  const trimmed = value.trim();
  return isValidAdminEmail(trimmed) ? trimmed : '';
}

/**
 * First usable author email. Ignores everything that is not a valid address.
 * @param {unknown} raw
 * @returns {string}
 */
function pickAuthorEmail(raw) {
  const list = Array.isArray(raw) ? raw : [];
  const limit = Math.min(list.length, 20);
  for (let i = 0; i < limit; i += 1) {
    const email = normalizeAdminEmail(list[i]);
    if (email) return email;
  }
  return '';
}

/**
 * @param {unknown} value
 * @param {number} max
 * @returns {string}
 */
function clipField(value, max) {
  if (typeof value !== 'string') return '';
  const cleaned = value.replace(/[\u0000-\u001f\u007f]+/g, ' ').replace(/\s+/g, ' ').trim();
  if (!cleaned) return '';
  if (cleaned.length <= max) return cleaned;
  return `${cleaned.slice(0, Math.max(0, max - 1))}…`;
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function headerLeaks(value) {
  return typeof value === 'string' && HEADER_LEAK.test(value);
}

/**
 * @param {unknown} value
 * @param {number} max
 * @param {string} fallback
 * @returns {string}
 */
function headerField(value, max, fallback) {
  const text = clipField(value, max);
  if (!text || headerLeaks(text)) return fallback;
  return text;
}

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} body
 * @returns {string}
 */
function mailtoUrl(to, subject, body) {
  return `mailto:${encodeURIComponent(to)}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
}

/**
 * @param {string[]} parts
 * @returns {string}
 */
function joinParts(parts) {
  const kept = [];
  for (let i = 0; i < parts.length; i += 1) {
    if (typeof parts[i] === 'string' && parts[i]) kept.push(parts[i]);
  }
  return kept.join('\n\n');
}

/**
 * @param {string} to
 * @param {string} subject
 * @param {string} header
 * @param {string} badUrlsText
 * @param {number} cap
 * @returns {{ body: string, url: string, truncated: boolean, subject: string }}
 */
function fitAdminBody(to, subject, header, badUrlsText, cap) {
  const head = header.trim();
  const bad = badUrlsText.replace(/\r\n/g, '\n').replace(/\r/g, '\n').trim();
  const lines = bad ? bad.split('\n') : [];

  /**
   * @param {number} lineCount
   * @returns {string}
   */
  function bodyFor(lineCount) {
    const chunk = lines.slice(0, lineCount).join('\n').trimEnd();
    const truncatedList = lineCount < lines.length;
    let badPart = '';
    if (chunk && truncatedList) badPart = `${chunk}\n(list truncated)`;
    else if (chunk) badPart = chunk;
    return joinParts([head, badPart, PASTE_LINE]);
  }

  const full = bodyFor(lines.length);
  if (mailtoUrl(to, subject, full).length <= cap) {
    return { body: full, url: mailtoUrl(to, subject, full), truncated: false, subject };
  }

  let bestCount = -1;
  let lo = 0;
  let hi = lines.length;
  while (lo <= hi) {
    const mid = Math.floor((lo + hi) / 2);
    if (mailtoUrl(to, subject, bodyFor(mid)).length <= cap) {
      bestCount = mid;
      lo = mid + 1;
    } else {
      hi = mid - 1;
    }
  }

  if (bestCount >= 0) {
    const body = bodyFor(bestCount);
    return {
      body,
      url: mailtoUrl(to, subject, body),
      truncated: bestCount < lines.length,
      subject,
    };
  }

  let shrunkHead = head;
  let shrunkSubject = subject;
  let body = shrunkHead ? joinParts([shrunkHead, PASTE_LINE]) : PASTE_LINE;
  while (shrunkHead && mailtoUrl(to, shrunkSubject, body).length > cap) {
    shrunkHead = shrunkHead.slice(0, Math.max(0, shrunkHead.length - 24)).trimEnd();
    body = shrunkHead ? joinParts([shrunkHead, PASTE_LINE]) : PASTE_LINE;
  }
  while (mailtoUrl(to, shrunkSubject, body).length > cap && shrunkSubject.length > 0) {
    shrunkSubject = shrunkSubject.slice(0, Math.max(0, shrunkSubject.length - 8)).trimEnd();
  }
  if (!shrunkSubject) shrunkSubject = 'Report';
  if (mailtoUrl(to, shrunkSubject, body).length > cap) {
    body = PASTE_LINE;
    shrunkSubject = 'Report';
  }
  return {
    body,
    url: mailtoUrl(to, shrunkSubject, body),
    truncated: true,
    subject: shrunkSubject,
  };
}

/**
 * @param {unknown} reportText
 * @param {unknown} badUrlsText
 * @returns {string}
 */
function buildClipboardText(reportText, badUrlsText) {
  const report = typeof reportText === 'string' ? reportText.replace(/\r\n/g, '\n').trim() : '';
  const bad = typeof badUrlsText === 'string' ? badUrlsText.replace(/\r\n/g, '\n').trim() : '';
  if (report && bad) return `${report}\n\n${bad}\n`;
  if (report) return `${report}\n`;
  if (bad) return `${bad}\n`;
  return '';
}

/**
 * Short mailto body plus the clipboard text. Unknown input fields are ignored,
 * so machine details passed alongside the report cannot leak into the draft.
 * @param {object | null | undefined} input
 * @returns {{
 *   ok: boolean,
 *   reason?: string,
 *   to: string,
 *   subject: string,
 *   body: string,
 *   url: string,
 *   truncated: boolean,
 *   clipboardText: string,
 * }}
 */
function buildAdminMail(input) {
  const empty = {
    ok: false,
    reason: 'invalid-email',
    to: '',
    subject: '',
    body: '',
    url: '',
    truncated: false,
    clipboardText: '',
  };
  const row = input && typeof input === 'object' ? input : {};
  const to = normalizeAdminEmail(row.to);
  if (!to) return empty;
  const label = headerField(row.label, 80, 'server');
  const subject = `Foundry performance report: ${label}`;
  const header = [
    `Client ${headerField(row.clientVersion, 32, 'unknown')} | Foundry ${headerField(row.foundryVersion, 32, 'unknown')}`,
    `Server ${label}`,
    headerField(row.joinSummary, 240, 'join summary:'),
    `Issues ${headerField(row.issuesSummary, 240, 'No issues detected')}`,
  ].join('\n');
  const badUrlsText = typeof row.badUrlsText === 'string' ? row.badUrlsText : '';
  const cap = typeof row.maxUrlLength === 'number' && Number.isFinite(row.maxUrlLength)
    ? Math.min(MAILTO_URL_CAP, Math.max(240, Math.floor(row.maxUrlLength)))
    : MAILTO_URL_CAP;
  const fitted = fitAdminBody(to, subject, header, badUrlsText, cap);
  return {
    ok: true,
    to,
    subject: fitted.subject,
    body: fitted.body,
    url: fitted.url,
    truncated: fitted.truncated,
    clipboardText: buildClipboardText(row.reportText, badUrlsText),
  };
}

/**
 * @param {unknown} servers
 * @param {unknown} id
 * @returns {string}
 */
function readAdminEmail(servers, id) {
  if (!Array.isArray(servers) || typeof id !== 'string' || !id) return '';
  for (let i = 0; i < servers.length; i += 1) {
    const server = servers[i];
    if (!server || server.id !== id) continue;
    return normalizeAdminEmail(server.adminEmail);
  }
  return '';
}

/**
 * @param {unknown} servers
 * @param {unknown} id
 * @param {unknown} email
 * @returns {object[] | null}
 */
function withAdminEmail(servers, id, email) {
  if (!Array.isArray(servers) || typeof id !== 'string' || !id) return null;
  const index = servers.findIndex((server) => server && server.id === id);
  if (index === -1) return null;
  const updated = { ...servers[index] };
  const normalized = normalizeAdminEmail(email);
  if (normalized) updated.adminEmail = normalized;
  else delete updated.adminEmail;
  const next = servers.slice();
  next[index] = updated;
  return next;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanServerId(value) {
  if (typeof value !== 'string') return '';
  const id = value.trim();
  if (!id || id.length > 80 || /[\u0000-\u001f\u007f]/.test(id)) return '';
  return id;
}

/**
 * @param {object | null | undefined} payload
 * @returns {string}
 */
function foundryVersionOf(payload) {
  const snapshot = payload && payload.snapshot;
  const world = snapshot && snapshot.world;
  return world && typeof world.foundryVersion === 'string' ? world.foundryVersion : '';
}

/**
 * Counts plus a few issue titles. Drops titles that look like addresses, URLs, or paths.
 * @param {object | null | undefined} payload
 * @returns {string}
 */
function issuesSummaryOf(payload) {
  const findings = payload && Array.isArray(payload.findings) ? payload.findings : [];
  const titles = [];
  for (let i = 0; i < findings.length && titles.length < 3; i += 1) {
    const item = findings[i];
    if (!item || typeof item !== 'object') continue;
    const title = headerField(item.title, 80, '');
    if (title) titles.push(title);
  }
  const count = headerField(payload && payload.summary, 120, '');
  if (count && titles.length) return `${count} — ${titles.join('; ')}`;
  if (titles.length) return titles.join('; ');
  if (count) return count;
  return 'No issues detected';
}

/**
 * @param {object} options
 * @param {unknown} err
 */
function warn(options, err) {
  if (!options || typeof options.logWarn !== 'function') return;
  let name = 'Error';
  if (err && typeof err.name === 'string' && err.name) name = err.name.slice(0, 40);
  try {
    options.logWarn('[admin-contact] failed', { error: name });
  } catch {
    /* logging must not break the mail action */
  }
}

/**
 * IPC handlers for stats:get-admin-email, stats:set-admin-email, and stats:email-admin.
 * Dependencies are injected so this module does not load Electron.
 * @param {object} deps
 */
function createAdminContactHandlers(deps) {
  const options = deps && typeof deps === 'object' ? deps : {};

  function ensure() {
    if (typeof options.ensureServersFile === 'function') {
      options.ensureServersFile(options.serversFilePath);
    }
  }

  function load() {
    if (typeof options.loadServers !== 'function') return [];
    return options.loadServers(options.serversFilePath);
  }

  function save(servers) {
    if (typeof options.saveServers !== 'function') {
      const err = new Error('Save');
      err.name = 'SaveError';
      throw err;
    }
    options.saveServers(options.serversFilePath, servers);
  }

  async function readAuthorEmail(serverId) {
    if (typeof options.windowForServer !== 'function') return '';
    let win = null;
    try {
      win = options.windowForServer(serverId);
    } catch (err) {
      warn(options, err);
      return '';
    }
    if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return '';
    const contents = win.webContents;
    if (!contents || typeof contents.executeJavaScript !== 'function') return '';
    try {
      const raw = await contents.executeJavaScript(WORLD_AUTHOR_EMAIL_SCRIPT, false);
      return pickAuthorEmail(raw);
    } catch (err) {
      warn(options, err);
      return '';
    }
  }

  async function getAdminEmail(serverId) {
    const id = cleanServerId(serverId);
    if (!id) return { ok: false, reason: 'unavailable', email: '', saved: '', source: '' };
    let saved = '';
    try {
      ensure();
      saved = readAdminEmail(load(), id);
    } catch (err) {
      warn(options, err);
      saved = '';
    }
    if (saved) return { ok: true, email: saved, saved, source: 'profile' };
    const suggested = await readAuthorEmail(id);
    if (suggested) return { ok: true, email: suggested, saved: '', source: 'author' };
    return { ok: true, email: '', saved: '', source: '' };
  }

  async function setAdminEmail(serverId, email) {
    const id = cleanServerId(serverId);
    if (!id) return { ok: false, reason: 'unavailable' };
    const clearing = email == null || (typeof email === 'string' && email.trim() === '');
    if (!clearing && typeof email !== 'string') return { ok: false, reason: 'invalid-email' };
    const normalized = clearing ? '' : normalizeAdminEmail(email);
    if (!clearing && !normalized) return { ok: false, reason: 'invalid-email' };
    try {
      ensure();
      const next = withAdminEmail(load(), id, normalized);
      if (!next) return { ok: false, reason: 'no-profile' };
      save(next);
    } catch (err) {
      warn(options, err);
      return { ok: false, reason: 'save-failed' };
    }
    if (typeof options.onSaved === 'function') {
      try {
        options.onSaved();
      } catch (err) {
        warn(options, err);
      }
    }
    return { ok: true, email: normalized };
  }

  async function emailAdmin(serverId) {
    const started = Date.now();
    const id = cleanServerId(serverId);
    if (!id) return { ok: false, reason: 'unavailable' };
    const address = await getAdminEmail(id);
    const to = address && typeof address.email === 'string' ? address.email : '';
    if (!to) return { ok: false, reason: 'need-email' };

    let payload = null;
    try {
      payload = typeof options.getSnapshot === 'function' ? await options.getSnapshot(id) : null;
    } catch (err) {
      warn(options, err);
      payload = null;
    }

    let bad = null;
    try {
      bad = typeof options.getBadUrls === 'function' ? await options.getBadUrls(id) : null;
    } catch (err) {
      warn(options, err);
      bad = null;
    }

    let reportText = '';
    try {
      if (typeof options.buildReport === 'function') {
        reportText = options.buildReport({
          snapshot: payload && payload.snapshot,
          systemInfo: payload && payload.system,
          findings: payload && payload.findings,
          history: payload && payload.history,
        });
      }
    } catch (err) {
      warn(options, err);
      reportText = '';
    }
    if (typeof reportText !== 'string') reportText = '';

    let badUrlsText = '';
    try {
      if (typeof options.formatBadUrlsText === 'function') {
        const row = bad && typeof bad === 'object' ? bad : {};
        badUrlsText = options.formatBadUrlsText({
          label: row.label,
          generatedAt: new Date(),
          foundryVersion: row.foundryVersion || foundryVersionOf(payload),
          systemId: row.systemId,
          systemVersion: row.systemVersion,
          entries: row.entries,
          dropped: row.dropped,
        });
      }
    } catch (err) {
      warn(options, err);
      badUrlsText = '';
    }
    if (typeof badUrlsText !== 'string') badUrlsText = '';

    let label = '';
    try {
      ensure();
      const servers = load();
      const server = Array.isArray(servers) ? servers.find((item) => item && item.id === id) : null;
      if (server && typeof server.label === 'string') label = server.label;
    } catch (err) {
      warn(options, err);
    }
    if (!label && bad && typeof bad.label === 'string') label = bad.label;

    let joinSummary = '';
    try {
      if (typeof options.formatJoinSummary === 'function') {
        joinSummary = options.formatJoinSummary(payload && payload.snapshot);
      }
    } catch (err) {
      warn(options, err);
      joinSummary = '';
    }
    if (typeof joinSummary !== 'string') joinSummary = '';

    const mail = buildAdminMail({
      to,
      label,
      clientVersion: options.clientVersion,
      foundryVersion: foundryVersionOf(payload) || (bad && bad.foundryVersion) || '',
      joinSummary,
      issuesSummary: issuesSummaryOf(payload),
      badUrlsText,
      reportText,
    });
    if (!mail.ok || !mail.url.startsWith('mailto:') || mail.url.length > MAILTO_URL_CAP) {
      return { ok: false, reason: mail.ok ? 'open-failed' : (mail.reason || 'invalid-email') };
    }

    try {
      if (!options.clipboard || typeof options.clipboard.writeText !== 'function') {
        const err = new Error('Clipboard');
        err.name = 'ClipboardError';
        throw err;
      }
      options.clipboard.writeText(mail.clipboardText);
    } catch (err) {
      warn(options, err);
      return { ok: false, reason: 'clipboard-failed' };
    }

    try {
      if (typeof options.openExternal !== 'function') {
        const err = new Error('Open');
        err.name = 'OpenError';
        throw err;
      }
      await options.openExternal(mail.url);
    } catch (err) {
      warn(options, err);
      return { ok: false, reason: 'open-failed' };
    }

    if (typeof options.logInfo === 'function') {
      try {
        const count = bad && typeof bad.count === 'number' && Number.isFinite(bad.count) ? bad.count : 0;
        options.logInfo('[admin-contact] mailto', {
          ms: Date.now() - started,
          badUrls: count,
          truncated: mail.truncated ? 1 : 0,
        });
      } catch {
        /* ignore */
      }
    }
    return { ok: true, truncated: mail.truncated === true };
  }

  return {
    getAdminEmail,
    setAdminEmail,
    emailAdmin,
  };
}

module.exports = {
  MAILTO_URL_CAP,
  PASTE_LINE,
  WORLD_AUTHOR_EMAIL_SCRIPT,
  isValidAdminEmail,
  normalizeAdminEmail,
  pickAuthorEmail,
  buildAdminMail,
  readAdminEmail,
  withAdminEmail,
  createAdminContactHandlers,
};
