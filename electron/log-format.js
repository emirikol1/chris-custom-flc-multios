const os = require('os');
const { redactForLog } = require('./log-redact');

/** Objects at this depth (root is 0) are not walked. */
const MAX_DEPTH = 6;
/** Own enumerable keys / array elements copied from one value. */
const MAX_KEYS = 200;

/**
 * @param {unknown} arg
 * @returns {boolean}
 */
function shouldRedactArg(arg) {
  if (arg && typeof arg === 'object' && ('password' in arg || 'username' in arg)) {
    return true;
  }
  if (typeof arg === 'string' && /^https?:\/\//i.test(arg) && arg.includes('@')) {
    return true;
  }
  return false;
}

/**
 * @param {{ hostname?: string, username?: string } | undefined} opts
 * @returns {{ hostname: string, username: string }}
 */
function resolveIdentity(opts) {
  const provided = opts && typeof opts === 'object' ? opts : null;
  const machine = machineIdentity();
  let hostname = machine.hostname;
  let username = machine.username;
  if (provided && Object.prototype.hasOwnProperty.call(provided, 'hostname')) {
    hostname = typeof provided.hostname === 'string' ? provided.hostname : '';
  }
  if (provided && Object.prototype.hasOwnProperty.call(provided, 'username')) {
    username = typeof provided.username === 'string' ? provided.username : '';
  }
  return { hostname, username };
}

/** @type {{ hostname: string, username: string } | null} */
let cachedMachineIdentity = null;

/** Hostname and OS username, read once per process (logging must stay cheap). */
function machineIdentity() {
  if (cachedMachineIdentity) return cachedMachineIdentity;
  let hostname = '';
  let username = '';
  try {
    hostname = os.hostname();
  } catch {
    hostname = '';
  }
  try {
    const info = os.userInfo();
    username = info && typeof info.username === 'string' ? info.username : '';
  } catch {
    username = '';
  }
  cachedMachineIdentity = {
    hostname: typeof hostname === 'string' ? hostname : '',
    username: typeof username === 'string' ? username : '',
  };
  return cachedMachineIdentity;
}

/**
 * Whole-token, case-insensitive replace. Hyphen and underscore count as part
 * of the token so a short name does not eat a longer identifier.
 * @param {string} value
 * @param {string} token
 * @param {string} replacement
 * @returns {string}
 */
function replaceToken(value, token, replacement) {
  if (typeof token !== 'string' || token.length === 0) return value;
  const escaped = token.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const re = new RegExp(`(?<![A-Za-z0-9_-])${escaped}(?![A-Za-z0-9_-])`, 'gi');
  return value.replace(re, replacement);
}

/**
 * Strip user data from a single string. Bare dotted hosts are left alone
 * (version strings and ordinary words produce too many false positives)
 * unless the token is this machine's hostname.
 * @param {string} value
 * @param {{ hostname: string, username: string }} identity
 * @returns {string}
 */
function scrubString(value, identity) {
  let s = value;
  s = s.replace(/\b(?:https?|wss?|ftp|file):\/\/[^\s"'<>]+/gi, '[url]');
  s = s.replace(/(?:\/home|\/Users|\/root|\/tmp|\/var|\/opt|\/mnt|\/media)\/[^\s"'<>]+/g, '[path]');
  s = s.replace(/\b[A-Za-z]:\\[^\s"'<>]+/g, '[path]');
  s = s.replace(/[\w.+-]+@[\w-]+\.[\w.-]+/g, '[email]');
  s = s.replace(/\b(?:\d{1,3}\.){3}\d{1,3}\b/g, '[ip]');
  s = s.replace(/\b[A-Z][A-Za-z]{2,}\.[A-Za-z0-9]{16}\b/g, '[doc]');
  if (identity.hostname) s = replaceToken(s, identity.hostname, '[host]');
  if (identity.username.length >= 3) s = replaceToken(s, identity.username, '[user]');
  return s;
}

/**
 * @param {unknown} value
 * @param {{ hostname: string, username: string }} identity
 * @param {number} depth
 * @param {WeakSet<object>} seen
 * @returns {unknown}
 */
function scrubValue(value, identity, depth, seen) {
  if (value === null || typeof value === 'number' || typeof value === 'boolean') return value;
  if (typeof value === 'string') return scrubString(value, identity);
  if (typeof value === 'function' || typeof value === 'symbol') return '[fn]';
  if (typeof value !== 'object') return value;

  if (value instanceof Error) {
    const name = typeof value.name === 'string' && value.name ? value.name : 'Error';
    return { name: scrubString(name, identity) };
  }

  if (depth >= MAX_DEPTH) return '[depth]';
  if (seen.has(value)) return '[circular]';

  seen.add(value);
  try {
    if (Array.isArray(value)) {
      const n = Math.min(value.length, MAX_KEYS);
      const out = new Array(n);
      for (let i = 0; i < n; i += 1) {
        out[i] = scrubValue(value[i], identity, depth + 1, seen);
      }
      return out;
    }
    const keys = Object.keys(value);
    const n = Math.min(keys.length, MAX_KEYS);
    /** @type {Record<string, unknown>} */
    const out = {};
    for (let i = 0; i < n; i += 1) {
      const key = keys[i];
      if (key === 'username' || key === 'password') {
        out[key] = '[REDACTED]';
      } else {
        out[key] = scrubValue(/** @type {Record<string, unknown>} */ (value)[key], identity, depth + 1, seen);
      }
    }
    return out;
  } finally {
    seen.delete(value);
  }
}

/**
 * Deep-scrub a value so it is safe to write to a log file.
 * Never throws. Identity tokens default to this machine; pass `opts.hostname`
 * and `opts.username` to override (used by tests). The OS username is replaced
 * only when it is at least 3 characters.
 * @param {unknown} value
 * @param {{ hostname?: string, username?: string }} [opts]
 * @returns {unknown}
 */
function scrubForLog(value, opts) {
  try {
    return scrubValue(value, resolveIdentity(opts), 0, new WeakSet());
  } catch {
    return '[unloggable]';
  }
}

/**
 * @param {unknown} arg
 * @returns {unknown}
 */
function safeLogArg(arg) {
  try {
    const prepared = shouldRedactArg(arg) ? redactForLog(/** @type {object | string} */ (arg)) : arg;
    return scrubForLog(prepared);
  } catch {
    return '[unloggable]';
  }
}

/**
 * @param {unknown[]} args
 * @returns {unknown[]}
 */
function safeLogArgs(args) {
  return args.map(safeLogArg);
}

module.exports = {
  shouldRedactArg,
  safeLogArg,
  safeLogArgs,
  scrubForLog,
};
