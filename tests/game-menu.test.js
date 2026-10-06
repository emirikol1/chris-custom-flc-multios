import { describe, expect, it } from 'vitest';
import { gameWindowMenuTemplate } from '../electron/game-menu.js';

function viewMenu(template) {
  return template.find((item) => item.label === 'View');
}

function centerItem(template) {
  const view = viewMenu(template);
  return view.submenu.find((item) => item.id === 'center-prompts');
}

function highlightMenu(template) {
  const view = viewMenu(template);
  return view.submenu.find((item) => item.id === 'prompt-highlight');
}

describe('game window View menu', () => {
  it('adds Prompt windows always on main window under View and keeps the standard view commands', () => {
    const template = gameWindowMenuTemplate({ centerPrompts: true });
    const view = viewMenu(template);
    const roles = view.submenu.map((item) => item.role).filter(Boolean);
    expect(roles).toEqual([
      'reload',
      'forceReload',
      'toggleDevTools',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen',
    ]);
    const item = centerItem(template);
    expect(item.label).toBe('Prompt windows always on main window');
    expect(item.type).toBe('checkbox');
    expect(item.checked).toBe(true);
  });

  it('checks the box from the stored server choice and reports toggles', () => {
    const seen = [];
    const template = gameWindowMenuTemplate({
      centerPrompts: false,
      onToggleCenterPrompts: (enabled) => seen.push(enabled),
    });
    const item = centerItem(template);
    expect(item.checked).toBe(false);
    item.click({ checked: true });
    item.click({ checked: false });
    expect(seen).toEqual([true, false]);
  });

  it('puts highlight and the eight glow colors in their own menu, defaulting to on and blue', () => {
    const highlights = [];
    const raises = [];
    const colors = [];
    const strengths = [];
    const template = gameWindowMenuTemplate({
      promptHighlight: true,
      onTogglePromptHighlight: (enabled) => highlights.push(enabled),
      onTogglePromptAutoRaise: (enabled) => raises.push(enabled),
      onPickPromptGlow: (glow) => colors.push(glow),
      onPickPromptGlowStrength: () => strengths.push(true),
    });
    const menu = highlightMenu(template);
    expect(menu.label).toBe('Highlight Prompts');
    const toggle = menu.submenu.find((item) => item.id === 'prompt-highlight-toggle');
    expect(toggle.type).toBe('checkbox');
    expect(toggle.checked).toBe(true);
    const radios = menu.submenu.filter((item) => item.type === 'radio');
    expect(radios.map((item) => item.label)).toEqual([
      'Blue', 'Red', 'Orange', 'Yellow', 'Green', 'Purple', 'Pink', 'White',
    ]);
    expect(radios.find((item) => item.checked).label).toBe('Blue');
    const raise = menu.submenu.find((item) => item.id === 'prompt-auto-raise');
    expect(raise.label).toBe('Auto-Raise');
    expect(raise.type).toBe('checkbox');
    expect(raise.checked).toBe(true);
    expect(menu.submenu.indexOf(raise)).toBeLessThan(menu.submenu.indexOf(radios[0]));
    toggle.click({ checked: false });
    raise.click({ checked: false });
    radios.find((item) => item.label === 'Pink').click();
    expect(highlights).toEqual([false]);
    expect(raises).toEqual([false]);
    expect(colors).toEqual(['pink']);
    const strength = menu.submenu.find((item) => item.id === 'prompt-glow-strength');
    expect(strength.label).toBe('Glow Strength: 100%');
    expect(menu.submenu.indexOf(strength)).toBeGreaterThan(menu.submenu.indexOf(radios[radios.length - 1]));
    strength.click();
    expect(strengths).toEqual([true]);
    expect(gameWindowMenuTemplate({ promptGlowStrength: 250 }).find((item) => item.label === 'View')
      .submenu.find((item) => item.id === 'prompt-highlight')
      .submenu.find((item) => item.id === 'prompt-glow-strength').label).toBe('Glow Strength: 250%');

    const off = gameWindowMenuTemplate({ promptHighlight: false, promptAutoRaise: false, promptGlow: 'white' });
    const offMenu = highlightMenu(off);
    expect(offMenu.submenu.find((item) => item.id === 'prompt-highlight-toggle').checked).toBe(false);
    expect(offMenu.submenu.find((item) => item.id === 'prompt-auto-raise').checked).toBe(false);
    expect(offMenu.submenu.find((item) => item.id === 'prompt-glow-white').checked).toBe(true);
  });
});
