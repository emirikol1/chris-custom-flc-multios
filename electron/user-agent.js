'use strict';

/**
 * Build a browser-like user agent from Electron's default one.
 *
 * Electron appends `<appName>/<version> Electron/<version>` to the Chrome UA.
 * Some Foundry modules (notably PopOut!) refuse to run when they see
 * " electron/" in `navigator.userAgent`, so strip those product tokens.
 *
 * @param {string} ua Electron's `app.userAgentFallback`
 * @param {string} [appName] Product token to remove (package.json `name`)
 * @returns {string}
 */
function browserLikeUserAgent(ua, appName) {
  let out = String(ua || '');
  if (appName) {
    const escaped = String(appName).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    out = out.replace(new RegExp(`\\s+${escaped}/\\S+`, 'gi'), '');
  }
  out = out.replace(/\s+Electron\/\S+/gi, '');
  return out.replace(/\s{2,}/g, ' ').trim();
}

module.exports = { browserLikeUserAgent };
