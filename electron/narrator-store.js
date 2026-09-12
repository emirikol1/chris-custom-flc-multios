'use strict';

const fs = require('fs');
const path = require('path');
const { stripReasoning } = require('./ai-client');

const SESSION_CAP = 80;
const PROMPT_FILES = {
  commentary: 'mud-play-by-play.md',
  discussion: 'user-discussion.md',
};
const BUNDLED_PROMPTS_DIR = path.join(__dirname, 'narrator-prompts');
const DEFAULT_SETTINGS = {
  postToFoundry: false,
  speakAs: 'ooc',
  alias: 'The MUD',
  localByline: 'The MUD',
};

/**
 * @param {string} rootDir
 */
function ensureNarratorLayout(rootDir) {
  const promptsDir = path.join(rootDir, 'prompts');
  const sessionsDir = path.join(rootDir, 'sessions');
  fs.mkdirSync(promptsDir, { recursive: true });
  fs.mkdirSync(sessionsDir, { recursive: true });
  for (const fileName of Object.values(PROMPT_FILES)) {
    const dest = path.join(promptsDir, fileName);
    if (fs.existsSync(dest)) {
      continue;
    }
    const bundled = path.join(BUNDLED_PROMPTS_DIR, fileName);
    if (fs.existsSync(bundled)) {
      fs.copyFileSync(bundled, dest);
    }
  }
}

/**
 * @param {string} rootDir
 * @param {'commentary'|'discussion'} channel
 * @returns {string}
 */
function readPrompt(rootDir, channel) {
  ensureNarratorLayout(rootDir);
  const fileName = PROMPT_FILES[channel];
  const filePath = path.join(rootDir, 'prompts', fileName);
  return fs.readFileSync(filePath, 'utf8');
}

/**
 * @param {string} rootDir
 * @param {'commentary'|'discussion'} channel
 */
function sessionPath(rootDir, channel) {
  return path.join(rootDir, 'sessions', `${channel}.json`);
}

/**
 * @param {string} rootDir
 * @param {'commentary'|'discussion'} channel
 * @returns {{ version: 1, messages: Array<{ role: string, content: string, at: string }> }}
 */
function loadSession(rootDir, channel) {
  ensureNarratorLayout(rootDir);
  const filePath = sessionPath(rootDir, channel);
  if (!fs.existsSync(filePath)) {
    return { version: 1, messages: [] };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const messages = (Array.isArray(parsed.messages) ? parsed.messages : []).map((m) =>
      // Sessions saved before reasoning stripping may contain <think> blocks.
      m && m.role === 'assistant' && typeof m.content === 'string'
        ? { ...m, content: stripReasoning(m.content) }
        : m,
    );
    return { version: 1, messages };
  } catch {
    return { version: 1, messages: [] };
  }
}

/**
 * @param {string} filePath
 * @param {{ version: 1, messages: Array<{ role: string, content: string, at: string }> }} session
 */
function saveSessionFile(filePath, session) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, `${JSON.stringify(session, null, 2)}\n`, {
    mode: 0o600,
  });
}

/**
 * Replace the stored transcript (used after AI compression).
 * @param {string} rootDir
 * @param {'commentary'|'discussion'} channel
 * @param {Array<{ role: string, content: string, at?: string }>} messages
 */
function replaceSessionMessages(rootDir, channel, messages) {
  ensureNarratorLayout(rootDir);
  const next = (messages || []).map((m) => ({
    role: m.role === 'assistant' ? 'assistant' : 'user',
    content: String(m.content || ''),
    at: m.at || new Date().toISOString(),
  }));
  while (next.length > SESSION_CAP) {
    next.shift();
  }
  saveSessionFile(sessionPath(rootDir, channel), { version: 1, messages: next });
  return { version: 1, messages: next };
}

/**
 * @param {string} rootDir
 * @param {'commentary'|'discussion'} channel
 * @param {{ role: string, content: string, at: string }} message
 */
function appendMessage(rootDir, channel, message) {
  const session = loadSession(rootDir, channel);
  session.messages.push({
    role: message.role,
    content: String(message.content),
    at: message.at,
  });
  while (session.messages.length > SESSION_CAP) {
    session.messages.shift();
  }
  saveSessionFile(sessionPath(rootDir, channel), session);
  return session;
}

/**
 * @param {string} rootDir
 */
function settingsPath(rootDir) {
  return path.join(rootDir, 'settings.json');
}

/**
 * @param {string} rootDir
 * @returns {{ postToFoundry: boolean, speakAs: 'ooc'|'token'|'alias', alias: string, localByline: string }}
 */
function loadSettings(rootDir) {
  ensureNarratorLayout(rootDir);
  const filePath = settingsPath(rootDir);
  if (!fs.existsSync(filePath)) {
    return { ...DEFAULT_SETTINGS };
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    const speakAs =
      parsed.speakAs === 'token' || parsed.speakAs === 'alias' ? parsed.speakAs : 'ooc';
    return {
      postToFoundry: Boolean(parsed.postToFoundry),
      speakAs,
      alias: String(parsed.alias || DEFAULT_SETTINGS.alias).slice(0, 80),
      localByline: String(parsed.localByline || DEFAULT_SETTINGS.localByline).slice(0, 80),
    };
  } catch {
    return { ...DEFAULT_SETTINGS };
  }
}

/**
 * @param {string} rootDir
 * @param {{ postToFoundry?: boolean, speakAs?: string, alias?: string, localByline?: string }} patch
 */
function saveSettings(rootDir, patch) {
  const current = loadSettings(rootDir);
  const speakAsRaw = patch.speakAs === undefined ? current.speakAs : patch.speakAs;
  const next = {
    postToFoundry:
      patch.postToFoundry === undefined
        ? current.postToFoundry
        : Boolean(patch.postToFoundry),
    speakAs: speakAsRaw === 'token' || speakAsRaw === 'alias' ? speakAsRaw : 'ooc',
    alias: String(patch.alias === undefined ? current.alias : patch.alias)
      .replace(/[<>\n\r]/g, '')
      .slice(0, 80),
    localByline: String(
      patch.localByline === undefined ? current.localByline : patch.localByline,
    )
      .replace(/[<>\n\r]/g, '')
      .slice(0, 80),
  };
  fs.writeFileSync(settingsPath(rootDir), `${JSON.stringify(next, null, 2)}\n`, {
    mode: 0o600,
  });
  return next;
}

module.exports = {
  DEFAULT_SETTINGS,
  PROMPT_FILES,
  SESSION_CAP,
  appendMessage,
  ensureNarratorLayout,
  loadSession,
  loadSettings,
  readPrompt,
  replaceSessionMessages,
  saveSettings,
};
