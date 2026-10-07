'use strict';

/**
 * @param {object | null | undefined} win
 * @returns {boolean}
 */
function destroyed(win) {
  if (!win || typeof win !== 'object') return true;
  if (typeof win.isDestroyed !== 'function') return false;
  try {
    return win.isDestroyed() === true;
  } catch {
    return true;
  }
}

/**
 * @param {object} win
 */
function raiseOne(win) {
  if (typeof win.isMinimized === 'function' && win.isMinimized()) {
    if (typeof win.restore === 'function') win.restore();
  }
  if (typeof win.show === 'function') win.show();
  if (typeof win.moveTop === 'function') win.moveTop();
}

/**
 * Some window managers ignore focus. Pinning and immediately unpinning
 * asks them to raise the window anyway.
 * @param {object} win
 */
function nudge(win) {
  if (typeof win.setAlwaysOnTop !== 'function') return;
  try {
    win.setAlwaysOnTop(true);
  } catch {
    /* still clear the pin */
  }
  try {
    win.setAlwaysOnTop(false);
  } catch {
    /* next window */
  }
}

/**
 * Restore, show, and raise every live window. Focus `focusWin` after that
 * so the window the command was used from stays in front. A failure on one
 * window does not stop the others.
 * @param {Array<object> | null | undefined} windows
 * @param {object | null | undefined} focusWin
 */
function bringAllToFront(windows, focusWin) {
  const list = Array.isArray(windows) ? windows : [];
  /** @type {object[]} */
  const alive = [];
  for (const win of list) {
    if (destroyed(win)) continue;
    alive.push(win);
    try {
      raiseOne(win);
    } catch {
      /* one window must not stop the others */
    }
  }
  const focus = destroyed(focusWin) ? null : focusWin;
  if (focus && typeof focus.focus === 'function') {
    try {
      focus.focus();
    } catch {
      /* still nudge */
    }
  }
  /** @type {object[]} */
  const order = [];
  for (const win of alive) {
    if (win !== focus) order.push(win);
  }
  if (focus) order.push(focus);
  for (const win of order) {
    if (destroyed(win)) continue;
    nudge(win);
  }
}

module.exports = {
  bringAllToFront,
};
