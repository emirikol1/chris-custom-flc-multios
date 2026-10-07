'use strict';

const fsDefault = require('fs');
const path = require('path');

const KIND = /^(renderer-crashed|renderer-unresponsive|gpu-process-gone|uncaught-exception|unhandled-rejection|unclean-exit)$/;
const DETAIL = /^[A-Za-z0-9_-]{1,40}$/;
const STORED = /^[a-z0-9-]{1,40}(?:\.[A-Za-z0-9_-]{1,40})?$/;
const VERSION = /^\d+\.\d+\.\d+$/;
const MAX_CAUSES = 8;

/**
 * @param {unknown} kind
 * @param {unknown} detail
 * @returns {string | null}
 */
function causeToken(kind, detail) {
  if (typeof kind !== 'string' || !KIND.test(kind)) return null;
  if (detail == null || detail === '') return kind;
  if (typeof detail !== 'string' || !DETAIL.test(detail)) return kind;
  return `${kind}.${detail}`;
}

/**
 * @param {object} fs
 * @param {string} filePath
 * @returns {{ clean: boolean, causes: string[], client: string } | null}
 */
function readState(fs, filePath) {
  let parsed = null;
  try {
    parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (err) {
    if (err && err.code === 'ENOENT') return null;
    return { clean: false, causes: ['unclean-exit'], client: '' };
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed) || parsed.v !== 1) {
    return { clean: false, causes: ['unclean-exit'], client: '' };
  }
  /** @type {string[]} */
  const causes = [];
  if (Array.isArray(parsed.causes)) {
    for (let i = 0; i < parsed.causes.length && causes.length < MAX_CAUSES; i += 1) {
      const item = parsed.causes[i];
      if (typeof item !== 'string' || !STORED.test(item) || causes.includes(item)) continue;
      causes.push(item);
    }
  }
  const client = typeof parsed.client === 'string' && VERSION.test(parsed.client) ? parsed.client : '';
  return { clean: parsed.clean === true, causes, client, reported: parsed.reported === true };
}

/**
 * @param {object} fs
 * @param {string} filePath
 * @param {{ clean: boolean, causes: string[], client: string }} state
 */
function writeState(fs, filePath, state) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify({
    v: 1,
    clean: state.clean === true,
    client: state.client,
    causes: state.causes,
    reported: state.reported === true,
  }), { encoding: 'utf8', mode: 0o600 });
}

/**
 * Remembers whether this process shut down cleanly, and any crash cause noted
 * before it died. The next start reads the previous file.
 * @param {{ filePath: string, client?: string, fs?: object }} opts
 */
function createSessionGuard(opts) {
  const fs = opts && opts.fs && typeof opts.fs === 'object' ? opts.fs : fsDefault;
  const filePath = opts && typeof opts.filePath === 'string' ? opts.filePath : '';
  const client = opts && typeof opts.client === 'string' && VERSION.test(opts.client) ? opts.client : '';
  const previous = filePath ? readState(fs, filePath) : null;
  const current = { clean: false, client, causes: [], reported: false };
  if (filePath) writeState(fs, filePath, current);

  return {
    previous: previous && previous.clean !== true ? previous : null,
    /**
     * @param {unknown} kind
     * @param {unknown} [detail]
     */
    note(kind, detail) {
      const token = causeToken(kind, detail);
      if (!token || current.causes.includes(token) || current.causes.length >= MAX_CAUSES) return;
      current.causes.push(token);
      if (!filePath) return;
      try {
        writeState(fs, filePath, current);
      } catch {
        /* an unclean file with fewer causes is still a crash record */
      }
    },
    markClean() {
      current.clean = true;
      if (!filePath) return;
      writeState(fs, filePath, current);
    },
    markReported() {
      if (current.reported) return;
      current.reported = true;
      if (!filePath) return;
      try {
        writeState(fs, filePath, current);
      } catch {
        /* the crash report file is the detailed record */
      }
    },
  };
}

/** @type {ReturnType<typeof createSessionGuard> | null} */
let active = null;
/** @type {Array<[unknown, unknown]>} */
const queued = [];

/**
 * @param {ReturnType<typeof createSessionGuard>} guard
 */
function attach(guard) {
  active = guard;
  while (queued.length) {
    const item = queued.shift();
    try {
      guard.note(item[0], item[1]);
    } catch {
      /* ignore */
    }
  }
}

/**
 * @param {unknown} kind
 * @param {unknown} [detail]
 */
function note(kind, detail) {
  if (!active) {
    if (queued.length < MAX_CAUSES) queued.push([kind, detail]);
    return;
  }
  try {
    active.note(kind, detail);
  } catch {
    /* ignore */
  }
}

module.exports = {
  createSessionGuard,
  attach,
  note,
  causeToken,
};
