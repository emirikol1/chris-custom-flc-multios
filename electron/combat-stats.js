'use strict';

const fs = require('fs');
const path = require('path');

const EMPTY_ACTOR = () => ({ dealt: 0, taken: 0, healed: 0, crits: 0, nat1s: 0 });

function scoreboardPath(rootDir) {
  return path.join(rootDir, 'scoreboard.json');
}

function emptyScoreboard() {
  return {
    version: 1,
    lastTimestamp: 0,
    lastId: '',
    lastProcessedAt: '',
    actors: {},
    events: {},
  };
}

/**
 * @param {string} rootDir
 */
function loadScoreboard(rootDir) {
  fs.mkdirSync(rootDir, { recursive: true });
  const filePath = scoreboardPath(rootDir);
  if (!fs.existsSync(filePath)) {
    return emptyScoreboard();
  }
  try {
    const parsed = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    return {
      version: 1,
      lastTimestamp: Number(parsed.lastTimestamp) || 0,
      lastId: String(parsed.lastId || ''),
      lastProcessedAt: String(parsed.lastProcessedAt || ''),
      actors: parsed.actors && typeof parsed.actors === 'object' ? parsed.actors : {},
      events: parsed.events && typeof parsed.events === 'object' ? parsed.events : {},
    };
  } catch {
    return emptyScoreboard();
  }
}

/**
 * @param {string} rootDir
 * @param {ReturnType<typeof emptyScoreboard>} board
 */
function saveScoreboard(rootDir, board) {
  fs.mkdirSync(rootDir, { recursive: true });
  fs.writeFileSync(scoreboardPath(rootDir), `${JSON.stringify(board, null, 2)}\n`, {
    mode: 0o600,
  });
  return board;
}

/**
 * @param {string} text
 * @returns {string}
 */
function extractTarget(text) {
  const src = String(text || '');
  const m = src.match(/\bTargets\s+(.+?)(?=\s+Healing\b|\s+Damage\b|$)/i);
  if (!m) {
    return '';
  }
  let name = m[1]
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/\s+\d{1,3}$/, '');
  const words = name.split(' ');
  if (words.length >= 2 && words.length % 2 === 0) {
    const half = words.length / 2;
    const a = words.slice(0, half).join(' ');
    const b = words.slice(half).join(' ');
    if (a === b) {
      name = a;
    }
  }
  return name.slice(0, 80);
}

/**
 * @param {string} text
 * @param {string} keyword
 * @returns {number}
 */
function totalAfterDiceKeyword(text, keyword) {
  const re = new RegExp(
    `\\b${keyword}(?:\\s+${keyword})*\\s+(?:\\d+d\\d+(?:\\[[^\\]]+\\])?(?:\\s*[+-]\\s*\\d+)*\\s+)+(\\d+)`,
    'i',
  );
  const m = String(text).match(re);
  return m ? Number(m[1]) || 0 : 0;
}

/**
 * @param {string} text
 * @returns {number}
 */
function attackDieFace(text) {
  const m = String(text).match(
    /1d20(?:\[[^\]]*\])?(?:\s*[+-]\s*\d+)*\s+(?:(?:ADV|DIS|CRIT|Fumble|critical)[^0-9]*)*(\d{1,2})\b/i,
  );
  if (!m) {
    return 0;
  }
  const n = Number(m[1]);
  return n >= 1 && n <= 20 ? n : 0;
}

/**
 * @param {string} text
 * @returns {number}
 */
function countCrits(text) {
  const t = String(text || '');
  if (
    /\bnaturalCrit\b/i.test(t) ||
    /\bCRIT(?:ICAL)?(?:\s+HIT)?\s*:/i.test(t) ||
    /\bcritical hit\b/i.test(t)
  ) {
    return 1;
  }
  if (/\bAttack\b/i.test(t) && /1d20/i.test(t) && attackDieFace(t) === 20) {
    return 1;
  }
  return 0;
}

/**
 * @param {string} text
 * @returns {number}
 */
function countNat1s(text) {
  const t = String(text || '');
  if (/\bfumble\b/i.test(t) || /\bnatural(?:\s+|-)1\b/i.test(t) || /\bnat\s*1\b/i.test(t)) {
    return 1;
  }
  if (/\bAttack\b/i.test(t) && /1d20/i.test(t) && attackDieFace(t) === 1) {
    return 1;
  }
  return 0;
}

/**
 * @param {{ speaker?: string, text?: string, kind?: string }} line
 * @returns {{ speaker: string, target: string, dealt: number, taken: number, healed: number, crits: number, nat1s: number } | null}
 */
function parseCombatEvent(line) {
  const speaker = String(line && line.speaker ? line.speaker : '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 80);
  const text = String(line && line.text ? line.text : '');
  if (!text) {
    return null;
  }
  const arrow = text.match(/Damage\s*→\s*(\d+)\s+dealt/i);
  const healed =
    totalAfterDiceKeyword(text, 'Healing') ||
    (/\bHealing\b/i.test(text) ? Number((text.match(/\bHealing\s+(\d+)/i) || [])[1]) || 0 : 0);
  let dealt = 0;
  if (arrow) {
    dealt = Number(arrow[1]) || 0;
  } else {
    dealt = totalAfterDiceKeyword(text, 'Damage');
  }
  const crits = countCrits(text);
  const nat1s = countNat1s(text);
  if (!dealt && !healed && !crits && !nat1s) {
    return null;
  }
  const target = extractTarget(text) || (healed ? speaker : '');
  return {
    speaker,
    target,
    dealt,
    taken: dealt,
    healed,
    crits,
    nat1s,
  };
}

/**
 * @param {ReturnType<typeof emptyScoreboard>} board
 * @param {{ speaker: string, target: string, dealt: number, taken: number, healed: number }} event
 * @param {number} sign
 */
function applyActorDelta(board, event, sign) {
  if (!board.actors) {
    board.actors = {};
  }
  const bump = (name, field, amount) => {
    const who = String(name || '').trim();
    if (!who || !amount) {
      return;
    }
    if (!board.actors[who]) {
      board.actors[who] = EMPTY_ACTOR();
    }
    board.actors[who][field] = Math.max(0, (Number(board.actors[who][field]) || 0) + sign * amount);
  };
  bump(event.speaker, 'dealt', event.dealt);
  bump(event.target, 'taken', event.taken);
  bump(event.target || event.speaker, 'healed', event.healed);
  bump(event.speaker, 'crits', event.crits);
  bump(event.speaker, 'nat1s', event.nat1s);
}

/**
 * Replace per-message contribution so Foundry updates do not double-count.
 * @param {ReturnType<typeof emptyScoreboard>} board
 * @param {string} id
 * @param {{ speaker: string, target: string, dealt: number, taken: number, healed: number }} event
 */
function applyCombatEvent(board, id, event) {
  const key = String(id || '');
  if (key && board.events[key]) {
    applyActorDelta(board, board.events[key], -1);
  }
  applyActorDelta(board, event, 1);
  if (key) {
    board.events[key] = event;
  }
  return board;
}

/**
 * @param {Record<string, { dealt?: number, taken?: number, healed?: number }>} actors
 * @param {'dealt'|'taken'|'healed'} field
 */
function sumField(actors, field) {
  return Object.values(actors || '').reduce((n, row) => n + (Number(row && row[field]) || 0), 0);
}

/**
 * @param {ReturnType<typeof emptyScoreboard>} board
 * @returns {string}
 */
function formatScoreboard(board) {
  const actors = (board && board.actors) || {};
  const names = Object.keys(actors).sort((a, b) => a.localeCompare(b));
  const totalDealt = sumField(actors, 'dealt');
  const totalTaken = sumField(actors, 'taken');
  const totalHealed = sumField(actors, 'healed');
  const pct = (n, tot) => (tot > 0 ? ((100 * n) / tot).toFixed(1) : '0.0');
  const lines = [
    'SCOREBOARD (raw integers on disk; do not invent. Only /reset clears these numbers):',
    'Name | dealt | taken | healed | crits | nat1s | crit:nat1 | %dealt | %taken | %healed',
  ];
  for (const name of names) {
    const row = actors[name] || EMPTY_ACTOR();
    const dealt = Number(row.dealt) || 0;
    const taken = Number(row.taken) || 0;
    const healed = Number(row.healed) || 0;
    const crits = Number(row.crits) || 0;
    const nat1s = Number(row.nat1s) || 0;
    lines.push(
      `${name} | ${dealt} | ${taken} | ${healed} | ${crits} | ${nat1s} | ${crits}:${nat1s} | ${pct(dealt, totalDealt)} | ${pct(taken, totalTaken)} | ${pct(healed, totalHealed)}`,
    );
  }
  if (names.length === 0) {
    lines.push('(empty)');
  }
  if (board && board.lastProcessedAt) {
    lines.push(`Last processed at ${board.lastProcessedAt}`);
  }
  return lines.join('\n');
}

/**
 * @param {string} text
 * @returns {boolean}
 */
function isResetCommand(text) {
  return String(text || '').trim().toLowerCase() === '/reset';
}

/**
 * Zero dealt/taken/healed/crits/nat1s. Keep the Foundry watermark so old lines are not re-counted.
 * @param {ReturnType<typeof emptyScoreboard>} board
 */
function resetScoreboard(board) {
  const next = emptyScoreboard();
  next.lastTimestamp = Number(board && board.lastTimestamp) || 0;
  next.lastId = String((board && board.lastId) || '');
  next.lastProcessedAt = String((board && board.lastProcessedAt) || '');
  return next;
}

module.exports = {
  applyCombatEvent,
  emptyScoreboard,
  formatScoreboard,
  isResetCommand,
  loadScoreboard,
  parseCombatEvent,
  resetScoreboard,
  saveScoreboard,
  scoreboardPath,
  sumField,
};
