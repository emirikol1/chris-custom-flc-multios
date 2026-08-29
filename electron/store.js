const crypto = require('crypto');
const fs = require('fs');
const path = require('path');

const DEFAULT_SERVERS_PATH = path.join(__dirname, '..', 'data', 'servers.json');

/**
 * @param {string} input
 * @returns {string}
 */
function normalizeUrl(input) {
  const trimmed = String(input).trim();
  if (!trimmed) {
    throw new Error('URL is required');
  }
  let candidate = trimmed;
  if (!/^https?:\/\//i.test(candidate)) {
    candidate = `https://${candidate}`;
  }
  try {
    const parsed = new URL(candidate);
    if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
      throw new Error('URL must use http or https');
    }
    return parsed.href;
  } catch (err) {
    if (err instanceof TypeError || err.message === 'URL must use http or https') {
      throw new Error(`Invalid URL: ${trimmed}`);
    }
    throw err;
  }
}

/**
 * @param {string} [filePath]
 * @returns {import('./store').Server[]}
 */
function loadServers(filePath = DEFAULT_SERVERS_PATH) {
  if (!fs.existsSync(filePath)) {
    return [];
  }
  const raw = fs.readFileSync(filePath, 'utf8');
  const data = JSON.parse(raw);
  if (!data || !Array.isArray(data.servers)) {
    return [];
  }
  return data.servers;
}

/**
 * @param {string} filePath
 * @param {import('./store').Server[]} servers
 */
function saveServers(filePath, servers) {
  const dir = path.dirname(filePath);
  fs.mkdirSync(dir, { recursive: true });
  const payload = { servers };
  // mode 0o600 is best-effort permission tightening, not real security.
  fs.writeFileSync(filePath, JSON.stringify(payload, null, 2), { mode: 0o600 });
}

/**
 * Create an empty servers file if missing. Does not read any other install.
 * @param {string} filePath
 */
function ensureServersFile(filePath) {
  if (!fs.existsSync(filePath)) {
    saveServers(filePath, []);
  }
}

/**
 * @param {import('./store').Server[]} servers
 * @param {Omit<import('./store').Server, 'id'> & { id?: string }} data
 * @returns {import('./store').Server[]}
 */
function addServer(servers, data) {
  const url = normalizeUrl(data.url);
  const nextOrder =
    data.order !== undefined
      ? data.order
      : servers.length === 0
        ? 0
        : Math.max(...servers.map((s) => s.order ?? 0)) + 1;
  const entry = {
    id: crypto.randomUUID(),
    label: data.label ?? '',
    url,
    notes: data.notes ?? '',
    order: nextOrder,
  };
  if (data.username !== undefined && data.username !== '') {
    entry.username = data.username;
  }
  if (data.password !== undefined && data.password !== '') {
    entry.password = data.password;
  }
  return [...servers, entry];
}

/**
 * @param {import('./store').Server[]} servers
 * @param {string} id
 * @param {Partial<import('./store').Server>} patch
 * @returns {import('./store').Server[]}
 */
function updateServer(servers, id, patch) {
  const index = servers.findIndex((s) => s.id === id);
  if (index === -1) {
    throw new Error(`Server not found: ${id}`);
  }
  const current = servers[index];
  const updated = { ...current, ...patch, id: current.id };
  if (patch.url !== undefined) {
    updated.url = normalizeUrl(patch.url);
  }
  const next = servers.slice();
  next[index] = updated;
  return next;
}

/**
 * @param {import('./store').Server[]} servers
 * @param {string} id
 * @returns {import('./store').Server[]}
 */
function deleteServer(servers, id) {
  return servers.filter((s) => s.id !== id);
}

/**
 * @param {import('./store').Server[]} servers
 * @returns {import('./store').Server[]}
 */
function listServers(servers) {
  return [...servers].sort((a, b) => {
    const orderA = a.order ?? 0;
    const orderB = b.order ?? 0;
    if (orderA !== orderB) {
      return orderA - orderB;
    }
    return String(a.label ?? '').localeCompare(String(b.label ?? ''), undefined, {
      sensitivity: 'base',
    });
  });
}

module.exports = {
  DEFAULT_SERVERS_PATH,
  normalizeUrl,
  loadServers,
  saveServers,
  ensureServersFile,
  addServer,
  updateServer,
  deleteServer,
  listServers,
};
