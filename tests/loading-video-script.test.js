import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { MEDIA_URLS } from '../electron/media-protocol.js';
import {
  CLIP_MS,
  buildLoadingVideoScript,
  pickLoadingClip,
  rateFor,
} from '../electron/loading-video-script.js';

function scriptSource() {
  return buildLoadingVideoScript();
}

describe('buildLoadingVideoScript source', () => {
  it('returns an ES5 script that installs the loading-video API', () => {
    const src = scriptSource();
    expect(typeof src).toBe('string');
    expect(src.length).toBeGreaterThan(200);
    expect(src).not.toContain('`');
    expect(src).not.toContain('=>');
    expect(src).not.toContain('->');
    expect(src).not.toMatch(/\blet /);
    expect(src).not.toMatch(/\bconst /);
    expect(src).not.toContain('muted');
    expect(src).toContain('#000000');
    expect(src).not.toContain('#161818');
    expect(src).toContain('flc-lb-on');
    expect(src).toContain('0.001');
    expect(src).toContain('loadedmetadata');
    expect(src).toContain('loadeddata');
    expect(src).toContain("audio = 'blocked'");
    expect(src).toContain('volume = 1');
    expect(src).not.toContain('opacity:0');
    expect(src).not.toContain('#1a1a1d');
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain('window.__flcLoadingVideo');
    expect(src).toContain('mount');
    expect(src).toContain('setJoin');
    expect(src).toContain('setPhase');
    expect(src).toContain('destroy');
    expect(src).toContain('flc-loading-video');
    expect(src).toContain(MEDIA_URLS[0]);
    expect(src).not.toContain(MEDIA_URLS[1]);
    expect(src).not.toContain('loading-dragon.mp4');
    expect(src.match(/flc-media:\/\//g)).toEqual(['flc-media://']);
    expect(src).toContain(String(CLIP_MS));
    expect(src).toContain('START_LEAD_MS = 3000');
    expect(src).toContain('END_PAD_MS = 3000');
    expect(src).not.toContain('1.6');
    expect(src).toContain('drawing scene');
    expect(src).toContain('setting up world');
    expect(src).toContain('split(/\\s+/)');
    expect(src).toContain('aspect-ratio:960 / 444');
    expect(src).not.toContain('960 / 424');
    expect(src).not.toContain('height:268px');
    expect(src).toContain('MIN_CARD_PX = 520');
    expect(src).toContain('MIN_VIEW_PX = 560');
    expect(src).toContain('BANNER_HYST = 24');
    expect(src).toContain('ResizeObserver');
    expect(src).not.toContain('attributeFilter');
    expect(src).not.toContain('attributes:');
    expect(src).toContain('prefers-reduced-motion');
    expect(src).toContain('requestIdleCallback');
    expect(src).toContain('playbackRate');
    expect(src).toContain(rateFor.toString());
    expect(src).not.toMatch(/console\./);
    expect(src).not.toMatch(/https?:/);
    expect(src).not.toMatch(/document\.title/);
  });

  it('does not interpolate caller options into the page', () => {
    const src = buildLoadingVideoScript({ label: 'SecretToken', name: 'HiddenName' });
    expect(src).not.toContain('SecretToken');
    expect(src).not.toContain('HiddenName');
    expect(src).toBe(buildLoadingVideoScript());
    const junk = buildLoadingVideoScript("';alert(1)//");
    expect(junk).not.toContain('alert');
    expect(junk).toBe(buildLoadingVideoScript());
  });

  it('embeds exactly one chosen clip and never the other', () => {
    const first = buildLoadingVideoScript(MEDIA_URLS[0]);
    const second = buildLoadingVideoScript(MEDIA_URLS[1]);
    expect(first.match(/flc-media:\/\/app\/[a-z0-9.-]+/g)).toEqual([MEDIA_URLS[0]]);
    expect(second.match(/flc-media:\/\/app\/[a-z0-9.-]+/g)).toEqual([MEDIA_URLS[1]]);
    expect(first).not.toContain('loading-dragon-2.mp4');
    expect(second).not.toContain('loading-dragon-1.mp4');
  });
});

describe('pickLoadingClip', () => {
  const urls = MEDIA_URLS.slice();

  it('chooses by a number in [0, 1] and clamps the ends', () => {
    expect(pickLoadingClip(urls, 0)).toBe(urls[0]);
    expect(pickLoadingClip(urls, 0.49)).toBe(urls[0]);
    expect(pickLoadingClip(urls, 0.5)).toBe(urls[1]);
    expect(pickLoadingClip(urls, 0.99)).toBe(urls[1]);
    expect(pickLoadingClip(urls, 1)).toBe(urls[1]);
    expect(pickLoadingClip(urls, -1)).toBe(urls[0]);
    expect(pickLoadingClip(urls, Number.NaN)).toBe(urls[0]);
    expect(pickLoadingClip(urls, () => 0.75)).toBe(urls[1]);
    expect(pickLoadingClip([], 0.2)).toBe('');
    expect(pickLoadingClip(null, 0.2)).toBe('');
  });

  it('is called once per game-window injection with the allow-list', () => {
    const src = readFileSync(new URL('../electron/game-window.js', import.meta.url), 'utf8');
    expect(src).toContain('const clip = pickLoadingClip(MEDIA_URLS);');
    expect(src).toContain('buildLoadingVideoScript(clip)');
    expect(src).not.toContain('buildLoadingVideoScript()');
  });

  it('calls Math.random once when no roll is given', () => {
    const orig = Math.random;
    const calls = [];
    Math.random = () => {
      calls.push(1);
      return 0.1;
    };
    try {
      expect(pickLoadingClip(urls)).toBe(urls[0]);
      expect(calls).toEqual([1]);
    } finally {
      Math.random = orig;
    }
  });
});

describe('rateFor', () => {
  it('stretches or compresses the clip and clamps to 0.5–2', () => {
    expect(rateFor(CLIP_MS, CLIP_MS)).toBe(1);
    expect(rateFor(CLIP_MS, 15000)).toBeCloseTo(CLIP_MS / 15000, 8);
    expect(rateFor(CLIP_MS, 100)).toBe(2);
    expect(rateFor(CLIP_MS, 250)).toBe(2);
    expect(rateFor(100, 10000)).toBe(0.5);
    expect(rateFor(500, 1000)).toBe(0.5);
    expect(rateFor(5000, 100)).toBe(2);
    expect(rateFor(Number.NaN, 1000)).toBe(0.5);
    expect(rateFor(1000, Number.NaN)).toBe(2);
    expect(rateFor(-20, 1000)).toBe(0.5);
    expect(rateFor(1000, -20)).toBe(2);
  });
});

function createHost(options) {
  const opts = options || {};
  const idles = [];
  const intervals = [];
  const observers = [];
  const sizeObservers = [];
  let viewHeight = opts.viewHeight;
  let nextId = 1;
  let reduceMotion = opts.reduced === true;
  let phase = typeof opts.phase === 'number' ? opts.phase : 0;
  let clock = 100000;
  const CLASS_WRITE_LIMIT = 500;
  let classWrites = 0;
  const pendingMutations = [];
  let draining = false;

  function make(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      nodeType: 1,
      id: '',
      className: '',
      parentNode: null,
      childNodes: [],
      attributes: Object.create(null),
      style: {},
      _text: '',
      _on: Object.create(null),
    };
    Object.defineProperty(node, 'textContent', {
      get() { return this._text; },
      set(value) { this._text = value == null ? '' : String(value); },
    });
    Object.defineProperty(node, 'nextSibling', {
      get() {
        if (!this.parentNode) return null;
        const index = this.parentNode.childNodes.indexOf(this);
        return index >= 0 ? (this.parentNode.childNodes[index + 1] || null) : null;
      },
    });
    node.setAttribute = function setAttribute(name, value) {
      const key = String(name);
      this.attributes[key] = String(value);
      if (key === 'id') this.id = String(value);
      if (key === 'class') {
        this.className = String(value);
        // Browsers queue a record for every class write, even a same-value
        // one. Deliver it like a microtask so observer feedback loops surface.
        classWrites += 1;
        if (classWrites > CLASS_WRITE_LIMIT) throw new Error('class mutation feedback loop');
        for (let i = 0; i < observers.length; i += 1) {
          if (observers[i].connected) pendingMutations.push(observers[i]);
        }
        if (!draining) {
          draining = true;
          try {
            while (pendingMutations.length) {
              const target = pendingMutations.shift();
              target.callback([{ type: 'attributes', attributeName: 'class' }], target);
            }
          } finally {
            draining = false;
          }
        }
      }
    };
    node.getAttribute = function getAttribute(name) {
      const key = String(name);
      return Object.prototype.hasOwnProperty.call(this.attributes, key) ? this.attributes[key] : null;
    };
    node.appendChild = function appendChild(child) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      this.childNodes.push(child);
      return child;
    };
    node.insertBefore = function insertBefore(child, before) {
      if (child.parentNode) child.parentNode.removeChild(child);
      child.parentNode = this;
      const index = before ? this.childNodes.indexOf(before) : -1;
      if (index < 0) this.childNodes.push(child);
      else this.childNodes.splice(index, 0, child);
      return child;
    };
    node.removeChild = function removeChild(child) {
      const index = this.childNodes.indexOf(child);
      if (index >= 0) this.childNodes.splice(index, 1);
      child.parentNode = null;
      return child;
    };
    node.contains = function contains(other) {
      let cur = other;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    };
    node.querySelector = function querySelector(sel) {
      return walk(this, sel);
    };
    node.addEventListener = function addEventListener(type, fn) {
      this._on[type] = fn;
    };
    if (node.tagName === 'VIDEO') {
      node.paused = true;
      node.ended = false;
      node.duration = 10.433;
      node.currentTime = 0;
      node.playbackRate = 1;
      node.muted = false;
      node.volume = 1;
      node.readyState = 0;
      node.loop = true;
      node.playCalls = 0;
      node.pauseCalls = 0;
      node.load = function load() {
        this.readyState = 2;
        if (typeof this._on.loadedmetadata === 'function') this._on.loadedmetadata();
        if (typeof this._on.loadeddata === 'function') this._on.loadeddata();
      };
      node.play = function play() {
        const reject = opts.rejectPlay === true && this.muted !== true && this._rejectOnce !== true;
        this.playCalls += 1;
        if (reject) {
          this._rejectOnce = true;
          const rejected = {
            then(ok, fail) {
              if (typeof fail === 'function') fail();
              return rejected;
            },
          };
          return rejected;
        }
        this.paused = false;
        const result = {
          then(ok) {
            if (typeof ok === 'function') ok();
            return result;
          },
        };
        return result;
      };
      node.pause = function pause() {
        this.paused = true;
        this.pauseCalls += 1;
      };
    }
    return node;
  }

  function match(node, sel) {
    if (sel.charAt(0) === '#') return node.id === sel.slice(1);
    if (sel.charAt(0) === '.') {
      return node.className.split(/\s+/).indexOf(sel.slice(1)) >= 0;
    }
    return node.tagName === sel.toUpperCase();
  }

  function walk(node, sel) {
    for (let i = 0; i < node.childNodes.length; i += 1) {
      const child = node.childNodes[i];
      if (match(child, sel)) return child;
      const found = walk(child, sel);
      if (found) return found;
    }
    return null;
  }

  function walkAll(node, sel, out) {
    for (let i = 0; i < node.childNodes.length; i += 1) {
      const child = node.childNodes[i];
      if (match(child, sel)) out.push(child);
      walkAll(child, sel, out);
    }
    return out;
  }

  const document = make('#document');
  document.createElement = function createElement(tag) { return make(tag); };
  document.querySelector = function querySelector(sel) { return walk(document, sel); };
  document.querySelectorAll = function querySelectorAll(sel) {
    if (sel === 'a, button') return walkAll(document, 'A', []).concat(walkAll(document, 'BUTTON', []));
    return walkAll(document, sel, []);
  };
  document.getElementById = function getElementById(id) { return walk(document, `#${id}`); };

  const head = make('head');
  const body = make('body');
  document.appendChild(head);
  document.appendChild(body);
  document.head = head;
  document.body = body;
  document.documentElement = document;

  const root = document.createElement('div');
  root.setAttribute('id', 'fvtt-loading-progress');
  const card = document.createElement('div');
  card.setAttribute('class', 'flp-card');
  const detail = document.createElement('div');
  detail.setAttribute('class', 'flp-detail');
  const gauges = document.createElement('div');
  gauges.setAttribute('id', 'flc-gauges');
  const track = document.createElement('div');
  track.setAttribute('class', 'flp-track');
  if (typeof opts.cardWidth === 'number') card.clientWidth = opts.cardWidth;
  card.appendChild(detail);
  if (opts.place !== 'track' && opts.place !== 'hide') card.appendChild(gauges);
  card.appendChild(track);
  root.appendChild(card);

  if (opts.place === 'ui-top') {
    const ui = document.createElement('div');
    ui.setAttribute('id', 'ui-top');
    ui.appendChild(root);
    body.appendChild(ui);
  } else if (opts.place === 'hide') {
    root.id = '';
    root.setAttribute('id', 'load-screen');
    const hide = document.createElement('button');
    hide.textContent = 'Hide';
    card.appendChild(hide);
    body.appendChild(root);
  } else {
    body.appendChild(root);
  }

  function MutationObserver(callback) {
    this.callback = callback;
    this.connected = false;
    observers.push(this);
  }
  MutationObserver.prototype.observe = function observe(target, options) {
    this.connected = true;
    this.target = target;
    this.options = options;
  };
  MutationObserver.prototype.disconnect = function disconnect() { this.connected = false; };

  function ResizeObserver(callback) {
    this.cb = callback;
    sizeObservers.push(this);
  }
  ResizeObserver.prototype.observe = function observe() { this.cb(); };
  ResizeObserver.prototype.disconnect = function disconnect() {};

  const sandbox = {
    document,
    MutationObserver,
    ResizeObserver,
    performance: {
      now() { return clock; },
    },
    requestIdleCallback(fn) {
      const id = nextId;
      nextId += 1;
      idles.push({ id, fn });
      return id;
    },
    cancelIdleCallback(id) {
      const index = idles.findIndex((item) => item.id === id);
      if (index >= 0) idles.splice(index, 1);
    },
    setTimeout(fn) {
      const id = nextId;
      nextId += 1;
      idles.push({ id, fn });
      return id;
    },
    clearTimeout(id) {
      const index = idles.findIndex((item) => item.id === id);
      if (index >= 0) idles.splice(index, 1);
    },
    setInterval(fn) {
      const id = nextId;
      nextId += 1;
      intervals.push({ id, fn });
      return id;
    },
    clearInterval(id) {
      const index = intervals.findIndex((item) => item.id === id);
      if (index >= 0) intervals.splice(index, 1);
    },
    Date,
  };
  Object.defineProperty(sandbox, 'innerHeight', {
    get() { return viewHeight; },
    set(value) { viewHeight = value; },
  });
  sandbox.window = sandbox;
  sandbox.matchMedia = function matchMedia(query) {
    return {
      media: query,
      matches: reduceMotion && String(query).indexOf('prefers-reduced-motion') >= 0,
    };
  };
  const stepNames = ['', 'connecting', 'loading page', 'receiving world data', 'initializing', 'loading languages', 'setting up world', 'drawing scene', 'ready'];
  sandbox.__flcTelemetry = {
    step() {
      const index = phase;
      const name = index >= 0 && index < stepNames.length ? stepNames[index] : '';
      return { index, total: 8, name };
    },
  };

  vm.runInNewContext(scriptSource(), sandbox);

  return {
    document,
    root,
    card,
    gauges,
    track,
    observers,
    intervals,
    api: sandbox.window.__flcLoadingVideo,
    setPhase(index) { phase = index; },
    setClock(value) { clock = value; },
    setViewHeight(value) { viewHeight = value; },
    relayout() {
      const last = sizeObservers[sizeObservers.length - 1];
      if (last) last.cb();
    },
    video() {
      const box = document.getElementById('flc-loading-video');
      return box ? box.querySelector('video') : null;
    },
    flushIdle() {
      const batch = idles.splice(0, idles.length);
      for (let i = 0; i < batch.length; i += 1) batch[i].fn();
    },
    countBoxes() {
      return walkAll(document, '#flc-loading-video', []).length;
    },
    classWrites() { return classWrites; },
  };
}

describe('loading clip on the join card', () => {
  it('settles after mount: class paints do not feed its own mutation observer', () => {
    const host = createHost({ cardWidth: 680, viewHeight: 900 });
    expect(host.api.mount()).toBe(true);
    const after = host.classWrites();
    // Observer callbacks remount; re-painting an unchanged class must be a no-op.
    host.observers.forEach((o) => { if (o.connected) o.callback([{ type: 'childList' }], o); });
    host.relayout();
    host.flushIdle();
    expect(host.classWrites() - after).toBeLessThanOrEqual(2);
    expect(host.root.className.split(/\s+/)).toContain('flc-lb-on');
    expect(host.countBoxes()).toBe(1);
    const video = host.video();
    let i = 0;
    for (i = 0; i < 40; i += 1) {
      host.observers[0].callback([{ type: 'childList' }], host.observers[0]);
    }
    expect(host.video()).toBe(video);
    expect(host.countBoxes()).toBe(1);
    expect(host.classWrites() - after).toBeLessThanOrEqual(2);
  });

  it('mounts once, directly above the gauge row', () => {
    const host = createHost();
    expect(host.api.mount()).toBe(true);
    expect(host.api.mount()).toBe(true);
    const box = host.document.getElementById('flc-loading-video');
    expect(box).toBeTruthy();
    expect(box.parentNode).toBe(host.card);
    expect(box.nextSibling).toBe(host.gauges);
    expect(host.gauges.nextSibling).toBe(host.track);
    expect(host.countBoxes()).toBe(1);
    expect(host.document.getElementById('flc-lv-style').textContent).toContain('aspect-ratio:960 / 444');
    expect(host.document.getElementById('flc-lv-style').textContent).not.toContain('height:268px');
    expect(host.observers.some((observer) => observer.connected)).toBe(true);
    const live = host.observers.filter((observer) => observer.connected);
    expect(live).toHaveLength(1);
    expect(live[0].target).toBe(host.root);
    expect(live[0].options).toEqual({ childList: true, subtree: true });
    host.flushIdle();
    const video = host.video();
    expect(video).toBeTruthy();
    expect(video.getAttribute('src')).toBe(MEDIA_URLS[0]);
    expect(video.getAttribute('muted')).toBeNull();
    expect(video.getAttribute('playsinline')).toBe('playsinline');
    expect(video.getAttribute('preload')).toBe('auto');
    expect(video.loop).toBe(false);
    expect(video.muted).toBe(false);
    expect(video.volume).toBe(1);
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(0.001);
    expect(video.playCalls).toBe(0);
    expect(host.api.mounted).toBe(true);
    expect(host.api.visible).toBe(true);
    expect(host.api.paused).toBe(true);
    expect(host.api.readyState).toBe(2);
    expect(host.api.currentTime).toBe(0.001);
    expect(host.api.muted).toBe(false);
    expect(host.api.audio).toBe('pending');
    expect(String(host.root.getAttribute('class') || '')).toContain('flc-lb-on');
    expect(host.document.getElementById('flc-lv-style').textContent).toContain('#000000');
    expect(host.document.getElementById('flc-lv-style').textContent).not.toContain('#161818');
    expect(box.childNodes).toEqual([video]);
    expect(box.textContent).toBe('');
  });

  it('inserts before the progress track when the gauge row is absent', () => {
    const host = createHost({ place: 'track' });
    const box = host.document.getElementById('flc-loading-video');
    expect(box.nextSibling).toBe(host.track);
    expect(host.card.querySelector('#flc-gauges')).toBeNull();
  });

  it('finds a Hide-button overlay and refuses the in-game indicator', () => {
    const host = createHost({ place: 'hide' });
    const box = host.document.getElementById('flc-loading-video');
    expect(box).toBeTruthy();
    expect(box.nextSibling).toBe(host.track);

    const blocked = createHost({ place: 'ui-top' });
    expect(blocked.document.getElementById('flc-loading-video')).toBeNull();
    expect(blocked.api.mount()).toBe(false);
  });

  it('does not mount when reduced motion is requested', () => {
    const host = createHost({ reduced: true });
    expect(host.document.getElementById('flc-loading-video')).toBeNull();
    expect(host.document.getElementById('flc-lv-style')).toBeNull();
    expect(host.api.mount()).toBe(false);
    expect(host.countBoxes()).toBe(0);
  });

  it('stays paused while the estimate is well above the clip, then starts about one clip from ready', () => {
    const host = createHost();
    host.flushIdle();
    const video = host.video();
    const budget = video.duration * 1000;
    host.api.setJoin(0, 60000);
    expect(video.playCalls).toBe(0);
    expect(video.paused).toBe(true);

    host.api.setJoin(5000, 20000);
    expect(video.playCalls).toBe(0);
    expect(host.api.paused).toBe(true);

    host.api.setJoin(0, budget + 3500);
    expect(video.playCalls).toBe(0);
    expect(video.paused).toBe(true);

    host.api.setJoin(0, budget + 3000);
    expect(video.playCalls).toBe(1);
    expect(video.paused).toBe(false);
    expect(video.playbackRate).toBeCloseTo(rateFor((video.duration - video.currentTime) * 1000, budget), 8);
    expect(host.document.getElementById('flc-loading-video').getAttribute('class')).toBe('flc-lv-on');
    expect(host.api.audio).toBe('on');
    expect(host.api.paused).toBe(false);
    expect(host.api.visible).toBe(true);

    host.api.setJoin(30000, 20000);
    expect(video.playbackRate).toBe(1);
  });

  it('stays paused on setting up world when this server has no typical join time', () => {
    const host = createHost({ phase: 2 });
    host.flushIdle();
    host.api.setJoin(0, 0);
    expect(host.video().playCalls).toBe(0);
    host.setPhase(6);
    host.api.setJoin(0, 0);
    expect(host.video().playCalls).toBe(0);
    expect(host.video().paused).toBe(true);
    host.setPhase(7);
    host.api.setJoin(0, 0);
    expect(host.video().playCalls).toBe(1);
    expect(host.video().playbackRate).toBe(1);
    expect(host.api.audio).toBe('on');
  });

  it('ignores non-finite join numbers', () => {
    const host = createHost({ phase: 0 });
    host.flushIdle();
    host.api.setJoin(Number.NaN, Number.POSITIVE_INFINITY);
    host.api.setJoin('20', '30');
    expect(host.video().playCalls).toBe(0);
  });

  it('pauses and removes itself on destroy, and when the overlay finishes', () => {
    const host = createHost();
    host.flushIdle();
    host.api.setJoin(0, CLIP_MS);
    const video = host.video();
    expect(video.paused).toBe(false);
    host.api.destroy();
    expect(video.paused).toBe(true);
    expect(video.pauseCalls).toBeGreaterThan(0);
    expect(host.document.getElementById('flc-loading-video')).toBeNull();
    expect(host.document.getElementById('flc-lv-style')).toBeNull();
    expect(host.observers.some((observer) => observer.connected)).toBe(false);
    expect(host.intervals).toHaveLength(0);

    host.api.mount();
    host.flushIdle();
    expect(host.document.getElementById('flc-loading-video')).toBeTruthy();
    host.root.setAttribute('class', 'flp-finished');
    host.observers[0].callback();
    expect(host.document.getElementById('flc-loading-video')).toBeNull();
  });

  it('drops the banner when the card is narrower than the threshold', () => {
    const host = createHost({ cardWidth: 400, viewHeight: 800 });
    const box = host.document.getElementById('flc-loading-video');
    expect(box.getAttribute('class')).toBe('flc-lv-off');
    expect(String(host.root.getAttribute('class') || '')).not.toContain('flc-lb-on');
    expect(String(host.gauges.parentNode.getAttribute('class') || '')).toContain('flc-lb-on');
    expect(host.api.visible).toBe(false);
    expect(host.api.mounted).toBe(true);
    expect(box.nextSibling).toBe(host.gauges);
    expect(host.gauges.id).toBe('flc-gauges');
    host.flushIdle();
    host.api.setJoin(5000, 20000);
    expect(host.video()).toBeNull();
  });

  it('uses 24px of hysteresis and pauses while the banner is hidden', () => {
    const host = createHost({ cardWidth: 600, viewHeight: 700 });
    const box = host.document.getElementById('flc-loading-video');
    expect(box.getAttribute('class')).not.toBe('flc-lv-off');
    expect(String(host.root.getAttribute('class') || '')).toContain('flc-lb-on');
    host.flushIdle();
    host.api.setJoin(0, CLIP_MS);
    const video = host.video();
    expect(video.playCalls).toBe(1);

    host.card.clientWidth = 500;
    host.relayout();
    expect(box.getAttribute('class')).not.toBe('flc-lv-off');
    expect(video.paused).toBe(false);

    host.card.clientWidth = 490;
    host.relayout();
    expect(box.getAttribute('class')).toBe('flc-lv-off');
    expect(video.paused).toBe(true);
    expect(String(host.root.getAttribute('class') || '')).not.toContain('flc-lb-on');
    expect(String(host.card.getAttribute('class') || '')).toContain('flc-lb-on');

    host.setViewHeight(400);
    host.card.clientWidth = 800;
    host.relayout();
    expect(box.getAttribute('class')).toBe('flc-lv-off');

    host.setViewHeight(800);
    host.relayout();
    expect(box.getAttribute('class')).toBe('flc-lv-on');
    expect(String(host.root.getAttribute('class') || '')).toContain('flc-lb-on');
    expect(String(host.card.getAttribute('class') || '')).not.toContain('flc-lb-on');
    expect(video.playCalls).toBe(2);
    expect(video.paused).toBe(false);
  });

  it('paints the first paused frame and drops the clip colour with the banner', () => {
    const host = createHost();
    const video = host.video();
    const css = host.document.getElementById('flc-lv-style').textContent;
    expect(video.paused).toBe(true);
    expect(video.currentTime).toBe(0.001);
    expect(video.readyState).toBeGreaterThanOrEqual(1);
    expect(css).toContain('#fvtt-loading-progress.flc-lb-on');
    expect(css).toContain('.flp-card{background:#000000 !important}');
    expect(css).toContain('#fvtt-loading-progress .flp-card.flc-lb-on{background:#000000 !important}');
    expect(css).toContain('rgba(0,0,0,0),#000000');
    expect(css).not.toContain('#161818');
    expect(String(host.root.getAttribute('class') || '')).toBe('flc-lb-on');

    host.api.destroy();
    expect(String(host.root.getAttribute('class') || '')).not.toContain('flc-lb-on');
    expect(host.api.mounted).toBe(false);
    expect(host.api.visible).toBe(false);
    expect(host.api.paused).toBe(true);
    expect(host.api.currentTime).toBe(0);
    expect(host.api.readyState).toBe(0);
    expect(host.api.muted).toBe(false);
  });

  it('retries once without sound when playback with audio is rejected', () => {
    const host = createHost({ rejectPlay: true, phase: 7 });
    const video = host.video();
    expect(video.playCalls).toBe(2);
    expect(video.muted).toBe(true);
    expect(video.paused).toBe(false);
    expect(host.api.audio).toBe('blocked');
    expect(host.api.muted).toBe(true);
    expect(host.api.paused).toBe(false);
    expect(host.api.visible).toBe(true);
  });
});
