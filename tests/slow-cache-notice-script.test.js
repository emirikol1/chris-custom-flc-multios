import vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { buildAdminMessage } from '../electron/slow-cache-advice.js';
import { buildSlowCacheNoticeScript } from '../electron/slow-cache-notice-script.js';

function es5(src) {
  expect(src).not.toContain('`');
  expect(src).not.toContain('=>');
  expect(src).not.toContain('->');
  expect(src).not.toMatch(/\blet\b/);
  expect(src).not.toMatch(/\bconst\b/);
  expect(() => new Function(src)).not.toThrow();
}

function createHost() {
  const observers = [];

  function make(tag) {
    const node = {
      tagName: String(tag).toUpperCase(),
      id: '',
      className: '',
      parentNode: null,
      childNodes: [],
      attributes: Object.create(null),
      style: {},
      _text: '',
      _listeners: Object.create(null),
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
    node.select = function select() {};
    node.addEventListener = function addEventListener(type, fn) {
      const key = String(type);
      if (!this._listeners[key]) this._listeners[key] = [];
      this._listeners[key].push(fn);
    };
    node.querySelector = function querySelector(sel) {
      return walk(this, sel);
    };
    node.querySelectorAll = function querySelectorAll(sel) {
      const out = [];
      String(sel).split(',').forEach((part) => walkAll(this, part.trim(), out));
      return out;
    };
    return node;
  }

  function classHas(node, name) {
    return (` ${node.className} `).indexOf(` ${name} `) !== -1;
  }

  function match(node, sel) {
    if (!node || !sel || node.tagName === '#document') return false;
    if (sel.charAt(0) === '#') return node.id === sel.slice(1);
    if (sel.indexOf('.') !== -1) {
      const bits = sel.split('.');
      const tag = bits[0];
      if (tag && node.tagName !== tag.toUpperCase()) return false;
      return bits.slice(1).every((name) => name && classHas(node, name));
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
    const out = [];
    String(sel).split(',').forEach((part) => walkAll(document, part.trim(), out));
    return out;
  };
  document.getElementById = function getElementById(id) { return walk(document, `#${id}`); };
  document.execCommand = function execCommand() { return false; };

  const head = make('head');
  const body = make('body');
  document.appendChild(head);
  document.appendChild(body);
  document.head = head;
  document.body = body;

  function MutationObserver(callback) {
    this.callback = callback;
    observers.push(this);
  }
  MutationObserver.prototype.observe = function observe() {};
  MutationObserver.prototype.disconnect = function disconnect() { this.callback = null; };

  const copied = [];
  const sandbox = {
    document,
    MutationObserver,
    setTimeout,
    clearTimeout,
    navigator: {
      clipboard: {
        writeText(text) {
          copied.push(text);
          return Promise.resolve();
        },
      },
    },
  };
  sandbox.window = sandbox;

  const overlay = make('div');
  overlay.id = 'fvtt-loading-progress';
  const card = make('main');
  card.className = 'flp-card';
  const track = make('div');
  track.className = 'flp-track';
  const hide = make('button');
  hide.textContent = 'Hide';
  card.appendChild(track);
  card.appendChild(hide);
  overlay.appendChild(card);
  body.appendChild(overlay);

  return { sandbox, observers, copied, overlay, card, track, hide, document };
}

describe('buildSlowCacheNoticeScript', () => {
  it('is an ES5 script that mounts after the track and copies the admin note', async () => {
    const message = buildAdminMessage({ proxy: 'nginx' });
    const src = buildSlowCacheNoticeScript(message);
    es5(src);
    expect(src).toContain('flc-slow-cache');
    expect(src).toContain('Copy message for your server admin');
    expect(src).toContain('stale-while-revalidate');
    expect(src).not.toContain('__FLC_MESSAGE__');

    const host = createHost();
    vm.runInNewContext(src, host.sandbox);
    const notice = host.document.getElementById('flc-slow-cache');
    expect(notice).toBeTruthy();
    const order = host.card.childNodes;
    const trackAt = order.indexOf(host.track);
    const noticeAt = order.indexOf(notice);
    const hideAt = order.indexOf(host.hide);
    expect(noticeAt).toBe(trackAt + 1);
    expect(hideAt).toBe(noticeAt + 1);

    const copy = notice.querySelector('.flc-slow-cache-copy');
    expect(copy).toBeTruthy();
    expect(copy.textContent).toBe('Copy message for your server admin');
    copy._listeners.click[0]();
    await Promise.resolve();
    expect(host.copied[0]).toContain('nginx -t');
    expect(host.copied[0]).toContain('http2');
  });

  it('unmounts when the overlay is finished', () => {
    const src = buildSlowCacheNoticeScript('hello');
    es5(src);
    const host = createHost();
    vm.runInNewContext(src, host.sandbox);
    expect(host.document.getElementById('flc-slow-cache')).toBeTruthy();
    host.overlay.className = 'flp-finished';
    expect(host.observers.length).toBeGreaterThan(0);
    host.observers[0].callback();
    expect(host.document.getElementById('flc-slow-cache')).toBeNull();
  });

  it('falls back to execCommand when clipboard rejects', async () => {
    const src = buildSlowCacheNoticeScript('fallback note');
    const host = createHost();
    let commanded = '';
    host.document.execCommand = function execCommand(cmd) {
      commanded = cmd;
      return true;
    };
    host.sandbox.navigator.clipboard.writeText = function writeText() {
      return Promise.reject(new Error('nope'));
    };
    vm.runInNewContext(src, host.sandbox);
    const copy = host.document.getElementById('flc-slow-cache').querySelector('.flc-slow-cache-copy');
    copy._listeners.click[0]();
    await Promise.resolve();
    await Promise.resolve();
    expect(commanded).toBe('copy');
  });
});
