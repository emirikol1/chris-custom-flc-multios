const fs = require('fs');
const path = require('path');

const DEFAULT_APP_PREFS = {
  mudEnabled: false,
};

/**
 * @param {string} filePath
 * @returns {{ mudEnabled: boolean }}
 */
function readAppPrefs(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_APP_PREFS };
    }
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      mudEnabled: Boolean(parsed && parsed.mudEnabled),
    };
  } catch {
    return { ...DEFAULT_APP_PREFS };
  }
}

/**
 * @param {string} filePath
 * @param {Partial<{ mudEnabled: boolean }>} patch
 * @returns {{ mudEnabled: boolean }}
 */
function writeAppPrefs(filePath, patch) {
  const current = readAppPrefs(filePath);
  const next = {
    mudEnabled:
      patch && patch.mudEnabled !== undefined ? Boolean(patch.mudEnabled) : current.mudEnabled,
  };
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

module.exports = {
  DEFAULT_APP_PREFS,
  readAppPrefs,
  writeAppPrefs,
};
