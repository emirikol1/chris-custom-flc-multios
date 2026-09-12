'use strict';

const { createAiClient } = require('./ai-client');
const { loadProvider } = require('./ai-provider');
const {
  isNarratorEcho,
  sanitizeChatLine,
  buildFoundryPostPayload,
  fallbackMudLine,
  wantsFoundryPost,
  isSendOnlyCommand,
  stripForPublicChat,
  isSilenceMud,
} = require('./foundry-chat-bridge');
const {
  appendMessage,
  loadSession,
  loadSettings,
  readPrompt,
  replaceSessionMessages,
  saveSettings,
} = require('./narrator-store');
const { buildLmMessages, compressHistory } = require('./narrator-context');
const { formatRomDamageLadder, romDamageVerb } = require('./mud-color');
const {
  applyCombatEvent,
  formatScoreboard,
  isResetCommand,
  loadScoreboard,
  parseCombatEvent,
  resetScoreboard,
  saveScoreboard,
} = require('./combat-stats');

/**
 * @param {object} opts
 */
function createNarratorService(opts) {
  const rootDir = opts.rootDir;
  const credsLoader = opts.credsLoader || loadProvider;
  const clientFactory = opts.clientFactory || createAiClient;
  const now = opts.now || (() => new Date().toISOString());
  const postToFoundry =
    opts.postToFoundry ||
    (async () => {
      /* local-only by default */
    });

  function recentCaptured(limit) {
    return loadSession(rootDir, 'commentary')
      .messages.filter((m) => m.role === 'assistant')
      .slice(-limit)
      .map((m) => m.content);
  }

  async function chatChannel(channel, userContent, opts) {
    const creds = credsLoader();
    if (!creds.ok) {
      return { ok: false, code: creds.code, message: creds.message, channel };
    }
    const system = `${readPrompt(rootDir, channel).trim()}\n\n${formatRomDamageLadder()}\n\n${formatScoreboard(loadScoreboard(rootDir))}`;
    const history = loadSession(rootDir, channel).messages.map((m) => ({
      role: m.role,
      content: m.content,
    }));
    const client = clientFactory({
      baseUrl: creds.baseUrl,
      apiKey: creds.apiKey,
    });
    const built = await buildLmMessages({
      system,
      history,
      userContent,
      compress: (older) =>
        compressHistory(older, (args) => client.chat({ model: creds.model, ...args })),
    });
    if (built.compressed) {
      const at = now();
      const persisted = [];
      if (built.summary) {
        persisted.push({
          role: 'assistant',
          content: `Earlier session (compressed):\n${built.summary}`,
          at,
        });
      }
      for (const m of built.latest) {
        persisted.push({
          role: m.role === 'assistant' ? 'assistant' : 'user',
          content: String(m.content || ''),
          at,
        });
      }
      replaceSessionMessages(rootDir, channel, persisted);
    }
    const result = await client.chat({ model: creds.model, messages: built.messages });
    const at = now();
    const storedUser = opts && opts.storeUser ? opts.storeUser : userContent;
    appendMessage(rootDir, channel, { role: 'user', content: storedUser, at });
    appendMessage(rootDir, channel, {
      role: 'assistant',
      content: result.content,
      at,
    });
    return { ok: true, channel, text: result.content, model: result.model };
  }

  function recordCombat(raw, sanitized) {
    const event = parseCombatEvent({
      speaker: sanitized.speaker,
      text: sanitized.text,
    });
    const board = loadScoreboard(rootDir);
    const ts = Number(raw && (raw.timestamp != null ? raw.timestamp : raw.ts)) || 0;
    const id = String((raw && (raw.id || raw.messageId)) || '');
    if (event) {
      const priorTs = Number(board.lastTimestamp) || 0;
      const alreadyCounted =
        Boolean(raw && raw.historical) && priorTs > 0 && ts > 0 && ts <= priorTs;
      if (!alreadyCounted) {
        applyCombatEvent(board, id, event);
      }
    }
    if (ts > (Number(board.lastTimestamp) || 0)) {
      board.lastTimestamp = ts;
      board.lastId = id;
    } else if (ts === (Number(board.lastTimestamp) || 0) && id) {
      board.lastId = id;
    }
    board.lastProcessedAt = now();
    saveScoreboard(rootDir, board);
  }

  function romVerbHint(sanitized) {
    const event = parseCombatEvent({
      speaker: sanitized.speaker,
      text: sanitized.text,
    });
    if (event && event.dealt > 0) {
      const v = romDamageVerb(event.dealt);
      return `\nROM 2.4 dam_message: ${event.dealt} damage → ${v.vp} (${v.percent}%). Use this verb.`;
    }
    if (/\bmiss(?:es)?\b/i.test(sanitized.text) && (!event || !event.dealt)) {
      return '\nROM 2.4 dam_message: 0 damage → misses.';
    }
    return '';
  }

  async function handleFoundryLine(raw) {
    const sanitized = sanitizeChatLine(raw);
    if (!sanitized) {
      return { ok: true, skipped: isNarratorEcho(raw && raw.text) ? 'echo' : 'empty' };
    }
    recordCombat(raw, sanitized);
    const capturedMud = fallbackMudLine(sanitized);
    if (raw && raw.historical) {
      return {
        ok: true,
        captured: true,
        historical: true,
        channel: 'commentary',
        mudText: capturedMud,
      };
    }
    const userContent = `Foundry ${sanitized.kind} [${sanitized.speaker}]: ${sanitized.text}${romVerbHint(sanitized)}`;
    let result;
    try {
      result = await chatChannel('commentary', userContent);
    } catch {
      return {
        ok: false,
        captured: true,
        mudText: capturedMud,
        code: 'lm-error',
        message: 'AI server error',
        channel: 'commentary',
      };
    }
    if (!result.ok) {
      return { ...result, captured: true, mudText: capturedMud };
    }
    if (isSilenceMud(result.text)) {
      return { ok: true, skipped: 'silence', captured: true, channel: 'commentary' };
    }
    const settings = loadSettings(rootDir);
    if (settings.postToFoundry) {
      await postToFoundry(buildFoundryPostPayload(result.text, settings));
    }
    return {
      ok: true,
      captured: true,
      channel: 'commentary',
      mudText: result.text,
      model: result.model,
    };
  }

  async function handleHistoryRecap(lines, onChunk) {
    const rawLines = lines || [];
    const sanitized = rawLines.map((raw) => sanitizeChatLine(raw)).filter(Boolean);
    if (sanitized.length === 0) {
      return { ok: true, skipped: 'empty', count: 0 };
    }
    for (const raw of rawLines) {
      const line = sanitizeChatLine(raw);
      if (line) {
        recordCombat(raw, line);
      }
    }
    const chunkSize = 20;
    const parts = [];
    for (let i = 0; i < sanitized.length; i += chunkSize) {
      const chunk = sanitized.slice(i, i + chunkSize);
      const userContent =
        `Rewrite these Foundry chat lines as MUD play-by-play, in order. One or a few MUD lines per event. Include every attack and roll. Do not invent. Do not paste the Foundry wording:\n` +
        chunk.map((l) => `${l.kind} [${l.speaker}]: ${l.text}`).join('\n');
      const result = await chatChannel('commentary', userContent);
      if (!result.ok) {
        return { ...result, captured: true, count: sanitized.length, mudText: parts.join('\n') };
      }
      if (!isSilenceMud(result.text)) {
        parts.push(result.text);
        if (typeof onChunk === 'function') {
          onChunk(result.text);
        }
      }
    }
    return {
      ok: true,
      channel: 'commentary',
      mudText: parts.join('\n'),
      model: undefined,
      count: sanitized.length,
    };
  }

  async function handleUserQuestion(text) {
    const question = String(text || '').trim();
    if (!question) {
      return { ok: false, code: 'empty', message: 'Empty question', channel: 'discussion' };
    }

    if (isResetCommand(question)) {
      const board = resetScoreboard(loadScoreboard(rootDir));
      saveScoreboard(rootDir, board);
      const at = now();
      const text = `{YScoreboard reset.{x\n${formatScoreboard(board)}`;
      appendMessage(rootDir, 'discussion', { role: 'user', content: question, at });
      appendMessage(rootDir, 'discussion', { role: 'assistant', content: text, at });
      return { ok: true, channel: 'discussion', reset: true, text };
    }

    async function postPublic(body) {
      const cleaned = stripForPublicChat(body);
      if (!cleaned) {
        return { ok: false, posted: false, message: 'Nothing to post' };
      }
      const posted = await postToFoundry(buildFoundryPostPayload(cleaned, loadSettings(rootDir)));
      const ok = !posted || posted.ok !== false;
      return { ok, posted: Boolean(ok) };
    }

    if (isSendOnlyCommand(question) || (wantsFoundryPost(question) && isSendOnlyCommand(question))) {
      const last = loadSession(rootDir, 'discussion')
        .messages.filter((m) => m.role === 'assistant')
        .slice(-1)[0];
      if (!last || !last.content) {
        return { ok: false, code: 'empty', message: 'Nothing to send yet', channel: 'discussion' };
      }
      const posted = await postPublic(last.content);
      return {
        ok: posted.ok,
        channel: 'discussion',
        posted: posted.posted,
        text: posted.ok ? 'Posted to Foundry chat.' : 'Foundry chat post failed.',
      };
    }

    const mudBits = recentCaptured(8);
    const lmUser =
      mudBits.length > 0
        ? `Recent MUD play-by-play (context only):\n${mudBits.join('\n')}\n\nUser question: ${question}`
        : question;
    const result = await chatChannel('discussion', lmUser, { storeUser: question });
    if (!result.ok) {
      return result;
    }
    if (wantsFoundryPost(question)) {
      const posted = await postPublic(result.text);
      const cleaned = stripForPublicChat(result.text);
      return {
        ...result,
        posted: posted.posted,
        text: posted.posted ? cleaned : result.text,
      };
    }
    return { ok: true, channel: 'discussion', text: result.text, model: result.model };
  }

  function setPostToFoundry(enabled) {
    return saveSettings(rootDir, { postToFoundry: Boolean(enabled) });
  }

  function setSettings(patch) {
    return saveSettings(rootDir, patch || {});
  }

  function getSettings() {
    return loadSettings(rootDir);
  }

  return {
    getSettings,
    handleFoundryLine,
    handleHistoryRecap,
    handleUserQuestion,
    setPostToFoundry,
    setSettings,
  };
}

module.exports = {
  createNarratorService,
};
