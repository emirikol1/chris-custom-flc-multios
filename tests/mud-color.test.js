import { describe, expect, it } from 'vitest';
import {
  emphasizeDamageVerbs,
  mudToAnsi,
  mudToFoundryChat,
  mudToHtml,
  rainbowize,
  romDamageVerb,
  formatRomDamageLadder,
} from '../electron/mud-color.js';

describe('rainbowize', () => {
  it('colors MASSACRE with the ROM rainbow cycle', () => {
    expect(rainbowize('MASSACRE')).toBe('{RM{YA{GS{CS{BA{MC{WR{RE{x');
  });
});

describe('romDamageVerb', () => {
  it('uses the ROM 2.4 dam_message percent table', () => {
    expect(romDamageVerb(0).vp).toBe('misses');
    expect(romDamageVerb(1).vp).toBe('scratches');
    expect(romDamageVerb(5).vp).toBe('scratches');
    expect(romDamageVerb(6).vp).toBe('grazes');
    expect(romDamageVerb(15).vp).toBe('hits');
    expect(romDamageVerb(45).vp).toBe('maims');
    expect(romDamageVerb(65).vp).toBe('MASSACRES');
    expect(romDamageVerb(95).vp).toBe('<<< ERADICATES >>>');
    expect(romDamageVerb(96).vp).toContain('UNSPEAKABLE');
  });

  it('uses victim max HP when given, like stock ROM', () => {
    expect(romDamageVerb(17, { maxHit: 20 }).vp).toBe('=== OBLITERATES ===');
  });

  it('lists every ROM 2.4 rung including maim and eradicate', () => {
    const table = formatRomDamageLadder();
    expect(table).toContain('maim');
    expect(table).toContain('MASSACRE');
    expect(table).toContain('<<< ERADICATE >>>');
    expect(table).toContain('UNSPEAKABLE');
    expect(table).toMatch(/1-5%/);
  });
});

describe('emphasizeDamageVerbs', () => {
  it('rainbows MASSACRED in a sentence', () => {
    const out = emphasizeDamageVerbs('The troll MASSACRED Bob!');
    expect(out).toContain('{RM');
    expect(out).toContain('{x');
    expect(out).toMatch(/The troll .* Bob!/);
  });

  it('wraps MUTILATES in magenta', () => {
    expect(emphasizeDamageVerbs('Grog MUTILATES the goblin.')).toContain(
      '{MMUTILATES{x',
    );
  });

  it('does not double-wrap an already coded MASSACRE', () => {
    const coded = '{RM{YA{GS{CS{BA{MC{WR{RE{x';
    expect(emphasizeDamageVerbs(coded)).toBe(coded);
  });
});

describe('mudToHtml', () => {
  it('escapes HTML then paints ROM codes', () => {
    const html = mudToHtml('{RYou <orc>{x');
    expect(html).toContain('&lt;orc&gt;');
    expect(html).not.toContain('<orc>');
    expect(html).toMatch(/<span class="mud mud-R">You /);
  });

  it('closes spans on {x', () => {
    expect(mudToHtml('{Ghello{x there')).toBe(
      '<span class="mud mud-G">hello</span> there',
    );
  });
});

describe('mudToAnsi', () => {
  it('emits ANSI for ROM codes', () => {
    const ansi = mudToAnsi('{RYou{x');
    expect(ansi).toContain('\x1b[1;31m');
    expect(ansi).toContain('\x1b[0m');
    expect(ansi).toContain('You');
  });

  it('does not treat {h as a color or eat injures', () => {
    const ansi = mudToAnsi('{hinjures the orc');
    expect(ansi).toContain('injures');
    expect(ansi).not.toContain('{h');
    expect(ansi).not.toContain('hinjures');
  });

  it('drops a failed rainbow prefix so Saulina is not turned into GA', () => {
    const raw =
      "{WG{R{YA{G{C{B{M{W{xSaulina's {wGraveflame Reaver{x {RM{YA{GS{CS{BA{MC{WR{RE{x";
    const ansi = mudToAnsi(raw);
    const plain = ansi.replace(/\x1b\[[0-9;]*m/g, '');
    expect(plain).toContain("Saulina's");
    expect(plain).toContain('Graveflame Reaver');
    expect(plain).toContain('MASSACRE');
    expect(plain).toMatch(/^Saulina's/);
    expect(plain).not.toMatch(/^GA/);
  });
});

describe('mudToFoundryChat', () => {
  it('is a normal /ooc player line with [MUD] and inline color', () => {
    const line = mudToFoundryChat('{RYou{x');
    expect(line.startsWith('/ooc [MUD] ')).toBe(true);
    expect(line).toContain('style="color:#ff5555"');
    expect(line).not.toContain('<script');
  });
});
