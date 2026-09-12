'use strict';

const { BrowserWindow, session } = require('electron');
const { joinPageUrl } = require('./foundry-users');
const { logWarn } = require('./logger');

const DEFAULT_TIMEOUT_MS = 20000;
const POLL_MS = 300;

// Reads only option labels from the join form. Returns null while the form is
// not rendered yet, [] if the select exists but has no real users.
const READ_USERS_SCRIPT = `(function () {
  var sel = document.querySelector('select[name="userid"]');
  if (!sel) { return null; }
  var out = [];
  for (var i = 0; i < sel.options.length; i++) {
    var o = sel.options[i];
    var v = String(o.value || '').trim();
    var t = String(o.textContent || '').trim();
    if (v && t && out.indexOf(t) === -1) { out.push(t); }
  }
  return out;
})()`;

/**
 * Load the server's join page in a hidden window and read the user names.
 * Foundry V12+ renders the join form client-side, so a plain HTTP fetch does
 * not contain the list.
 *
 * @param {string} serverUrl
 * @param {{ partition?: string, timeoutMs?: number }} [opts]
 * @returns {Promise<{ ok: true, users: string[] } | { ok: false, error: string }>}
 */
function fetchUsersViaHiddenWindow(serverUrl, opts = {}) {
  let url;
  try {
    url = joinPageUrl(serverUrl);
  } catch {
    return Promise.resolve({ ok: false, error: 'invalid_url' });
  }

  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const partition = opts.partition || `users-probe-${Date.now()}`;

  return new Promise((resolve) => {
    const win = new BrowserWindow({
      show: false,
      width: 1024,
      height: 768,
      webPreferences: {
        session: session.fromPartition(partition),
        contextIsolation: true,
        nodeIntegration: false,
        spellcheck: false,
        // Foundry renders the join form from timers/socket events; a hidden
        // window must not be throttled or the form never appears.
        backgroundThrottling: false,
      },
    });

    let settled = false;
    let pollTimer = null;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      if (pollTimer) clearInterval(pollTimer);
      clearTimeout(deadline);
      if (!win.isDestroyed()) win.destroy();
      resolve(result);
    };

    const deadline = setTimeout(() => finish({ ok: false, error: 'no_users' }), timeoutMs);

    const poll = async () => {
      if (settled || win.isDestroyed()) return;
      let users;
      try {
        users = await win.webContents.executeJavaScript(READ_USERS_SCRIPT, true);
      } catch {
        return; // page still navigating
      }
      if (Array.isArray(users) && users.length > 0) {
        finish({ ok: true, users: users.map((u) => String(u).slice(0, 120)) });
      }
    };

    win.webContents.on('did-fail-load', (_e, code, _desc, _url, isMainFrame) => {
      if (isMainFrame && code !== -3 /* aborted */) {
        finish({ ok: false, error: 'unreachable' });
      }
    });
    win.webContents.on('did-finish-load', () => {
      if (!pollTimer) pollTimer = setInterval(poll, POLL_MS);
      poll();
    });

    win.loadURL(url).catch(() => {
      logWarn('[users-window] load failed');
      finish({ ok: false, error: 'unreachable' });
    });
  });
}

module.exports = {
  fetchUsersViaHiddenWindow,
  READ_USERS_SCRIPT,
};
