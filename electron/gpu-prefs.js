const fs = require('fs');
const path = require('path');

const DEFAULT_GPU_PREFS = {
  preferSoftwareWebgl: false,
  lastFallbackReason: null,
  lastFallbackAt: null,
};

/**
 * @param {string} filePath
 * @returns {{ preferSoftwareWebgl: boolean, lastFallbackReason: string|null, lastFallbackAt: string|null }}
 */
function readGpuPrefs(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return { ...DEFAULT_GPU_PREFS };
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    return {
      preferSoftwareWebgl: Boolean(parsed.preferSoftwareWebgl),
      lastFallbackReason: parsed.lastFallbackReason ?? null,
      lastFallbackAt: parsed.lastFallbackAt ?? null,
    };
  } catch {
    return { ...DEFAULT_GPU_PREFS };
  }
}

/**
 * @param {string} filePath
 * @param {{ preferSoftwareWebgl: boolean, lastFallbackReason: string|null, lastFallbackAt: string|null }} prefs
 */
function writeGpuPrefs(filePath, prefs) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const toWrite = {
    preferSoftwareWebgl: Boolean(prefs.preferSoftwareWebgl),
    lastFallbackReason: prefs.lastFallbackReason ?? null,
    lastFallbackAt: prefs.lastFallbackAt ?? null,
  };
  fs.writeFileSync(filePath, JSON.stringify(toWrite, null, 2), 'utf8');
}

module.exports = {
  readGpuPrefs,
  writeGpuPrefs,
  DEFAULT_GPU_PREFS,
};
