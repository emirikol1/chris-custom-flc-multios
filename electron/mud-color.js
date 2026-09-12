'use strict';

const RAINBOW_CYCLE = ['R', 'Y', 'G', 'C', 'B', 'M', 'W'];

const RESET_CODES = new Set(['x', 'X', 'n', 'N']);
const COLOR_CODES = new Set([
  'r',
  'R',
  'g',
  'G',
  'y',
  'Y',
  'b',
  'B',
  'm',
  'M',
  'c',
  'C',
  'w',
  'W',
  'd',
  'D',
]);

const ANSI_BY_CODE = {
  r: '\x1b[31m',
  R: '\x1b[1;31m',
  g: '\x1b[32m',
  G: '\x1b[1;32m',
  y: '\x1b[33m',
  Y: '\x1b[1;33m',
  b: '\x1b[34m',
  B: '\x1b[1;34m',
  m: '\x1b[35m',
  M: '\x1b[1;35m',
  c: '\x1b[36m',
  C: '\x1b[1;36m',
  w: '\x1b[37m',
  W: '\x1b[1;37m',
  d: '\x1b[2m',
  D: '\x1b[2m',
  x: '\x1b[0m',
  X: '\x1b[0m',
  n: '\x1b[0m',
  N: '\x1b[0m',
};

const VERB_COLORS = [
  { re: /\b(misses|miss)\b/gi, color: 'w' },
  { re: /\b(scratches|scratch)\b/gi, color: 'w' },
  { re: /\b(grazes|graze)\b/gi, color: 'w' },
  { re: /\b(hits|hit)(?! points)\b/gi, color: 'W' },
  { re: /\b(injures|injure)\b/gi, color: 'y' },
  { re: /\b(wounds|wound)\b/gi, color: 'Y' },
  { re: /\b(mauls|maul)\b/gi, color: 'y' },
  { re: /\b(maims|maim)\b/gi, color: 'Y' },
  { re: /\b(decimates|decimate)\b/gi, color: 'R' },
  { re: /\b(devastates|devastate)\b/gi, color: 'R' },
  { re: /\b(MUTILATES|MUTILATE)\b/g, color: 'M' },
  { re: /\b(DISEMBOWELS|DISEMBOWEL)\b/g, color: 'C' },
  { re: /\b(DISMEMBERS|DISMEMBER)\b/g, color: 'B' },
  { re: /\b(MANGLES|MANGLE)\b/g, color: 'R' },
  { re: /\b(DEMOLISH)\b/g, color: 'R' },
  { re: /\b(OBLITERATE)\b/g, color: 'Y' },
  { re: /\b(ANNIHILATE)\b/g, color: 'C' },
  { re: /\b(ERADICATE)\b/g, color: 'M' },
  { re: /\b(UNSPEAKABLE)\b/g, color: 'R' },
];

const RAINBOW_RE = /\b(MASSACRES|MASSACRED|MASSACRING|MASSACRE)\b/gi;

/**
 * Stock ROM 2.4b6 fight.c dam_message: (100 * dam) / victim->max_hit.
 * When max HP is unknown, max is 100 so the damage number is the percent.
 */
const ROM_DAMAGE_LADDER = [
  { maxPercent: 5, vs: 'scratch', vp: 'scratches' },
  { maxPercent: 10, vs: 'graze', vp: 'grazes' },
  { maxPercent: 15, vs: 'hit', vp: 'hits' },
  { maxPercent: 20, vs: 'injure', vp: 'injures' },
  { maxPercent: 25, vs: 'wound', vp: 'wounds' },
  { maxPercent: 30, vs: 'maul', vp: 'mauls' },
  { maxPercent: 35, vs: 'decimate', vp: 'decimates' },
  { maxPercent: 40, vs: 'devastate', vp: 'devastates' },
  { maxPercent: 45, vs: 'maim', vp: 'maims' },
  { maxPercent: 50, vs: 'MUTILATE', vp: 'MUTILATES' },
  { maxPercent: 55, vs: 'DISEMBOWEL', vp: 'DISEMBOWELS' },
  { maxPercent: 60, vs: 'DISMEMBER', vp: 'DISMEMBERS' },
  { maxPercent: 65, vs: 'MASSACRE', vp: 'MASSACRES' },
  { maxPercent: 70, vs: 'MANGLE', vp: 'MANGLES' },
  { maxPercent: 75, vs: '*** DEMOLISH ***', vp: '*** DEMOLISHES ***' },
  { maxPercent: 80, vs: '*** DEVASTATE ***', vp: '*** DEVASTATES ***' },
  { maxPercent: 85, vs: '=== OBLITERATE ===', vp: '=== OBLITERATES ===' },
  { maxPercent: 90, vs: '>>> ANNIHILATE <<<', vp: '>>> ANNIHILATES <<<' },
  { maxPercent: 95, vs: '<<< ERADICATE >>>', vp: '<<< ERADICATES >>>' },
  { maxPercent: Infinity, vs: 'do UNSPEAKABLE things to', vp: 'does UNSPEAKABLE things to' },
];

/**
 * @param {string} text
 * @returns {string}
 */
function rainbowize(text) {
  const chars = [...String(text)];
  let out = '';
  for (let i = 0; i < chars.length; i += 1) {
    out += `{${RAINBOW_CYCLE[i % RAINBOW_CYCLE.length]}${chars[i]}`;
  }
  return `${out}{x`;
}

/**
 * @param {number} dam
 * @param {number} [maxHit]
 * @returns {number}
 */
function romDamagePercent(dam, maxHit) {
  const damage = Math.max(0, Number(dam) || 0);
  if (damage === 0) {
    return 0;
  }
  const max = Number(maxHit);
  const denom = Number.isFinite(max) && max > 0 ? Math.floor(max) : 100;
  return Math.floor((100 * damage) / denom);
}

/**
 * @param {number} dam
 * @param {{ maxHit?: number }} [opts]
 * @returns {{ vs: string, vp: string, percent: number, punct: string }}
 */
function romDamageVerb(dam, opts) {
  const damage = Math.max(0, Number(dam) || 0);
  if (damage === 0) {
    return { vs: 'miss', vp: 'misses', percent: 0, punct: '.' };
  }
  const percent = romDamagePercent(damage, opts && opts.maxHit);
  const row = ROM_DAMAGE_LADDER.find((r) => percent <= r.maxPercent);
  return {
    vs: row.vs,
    vp: row.vp,
    percent,
    punct: percent <= 45 ? '.' : '!',
  };
}

/**
 * @returns {string}
 */
function formatRomDamageLadder() {
  const lines = [
    'ROM 2.4 dam_message (fight.c): verb from (100 * dam) / victim max HP.',
    'If max HP is unknown, max HP is 100 (the damage number is the percent).',
    '0          miss / misses',
  ];
  let prev = 1;
  for (const row of ROM_DAMAGE_LADDER) {
    const range = row.maxPercent === Infinity ? '96%+' : `${prev}-${row.maxPercent}%`;
    lines.push(`${range.padEnd(10, ' ')} ${row.vs} / ${row.vp}`);
    prev = row.maxPercent === Infinity ? prev : row.maxPercent + 1;
  }
  lines.push('Punctuation: period if percent <= 45, otherwise !');
  lines.push('MASSACRE is rainbow: {RM{YA{GS{CS{BA{MC{WR{RE{x');
  return lines.join('\n');
}

/**
 * @param {string} source
 * @param {number} offset
 * @returns {boolean}
 */
function alreadyCoded(source, offset) {
  if (offset >= 2 && source[offset - 2] === '{') {
    return true;
  }
  return false;
}

/**
 * Drop fake `{h` codes and failed rainbow prefixes (color codes with almost
 * no letters) so names like Saulina are not turned into "GA".
 * @param {string} text
 * @returns {string}
 */
function sanitizeRom(text) {
  let s = String(text);
  s = s.replace(/\{([^rRgGyYbBmMcCwWdDxXnN])/g, '');
  s = s.replace(/(?:\{[rRgGyYbBmMcCwWdD][^{]*){3,}\{x/g, (run) => {
    const colorCodes = run.match(/\{[rRgGyYbBmMcCwWdD]/g) || [];
    const letters = run.replace(/\{[rRgGyYbBmMcCwWdDxXnN]/g, '');
    const letterCount = letters.replace(/\s+/g, '').length;
    if (colorCodes.length >= 3 && letterCount < colorCodes.length / 2) {
      return '';
    }
    return run;
  });
  return s;
}

/**
 * @param {string} text
 * @returns {string}
 */
function emphasizeDamageVerbs(text) {
  let out = String(text);
  out = out.replace(RAINBOW_RE, (match, _g, offset) => {
    if (alreadyCoded(out, offset)) {
      return match;
    }
    return rainbowize(match);
  });
  for (const { re, color } of VERB_COLORS) {
    out = out.replace(re, (match, _g, offset) => {
      if (alreadyCoded(out, offset)) {
        return match;
      }
      return `{${color}${match}{x`;
    });
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string}
 */
function escapeHtml(text) {
  return String(text)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * @param {string} raw
 * @param {(code: string, chunk: string) => string} wrap
 * @returns {string}
 */
function mapRom(raw, wrap) {
  const emphasized = emphasizeDamageVerbs(sanitizeRom(raw));
  let out = '';
  let current = null;
  let i = 0;
  while (i < emphasized.length) {
    if (emphasized[i] === '{' && i + 1 < emphasized.length) {
      const code = emphasized[i + 1];
      if (RESET_CODES.has(code) || COLOR_CODES.has(code)) {
        if (current) {
          out += wrap(current, null);
          current = null;
        }
        if (COLOR_CODES.has(code)) {
          current = code;
        }
        i += 2;
        continue;
      }
    }
    const ch = emphasized[i];
    if (current) {
      out += wrap(current, ch);
    } else {
      out += wrap(null, ch);
    }
    i += 1;
  }
  if (current) {
    out += wrap(current, null);
  }
  return out;
}

/**
 * @param {string} text
 * @returns {string}
 */
function mudToHtml(text) {
  let open = null;
  let buf = '';
  const flushOpen = () => {
    if (open) {
      buf += '</span>';
      open = null;
    }
  };
  const emphasized = emphasizeDamageVerbs(sanitizeRom(text));
  let i = 0;
  while (i < emphasized.length) {
    if (emphasized[i] === '{' && i + 1 < emphasized.length) {
      const code = emphasized[i + 1];
      if (RESET_CODES.has(code) || COLOR_CODES.has(code)) {
        flushOpen();
        if (COLOR_CODES.has(code)) {
          buf += `<span class="mud mud-${code}">`;
          open = code;
        }
        i += 2;
        continue;
      }
    }
    buf += escapeHtml(emphasized[i]);
    i += 1;
  }
  flushOpen();
  return buf;
}

/**
 * @param {string} text
 * @returns {string}
 */
function mudToAnsi(text) {
  let buf = '';
  const emphasized = emphasizeDamageVerbs(sanitizeRom(text));
  let i = 0;
  while (i < emphasized.length) {
    if (emphasized[i] === '{' && i + 1 < emphasized.length) {
      const code = emphasized[i + 1];
      if (ANSI_BY_CODE[code]) {
        buf += ANSI_BY_CODE[code];
        i += 2;
        continue;
      }
    }
    buf += emphasized[i];
    i += 1;
  }
  if (!buf.endsWith('\x1b[0m')) {
    buf += '\x1b[0m';
  }
  return buf;
}

const FOUNDRY_HEX = {
  r: '#b22222',
  R: '#ff5555',
  g: '#228b22',
  G: '#55ff55',
  y: '#cccc00',
  Y: '#ffff55',
  b: '#2222b2',
  B: '#5555ff',
  m: '#b222b2',
  M: '#ff55ff',
  c: '#22b2b2',
  C: '#55ffff',
  w: '#bbbbbb',
  W: '#ffffff',
  d: '#666666',
  D: '#888888',
};

/**
 * @param {string} text
 * @returns {string}
 */
function stripRom(text) {
  return String(text).replace(/\{[A-Za-z]/g, '');
}

/**
 * HTML a player could paste into Foundry chat (inline color). Used with
 * `/ooc` via ui.chat.processMessage — the normal client chat path.
 * @param {string} text
 * @returns {string}
 */
function mudToFoundryHtml(text) {
  let buf = '';
  let open = null;
  const emphasized = emphasizeDamageVerbs(sanitizeRom(text));
  let i = 0;
  const close = () => {
    if (open) {
      buf += '</span>';
      open = null;
    }
  };
  while (i < emphasized.length) {
    if (emphasized[i] === '{' && i + 1 < emphasized.length) {
      const code = emphasized[i + 1];
      if (RESET_CODES.has(code) || COLOR_CODES.has(code)) {
        close();
        if (COLOR_CODES.has(code) && FOUNDRY_HEX[code]) {
          buf += `<span style="color:${FOUNDRY_HEX[code]}">`;
          open = code;
        }
        i += 2;
        continue;
      }
    }
    buf += escapeHtml(emphasized[i]);
    i += 1;
  }
  close();
  return buf.replace(/\n/g, '<br>');
}

/**
 * @param {string} rom
 * @returns {string}
 */
function mudToFoundryChat(rom) {
  return `/ooc [MUD] ${mudToFoundryHtml(rom)}`;
}

module.exports = {
  RAINBOW_CYCLE,
  emphasizeDamageVerbs,
  formatRomDamageLadder,
  mudToAnsi,
  mudToFoundryChat,
  mudToFoundryHtml,
  mudToHtml,
  rainbowize,
  romDamagePercent,
  romDamageVerb,
  sanitizeRom,
  stripRom,
};
