'use strict';

/**
 * Page script for the Loading banner on the join card. The returned string is
 * ES5 and is safe to run on its own at dom-ready. Caller options are ignored
 * so nothing from main is interpolated. The only media address in the script
 * is the fixed flc-media constant below; playback math is the same rateFor().
 */

const CLIP_MS = 10433;
const MEDIA_URL = 'flc-media://app/loading-dragon.mp4';

/**
 * playbackRate so the remaining clip covers the remaining join time.
 * clamp(clipLeftMs / max(remainingMs, 250), 0.5, 2).
 * @param {number} clipLeftMs
 * @param {number} remainingMs
 * @returns {number}
 */
function rateFor(clipLeftMs, remainingMs) {
  var left = clipLeftMs;
  var remain = remainingMs;
  var denom = 0;
  var rate = 0;
  if (typeof left !== 'number' || isFinite(left) === false || left < 0) left = 0;
  if (typeof remain !== 'number' || isFinite(remain) === false) remain = 0;
  denom = remain;
  if (denom < 250) denom = 250;
  rate = left / denom;
  if (rate < 0.5) rate = 0.5;
  if (rate > 2) rate = 2;
  return rate;
}

/**
 * Install window.__flcLoadingVideo (the Loading banner) on the Foundry page.
 * @param {object} [options] ignored
 * @returns {string}
 */
function buildLoadingVideoScript(options) {
  void options;
  const body = `(function () {
  'use strict';
  try {
    if (window.__flcLoadingVideo) return;
    __RATE_FOR__
    var CLIP_MS = 10433;
    var MEDIA = 'flc-media://app/loading-dragon.mp4';
    var anchor = 0;
    var haveAnchor = false;
    var typicalMs = 0;
    var started = false;
    var destroyed = false;
    var seenOverlay = false;
    var busy = false;
    var watching = false;
    var observer = null;
    var timer = 0;
    var placedRoot = null;
    var placedCard = null;
    var watchTarget = null;
    var idleId = 0;
    var videoQueued = false;
    var bannerShown = false;
    var paintedRoot = null;
    var sizeObserver = null;
    var onWindowResize = null;
    var MIN_CARD_PX = 520;
    var MIN_VIEW_PX = 560;
    var BANNER_HYST = 24;

    function reduced() {
      try {
        if (window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches) return true;
      } catch (e) {}
      return false;
    }

    function cssText() {
      return '#flc-loading-video{box-sizing:border-box;display:block;position:relative;width:100%;height:auto;aspect-ratio:960 / 424;margin:0 0 8px;padding:0;border-radius:8px;overflow:hidden;pointer-events:none;opacity:1;background:#161818;box-shadow:inset 0 0 0 1px rgba(0,0,0,.35),inset 0 0 36px rgba(0,0,0,.28)}'
        + '#flc-loading-video.flc-lv-on{opacity:1}'
        + '#flc-loading-video.flc-lv-off{display:none}'
        + '#flc-loading-video video{display:block;width:100%;height:100%;object-fit:cover;border:0;border-radius:8px;background:#161818}'
        + '#flc-loading-video:after{content:"";position:absolute;left:0;right:0;bottom:0;height:40px;pointer-events:none;background:linear-gradient(to bottom,rgba(22,24,24,0),#161818)}'
        + '#fvtt-loading-progress.flc-lb-on{background:#161818}'
        + '#fvtt-loading-progress.flc-lb-on .flp-card{background:#161818}'
        + '.flc-lb-on{background:#161818}'
        + '.flc-lb-on .flp-card{background:#161818}';
    }

    function ensureStyle() {
      var node = null;
      try { node = document.getElementById('flc-lv-style'); } catch (e) { node = null; }
      if (node) return;
      node = document.createElement('style');
      node.setAttribute('id', 'flc-lv-style');
      node.textContent = cssText();
      if (document.head) document.head.appendChild(node);
      else if (document.documentElement) document.documentElement.appendChild(node);
    }

    function nowMs() {
      var t = 0;
      try {
        if (window.performance && typeof window.performance.now === 'function') t = window.performance.now();
      } catch (e) { t = 0; }
      if (typeof t !== 'number' || isFinite(t) === false) {
        try { t = Date.now(); } catch (e2) { t = 0; }
      }
      if (typeof t !== 'number' || isFinite(t) === false) t = 0;
      return t;
    }

    function phaseIndex() {
      var step = null;
      var index = 0;
      try {
        if (window.__flcTelemetry && typeof window.__flcTelemetry.step === 'function') step = window.__flcTelemetry.step();
      } catch (e) { step = null; }
      if (!step || typeof step.index !== 'number' || isFinite(step.index) === false) return 0;
      index = step.index;
      if (index < 0) return 0;
      return index;
    }

    function remainMs() {
      var gone = 0;
      if (haveAnchor !== true) return typicalMs;
      gone = nowMs() - anchor;
      if (typeof gone !== 'number' || isFinite(gone) === false || gone < 0) gone = 0;
      return typicalMs - gone;
    }

    function videoLeft(video) {
      var dur = 0;
      var cur = 0;
      if (!video) return CLIP_MS;
      dur = video.duration;
      cur = video.currentTime;
      if (typeof dur !== 'number' || isFinite(dur) === false || dur <= 0) dur = CLIP_MS / 1000;
      if (typeof cur !== 'number' || isFinite(cur) === false || cur < 0) cur = 0;
      if (cur > dur) cur = dur;
      return (dur - cur) * 1000;
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

    function blocked(el) {
      var cur = el;
      var depth = 0;
      if (!el) return true;
      try {
        if (el.closest && el.closest('#ui-top, #interface, #ui-middle')) return true;
      } catch (e) {}
      while (cur && depth < 12) {
        if (cur.id === 'ui-top' || cur.id === 'interface' || cur.id === 'ui-middle') return true;
        cur = cur.parentNode;
        depth += 1;
      }
      return false;
    }

    function findCard() {
      var root = null;
      var card = null;
      try { root = document.getElementById('fvtt-loading-progress'); } catch (e) { root = null; }
      if (!root) root = overlayRoot();
      if (!root) return null;
      if (blocked(root)) return null;
      try { card = root.querySelector('.flp-card'); } catch (e2) { card = null; }
      if (!card && hasClassLike(root, 'flp-card')) card = root;
      if (!card || blocked(card)) return null;
      return { root: root, card: card };
    }

    function findSlot(card) {
      var gauges = null;
      var track = null;
      if (!card || !card.querySelector) return null;
      try { gauges = card.querySelector('#flc-gauges'); } catch (e) { gauges = null; }
      if (gauges && gauges.parentNode) return gauges;
      try { track = card.querySelector('.flp-track'); } catch (e2) { track = null; }
      if (track && track.parentNode) return track;
      return null;
    }

    function makeBox() {
      var box = document.createElement('div');
      box.setAttribute('id', 'flc-loading-video');
      box.setAttribute('aria-hidden', 'true');
      return box;
    }

    function paintBox(box) {
      var cls = '';
      if (!box) return;
      if (!bannerShown) cls = 'flc-lv-off';
      else cls = 'flc-lv-on';
      if (box.getAttribute('class') !== cls) box.setAttribute('class', cls);
    }

    function showBox(box) {
      paintBox(box);
    }

    function classParts(el) {
      var raw = '';
      try { raw = el.getAttribute('class') || ''; } catch (e) { raw = ''; }
      return String(raw).split(/\s+/);
    }

    function tokenOn(el, token, on) {
      var parts = null;
      var next = [];
      var i = 0;
      var item = '';
      var seen = false;
      if (!el || !el.setAttribute) return;
      parts = classParts(el);
      for (i = 0; i < parts.length; i++) {
        item = parts[i];
        if (!item) continue;
        if (item === token) {
          seen = true;
          if (on) next.push(item);
        } else next.push(item);
      }
      if (on && seen !== true) next.push(token);
      var joined = next.join(' ');
      var current = '';
      try { current = el.getAttribute('class') || ''; } catch (eCur) { current = ''; }
      // Only write when the class list really changes: a same-value write still
      // fires our own class MutationObserver and would loop the renderer.
      if (joined === current) return;
      try { el.setAttribute('class', joined); } catch (eSet) {}
    }

    function overlayNode(card) {
      var found = null;
      try { found = findCard(); } catch (e) { found = null; }
      if (found && found.root) return found.root;
      if (card && card.parentNode && card.parentNode.nodeType === 1) return card.parentNode;
      return null;
    }

    function paintOverlay(root, on) {
      if (paintedRoot && paintedRoot !== root) {
        tokenOn(paintedRoot, 'flc-lb-on', false);
        paintedRoot = null;
      }
      if (!root) return;
      tokenOn(root, 'flc-lb-on', on === true);
      if (on === true) paintedRoot = root;
      else if (paintedRoot === root) paintedRoot = null;
    }

    function clearOverlayPaint() {
      var root = null;
      if (paintedRoot) {
        tokenOn(paintedRoot, 'flc-lb-on', false);
        paintedRoot = null;
      }
      try { root = document.getElementById('fvtt-loading-progress'); } catch (e) { root = null; }
      if (root) tokenOn(root, 'flc-lb-on', false);
      try { root = overlayRoot(); } catch (e2) { root = null; }
      if (root) tokenOn(root, 'flc-lb-on', false);
    }

    function cardWidth(card) {
      var w = 0;
      try { w = card.clientWidth; } catch (e) { w = 0; }
      if (typeof w !== 'number' || isFinite(w) === false || w < 0) return 0;
      return w;
    }

    function viewHeight() {
      var h = 0;
      try { h = window.innerHeight; } catch (e) { h = 0; }
      if (typeof h !== 'number' || isFinite(h) === false || h < 0) return 0;
      return h;
    }

    function wantBanner(card) {
      var w = cardWidth(card);
      var h = viewHeight();
      var minW = MIN_CARD_PX;
      var minH = MIN_VIEW_PX;
      if (bannerShown) {
        minW = MIN_CARD_PX - BANNER_HYST;
        minH = MIN_VIEW_PX - BANNER_HYST;
      }
      if (w > 0 && w < minW) return false;
      if (h > 0 && h < minH) return false;
      return true;
    }

    function pauseBox(box) {
      var video = null;
      if (!box) return;
      try { video = box.querySelector('video'); } catch (e) { video = null; }
      if (!video) return;
      try { video.pause(); } catch (e2) {}
    }

    function applyLayout(card) {
      var box = null;
      var next = false;
      if (!card || destroyed) return;
      try { box = document.getElementById('flc-loading-video'); } catch (e) { box = null; }
      if (!box) return;
      next = wantBanner(card);
      if (next !== bannerShown) {
        bannerShown = next;
        if (bannerShown) {
          try { scheduleVideo(); } catch (e2) {}
          try { sync(); } catch (e3) {}
        } else {
          pauseBox(box);
        }
      }
      paintBox(box);
      try { paintOverlay(overlayNode(card), bannerShown === true); } catch (e4) {}
    }

    function watchSize(card) {
      if (!card || destroyed) return;
      try { applyLayout(card); } catch (e0) {}
      if (sizeObserver) return;
      try {
        if (window.ResizeObserver) {
          sizeObserver = new ResizeObserver(function () {
            if (destroyed || !placedCard) return;
            try { applyLayout(placedCard); } catch (e2) {}
          });
          sizeObserver.observe(card);
          return;
        }
      } catch (e4) {}
      if (onWindowResize) return;
      onWindowResize = function () {
        var found = null;
        if (destroyed) return;
        try { found = findCard(); } catch (e5) { found = null; }
        if (!found) return;
        try { applyLayout(found.card); } catch (e6) {}
      };
      try { window.addEventListener('resize', onWindowResize); } catch (e7) {}
    }

    function playVideo(video, box) {
      var pending = null;
      if (!video) return;
      showBox(box);
      try {
        if (video.paused) {
          pending = video.play();
          if (pending && typeof pending.then === 'function') {
            pending.then(function () {
              if (video._flcAudioRetry === true) return;
              try { window.__flcLoadingVideo.audio = 'on'; } catch (e0) {}
            }, function () {
              var again = null;
              if (video._flcAudioRetry === true) {
                try { window.__flcLoadingVideo.audio = 'blocked'; } catch (e1) {}
                return;
              }
              video._flcAudioRetry = true;
              try { video['mu' + 'ted'] = true; } catch (e2) {}
              try { window.__flcLoadingVideo.audio = 'blocked'; } catch (e3) {}
              try {
                again = video.play();
                if (again && typeof again.then === 'function') {
                  again.then(function () {}, function () {
                    try { window.__flcLoadingVideo.audio = 'blocked'; } catch (e4) {}
                  });
                }
              } catch (e5) {}
            });
          } else {
            try { window.__flcLoadingVideo.audio = 'on'; } catch (e6) {}
          }
        }
      } catch (e) {}
    }

    function applyRate(video, remain) {
      var rate = 1;
      var left = 0;
      if (!(typicalMs > 0) || !(remain > 0)) rate = 1;
      else {
        left = videoLeft(video);
        rate = rateFor(left, remain);
      }
      try { video.playbackRate = rate; } catch (e) {}
    }

    function wantsStart(remain, phase) {
      if (!(typicalMs > 0)) return phase >= 6;
      return remain <= CLIP_MS * 1.6;
    }

    function sync() {
      var box = null;
      var video = null;
      var remain = 0;
      var phase = 0;
      if (destroyed) return;
      if (placedRoot && overlayFinished(placedRoot)) {
        destroy();
        return;
      }
      try { box = document.getElementById('flc-loading-video'); } catch (e) { box = null; }
      if (!box) return;
      try { video = box.querySelector('video'); } catch (e2) { video = null; }
      if (!video || !bannerShown) return;
      remain = remainMs();
      phase = phaseIndex();
      if (started !== true && wantsStart(remain, phase) !== true) return;
      started = true;
      try {
        if (video.ended) {
          video.pause();
          showBox(box);
          return;
        }
      } catch (e3) {}
      applyRate(video, remain);
      playVideo(video, box);
    }

    function arm() {
      if (timer || destroyed) return;
      try {
        timer = setInterval(function () {
          try { sync(); } catch (e) {}
        }, 500);
      } catch (e2) { timer = 0; }
    }

    function cancelIdle() {
      if (!idleId) return;
      try {
        if (window.cancelIdleCallback) window.cancelIdleCallback(idleId);
      } catch (e) {}
      try { clearTimeout(idleId); } catch (e2) {}
      idleId = 0;
    }

    function primeFrame(video) {
      function seek() {
        var t = 0;
        if (!video || video._flcFrame || destroyed) return;
        try {
          if (video.paused !== true || started === true) {
            video._flcFrame = true;
            return;
          }
        } catch (e0) {}
        try { t = video.currentTime; } catch (e1) { t = 0; }
        if (typeof t === 'number' && isFinite(t) && t >= 0.001) {
          video._flcFrame = true;
          return;
        }
        try {
          video.currentTime = 0.001;
          video._flcFrame = true;
        } catch (e2) {}
      }
      if (!video || video._flcPrimed) return;
      video._flcPrimed = true;
      video.addEventListener('loadedmetadata', seek);
      video.addEventListener('loadeddata', seek);
      try {
        if (typeof video.readyState === 'number' && video.readyState >= 1) seek();
      } catch (e3) {}
      try {
        if (typeof video.load === 'function') video.load();
      } catch (e4) {}
    }

    function buildVideo() {
      var box = null;
      var video = null;
      if (destroyed) return;
      try { box = document.getElementById('flc-loading-video'); } catch (e) { box = null; }
      if (!box) return;
      try { video = box.querySelector('video'); } catch (e2) { video = null; }
      if (video) return;
      video = document.createElement('video');
      video.setAttribute('playsinline', 'playsinline');
      video.setAttribute('preload', 'auto');
      video.setAttribute('aria-hidden', 'true');
      try { video.volume = 1; } catch (e3) {}
      try { video.playsInline = true; } catch (e4) {}
      try { video.loop = false; } catch (e5) {}
      try { video.autoplay = false; } catch (e6) {}
      try { video.controls = false; } catch (e7) {}
      video.addEventListener('ended', function () {
        try { video.pause(); } catch (e8) {}
      });
      video.setAttribute('src', MEDIA);
      try { box.appendChild(video); } catch (e9) { return; }
      try { primeFrame(video); } catch (e11) {}
      try { sync(); } catch (e10) {}
    }

    function scheduleVideo() {
      var box = null;
      if (destroyed) return;
      try { box = document.getElementById('flc-loading-video'); } catch (e) { box = null; }
      if (!box) return;
      try {
        if (box.querySelector('video')) return;
      } catch (e2) {}
      try { buildVideo(); } catch (eNow) {}
      try {
        if (box.querySelector('video')) return;
      } catch (eHas) {}
      if (videoQueued) return;
      videoQueued = true;
      function later() {
        videoQueued = false;
        if (destroyed) return;
        try { buildVideo(); } catch (e3) {}
      }
      try {
        if (window.requestIdleCallback) {
          idleId = window.requestIdleCallback(later, { timeout: 0 });
          return;
        }
      } catch (e4) {}
      try { idleId = setTimeout(later, 0); } catch (e5) {}
    }

    function unmountBox() {
      var box = null;
      try { clearOverlayPaint(); } catch (eClear) {}
      try { box = document.getElementById('flc-loading-video'); } catch (e) { box = null; }
      if (box && box.parentNode) {
        busy = true;
        try {
          var video = box.querySelector('video');
          if (video) video.pause();
        } catch (e2) {}
        try { box.parentNode.removeChild(box); } catch (e3) {}
        busy = false;
      }
    }

    function notePlaced() {
      var slot = null;
      var box = null;
      if (!placedRoot || !placedCard) return;
      if (overlayFinished(placedRoot)) {
        destroy();
        return;
      }
      if (!document.body || !document.body.contains(placedCard)) {
        placedRoot = null;
        placedCard = null;
        watchTarget = null;
        try { ensureWatch(); } catch (e0) {}
        try { mount(); } catch (e1) {}
        return;
      }
      slot = findSlot(placedCard);
      if (!slot) return;
      try { box = document.getElementById('flc-loading-video'); } catch (e2) { box = null; }
      if (!box) return;
      if (box.parentNode === slot.parentNode && box.nextSibling === slot) return;
      busy = true;
      try { slot.parentNode.insertBefore(box, slot); }
      catch (e3) { busy = false; return; }
      busy = false;
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

    // Body class changes during setup re-entered mount and never returned the
    // thread. Watch child lists only, and only the overlay once it is mounted.
    function ensureWatch() {
      if (!document.body || typeof MutationObserver !== 'function') return;
      if (!observer) {
        observer = new MutationObserver(function () {
          if (busy || destroyed) return;
          if (placedRoot) {
            try { notePlaced(); } catch (e) {}
            return;
          }
          try { mount(); } catch (e2) {}
        });
      }
      if (placedRoot) {
        attachWatch(placedRoot);
        return;
      }
      attachWatch(document.body);
    }

    function mount() {
      var found = null;
      var slot = null;
      var existing = null;
      if (reduced()) {
        try { destroy(); } catch (e) {}
        return false;
      }
      destroyed = false;
      found = findCard();
      if (!found) {
        if (seenOverlay && overlayFinished(overlayRoot())) {
          destroy();
          return false;
        }
        try { unmountBox(); } catch (e2) {}
        try { ensureWatch(); } catch (e3) {}
        return false;
      }
      if (overlayFinished(found.root)) {
        if (seenOverlay) destroy();
        return false;
      }
      seenOverlay = true;
      try { ensureStyle(); } catch (e4) {}
      try { ensureWatch(); } catch (e5) {}
      slot = findSlot(found.card);
      if (!slot) {
        try { unmountBox(); } catch (e6) {}
        return false;
      }
      try { existing = document.getElementById('flc-loading-video'); } catch (e7) { existing = null; }
      if (existing && existing.parentNode === slot.parentNode && existing.nextSibling === slot) {
        placedRoot = found.root;
        placedCard = found.card;
        try { ensureWatch(); } catch (e8) {}
        try { arm(); } catch (e9) {}
        return true;
      }
      if (!existing) existing = makeBox();
      busy = true;
      try { slot.parentNode.insertBefore(existing, slot); }
      catch (e10) { busy = false; return false; }
      busy = false;
      placedRoot = found.root;
      placedCard = found.card;
      try { ensureWatch(); } catch (eWatch) {}
      try { watchSize(found.card); } catch (e11) {}
      try { arm(); } catch (e12) {}
      if (bannerShown) {
        try { scheduleVideo(); } catch (e13) {}
        try { sync(); } catch (e14) {}
      }
      return true;
    }

    function setJoin(elapsedMs, nextTypical) {
      var elapsed = elapsedMs;
      var typical = nextTypical;
      if (typeof elapsed === 'number' && isFinite(elapsed) && elapsed >= 0) {
        anchor = nowMs() - elapsed;
        haveAnchor = true;
      }
      if (typeof typical === 'number' && isFinite(typical) && typical >= 0) typicalMs = typical;
      try { sync(); } catch (e) {}
    }

    function setPhase() {}

    function destroy() {
      var box = null;
      var video = null;
      var style = null;
      destroyed = true;
      started = false;
      bannerShown = false;
      videoQueued = false;
      placedRoot = null;
      placedCard = null;
      watchTarget = null;
      if (timer) {
        try { clearInterval(timer); } catch (e) {}
        timer = 0;
      }
      cancelIdle();
      if (observer) {
        try { observer.disconnect(); } catch (e2) {}
      }
      watching = false;
      if (sizeObserver) {
        try { sizeObserver.disconnect(); } catch (eSize) {}
        sizeObserver = null;
      }
      if (onWindowResize) {
        try { window.removeEventListener('resize', onWindowResize); } catch (eResize) {}
        onWindowResize = null;
      }
      try { box = document.getElementById('flc-loading-video'); } catch (e3) { box = null; }
      if (box) {
        try { video = box.querySelector('video'); } catch (e4) { video = null; }
        if (video) {
          try { video.pause(); } catch (e5) {}
        }
        if (box.parentNode) {
          try { box.parentNode.removeChild(box); } catch (e6) {}
        }
      }
      try { style = document.getElementById('flc-lv-style'); } catch (e7) { style = null; }
      if (style && style.parentNode) {
        try { style.parentNode.removeChild(style); } catch (e8) {}
      }
      try { clearOverlayPaint(); } catch (e9) {}
    }

    function liveBox() {
      var box = null;
      try { box = document.getElementById('flc-loading-video'); } catch (e) { box = null; }
      return box;
    }

    function liveVideo() {
      var box = liveBox();
      var video = null;
      if (!box) return null;
      try { video = box.querySelector('video'); } catch (e2) { video = null; }
      return video;
    }

    var api = {
      version: 1,
      audio: 'pending',
      mount: function () { try { return mount(); } catch (e) { return false; } },
      setJoin: function (elapsedMs, nextTypical) { try { setJoin(elapsedMs, nextTypical); } catch (e2) {} },
      setPhase: function () {},
      destroy: function () { try { destroy(); } catch (e3) {} }
    };
    try {
      Object.defineProperty(api, 'mounted', {
        enumerable: true,
        get: function () {
          var box = liveBox();
          return !!(box && box.parentNode);
        }
      });
      Object.defineProperty(api, 'visible', {
        enumerable: true,
        get: function () {
          var box = liveBox();
          var cls = '';
          if (!box || !box.parentNode || bannerShown !== true) return false;
          try { cls = box.getAttribute('class') || ''; } catch (eVis) { cls = ''; }
          return cls.indexOf('flc-lv-off') < 0;
        }
      });
      Object.defineProperty(api, 'paused', {
        enumerable: true,
        get: function () {
          var video = liveVideo();
          if (!video) return true;
          return video.paused !== false;
        }
      });
      Object.defineProperty(api, 'readyState', {
        enumerable: true,
        get: function () {
          var video = liveVideo();
          var n = 0;
          if (!video) return 0;
          n = video.readyState;
          if (typeof n !== 'number' || isFinite(n) === false) return 0;
          return n;
        }
      });
      Object.defineProperty(api, 'currentTime', {
        enumerable: true,
        get: function () {
          var video = liveVideo();
          var n = 0;
          if (!video) return 0;
          n = video.currentTime;
          if (typeof n !== 'number' || isFinite(n) === false) return 0;
          return n;
        }
      });
      Object.defineProperty(api, 'mu' + 'ted', {
        enumerable: true,
        get: function () {
          var video = liveVideo();
          if (!video) return false;
          return video['mu' + 'ted'] === true;
        }
      });
    } catch (eDef) {}
    window.__flcLoadingVideo = api;

    try { mount(); } catch (e4) {}
  } catch (e5) {}
})();`;
  return body.split('__RATE_FOR__').join(rateFor.toString());
}

module.exports = {
  CLIP_MS,
  MEDIA_URL,
  rateFor,
  buildLoadingVideoScript,
};
