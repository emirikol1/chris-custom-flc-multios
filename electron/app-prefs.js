const fs = require('fs');
const path = require('path');

const DEFAULT_APP_PREFS = {
  mudEnabled: false,
  serversCollapsed: false,
  mudCollapsed: false,
  loadingBannerEnabled: true,
};

/** @typedef {{ mudEnabled: boolean, serversCollapsed: boolean, mudCollapsed: boolean, loadingBannerEnabled: boolean }} AppPrefs */

const BOOL_KEYS = /** @type {(keyof AppPrefs)[]} */ (Object.keys(DEFAULT_APP_PREFS));

/**
 * Unknown keys (including a leftover diskCacheMb) are ignored.
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
      if (parsed && Object.prototype.hasOwnProperty.call(parsed, key)) {
        out[key] = Boolean(parsed[key]);
      }
    }
    return out;
  } catch {
    return { ...DEFAULT_APP_PREFS };
  }
}

/**
 * Writes only the boolean prefs. A leftover diskCacheMb in the file is not written back.
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
