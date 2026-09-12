'use strict';

/**
 * Import/export of all user settings as a single JSON document.
 *
 * Pure functions only (no Electron, no fs) so they are unit-testable; main.js
 * wires them to the individual stores and the file dialogs.
 */

const { addServer, updateServer } = require('./store');

const FORMAT_VERSION = 1;
const APP_ID = 'chris-custom-flc-multios';

/**
 * @typedef {{
 *   app: string,
 *   format: number,
 *   exportedAt: string,
 *   appVersion?: string,
 *   servers?: object[],
 *   aiProvider?: { preset?: string, baseUrl?: string, apiKey?: string, model?: string },
 *   appPrefs?: Record<string, boolean>,
 *   narratorSettings?: Record<string, unknown>,
 *   windowState?: Record<string, object>,
 * }} SettingsBundle
 */

/**
 * Build the export document.
 * @param {{
 *   servers: object[],
 *   aiProvider: object,
 *   appPrefs: object,
 *   narratorSettings: object,
 *   windowState: object,
 *   appVersion?: string,
 *   now?: () => string,
 * }} parts
 * @returns {SettingsBundle}
 */
function buildExport(parts) {
  const now = typeof parts.now === 'function' ? parts.now : () => new Date().toISOString();
  return {
    app: APP_ID,
    format: FORMAT_VERSION,
    exportedAt: now(),
    ...(parts.appVersion ? { appVersion: String(parts.appVersion) } : {}),
    servers: Array.isArray(parts.servers) ? parts.servers : [],
    aiProvider: isPlainObject(parts.aiProvider) ? parts.aiProvider : {},
    appPrefs: isPlainObject(parts.appPrefs) ? parts.appPrefs : {},
    narratorSettings: isPlainObject(parts.narratorSettings) ? parts.narratorSettings : {},
    windowState: isPlainObject(parts.windowState) ? parts.windowState : {},
  };
}

/**
 * Parse and validate an import document.
 * @param {string} text JSON text
 * @returns {{ ok: true, bundle: SettingsBundle } | { ok: false, error: 'invalid_json' | 'not_settings_file' | 'unsupported_format' }}
 */
function parseImport(text) {
  let parsed;
  try {
    parsed = JSON.parse(String(text));
  } catch {
    return { ok: false, error: 'invalid_json' };
  }
  if (!isPlainObject(parsed) || parsed.app !== APP_ID) {
    return { ok: false, error: 'not_settings_file' };
  }
  if (Number(parsed.format) !== FORMAT_VERSION) {
    return { ok: false, error: 'unsupported_format' };
  }
  /** @type {SettingsBundle} */
  const bundle = {
    app: APP_ID,
    format: FORMAT_VERSION,
    exportedAt: typeof parsed.exportedAt === 'string' ? parsed.exportedAt : '',
  };
  if (Array.isArray(parsed.servers)) bundle.servers = parsed.servers.filter(isPlainObject);
  if (isPlainObject(parsed.aiProvider)) bundle.aiProvider = parsed.aiProvider;
  if (isPlainObject(parsed.appPrefs)) bundle.appPrefs = parsed.appPrefs;
  if (isPlainObject(parsed.narratorSettings)) bundle.narratorSettings = parsed.narratorSettings;
  if (isPlainObject(parsed.windowState)) {
    bundle.windowState = Object.fromEntries(
      Object.entries(parsed.windowState).filter(([, v]) => isPlainObject(v)),
    );
  }
  return { ok: true, bundle };
}

/**
 * Merge imported servers into the existing list.
 *  - same id            → update in place
 *  - same URL (no id)   → update in place
 *  - otherwise          → add
 * Invalid entries (missing/bad URL) are skipped and counted.
 * @param {object[]} existing
 * @param {object[]} incoming
 * @returns {{ servers: object[], added: number, updated: number, skipped: number }}
 */
function mergeServers(existing, incoming) {
  let servers = Array.isArray(existing) ? existing.slice() : [];
  let added = 0;
  let updated = 0;
  let skipped = 0;
  for (const raw of Array.isArray(incoming) ? incoming : []) {
    if (!isPlainObject(raw) || typeof raw.url !== 'string' || !raw.url.trim()) {
      skipped += 1;
      continue;
    }
    const patch = pickServerFields(raw);
    try {
      let target = raw.id ? servers.find((s) => s.id === raw.id) : undefined;
      if (!target) {
        const url = normalizeForCompare(raw.url);
        target = servers.find((s) => normalizeForCompare(s.url) === url);
      }
      if (target) {
        servers = updateServer(servers, target.id, patch);
        updated += 1;
      } else {
        servers = addServer(servers, patch);
        added += 1;
      }
    } catch {
      skipped += 1;
    }
  }
  return { servers, added, updated, skipped };
}

/** @param {Record<string, unknown>} raw */
function pickServerFields(raw) {
  /** @type {Record<string, unknown>} */
  const out = { url: raw.url };
  if (typeof raw.label === 'string') out.label = raw.label;
  if (typeof raw.notes === 'string') out.notes = raw.notes;
  if (typeof raw.order === 'number' && Number.isFinite(raw.order)) out.order = raw.order;
  if (typeof raw.username === 'string' && raw.username !== '') out.username = raw.username;
  if (typeof raw.password === 'string' && raw.password !== '') out.password = raw.password;
  if (raw.autoJoin !== undefined) out.autoJoin = Boolean(raw.autoJoin);
  return out;
}

/** @param {unknown} url */
function normalizeForCompare(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(String(url)) ? String(url) : `https://${String(url)}`);
    return `${u.protocol}//${u.host}${u.pathname.replace(/\/+$/, '')}`.toLowerCase();
  } catch {
    return String(url).trim().toLowerCase();
  }
}

/** @param {unknown} v */
function isPlainObject(v) {
  return Boolean(v) && typeof v === 'object' && !Array.isArray(v);
}

module.exports = {
  APP_ID,
  FORMAT_VERSION,
  buildExport,
  parseImport,
  mergeServers,
};
