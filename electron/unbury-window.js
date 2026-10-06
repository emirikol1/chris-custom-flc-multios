'use strict';

/**
 * Bring a newly opened game window to the front a moment after it spawns.
 * Connecting often leaves it buried under the window the user clicked next.
 *
 * Linux window managers ignore a plain focus request from a background app.
 * Briefly marking the window above others forces the raise; the mark is
 * cleared before this function returns, so the window does not stay on top.
 */

/** Delay after spawn before the game window raises itself (ms). */
const UNBURY_DELAY_MS = 2000;
/**
 * How long the window stays marked above others while the raise takes effect.
 * Cleared after this so it does not remain always on top.
 */
const UNBURY_RELEASE_MS = 200;

/**
 * @param {object | null | undefined} win BrowserWindow-like
 * @returns {boolean} true when a raise was attempted
 */
/**
 * @param {object | null | undefined} win
 * @returns {{ x: number, y: number, width: number, height: number } | null}
 */
function boundsOf(win) {
  if (!win || typeof win.getBounds !== 'function') return null;
  try {
    const bounds = win.getBounds();
    if (!bounds || !Number.isFinite(bounds.x) || !Number.isFinite(bounds.y)) return null;
    return {
      x: bounds.x,
      y: bounds.y,
      width: bounds.width,
      height: bounds.height,
    };
  } catch {
    return null;
  }
}

/**
 * @param {object | null | undefined} win
 * @param {{ x: number, y: number, width: number, height: number } | null} bounds
 */
function putBack(win, bounds) {
  if (!win || !bounds || typeof win.setBounds !== 'function') return;
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
  try {
    win.setBounds(bounds);
  } catch {
    /* The window can close between the check and the call. */
  }
}

/**
 * Remember where a window is and return a function that puts it back
 * if a raise or a child window moves it.
 * @param {object | null | undefined} win
 * @returns {() => void}
 */
function holdBounds(win) {
  const before = boundsOf(win);
  return function restoreHeldBounds() {
    if (!before) return;
    const now = boundsOf(win);
    if (
      now
      && now.x === before.x
      && now.y === before.y
      && now.width === before.width
      && now.height === before.height
    ) return;
    putBack(win, before);
  };
}

/** Positions within this many pixels count as the same spot. */
const SAME_SPOT_PX = 20;

/**
 * @param {{ x?: number, y?: number } | null | undefined} a
 * @param {{ x?: number, y?: number } | null | undefined} b
 * @returns {boolean}
 */
function nearPoint(a, b) {
  return Boolean(
    a && b
    && Number.isFinite(a.x) && Number.isFinite(a.y)
    && Number.isFinite(b.x) && Number.isFinite(b.y)
    && Math.abs(a.x - b.x) <= SAME_SPOT_PX
    && Math.abs(a.y - b.y) <= SAME_SPOT_PX,
  );
}

/**
 * True when a window is sitting on another saved window and not on its own place.
 * @param {{ x?: number, y?: number } | null | undefined} here
 * @param {{ x?: number, y?: number } | null | undefined} intended
 * @param {Array<{ x?: number, y?: number } | null | undefined>} others
 * @returns {boolean}
 */
function driftedOntoOtherWindow(here, intended, others) {
  if (!here || !Number.isFinite(intended && intended.x) || !Number.isFinite(intended && intended.y)) return false;
  if (nearPoint(here, intended)) return false;
  return (Array.isArray(others) ? others : []).some((other) => nearPoint(here, other));
}

function unburyWindow(win) {
  if (!win || (typeof win.isDestroyed === 'function' && win.isDestroyed())) return false;
  const restore = holdBounds(win);
  if (typeof win.isMinimized === 'function' && win.isMinimized() && typeof win.restore === 'function') {
    win.restore();
  }
  if (typeof win.setAlwaysOnTop === 'function') win.setAlwaysOnTop(true);
  if (typeof win.show === 'function') win.show();
  if (typeof win.focus === 'function') win.focus();
  if (typeof win.moveTop === 'function') win.moveTop();
  restore();
  if (typeof win.setAlwaysOnTop === 'function') {
    setTimeout(() => {
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
      try {
        win.setAlwaysOnTop(false);
      } catch {
        /* The raise already happened; losing the follow-up clear is logged by Electron. */
      }
      restore();
    }, UNBURY_RELEASE_MS);
  }
  return true;
}

/**
 * @param {object | null | undefined} win
 * @param {number} [delayMs]
 * @returns {() => void} cancel
 */
function scheduleUnbury(win, delayMs = UNBURY_DELAY_MS, onRaised) {
  const timer = setTimeout(() => {
    if (unburyWindow(win) && typeof onRaised === 'function') onRaised();
  }, delayMs);
  return function cancelUnbury() {
    clearTimeout(timer);
  };
}

module.exports = {
  UNBURY_DELAY_MS,
  UNBURY_RELEASE_MS,
  driftedOntoOtherWindow,
  holdBounds,
  scheduleUnbury,
  unburyWindow,
};
