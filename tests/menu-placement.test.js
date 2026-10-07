import { describe, expect, it, vi } from 'vitest';
import { plainAppMenuTemplate } from '../electron/game-menu.js';
import { createMenuPlacement } from '../electron/menu-placement.js';

function fakeMenuApi() {
  return {
    setApplicationMenu: vi.fn(),
    buildFromTemplate: vi.fn((template) => ({ template })),
  };
}

function fakeWin(overrides = {}) {
  return {
    setMenu: vi.fn(),
    isFocused: () => false,
    ...overrides,
  };
}

function lastMenu(Menu) {
  const calls = Menu.setApplicationMenu.mock.calls;
  return calls[calls.length - 1][0];
}

describe('createMenuPlacement on darwin', () => {
  it('sets the application menu to the game menu on game focus and the plain menu on other windows', () => {
    const Menu = fakeMenuApi();
    const placement = createMenuPlacement({ platform: 'darwin', Menu });
    const game = fakeWin();
    const other = fakeWin();
    const gameMenu = { id: 'game-menu' };

    placement.installForWindow(game, gameMenu);
    expect(game.setMenu).not.toHaveBeenCalled();
    expect(Menu.setApplicationMenu).not.toHaveBeenCalled();

    placement.onFocus(game);
    expect(lastMenu(Menu)).toBe(gameMenu);

    placement.onFocus(other);
    expect(lastMenu(Menu).template).toEqual(plainAppMenuTemplate());
    expect(JSON.stringify(lastMenu(Menu).template)).not.toMatch(/Highlight|full-refresh|diagnostics|center-prompts/);
  });

  it('applies the game menu immediately when that window is already focused', () => {
    const Menu = fakeMenuApi();
    const placement = createMenuPlacement({ platform: 'darwin', Menu });
    const game = fakeWin({ isFocused: () => true });
    const gameMenu = { id: 'focused-game' };

    placement.installForWindow(game, gameMenu);
    expect(Menu.setApplicationMenu).toHaveBeenCalledTimes(1);
    expect(Menu.setApplicationMenu).toHaveBeenCalledWith(gameMenu);
    expect(game.setMenu).not.toHaveBeenCalled();
  });

  it('reverts to the plain menu when the game window whose menu is showing closes', () => {
    const Menu = fakeMenuApi();
    const placement = createMenuPlacement({ platform: 'darwin', Menu });
    const game = fakeWin({ isFocused: () => true });
    const gameMenu = { id: 'closing-game' };

    placement.installForWindow(game, gameMenu);
    placement.onClosed(game);
    expect(lastMenu(Menu).template).toEqual(plainAppMenuTemplate());
  });

  it('keeps the other game window menu when a background game window closes', () => {
    const Menu = fakeMenuApi();
    const placement = createMenuPlacement({ platform: 'darwin', Menu });
    const background = fakeWin();
    const front = fakeWin();
    const backgroundMenu = { id: 'background' };
    const frontMenu = { id: 'front' };

    placement.installForWindow(background, backgroundMenu);
    placement.installForWindow(front, frontMenu);
    placement.onFocus(front);
    placement.onClosed(background);
    expect(lastMenu(Menu)).toBe(frontMenu);
  });

  it('setPlain installs the plain menu', () => {
    const Menu = fakeMenuApi();
    const placement = createMenuPlacement({ platform: 'darwin', Menu });
    placement.setPlain();
    expect(lastMenu(Menu).template).toEqual(plainAppMenuTemplate());
  });
});

describe('createMenuPlacement on win32 and linux', () => {
  it.each(['win32', 'linux'])('calls setMenu on the window and never setApplicationMenu (%s)', (platform) => {
    const Menu = fakeMenuApi();
    const placement = createMenuPlacement({ platform, Menu });
    const game = fakeWin({ isFocused: () => true });
    const gameMenu = { id: 'window-menu' };

    placement.installForWindow(game, gameMenu);
    placement.onFocus(game);
    placement.onFocus(fakeWin());
    placement.onClosed(game);
    placement.setPlain();

    expect(game.setMenu).toHaveBeenCalledTimes(1);
    expect(game.setMenu).toHaveBeenCalledWith(gameMenu);
    expect(Menu.setApplicationMenu).not.toHaveBeenCalled();
  });
});
