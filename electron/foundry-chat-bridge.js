'use strict';

const { mudToFoundryHtml } = require('./mud-color');

const FOUNDRY_MUD_PREFIX = '[MUD] ';
const HISTORY_WINDOW_MS = 12 * 60 * 60 * 1000;
const KIND_SET = new Set(['ic', 'ooc', 'emote', 'whisper', 'roll', 'other']);

/**
 * @param {string} text
 * @returns {boolean}
 */
function isNarratorEcho(text) {
  return String(text || '').includes('[MUD]');
}

/**
 * Play-by-play should not render idle/filler output.
 * @param {string} text
 * @returns {boolean}
 */
function isSilenceMud(text) {
  const t = String(text || '')
    .replace(/\{[xXnN]\}/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  if (!t) {
    return true;
  }
  return /^SILENCE$/i.test(t);
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function wantsFoundryPost(text) {
  const t = String(text || '').toLowerCase();
  if (/\b(send|post|put)\b/.test(t) && /\b(foundry|game chat|the chat|vtt)\b/.test(t)) {
    return true;
  }
  if (/\bto the (game )?chat\b/.test(t)) {
    return true;
  }
  return false;
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isSendOnlyCommand(text) {
  const t = String(text || '')
    .trim()
    .toLowerCase()
    .replace(/[.!?]+$/g, '')
    .trim();
  return (
    /^(please\s+)?(send|post)(\s+(it|that|this|them))?(\s+to(\s+the)?(\s+game)?(\s+foundry)?\s*chat)?$/.test(
      t,
    ) || t === 'send to the game chat'
  );
}

/**
 * @param {string} line
 * @returns {boolean}
 */
function isMetaChatLine(line) {
  const t = String(line || '').trim();
  if (!t) {
    return true;
  }
  if (/\?$/.test(t)) {
    return true;
  }
  if (
    /^(i can'?t|i cannot|i don'?t|paste this|here'?s a |yes[—–-]|if you (paste|keep)|from here|need anything|let me know|i only know)/i.test(
      t,
    )
  ) {
    return true;
  }
  return false;
}

/**
 * Public Foundry chat gets the requested lines only — no thinking, questions,
 * or "paste this" instructions.
 * @param {string} text
 * @returns {string}
 */
function stripForPublicChat(text) {
  const lines = String(text || '')
    .replace(/\r\n/g, '\n')
    .split('\n');
  const kept = [];
  for (const line of lines) {
    if (isMetaChatLine(line)) {
      continue;
    }
    kept.push(line);
  }
  return kept.join('\n').trim();
}

/**
 * @param {string} className
 * @returns {'ic'|'ooc'|'emote'|'whisper'|'roll'|'other'}
 */
function kindFromClassName(className) {
  const c = String(className || '').toLowerCase();
  if (c.includes('whisper')) {
    return 'whisper';
  }
  if (c.includes('emote')) {
    return 'emote';
  }
  if (c.includes('ooc')) {
    return 'ooc';
  }
  if (c.includes('roll') || c.includes('dice')) {
    return 'roll';
  }
  if (c.includes('ic')) {
    return 'ic';
  }
  return 'other';
}

/**
 * @param {{ speaker?: string, text?: string, className?: string, kind?: string }} raw
 * @returns {{ speaker: string, text: string, kind: string } | null}
 */
function sanitizeChatLine(raw) {
  const speaker = String(raw && raw.speaker ? raw.speaker : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const text = String(raw && raw.text ? raw.text : '')
    .replace(/\0/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 2000);
  if (!text) {
    return null;
  }
  if (isNarratorEcho(text)) {
    return null;
  }
  const explicit = raw && raw.kind ? String(raw.kind).toLowerCase() : '';
  return {
    speaker,
    text,
    kind: KIND_SET.has(explicit) ? explicit : kindFromClassName(raw && raw.className),
  };
}

/**
 * @param {{ speaker?: string, text?: string, kind?: string }} line
 * @returns {string}
 */
function fallbackMudLine(line) {
  const speaker = String(line && line.speaker ? line.speaker : 'Someone').slice(0, 80);
  const kind = String(line && line.kind ? line.kind : 'other').toUpperCase();
  const text = String(line && line.text ? line.text : '');
  return `{D[{x{Y${kind}{x{D]{x {W${speaker}{x {w${text}{x`;
}

/**
 * @param {Array<{ id?: string, timestamp?: number }>} messages
 * @param {number} nowMs
 * @param {number} [windowMs]
 */
function filterMessagesSince(messages, nowMs, windowMs) {
  const window = windowMs == null ? HISTORY_WINDOW_MS : windowMs;
  const since = nowMs - window;
  return (messages || [])
    .filter((m) => {
      const ts = Number(m && m.timestamp);
      return Number.isFinite(ts) && ts >= since && ts <= nowMs;
    })
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

/**
 * @param {{ lastTimestamp?: number, lastId?: string } | null} cursor
 * @returns {{ lastTimestamp: number, lastId: string }}
 */
function normalizeCursor(cursor) {
  return {
    lastTimestamp: Number(cursor && cursor.lastTimestamp) || 0,
    lastId: String(cursor && cursor.lastId ? cursor.lastId : ''),
  };
}

/**
 * Keep messages strictly after the last processed Foundry timestamp.
 * @param {Array<{ id?: string, timestamp?: number }>} messages
 * @param {{ lastTimestamp?: number, lastId?: string } | null} cursor
 */
function messagesAfterCursor(messages, cursor) {
  const { lastTimestamp, lastId } = normalizeCursor(cursor);
  return (messages || [])
    .filter((m) => {
      const ts = Number(m && m.timestamp) || 0;
      if (ts > lastTimestamp) {
        return true;
      }
      if (ts < lastTimestamp) {
        return false;
      }
      const id = String(m && m.id ? m.id : '');
      return Boolean(id) && id !== lastId;
    })
    .sort((a, b) => Number(a.timestamp) - Number(b.timestamp));
}

/**
 * @param {{ lastTimestamp?: number, lastId?: string } | null} cursor
 * @param {{ timestamp?: number, id?: string } | null} msg
 */
function nextCursor(cursor, msg) {
  const current = normalizeCursor(cursor);
  const ts = Number(msg && msg.timestamp) || 0;
  const id = String(msg && msg.id ? msg.id : '');
  if (ts > current.lastTimestamp) {
    return { lastTimestamp: ts, lastId: id };
  }
  if (ts === current.lastTimestamp && id) {
    return { lastTimestamp: ts, lastId: id };
  }
  return current;
}

/**
 * @param {{ lastTimestamp?: number, lastId?: string } | null} cursor
 * @returns {string}
 */
function buildCaptureSource(cursor) {
  const ts = Number(cursor && cursor.lastTimestamp) || 0;
  const safe = Number.isFinite(ts) && ts > 0 ? Math.floor(ts) : 0;
  return FOUNDRY_CAPTURE_SOURCE.replace('__FLC_AFTER_TS__', String(safe));
}

/**
 * Foundry canvas Y grows south.
 * @param {{ name?: string, dx?: number, dy?: number }} move
 * @returns {string | null}
 */
function describeTokenMove(move) {
  const dx = Number(move && move.dx) || 0;
  const dy = Number(move && move.dy) || 0;
  if (dx === 0 && dy === 0) {
    return null;
  }
  const ns = dy < 0 ? 'north' : dy > 0 ? 'south' : '';
  const ew = dx > 0 ? 'east' : dx < 0 ? 'west' : '';
  const dir = `${ns}${ew}`;
  if (!dir) {
    return null;
  }
  const name = String(move && move.name ? move.name : 'Someone')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80) || 'Someone';
  return `{g${name} leaves ${dir}.{x`;
}

const FOUNDRY_CAPTURE_SOURCE = `(function() {
  var VERSION = 4;
  var AFTER_TS = __FLC_AFTER_TS__;
  if (window.__flcMudCapture === VERSION) return;
  window.__flcMudCapture = VERSION;
  if (!window.__flcMudSeen) window.__flcMudSeen = {};

  function sendLine(payload) {
    if (!window.flcGame || typeof window.flcGame.chatLine !== 'function') return;
    window.flcGame.chatLine(payload);
  }

  function sendStatus(payload) {
    if (!window.flcGame || typeof window.flcGame.captureStatus !== 'function') return;
    window.flcGame.captureStatus(payload);
  }

  function htmlToText(html) {
    if (!html) return '';
    var d = document.createElement('div');
    d.innerHTML = String(html);
    return (d.textContent || '').replace(/\\s+/g, ' ').trim();
  }

  function kindFromDoc(m) {
    try {
      if (m.whisper && m.whisper.length) return 'whisper';
      if (m.isRoll || (m.rolls && m.rolls.length)) return 'roll';
      var STYLES = (typeof CONST !== 'undefined' && CONST.CHAT_MESSAGE_STYLES) ? CONST.CHAT_MESSAGE_STYLES : {};
      var TYPES = (typeof CONST !== 'undefined' && CONST.CHAT_MESSAGE_TYPES) ? CONST.CHAT_MESSAGE_TYPES : {};
      var style = m.style;
      var type = m.type;
      if (style === STYLES.WHISPER || type === TYPES.WHISPER) return 'whisper';
      if (style === STYLES.EMOTE || type === TYPES.EMOTE) return 'emote';
      if (style === STYLES.OOC || type === TYPES.OOC) return 'ooc';
      if (style === STYLES.IC || type === TYPES.IC) return 'ic';
      var cls = String(m.flags && m.core && m.flags.core || '');
      if (String(cls).toLowerCase().indexOf('roll') >= 0) return 'roll';
    } catch (e) {}
    return 'other';
  }

  function payloadFromMessage(m, extra) {
    var speaker = '';
    try {
      speaker = (m.speaker && (m.speaker.alias || m.speaker.actor)) || '';
    } catch (e1) {}
    var flavor = '';
    var content = '';
    try { flavor = m.flavor || ''; } catch (e2) {}
    try { content = m.content || ''; } catch (e3) {}
    var text = htmlToText((flavor ? flavor + ' ' : '') + content);
    var payload = {
      id: m && m.id ? String(m.id) : '',
      speaker: speaker,
      text: text,
      kind: kindFromDoc(m),
      timestamp: m && m.timestamp ? m.timestamp : 0
    };
    if (extra) {
      for (var k in extra) {
        if (Object.prototype.hasOwnProperty.call(extra, k)) payload[k] = extra[k];
      }
    }
    return payload;
  }

  function emit(payload) {
    var id = payload && payload.id ? String(payload.id) : '';
    var text = payload && payload.text ? String(payload.text) : '';
    if (!text) return;
    if (id && window.__flcMudSeen[id] === text) return;
    if (id) window.__flcMudSeen[id] = text;
    sendLine(payload);
  }

  function dumpHistory() {
    if (!window.game || !game.messages) return 0;
    var list = [];
    game.messages.forEach(function(m) { list.push(m); });
    list.sort(function(a, b) { return Number(a.timestamp || 0) - Number(b.timestamp || 0); });
    var n = 0;
    for (var i = 0; i < list.length; i++) {
      var ts = Number(list[i].timestamp || 0);
      if (ts && ts <= AFTER_TS) continue;
      emit(payloadFromMessage(list[i], { historical: true }));
      n += 1;
    }
    return n;
  }

  function armHooks() {
    if (window.__flcMudHooks) return true;
    if (!window.Hooks) return false;
    window.__flcMudHooks = true;
    function onReady() {
      var n = dumpHistory();
      sendStatus({ hooked: true, path: 'hooks', historical: n });
      Hooks.on('createChatMessage', function(m) {
        emit(payloadFromMessage(m));
      });
      Hooks.on('updateChatMessage', function(m) {
        emit(payloadFromMessage(m));
      });
      var moveTimers = {};
      Hooks.on('preUpdateToken', function(doc, change) {
        if (!change || (change.x === undefined && change.y === undefined)) return;
        var grid = 100;
        try {
          if (canvas && canvas.grid && canvas.grid.size) grid = canvas.grid.size;
        } catch (e) {}
        var ox = doc.x;
        var oy = doc.y;
        var nx = change.x !== undefined ? change.x : ox;
        var ny = change.y !== undefined ? change.y : oy;
        var dx = Math.round((nx - ox) / grid);
        var dy = Math.round((ny - oy) / grid);
        if (!dx && !dy) return;
        var name = (doc.name) || (doc.actor && doc.actor.name) || 'Someone';
        var id = doc.id;
        if (moveTimers[id]) clearTimeout(moveTimers[id]);
        moveTimers[id] = setTimeout(function() {
          if (window.flcGame && typeof window.flcGame.tokenMove === 'function') {
            window.flcGame.tokenMove({ name: name, dx: dx, dy: dy });
          }
        }, 250);
      });
    }
    if (window.game && game.ready) onReady();
    else Hooks.once('ready', onReady);
    return true;
  }

  function lineFromNode(node) {
    if (!node || !node.querySelector) return;
    var senderEl = node.querySelector('.message-sender, .message-header .name, h4.name');
    var contentEl = node.querySelector('.message-content');
    var text = ((contentEl && contentEl.textContent) || node.textContent || '').replace(/\\s+/g, ' ').trim();
    var speaker = ((senderEl && senderEl.textContent) || '').replace(/\\s+/g, ' ').trim();
    var className = String(node.className || '');
    var id = (node.getAttribute && node.getAttribute('data-message-id')) || '';
    emit({ id: id, speaker: speaker, text: text, className: className, kind: className });
  }

  function observeLog(log) {
    if (!log || log.__flcMudObs) return;
    log.__flcMudObs = true;
    var obs = new MutationObserver(function(muts) {
      for (var i = 0; i < muts.length; i++) {
        var mut = muts[i];
        var nodes = mut.addedNodes;
        for (var j = 0; j < nodes.length; j++) {
          var n = nodes[j];
          if (!n || n.nodeType !== 1) continue;
          if (n.classList && n.classList.contains('chat-message')) lineFromNode(n);
          else if (n.querySelectorAll) {
            var inner = n.querySelectorAll('.chat-message');
            for (var k = 0; k < inner.length; k++) lineFromNode(inner[k]);
          }
        }
        var t = mut.target;
        if (t && t.nodeType === 1) {
          var msg = t.closest ? t.closest('.chat-message') : null;
          if (msg) lineFromNode(msg);
        }
      }
    });
    obs.observe(log, { childList: true, subtree: true, characterData: true });
  }

  function findLogs() {
    var found = [];
    var seen = {};
    function add(el) {
      if (!el || seen[el]) return;
      seen[el] = true;
      found.push(el);
    }
    add(document.querySelector('#chat-log'));
    add(document.querySelector('#chat-notifications'));
    var extras = document.querySelectorAll('ol.chat-log, .chat-log');
    for (var i = 0; i < extras.length; i++) add(extras[i]);
    return found;
  }

  function armDom() {
    var logs = findLogs();
    for (var i = 0; i < logs.length; i++) observeLog(logs[i]);
    return logs.length > 0;
  }

  function waitForFoundry() {
    if (armHooks()) return;
    var t = setInterval(function() {
      if (armHooks()) clearInterval(t);
    }, 500);
  }

  waitForFoundry();
  armDom();
  if (!window.__flcMudBoot) {
    window.__flcMudBoot = true;
    new MutationObserver(function() { armDom(); }).observe(document.documentElement, { childList: true, subtree: true });
  }
})();`;

const CHAT_OBSERVER_SOURCE = FOUNDRY_CAPTURE_SOURCE;

const FOUNDRY_POST_SOURCE = `(function(payload) {
  var content = String(payload && payload.content || '');
  var speakAs = payload && payload.speakAs === 'token' ? 'token'
    : payload && payload.speakAs === 'alias' ? 'alias' : 'ooc';
  var alias = String(payload && payload.alias || '').slice(0, 80);
  if (!content) return { ok: false, reason: 'empty' };
  try {
    if (typeof ChatMessage !== 'undefined' && typeof ChatMessage.create === 'function'
        && typeof ChatMessage.getSpeaker === 'function') {
      var speakerOpts = {};
      if (speakAs === 'alias' && alias) speakerOpts.alias = alias;
      var speaker = ChatMessage.getSpeaker(speakerOpts);
      var data = { content: content, speaker: speaker };
      var STYLES = (typeof CONST !== 'undefined' && CONST.CHAT_MESSAGE_STYLES) ? CONST.CHAT_MESSAGE_STYLES : null;
      var TYPES = (typeof CONST !== 'undefined' && CONST.CHAT_MESSAGE_TYPES) ? CONST.CHAT_MESSAGE_TYPES : null;
      if (speakAs === 'token' || speakAs === 'ic') {
        if (STYLES && STYLES.IC !== undefined) data.style = STYLES.IC;
        else if (TYPES && TYPES.IC !== undefined) data.type = TYPES.IC;
      } else {
        if (STYLES && STYLES.OOC !== undefined) data.style = STYLES.OOC;
        else if (TYPES && TYPES.OOC !== undefined) data.type = TYPES.OOC;
      }
      return Promise.resolve(ChatMessage.create(data)).then(function() {
        return { ok: true, path: 'create' };
      }).catch(function() { return { ok: false, reason: 'create' }; });
    }
    if (window.ui && ui.chat && typeof ui.chat.processMessage === 'function') {
      var cmd = speakAs === 'token' ? '/ic ' : '/ooc ';
      ui.chat.processMessage(cmd + content);
      return { ok: true, path: 'processMessage' };
    }
  } catch (e) {
    return { ok: false, reason: 'processMessage' };
  }
  return { ok: false, reason: 'no-chat' };
})`;

/**
 * Client-side Foundry chat payload. Never includes another user's id.
 * Foundry still binds the message to the logged-in user.
 * @param {string} rom
 * @param {{ speakAs?: string, alias?: string }} settings
 */
function buildFoundryPostPayload(rom, settings) {
  const speakAs =
    settings && (settings.speakAs === 'token' || settings.speakAs === 'alias')
      ? settings.speakAs
      : 'ooc';
  const body = stripForPublicChat(rom);
  return {
    content: `[MUD] ${mudToFoundryHtml(body)}`,
    speakAs,
    alias: String(settings && settings.alias ? settings.alias : '')
      .replace(/[<>\n\r]/g, '')
      .slice(0, 80),
  };
}

module.exports = {
  CHAT_OBSERVER_SOURCE,
  FOUNDRY_CAPTURE_SOURCE,
  FOUNDRY_MUD_PREFIX,
  FOUNDRY_POST_SOURCE,
  HISTORY_WINDOW_MS,
  buildCaptureSource,
  buildFoundryPostPayload,
  describeTokenMove,
  fallbackMudLine,
  filterMessagesSince,
  isNarratorEcho,
  isSendOnlyCommand,
  isSilenceMud,
  kindFromClassName,
  sanitizeChatLine,
  stripForPublicChat,
  wantsFoundryPost,
};
