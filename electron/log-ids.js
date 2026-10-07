const crypto = require('crypto');

/**
 * Kind words that may appear in a window-state key and are safe to log as-is.
 * `server-config` is longer than 12 characters, so it must be listed here or
 * the defensive hasher would treat it as an identifier.
 */
const KNOWN_SEGMENTS = new Set([
  'join',
  'main',
  'mud',
  'game',
  'stats',
  'layout',
  'popout',
  'document',
  'sidebar',
  'app',
  'server-config',
  'unknown',
]);

/**
 * Segments that can follow `game` without being the server id.
 * Built from sessionLayoutKey / popoutBoundsKey / layoutRecordKey / popoutSlotKey / mudStateKey:
 *   game
 *   game:<serverId>
 *   game:<serverId>:mud | :stats | :layout | :popout-<n>
 *   game:<serverId>:popout:document:<uuid> | :popout:sidebar:<tab> | :popout:app:<class>
 * Anonymous sessions use layout key `game` (no server id), so `game:layout` and
 * `game:popout-3` are real keys and the second segment is not an id.
 */
const GAME_SUFFIXES = new Set([
  'mud',
  'stats',
  'layout',
  'popout',
  'document',
  'sidebar',
  'app',
  'unknown',
]);

/** Foundry world document uuid, e.g. Actor.9X9JkctFMogBiagD. */
const DOC_REF = /^[A-Z][A-Za-z]{2,}\.[A-Za-z0-9]{16}$/;

/**
 * Non-reversible server id for logs. Empty and non-strings become `srv:none`
 * so a missing id cannot be confused with a hash of the string `"undefined"`.
 * @param {unknown} id
 * @returns {string}
 */
function shortServerHash(id) {
  if (typeof id !== 'string' || id.length === 0) return 'srv:none';
  const hex = crypto.createHash('sha256').update(id).digest('hex');
  return `srv:${hex.slice(0, 6)}`;
}

/**
 * @param {string} segment
 * @returns {boolean}
 */
function isPopoutSlot(segment) {
  return /^popout-\d+$/.test(segment);
}

/**
 * @param {string} segment
 * @returns {boolean}
 */
function isGameSuffix(segment) {
  return GAME_SUFFIXES.has(segment) || isPopoutSlot(segment);
}

/**
 * Keep short structural tokens. Anything longer than 12 characters that is
 * not a known word is an identifier and must be hashed instead.
 * @param {string} segment
 * @returns {boolean}
 */
function isSafeKindSegment(segment) {
  if (KNOWN_SEGMENTS.has(segment)) return true;
  if (isPopoutSlot(segment)) return true;
  if (segment.length === 0 || segment.length > 12) return false;
  return /^[A-Za-z0-9][A-Za-z0-9_-]*$/.test(segment);
}

/**
 * Walk key segments into log groups. Document ids (the segment after
 * `document:`, or a bare Actor.<16> token) are dropped, not hashed.
 * @param {string[]} parts
 * @param {number} start
 * @returns {string[]}
 */
function collectGroups(parts, start) {
  /** @type {string[]} */
  const groups = [];
  /** @type {string[]} */
  let kind = [];

  const flush = () => {
    if (kind.length > 0) {
      groups.push(kind.join(':'));
      kind = [];
    }
  };

  for (let i = start; i < parts.length; i += 1) {
    const seg = parts[i];
    if (seg === 'document') {
      kind.push('document');
      // descriptorKey stores the uuid as the very next segment (`document:<uuid>`).
      if (i + 1 < parts.length) i += 1;
      continue;
    }
    if (DOC_REF.test(seg)) continue;
    if (isSafeKindSegment(seg)) {
      kind.push(seg);
      continue;
    }
    if (!seg) continue;
    flush();
    groups.push(shortServerHash(seg));
  }
  flush();
  return groups;
}

/**
 * Window-state key safe to write to a log: kind words stay, the server id
 * becomes `srv:` + 6 hex chars, and any Foundry document id is removed.
 * @param {unknown} key
 * @returns {string}
 */
function describeStateKey(key) {
  try {
    if (typeof key !== 'string' || key.length === 0) return 'unknown';
    const parts = key.split(':');
    if (parts[0] === 'game' && parts.length > 1) {
      /** @type {string[]} */
      const groups = ['game'];
      let start = 1;
      const second = parts[1];
      if (second && !isGameSuffix(second) && !DOC_REF.test(second)) {
        groups.push(shortServerHash(second));
        start = 2;
      }
      const tail = collectGroups(parts, start);
      if (groups.length === 1 && tail.length === 1 && !tail[0].startsWith('srv:')) {
        return `game:${tail[0]}`;
      }
      return groups.concat(tail).join(' ');
    }
    const groups = collectGroups(parts, 0);
    return groups.join(' ') || 'unknown';
  } catch {
    return 'unknown';
  }
}

module.exports = {
  shortServerHash,
  describeStateKey,
};
