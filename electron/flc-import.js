const fs = require('fs');

/**
 * Map a FLC-shaped { servers: [] } file to our schema.
 * Callers must pass an explicit path. There is no default path to any
 * other install on this machine (official FLC or Chris' Custom FLC).
 *
 * @param {string} flcServersJsonPath
 * @returns {Array<{ id: string, label: string, url: string, notes: string, order: number }>}
 */
function importFromFlc(flcServersJsonPath) {
  if (!flcServersJsonPath || !fs.existsSync(flcServersJsonPath)) {
    return [];
  }
  let raw;
  try {
    raw = fs.readFileSync(flcServersJsonPath, 'utf8');
  } catch (err) {
    console.warn('importFromFlc: could not read file', err.message);
    return [];
  }
  let data;
  try {
    data = JSON.parse(raw);
  } catch (err) {
    console.warn('importFromFlc: malformed JSON', err.message);
    return [];
  }
  if (!data || !Array.isArray(data.servers)) {
    console.warn('importFromFlc: unexpected shape, expected { servers: [] }');
    return [];
  }
  return data.servers.map((s) => ({
    id: s.id,
    label: s.label ?? '',
    url: s.url ?? '',
    notes: s.notes ?? '',
    order: s.order ?? 0,
  }));
}

module.exports = {
  importFromFlc,
};
