'use strict';

/**
 * Ask the operating system for its normal "this window needs attention" alert.
 *
 * Electron's `BrowserWindow.flashFrame` is the supported cross-platform call.
 * There is no better-deployed library for this: Electron already maps it to
 * the platform behavior, and the OS ends the alert when the window is focused.
 *
 *   - Windows: the taskbar button flashes until the window is focused
 *   - Linux: the urgency hint, which the window manager clears on focus
 *   - macOS: the Dock icon bounces once (the system's informational request)
 *
 * This module does not keep alerting after focus, and it does not decide when
 * the alert ends.
 */

/**
 * @param {object | null | undefined} win BrowserWindow-like
 * @returns {boolean} true when an alert was requested
 */
function requestUserAttention(win) {
  if (!win || typeof win !== 'object') return false;
  if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return false;
  if (typeof win.isFocused === 'function' && win.isFocused()) return false;
  if (typeof win.flashFrame !== 'function') return false;
  win.flashFrame(true);
  return true;
}

module.exports = {
  requestUserAttention,
};
