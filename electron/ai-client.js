'use strict';

/**
 * OpenAI-compatible chat client (LM Studio, Ollama, Groq, OpenAI, ...).
 *
 * Security notes:
 * - Error messages are generic and never include the base URL or the API key.
 * - Any `Bearer <token>` / `sk-...` fragments that leak in from underlying
 *   errors are redacted before they are rethrown.
 */

const DEFAULT_LIST_TIMEOUT_MS = 10000;
const DEFAULT_CHAT_TIMEOUT_MS = 120000;

/** @type {ReadonlyArray<string>} */
const ERROR_CODES = Object.freeze([
  'unreachable',
  'unauthorized',
  'forbidden',
  'not_found',
  'rate_limited',
  'http_error',
  'no_models',
  'invalid_url',
]);

/**
 * @param {string} baseUrl
 * @returns {string}
 */
function normalizeBaseUrl(baseUrl) {
  return String(baseUrl ?? '')
    .trim()
    .replace(/\/+$/, '');
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isHttpUrl(value) {
  if (typeof value !== 'string' || value.trim() === '') return false;
  try {
    const parsed = new URL(value.trim());
    return parsed.protocol === 'http:' || parsed.protocol === 'https:';
  } catch {
    return false;
  }
}

/**
 * @param {string} text
 * @returns {string}
 */
function redact(text) {
  return String(text)
    .replace(/Bearer\s+\S+/gi, 'Bearer [REDACTED]')
    .replace(/sk-\S+/g, '[REDACTED]');
}

/**
 * @param {unknown} err
 * @returns {string}
 */
function safeErrorMessage(err) {
  const msg = err && err.message ? String(err.message) : 'AI server request failed';
  return redact(msg);
}

/**
 * @param {string} code
 * @param {string} message
 * @param {number} [status]
 * @returns {Error & { code: string, status?: number }}
 */
function makeError(code, message, status) {
  const err = /** @type {Error & { code: string, status?: number }} */ (new Error(redact(message)));
  err.code = code;
  if (typeof status === 'number') err.status = status;
  return err;
}

/**
 * @param {number} status
 * @returns {string}
 */
function codeForStatus(status) {
  switch (status) {
    case 401:
      return 'unauthorized';
    case 403:
      return 'forbidden';
    case 404:
      return 'not_found';
    case 429:
      return 'rate_limited';
    default:
      return 'http_error';
  }
}

/**
 * Map an error (or a fetch Response) to a stable error code.
 * @param {unknown} input
 * @returns {string}
 */
function classifyError(input) {
  if (input && typeof input === 'object') {
    // Response-like object.
    if (typeof (/** @type {any} */ (input).status) === 'number' && 'ok' in input) {
      const status = /** @type {any} */ (input).status;
      if (/** @type {any} */ (input).ok) return 'http_error';
      return codeForStatus(status);
    }
    const anyInput = /** @type {any} */ (input);
    if (typeof anyInput.code === 'string' && ERROR_CODES.includes(anyInput.code)) {
      return anyInput.code;
    }
    if (typeof anyInput.status === 'number') {
      return codeForStatus(anyInput.status);
    }
    if (anyInput.name === 'AbortError' || anyInput.name === 'TimeoutError') {
      return 'unreachable';
    }
    if (anyInput instanceof TypeError) {
      // fetch() throws TypeError on network failure / invalid URL.
      if (/invalid url/i.test(String(anyInput.message))) return 'invalid_url';
      return 'unreachable';
    }
    if (typeof anyInput.code === 'string') {
      // Node system errors: ECONNREFUSED, ENOTFOUND, ETIMEDOUT, ERR_INVALID_URL ...
      if (anyInput.code === 'ERR_INVALID_URL') return 'invalid_url';
      if (/^(E|ERR_)/.test(anyInput.code)) return 'unreachable';
    }
    const msg = String(anyInput.message || '');
    if (/invalid url/i.test(msg)) return 'invalid_url';
    if (/fetch failed|network|ECONN|ENOTFOUND|ETIMEDOUT|abort|timeout/i.test(msg)) return 'unreachable';
  }
  return 'http_error';
}

/**
 * @param {{ baseUrl: string, apiKey?: string, fetchImpl?: typeof fetch, timeoutMs?: number }} opts
 */
function createAiClient(opts) {
  const options = opts || {};
  const baseUrl = normalizeBaseUrl(options.baseUrl);
  const apiKey = options.apiKey && String(options.apiKey).trim() ? String(options.apiKey).trim() : 'local';
  const fetchImpl = options.fetchImpl || (typeof fetch === 'function' ? fetch : null);
  const baseTimeout = typeof options.timeoutMs === 'number' && options.timeoutMs > 0 ? options.timeoutMs : null;

  /**
   * @param {string} pathname
   * @param {RequestInit} init
   * @param {number} timeoutMs
   */
  async function request(pathname, init, timeoutMs) {
    if (!isHttpUrl(baseUrl)) {
      throw makeError('invalid_url', 'AI server URL is invalid');
    }
    if (typeof fetchImpl !== 'function') {
      throw makeError('unreachable', 'AI server request failed: fetch unavailable');
    }
    const url = `${baseUrl}${pathname}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), baseTimeout || timeoutMs);
    let response;
    try {
      response = await fetchImpl(url, {
        ...init,
        signal: controller.signal,
        headers: {
          Authorization: `Bearer ${apiKey}`,
          'Content-Type': 'application/json',
          ...(init && init.headers ? init.headers : {}),
        },
      });
    } catch (err) {
      const code = classifyError(err);
      const message =
        code === 'unreachable'
          ? 'AI server is unreachable'
          : code === 'invalid_url'
            ? 'AI server URL is invalid'
            : `AI server request failed: ${safeErrorMessage(err)}`;
      throw makeError(code, message);
    } finally {
      clearTimeout(timer);
    }
    if (!response || !response.ok) {
      const status = response && typeof response.status === 'number' ? response.status : 0;
      throw makeError(codeForStatus(status), `AI server HTTP ${status}`, status);
    }
    try {
      return await response.json();
    } catch {
      throw makeError('http_error', 'AI server returned an invalid response');
    }
  }

  async function listModels() {
    const body = await request('/models', { method: 'GET' }, DEFAULT_LIST_TIMEOUT_MS);
    const data = Array.isArray(body && body.data) ? body.data : Array.isArray(body) ? body : [];
    return data
      .map((row) => ({ id: row && row.id ? String(row.id) : '' }))
      .filter((row) => row.id);
  }

  /**
   * @param {{ model: string, messages: Array<{ role: string, content: string }>, temperature?: number }} params
   */
  async function chat({ model, messages, temperature } = /** @type {any} */ ({})) {
    if (!model) {
      throw makeError('no_models', 'No model selected');
    }
    const body = await request(
      '/chat/completions',
      {
        method: 'POST',
        body: JSON.stringify({
          model,
          messages: Array.isArray(messages) ? messages : [],
          temperature: temperature ?? 0.7,
          stream: false,
        }),
      },
      DEFAULT_CHAT_TIMEOUT_MS,
    );
    const content =
      body &&
      body.choices &&
      body.choices[0] &&
      body.choices[0].message &&
      body.choices[0].message.content
        ? String(body.choices[0].message.content)
        : '';
    return {
      content: stripReasoning(content),
      model: body && body.model ? String(body.model) : model,
    };
  }

  return { listModels, chat };
}

/**
 * Remove chain-of-thought blocks that "thinking" models (Qwen3, DeepSeek-R1,
 * etc.) embed in the reply text, e.g. `<think>...</think>answer`.
 * Handles closed blocks, a reply that begins mid-thought and only has the
 * closing tag, and an unterminated `<think>` (truncated reply).
 * @param {string} text
 * @returns {string}
 */
function stripReasoning(text) {
  let out = String(text || '');
  if (!/<\/?think(?:ing)?>/i.test(out)) return out;
  // Closed blocks (possibly several).
  out = out.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '');
  // Opening tag was dropped by the server: keep only what follows the last close.
  const lastClose = out.search(/<\/think(?:ing)?>(?![\s\S]*<\/think(?:ing)?>)/i);
  if (lastClose !== -1) {
    out = out.slice(lastClose).replace(/^<\/think(?:ing)?>/i, '');
  }
  // Unterminated block: reply was cut off while still thinking.
  out = out.replace(/<think(?:ing)?>[\s\S]*$/i, '');
  return out.trim();
}

module.exports = {
  createAiClient,
  stripReasoning,
  normalizeBaseUrl,
  safeErrorMessage,
  classifyError,
  isHttpUrl,
  ERROR_CODES,
  DEFAULT_LIST_TIMEOUT_MS,
  DEFAULT_CHAT_TIMEOUT_MS,
};
