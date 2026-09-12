import { describe, expect, it, vi } from 'vitest';
import {
  classifyError,
  createAiClient,
  normalizeBaseUrl,
  safeErrorMessage,
  stripReasoning,
} from '../electron/ai-client.js';

describe('stripReasoning', () => {
  it('leaves plain replies untouched', () => {
    expect(stripReasoning('{Y}Tony{x} strikes the goblin.')).toBe('{Y}Tony{x} strikes the goblin.');
  });

  it('removes a closed <think> block', () => {
    expect(stripReasoning('<think>Need SILENCE. Final only.</think>SILENCE')).toBe('SILENCE');
  });

  it('removes multiple blocks and surrounding whitespace', () => {
    expect(stripReasoning('<think>a</think>\n\nLine one\n<think>b</think>\nLine two\n')).toBe(
      'Line one\n\nLine two',
    );
  });

  it('handles a dropped opening tag (reasoning then </think>)', () => {
    expect(stripReasoning('The hard rules say... probably SILENCE.\n</think>SILENCE')).toBe(
      'SILENCE',
    );
  });

  it('drops an unterminated <think> (truncated reply)', () => {
    expect(stripReasoning('Answer.\n<think>still going')).toBe('Answer.');
    expect(stripReasoning('<think>only thought')).toBe('');
  });

  it('chat() applies it to the returned content', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({
        model: 'm',
        choices: [{ message: { role: 'assistant', content: '<think>x</think>Tony swings.' } }],
      }),
    );
    const client = createAiClient({ baseUrl: BASE_URL, apiKey: '', fetchImpl });
    const res = await client.chat({ model: 'm', messages: [] });
    expect(res.content).toBe('Tony swings.');
  });
});

const SECRET_KEY = 'sk-abc123SUPERSECRET';
const BASE_URL = 'http://127.0.0.1:1234/v1';

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  };
}

describe('normalizeBaseUrl', () => {
  it('strips trailing slashes and whitespace', () => {
    expect(normalizeBaseUrl('http://localhost:1234/v1///')).toBe('http://localhost:1234/v1');
    expect(normalizeBaseUrl('  http://localhost:1234/v1/ ')).toBe('http://localhost:1234/v1');
  });

  it('tolerates undefined', () => {
    expect(normalizeBaseUrl(undefined)).toBe('');
  });
});

describe('safeErrorMessage', () => {
  it('redacts bearer tokens', () => {
    const msg = safeErrorMessage(new Error(`Request failed: Authorization: Bearer ${SECRET_KEY} rejected`));
    expect(msg).not.toContain(SECRET_KEY);
    expect(msg).toContain('Bearer [REDACTED]');
  });

  it('redacts sk- keys', () => {
    const msg = safeErrorMessage(new Error(`bad key ${SECRET_KEY} here`));
    expect(msg).not.toContain(SECRET_KEY);
    expect(msg).toContain('[REDACTED]');
  });

  it('uses generic "AI server" wording and never mentions LM Studio', () => {
    const msg = safeErrorMessage(undefined);
    expect(msg).toBe('AI server request failed');
    expect(msg).not.toMatch(/LM Studio/i);
  });
});

describe('classifyError', () => {
  it('maps HTTP statuses on Response-like objects', () => {
    expect(classifyError({ ok: false, status: 401 })).toBe('unauthorized');
    expect(classifyError({ ok: false, status: 403 })).toBe('forbidden');
    expect(classifyError({ ok: false, status: 404 })).toBe('not_found');
    expect(classifyError({ ok: false, status: 429 })).toBe('rate_limited');
    expect(classifyError({ ok: false, status: 500 })).toBe('http_error');
  });

  it('maps network errors and aborts to unreachable', () => {
    expect(classifyError(new TypeError('fetch failed'))).toBe('unreachable');
    const abort = new Error('aborted');
    abort.name = 'AbortError';
    expect(classifyError(abort)).toBe('unreachable');
    const conn = new Error('connect ECONNREFUSED');
    conn.code = 'ECONNREFUSED';
    expect(classifyError(conn)).toBe('unreachable');
  });

  it('maps invalid URL errors', () => {
    const err = new TypeError('Invalid URL');
    err.code = 'ERR_INVALID_URL';
    expect(classifyError(err)).toBe('invalid_url');
  });

  it('passes through errors that already carry a known code', () => {
    const err = new Error('x');
    err.code = 'no_models';
    expect(classifyError(err)).toBe('no_models');
  });

  it('falls back to http_error for unknown input', () => {
    expect(classifyError(new Error('something odd'))).toBe('http_error');
    expect(classifyError(null)).toBe('http_error');
  });
});

describe('createAiClient', () => {
  it('sends Bearer local when apiKey is empty', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'm1' }] }));
    const client = createAiClient({ baseUrl: BASE_URL, apiKey: '', fetchImpl });
    await client.listModels();
    const [, init] = fetchImpl.mock.calls[0];
    expect(init.headers.Authorization).toBe('Bearer local');
    expect(init.signal).toBeInstanceOf(AbortSignal);
  });

  it('sends the configured key and hits /models', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({ data: [{ id: 'a' }, { id: 'b' }, { nope: 1 }] }));
    const client = createAiClient({ baseUrl: `${BASE_URL}/`, apiKey: SECRET_KEY, fetchImpl });
    const models = await client.listModels();
    expect(models).toEqual([{ id: 'a' }, { id: 'b' }]);
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/models`);
    expect(init.method).toBe('GET');
    expect(init.headers.Authorization).toBe(`Bearer ${SECRET_KEY}`);
  });

  it('chat posts to /chat/completions and returns content + model', async () => {
    const fetchImpl = vi.fn(async () =>
      jsonResponse({ model: 'served-model', choices: [{ message: { content: 'hello' } }] }),
    );
    const client = createAiClient({ baseUrl: BASE_URL, apiKey: '', fetchImpl });
    const result = await client.chat({
      model: 'req-model',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
    });
    expect(result).toEqual({ content: 'hello', model: 'served-model' });
    const [url, init] = fetchImpl.mock.calls[0];
    expect(url).toBe(`${BASE_URL}/chat/completions`);
    expect(init.method).toBe('POST');
    const body = JSON.parse(init.body);
    expect(body).toEqual({
      model: 'req-model',
      messages: [{ role: 'user', content: 'hi' }],
      temperature: 0.2,
      stream: false,
    });
  });

  it('chat throws "No model selected" when model is omitted', async () => {
    const fetchImpl = vi.fn();
    const client = createAiClient({ baseUrl: BASE_URL, apiKey: '', fetchImpl });
    await expect(client.chat({ messages: [] })).rejects.toThrow('No model selected');
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('HTTP errors carry err.code and never leak URL or key', async () => {
    const fetchImpl = vi.fn(async () => jsonResponse({}, 401));
    const client = createAiClient({ baseUrl: BASE_URL, apiKey: SECRET_KEY, fetchImpl });
    let caught;
    try {
      await client.listModels();
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(Error);
    expect(caught.code).toBe('unauthorized');
    expect(caught.status).toBe(401);
    expect(caught.message).not.toContain(SECRET_KEY);
    expect(caught.message).not.toContain('127.0.0.1');
    expect(caught.message).not.toMatch(/LM Studio/i);
  });

  it('maps 429 and 404 to codes', async () => {
    const client429 = createAiClient({ baseUrl: BASE_URL, apiKey: '', fetchImpl: async () => jsonResponse({}, 429) });
    await expect(client429.listModels()).rejects.toMatchObject({ code: 'rate_limited' });
    const client404 = createAiClient({ baseUrl: BASE_URL, apiKey: '', fetchImpl: async () => jsonResponse({}, 404) });
    await expect(client404.listModels()).rejects.toMatchObject({ code: 'not_found' });
  });

  it('network failures become unreachable and redact key material from the message', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new TypeError(`fetch failed for Bearer ${SECRET_KEY} at ${BASE_URL}`);
    });
    const client = createAiClient({ baseUrl: BASE_URL, apiKey: SECRET_KEY, fetchImpl });
    let caught;
    try {
      await client.listModels();
    } catch (err) {
      caught = err;
    }
    expect(caught.code).toBe('unreachable');
    expect(caught.message).toBe('AI server is unreachable');
    expect(caught.message).not.toContain(SECRET_KEY);
    expect(caught.message).not.toContain(BASE_URL);
  });

  it('rejects invalid base URLs without calling fetch', async () => {
    const fetchImpl = vi.fn();
    const client = createAiClient({ baseUrl: 'not a url', apiKey: '', fetchImpl });
    await expect(client.listModels()).rejects.toMatchObject({ code: 'invalid_url' });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it('aborts via AbortController when the timeout elapses', async () => {
    vi.useFakeTimers();
    try {
      const fetchImpl = vi.fn(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init.signal.addEventListener('abort', () => {
              const err = new Error('aborted');
              err.name = 'AbortError';
              reject(err);
            });
          }),
      );
      const client = createAiClient({ baseUrl: BASE_URL, apiKey: '', fetchImpl, timeoutMs: 50 });
      const pending = client.listModels();
      const assertion = expect(pending).rejects.toMatchObject({ code: 'unreachable' });
      await vi.advanceTimersByTimeAsync(60);
      await assertion;
    } finally {
      vi.useRealTimers();
    }
  });
});
