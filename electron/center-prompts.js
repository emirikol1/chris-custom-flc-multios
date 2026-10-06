'use strict';

/**
 * Center short-lived Foundry prompts (roll confirmations, yes/no, modal
 * dialogs) in the main game window. Sheets and sidebar tabs are left alone.
 * PopOut! otherwise moves those prompts into a popped-out sheet, centers them
 * there, and replaces the title bar so it cannot be dragged. Marking the
 * prompt makes PopOut leave it in the main window.
 *
 * The injected script never reads or reports page text, URLs, or credentials.
 * It only rewrites the left/top passed to Foundry's setPosition, and it marks
 * a prompt's own frame so the prompt reads as needing an answer.
 */

/**
 * Eight basic glow colors. Light values are deep so they stay visible on a
 * bright desktop. Dark values are bright so they stay visible on Foundry's
 * dark windows. White uses a dark halo in light mode so the white ring
 * does not disappear. Blue is the default and matches the outline already
 * in use. This is a fixed palette, not the OS accent color.
 *
 * @type {Array<{ id: string, label: string, light: string, dark: string, swatch: string, lightGlow?: string }>}
 */
const PROMPT_GLOW_COLORS = [
  { id: 'blue', label: 'Blue', light: '#063a8c', dark: '#b3cdff', swatch: '#2f6fed' },
  { id: 'red', label: 'Red', light: '#9b1212', dark: '#ffb4b4', swatch: '#e02323' },
  { id: 'orange', label: 'Orange', light: '#9a3d00', dark: '#ffc48a', swatch: '#f07800' },
  { id: 'yellow', label: 'Yellow', light: '#ffc200', dark: '#ffd000', swatch: '#ffc200' },
  { id: 'green', label: 'Green', light: '#0b6b28', dark: '#9be7b0', swatch: '#1f9d45' },
  { id: 'purple', label: 'Purple', light: '#5b1f8a', dark: '#e0b3ff', swatch: '#8a3ff0' },
  { id: 'pink', label: 'Pink', light: '#9a1858', dark: '#ffb3d6', swatch: '#e23b86' },
  { id: 'white', label: 'White', light: '#ffffff', dark: '#ffffff', swatch: '#f4f4f4', lightGlow: 'rgba(0, 0, 0, 0.9)' },
];

const DEFAULT_PROMPT_GLOW = 'blue';

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isKnownPromptGlow(value) {
  return PROMPT_GLOW_COLORS.some((color) => color.id === value);
}

/**
 * Unknown or missing values use blue.
 * @param {unknown} value
 * @returns {string}
 */
function normalizePromptGlow(value) {
  return isKnownPromptGlow(value) ? /** @type {string} */ (value) : DEFAULT_PROMPT_GLOW;
}

/**
 * Missing means the highlight is on. Only an explicit false turns it off.
 * @param {unknown} stored
 * @returns {boolean}
 */
function promptHighlightEnabled(stored) {
  if (stored && typeof stored === 'object') {
    return /** @type {{ promptHighlight?: unknown }} */ (stored).promptHighlight !== false;
  }
  return stored !== false;
}

/**
 * Missing means a prompt raises the window it opened in. Only an explicit false turns it off.
 * @param {unknown} stored
 * @returns {boolean}
 */
function promptAutoRaiseEnabled(stored) {
  if (stored && typeof stored === 'object') {
    return /** @type {{ promptAutoRaise?: unknown }} */ (stored).promptAutoRaise !== false;
  }
  return stored !== false;
}

/** 100% is the glow size already in the stylesheet. */
const DEFAULT_PROMPT_GLOW_STRENGTH = 100;
const MIN_PROMPT_GLOW_STRENGTH = 0;
const MAX_PROMPT_GLOW_STRENGTH = 300;

/**
 * Missing or unusable values are 100% of the baseline glow. Out-of-range numbers clamp to 0–300.
 * @param {unknown} value
 * @returns {number}
 */
function normalizePromptGlowStrength(value) {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n)) return DEFAULT_PROMPT_GLOW_STRENGTH;
  return Math.min(MAX_PROMPT_GLOW_STRENGTH, Math.max(MIN_PROMPT_GLOW_STRENGTH, Math.round(n)));
}

/**
 * True when a profile actually stored a strength, including an explicit 100.
 * @param {unknown} value
 * @returns {boolean}
 */
function isExplicitPromptGlowStrength(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {string} hex
 * @param {number} alpha
 * @returns {string}
 */
function rgbaFromHex(hex, alpha) {
  const n = parseInt(hex.slice(1), 16);
  const r = (n >> 16) & 255;
  const g = (n >> 8) & 255;
  const b = n & 255;
  return `rgba(${r}, ${g}, ${b}, ${alpha})`;
}

/**
 * Ring around the whole prompt and a slow edge glow. Reduced motion keeps
 * the ring and does not breathe. Forced-colors mode uses the OS text color
 * so a high-contrast theme is not covered by the palette.
 * @returns {string}
 */
function promptMarkerCss() {
  const rules = PROMPT_GLOW_COLORS.filter((color) => color.id !== DEFAULT_PROMPT_GLOW).map((color) => `
.flc-needs-response[data-flc-glow="${color.id}"] {
  --flc-edge: ${color.light};
  --flc-glow: ${color.lightGlow || rgbaFromHex(color.light, 0.95)};
}`).join('');
  const darkRules = PROMPT_GLOW_COLORS.filter((color) => color.id !== DEFAULT_PROMPT_GLOW).map((color) => `
  .flc-needs-response[data-flc-glow="${color.id}"] {
    --flc-edge: ${color.dark};
    --flc-glow: ${rgbaFromHex(color.dark, 0.7)};
  }`).join('');
  const blue = PROMPT_GLOW_COLORS[0];
  return `
.flc-needs-response {
  --flc-edge: ${blue.light};
  --flc-glow: ${rgbaFromHex(blue.light, 0.95)};
  --flc-blur: calc(48px * var(--flc-strength, 1));
  --flc-spread: calc(18px * var(--flc-strength, 1));
  outline: 3px solid var(--flc-edge);
  outline-offset: 1px;
  animation: flc-prompt-breathe 2.6s ease-in-out infinite;
}
${rules}
@keyframes flc-prompt-breathe {
  0%, 100% { box-shadow: 0 0 0 2px var(--flc-edge); }
  50% { box-shadow: 0 0 0 calc(6px * var(--flc-strength, 1)) var(--flc-edge), 0 0 var(--flc-blur) var(--flc-spread) var(--flc-glow); }
}
@media (prefers-color-scheme: dark) {
  .flc-needs-response {
    --flc-edge: ${blue.dark};
    --flc-glow: ${rgbaFromHex(blue.dark, 0.7)};
    --flc-blur: calc(30px * var(--flc-strength, 1));
    --flc-spread: calc(8px * var(--flc-strength, 1));
  }
${darkRules}
}
@media (prefers-reduced-motion: reduce) {
  .flc-needs-response {
    animation: none;
    box-shadow: 0 0 0 3px var(--flc-edge);
  }
}
@media (forced-colors: active) {
  .flc-needs-response {
    animation: none;
    outline: 3px solid CanvasText;
    box-shadow: none;
    forced-color-adjust: none;
  }
}
`;
}

/** How often to look for Foundry's Application classes (ms). */
const CENTER_PROMPTS_POLL_MS = 250;
const CENTER_PROMPTS_POLL_ATTEMPTS = 40;

/**
 * Missing means on. Only an explicit false turns centering off.
 * Accepts either the stored flag or a server profile object.
 * @param {unknown} stored
 * @returns {boolean}
 */
function centerPromptsEnabled(stored) {
  if (stored && typeof stored === 'object') {
    return /** @type {{ centerPrompts?: unknown }} */ (stored).centerPrompts !== false;
  }
  return stored !== false;
}

/**
 * True for a transient prompt. Document sheets and sidebar tabs never qualify,
 * even when a module marks them modal.
 *
 * Serialised into the injected script, so it stays self-contained.
 * @param {object | null | undefined} app
 * @returns {boolean}
 */
function isShortLivedPrompt(app) {
  if (!app || typeof app !== 'object') return false;
  var doc = app.document;
  if (doc && typeof doc.uuid === 'string' && doc.uuid) return false;
  if (typeof app.tabName === 'string' && app.tabName) return false;
  var cls = '';
  if (app.constructor && typeof app.constructor.name === 'string') cls = app.constructor.name;
  if (cls === 'Dialog' || cls === 'DialogV2') return true;
  if (cls.length > 6 && cls.slice(-6) === 'Dialog') return true;
  var options = app.options;
  if (!options || typeof options !== 'object') return false;
  if (options.modal === true) return true;
  return !!(options.window && options.window.modal === true);
}

/**
 * @param {{ width?: number, height?: number } | null | undefined} viewport
 * @param {{ width?: number, height?: number } | null | undefined} size
 * @returns {{ left: number, top: number }}
 */
function centerInViewport(viewport, size) {
  var vw = viewport && typeof viewport.width === 'number' && Number.isFinite(viewport.width) ? viewport.width : 0;
  var vh = viewport && typeof viewport.height === 'number' && Number.isFinite(viewport.height) ? viewport.height : 0;
  var w = size && typeof size.width === 'number' && Number.isFinite(size.width) ? size.width : 0;
  var h = size && typeof size.height === 'number' && Number.isFinite(size.height) ? size.height : 0;
  return {
    left: Math.max(0, Math.round((vw - w) / 2)),
    top: Math.max(0, Math.round((vh - h) / 2)),
  };
}

/**
 * Body of the injected function. `window` is a free variable.
 * @param {boolean} enabled
 * @param {boolean} [highlight]
 * @param {string} [glow]
 * @param {number} [strength]
 * @returns {string}
 */
function buildCenterPromptsBody(enabled, highlight, glow, strength) {
  const flag = enabled !== false ? 'true' : 'false';
  const highlightFlag = highlight !== false ? 'true' : 'false';
  const glowId = JSON.stringify(normalizePromptGlow(glow));
  const glowIds = JSON.stringify(PROMPT_GLOW_COLORS.map((color) => color.id));
  const strengthNum = normalizePromptGlowStrength(strength);
  return `
'use strict';
window.__flcCenterPrompts = ${flag};
window.__flcPromptHighlight = ${highlightFlag};
window.__flcPromptGlow = ${glowId};
window.__flcPromptStrength = ${strengthNum};
if (window.__flcCenterPromptsArmed) {
  if (typeof window.__flcRestylePrompts === 'function') window.__flcRestylePrompts();
  return;
}
window.__flcCenterPromptsArmed = true;

${isShortLivedPrompt.toString()}
${centerInViewport.toString()}

function flcElement(app) {
  var el = app && app.element;
  if (!el) return null;
  if (el.jquery) el = el[0];
  if (el && el.nodeType === 1) return el;
  return null;
}

function flcSize(app, position) {
  var w;
  var h;
  if (position && typeof position.width === 'number') w = position.width;
  else if (app.position && typeof app.position.width === 'number') w = app.position.width;
  if (position && typeof position.height === 'number') h = position.height;
  else if (app.position && typeof app.position.height === 'number') h = app.position.height;
  var el = flcElement(app);
  if (typeof w !== 'number' && el && typeof el.offsetWidth === 'number') w = el.offsetWidth;
  if (typeof h !== 'number' && el && typeof el.offsetHeight === 'number') h = el.offsetHeight;
  return { width: typeof w === 'number' ? w : 0, height: typeof h === 'number' ? h : 0 };
}

function flcRequestAttention(app) {
  if (!isShortLivedPrompt(app) || app._flcAttentionSent) return;
  app._flcAttentionSent = true;
  var target = window;
  try {
    var el = flcElement(app);
    var doc = el && el.ownerDocument;
    var view = doc && doc.defaultView;
    if (view && view.flcGame && typeof view.flcGame.promptAttention === 'function') target = view;
  } catch (ignored) {}
  try {
    if (target.flcGame && typeof target.flcGame.promptAttention === 'function') {
      target.flcGame.promptAttention();
    }
  } catch (ignored) {}
}

function flcForgetAttention(app) {
  if (app) app._flcAttentionSent = false;
}

function flcKeepInMainWindow(app) {
  if (!app || typeof app !== 'object') return;
  try { app._disable_popout_module = true; } catch (ignored) {}
  var options = app.options;
  if (!options || typeof options !== 'object') {
    try { app.options = { popOutModuleDisable: true }; } catch (ignored) {}
    return;
  }
  var ctor = app.constructor;
  var shared = ctor && ctor.DEFAULT_OPTIONS;
  if (shared && options === shared) {
    try {
      var copy = {};
      var k;
      for (k in options) {
        if (Object.prototype.hasOwnProperty.call(options, k)) copy[k] = options[k];
      }
      copy.popOutModuleDisable = true;
      app.options = copy;
    } catch (ignored) {}
    return;
  }
  try { options.popOutModuleDisable = true; } catch (ignored) {}
}

function flcEnsurePromptStyle(doc) {
  if (!doc || typeof doc.getElementById !== 'function' || typeof doc.createElement !== 'function') return;
  if (!doc.head || typeof doc.head.appendChild !== 'function') return;
  if (doc.getElementById('flc-prompt-style')) return;
  var style = doc.createElement('style');
  style.id = 'flc-prompt-style';
  style.textContent = ${JSON.stringify(promptMarkerCss())};
  doc.head.appendChild(style);
}

function flcGlowId() {
  var id = window.__flcPromptGlow;
  var allowed = ${glowIds};
  var i;
  for (i = 0; i < allowed.length; i++) if (allowed[i] === id) return id;
  return 'blue';
}

function flcStrengthFactor() {
  var n = Number(window.__flcPromptStrength);
  if (!isFinite(n)) n = 100;
  if (n < 0) n = 0;
  if (n > 300) n = 300;
  return String(n / 100);
}

function flcApplyHighlight(el) {
  if (!el) return;
  var on = window.__flcPromptHighlight !== false;
  if (!on) {
    if (el.classList && typeof el.classList.remove === 'function') el.classList.remove('flc-needs-response');
    else if (typeof el.className === 'string') {
      el.className = el.className.split(/\\s+/).filter(function (name) {
        return name && name !== 'flc-needs-response';
      }).join(' ');
    }
    if (typeof el.removeAttribute === 'function') el.removeAttribute('data-flc-glow');
    if (el.style && typeof el.style.removeProperty === 'function') el.style.removeProperty('--flc-strength');
    return;
  }
  if (el.classList && typeof el.classList.add === 'function') el.classList.add('flc-needs-response');
  else if (typeof el.className === 'string' && (' ' + el.className + ' ').indexOf(' flc-needs-response ') < 0) {
    el.className = (el.className ? el.className + ' ' : '') + 'flc-needs-response';
  }
  if (typeof el.setAttribute === 'function') el.setAttribute('data-flc-glow', flcGlowId());
  if (el.style && typeof el.style.setProperty === 'function') el.style.setProperty('--flc-strength', flcStrengthFactor());
}

function flcTrackPrompt(app) {
  var list = window.__flcPromptApps;
  if (!list) {
    list = [];
    window.__flcPromptApps = list;
  }
  var i;
  for (i = 0; i < list.length; i++) if (list[i] === app) return;
  list.push(app);
}

function flcRestylePrompts() {
  var list = window.__flcPromptApps || [];
  var i;
  for (i = 0; i < list.length; i++) flcApplyHighlight(flcElement(list[i]));
}
window.__flcRestylePrompts = flcRestylePrompts;

function flcMarkPrompt(app) {
  if (!isShortLivedPrompt(app)) return;
  flcTrackPrompt(app);
  var el = flcElement(app);
  if (!el) return;
  flcEnsurePromptStyle(el.ownerDocument);
  flcApplyHighlight(el);
}

function flcArmDrag(app) {
  var el = flcElement(app);
  if (!el || el.__flcPromptDrag || typeof el.addEventListener !== 'function') return;
  el.__flcPromptDrag = true;
  el.addEventListener('pointerdown', function (ev) {
    if (!ev || ev.button !== 0) return;
    var target = ev.target;
    if (!target || typeof target.closest !== 'function') return;
    if (!target.closest('.window-header')) return;
    if (target.closest('.header-button, .header-control, button, a')) return;
    app._flcPromptMoved = true;
  }, true);
}

function flcWrap(proto) {
  if (!proto) return;
  if (typeof proto.setPosition === 'function' && !proto.setPosition.__flcCenterWrapped) {
    var origPos = proto.setPosition;
    var wrappedPos = function (position) {
      flcRequestAttention(this);
      flcMarkPrompt(this);
      if (window.__flcCenterPrompts && isShortLivedPrompt(this) && !this._flcPromptMoved) {
        flcKeepInMainWindow(this);
        flcArmDrag(this);
        var src = position && typeof position === 'object' ? position : {};
        var next = {};
        var k;
        for (k in src) {
          if (Object.prototype.hasOwnProperty.call(src, k)) next[k] = src[k];
        }
        var c = centerInViewport(
          { width: window.innerWidth, height: window.innerHeight },
          flcSize(this, next)
        );
        next.left = c.left;
        next.top = c.top;
        return origPos.call(this, next);
      }
      return origPos.call(this, position);
    };
    wrappedPos.__flcCenterWrapped = true;
    proto.setPosition = wrappedPos;
  }
  if (typeof proto.render === 'function' && !proto.render.__flcCenterWrapped) {
    var origRender = proto.render;
    var wrappedRender = function () {
      if (this.rendered !== true) {
        this._flcPromptMoved = false;
        flcForgetAttention(this);
      }
      if (window.__flcCenterPrompts && isShortLivedPrompt(this)) flcKeepInMainWindow(this);
      var result = origRender.apply(this, arguments);
      flcMarkPrompt(this);
      if (isShortLivedPrompt(this) && typeof window.setTimeout === 'function') {
        var marked = this;
        window.setTimeout(function () { flcMarkPrompt(marked); }, 160);
      }
      flcRequestAttention(this);
      return result;
    };
    wrappedRender.__flcCenterWrapped = true;
    proto.render = wrappedRender;
  }
  if (typeof proto.close === 'function' && !proto.close.__flcCenterWrapped) {
    var origClose = proto.close;
    var wrappedClose = function () {
      try {
        return origClose.apply(this, arguments);
      } finally {
        flcForgetAttention(this);
      }
    };
    wrappedClose.__flcCenterWrapped = true;
    proto.close = wrappedClose;
  }
}

function flcTryArm() {
  var hooked = false;
  if (window.Application && window.Application.prototype) {
    flcWrap(window.Application.prototype);
    hooked = true;
  }
  var api = window.foundry && window.foundry.applications && window.foundry.applications.api;
  if (api && api.ApplicationV2 && api.ApplicationV2.prototype) {
    flcWrap(api.ApplicationV2.prototype);
  }
  return hooked;
}

if (!flcTryArm() && typeof window.setInterval === 'function') {
  var tries = 0;
  var timer = window.setInterval(function () {
    tries += 1;
    if (flcTryArm() || tries >= ${CENTER_PROMPTS_POLL_ATTEMPTS}) {
      try { window.clearInterval(timer); } catch (ignored) {}
    }
  }, ${CENTER_PROMPTS_POLL_MS});
}
`;
}

/**
 * @param {boolean} enabled
 * @param {boolean} [highlight]
 * @param {string} [glow]
 * @returns {string}
 */
function buildCenterPromptsScript(enabled, highlight, glow, strength) {
  return `(function (window) {${buildCenterPromptsBody(enabled, highlight, glow, strength)}})(window);`;
}

module.exports = {
  CENTER_PROMPTS_POLL_MS,
  buildCenterPromptsBody,
  buildCenterPromptsScript,
  centerInViewport,
  centerPromptsEnabled,
  isKnownPromptGlow,
  isShortLivedPrompt,
  normalizePromptGlow,
  promptAutoRaiseEnabled,
  promptHighlightEnabled,
  normalizePromptGlowStrength,
  isExplicitPromptGlowStrength,
  PROMPT_GLOW_COLORS,
  promptMarkerCss,
};
