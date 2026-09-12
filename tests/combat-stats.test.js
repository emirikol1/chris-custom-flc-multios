import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  applyCombatEvent,
  formatScoreboard,
  isResetCommand,
  loadScoreboard,
  parseCombatEvent,
  resetScoreboard,
  saveScoreboard,
} from '../electron/combat-stats.js';

describe('parseCombatEvent', () => {
  it('reads a Scorching Ray damage total and target', () => {
    const ev = parseCombatEvent({
      speaker: 'Rina Silverthorn',
      text:
        'Scorching Ray 2nd Level • Evocation Attack Damage Attack 1d20 + 5 + 4 + 2 + 2 CRIT: 20 20 33 Targets Scarlet Collector Scarlet Collector 21 Damage 2d6 + 12 17 4 1 5 5 5',
    });
    expect(ev).toEqual({
      speaker: 'Rina Silverthorn',
      target: 'Scarlet Collector',
      dealt: 17,
      taken: 17,
      healed: 0,
      crits: 1,
      nat1s: 0,
    });
  });

  it('reads potion healing as healed, not dealt', () => {
    const ev = parseCombatEvent({
      speaker: 'Maple Blackridge',
      text:
        'Potion of Healing (Superior) Potion Healing Consume Resource Targets Maple Blackridge Maple Blackridge Healing 40 40',
    });
    expect(ev.healed).toBe(40);
    expect(ev.dealt).toBe(0);
    expect(ev.target).toBe('Maple Blackridge');
  });

  it('reads midi "Damage → N dealt"', () => {
    const ev = parseCombatEvent({
      speaker: 'Meadow',
      text: '29 Damage → 26 dealt',
    });
    expect(ev.dealt).toBe(26);
  });

  it('returns null for a miss with no damage dice total', () => {
    expect(
      parseCombatEvent({
        speaker: 'Grog',
        text: 'Crossbow, Light Attack 1d20 + 5 Targets Saul Blightborne 23',
      }),
    ).toBeNull();
  });

  it('counts a midi CRIT as a critical hit', () => {
    const ev = parseCombatEvent({
      speaker: 'Rina Silverthorn',
      text:
        'Scorching Ray Attack 1d20 + 5 CRIT: naturalCrit 20 20 33 Targets Orc Orc 12 Damage 2d6 + 12 17',
    });
    expect(ev.crits).toBe(1);
    expect(ev.nat1s).toBe(0);
  });

  it('counts a fumble / natural 1 even when the attack deals no damage', () => {
    const ev = parseCombatEvent({
      speaker: 'Grog',
      text: 'Crossbow, Light Attack 1d20 + 5 Fumble 1 6 Targets Saul Blightborne 23',
    });
    expect(ev).toEqual({
      speaker: 'Grog',
      target: 'Saul Blightborne',
      dealt: 0,
      taken: 0,
      healed: 0,
      crits: 0,
      nat1s: 1,
    });
  });

  it('counts a d20 face of 1 as a natural 1', () => {
    const ev = parseCombatEvent({
      speaker: 'Grog',
      text: 'Crossbow, Light Attack 1d20 + 5 1 6 Targets Saul Blightborne 23',
    });
    expect(ev.nat1s).toBe(1);
    expect(ev.crits).toBe(0);
  });
});

describe('scoreboard persistence', () => {
  it('keeps raw running totals and percent distribution on disk', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-score-'));
    let board = loadScoreboard(root);
    board = applyCombatEvent(board, 'a', {
      speaker: 'Rina',
      target: 'Orc',
      dealt: 17,
      taken: 17,
      healed: 0,
      crits: 2,
      nat1s: 1,
    });
    board = applyCombatEvent(board, 'b', {
      speaker: 'Maple',
      target: 'Maple',
      dealt: 0,
      taken: 0,
      healed: 40,
    });
    saveScoreboard(root, board);
    const loaded = loadScoreboard(root);
    expect(loaded.actors.Rina.dealt).toBe(17);
    expect(loaded.actors.Rina.crits).toBe(2);
    expect(loaded.actors.Rina.nat1s).toBe(1);
    expect(loaded.actors.Orc.taken).toBe(17);
    expect(loaded.actors.Maple.healed).toBe(40);
    const text = formatScoreboard(loaded);
    expect(text).toContain('Rina | 17 | 0 | 0 | 2 | 1 | 2:1 | 100.0');
    expect(text).toContain('Maple | 0 | 0 | 40 | 0 | 0 | 0:0 | 0.0');
    applyCombatEvent(board, 'a', {
      speaker: 'Rina',
      target: 'Orc',
      dealt: 20,
      taken: 17,
      healed: 0,
      crits: 2,
      nat1s: 1,
    });
    expect(board.actors.Rina.dealt).toBe(20);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('zeros actors and events on /reset but keeps the Foundry cursor', () => {
    const board = resetScoreboard({
      version: 1,
      lastTimestamp: 1700000000000,
      lastId: 'msg-9',
      lastProcessedAt: '2026-09-05T20:00:00.000Z',
      actors: { Rina: { dealt: 17, taken: 0, healed: 0 } },
      events: { a: { speaker: 'Rina', target: 'Orc', dealt: 17, taken: 17, healed: 0 } },
    });
    expect(board.actors).toEqual({});
    expect(board.events).toEqual({});
    expect(board.lastTimestamp).toBe(1700000000000);
    expect(board.lastId).toBe('msg-9');
    expect(formatScoreboard(board)).toContain('(empty)');
  });
});

describe('isResetCommand', () => {
  it('matches /reset only', () => {
    expect(isResetCommand('/reset')).toBe(true);
    expect(isResetCommand('  /RESET  ')).toBe(true);
    expect(isResetCommand('reset the scores')).toBe(false);
    expect(isResetCommand('/reset please')).toBe(false);
  });
});
