const fs = require('fs');
const path = require('path');

const DEFAULT_APP_PREFS = {
  mudEnabled: false,
  serversCollapsed: false,
  mudCollapsed: false,
};

/** @typedef {{ mudEnabled: boolean, serversCollapsed: boolean, mudCollapsed: boolean }} AppPrefs */

const BOOL_KEYS = /** @type {(keyof AppPrefs)[]} */ (Object.keys(DEFAULT_APP_PREFS));

/**
 * @param {string} filePath
 * @returns {AppPrefs}
 */
function readAppPrefs(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_APP_PREFS };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const out = { ...DEFAULT_APP_PREFS };
    for (const key of BOOL_KEYS) {
      out[key] = Boolean(parsed && parsed[key]);
    }
    return out;
  } catch {
    return { ...DEFAULT_APP_PREFS };
  }
}

/**
 * @param {string} filePath
 * @param {Partial<AppPrefs>} patch
 * @returns {AppPrefs}
 */
function writeAppPrefs(filePath, patch) {
  const next = readAppPrefs(filePath);
  for (const key of BOOL_KEYS) {
    if (patch && patch[key] !== undefined) {
      next[key] = Boolean(patch[key]);
    }
  }
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  DEFAULT_APP_PREFS,
  readAppPrefs,
  writeAppPrefs,
};
