'use strict';

/**
 * The note a player pastes to the person who runs their Foundry server.
 * One text, reused by the black-screen window, the loading card, and the
 * join-window copy button. Static wording only — nothing from the session.
 */

const NGINX_BODY = [
  'Subject: Faster Foundry loads — small nginx tweak',
  '',
  'Hi! A quick note from a player using the Foundry Light Client. When joining this Foundry server, the client spends ~15-20 seconds re-checking about 1,200 unchanged module/system files before the loading screen can appear. It looks like nginx is serving those files with "Cache-Control: no-cache" over HTTP/1.1, so every browser has to ask about each file one at a time (6 at a time, one round-trip each). Nothing is broken; this is just an optional optimization that would make loads noticeably faster for everyone.',
  '',
  'Two safe changes in your nginx site config (usually /etc/nginx/sites-available/<your-site> or /etc/nginx/conf.d/<your-site>.conf) fix it for every player:',
  '',
  '1) Enable HTTP/2 on the TLS listener (lets the browser check all files at once):',
  '    listen 443 ssl http2;',
  '',
  '2) Let browsers reuse Foundry\'s package files between loads, while still picking up updates in the background:',
  '    # Foundry VTT package assets: serve from browser cache, refresh in background',
  '    location ~* ^/(scripts|css|fonts|icons|ui|sounds|lang|systems|modules)/ {',
  '        proxy_pass http://127.0.0.1:30000;      # same upstream as your main location block',
  '        proxy_http_version 1.1;',
  '        proxy_set_header Host $host;',
  '        proxy_set_header X-Real-IP $remote_addr;',
  '        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;',
  '        proxy_set_header X-Forwarded-Proto $scheme;',
  '        proxy_hide_header Cache-Control;',
  '        add_header Cache-Control "public, max-age=0, stale-while-revalidate=604800";',
  '    }',
  '',
  '(Keep your existing "location /" block as-is — it still handles the game, the WebSocket upgrade, and uploads. Adjust the proxy_pass port if Foundry is not on 30000.)',
  '',
  'Then: sudo nginx -t && sudo systemctl reload nginx',
  '',
  'With stale-while-revalidate the browser uses its cached copy immediately and re-checks in the background, so module updates are still picked up on the next load. Nothing is cached longer than a week.',
].join('\n');

const GENERIC_BODY = [
  'Subject: Faster Foundry loads — small proxy tweak',
  '',
  'Hi! When players join this Foundry server, the client spends ~15-20 seconds re-checking about 1,200 unchanged module/system files with the server before the loading screen can even appear. That happens because those files are served with "Cache-Control: no-cache" over HTTP/1.1, so every browser has to ask about each file one at a time (6 at a time, one round-trip each).',
  '',
  'Your reverse proxy should enable HTTP/2 and send Cache-Control: public, max-age=0, stale-while-revalidate=604800 for those asset paths instead of no-cache. The paths are /scripts/, /css/, /fonts/, /icons/, /ui/, /sounds/, /lang/, /systems/, and /modules/.',
  '',
  'With stale-while-revalidate the browser uses its cached copy immediately and re-checks in the background, so module updates are still picked up on the next load. Nothing is cached longer than a week.',
].join('\n');

/**
 * @returns {string}
 */
function defaultProductName() {
  try {
    const pkg = require('../package.json');
    if (pkg && typeof pkg.productName === 'string' && pkg.productName.trim()) {
      return pkg.productName.trim();
    }
  } catch {
    /* package.json unreadable */
  }
  return "Chris's Custom FLC MultiOS";
}

/**
 * @param {unknown} value
 * @returns {string}
 */
function cleanProductName(value) {
  const fallback = defaultProductName();
  if (typeof value !== 'string') return fallback;
  const text = value.replace(/[\r\n]/g, ' ').trim();
  if (!text || text.length > 80) return fallback;
  if (/https?:|\/\//i.test(text)) return fallback;
  return text;
}

/**
 * @param {string} name
 * @returns {string}
 */
function footer(name) {
  return `Sent from ${name} (Foundry Light Client).`;
}

/**
 * @param {{ proxy?: unknown, productName?: unknown }} [opts]
 * @returns {string}
 */
function buildAdminMessage(opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const name = cleanProductName(options.productName);
  const body = options.proxy === 'nginx' ? NGINX_BODY : GENERIC_BODY;
  return `${body}\n\n${footer(name)}`;
}

module.exports = {
  buildAdminMessage,
  defaultProductName,
};
