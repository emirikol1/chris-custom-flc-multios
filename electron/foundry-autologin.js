'use strict';

/**
 * Foundry VTT "Join Game Session" auto-login.
 *
 * The main process injects the script produced by `buildAutologinScript()`
 * into the game window via `webContents.executeJavaScript`. The script
 * waits (up to ~8 s) for Foundry's join form, selects the stored user,
 * fills the password and submits.
 *
 * Privacy rules enforced here:
 *   - username/password are embedded ONLY as JSON literals and never logged;
 *   - the injected script never reports HTML, URLs, titles or option texts;
 *   - the only thing sent back is a tiny status object passed to
 *     `window.flcGame.autologinStatus(status)` when the preload provides it.
 *
 * Status shapes reported:
 *   { matched: true,  submitted: true }
 *   { matched: false, userCount: <number> }
 *   { matched: false, error: 'exception' }
 *   (nothing at all if the form never appears before the timeout)
 */

/** How long the injected script keeps looking for the join form (ms). */
const AUTOLOGIN_TIMEOUT_MS = 8000;
/** Fallback polling interval when MutationObserver misses the form (ms). */
const AUTOLOGIN_POLL_MS = 250;
/** Value returned by the injected IIFE. */
const AUTOLOGIN_ARMED_RESULT = 'flc-autologin-armed';

/**
 * Pick the `value` of the option whose text matches `username`.
 *
 * Case-insensitive, trimmed exact match first; otherwise a unique
 * case-insensitive prefix match; otherwise `null`.
 *
 * NOTE: this function is serialised with `Function.prototype.toString()` and
 * inlined into the injected script, so it must stay self-contained (no
 * closures, no module references, ES5-compatible syntax).
 *
 * @param {Array<{ value: string, text: string }>} options
 * @param {string} username
 * @returns {string|null}
 */
function matchUserOption(options, username) {
  if (!Array.isArray(options) || options.length === 0) return null;
  var wanted = String(username == null ? '' : username).trim().toLowerCase();
  if (!wanted) return null;

  var i;
  var text;
  for (i = 0; i < options.length; i += 1) {
    text = String(options[i] && options[i].text != null ? options[i].text : '')
      .trim()
      .toLowerCase();
    if (text && text === wanted) return options[i].value;
  }

  var prefixValue = null;
  var prefixHits = 0;
  for (i = 0; i < options.length; i += 1) {
    text = String(options[i] && options[i].text != null ? options[i].text : '')
      .trim()
      .toLowerCase();
    if (text && text.indexOf(wanted) === 0) {
      prefixHits += 1;
      prefixValue = options[i].value;
    }
  }
  return prefixHits === 1 ? prefixValue : null;
}

/** Source text of `matchUserOption`, inlined into the injected script. */
const MATCH_USER_OPTION_SOURCE = matchUserOption.toString();

/**
 * Build the body of the injected function. The body expects two free
 * variables, `window` and `document`, so it can be evaluated in tests via
 * `new Function('window', 'document', body)`.
 *
 * @param {{ username: string, password: string }} creds
 * @returns {string}
 */
function buildAutologinBody({ username, password } = {}) {
  const credsLiteral = JSON.stringify({
    username: String(username == null ? '' : username),
    password: String(password == null ? '' : password),
  });

  return `
'use strict';
var ARMED = ${JSON.stringify(AUTOLOGIN_ARMED_RESULT)};
try {
  if (window.__flcAutologinDone || window.__flcAutologinArmed) return ARMED;
  window.__flcAutologinArmed = true;

  var CREDS = ${credsLiteral};
  ${MATCH_USER_OPTION_SOURCE}

  var intervalId = null;
  var timeoutId = null;
  var observer = null;

  var report = function (status) {
    try {
      if (window.flcGame && typeof window.flcGame.autologinStatus === 'function') {
        window.flcGame.autologinStatus(status);
      }
    } catch (ignored) {}
  };

  var cleanup = function () {
    if (intervalId !== null) { try { window.clearInterval(intervalId); } catch (ignored) {} intervalId = null; }
    if (timeoutId !== null) { try { window.clearTimeout(timeoutId); } catch (ignored) {} timeoutId = null; }
    if (observer) { try { observer.disconnect(); } catch (ignored) {} observer = null; }
  };

  var finish = function () {
    window.__flcAutologinDone = true;
    cleanup();
  };

  var fire = function (el, type) {
    try {
      var ev = typeof window.Event === 'function'
        ? new window.Event(type, { bubbles: true })
        : { type: type, bubbles: true };
      el.dispatchEvent(ev);
    } catch (ignored) {}
  };

  var findSelect = function () {
    var form = document.querySelector('form#join-game');
    var select = form ? form.querySelector('select[name="userid"]') : null;
    if (!select) select = document.querySelector('select[name="userid"]');
    return select || null;
  };

  var attempt = function () {
    if (window.__flcAutologinDone) return true;
    var select = findSelect();
    if (!select) return false;

    var form = select.form || (typeof select.closest === 'function' ? select.closest('form') : null)
      || document.querySelector('form#join-game');
    var scope = form || document;

    var options = [];
    var rawOptions = select.options || [];
    for (var i = 0; i < rawOptions.length; i += 1) {
      var opt = rawOptions[i];
      if (!opt) continue;
      options.push({ value: opt.value, text: opt.text != null ? opt.text : (opt.textContent || '') });
    }

    var value = matchUserOption(options, CREDS.username);
    if (value === null) {
      finish();
      report({ matched: false, userCount: options.length });
      return true;
    }

    // Mark done before touching the DOM so a re-entrant call cannot double-submit.
    finish();

    select.value = value;
    fire(select, 'change');

    var pw = scope.querySelector('input[name="password"]')
      || document.querySelector('input[name="password"]');
    if (pw && CREDS.password) {
      pw.value = CREDS.password;
      fire(pw, 'input');
      fire(pw, 'change');
    }

    var button = scope.querySelector('button[name="join"]')
      || document.querySelector('button[name="join"]');
    if (button && typeof button.click === 'function') {
      button.click();
    } else if (form && typeof form.requestSubmit === 'function') {
      form.requestSubmit();
    } else if (form && typeof form.submit === 'function') {
      form.submit();
    }

    report({ matched: true, submitted: true });
    return true;
  };

  var guardedAttempt = function () {
    try {
      return attempt();
    } catch (err) {
      finish();
      report({ matched: false, error: 'exception' });
      return true;
    }
  };

  if (!guardedAttempt()) {
    intervalId = window.setInterval(guardedAttempt, ${AUTOLOGIN_POLL_MS});
    timeoutId = window.setTimeout(function () {
      if (!window.__flcAutologinDone) finish();
    }, ${AUTOLOGIN_TIMEOUT_MS});
    if (typeof window.MutationObserver === 'function') {
      try {
        var root = document.documentElement || document.body;
        if (root) {
          observer = new window.MutationObserver(guardedAttempt);
          observer.observe(root, { childList: true, subtree: true });
        }
      } catch (ignored) {
        observer = null;
      }
    }
  }
} catch (err) {
  try {
    window.__flcAutologinDone = true;
    if (window.flcGame && typeof window.flcGame.autologinStatus === 'function') {
      window.flcGame.autologinStatus({ matched: false, error: 'exception' });
    }
  } catch (ignored) {}
}
return ARMED;
`;
}

/**
 * Build the full IIFE string for `webContents.executeJavaScript`.
 *
 * @param {{ username: string, password: string }} creds
 * @returns {string}
 */
function buildAutologinScript(creds) {
  return `(function (window, document) {${buildAutologinBody(creds)}})(window, document);`;
}

/**
 * True when `urlString` points at Foundry's join route (`/join`, possibly
 * under a route prefix). Invalid URLs yield `false`.
 *
 * @param {string} urlString
 * @returns {boolean}
 */
function isJoinPageUrl(urlString) {
  if (typeof urlString !== 'string' || !urlString) return false;
  let pathname;
  try {
    pathname = new URL(urlString).pathname;
  } catch {
    return false;
  }
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '/join' || trimmed.endsWith('/join');
}

module.exports = {
  AUTOLOGIN_ARMED_RESULT,
  AUTOLOGIN_POLL_MS,
  AUTOLOGIN_TIMEOUT_MS,
  MATCH_USER_OPTION_SOURCE,
  buildAutologinBody,
  buildAutologinScript,
  isJoinPageUrl,
  matchUserOption,
};
