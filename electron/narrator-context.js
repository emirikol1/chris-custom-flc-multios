'use strict';

const CONTEXT_MAX_CHARS = 20000;
const KEEP_LATEST_CHARS = 8000;
const COMPRESS_CHUNK_CHARS = 12000;

const COMPRESS_SYSTEM =
  'You compress a Foundry VTT / MUD session log into a dense running summary. ' +
  'Keep character names, hits, misses, damage, deaths, heals, spells, and unresolved effects. ' +
  'Drop UI chrome, Plutonium notices, HP Updated noise, repeated welcomes, questions, and preambles. ' +
  'Output only the summary. No questions.';

/**
 * @param {Array<{ role?: string, content?: string }>} messages
 * @param {number} keepChars
 * @returns {{ older: Array<{ role?: string, content?: string }>, latest: Array<{ role?: string, content?: string }> }}
 */
function splitKeepLatest(messages, keepChars) {
  const list = Array.isArray(messages) ? messages.slice() : [];
  const latest = [];
  let used = 0;
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const size = String(list[i] && list[i].content ? list[i].content : '').length;
    if (latest.length > 0 && used + size > keepChars) {
      return { older: list.slice(0, i + 1), latest: latest.reverse() };
    }
    latest.push(list[i]);
    used += size;
  }
  return { older: [], latest: latest.reverse() };
}

/**
 * @param {Array<{ role?: string, content?: string }>} messages
 * @returns {string}
 */
function formatLog(messages) {
  return (messages || [])
    .map((m) => `${m.role || 'user'}: ${m.content || ''}`)
    .join('\n');
}

/**
 * Map-reduce compression of older turns using the same LM.
 * @param {Array<{ role?: string, content?: string }>} messages
 * @param {(args: { messages: Array<{ role: string, content: string }> }) => Promise<{ content: string }>} chat
 * @param {number} [chunkChars]
 * @returns {Promise<string>}
 */
async function compressHistory(messages, chat, chunkChars) {
  const limit = chunkChars || COMPRESS_CHUNK_CHARS;
  const list = Array.isArray(messages) ? messages : [];
  if (list.length === 0) {
    return '';
  }
  const total = formatLog(list);
  if (total.length > limit && list.length > 1) {
    const chunks = [];
    let bucket = [];
    let size = 0;
    for (const msg of list) {
      const piece = String(msg && msg.content ? msg.content : '').length;
      if (bucket.length > 0 && size + piece > limit) {
        chunks.push(bucket);
        bucket = [];
        size = 0;
      }
      bucket.push(msg);
      size += piece;
    }
    if (bucket.length > 0) {
      chunks.push(bucket);
    }
    const parts = [];
    for (const chunk of chunks) {
      parts.push(await compressHistory(chunk, chat, limit));
    }
    return compressHistory(
      [{ role: 'user', content: parts.filter(Boolean).join('\n') }],
      chat,
      limit,
    );
  }

  const result = await chat({
    messages: [
      { role: 'system', content: COMPRESS_SYSTEM },
      { role: 'user', content: `Compress this session log:\n${total}` },
    ],
  });
  return String(result && result.content ? result.content : '').trim();
}

/**
 * Always: system prompt first, latest chat kept, current user last.
 * When over budget: AI-compress older turns (normal rolling summary).
 * @param {object} opts
 * @returns {Promise<{ messages: Array<{ role: string, content: string }>, compressed: boolean, latest: Array, summary: string }>}
 */
async function buildLmMessages(opts) {
  const system = String(opts && opts.system ? opts.system : '');
  const history = Array.isArray(opts.history) ? opts.history : [];
  const userContent = String(opts && opts.userContent ? opts.userContent : '');
  const maxChars = opts && opts.maxChars != null ? opts.maxChars : CONTEXT_MAX_CHARS;
  const keepLatestChars =
    opts && opts.keepLatestChars != null ? opts.keepLatestChars : KEEP_LATEST_CHARS;
  const compress = opts && opts.compress;

  const systemMsg = { role: 'system', content: system };
  const userMsg = { role: 'user', content: userContent };
  const historyChars = history.reduce(
    (n, m) => n + String(m && m.content ? m.content : '').length,
    0,
  );

  if (system.length + historyChars + userContent.length <= maxChars) {
    return {
      messages: [
        systemMsg,
        ...history.map((m) => ({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content || ''),
        })),
        userMsg,
      ],
      compressed: false,
      latest: history,
      summary: '',
    };
  }

  const { older, latest } = splitKeepLatest(history, keepLatestChars);
  let summary = '';
  if (older.length > 0 && typeof compress === 'function') {
    summary = String((await compress(older)) || '').trim();
  }

  const messages = [systemMsg];
  if (summary) {
    messages.push({
      role: 'user',
      content: `Earlier session (compressed):\n${summary}`,
    });
    messages.push({
      role: 'assistant',
      content: 'Continuing from the compressed earlier session.',
    });
  }
  for (const m of latest) {
    messages.push({
      role: m.role === 'assistant' ? 'assistant' : 'user',
      content: String(m.content || ''),
    });
  }
  messages.push(userMsg);
  return { messages, compressed: Boolean(summary), latest, summary };
}

module.exports = {
  COMPRESS_SYSTEM,
  CONTEXT_MAX_CHARS,
  KEEP_LATEST_CHARS,
  buildLmMessages,
  compressHistory,
  splitKeepLatest,
};
