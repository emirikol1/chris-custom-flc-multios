'use strict';

const { plainAppMenuTemplate } = require('./game-menu');

/**
 * Window menu on Windows and Linux; the macOS menu bar is the application menu.
 * Game windows registered with installForWindow keep their own menu. Any other
 * focused window on macOS gets the plain menu. The caller maps a popout focus
 * to its parent game window before calling onFocus.
 *
 * @param {{
 *   platform: string,
 *   Menu: {
 *     setApplicationMenu: (menu: unknown) => void,
 *     buildFromTemplate: (template: unknown[]) => unknown,
 *   },
 *   bringAllToFront?: (win?: object) => void,
 * }} opts
 * @returns {{
 *   installForWindow: (win: { setMenu?: (menu: unknown) => void, isFocused?: () => boolean }, menu: unknown) => void,
 *   onFocus: (win: object) => void,
 *   onClosed: (win: object) => void,
 *   setPlain: () => void,
 * }}
 */
function createMenuPlacement({ platform, Menu, bringAllToFront }) {
  /** @type {Map<object, unknown>} */
  const menus = new Map();
  /** @type {object | null} */
  let active = null;

  function plainMenu() {
    return Menu.buildFromTemplate(plainAppMenuTemplate({ bringAllToFront }));
  }

  return {
    installForWindow(win, menu) {
      if (!win) return;
      menus.set(win, menu);
      if (platform !== 'darwin') {
        if (typeof win.setMenu === 'function') win.setMenu(menu);
        return;
      }
      const focused = typeof win.isFocused === 'function' && win.isFocused() === true;
      if (focused || active === win) {
        active = win;
        Menu.setApplicationMenu(menu);
      }
    },

    onFocus(win) {
      if (platform !== 'darwin' || !win) return;
      if (menus.has(win)) {
        active = win;
        Menu.setApplicationMenu(menus.get(win));
        return;
      }
      active = null;
      Menu.setApplicationMenu(plainMenu());
    },

    onClosed(win) {
      if (!win) return;
      const had = menus.delete(win);
      if (platform !== 'darwin') return;
      if (had && active === win) {
        active = null;
        Menu.setApplicationMenu(plainMenu());
      }
    },

    setPlain() {
      active = null;
      if (platform !== 'darwin') return;
      Menu.setApplicationMenu(plainMenu());
    },
  };
}

module.exports = {
  createMenuPlacement,
};
