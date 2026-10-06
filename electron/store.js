const crypto = require('crypto');
const fs = require('fs');
const path = require('path');
const {
  isExplicitPromptGlowStrength,
  isKnownPromptGlow,
  normalizePromptGlowStrength,
} = require('./center-prompts');

const DEFAULT_SERVERS_PATH = path.join(__dirname, '..', 'data', 'servers.json');

/** View-menu choices stored on a server profile. Missing keys mean the defaults. */
const PROMPT_APPEARANCE_KEYS = [
  'centerPrompts',
  'promptHighlight',
  'promptAutoRaise',
  'promptGlow',
  'promptGlowStrength',
];

/**
 * Appearance fields worth copying onto another server profile.
 * @param {object | null | undefined} source
 * @returns {Record<string, unknown>}
 */
function pickPromptAppearance(source) {
  /** @type {Record<string, unknown>} */
  const out = {};
  if (!source || typeof source !== 'object') return out;
  if (typeof source.centerPrompts === 'boolean') out.centerPrompts = source.centerPrompts;
  if (typeof source.promptHighlight === 'boolean') out.promptHighlight = source.promptHighlight;
  if (typeof source.promptAutoRaise === 'boolean') out.promptAutoRaise = source.promptAutoRaise;
  if (isKnownPromptGlow(source.promptGlow)) out.promptGlow = source.promptGlow;
  if (isExplicitPromptGlowStrength(source.promptGlowStrength)) {
    out.promptGlowStrength = normalizePromptGlowStrength(source.promptGlowStrength);
  }
  return out;
}

/**
 * @param {import('./store').Server[]} servers
 * @param {object | null | undefined} data
 */
function withClonedAppearance(servers, data) {
  const incoming = data && typeof data === 'object' ? { ...data } : {};
  const fromId = incoming.cloneFrom;
  delete incoming.cloneFrom;
  if (!fromId) return incoming;
  const source = servers.find((server) => server.id === fromId);
  return { ...pickPromptAppearance(source), ...incoming };
}

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
  const incoming = withClonedAppearance(servers, data);
  const url = normalizeUrl(incoming.url);
  const nextOrder =
    incoming.order !== undefined
      ? incoming.order
      : servers.length === 0
        ? 0
        : Math.max(...servers.map((s) => s.order ?? 0)) + 1;
  const entry = {
    id: crypto.randomUUID(),
    label: incoming.label ?? '',
    url,
    notes: incoming.notes ?? '',
    order: nextOrder,
  };
  if (incoming.username !== undefined && incoming.username !== '') {
    entry.username = incoming.username;
  }
  if (incoming.password !== undefined && incoming.password !== '') {
    entry.password = incoming.password;
  }
  entry.autoJoin = incoming.autoJoin === undefined ? true : Boolean(incoming.autoJoin);
  // Absent means "center prompts on". Only an explicit choice is stored.
  if (typeof incoming.centerPrompts === 'boolean') {
    entry.centerPrompts = incoming.centerPrompts;
  }
  // Absent means the prompt highlight is on, the glow is blue, and strength is 100%.
  if (typeof incoming.promptHighlight === 'boolean') {
    entry.promptHighlight = incoming.promptHighlight;
  }
  if (typeof incoming.promptAutoRaise === 'boolean') {
    entry.promptAutoRaise = incoming.promptAutoRaise;
  }
  if (isKnownPromptGlow(incoming.promptGlow)) {
    entry.promptGlow = incoming.promptGlow;
  }
  if (isExplicitPromptGlowStrength(incoming.promptGlowStrength)) {
    entry.promptGlowStrength = normalizePromptGlowStrength(incoming.promptGlowStrength);
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
  if (patch.autoJoin !== undefined) {
    updated.autoJoin = Boolean(patch.autoJoin);
  }
  if (patch.username === undefined && 'username' in patch) {
    delete updated.username;
  }
  if (patch.password === undefined && 'password' in patch) {
    delete updated.password;
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

/**
 * Drop prompt appearance back to the defaults (the keys are simply removed).
 * @param {import('./store').Server[]} servers
 * @param {string} id
 * @returns {{ servers: import('./store').Server[], changed: boolean }}
 */
function clearPromptAppearance(servers, id) {
  const index = servers.findIndex((server) => server.id === id);
  if (index === -1) return { servers, changed: false };
  const current = { ...servers[index] };
  let changed = false;
  for (const key of PROMPT_APPEARANCE_KEYS) {
    if (Object.prototype.hasOwnProperty.call(current, key)) {
      delete current[key];
      changed = true;
    }
  }
  if (!changed) return { servers, changed: false };
  const next = servers.slice();
  next[index] = current;
  return { servers: next, changed: true };
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
  clearPromptAppearance,
  pickPromptAppearance,
};
