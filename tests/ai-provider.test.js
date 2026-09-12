import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  PRESETS,
  filterModelsForPreset,
  getPreset,
  loadProvider,
  publicProviderConfig,
  readProviderConfig,
  testConnection,
  writeProviderConfig,
} from '../electron/ai-provider.js';

const SECRET_KEY = 'sk-test-SECRET-9999';
const tmpDirs = [];

function tempConfigFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-ai-provider-'));
  tmpDirs.push(dir);
  return path.join(dir, 'nested', 'ai-provider.json');
}

function jsonResponse(body, status = 200) {
  return { ok: status >= 200 && status < 300, status, json: async () => body };
}

afterEach(() => {
  for (const dir of tmpDirs) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
  tmpDirs.length = 0;
});

describe('PRESETS', () => {
  const EXPECTED = [
    ['lmstudio', 'LM Studio', 'local', 'http://127.0.0.1:1234/v1', false, 'https://lmstudio.ai/', 'Free. Runs on this computer. Load a model in LM Studio first.'],
    ['ollama', 'Ollama', 'local', 'http://localhost:11434/v1', false, 'https://ollama.com/download', 'Free. Runs on this computer. Pull a model with ollama first.'],
    ['groq', 'Groq (free tier)', 'hosted-free', 'https://api.groq.com/openai/v1', true, 'https://console.groq.com/keys', 'Free key, no card. Very fast. About 14,400 requests/day.'],
    ['cerebras', 'Cerebras (free tier)', 'hosted-free', 'https://api.cerebras.ai/v1', true, 'https://cloud.cerebras.ai/', 'Free key, no card. About 1M tokens/day.'],
    ['gemini', 'Google Gemini (AI Studio free tier)', 'hosted-free', 'https://generativelanguage.googleapis.com/v1beta/openai', true, 'https://aistudio.google.com/apikey', 'Free key, no card. Generous daily limits.'],
    ['openrouter', 'OpenRouter (free models)', 'hosted-free', 'https://openrouter.ai/api/v1', true, 'https://openrouter.ai/keys', 'Free key. Only models ending in :free are shown. About 50 requests/day on a free account.'],
    ['mistral', 'Mistral (free Experiment tier)', 'hosted-free', 'https://api.mistral.ai/v1', true, 'https://console.mistral.ai/api-keys', 'Free key. Low rate limit (about 2 requests/minute).'],
    ['openai', 'OpenAI (paid)', 'paid', 'https://api.openai.com/v1', true, 'https://platform.openai.com/api-keys', 'Paid account required.'],
    ['custom', 'Custom (OpenAI-compatible URL)', 'custom', '', false, '', 'Any server that speaks the OpenAI /v1 API.'],
  ];

  it('matches the expected table exactly, in order', () => {
    expect(PRESETS.map((p) => [p.id, p.label, p.group, p.baseUrl, p.keyRequired, p.signupUrl, p.hint])).toEqual(EXPECTED);
  });

  it('has unique ids, well-formed URLs, and valid groups', () => {
    const ids = PRESETS.map((p) => p.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const p of PRESETS) {
      expect(['local', 'hosted-free', 'paid', 'custom']).toContain(p.group);
      expect(typeof p.keyRequired).toBe('boolean');
      expect(typeof p.hint).toBe('string');
      if (p.id !== 'custom') {
        expect(p.baseUrl).toMatch(/^https?:\/\//);
        expect(p.baseUrl).not.toMatch(/\/$/);
        expect(p.signupUrl).toMatch(/^https:\/\//);
      }
    }
  });

  it('getPreset finds known ids and returns undefined otherwise', () => {
    expect(getPreset('groq').label).toBe('Groq (free tier)');
    expect(getPreset('nope')).toBeUndefined();
  });
});

describe('readProviderConfig / writeProviderConfig', () => {
  it('returns safe defaults when the file is missing', () => {
    expect(readProviderConfig(tempConfigFile())).toEqual({
      preset: 'lmstudio',
      baseUrl: 'http://127.0.0.1:1234/v1',
      apiKey: '',
      model: '',
    });
  });

  it('returns defaults when the file is corrupt', () => {
    const filePath = tempConfigFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, '{ not json', 'utf8');
    expect(readProviderConfig(filePath).preset).toBe('lmstudio');
  });

  it('falls back to lmstudio when stored preset is unknown', () => {
    const filePath = tempConfigFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ preset: 'bogus', model: 'x' }), 'utf8');
    const cfg = readProviderConfig(filePath);
    expect(cfg.preset).toBe('lmstudio');
    expect(cfg.baseUrl).toBe('http://127.0.0.1:1234/v1');
    expect(cfg.model).toBe('x');
  });

  it('round-trips, trims strings, creates parent dirs, and writes 0600', () => {
    const filePath = tempConfigFile();
    const written = writeProviderConfig(filePath, {
      preset: ' groq ',
      baseUrl: ' https://api.groq.com/openai/v1/ ',
      apiKey: `  ${SECRET_KEY}  `,
      model: ' llama-3 ',
    });
    expect(written).toEqual({
      preset: 'groq',
      baseUrl: 'https://api.groq.com/openai/v1',
      apiKey: SECRET_KEY,
      model: 'llama-3',
    });
    expect(readProviderConfig(filePath)).toEqual(written);
    const mode = fs.statSync(filePath).mode & 0o777;
    expect(mode).toBe(0o600);
    // Stored file is valid JSON.
    expect(() => JSON.parse(fs.readFileSync(filePath, 'utf8'))).not.toThrow();
  });

  it('keeps 0600 when overwriting an existing file with looser permissions', () => {
    const filePath = tempConfigFile();
    writeProviderConfig(filePath, { preset: 'ollama', model: 'a' });
    fs.chmodSync(filePath, 0o644);
    writeProviderConfig(filePath, { preset: 'ollama', model: 'b' });
    expect(fs.statSync(filePath).mode & 0o777).toBe(0o600);
  });

  it('preserves the stored apiKey when cfg.apiKey is undefined', () => {
    const filePath = tempConfigFile();
    writeProviderConfig(filePath, { preset: 'groq', apiKey: SECRET_KEY, model: 'm1' });
    writeProviderConfig(filePath, { preset: 'groq', model: 'm2' });
    const cfg = readProviderConfig(filePath);
    expect(cfg.apiKey).toBe(SECRET_KEY);
    expect(cfg.model).toBe('m2');
  });

  it('clears the apiKey when cfg.apiKey is an empty string', () => {
    const filePath = tempConfigFile();
    writeProviderConfig(filePath, { preset: 'groq', apiKey: SECRET_KEY, model: 'm1' });
    writeProviderConfig(filePath, { preset: 'groq', apiKey: '', model: 'm1' });
    expect(readProviderConfig(filePath).apiKey).toBe('');
  });

  it('uses the preset baseUrl when none is supplied', () => {
    const filePath = tempConfigFile();
    writeProviderConfig(filePath, { preset: 'ollama', model: 'llama3' });
    expect(readProviderConfig(filePath).baseUrl).toBe('http://localhost:11434/v1');
  });

  it('rejects unknown presets', () => {
    const filePath = tempConfigFile();
    expect(() => writeProviderConfig(filePath, { preset: 'nope', baseUrl: 'http://x/v1' })).toThrow();
    expect(fs.existsSync(filePath)).toBe(false);
  });

  it('rejects invalid base URLs with code invalid_url', () => {
    const filePath = tempConfigFile();
    for (const bad of ['', 'localhost:1234/v1', 'ftp://example.com/v1', 'file:///etc/passwd', 'not a url']) {
      let caught;
      try {
        writeProviderConfig(filePath, { preset: 'custom', baseUrl: bad, apiKey: '', model: 'm' });
      } catch (err) {
        caught = err;
      }
      expect(caught, `expected rejection for ${JSON.stringify(bad)}`).toBeInstanceOf(Error);
      expect(caught.code).toBe('invalid_url');
    }
    expect(fs.existsSync(filePath)).toBe(false);
  });
});

describe('publicProviderConfig', () => {
  it('removes apiKey and adds hasKey', () => {
    const pub = publicProviderConfig({ preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', apiKey: SECRET_KEY, model: 'm' });
    expect(pub).toEqual({ preset: 'groq', baseUrl: 'https://api.groq.com/openai/v1', model: 'm', hasKey: true });
    expect('apiKey' in pub).toBe(false);
    expect(JSON.stringify(pub)).not.toContain(SECRET_KEY);
  });

  it('reports hasKey false for empty key', () => {
    expect(publicProviderConfig({ preset: 'ollama', baseUrl: 'http://localhost:11434/v1', apiKey: '', model: '' }).hasKey).toBe(false);
    expect(publicProviderConfig({}).hasKey).toBe(false);
  });
});

describe('loadProvider readiness matrix', () => {
  const NOT_CONFIGURED = { ok: false, code: 'not_configured', message: 'AI server is not set up yet' };

  it('local preset with model and no key is ok', () => {
    const filePath = tempConfigFile();
    writeProviderConfig(filePath, { preset: 'ollama', model: 'llama3', apiKey: '' });
    expect(loadProvider(filePath)).toEqual({
      ok: true,
      preset: 'ollama',
      baseUrl: 'http://localhost:11434/v1',
      apiKey: '',
      model: 'llama3',
    });
  });

  it('hosted preset without key is not_configured', () => {
    const filePath = tempConfigFile();
    writeProviderConfig(filePath, { preset: 'groq', model: 'llama-3', apiKey: '' });
    expect(loadProvider(filePath)).toEqual(NOT_CONFIGURED);
  });

  it('hosted preset with key and model is ok', () => {
    const filePath = tempConfigFile();
    writeProviderConfig(filePath, { preset: 'groq', model: 'llama-3', apiKey: SECRET_KEY });
    expect(loadProvider(filePath)).toMatchObject({ ok: true, preset: 'groq', apiKey: SECRET_KEY, model: 'llama-3' });
  });

  it('missing model is not_configured', () => {
    const filePath = tempConfigFile();
    writeProviderConfig(filePath, { preset: 'ollama', model: '', apiKey: '' });
    expect(loadProvider(filePath)).toEqual(NOT_CONFIGURED);
  });

  it('missing file is not_configured', () => {
    expect(loadProvider(tempConfigFile())).toEqual(NOT_CONFIGURED);
  });

  it('invalid stored baseUrl is not_configured', () => {
    const filePath = tempConfigFile();
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, JSON.stringify({ preset: 'custom', baseUrl: 'garbage', model: 'm' }), 'utf8');
    expect(loadProvider(filePath)).toEqual(NOT_CONFIGURED);
  });
});

describe('filterModelsForPreset', () => {
  const models = [{ id: 'meta/llama:free' }, { id: 'openai/gpt-4o' }, { id: 'x/y:free' }];

  it('keeps only :free models for openrouter', () => {
    expect(filterModelsForPreset('openrouter', models)).toEqual([{ id: 'meta/llama:free' }, { id: 'x/y:free' }]);
    expect(filterModelsForPreset('openrouter', ['a:free', 'b'])).toEqual(['a:free']);
  });

  it('returns models unchanged for other presets', () => {
    expect(filterModelsForPreset('groq', models)).toEqual(models);
    expect(filterModelsForPreset('lmstudio', models)).toEqual(models);
  });

  it('tolerates non-array input', () => {
    expect(filterModelsForPreset('openrouter', undefined)).toEqual([]);
  });
});

describe('testConnection', () => {
  it('returns model ids on success', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'a' }, { id: 'b' }] }));
    const result = await testConnection({ preset: 'lmstudio', baseUrl: 'http://127.0.0.1:1234/v1', apiKey: '' }, { fetchImpl });
    expect(result).toEqual({ ok: true, models: ['a', 'b'] });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe('http://127.0.0.1:1234/v1/models');
    expect(init.headers.Authorization).toBe('Bearer local');
  });

  it('applies openrouter :free filtering', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'm/one:free' }, { id: 'm/two' }] }));
    const result = await testConnection({ preset: 'openrouter', apiKey: SECRET_KEY }, { fetchImpl });
    expect(result).toEqual({ ok: true, models: ['m/one:free'] });
  });

  it('returns unauthorized on 401 without leaking URL or key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const result = await testConnection({ preset: 'groq', apiKey: SECRET_KEY }, { fetchImpl });
    expect(result).toEqual({ ok: false, error: 'unauthorized' });
    const serialized = JSON.stringify(result);
    expect(serialized).not.toContain(SECRET_KEY);
    expect(serialized).not.toContain('groq.com');
  });

  it('returns unreachable on network failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError('fetch failed');
    });
    const result = await testConnection({ preset: 'ollama' }, { fetchImpl });
    expect(result).toEqual({ ok: false, error: 'unreachable' });
  });

  it('returns no_models on an empty list', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [] }));
    const result = await testConnection({ preset: 'lmstudio' }, { fetchImpl });
    expect(result).toEqual({ ok: false, error: 'no_models' });
  });

  it('returns no_models when openrouter filtering leaves nothing', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'paid/model' }] }));
    const result = await testConnection({ preset: 'openrouter', apiKey: SECRET_KEY }, { fetchImpl });
    expect(result).toEqual({ ok: false, error: 'no_models' });
  });

  it('returns invalid_url without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const result = await testConnection({ preset: 'custom', baseUrl: 'nope' }, { fetchImpl });
    expect(result).toEqual({ ok: false, error: 'invalid_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('never throws, even if the client factory blows up', async () => {
    const clientFactory = () => {
      throw new Error(`boom Bearer ${SECRET_KEY}`);
    };
    const result = await testConnection({ preset: 'lmstudio' }, { clientFactory });
    expect(result.ok).toBe(false);
    expect(typeof result.error).toBe('string');
    expect(JSON.stringify(result)).not.toContain(SECRET_KEY);
  });

  it('supports a custom clientFactory', async () => {
    const clientFactory = vi.fn(() => ({ listModels: async () => [{ id: 'z' }] }));
    const result = await testConnection({ preset: 'custom', baseUrl: 'http://example.test/v1', apiKey: 'k' }, { clientFactory });
    expect(result).toEqual({ ok: true, models: ['z'] });
    expect(clientFactory).toHaveBeenCalledWith(expect.objectContaining({ baseUrl: 'http://example.test/v1', apiKey: 'k' }));
  });
});
