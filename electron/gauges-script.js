'use strict';

/**
 * Page script for the join fuel gauges. The returned string is ES5 and is
 * safe to append to the loading-details injection or to run on its own at
 * dom-ready. Caller options are ignored so nothing from main is interpolated.
 */

const { GAUGES } = require('./join-gauges');

/**
 * @returns {string}
 */
function gaugeLiteral() {
  const parts = [];
  for (let i = 0; i < GAUGES.length; i += 1) {
    const gauge = GAUGES[i];
    if (!/^[a-z]{1,16}$/.test(gauge.id) || !/^[A-Za-z ]{1,24}$/.test(gauge.shortLabel)) {
      throw new Error('Bad gauge label');
    }
    parts.push(`{id:'${gauge.id}',label:'${gauge.shortLabel}'}`);
  }
  return parts.join(',');
}

/**
 * Install window.__flcGauges on the Foundry page.
 * @param {object} [options] ignored
 * @returns {string}
 */
function buildGaugesScript(options) {
  void options;
  const gauges = gaugeLiteral();
  return `(function () {
  'use strict';
  try {
    if (window.__flcGauges) return;
    var NS = 'http://www.w3.org/2000/svg';
    var G = [${gauges}];
    var TAU = 400;
    var RED = '#d9372b';
    var AMBER = '#e0a100';
    var GREEN = '#2fb344';
    // Car fuel gauge sweep: centre (48,40) r=30, starts at ~8 o'clock (240deg
    // clockwise from 12), sweeps clockwise over the top, ends at 3 o'clock
    // (90deg). 210deg of arc, so large-arc 1, sweep 1 in SVG y-down coords.
    var ARC = 'M 22.02 55 A 30 30 0 1 1 78 40';
    // Ids come from G, the same records that stamp each dial's label.
    // Cache hit % is a ratio, so it stays out of the overall progress average.
    var KEYS = [];
    var PROGRESS_KEYS = [];
    var targets = {};
    var shown = {};
    var expectText = {};
    var keyi = 0;
    var keyId = '';
    for (keyi = 0; keyi < G.length; keyi++) {
      keyId = G[keyi].id;
      KEYS.push(keyId);
      if (keyId !== 'cache') PROGRESS_KEYS.push(keyId);
      targets[keyId] = keyId === 'cache' ? null : 0;
      shown[keyId] = keyId === 'cache' ? null : 0;
      expectText[keyId] = '';
    }
    var LED_H = 56;
    // Below this row width the five dials no longer fit on one line.
    var NARROW_W = 520;
    var HYST = 24;
    var led = null;
    var sizer = null;
    var narrow = false;
    var slots = [];
    var observer = null;
    var watching = false;
    var watchTarget = null;
    var placedRoot = null;
    var busy = false;
    var destroyed = false;
    var seenOverlay = false;
    var rafId = 0;
    var haveTs = false;
    var lastTs = 0;

    function hexToRgb(hex) {
      var n = parseInt(hex.slice(1), 16);
      return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
    }

    function rgbToHsl(r, g, b) {
      var max;
      var min;
      var l;
      var d;
      var s;
      var h;
      r = r / 255;
      g = g / 255;
      b = b / 255;
      max = Math.max(r, g, b);
      min = Math.min(r, g, b);
      l = (max + min) / 2;
      if (max === min) return [0, 0, l];
      d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      return [h * 60, s, l];
    }

    function hslToRgb(h, s, l) {
      var c = (1 - Math.abs(2 * l - 1)) * s;
      var hp = (((h % 360) + 360) % 360) / 60;
      var x = c * (1 - Math.abs((hp % 2) - 1));
      var r = 0;
      var g = 0;
      var b = 0;
      var m = 0;
      if (hp < 1) { r = c; g = x; }
      else if (hp < 2) { r = x; g = c; }
      else if (hp < 3) { g = c; b = x; }
      else if (hp < 4) { g = x; b = c; }
      else if (hp < 5) { r = x; b = c; }
      else { r = c; b = x; }
      m = l - c / 2;
      return [Math.round((r + m) * 255), Math.round((g + m) * 255), Math.round((b + m) * 255)];
    }

    function hexByte(n) {
      var s = n.toString(16);
      return s.length < 2 ? '0' + s : s;
    }

    function lerpHex(from, to, t) {
      var fromRgb = hexToRgb(from);
      var toRgb = hexToRgb(to);
      var a = rgbToHsl(fromRgb[0], fromRgb[1], fromRgb[2]);
      var b = rgbToHsl(toRgb[0], toRgb[1], toRgb[2]);
      var hueDelta = b[0] - a[0];
      var hue = 0;
      var sat = 0;
      var light = 0;
      var rgb = null;
      if (hueDelta > 180) hueDelta -= 360;
      if (hueDelta < -180) hueDelta += 360;
      hue = (a[0] + hueDelta * t + 360) % 360;
      sat = a[1] + (b[1] - a[1]) * t;
      light = a[2] + (b[2] - a[2]) * t;
      rgb = hslToRgb(hue, sat, light);
      return '#' + hexByte(rgb[0]) + hexByte(rgb[1]) + hexByte(rgb[2]);
    }

    function gaugeColor(fill) {
      var t = fill;
      if (typeof t !== 'number' || !isFinite(t) || t <= 0) return RED;
      if (t >= 1) return GREEN;
      if (t > 0.499999 && t < 0.500001) return AMBER;
      if (t < 0.5) return lerpHex(RED, AMBER, t / 0.5);
      return lerpHex(AMBER, GREEN, (t - 0.5) / 0.5);
    }

    function reduced() {
      try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
      } catch (e) {}
      return false;
    }

    function clamp01(value) {
      if (typeof value !== 'number' || !isFinite(value)) return null;
      if (value < 0) return 0;
      if (value > 1) return 1;
      return value;
    }

    function requestFrame(fn) {
      try {
        if (window.requestAnimationFrame) return window.requestAnimationFrame(fn);
      } catch (e) {}
      try { return setTimeout(function () { fn(16); }, 16); } catch (e2) {}
      return 0;
    }

    function cancelFrame(id) {
      try {
        if (window.cancelAnimationFrame) window.cancelAnimationFrame(id);
      } catch (e) {}
      try { clearTimeout(id); } catch (e2) {}
    }

    function cssText() {
      return '#flc-gauges{box-sizing:border-box;display:flex;flex-wrap:wrap;justify-content:center;align-content:center;align-items:flex-start;gap:2px 10px;height:96px;margin:0 0 8px;padding:0 8px;pointer-events:none;container-type:inline-size;font-family:inherit;color:#f4f1ea}'
        + '#flc-gauges .flc-g-item{width:92px;height:88px;display:flex;flex-direction:column;align-items:center;justify-content:flex-end}'
        + '#flc-gauges .flc-g-svg{width:72px;height:57px;display:block;overflow:visible}'
        + '#flc-gauges .flc-g-track{fill:none;stroke:rgba(255,255,255,.22);stroke-width:6;stroke-linecap:round}'
        + '#flc-gauges .flc-g-fill{fill:none;stroke-width:6;stroke-linecap:round}'
        + '#flc-gauges .flc-g-pct{font:700 13px/1 sans-serif;text-anchor:middle}'
        + '#flc-gauges .flc-g-label{margin-top:1px;font:600 10px/1.2 sans-serif;letter-spacing:.06em;text-transform:uppercase;color:rgba(244,241,234,.78)}'
        + '#flc-gauges .flc-g-expect{height:12px;min-height:12px;font:600 10px/1 sans-serif;color:rgba(244,241,234,.55);font-variant-numeric:tabular-nums}'
        + '#flc-gauges .flc-g-unknown .flc-g-track{stroke:rgba(255,255,255,.38);stroke-dasharray:2 5}'
        + '#flc-gauges .flc-g-unknown .flc-g-pct{fill:#c8c2b4}'
        // Narrow card: the dials give way to one LED-style completion readout
        // that scales with the container (container-query units, vw fallback).
        + '#flc-gauges .flc-g-led{display:none;position:relative;align-items:baseline;justify-content:center;width:100%;height:100%;font:700 clamp(18px,13cqw,46px)/1 "DejaVu Sans Mono","Menlo","Consolas",monospace;letter-spacing:.06em;font-variant-numeric:tabular-nums}'
        + '#flc-gauges .flc-g-led-ghost{position:absolute;left:0;right:0;text-align:center;color:rgba(255,255,255,.07);pointer-events:none}'
        + '#flc-gauges .flc-g-led-val{position:relative;text-align:center}'
        + '#flc-gauges .flc-g-led-cap{font:600 clamp(8px,2.6cqw,11px)/1 sans-serif;letter-spacing:.14em;text-transform:uppercase;color:rgba(244,241,234,.6);margin-left:.6em}'
        + '#flc-gauges.flc-g-narrow{height:' + LED_H + 'px;padding:0 4px}#flc-gauges.flc-g-narrow .flc-g-item{display:none}#flc-gauges.flc-g-narrow .flc-g-led{display:flex}'
        + '@media (max-width:' + NARROW_W + 'px){#flc-gauges{height:' + LED_H + 'px;padding:0 4px}#flc-gauges .flc-g-item{display:none}#flc-gauges .flc-g-led{display:flex}}'
        + '@media (prefers-reduced-motion:reduce){#flc-gauges .flc-g-fill{transition:none}}';
    }

    function ensureStyle() {
      var node = null;
      try { node = document.getElementById('flc-g-style'); } catch (e) { node = null; }
      if (node) return;
      node = document.createElement('style');
      node.setAttribute('id', 'flc-g-style');
      node.textContent = cssText();
      if (document.head) document.head.appendChild(node);
      else if (document.documentElement) document.documentElement.appendChild(node);
    }

    function makeGauge(def, row) {
      var item = document.createElement('div');
      var svg = document.createElementNS(NS, 'svg');
      var track = document.createElementNS(NS, 'path');
      var fill = document.createElementNS(NS, 'path');
      var text = document.createElementNS(NS, 'text');
      var label = document.createElement('div');
      var expect = document.createElement('div');
      item.setAttribute('class', 'flc-g-item');
      item.setAttribute('data-gauge', def.id);
      svg.setAttribute('class', 'flc-g-svg');
      svg.setAttribute('viewBox', '14 6 68 54');
      svg.setAttribute('aria-hidden', 'true');
      track.setAttribute('class', 'flc-g-track');
      track.setAttribute('d', ARC);
      track.setAttribute('pathLength', '1');
      fill.setAttribute('class', 'flc-g-fill');
      fill.setAttribute('d', ARC);
      fill.setAttribute('pathLength', '1');
      text.setAttribute('class', 'flc-g-pct');
      text.setAttribute('x', '48');
      text.setAttribute('y', '45');
      text.setAttribute('text-anchor', 'middle');
      label.setAttribute('class', 'flc-g-label');
      label.textContent = def.label;
      expect.setAttribute('class', 'flc-g-expect');
      expect.textContent = expectText[def.id] || '';
      svg.appendChild(track);
      svg.appendChild(fill);
      svg.appendChild(text);
      item.appendChild(svg);
      item.appendChild(label);
      item.appendChild(expect);
      row.appendChild(item);
      return { id: def.id, label: def.label, nameEl: label, item: item, fill: fill, text: text, expect: expect };
    }

    function makeLed(row) {
      var wrap = document.createElement('div');
      var ghost = document.createElement('span');
      var val = document.createElement('span');
      var cap = document.createElement('span');
      wrap.setAttribute('class', 'flc-g-led');
      wrap.setAttribute('aria-hidden', 'true');
      ghost.setAttribute('class', 'flc-g-led-ghost');
      ghost.textContent = '888%';
      val.setAttribute('class', 'flc-g-led-val');
      val.textContent = '0%';
      cap.setAttribute('class', 'flc-g-led-cap');
      cap.textContent = 'loaded';
      wrap.appendChild(ghost);
      wrap.appendChild(val);
      wrap.appendChild(cap);
      row.appendChild(wrap);
      return { wrap: wrap, val: val };
    }

    function makeRow() {
      var row = document.createElement('div');
      var i = 0;
      row.setAttribute('id', 'flc-gauges');
      slots = [];
      for (i = 0; i < G.length; i++) slots.push(makeGauge(G[i], row));
      led = makeLed(row);
      return row;
    }

    function overallFill() {
      var i = 0;
      var sum = 0;
      var n = 0;
      var v = 0;
      for (i = 0; i < PROGRESS_KEYS.length; i++) {
        v = shown[PROGRESS_KEYS[i]];
        if (typeof v !== 'number' || !isFinite(v)) v = 0;
        sum += v;
        n += 1;
      }
      return n ? sum / n : 0;
    }

    function paintLed() {
      var fill = 0;
      var color = RED;
      if (!led || !led.val) return;
      fill = overallFill();
      color = gaugeColor(fill);
      led.val.textContent = Math.round(fill * 100) + '%';
      led.val.style.color = color;
      led.val.style.textShadow = '0 0 6px ' + color + ', 0 0 16px ' + color;
    }

    function paint() {
      var i = 0;
      var slot = null;
      var id = '';
      var value = 0;
      var unknown = false;
      var text = '';
      var color = RED;
      var dash = '0 1';
      for (i = 0; i < slots.length; i++) {
        slot = slots[i];
        id = slot.id;
        value = shown[id];
        unknown = id === 'cache' && (value == null || typeof value !== 'number' || !isFinite(value));
        if (unknown) {
          text = '\\u2014';
          color = '#c8c2b4';
          dash = '0 1';
          slot.item.setAttribute('class', 'flc-g-item flc-g-unknown');
          try { slot.fill.style.filter = 'none'; } catch (e0) {}
        } else {
          if (typeof value !== 'number' || !isFinite(value)) value = 0;
          text = Math.round(value * 100) + '%';
          color = gaugeColor(value);
          dash = value + ' 1';
          slot.item.setAttribute('class', 'flc-g-item');
          try { slot.fill.style.filter = 'drop-shadow(0 0 2px ' + color + ')'; } catch (e1) {}
        }
        slot.fill.setAttribute('stroke', color);
        slot.fill.setAttribute('stroke-dasharray', dash);
        slot.fill.setAttribute('stroke-dashoffset', '0');
        slot.text.textContent = text;
        slot.text.setAttribute('fill', color);
        if (slot.nameEl) slot.nameEl.textContent = slot.label;
        slot.item.setAttribute('aria-label', slot.label + ' ' + text);
      }
      try { paintLed(); } catch (e2) {}
    }

    function hasClassLike(el, word) {
      var cls = '';
      try { cls = (el.getAttribute('class') || '') + ' ' + (el.id || ''); } catch (e) { cls = ''; }
      return cls.toLowerCase().indexOf(word) !== -1;
    }

    function overlayRoot() {
      var root = null;
      var hide = null;
      var list = null;
      var i = 0;
      var el = null;
      var depth = 0;
      try { root = document.getElementById('fvtt-loading-progress'); } catch (e) { root = null; }
      if (root) return root;
      // Generic join overlay: an a/button reading "Hide" under an ancestor named *load*.
      try { list = document.querySelectorAll('a, button'); } catch (e2) { list = null; }
      if (!list) return null;
      for (i = 0; i < list.length && i < 400; i++) {
        hide = list[i];
        if (!hide || (hide.textContent || '').replace(/\\s+/g, '') !== 'Hide') continue;
        el = hide.parentNode;
        depth = 0;
        while (el && el !== document.body && depth < 8) {
          if (el.nodeType === 1 && hasClassLike(el, 'load')) return el;
          el = el.parentNode;
          depth += 1;
        }
      }
      return null;
    }

    function overlayFinished(root) {
      if (!root) return true;
      if (!document.body || !document.body.contains(root)) return true;
      return hasClassLike(root, 'finished');
    }

    function findTrack(root) {
      var bar = null;
      var sel = ['.flp-track', '[role="progressbar"]', 'progress', '[class*="track"]', '[class*="progress-bar"]', '[class*="bar"]'];
      var i = 0;
      for (i = 0; i < sel.length; i++) {
        try { bar = root.querySelector(sel[i]); } catch (e) { bar = null; }
        if (bar && bar.parentNode && bar !== root) return bar;
      }
      return null;
    }

    function findAnchor() {
      var root = overlayRoot();
      var loading = null;
      var bar = null;
      var ctx = null;
      if (root) {
        if (overlayFinished(root)) return null;
        bar = findTrack(root);
        if (bar) return bar;
      }
      // Foundry's own full-page loader. Never the small in-game #ui-top indicator.
      try { loading = document.querySelector('#loading'); } catch (e) { loading = null; }
      if (!loading || !loading.querySelector) return null;
      try { if (loading.closest && loading.closest('#ui-top, #interface, #ui-middle')) return null; } catch (e1) {}
      try { bar = loading.querySelector('#loading-bar'); } catch (e2) { bar = null; }
      if (bar && bar.parentNode) return bar;
      try { ctx = loading.querySelector('#context'); } catch (e3) { ctx = null; }
      if (ctx && ctx.parentNode) return ctx;
      return null;
    }

    function applyWidth(width) {
      var row = null;
      var next = narrow;
      if (typeof width !== 'number' || !isFinite(width) || width <= 0) return;
      // Hysteresis: must cross the threshold by HYST to flip, so a window
      // being dragged at the edge cannot flicker between modes.
      if (!narrow && width < NARROW_W - HYST) next = true;
      else if (narrow && width > NARROW_W + HYST) next = false;
      if (next === narrow) return;
      narrow = next;
      try { row = document.getElementById('flc-gauges'); } catch (e) { row = null; }
      if (!row) return;
      try {
        if (narrow) row.setAttribute('class', 'flc-g-narrow');
        else row.removeAttribute('class');
      } catch (e2) {}
      try { paint(); } catch (e3) {}
    }

    function watchSize(row) {
      var rect = null;
      if (!row) return;
      try { rect = row.getBoundingClientRect(); } catch (e) { rect = null; }
      if (rect) applyWidth(rect.width);
      if (sizer || typeof ResizeObserver !== 'function') return;
      try {
        sizer = new ResizeObserver(function (entries) {
          var i = 0;
          if (destroyed) return;
          for (i = 0; i < entries.length; i++) {
            if (entries[i] && entries[i].contentRect) applyWidth(entries[i].contentRect.width);
          }
        });
        sizer.observe(row);
      } catch (e2) { sizer = null; }
    }

    function unmountRow() {
      var row = null;
      try { row = document.getElementById('flc-gauges'); } catch (e) { row = null; }
      if (row && row.parentNode) {
        busy = true;
        try { row.parentNode.removeChild(row); } catch (e2) {}
        busy = false;
      }
    }

    function attachWatch(target) {
      if (!observer || !target || watchTarget === target) return;
      try { observer.disconnect(); } catch (e0) {}
      try {
        observer.observe(target, { childList: true, subtree: true });
        watching = true;
        watchTarget = target;
      } catch (e1) {
        watching = false;
        watchTarget = null;
      }
    }

    // Same rule as the loading banner: do not watch class changes on body.
    // After the overlay is mounted, only its child list is observed.
    function watch() {
      if (!document.body || typeof MutationObserver !== 'function') return;
      if (!observer) {
        observer = new MutationObserver(function () {
          if (busy || destroyed) return;
          try { mount(); } catch (e) {}
        });
      }
      if (placedRoot) {
        attachWatch(placedRoot);
        return;
      }
      attachWatch(document.body);
    }

    function mount() {
      var anchor = null;
      var existing = null;
      destroyed = false;
      try { ensureStyle(); } catch (e0) {}
      try { watch(); } catch (e1) {}
      anchor = findAnchor();
      if (!anchor) {
        // Overlay finished (join done): tear everything down so nothing lingers
        // in the game UI and the observer stops costing anything.
        if (seenOverlay && overlayFinished(overlayRoot())) { destroy(); return false; }
        try { unmountRow(); } catch (e9) {}
        return false;
      }
      seenOverlay = true;
      placedRoot = overlayRoot();
      if (!placedRoot) {
        try { placedRoot = document.getElementById('loading'); } catch (eRoot) { placedRoot = null; }
      }
      if (!placedRoot && anchor.parentNode && anchor.parentNode.nodeType === 1) placedRoot = anchor.parentNode;
      try { watch(); } catch (eWatch) {}
      try { existing = document.getElementById('flc-gauges'); } catch (e2) { existing = null; }
      if (existing && existing.parentNode === anchor.parentNode && existing.nextSibling === anchor) return true;
      if (!existing) existing = makeRow();
      busy = true;
      try { anchor.parentNode.insertBefore(existing, anchor); }
      catch (e3) { busy = false; return false; }
      busy = false;
      try { paint(); } catch (e4) {}
      try { watchSize(existing); } catch (e5) {}
      return true;
    }

    function snap() {
      var i = 0;
      var id = '';
      for (i = 0; i < KEYS.length; i++) {
        id = KEYS[i];
        shown[id] = targets[id];
      }
    }

    function approach(cur, target, dt) {
      var k = 1 - Math.exp(-dt / TAU);
      if (!(k > 0)) k = 0;
      if (k > 1) k = 1;
      return cur + (target - cur) * k;
    }

    function frame(ts) {
      var dt = 16;
      var i = 0;
      var id = '';
      var moving = false;
      var next = 0;
      var goal = 0;
      rafId = 0;
      if (destroyed) return;
      if (haveTs) dt = ts - lastTs;
      haveTs = true;
      lastTs = ts;
      if (!(dt > 0)) dt = 16;
      if (dt > 80) dt = 80;
      if (reduced()) {
        snap();
        try { paint(); } catch (e0) {}
        return;
      }
      for (i = 0; i < KEYS.length; i++) {
        id = KEYS[i];
        goal = targets[id];
        if (id === 'cache' && (goal == null || typeof goal !== 'number')) {
          shown.cache = null;
          continue;
        }
        if (shown[id] == null || typeof shown[id] !== 'number') shown[id] = 0;
        next = approach(shown[id], goal, dt);
        if (next < shown[id]) next = shown[id];
        if (Math.abs(goal - next) < 0.004) next = goal;
        shown[id] = next;
        if (Math.abs(goal - shown[id]) > 0.001) moving = true;
      }
      try { paint(); } catch (e1) {}
      if (moving) rafId = requestFrame(frame);
    }

    function kick() {
      if (destroyed) return;
      if (reduced()) {
        snap();
        try { paint(); } catch (e) {}
        return;
      }
      if (rafId) return;
      haveTs = false;
      rafId = requestFrame(frame);
    }

    function setFills(partial) {
      var i = 0;
      var key = '';
      var value = null;
      if (destroyed || !partial || typeof partial !== 'object') return;
      for (i = 0; i < KEYS.length; i++) {
        key = KEYS[i];
        if (!Object.prototype.hasOwnProperty.call(partial, key)) continue;
        if (key === 'cache' && partial[key] === null) continue;
        value = clamp01(partial[key]);
        if (value == null) continue;
        if (targets[key] == null || value > targets[key]) targets[key] = value;
      }
      kick();
    }

    function cleanExpect(value) {
      var text = '';
      if (typeof value === 'number' && isFinite(value)) text = String(Math.round(value));
      else if (typeof value === 'string') text = value;
      else return '';
      if (!/^[0-9][0-9, .%]{0,15}$/.test(text)) return '';
      return text;
    }

    function slotById(id) {
      var i = 0;
      for (i = 0; i < slots.length; i++) {
        if (slots[i] && slots[i].id === id) return slots[i];
      }
      return null;
    }

    function setExpectedLabels(labels) {
      var i = 0;
      var key = '';
      var slot = null;
      if (!labels || typeof labels !== 'object') return;
      for (i = 0; i < KEYS.length; i++) {
        key = KEYS[i];
        if (!Object.prototype.hasOwnProperty.call(labels, key)) continue;
        expectText[key] = cleanExpect(labels[key]);
        slot = slotById(key);
        if (slot && slot.expect) slot.expect.textContent = expectText[key] || '';
      }
    }

    function resetNumbers() {
      var i = 0;
      var id = '';
      for (i = 0; i < KEYS.length; i++) {
        id = KEYS[i];
        targets[id] = id === 'cache' ? null : 0;
        shown[id] = id === 'cache' ? null : 0;
        expectText[id] = '';
      }
    }

    function destroy() {
      var row = null;
      var style = null;
      destroyed = true;
      if (rafId) {
        cancelFrame(rafId);
        rafId = 0;
      }
      if (observer) {
        try { observer.disconnect(); } catch (e) {}
      }
      if (sizer) {
        try { sizer.disconnect(); } catch (e1) {}
        sizer = null;
      }
      narrow = false;
      led = null;
      watching = false;
      watchTarget = null;
      placedRoot = null;
      try { row = document.getElementById('flc-gauges'); } catch (e2) { row = null; }
      if (row && row.parentNode) {
        try { row.parentNode.removeChild(row); } catch (e3) {}
      }
      try { style = document.getElementById('flc-g-style'); } catch (e4) { style = null; }
      if (style && style.parentNode) {
        try { style.parentNode.removeChild(style); } catch (e5) {}
      }
      slots = [];
      resetNumbers();
    }

    window.__flcGauges = {
      version: 1,
      mount: function () { try { return mount(); } catch (e) { return false; } },
      setFills: function (partial) { try { setFills(partial); } catch (e) {} },
      setExpectedLabels: function (labels) { try { setExpectedLabels(labels); } catch (e) {} },
      destroy: function () { try { destroy(); } catch (e) {} }
    };

    try { mount(); } catch (e6) {}
  } catch (e7) {}
})();`;
}

module.exports = {
  buildGaugesScript,
};
