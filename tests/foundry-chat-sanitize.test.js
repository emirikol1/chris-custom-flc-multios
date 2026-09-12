import { describe, expect, it } from 'vitest';
import {
  CHAT_OBSERVER_SOURCE,
  FOUNDRY_CAPTURE_SOURCE,
  FOUNDRY_MUD_PREFIX,
  HISTORY_WINDOW_MS,
  buildCaptureSource,
  buildFoundryPostPayload,
  describeTokenMove,
  fallbackMudLine,
  filterMessagesSince,
  isNarratorEcho,
  sanitizeChatLine,
  stripForPublicChat,
  wantsFoundryPost,
  isSilenceMud,
} from '../electron/foundry-chat-bridge.js';

describe('isNarratorEcho', () => {
  it('detects the [MUD] prefix used when posting to Foundry', () => {
    expect(isNarratorEcho(`${FOUNDRY_MUD_PREFIX} You MASSACRE the orc!`)).toBe(
      true,
    );
    expect(isNarratorEcho('Grog hits the orc.')).toBe(false);
  });
});

describe('isSilenceMud', () => {
  it('treats SILENCE and empty ROM as no play-by-play', () => {
    expect(isSilenceMud('SILENCE')).toBe(true);
    expect(isSilenceMud('{x}')).toBe(true);
    expect(isSilenceMud('  {x}SILENCE{x}  ')).toBe(true);
    expect(isSilenceMud('{WGrog{x hits the orc.')).toBe(false);
  });
});

describe('sanitizeChatLine', () => {
  it('returns null for empty text', () => {
    expect(sanitizeChatLine({ speaker: 'A', text: '  ' })).toBeNull();
  });

  it('returns null for narrator echoes so they are not re-narrated', () => {
    expect(
      sanitizeChatLine({
        speaker: 'Chris',
        text: `${FOUNDRY_MUD_PREFIX} MASSACRE`,
        className: 'chat-message ic',
      }),
    ).toBeNull();
  });

  it('maps Foundry class names to kinds and keeps text as text', () => {
    const line = sanitizeChatLine({
      speaker: 'Grog',
      text: 'I <hit> the orc',
      className: 'chat-message ic',
    });
    expect(line).toEqual({
      speaker: 'Grog',
      text: 'I <hit> the orc',
      kind: 'ic',
    });
  });

  it('maps whisper, emote, ooc, and roll', () => {
    expect(sanitizeChatLine({ speaker: 'A', text: 'hi', className: 'whisper' }).kind).toBe(
      'whisper',
    );
    expect(sanitizeChatLine({ speaker: 'A', text: 'grins', className: 'emote' }).kind).toBe(
      'emote',
    );
    expect(sanitizeChatLine({ speaker: 'A', text: 'ooc', className: 'ooc' }).kind).toBe(
      'ooc',
    );
    expect(sanitizeChatLine({ speaker: 'A', text: '1d20', className: 'dice-roll' }).kind).toBe(
      'roll',
    );
  });

  it('uses an explicit kind when Foundry class names are missing', () => {
    const line = sanitizeChatLine({
      speaker: 'Grog',
      text: 'Longsword 18 vs AC 14 hits',
      kind: 'roll',
    });
    expect(line.kind).toBe('roll');
  });
});

describe('wantsFoundryPost', () => {
  it('detects a request to send the answer to Foundry chat', () => {
    expect(wantsFoundryPost('send to the game chat')).toBe(true);
    expect(wantsFoundryPost('total the damage one per line to the chat')).toBe(true);
    expect(wantsFoundryPost('What just happened?')).toBe(false);
  });
});

describe('stripForPublicChat', () => {
  it('keeps only the requested lines and drops thinking and questions', () => {
    const messy = [
      "I can't send messages directly to your Foundry game chat from here. Paste this into your game chat:",
      '',
      '- Rina Silverthorn dealt 45 damage.',
      '- Maple Blackridge dealt 34 damage.',
      '',
      'If you paste more rounds, I will update this list. Need anything else?',
    ].join('\n');
    const out = stripForPublicChat(messy);
    expect(out).toContain('Rina Silverthorn dealt 45 damage.');
    expect(out).toContain('Maple Blackridge dealt 34 damage.');
    expect(out).not.toContain('Paste this');
    expect(out).not.toContain("I can't");
    expect(out).not.toContain('Need anything');
    expect(out).not.toMatch(/\?/);
  });
});

describe('fallbackMudLine', () => {
  it('wraps a captured Foundry attack so play-by-play is never blank', () => {
    const mud = fallbackMudLine({
      speaker: 'Grog',
      text: 'Longsword 18 vs AC 14 hits for 12',
      kind: 'roll',
    });
    expect(mud).toContain('{WGrog{x');
    expect(mud).toContain('Longsword 18 vs AC 14 hits for 12');
    expect(mud).toContain('ROLL');
  });
});

describe('filterMessagesSince', () => {
  it('keeps Foundry messages from the last 12 hours only', () => {
    const now = Date.parse('2026-09-05T20:00:00.000Z');
    const kept = filterMessagesSince(
      [
        { id: 'old', timestamp: now - HISTORY_WINDOW_MS - 1000, text: 'yesterday' },
        { id: 'hit', timestamp: now - 60_000, text: 'attack' },
        { id: 'future', timestamp: now + 1000, text: 'nope' },
      ],
      now,
    );
    expect(kept.map((m) => m.id)).toEqual(['hit']);
  });
});

describe('describeTokenMove', () => {
  it('turns a grid delta into a MUD leave line (Foundry Y grows south)', () => {
    expect(describeTokenMove({ name: 'Grog', dx: 0, dy: -1 })).toBe(
      '{gGrog leaves north.{x',
    );
    expect(describeTokenMove({ name: 'Grog', dx: 1, dy: 1 })).toBe(
      '{gGrog leaves southeast.{x',
    );
    expect(describeTokenMove({ name: 'Grog', dx: 0, dy: 0 })).toBeNull();
  });
});

describe('FOUNDRY_CAPTURE_SOURCE', () => {
  it('hooks Foundry chat documents, not only new DOM nodes', () => {
    const src = FOUNDRY_CAPTURE_SOURCE || CHAT_OBSERVER_SOURCE;
    expect(src).toContain('createChatMessage');
    expect(src).toContain('updateChatMessage');
    expect(src).toContain('game.messages');
    expect(src).toContain('preUpdateToken');
  });

  it('assigns AFTER_TS before stamping the capture version', () => {
    const after = FOUNDRY_CAPTURE_SOURCE.indexOf('var AFTER_TS = __FLC_AFTER_TS__');
    const stamp = FOUNDRY_CAPTURE_SOURCE.indexOf('window.__flcMudCapture = VERSION');
    expect(after).toBeGreaterThan(-1);
    expect(stamp).toBeGreaterThan(after);
  });
});

describe('buildCaptureSource', () => {
  it('replaces AFTER_TS with a number so the IIFE is valid JavaScript', () => {
    const src = buildCaptureSource({ lastTimestamp: 99 });
    expect(src).not.toContain('__FLC_AFTER_TS__');
    expect(src).toMatch(/var AFTER_TS = 99;/);
    expect(() => new Function(src)).not.toThrow();
  });
});

describe('buildFoundryPostPayload', () => {
  it('never includes another Foundry user id', () => {
    const payload = buildFoundryPostPayload('{RYou{x', {
      speakAs: 'alias',
      alias: 'The MUD',
    });
    expect(payload.content).toContain('[MUD]');
    expect(payload.speakAs).toBe('alias');
    expect(payload.alias).toBe('The MUD');
    expect(payload).not.toHaveProperty('user');
    expect(payload).not.toHaveProperty('userId');
  });
});
