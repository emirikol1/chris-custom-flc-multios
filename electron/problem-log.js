'use strict';

/**
 * Append-only problem log. One JSON line per issue lifecycle (first seen
 * through resolved, closed, or quit). Crash and unresponsive findings are
 * written when they appear. The file stores a profile label only when that
 * label cannot be an address; otherwise it stores the short server hash.
 */

const fsDefault = require('fs');
const path = require('path');

const DEFAULT_MAX_BYTES = 1000000;
const WARN_INTERVAL_MS = 60000;
const EVIDENCE_MAX = 200;
const TITLE_MAX = 200;

/**
 * Point events, written once when they appear. `renderer-crashed` and
 * `renderer-unresponsive` are the ids in issue-detector.js. `gpu-process-gone`
 * is included so a GPU-process finding with that id is recorded the same way.
 */
const EVENT_IDS = new Set([
  'renderer-crashed',
  'renderer-unresponsive',
  'gpu-process-gone',
]);

const HOST_TOKEN = /\.[A-Za-z]{2,}/;
const IPV4 = /\d{1,3}(?:\.\d{1,3}){3}/;
const FINDING_ID = /^[a-z0-9-]{1,80}$/;
const SERVER_HASH = /^srv:[0-9a-f]{6}$/;

/**
 * Keep a short profile label. Anything that could be an address becomes the
 * server hash instead.
 * @param {unknown} label
 * @param {unknown} serverHash
 * @returns {string}
 */
function safeProfileLabel(label, serverHash) {
  const fallback = typeof serverHash === 'string' ? serverHash : '';
  if (typeof label !== 'string') return fallback;
  if (label.length > 48) return fallback;
  if (label.includes('://') || label.includes('/') || label.includes('@')) return fallback;
  if (IPV4.test(label)) return fallback;
  const tokens = label.split(/\s+/);
  for (let i = 0; i < tokens.length; i += 1) {
    if (HOST_TOKEN.test(tokens[i])) return fallback;
  }
  return label;
}

/**
 * @param {unknown} value
 * @returns {string | null}
 */
function cleanToken(value) {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (!text || text.length > 32) return null;
  if (text.includes('://') || text.includes('/') || text.includes('@') || /\s/.test(text)) return null;
  if (IPV4.test(text) || HOST_TOKEN.test(text)) return null;
  return text;
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanHash(value) {
  if (value === 'srv:none') return value;
  if (typeof value === 'string' && SERVER_HASH.test(value)) return value;
  return 'srv:none';
}

/**
 * @param {unknown} systemId
 * @param {unknown} systemVersion
 * @returns {string | null}
 */
function formatSystem(systemId, systemVersion) {
  const id = cleanToken(systemId);
  const version = cleanToken(systemVersion);
  if (id && version) return `${id} ${version}`;
  return id || version || null;
}

/**
 * @param {unknown} raw
 * @returns {{ id: string, category: string, severity: string, title: string, evidence: string } | null}
 */
function normalizeFinding(raw) {
  if (!raw || typeof raw !== 'object') return null;
  if (raw.severity !== 'warn' && raw.severity !== 'error') return null;
  if (typeof raw.id !== 'string' || !FINDING_ID.test(raw.id)) return null;
  const category = typeof raw.category === 'string' && raw.category
    ? raw.category.slice(0, 40)
    : 'client';
  const title = typeof raw.title === 'string' ? raw.title.slice(0, TITLE_MAX) : '';
  const evidence = typeof raw.evidence === 'string' ? raw.evidence.slice(0, EVIDENCE_MAX) : '';
  return {
    id: raw.id,
    category,
    severity: raw.severity,
    title,
    evidence,
  };
}

/**
 * @param {{
 *   filePath?: string,
 *   now?: () => number,
 *   fs?: object,
 *   clientVersion?: string,
 *   maxBytes?: number,
 *   log?: { warn?: Function },
 * }} [opts]
 */
function createProblemLog(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const filePath = typeof options.filePath === 'string' ? options.filePath : '';
  const clock = typeof options.now === 'function' ? options.now : Date.now;
  const fs = options.fs && typeof options.fs === 'object' ? options.fs : fsDefault;
  const clientVersion = typeof options.clientVersion === 'string' ? options.clientVersion : '';
  const maxBytes = typeof options.maxBytes === 'number' && Number.isFinite(options.maxBytes) && options.maxBytes >= 0
    ? options.maxBytes
    : DEFAULT_MAX_BYTES;
  const logger = options.log && typeof options.log === 'object' ? options.log : null;

  /** @type {Map<string, Map<string, object>>} */
  const openByServer = new Map();
  /** @type {Map<string, Set<string>>} */
  const eventsByServer = new Map();
  let lastWarnAt = -WARN_INTERVAL_MS;

  function currentNow() {
    try {
      const n = clock();
      if (typeof n === 'number' && Number.isFinite(n)) return n;
    } catch {
      /* fall through */
    }
    return Date.now();
  }

  /**
   * @param {unknown} err
   */
  function reportWrite(err) {
    const stamp = currentNow();
    if (stamp - lastWarnAt < WARN_INTERVAL_MS) return;
    lastWarnAt = stamp;
    const name = err && err.name ? String(err.name) : 'Error';
    try {
      if (logger && typeof logger.warn === 'function') {
        logger.warn('[problem-log] write failed', { error: name });
      }
    } catch {
      /* ignore */
    }
  }

  /**
   * @param {object} issue
   * @param {object | null | undefined} context
   */
  function applyCtx(issue, context) {
    const source = context && typeof context === 'object' ? context : {};
    issue.profile = typeof source.profile === 'string' ? source.profile : '';
    issue.serverHash = typeof source.serverHash === 'string' ? source.serverHash : '';
    issue.foundryVersion = Object.prototype.hasOwnProperty.call(source, 'foundryVersion')
      ? source.foundryVersion
      : null;
    issue.systemId = Object.prototype.hasOwnProperty.call(source, 'systemId') ? source.systemId : null;
    issue.systemVersion = Object.prototype.hasOwnProperty.call(source, 'systemVersion')
      ? source.systemVersion
      : null;
  }

  /**
   * @param {string} line
   */
  function appendLine(line) {
    if (!filePath) {
      const err = new Error('missing path');
      err.name = 'Error';
      throw err;
    }
    const dir = path.dirname(filePath);
    fs.mkdirSync(dir, { recursive: true });
    let size = 0;
    let exists = false;
    try {
      size = fs.statSync(filePath).size;
      exists = true;
    } catch (err) {
      if (!err || err.code !== 'ENOENT') throw err;
    }
    if (exists && size > maxBytes) {
      const rotated = path.join(dir, 'problem-log.1.jsonl');
      fs.rmSync(rotated, { force: true });
      fs.renameSync(filePath, rotated);
    }
    fs.appendFileSync(filePath, line, { encoding: 'utf8', mode: 0o600 });
  }

  /**
   * @param {object} issue
   * @param {'resolved'|'closed'|'quit'|'event'} endedBy
   * @param {number} stamp
   */
  function appendRecord(issue, endedBy, stamp) {
    const resolvedAt = endedBy === 'closed' || endedBy === 'quit'
      ? null
      : new Date(endedBy === 'event' ? issue.startedAt : stamp).toISOString();
    const durationMs = endedBy === 'event' ? 0 : Math.max(0, Math.round(stamp - issue.startedAt));
    const record = {
      v: 1,
      startedAt: new Date(issue.startedAt).toISOString(),
      resolvedAt,
      durationMs,
      endedBy,
      profile: safeProfileLabel(issue.profile, cleanHash(issue.serverHash)),
      server: cleanHash(issue.serverHash),
      id: issue.id,
      category: issue.category,
      severity: issue.severity,
      title: issue.title,
      evidence: issue.evidence,
      client: cleanToken(clientVersion) || '',
      foundry: cleanToken(issue.foundryVersion),
      system: formatSystem(issue.systemId, issue.systemVersion),
    };
    appendLine(`${JSON.stringify(record)}\n`);
  }

  /**
   * @param {string} serverKey
   * @param {object} context
   * @param {unknown} findings
   */
  function observe(serverKey, context, findings) {
    try {
      if (typeof serverKey !== 'string' || !serverKey) return;
      const list = Array.isArray(findings) ? findings : [];
      /** @type {Map<string, object>} */
      const active = new Map();
      /** @type {object[]} */
      const events = [];
      /** @type {Set<string>} */
      const eventIds = new Set();
      for (let i = 0; i < list.length; i += 1) {
        const item = normalizeFinding(list[i]);
        if (!item) continue;
        if (EVENT_IDS.has(item.id)) {
          events.push(item);
          eventIds.add(item.id);
        } else {
          active.set(item.id, item);
        }
      }

      let open = openByServer.get(serverKey);
      if (!open) {
        open = new Map();
        openByServer.set(serverKey, open);
      }
      const stamp = currentNow();
      const ids = Array.from(open.keys());
      for (let i = 0; i < ids.length; i += 1) {
        const id = ids[i];
        if (active.has(id)) continue;
        const issue = open.get(id);
        try {
          appendRecord(issue, 'resolved', stamp);
          open.delete(id);
        } catch (err) {
          reportWrite(err);
          return;
        }
      }
      const activeIds = Array.from(active.keys());
      for (let i = 0; i < activeIds.length; i += 1) {
        const id = activeIds[i];
        const item = active.get(id);
        const existing = open.get(id);
        if (existing) {
          existing.category = item.category;
          existing.severity = item.severity;
          existing.title = item.title;
          existing.evidence = item.evidence;
          applyCtx(existing, context);
        } else {
          const issue = {
            startedAt: stamp,
            id: item.id,
            category: item.category,
            severity: item.severity,
            title: item.title,
            evidence: item.evidence,
          };
          applyCtx(issue, context);
          open.set(id, issue);
        }
      }
      if (!open.size) openByServer.delete(serverKey);

      let seen = eventsByServer.get(serverKey);
      if (!seen) {
        seen = new Set();
        eventsByServer.set(serverKey, seen);
      }
      const seenIds = Array.from(seen);
      for (let i = 0; i < seenIds.length; i += 1) {
        if (!eventIds.has(seenIds[i])) seen.delete(seenIds[i]);
      }
      for (let i = 0; i < events.length; i += 1) {
        const item = events[i];
        if (seen.has(item.id)) continue;
        const issue = {
          startedAt: stamp,
          id: item.id,
          category: item.category,
          severity: item.severity,
          title: item.title,
          evidence: item.evidence,
        };
        applyCtx(issue, context);
        try {
          appendRecord(issue, 'event', stamp);
          seen.add(item.id);
        } catch (err) {
          reportWrite(err);
          return;
        }
      }
      if (!seen.size) eventsByServer.delete(serverKey);
    } catch (err) {
      reportWrite(err);
    }
  }

  /**
   * @param {string} serverKey
   * @param {'closed'|'quit'} reason
   */
  function closeServer(serverKey, reason) {
    try {
      if (typeof serverKey !== 'string' || !serverKey) return;
      const endedBy = reason === 'quit' ? 'quit' : 'closed';
      const open = openByServer.get(serverKey);
      if (!open) return;
      const stamp = currentNow();
      const ids = Array.from(open.keys());
      for (let i = 0; i < ids.length; i += 1) {
        const issue = open.get(ids[i]);
        try {
          appendRecord(issue, endedBy, stamp);
          open.delete(ids[i]);
        } catch (err) {
          reportWrite(err);
          return;
        }
      }
      openByServer.delete(serverKey);
      eventsByServer.delete(serverKey);
    } catch (err) {
      reportWrite(err);
    }
  }

  /**
   * @param {'quit'|'closed'} [reason]
   */
  function closeAll(reason) {
    const endedBy = reason === 'quit' ? 'quit' : 'closed';
    const keys = Array.from(openByServer.keys());
    for (let i = 0; i < keys.length; i += 1) closeServer(keys[i], endedBy);
  }

  /**
   * One crash or similar point event, including a previous process that never
   * reached a clean quit. `serverHash` may be srv:none.
   * @param {object} raw
   * @returns {boolean}
   */
  function recordEvent(raw) {
    const source = raw && typeof raw === 'object' ? raw : null;
    const item = source ? normalizeFinding(source) : null;
    if (!item) return false;
    const issue = {
      startedAt: currentNow(),
      id: item.id,
      category: item.category,
      severity: item.severity,
      title: item.title,
      evidence: item.evidence,
    };
    applyCtx(issue, source);
    try {
      appendRecord(issue, 'event', issue.startedAt);
      return true;
    } catch (err) {
      reportWrite(err);
      return false;
    }
  }

  function flush() {}

  /**
   * @param {number} limit
   * @returns {object[]}
   */
  function readRecent(limit) {
    const count = typeof limit === 'number' && Number.isFinite(limit) ? Math.floor(limit) : 0;
    if (count <= 0 || !filePath) return [];
    let text = '';
    try {
      text = fs.readFileSync(filePath, 'utf8');
    } catch {
      return [];
    }
    /** @type {object[]} */
    const valid = [];
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i += 1) {
      const line = lines[i].trim();
      if (!line) continue;
      try {
        const parsed = JSON.parse(line);
        if (parsed && typeof parsed === 'object' && !Array.isArray(parsed) && parsed.v === 1) {
          valid.push(parsed);
        }
      } catch {
        /* skip a damaged line */
      }
    }
    return valid.slice(-count);
  }

  return {
    observe,
    recordEvent,
    closeServer,
    closeAll,
    flush,
    readRecent,
  };
}

module.exports = {
  createProblemLog,
  safeProfileLabel,
};
