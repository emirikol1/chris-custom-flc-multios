'use strict';

/**
 * Per-session screen layout: which Foundry application windows (sheets,
 * journals, sidebar popouts, …) are open inside the game page, where they
 * are, whether they are minimized, and whether they are popped out into their
 * own OS window via the PopOut! module. Saved per server, restored on the
 * next connection, and anything not in the saved layout is closed so the
 * screen comes back exactly as it was left.
 *
 * Pure helpers + page scripts only. No Electron, no fs, so it is unit-testable.
 * Nothing in here logs; descriptors (document UUIDs, tab names, class names)
 * are written only to the user's window-state file.
 */

const MAX_ENTRIES = 40;
/** Transient prompts that must never be restored. */
const SKIP_CLASSES = new Set(['Dialog', 'DialogV2', 'Notifications', 'Tooltip']);

/**
 * @typedef {{ kind: 'document', uuid: string }
 *         | { kind: 'sidebar', tab: string }
 *         | { kind: 'app', cls: string }} Descriptor
 * @typedef {{ left?: number, top?: number, width?: number, height?: number, scale?: number }} Position
 * @typedef {Descriptor & { mode: 'window' | 'popout', pos: Position, minimized: boolean }} LayoutEntry
 */

/**
 * Validate a descriptor coming back from the page (untrusted).
 * @param {unknown} raw
 * @returns {Descriptor | null}
 */
function sanitizeDescriptor(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  if (r.kind === 'document' && typeof r.uuid === 'string') {
    const uuid = r.uuid.trim();
    return uuid && uuid.length <= 200 && /^[\w.\-]+$/.test(uuid) ? { kind: 'document', uuid } : null;
  }
  if (r.kind === 'sidebar' && typeof r.tab === 'string') {
    const tab = r.tab.trim();
    return tab && tab.length <= 40 && /^[A-Za-z][\w-]*$/.test(tab) ? { kind: 'sidebar', tab } : null;
  }
  if (r.kind === 'app' && typeof r.cls === 'string') {
    const cls = r.cls.trim();
    if (SKIP_CLASSES.has(cls)) return null;
    return cls && cls.length <= 80 && /^[A-Za-z_$][\w$]*$/.test(cls) ? { kind: 'app', cls } : null;
  }
  return null;
}

/**
 * @param {unknown} raw
 * @returns {Position}
 */
function sanitizePosition(raw) {
  /** @type {Position} */
  const out = {};
  if (!raw || typeof raw !== 'object') return out;
  const r = /** @type {Record<string, unknown>} */ (raw);
  for (const k of /** @type {const} */ (['left', 'top', 'width', 'height', 'scale'])) {
    const v = r[k];
    if (typeof v === 'number' && Number.isFinite(v)) {
      if ((k === 'width' || k === 'height') && v <= 0) continue;
      if (k === 'scale' && (v <= 0 || v > 10)) continue;
      out[k] = Math.round(v * 1000) / 1000;
    }
  }
  return out;
}

/**
 * Validate one layout entry from the page or from disk.
 * @param {unknown} raw
 * @returns {LayoutEntry | null}
 */
function sanitizeEntry(raw) {
  const desc = sanitizeDescriptor(raw);
  if (!desc) return null;
  const r = /** @type {Record<string, unknown>} */ (raw);
  return {
    ...desc,
    mode: r.mode === 'popout' ? 'popout' : 'window',
    pos: sanitizePosition(r.pos),
    minimized: r.minimized === true,
  };
}

/**
 * Stable identity string for a descriptor (used as part of window-state keys).
 * @param {Descriptor} desc
 */
function descriptorKey(desc) {
  switch (desc.kind) {
    case 'document':
      return `document:${desc.uuid}`;
    case 'sidebar':
      return `sidebar:${desc.tab}`;
    case 'app':
      return `app:${desc.cls}`;
    default:
      return 'unknown';
  }
}

/**
 * Window-state key under which a popout OS window's bounds are stored.
 * @param {string} layoutKey session layout key (e.g. "game:<serverId>")
 * @param {Descriptor} desc
 */
function popoutBoundsKey(layoutKey, desc) {
  return `${layoutKey}:popout:${descriptorKey(desc)}`;
}

/**
 * Window-state key holding the session's saved screen layout.
 * @param {string} layoutKey
 */
function layoutRecordKey(layoutKey) {
  return `${layoutKey}:layout`;
}

/**
 * @param {unknown} raw stored layout record
 * @returns {LayoutEntry[]}
 */
function readLayout(raw) {
  const list =
    raw && typeof raw === 'object' && Array.isArray(/** @type {any} */ (raw).windows)
      ? /** @type {any} */ (raw).windows
      : [];
  return dedupeEntries(list.map(sanitizeEntry).filter(Boolean));
}

/**
 * @param {LayoutEntry[]} entries
 * @returns {LayoutEntry[]}
 */
function dedupeEntries(entries) {
  /** @type {LayoutEntry[]} */
  const out = [];
  const seen = new Set();
  for (const e of entries) {
    const k = descriptorKey(e);
    if (seen.has(k)) continue;
    seen.add(k);
    out.push(e);
    if (out.length >= MAX_ENTRIES) break;
  }
  return out;
}

/**
 * Normalised fingerprint of the desktop: every display's bounds, sorted.
 * A layout is only restored onto the same desktop it was saved on.
 * @param {Array<{ bounds?: { x: number, y: number, width: number, height: number } }> | undefined} displays
 * @returns {Array<{ x: number, y: number, width: number, height: number }>}
 */
function desktopSignature(displays) {
  const out = [];
  for (const d of Array.isArray(displays) ? displays : []) {
    const b = d && d.bounds ? d.bounds : d;
    if (!b || typeof b !== 'object') continue;
    const { x, y, width, height } = /** @type {any} */ (b);
    if ([x, y, width, height].every((v) => typeof v === 'number' && Number.isFinite(v))) {
      out.push({ x: Math.round(x), y: Math.round(y), width: Math.round(width), height: Math.round(height) });
    }
  }
  out.sort((a, b) => a.x - b.x || a.y - b.y || a.width - b.width || a.height - b.height);
  return out;
}

/**
 * @param {unknown} a
 * @param {unknown} b
 */
function sameDesktop(a, b) {
  const sa = desktopSignature(/** @type {any} */ (a));
  const sb = desktopSignature(/** @type {any} */ (b));
  return sa.length > 0 && JSON.stringify(sa) === JSON.stringify(sb);
}

/**
 * Turn a raw page snapshot into a storable record, or null if unusable.
 * @param {unknown} raw result of SNAPSHOT_LAYOUT_SCRIPT
 * @param {{ now?: () => string, displays?: unknown[] }} [opts]
 * @returns {{ windows: LayoutEntry[], savedAt: string, desktop: ReturnType<typeof desktopSignature> } | null}
 */
function layoutRecordFromSnapshot(raw, opts = {}) {
  if (!Array.isArray(raw)) return null;
  const windows = dedupeEntries(raw.map(sanitizeEntry).filter(Boolean));
  const now = typeof opts.now === 'function' ? opts.now : () => new Date().toISOString();
  return { windows, savedAt: now(), desktop: desktopSignature(/** @type {any} */ (opts.displays)) };
}

/**
 * @param {LayoutEntry[]} layout
 * @param {Descriptor} desc
 * @returns {LayoutEntry[]}
 */
function removeEntry(layout, desc) {
  const k = descriptorKey(desc);
  return layout.filter((e) => descriptorKey(e) !== k);
}

/**
 * Cheap structural equality used to avoid rewriting an unchanged layout.
 * @param {{ windows: LayoutEntry[] } | null | undefined} a
 * @param {{ windows: LayoutEntry[] } | null | undefined} b
 */
function sameLayout(a, b) {
  const wa = a && Array.isArray(a.windows) ? a.windows : [];
  const wb = b && Array.isArray(b.windows) ? b.windows : [];
  return JSON.stringify(wa) === JSON.stringify(wb);
}

/** Shared page-side helper: describe a Foundry Application. */
const DESCRIBE_FN = `function describeApp(app) {
    if (!app) return null;
    var cls = app.constructor && app.constructor.name ? String(app.constructor.name) : '';
    if (typeof app.tabName === 'string' && app.tabName) return { kind: 'sidebar', tab: app.tabName };
    var doc = app.document || (app.object && app.object.documentName ? app.object : null);
    if (doc && typeof doc.uuid === 'string' && doc.uuid) return { kind: 'document', uuid: doc.uuid };
    return cls ? { kind: 'app', cls: cls } : null;
  }`;

/** Shared page-side helper: find a Foundry Application from a descriptor (async). */
const RESOLVE_FN = `async function resolveApp(desc) {
    if (desc.kind === 'document') {
      var doc = await fromUuid(desc.uuid);
      if (!doc) return { reason: 'not_found' };
      var sheet = doc.sheet;
      return sheet ? { app: sheet } : { reason: 'no_sheet' };
    }
    if (desc.kind === 'sidebar') {
      var tab = window.ui && ui[desc.tab];
      if (!tab) return { reason: 'not_found' };
      if (typeof tab.renderPopout === 'function') {
        var p = tab.renderPopout();
        if (p && typeof p.then === 'function') p = await p;
        var inst = (p && typeof p === 'object' && p.render) ? p : (tab._popout || tab.popout || null);
        return { app: inst || tab, rendered: true };
      }
      return { app: tab };
    }
    if (desc.kind === 'app') {
      var uiObj = window.ui || {};
      for (var k in uiObj) {
        var cand = uiObj[k];
        if (cand && cand.constructor && cand.constructor.name === desc.cls) return { app: cand };
      }
      return { reason: 'not_found' };
    }
    return { reason: 'unknown_kind' };
  }`;

/**
 * Runs in the game window. Returns an array of layout entries for every open
 * floating application window (v1 `ui.windows` and positioned AppV2
 * instances), or null if the game is not ready.
 */
const SNAPSHOT_LAYOUT_SCRIPT = `(function () {
  ${DESCRIBE_FN}
  function num(v) { return (typeof v === 'number' && isFinite(v)) ? v : undefined; }
  try {
    if (!window.game || game.ready !== true) return null;
    var mod = window.PopoutModule && window.PopoutModule.singleton;
    var out = [];
    var seen = {};
    function push(app) {
      var d = describeApp(app);
      if (!d) return;
      var appId = (app.appId !== undefined && app.appId !== null) ? app.appId : app.id;
      var popped = !!(mod && mod.poppedOut && mod.poppedOut.has && mod.poppedOut.has(appId));
      var rendered = app.rendered === true || (app.element && (app.element.jquery ? app.element.length > 0 : true));
      if (!rendered && !popped) return;
      var key = d.kind + ':' + (d.uuid || d.tab || d.cls);
      if (seen[key]) return;
      seen[key] = true;
      var p = app.position || {};
      out.push({
        kind: d.kind, uuid: d.uuid, tab: d.tab, cls: d.cls,
        mode: popped ? 'popout' : 'window',
        pos: { left: num(p.left), top: num(p.top), width: num(p.width), height: num(p.height), scale: num(p.scale) },
        minimized: !!(app._minimized || app.minimized === true)
      });
    }
    if (window.ui && ui.windows) {
      var w = ui.windows;
      for (var id in w) push(w[id]);
    }
    var inst = window.foundry && foundry.applications && foundry.applications.instances;
    if (inst && typeof inst.values === 'function') {
      var it = inst.values();
      for (var s = it.next(); !s.done; s = it.next()) {
        var app = s.value;
        var wo = app && app.options && app.options.window;
        if (!wo || wo.frame === false || wo.positioned === false) continue;
        push(app);
      }
    }
    return out;
  } catch (e) {
    return null;
  }
})()`;

/**
 * Runs inside a popout OS window. Finds the PopOut! state whose window is this
 * one and returns a descriptor of the popped-out Application, or null.
 */
const IDENTIFY_POPOUT_SCRIPT = `(function () {
  ${DESCRIBE_FN}
  try {
    var root = window._rootWindow || window.opener;
    var mod = root && root.PopoutModule && root.PopoutModule.singleton;
    if (!mod || !mod.poppedOut || typeof mod.poppedOut.values !== 'function') return null;
    var it = mod.poppedOut.values();
    for (var step = it.next(); !step.done; step = it.next()) {
      var state = step.value;
      if (state && state.window === window) return describeApp(state.app);
    }
    return null;
  } catch (e) {
    return null;
  }
})()`;

/** Runs in the game window: is Foundry fully ready, and is PopOut! initialised? */
const GAME_READY_SCRIPT = `(function () {
  try {
    var g = window.game;
    if (!g || g.ready !== true) return { ready: false };
    var mod = window.PopoutModule && window.PopoutModule.singleton;
    return { ready: true, popout: !!(mod && mod.poppedOut) };
  } catch (e) {
    return { ready: false };
  }
})()`;

/**
 * Build the script that restores one layout entry inside the game window.
 * Resolves to { ok: true } | { ok: false, reason }.
 * Reasons: not_found, no_sheet, unknown_kind, render_failed, no_popout_module, exception.
 * @param {LayoutEntry} entry
 */
function buildRestoreScript(entry) {
  const json = JSON.stringify(sanitizeEntry(entry));
  return `(async function (entry) {
  ${RESOLVE_FN}
  try {
    if (!entry) return { ok: false, reason: 'unknown_kind' };
    var mod = window.PopoutModule && window.PopoutModule.singleton;
    if (entry.mode === 'popout' && !(mod && typeof mod.onPopoutClicked === 'function')) {
      return { ok: false, reason: 'no_popout_module' };
    }
    var res = await resolveApp(entry);
    if (!res.app) return { ok: false, reason: res.reason || 'not_found' };
    var app = res.app;
    var appId = (app.appId !== undefined && app.appId !== null) ? app.appId : app.id;
    if (entry.mode === 'popout' && mod.poppedOut && mod.poppedOut.has && mod.poppedOut.has(appId)) {
      return { ok: true, already: true };
    }
    if (!res.rendered) {
      try {
        var r = app.render(true);
        if (r && typeof r.then === 'function') await r;
      } catch (e) {
        return { ok: false, reason: 'render_failed' };
      }
    }
    var t0 = Date.now();
    while (Date.now() - t0 < 8000) {
      var el = app.element;
      var node = el && (el.jquery ? el[0] : el);
      if (node && node.isConnected) break;
      await new Promise(function (r2) { setTimeout(r2, 100); });
    }
    if (entry.mode === 'popout') {
      mod.onPopoutClicked(app);
      var ok = !!(mod.poppedOut && mod.poppedOut.has && mod.poppedOut.has(appId));
      return ok ? { ok: true } : { ok: false, reason: 'render_failed' };
    }
    var pos = {};
    var p = entry.pos || {};
    if (typeof p.left === 'number') pos.left = p.left;
    if (typeof p.top === 'number') pos.top = p.top;
    if (typeof p.width === 'number') pos.width = p.width;
    if (typeof p.height === 'number') pos.height = p.height;
    if (typeof p.scale === 'number') pos.scale = p.scale;
    try { if (typeof app.setPosition === 'function' && Object.keys(pos).length) app.setPosition(pos); } catch (e) {}
    try { if (entry.minimized && typeof app.minimize === 'function') await app.minimize(); } catch (e) {}
    return { ok: true };
  } catch (e) {
    return { ok: false, reason: 'exception' };
  }
})(${json})`;
}

/**
 * Build the script that closes every in-page floating window that is NOT in
 * the saved layout. Resolves to the number of windows closed.
 * @param {LayoutEntry[]} keep
 */
function buildCloseUnlistedScript(keep) {
  const keys = JSON.stringify(keep.map(descriptorKey));
  return `(async function (keepKeys) {
  ${DESCRIBE_FN}
  var keep = {};
  for (var i = 0; i < keepKeys.length; i++) keep[keepKeys[i]] = true;
  var closed = 0;
  var skip = { Dialog: 1, DialogV2: 1, Notifications: 1, Tooltip: 1 };
  async function maybeClose(app) {
    try {
      if (!app || typeof app.close !== 'function') return;
      var cls = app.constructor && app.constructor.name;
      if (cls && skip[cls]) return;
      var d = describeApp(app);
      if (!d) return;
      var key = d.kind + ':' + (d.uuid || d.tab || d.cls);
      if (keep[key]) return;
      var r = app.close();
      if (r && typeof r.then === 'function') await r;
      closed++;
    } catch (e) {}
  }
  try {
    var list = [];
    if (window.ui && ui.windows) { var w = ui.windows; for (var id in w) list.push(w[id]); }
    var inst = window.foundry && foundry.applications && foundry.applications.instances;
    if (inst && typeof inst.values === 'function') {
      var it = inst.values();
      for (var s = it.next(); !s.done; s = it.next()) {
        var app = s.value;
        var wo = app && app.options && app.options.window;
        if (!wo || wo.frame === false || wo.positioned === false) continue;
        list.push(app);
      }
    }
    for (var j = 0; j < list.length; j++) await maybeClose(list[j]);
  } catch (e) {}
  return closed;
})(${keys})`;
}

/**
 * Should a failed restore drop the entry from the saved layout?
 * Objects that no longer exist are forgotten; transient problems are retried next time.
 * @param {string} reason
 */
function shouldForgetOnFailure(reason) {
  return reason === 'not_found' || reason === 'no_sheet' || reason === 'unknown_kind';
}

module.exports = {
  MAX_ENTRIES,
  sanitizeDescriptor,
  sanitizePosition,
  sanitizeEntry,
  descriptorKey,
  popoutBoundsKey,
  layoutRecordKey,
  readLayout,
  desktopSignature,
  sameDesktop,
  layoutRecordFromSnapshot,
  removeEntry,
  sameLayout,
  SNAPSHOT_LAYOUT_SCRIPT,
  IDENTIFY_POPOUT_SCRIPT,
  GAME_READY_SCRIPT,
  buildRestoreScript,
  buildCloseUnlistedScript,
  shouldForgetOnFailure,
};
