import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  CENTER_PROMPTS_POLL_MS,
  buildCenterPromptsBody,
  buildCenterPromptsScript,
  centerInViewport,
  centerPromptsEnabled,
  isShortLivedPrompt,
  normalizePromptGlow,
  normalizePromptGlowStrength,
  PROMPT_GLOW_COLORS,
  promptAutoRaiseEnabled,
  promptHighlightEnabled,
  promptMarkerCss,
} from '../electron/center-prompts.js';

describe('centerPromptsEnabled', () => {
  it('is on when the server has never stored a choice', () => {
    expect(centerPromptsEnabled(undefined)).toBe(true);
    expect(centerPromptsEnabled({})).toBe(true);
  });

  it('honours an explicit false or true', () => {
    expect(centerPromptsEnabled(false)).toBe(false);
    expect(centerPromptsEnabled(true)).toBe(true);
    expect(centerPromptsEnabled({ centerPrompts: false })).toBe(false);
    expect(centerPromptsEnabled({ centerPrompts: true })).toBe(true);
  });
});

describe('isShortLivedPrompt', () => {
  it('accepts Foundry dialogs, names ending in Dialog, and modal apps', () => {
    expect(isShortLivedPrompt({ constructor: { name: 'Dialog' } })).toBe(true);
    expect(isShortLivedPrompt({ constructor: { name: 'DialogV2' } })).toBe(true);
    expect(isShortLivedPrompt({ constructor: { name: 'ActivityUsageDialog' } })).toBe(true);
    expect(isShortLivedPrompt({ constructor: { name: 'FilePicker' }, options: { modal: true } })).toBe(true);
    expect(isShortLivedPrompt({
      constructor: { name: 'CustomPrompt' },
      options: { window: { modal: true } },
    })).toBe(true);
  });

  it('rejects sheets, sidebar tabs, and ordinary apps', () => {
    expect(isShortLivedPrompt({
      constructor: { name: 'ActorSheet' },
      document: { uuid: 'Actor.abc' },
    })).toBe(false);
    expect(isShortLivedPrompt({
      constructor: { name: 'Dialog' },
      document: { uuid: 'Actor.abc' },
      options: { modal: true },
    })).toBe(false);
    expect(isShortLivedPrompt({ constructor: { name: 'ChatLog' }, tabName: 'chat' })).toBe(false);
    expect(isShortLivedPrompt({ constructor: { name: 'CombatTracker' } })).toBe(false);
    expect(isShortLivedPrompt(null)).toBe(false);
  });
});

describe('centerInViewport', () => {
  it('places the box in the middle of the viewport', () => {
    expect(centerInViewport({ width: 1000, height: 800 }, { width: 400, height: 200 })).toEqual({
      left: 300,
      top: 300,
    });
  });

  it('clamps to the origin when the box is larger than the viewport', () => {
    expect(centerInViewport({ width: 100, height: 80 }, { width: 400, height: 200 })).toEqual({
      left: 0,
      top: 0,
    });
  });
});

function makeProto() {
  const proto = {
    setPosition(position) {
      this.calls.push(position);
      return position;
    },
    render() {
      this.rendered = true;
      return this.setPosition({
        left: 8,
        top: 9,
        width: this.position.width,
        height: this.position.height,
      });
    },
  };
  return proto;
}

function makeApp(proto, ctorName, fields = {}) {
  function Ctor() {}
  Object.defineProperty(Ctor, 'name', { value: ctorName });
  Ctor.prototype = proto;
  const app = Object.create(proto);
  app.constructor = Ctor;
  app.calls = [];
  app.position = { width: 400, height: 200, left: 1, top: 2 };
  app.rendered = false;
  Object.assign(app, fields);
  return app;
}

function makeWindow(proto) {
  function Application() {}
  Application.prototype = proto;
  return {
    innerWidth: 1000,
    innerHeight: 800,
    Application,
    setInterval: (...args) => setInterval(...args),
    clearInterval: (...args) => clearInterval(...args),
  };
}

function run(win, enabled, highlight, glow) {
  const body = buildCenterPromptsBody(enabled, highlight, glow);
  const fn = new Function('window', body);
  return fn(win);
}

describe('injected center-prompts body', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a script that parses and does not touch page content', () => {
    const script = buildCenterPromptsScript(true);
    expect(script.startsWith('(function (window) {')).toBe(true);
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toMatch(/\blocation\b/);
    expect(script).not.toMatch(/password|username|innerHTML|outerHTML|console\./);
  });

  it('centers a dialog and leaves a sheet where it was', () => {
    const proto = makeProto();
    const win = makeWindow(proto);
    run(win, true);

    const dialog = makeApp(proto, 'Dialog');
    dialog.setPosition({ left: 0, top: 0, width: 400, height: 200 });
    expect(dialog.calls[0]).toMatchObject({ left: 300, top: 300, width: 400, height: 200 });

    const sheet = makeApp(proto, 'ActorSheet', { document: { uuid: 'Actor.abc' } });
    sheet.setPosition({ left: 4, top: 5, width: 400, height: 200 });
    expect(sheet.calls[0]).toMatchObject({ left: 4, top: 5 });
  });

  it('lets a drag stick, ignores header buttons, and recenters the next open', () => {
    const proto = makeProto();
    const win = makeWindow(proto);
    run(win, true);
    const el = {
      nodeType: 1,
      addEventListener(type, fn, capture) {
        this.type = type;
        this.fn = fn;
        this.capture = capture;
      },
    };
    const dialog = makeApp(proto, 'Dialog', { element: el });

    dialog.setPosition({ left: 0, top: 0, width: 400, height: 200 });
    expect(dialog.calls.at(-1).left).toBe(300);
    expect(el.type).toBe('pointerdown');
    expect(el.capture).toBe(true);
    el.fn({
      button: 0,
      target: {
        closest(sel) {
          return sel === '.window-header' ? {} : null;
        },
      },
    });
    dialog.setPosition({ left: 12, top: 34, width: 400, height: 200 });
    expect(dialog.calls.at(-1)).toMatchObject({ left: 12, top: 34 });

    el.fn({
      button: 0,
      target: {
        closest(sel) {
          if (sel === '.window-header') return {};
          return String(sel).includes('button') ? {} : null;
        },
      },
    });
    dialog.rendered = false;
    dialog.render();
    expect(dialog.calls.at(-1)).toMatchObject({ left: 300, top: 300 });
  });

  it('tells PopOut to leave a prompt in the main window before that prompt renders', () => {
    const proto = makeProto();
    const inner = proto.render;
    proto.render = function render() {
      this.blockedDuringRender = this._disable_popout_module === true
        && this.options.popOutModuleDisable === true;
      return inner.apply(this, arguments);
    };
    const win = makeWindow(proto);
    run(win, true);

    const shared = { popOut: true };
    const dialog = makeApp(proto, 'Dialog', { options: shared });
    dialog.constructor.DEFAULT_OPTIONS = shared;
    dialog.render();
    expect(dialog.blockedDuringRender).toBe(true);
    expect(shared.popOutModuleDisable).toBeUndefined();
    expect(dialog.options).not.toBe(shared);

    const sheet = makeApp(proto, 'ActorSheet', {
      document: { uuid: 'Actor.abc' },
      options: { popOut: true },
    });
    sheet.render();
    expect(sheet._disable_popout_module).toBeUndefined();
    expect(sheet.options.popOutModuleDisable).toBeUndefined();
  });

  it('uses a stronger glow in light mode than in dark mode', () => {
    const css = promptMarkerCss();
    expect(css).toContain('--flc-glow: rgba(6, 58, 140, 0.95)');
    expect(css).toContain('calc(48px * var(--flc-strength, 1))');
    expect(css).toContain('calc(18px * var(--flc-strength, 1))');
    expect(css).toContain('--flc-glow: rgba(179, 205, 255, 0.7)');
    expect(css).toContain('calc(30px * var(--flc-strength, 1))');
    expect(css).toContain('calc(8px * var(--flc-strength, 1))');
    expect(css).toContain('--flc-glow: rgba(255, 194, 0, 0.95)');
    expect(css).toContain('prefers-color-scheme: dark');
    expect(css).toContain('prefers-reduced-motion: reduce');
    expect(css).toContain('forced-colors: active');
    expect(css).toContain('CanvasText');
    expect(css).not.toContain('.window-header');
    expect(css).toContain('data-flc-glow="white"');
    expect(css).toContain('rgba(0, 0, 0, 0.9)');
    for (const color of ['red', 'orange', 'yellow', 'green', 'purple', 'pink']) {
      expect(css).toContain(`data-flc-glow="${color}"`);
    }
  });

  it('uses the eight named colors and treats an unknown choice as blue', () => {
    expect(PROMPT_GLOW_COLORS.map((color) => color.id)).toEqual([
      'blue', 'red', 'orange', 'yellow', 'green', 'purple', 'pink', 'white',
    ]);
    expect(normalizePromptGlow(undefined)).toBe('blue');
    expect(normalizePromptGlow('nope')).toBe('blue');
    expect(normalizePromptGlow('pink')).toBe('pink');
    expect(promptHighlightEnabled(undefined)).toBe(true);
    expect(promptHighlightEnabled(false)).toBe(false);
    expect(promptAutoRaiseEnabled(undefined)).toBe(true);
    expect(promptAutoRaiseEnabled(false)).toBe(false);
    expect(promptAutoRaiseEnabled({ promptAutoRaise: false })).toBe(false);
    expect(normalizePromptGlowStrength(undefined)).toBe(100);
    expect(normalizePromptGlowStrength(150)).toBe(150);
    expect(normalizePromptGlowStrength(400)).toBe(300);
    expect(normalizePromptGlowStrength(-5)).toBe(0);
  });

  it('marks a prompt when centering is off and can turn the highlight off', () => {
    const proto = makeProto();
    const win = makeWindow(proto);
    const styles = [];
    const doc = {
      head: { appendChild(node) { styles.push(node); } },
      getElementById(id) { return styles.find((s) => s.id === id) || null; },
      createElement() { return { id: '', textContent: '' }; },
    };
    const attrs = {};
    const el = {
      nodeType: 1,
      ownerDocument: doc,
      classList: {
        names: [],
        add(name) { if (!this.names.includes(name)) this.names.push(name); },
        remove(name) { this.names = this.names.filter((item) => item !== name); },
      },
      setAttribute(name, value) { attrs[name] = value; },
      removeAttribute(name) { delete attrs[name]; },
    };
    run(win, false, true, 'red');
    makeApp(proto, 'Dialog', { element: el }).render();
    expect(el.classList.names).toContain('flc-needs-response');
    expect(attrs['data-flc-glow']).toBe('red');
    expect(styles[0].id).toBe('flc-prompt-style');

    run(win, false, false, 'red');
    expect(el.classList.names).not.toContain('flc-needs-response');
    expect(attrs['data-flc-glow']).toBeUndefined();

    const sheetEl = {
      nodeType: 1,
      ownerDocument: doc,
      classList: { names: [], add(name) { this.names.push(name); }, remove() {} },
      setAttribute() { throw new Error('sheet should not be marked'); },
    };
    makeApp(proto, 'ActorSheet', {
      document: { uuid: 'Actor.abc' },
      element: sheetEl,
    }).render();
    expect(sheetEl.classList.names).toEqual([]);
  });

  it('does not block PopOut when centering is off', () => {
    const proto = makeProto();
    const win = makeWindow(proto);
    run(win, false);
    const dialog = makeApp(proto, 'Dialog', { options: { popOut: true } });
    dialog.render();
    expect(dialog._disable_popout_module).toBeUndefined();
    expect(dialog.options.popOutModuleDisable).toBeUndefined();
  });

  it('does not recenter a prompt that is already open and has been dragged', () => {
    const proto = makeProto();
    const win = makeWindow(proto);
    run(win, true);
    const dialog = makeApp(proto, 'ActivityUsageDialog');
    dialog.rendered = true;
    dialog._flcPromptMoved = true;
    dialog.render();
    expect(dialog.calls.at(-1)).toMatchObject({ left: 8, top: 9 });
  });

  it('stops centering after a later inject turns the preference off', () => {
    const proto = makeProto();
    const win = makeWindow(proto);
    run(win, true);
    run(win, false);
    const dialog = makeApp(proto, 'DialogV2');
    dialog.setPosition({ left: 6, top: 7, width: 400, height: 200 });
    expect(dialog.calls[0]).toMatchObject({ left: 6, top: 7 });
    expect(dialog.calls).toHaveLength(1);
  });

  it('hooks ApplicationV2 dialogs', () => {
    const v1 = makeProto();
    const v2 = makeProto();
    const win = makeWindow(v1);
    function ApplicationV2() {}
    ApplicationV2.prototype = v2;
    win.foundry = { applications: { api: { ApplicationV2 } } };
    run(win, true);
    const dialog = makeApp(v2, 'DialogV2', { options: { window: { modal: true } } });
    dialog.setPosition({ left: 0, top: 0, width: 200, height: 100 });
    expect(dialog.calls[0]).toMatchObject({ left: 400, top: 350 });
  });

  it('asks for OS attention once per prompt open and not for a sheet', () => {
    const proto = makeProto();
    proto.close = function close() {
      this.rendered = false;
    };
    const calls = [];
    const win = makeWindow(proto);
    win.flcGame = { promptAttention: () => calls.push(true) };
    run(win, true);

    const dialog = makeApp(proto, 'Dialog');
    dialog.setPosition({ left: 0, top: 0, width: 400, height: 200 });
    dialog.setPosition({ left: 10, top: 10, width: 400, height: 200 });
    const sheet = makeApp(proto, 'ActorSheet', { document: { uuid: 'Actor.abc' } });
    sheet.setPosition({ left: 1, top: 1, width: 400, height: 200 });
    dialog.close();
    dialog.render();
    expect(calls).toEqual([true, true]);
  });

  it('asks the window that holds the prompt, when that is a popout', () => {
    const proto = makeProto();
    const win = makeWindow(proto);
    const mainCalls = [];
    const popCalls = [];
    win.flcGame = { promptAttention: () => mainCalls.push(true) };
    const pop = { flcGame: { promptAttention: () => popCalls.push(true) } };
    run(win, true);
    const dialog = makeApp(proto, 'Dialog', {
      element: { nodeType: 1, ownerDocument: { defaultView: pop } },
    });
    dialog.setPosition({ left: 0, top: 0, width: 400, height: 200 });
    expect(popCalls).toEqual([true]);
    expect(mainCalls).toEqual([]);
  });

  it('waits until Application exists, then stops polling', () => {
    const proto = makeProto();
    const win = {
      innerWidth: 1000,
      innerHeight: 800,
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
    };
    run(win, true);
    expect(vi.getTimerCount()).toBe(1);
    function Application() {}
    Application.prototype = proto;
    win.Application = Application;
    vi.advanceTimersByTime(CENTER_PROMPTS_POLL_MS);
    expect(vi.getTimerCount()).toBe(0);
    const dialog = makeApp(proto, 'Dialog');
    dialog.setPosition({ left: 0, top: 0, width: 400, height: 200 });
    expect(dialog.calls[0].left).toBe(300);
  });
});
