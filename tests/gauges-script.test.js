import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildGaugesScript } from '../electron/gauges-script.js';
import { GAUGES, gaugeColor } from '../electron/join-gauges.js';

function scriptSource() {
  return buildGaugesScript();
}

describe('buildGaugesScript source', () => {
  it('returns an ES5 script that installs the gauges API', () => {
    const src = scriptSource();
    expect(typeof src).toBe('string');
    expect(src.length).toBeGreaterThan(200);
    expect(src).not.toContain('`');
    expect(src).not.toContain('=>');
    expect(src).not.toMatch(/\blet /);
    expect(src).not.toMatch(/\bconst /);
    expect(() => new Function(src)).not.toThrow();
    expect(src).toContain('window.__flcGauges');
    expect(src).toContain('mount');
    expect(src).toContain('setFills');
    expect(src).toContain('setExpectedLabels');
    expect(src).toContain('destroy');
    expect(src).toContain('flc-gauges');
    expect(src).toContain('flc-g-');
    expect(src).toContain('prefers-reduced-motion');
    expect(src).toContain('520');
    expect(src).toContain('requestAnimationFrame');
    expect(src).not.toContain('attributeFilter');
    expect(src).not.toContain('attributes:');
    expect(src).not.toMatch(/console\./);
    for (let i = 0; i < GAUGES.length; i += 1) {
      expect(src).toContain(GAUGES[i].shortLabel);
    }
    expect(src.replace('http://www.w3.org/2000/svg', '')).not.toMatch(/https?:/);
    expect(src).toContain('#d9372b');
    expect(src).toContain('#e0a100');
    expect(src).toContain('#2fb344');
  });

  it('does not interpolate caller options into the page', () => {
    const src = buildGaugesScript({ label: 'http://evil.example/world', name: 'Secret World' });
    expect(src).not.toContain('evil.example');
    expect(src).not.toContain('Secret');
    expect(src).toBe(buildGaugesScript());
  });
});

function createHost() {
  const frames = [];
  let nextId = 1;
  let reduceMotion = false;
  const observers = [];

  function make(tag, ns) {
    const node = {
      tagName: String(tag).toUpperCase(),
      namespaceURI: ns || 'http://www.w3.org/1999/xhtml',
      id: '',
      className: '',
      parentNode: null,
      childNodes: [],
      attributes: Object.create(null),
      style: {},
      _text: '',
    };
    Object.defineProperty(node, 'textContent', {
      get() { return this._text; },
      set(value) { this._text = value == null ? '' : String(value); },
    });
    Object.defineProperty(node, 'children', {
      get() { return this.childNodes.slice(); },
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
      if (key === 'class') this.className = String(value);
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
  document.createElementNS = function createElementNS(ns, tag) { return make(tag, ns); };
  document.querySelector = function querySelector(sel) { return walk(document, sel); };
  document.getElementById = function getElementById(id) { return walk(document, `#${id}`); };

  const head = make('head');
  const body = make('body');
  document.appendChild(head);
  document.appendChild(body);
  document.head = head;
  document.body = body;
  document.documentElement = document;

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

  function requestAnimationFrame(fn) {
    const id = nextId;
    nextId += 1;
    frames.push({ id, fn });
    return id;
  }
  function cancelAnimationFrame(id) {
    const index = frames.findIndex((frame) => frame.id === id);
    if (index >= 0) frames.splice(index, 1);
  }

  const sandbox = {
    document,
    MutationObserver,
    requestAnimationFrame,
    cancelAnimationFrame,
    setTimeout,
    clearTimeout,
  };
  sandbox.window = sandbox;
  sandbox.matchMedia = function matchMedia(query) {
    return {
      media: query,
      matches: reduceMotion && String(query).indexOf('prefers-reduced-motion') >= 0,
    };
  };
  sandbox.window.matchMedia = sandbox.matchMedia;

  const loading = document.createElement('div');
  loading.id = 'loading';
  const note = document.createElement('div');
  note.id = 'flc-loading-note';
  note.textContent = 'Step 3/8';
  const context = document.createElement('div');
  context.id = 'context';
  context.textContent = 'Loading';
  const bar = document.createElement('div');
  bar.id = 'loading-bar';
  loading.appendChild(note);
  loading.appendChild(context);
  loading.appendChild(bar);
  body.appendChild(loading);

  vm.runInNewContext(scriptSource(), sandbox);

  function item(id) {
    const root = document.getElementById('flc-gauges');
    const items = root ? root.childNodes : [];
    for (let i = 0; i < items.length; i += 1) {
      if (items[i].getAttribute('data-gauge') === id) return items[i];
    }
    return null;
  }

  function fillOf(id) {
    const node = item(id);
    const path = node && node.querySelector('.flc-g-fill');
    const dash = path ? path.getAttribute('stroke-dasharray') : '';
    const value = parseFloat(dash);
    return Number.isFinite(value) ? value : null;
  }

  function textOf(id) {
    const node = item(id);
    const text = node && node.querySelector('.flc-g-pct');
    return text ? text.textContent : '';
  }

  function expectOf(id) {
    const node = item(id);
    const text = node && node.querySelector('.flc-g-expect');
    return text ? text.textContent : '';
  }

  return {
    document,
    loading,
    note,
    bar,
    observers,
    api: sandbox.window.__flcGauges,
    item,
    fillOf,
    textOf,
    expectOf,
    countGauges() {
      return walkAll(document, '#flc-gauges', []).length;
    },
    setReduced(value) { reduceMotion = value === true; },
    flush(ts) {
      const batch = frames.splice(0, frames.length);
      for (let i = 0; i < batch.length; i += 1) batch[i].fn(ts);
    },
    flushUntilQuiet() {
      let guard = 0;
      let time = 0;
      while (frames.length && guard < 80) {
        time += 100;
        const batch = frames.splice(0, frames.length);
        for (let i = 0; i < batch.length; i += 1) batch[i].fn(time);
        guard += 1;
      }
    },
  };
}

describe('gauges on the loading overlay', () => {
  it('mounts one row immediately above the progress bar and leaves step text alone', () => {
    const host = createHost();
    expect(host.api.mount()).toBe(true);
    expect(host.api.mount()).toBe(true);
    const row = host.document.getElementById('flc-gauges');
    expect(row).toBeTruthy();
    expect(row.nextSibling).toBe(host.bar);
    expect(host.note.textContent).toBe('Step 3/8');
    expect(host.note.parentNode).toBe(host.loading);
    expect(host.note.nextSibling.id).toBe('context');
    expect(host.countGauges()).toBe(1);
    const live = host.observers.filter((observer) => observer.connected);
    expect(live).toHaveLength(1);
    expect(live[0].target).toBe(host.loading);
    expect(live[0].options).toEqual({ childList: true, subtree: true });
    expect(row.childNodes).toHaveLength(6);
    expect(host.document.getElementById('flc-g-style').textContent).toContain('flc-g-');
    expect(host.textOf('cache')).toBe('—');
    expect(host.item('cache').className).toContain('flc-g-unknown');
    expect(host.textOf('files')).toBe('0%');
  });

  it('snaps colors to the shared gauge scale when motion is reduced', () => {
    const host = createHost();
    host.setReduced(true);
    host.api.mount();
    host.api.setFills({ files: 0, objects: 0.25, modules: 0.5, scene: 0.75, cache: 1 });
    expect(host.item('files').querySelector('.flc-g-fill').getAttribute('stroke')).toBe(gaugeColor(0));
    expect(host.item('objects').querySelector('.flc-g-fill').getAttribute('stroke')).toBe(gaugeColor(0.25));
    expect(host.item('modules').querySelector('.flc-g-fill').getAttribute('stroke')).toBe(gaugeColor(0.5));
    expect(host.item('scene').querySelector('.flc-g-fill').getAttribute('stroke')).toBe(gaugeColor(0.75));
    expect(host.item('cache').querySelector('.flc-g-fill').getAttribute('stroke')).toBe(gaugeColor(1));
    expect(host.textOf('objects')).toBe('25%');
    expect(host.textOf('cache')).toBe('100%');
    expect(host.item('cache').className).not.toContain('flc-g-unknown');
  });

  it('keeps a partial update and a null cache from walking backward', () => {
    const host = createHost();
    host.setReduced(true);
    host.api.mount();
    host.api.setFills({ files: 0.8, cache: 0.6 });
    host.api.setFills({ objects: 0.4 });
    host.api.setFills({ files: 0.2, cache: null });
    expect(host.textOf('files')).toBe('80%');
    expect(host.textOf('cache')).toBe('60%');
    expect(host.textOf('objects')).toBe('40%');
    expect(host.textOf('modules')).toBe('0%');
    expect(host.textOf('scene')).toBe('0%');
  });

  it('eases a fill forward and settles on the target', () => {
    const host = createHost();
    host.setReduced(false);
    host.api.mount();
    host.api.setFills({ files: 1, cache: null, objects: 0, modules: 0, scene: 0 });
    host.flush(0);
    const early = host.fillOf('files');
    expect(early).toBeGreaterThan(0);
    expect(early).toBeLessThan(0.25);
    host.flushUntilQuiet();
    expect(host.fillOf('files')).toBeGreaterThan(0.99);
    expect(host.textOf('cache')).toBe('—');
  });

  it('shows only numeric expected labels', () => {
    const host = createHost();
    host.api.mount();
    host.api.setExpectedLabels({
      files: '1,240',
      cache: '80%',
      objects: '12 docs',
      modules: 'http://evil.example/mod',
      scene: 18,
    });
    expect(host.expectOf('files')).toBe('1,240');
    expect(host.expectOf('cache')).toBe('80%');
    expect(host.expectOf('objects')).toBe('');
    expect(host.expectOf('modules')).toBe('');
    expect(host.expectOf('scene')).toBe('18');
    const texts = [];
    (function collect(node) {
      if (!node) return;
      if (node._text) texts.push(node._text);
      const kids = node.childNodes || [];
      for (let i = 0; i < kids.length; i += 1) collect(kids[i]);
    }(host.loading));
    expect(texts.join('\n')).not.toContain('http');
    expect(texts.join('\n')).not.toContain('docs');
    expect(host.note.textContent).toBe('Step 3/8');
  });

  it('removes itself on destroy and remounts if Foundry rebuilds the overlay', () => {
    const host = createHost();
    host.api.mount();
    expect(host.observers.some((observer) => observer.connected)).toBe(true);
    host.api.destroy();
    expect(host.document.getElementById('flc-gauges')).toBeNull();
    expect(host.document.getElementById('flc-g-style')).toBeNull();
    expect(host.observers.some((observer) => observer.connected)).toBe(false);

    host.api.mount();
    const first = host.document.getElementById('flc-gauges');
    host.loading.removeChild(first);
    host.loading.removeChild(host.bar);
    const replacement = host.document.createElement('div');
    replacement.id = 'loading-bar';
    host.loading.appendChild(replacement);
    host.observers[0].callback();
    const again = host.document.getElementById('flc-gauges');
    expect(again).toBeTruthy();
    expect(again.nextSibling).toBe(replacement);
    expect(host.note.parentNode).toBe(host.loading);
    expect(host.note.textContent).toBe('Step 3/8');
  });
});
