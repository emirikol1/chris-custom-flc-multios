'use strict';

const fs = require('fs');
const path = require('path');
const { createAiClient, classifyError, isHttpUrl, normalizeBaseUrl } = require('./ai-client');

/**
 * @typedef {{ id: string, label: string, group: 'local'|'hosted-free'|'paid'|'custom', baseUrl: string, keyRequired: boolean, signupUrl: string, hint: string }} Preset
 * @typedef {{ preset: string, baseUrl: string, apiKey: string, model: string }} ProviderConfig
 */

/** @type {ReadonlyArray<Preset>} */
const PRESETS = Object.freeze([
  {
    id: 'lmstudio',
    label: 'LM Studio',
    group: 'local',
    baseUrl: 'http://127.0.0.1:1234/v1',
    keyRequired: false,
    signupUrl: 'https://lmstudio.ai/',
    hint: 'Free. Runs on this computer. Load a model in LM Studio first.',
  },
  {
    id: 'ollama',
    label: 'Ollama',
    group: 'local',
    baseUrl: 'http://localhost:11434/v1',
    keyRequired: false,
    signupUrl: 'https://ollama.com/download',
    hint: 'Free. Runs on this computer. Pull a model with ollama first.',
  },
  {
    id: 'groq',
    label: 'Groq (free tier)',
    group: 'hosted-free',
    baseUrl: 'https://api.groq.com/openai/v1',
    keyRequired: true,
    signupUrl: 'https://console.groq.com/keys',
    hint: 'Free key, no card. Very fast. About 14,400 requests/day.',
  },
  {
    id: 'cerebras',
    label: 'Cerebras (free tier)',
    group: 'hosted-free',
    baseUrl: 'https://api.cerebras.ai/v1',
    keyRequired: true,
    signupUrl: 'https://cloud.cerebras.ai/',
    hint: 'Free key, no card. About 1M tokens/day.',
  },
  {
    id: 'gemini',
    label: 'Google Gemini (AI Studio free tier)',
    group: 'hosted-free',
    baseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    keyRequired: true,
    signupUrl: 'https://aistudio.google.com/apikey',
    hint: 'Free key, no card. Generous daily limits.',
  },
  {
    id: 'openrouter',
    label: 'OpenRouter (free models)',
    group: 'hosted-free',
    baseUrl: 'https://openrouter.ai/api/v1',
    keyRequired: true,
    signupUrl: 'https://openrouter.ai/keys',
    hint: 'Free key. Only models ending in :free are shown. About 50 requests/day on a free account.',
  },
  {
    id: 'mistral',
    label: 'Mistral (free Experiment tier)',
    group: 'hosted-free',
    baseUrl: 'https://api.mistral.ai/v1',
    keyRequired: true,
    signupUrl: 'https://console.mistral.ai/api-keys',
    hint: 'Free key. Low rate limit (about 2 requests/minute).',
  },
  {
    id: 'openai',
    label: 'OpenAI (paid)',
    group: 'paid',
    baseUrl: 'https://api.openai.com/v1',
    keyRequired: true,
    signupUrl: 'https://platform.openai.com/api-keys',
    hint: 'Paid account required.',
  },
  {
    id: 'custom',
    label: 'Custom (OpenAI-compatible URL)',
    group: 'custom',
    baseUrl: '',
    keyRequired: false,
    signupUrl: '',
    hint: 'Any server that speaks the OpenAI /v1 API.',
  },
].map((p) => Object.freeze(p)));

const DEFAULT_PRESET_ID = 'lmstudio';

/**
 * @param {string} id
 * @returns {Preset|undefined}
 */
function getPreset(id) {
  return PRESETS.find((p) => p.id === id);
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function asTrimmedString(value) {
  return typeof value === 'string' ? value.trim() : '';
}

/**
 * @returns {ProviderConfig}
 */
function defaultProviderConfig() {
  const preset = /** @type {Preset} */ (getPreset(DEFAULT_PRESET_ID));
  return { preset: preset.id, baseUrl: preset.baseUrl, apiKey: '', model: '' };
}

/**
 * @param {string} filePath
 * @returns {ProviderConfig}
 */
function readProviderConfig(filePath) {
  const defaults = defaultProviderConfig();
  try {
    if (!filePath || !fs.existsSync(filePath)) {
      return defaults;
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') return defaults;

    const presetId = asTrimmedString(parsed.preset);
    const preset = getPreset(presetId) || getPreset(DEFAULT_PRESET_ID);
    const storedBaseUrl = asTrimmedString(parsed.baseUrl);
    return {
      preset: /** @type {Preset} */ (preset).id,
      baseUrl: storedBaseUrl || /** @type {Preset} */ (preset).baseUrl,
      apiKey: asTrimmedString(parsed.apiKey),
      model: asTrimmedString(parsed.model),
    };
  } catch {
    return defaults;
  }
}

/**
 * @param {string} filePath
 * @param {Partial<ProviderConfig>} cfg
 * @returns {ProviderConfig}
 */
function writeProviderConfig(filePath, cfg) {
  const input = cfg && typeof cfg === 'object' ? cfg : {};
  const presetId = asTrimmedString(input.preset) || DEFAULT_PRESET_ID;
  const preset = getPreset(presetId);
  if (!preset) {
    const err = /** @type {Error & { code: string }} */ (new Error('Unknown AI provider preset'));
    err.code = 'invalid_preset';
    throw err;
  }

  const rawBaseUrl = asTrimmedString(input.baseUrl) || preset.baseUrl;
  if (!isHttpUrl(rawBaseUrl)) {
    const err = /** @type {Error & { code: string }} */ (new Error('AI server URL must start with http:// or https://'));
    err.code = 'invalid_url';
    throw err;
  }
  const baseUrl = normalizeBaseUrl(rawBaseUrl);

  let apiKey;
  if (input.apiKey === undefined) {
    apiKey = readProviderConfig(filePath).apiKey;
  } else {
    apiKey = asTrimmedString(input.apiKey);
  }

  const toWrite = {
    preset: preset.id,
    baseUrl,
    apiKey,
    model: asTrimmedString(input.model),
  };

  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  }
  fs.writeFileSync(filePath, JSON.stringify(toWrite, null, 2), { encoding: 'utf8', mode: 0o600 });
  try {
    // writeFileSync's mode only applies on creation; enforce on existing files too.
    fs.chmodSync(filePath, 0o600);
  } catch {
    // Some platforms (Windows) do not support POSIX modes; ignore.
  }
  return toWrite;
}

/**
 * Strip the API key before sending config to the renderer.
 * @param {Partial<ProviderConfig>} cfg
 * @returns {{ preset: string, baseUrl: string, model: string, hasKey: boolean }}
 */
function publicProviderConfig(cfg) {
  const input = cfg && typeof cfg === 'object' ? cfg : {};
  const { apiKey, ...rest } = input;
  return {
    ...rest,
    preset: asTrimmedString(input.preset) || DEFAULT_PRESET_ID,
    baseUrl: asTrimmedString(input.baseUrl),
    model: asTrimmedString(input.model),
    hasKey: asTrimmedString(apiKey).length > 0,
  };
}

/**
 * @param {string} filePath
 * @returns {{ ok: true, baseUrl: string, apiKey: string, model: string, preset: string } | { ok: false, code: 'not_configured', message: string }}
 */
function loadProvider(filePath) {
  const cfg = readProviderConfig(filePath);
  const preset = getPreset(cfg.preset);
  const notConfigured = /** @type {const} */ ({
    ok: false,
    code: 'not_configured',
    message: 'AI server is not set up yet',
  });
  if (!preset) return notConfigured;
  if (!isHttpUrl(cfg.baseUrl)) return notConfigured;
  if (!cfg.model) return notConfigured;
  if (preset.keyRequired && !cfg.apiKey) return notConfigured;
  return {
    ok: true,
    baseUrl: normalizeBaseUrl(cfg.baseUrl),
    apiKey: cfg.apiKey,
    model: cfg.model,
    preset: preset.id,
  };
}

/**
 * @template {{ id: string } | string} T
 * @param {string} presetId
 * @param {T[]} models
 * @returns {T[]}
 */
function filterModelsForPreset(presetId, models) {
  const list = Array.isArray(models) ? models : [];
  if (presetId !== 'openrouter') return list;
  return list.filter((m) => {
    const id = typeof m === 'string' ? m : m && m.id ? String(m.id) : '';
    return id.endsWith(':free');
  });
}

/**
 * Probe a provider by listing its models. Never throws and never returns the
 * URL or key.
 * @param {{ preset?: string, baseUrl?: string, apiKey?: string }} cfg
 * @param {{ fetchImpl?: typeof fetch, clientFactory?: typeof createAiClient }} [deps]
 * @returns {Promise<{ ok: true, models: string[] } | { ok: false, error: string }>}
 */
async function testConnection(cfg, deps) {
  const input = cfg && typeof cfg === 'object' ? cfg : {};
  const options = deps && typeof deps === 'object' ? deps : {};
  const presetId = asTrimmedString(input.preset) || DEFAULT_PRESET_ID;
  const preset = getPreset(presetId);
  const baseUrl = asTrimmedString(input.baseUrl) || (preset ? preset.baseUrl : '');
  if (!isHttpUrl(baseUrl)) {
    return { ok: false, error: 'invalid_url' };
  }
  try {
    const factory = typeof options.clientFactory === 'function' ? options.clientFactory : createAiClient;
    const client = factory({
      baseUrl,
      apiKey: asTrimmedString(input.apiKey),
      fetchImpl: options.fetchImpl,
    });
    const models = await client.listModels();
    const filtered = filterModelsForPreset(presetId, Array.isArray(models) ? models : []);
    const ids = filtered.map((m) => (typeof m === 'string' ? m : String(m.id))).filter(Boolean);
    if (ids.length === 0) {
      return { ok: false, error: 'no_models' };
    }
    return { ok: true, models: ids };
  } catch (err) {
    return { ok: false, error: classifyError(err) };
  }
}

module.exports = {
  PRESETS,
  DEFAULT_PRESET_ID,
  getPreset,
  readProviderConfig,
  writeProviderConfig,
  publicProviderConfig,
  loadProvider,
  filterModelsForPreset,
  testConnection,
};
