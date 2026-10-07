import { describe, expect, it } from 'vitest';
import { gameWindowMenuTemplate, plainAppMenuTemplate } from '../electron/game-menu.js';

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
      'reload',
      'toggleDevTools',
      'toggleDevTools',
      'resetZoom',
      'zoomIn',
      'zoomOut',
      'togglefullscreen',
    ]);
    expect(roles).not.toContain('forceReload');
    const reloads = view.submenu.filter((item) => item.role === 'reload');
    expect(reloads.map((item) => item.accelerator)).toEqual(['F5', 'CmdOrCtrl+R']);
    expect(reloads[0].visible).toBeUndefined();
    expect(reloads[1].visible).toBe(false);
    const devtools = view.submenu.filter((item) => item.role === 'toggleDevTools');
    expect(devtools[0].accelerator).toBe('F12');
    expect(devtools[0].visible).toBeUndefined();
    expect(devtools[1].visible).toBe(false);
    expect(devtools[1].accelerator).toBeUndefined();
    const refresh = view.submenu.find((item) => item.id === 'full-refresh');
    const refreshAlt = view.submenu.find((item) => item.id === 'full-refresh-alt');
    expect(refresh.label).toBe('Full Refresh (clear cache)');
    expect(refresh.accelerator).toBe('Ctrl+F5');
    expect(refreshAlt.label).toBe('Full Refresh (clear cache)');
    expect(refreshAlt.accelerator).toBe('CmdOrCtrl+Shift+R');
    expect(refreshAlt.visible).toBe(false);
    expect(view.submenu.indexOf(refreshAlt)).toBe(view.submenu.indexOf(refresh) + 1);
    const item = centerItem(template);
    expect(item.label).toBe('Prompt windows always on main window');
    expect(item.type).toBe('checkbox');
    expect(item.checked).toBe(true);
  });

  it('runs Full Refresh from the View menu', () => {
    const seen = [];
    const template = gameWindowMenuTemplate({
      onFullRefresh: () => seen.push('refresh'),
    });
    const view = viewMenu(template);
    const item = view.submenu.find((entry) => entry.id === 'full-refresh');
    const alt = view.submenu.find((entry) => entry.id === 'full-refresh-alt');
    item.click();
    alt.click();
    expect(seen).toEqual(['refresh', 'refresh']);
    expect(() => gameWindowMenuTemplate().find((entry) => entry.label === 'View')
      .submenu.filter((entry) => entry.id === 'full-refresh' || entry.id === 'full-refresh-alt')
      .forEach((entry) => entry.click())).not.toThrow();
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

  it('adds a Diagnostics submenu with stats, logging, and report actions', () => {
    const seen = [];
    const template = gameWindowMenuTemplate({
      verboseLogging: true,
      onOpenWorldStats: () => seen.push('stats'),
      onToggleVerboseLogging: (enabled) => seen.push(enabled),
      onOpenLogs: () => seen.push('logs'),
      onOpenProblemLog: () => seen.push('problem'),
      onCopyTroubleshooting: () => seen.push('copy'),
      onSaveDiagnostics: () => seen.push('save'),
    });
    const view = viewMenu(template);
    const menu = view.submenu.find((item) => item.id === 'diagnostics');
    expect(menu.label).toBe('Diagnostics');
    const refresh = view.submenu.find((item) => item.id === 'full-refresh');
    expect(view.submenu.indexOf(refresh)).toBeLessThan(view.submenu.indexOf(menu));
    expect(menu.submenu.map((item) => item.id).filter(Boolean)).toEqual([
      'world-stats',
      'bring-all-to-front',
      'verbose-logging',
      'open-logs',
      'open-problem-log',
      'copy-ts',
      'save-diagnostics',
    ]);
    const stats = menu.submenu.find((item) => item.id === 'world-stats');
    expect(stats.label).toBe('World Statistics…');
    expect(stats.accelerator).toBe('CmdOrCtrl+Shift+S');
    const verbose = menu.submenu.find((item) => item.id === 'verbose-logging');
    expect(verbose.label).toBe('Verbose logging (this session)');
    expect(verbose.type).toBe('checkbox');
    expect(verbose.checked).toBe(true);
    expect(menu.submenu.find((item) => item.id === 'open-logs').label).toBe('Open logs folder');
    expect(menu.submenu.find((item) => item.id === 'open-problem-log').label).toBe('Open problem log');
    expect(menu.submenu.find((item) => item.id === 'copy-ts').label).toBe('Copy troubleshooting info');
    expect(menu.submenu.find((item) => item.id === 'save-diagnostics').label).toBe('Save diagnostics file…');
    stats.click();
    verbose.click({ checked: false });
    menu.submenu.find((item) => item.id === 'open-logs').click();
    menu.submenu.find((item) => item.id === 'open-problem-log').click();
    menu.submenu.find((item) => item.id === 'copy-ts').click();
    menu.submenu.find((item) => item.id === 'save-diagnostics').click();
    expect(seen).toEqual(['stats', false, 'logs', 'problem', 'copy', 'save']);
    expect(gameWindowMenuTemplate().find((item) => item.label === 'View')
      .submenu.find((item) => item.id === 'diagnostics')
      .submenu.find((item) => item.id === 'verbose-logging').checked).toBe(false);
    expect(() => gameWindowMenuTemplate().find((item) => item.label === 'View')
      .submenu.find((item) => item.id === 'diagnostics')
      .submenu.forEach((item) => {
        if (typeof item.click === 'function') item.click({ checked: true });
      })).not.toThrow();
  });

  it('puts Bring All FLC Windows to Front after World Statistics', () => {
    const seen = [];
    const from = { id: 'game' };
    const template = gameWindowMenuTemplate({
      bringAllToFront: (win) => seen.push(win),
    });
    const diagnostics = viewMenu(template).submenu.find((item) => item.id === 'diagnostics');
    const stats = diagnostics.submenu.find((item) => item.id === 'world-stats');
    const bring = diagnostics.submenu.find((item) => item.id === 'bring-all-to-front');
    expect(bring.label).toBe('Bring All FLC Windows to Front');
    expect(bring.accelerator).toBe('CmdOrCtrl+Shift+U');
    expect(diagnostics.submenu.indexOf(bring)).toBe(diagnostics.submenu.indexOf(stats) + 1);
    expect(diagnostics.submenu[diagnostics.submenu.indexOf(bring) + 1]).toEqual({ type: 'separator' });
    bring.click(null, from);
    expect(seen).toEqual([from]);
    expect(() => gameWindowMenuTemplate().find((item) => item.label === 'View')
      .submenu.find((item) => item.id === 'diagnostics')
      .submenu.find((item) => item.id === 'bring-all-to-front').click()).not.toThrow();
  });

  it('prepends the Apple menu only when the platform is darwin', () => {
    expect(gameWindowMenuTemplate({ platform: 'darwin' })[0]).toEqual({ role: 'appMenu' });
    expect(gameWindowMenuTemplate({ platform: 'darwin' })[1]).toEqual({ role: 'fileMenu' });
    expect(gameWindowMenuTemplate({ platform: 'win32' })[0]).toEqual({ role: 'fileMenu' });
    expect(gameWindowMenuTemplate({ platform: 'linux' })[0]).toEqual({ role: 'fileMenu' });
    expect(gameWindowMenuTemplate()[0]).toEqual({ role: 'fileMenu' });
  });
});

describe('plain application menu', () => {
  it('is app, edit, reload/zoom/devtools, and window — no prompt or glow items', () => {
    const template = plainAppMenuTemplate();
    expect(template.map((item) => item.role || item.label)).toEqual([
      'appMenu',
      'editMenu',
      'View',
      'windowMenu',
    ]);
    const view = template.find((item) => item.label === 'View');
    expect(view.submenu.map((item) => item.role).filter(Boolean)).toEqual([
      'reload',
      'reload',
      'toggleDevTools',
      'toggleDevTools',
      'resetZoom',
      'zoomIn',
      'zoomOut',
    ]);
    const reloads = view.submenu.filter((item) => item.role === 'reload');
    expect(reloads.map((item) => item.accelerator)).toEqual(['F5', 'CmdOrCtrl+R']);
    expect(reloads[1].visible).toBe(false);
    const devtoolsItems = view.submenu.filter((item) => item.role === 'toggleDevTools');
    expect(devtoolsItems[0].accelerator).toBe('F12');
    expect(devtoolsItems[1].visible).toBe(false);
    expect(devtoolsItems[1].accelerator).toBeUndefined();
    const dumped = JSON.stringify(template);
    expect(dumped).not.toContain('Highlight');
    expect(dumped).not.toContain('full-refresh');
    expect(dumped).not.toContain('diagnostics');
    expect(dumped).not.toContain('center-prompts');
    expect(dumped).not.toContain('forceReload');
  });

  it('adds Bring All FLC Windows to Front at the end of View', () => {
    const seen = [];
    const from = { id: 'join' };
    const template = plainAppMenuTemplate({
      bringAllToFront: (win) => seen.push(win),
    });
    const view = template.find((item) => item.label === 'View');
    const bring = view.submenu.find((item) => item.id === 'bring-all-to-front');
    const devtools = view.submenu.find((item) => item.role === 'toggleDevTools');
    expect(bring.label).toBe('Bring All FLC Windows to Front');
    expect(bring.accelerator).toBe('CmdOrCtrl+Shift+U');
    expect(view.submenu.indexOf(bring)).toBe(view.submenu.length - 1);
    expect(view.submenu[view.submenu.indexOf(bring) - 1]).toEqual({ type: 'separator' });
    expect(view.submenu.indexOf(bring)).toBeGreaterThan(view.submenu.indexOf(devtools));
    bring.click(null, from);
    expect(seen).toEqual([from]);
    expect(() => plainAppMenuTemplate().find((item) => item.label === 'View')
      .submenu.find((item) => item.id === 'bring-all-to-front').click()).not.toThrow();
  });
});
