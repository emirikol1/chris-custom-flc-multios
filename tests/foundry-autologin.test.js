import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOLOGIN_ARMED_RESULT,
  AUTOLOGIN_POLL_MS,
  AUTOLOGIN_TIMEOUT_MS,
  MATCH_USER_OPTION_SOURCE,
  buildAutologinBody,
  buildAutologinScript,
  isJoinPageUrl,
  matchUserOption,
} from '../electron/foundry-autologin.js';

const OPTIONS = [
  { value: '', text: '' },
  { value: 'u1', text: 'Gamemaster' },
  { value: 'u2', text: 'Chris' },
  { value: 'u3', text: 'Charlie' },
  { value: 'u4', text: '  Dana Scully ' },
];

// ---------------------------------------------------------------------------
// matchUserOption
// ---------------------------------------------------------------------------
describe('matchUserOption', () => {
  it('matches exact text', () => {
    expect(matchUserOption(OPTIONS, 'Chris')).toBe('u2');
  });

  it('matches case-insensitively and trims both sides', () => {
    expect(matchUserOption(OPTIONS, '  cHrIs ')).toBe('u2');
    expect(matchUserOption(OPTIONS, 'dana scully')).toBe('u4');
  });

  it('prefers exact over prefix when both exist', () => {
    const opts = [
      { value: 'a', text: 'Chris Proctor' },
      { value: 'b', text: 'Chris' },
    ];
    expect(matchUserOption(opts, 'chris')).toBe('b');
  });

  it('falls back to a unique prefix match', () => {
    expect(matchUserOption(OPTIONS, 'game')).toBe('u1');
    expect(matchUserOption(OPTIONS, 'Dana')).toBe('u4');
  });

  it('returns null for an ambiguous prefix', () => {
    // "ch" matches both Chris and Charlie
    expect(matchUserOption(OPTIONS, 'ch')).toBeNull();
  });

  it('ignores the blank placeholder option', () => {
    expect(matchUserOption(OPTIONS, '')).toBeNull();
    expect(matchUserOption(OPTIONS, '   ')).toBeNull();
    expect(matchUserOption([{ value: '', text: '' }], 'x')).toBeNull();
  });

  it('returns null with no options or bad input', () => {
    expect(matchUserOption([], 'Chris')).toBeNull();
    expect(matchUserOption(undefined, 'Chris')).toBeNull();
    expect(matchUserOption(OPTIONS, undefined)).toBeNull();
    expect(matchUserOption(OPTIONS, 'Nobody')).toBeNull();
  });

  it('tolerates options with missing text', () => {
    expect(matchUserOption([{ value: 'x' }, { value: 'y', text: null }], 'x')).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// Inlined matcher agrees with the exported one
// ---------------------------------------------------------------------------
describe('inlined matchUserOption', () => {
  const inlined = new Function(`return (${MATCH_USER_OPTION_SOURCE});`)();

  it('is a function named matchUserOption', () => {
    expect(typeof inlined).toBe('function');
    expect(inlined.name).toBe('matchUserOption');
  });

  it.each([
    ['Chris', 'u2'],
    ['  cHrIs ', 'u2'],
    ['game', 'u1'],
    ['ch', null],
    ['', null],
    ['Nobody', null],
    ['dana', 'u4'],
  ])('agrees with the exported matcher for %j', (username, expected) => {
    expect(inlined(OPTIONS, username)).toBe(expected);
    expect(matchUserOption(OPTIONS, username)).toBe(expected);
  });

  it('is embedded in the built script verbatim', () => {
    expect(buildAutologinScript({ username: 'a', password: 'b' })).toContain(MATCH_USER_OPTION_SOURCE);
  });
});

// ---------------------------------------------------------------------------
// buildAutologinScript — escaping / syntax
// ---------------------------------------------------------------------------
describe('buildAutologinScript', () => {
  it('returns an IIFE string that parses', () => {
    const script = buildAutologinScript({ username: 'Chris', password: 'hunter2' });
    expect(script.startsWith('(function (window, document) {')).toBe(true);
    expect(script.trimEnd().endsWith('})(window, document);')).toBe(true);
    expect(() => new Function(script)).not.toThrow();
  });

  it('embeds credentials only as one JSON literal', () => {
    const username = 'Chris';
    const password = 'p@ss"word';
    const script = buildAutologinScript({ username, password });
    const literal = JSON.stringify({ username, password });
    expect(script).toContain(`var CREDS = ${literal};`);
    // Exactly one occurrence of each credential string in the whole script.
    expect(script.split(JSON.stringify(username)).length - 1).toBe(1);
    expect(script.split(JSON.stringify(password)).length - 1).toBe(1);
    // Raw (unescaped) password must not appear outside the JSON literal.
    expect(script.replace(literal, '')).not.toContain(password);
  });

  it('safely escapes hostile usernames/passwords and still parses', () => {
    const hostile = [
      { username: '</script><script>alert(1)</script>', password: "'); alert(1); //" },
      { username: 'a"b\\c\nd', password: '`${process.exit()}`' },
      { username: '\u2028\u2029', password: '\u0000\u001f' },
    ];
    for (const creds of hostile) {
      const script = buildAutologinScript(creds);
      expect(() => new Function(script)).not.toThrow();
      const literal = JSON.stringify({ username: creds.username, password: creds.password });
      expect(script).toContain(literal);
      expect(script.replace(literal, '')).not.toContain('alert(1)');
      expect(script.replace(literal, '')).not.toContain('process.exit');
    }
  });

  it('coerces missing credentials to empty strings', () => {
    const script = buildAutologinScript({});
    expect(script).toContain('var CREDS = {"username":"","password":""};');
    expect(() => new Function(buildAutologinScript())).not.toThrow();
  });

  it('never references location, title, or outerHTML', () => {
    const script = buildAutologinScript({ username: 'a', password: 'b' });
    expect(script).not.toMatch(/\blocation\b/);
    expect(script).not.toMatch(/\.title\b/);
    expect(script).not.toMatch(/outerHTML|innerHTML/);
    expect(script).not.toMatch(/console\./);
  });
});

// ---------------------------------------------------------------------------
// Fake DOM harness
// ---------------------------------------------------------------------------
class FakeEl {
  constructor(props = {}) {
    this.events = [];
    this.clicks = 0;
    Object.assign(this, props);
  }
  dispatchEvent(ev) {
    this.events.push(ev.type);
    return true;
  }
  click() {
    this.clicks += 1;
  }
}

function makeFakeDom({ options, withButton = true, withPassword = true, withForm = true } = {}) {
  const select = new FakeEl({ name: 'userid', options: options ?? OPTIONS, value: '' });
  const password = withPassword ? new FakeEl({ name: 'password', value: '' }) : null;
  const button = withButton ? new FakeEl({ name: 'join' }) : null;

  const lookup = (sel) => {
    if (sel === 'select[name="userid"]') return select;
    if (sel === 'input[name="password"]') return password;
    if (sel === 'button[name="join"]') return button;
    return null;
  };

  const form = withForm
    ? new FakeEl({ id: 'join-game', requestSubmits: 0, querySelector: lookup })
    : null;
  if (form) {
    form.requestSubmit = function requestSubmit() {
      this.requestSubmits += 1;
    };
    select.form = form;
  }

  const document = {
    documentElement: {},
    querySelector(sel) {
      if (sel === 'form#join-game') return form;
      return lookup(sel);
    },
  };

  return { select, password, button, form, document };
}

class FakeEvent {
  constructor(type, init = {}) {
    this.type = type;
    this.bubbles = Boolean(init.bubbles);
  }
}

function makeFakeWindow({ withStatus = true, withObserver = false } = {}) {
  const statuses = [];
  const win = {
    Event: FakeEvent,
    setInterval: (...a) => setInterval(...a),
    clearInterval: (...a) => clearInterval(...a),
    setTimeout: (...a) => setTimeout(...a),
    clearTimeout: (...a) => clearTimeout(...a),
    statuses,
  };
  if (withStatus) {
    win.flcGame = { autologinStatus: (s) => statuses.push(s) };
  }
  if (withObserver) {
    win.observers = [];
    win.MutationObserver = class {
      constructor(cb) {
        this.cb = cb;
        this.observed = null;
        this.disconnected = false;
        win.observers.push(this);
      }
      observe(root, opts) {
        this.observed = { root, opts };
      }
      disconnect() {
        this.disconnected = true;
      }
    };
  }
  return win;
}

function run(win, doc, creds = { username: 'Chris', password: 'hunter2' }) {
  const body = buildAutologinBody(creds);
  const fn = new Function('window', 'document', body);
  return fn(win, doc);
}

// ---------------------------------------------------------------------------
// Injected body — DOM behaviour
// ---------------------------------------------------------------------------
describe('injected autologin body', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('selects the user, fills the password, clicks Join and reports success', () => {
    const win = makeFakeWindow();
    const dom = makeFakeDom();

    const result = run(win, dom.document);

    expect(result).toBe(AUTOLOGIN_ARMED_RESULT);
    expect(dom.select.value).toBe('u2');
    expect(dom.select.events).toEqual(['change']);
    expect(dom.password.value).toBe('hunter2');
    expect(dom.password.events).toEqual(['input', 'change']);
    expect(dom.button.clicks).toBe(1);
    expect(dom.form.requestSubmits).toBe(0);
    expect(win.statuses).toEqual([{ matched: true, submitted: true }]);
    expect(win.__flcAutologinDone).toBe(true);
  });

  it('falls back to form.requestSubmit() when the button is missing', () => {
    const win = makeFakeWindow();
    const dom = makeFakeDom({ withButton: false });

    run(win, dom.document);

    expect(dom.form.requestSubmits).toBe(1);
    expect(win.statuses).toEqual([{ matched: true, submitted: true }]);
  });

  it('reports matched:false with userCount (and no option text) when no user matches', () => {
    const win = makeFakeWindow();
    const dom = makeFakeDom();

    run(win, dom.document, { username: 'Nobody', password: 'x' });

    expect(win.statuses).toEqual([{ matched: false, userCount: OPTIONS.length }]);
    expect(win.__flcAutologinDone).toBe(true);
    expect(dom.button.clicks).toBe(0);
    expect(dom.password.value).toBe('');
    const serialized = JSON.stringify(win.statuses);
    for (const opt of OPTIONS) {
      if (opt.text.trim()) expect(serialized).not.toContain(opt.text.trim());
    }
    expect(serialized).not.toContain('Nobody');
  });

  it('reports matched:false on an ambiguous prefix', () => {
    const win = makeFakeWindow();
    const dom = makeFakeDom();
    run(win, dom.document, { username: 'ch', password: 'x' });
    expect(win.statuses).toEqual([{ matched: false, userCount: OPTIONS.length }]);
  });

  it('returns early and does nothing when the guard is already set', () => {
    const win = makeFakeWindow();
    win.__flcAutologinDone = true;
    const dom = makeFakeDom();

    const result = run(win, dom.document);

    expect(result).toBe(AUTOLOGIN_ARMED_RESULT);
    expect(dom.select.value).toBe('');
    expect(dom.button.clicks).toBe(0);
    expect(win.statuses).toEqual([]);
  });

  it('runs at most once per page load when injected twice', () => {
    const win = makeFakeWindow();
    const dom = makeFakeDom();

    run(win, dom.document);
    run(win, dom.document);

    expect(dom.button.clicks).toBe(1);
    expect(win.statuses).toHaveLength(1);
  });

  it('polls until the form appears, then submits and stops polling', () => {
    const win = makeFakeWindow();
    const dom = makeFakeDom();
    let ready = false;
    const lateDocument = {
      documentElement: {},
      querySelector: (sel) => (ready ? dom.document.querySelector(sel) : null),
    };

    run(win, lateDocument);
    expect(win.statuses).toEqual([]);
    expect(win.__flcAutologinDone).toBeUndefined();

    vi.advanceTimersByTime(AUTOLOGIN_POLL_MS * 4);
    expect(win.statuses).toEqual([]);

    ready = true;
    vi.advanceTimersByTime(AUTOLOGIN_POLL_MS);

    expect(win.statuses).toEqual([{ matched: true, submitted: true }]);
    expect(dom.button.clicks).toBe(1);
    expect(win.__flcAutologinDone).toBe(true);

    // Further ticks must not re-submit.
    vi.advanceTimersByTime(AUTOLOGIN_TIMEOUT_MS);
    expect(dom.button.clicks).toBe(1);
    expect(win.statuses).toHaveLength(1);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('gives up quietly after the timeout when the form never appears', () => {
    const win = makeFakeWindow({ withObserver: true });
    const emptyDocument = { documentElement: {}, querySelector: () => null };

    const result = run(win, emptyDocument);
    expect(result).toBe(AUTOLOGIN_ARMED_RESULT);
    expect(win.observers).toHaveLength(1);
    expect(win.observers[0].observed.opts).toEqual({ childList: true, subtree: true });

    vi.advanceTimersByTime(AUTOLOGIN_TIMEOUT_MS - 1);
    expect(win.__flcAutologinDone).toBeUndefined();

    vi.advanceTimersByTime(1);
    expect(win.__flcAutologinDone).toBe(true);
    expect(win.statuses).toEqual([]);
    expect(win.observers[0].disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reacts to a MutationObserver callback when the form is inserted', () => {
    const win = makeFakeWindow({ withObserver: true });
    const dom = makeFakeDom();
    let ready = false;
    const lateDocument = {
      documentElement: {},
      querySelector: (sel) => (ready ? dom.document.querySelector(sel) : null),
    };

    run(win, lateDocument);
    ready = true;
    win.observers[0].cb([]);

    expect(win.statuses).toEqual([{ matched: true, submitted: true }]);
    expect(win.observers[0].disconnected).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('works without window.flcGame (no reporting, still submits)', () => {
    const win = makeFakeWindow({ withStatus: false });
    const dom = makeFakeDom();

    expect(() => run(win, dom.document)).not.toThrow();
    expect(dom.button.clicks).toBe(1);
    expect(win.__flcAutologinDone).toBe(true);
  });

  it('reports a bare exception marker when the DOM throws', () => {
    const win = makeFakeWindow();
    const secretMessage = 'super secret failure detail';
    const explodingDocument = {
      documentElement: {},
      querySelector: () => {
        throw new Error(secretMessage);
      },
    };

    const result = run(win, explodingDocument);

    expect(result).toBe(AUTOLOGIN_ARMED_RESULT);
    expect(win.statuses).toEqual([{ matched: false, error: 'exception' }]);
    expect(JSON.stringify(win.statuses)).not.toContain(secretMessage);
    expect(win.__flcAutologinDone).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('reports exception when the throw happens during a later poll', () => {
    const win = makeFakeWindow();
    let explode = false;
    const flakyDocument = {
      documentElement: {},
      querySelector: () => {
        if (!explode) return null;
        throw new Error('boom');
      },
    };

    run(win, flakyDocument);
    expect(win.statuses).toEqual([]);
    explode = true;
    vi.advanceTimersByTime(AUTOLOGIN_POLL_MS);
    expect(win.statuses).toEqual([{ matched: false, error: 'exception' }]);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('never leaks the password into the status report', () => {
    const win = makeFakeWindow();
    const dom = makeFakeDom();
    run(win, dom.document, { username: 'Chris', password: 'hunter2' });
    const serialized = JSON.stringify(win.statuses);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('Chris');
  });
});

// ---------------------------------------------------------------------------
// isJoinPageUrl
// ---------------------------------------------------------------------------
describe('isJoinPageUrl', () => {
  it.each([
    ['http://localhost:30000/join', true],
    ['https://foundry.example.com/join', true],
    ['https://foundry.example.com/join/', true],
    ['https://foundry.example.com/join?foo=bar#x', true],
    ['https://example.com/foundry/join', true],
    ['https://example.com/game', false],
    ['https://example.com/', false],
    ['https://example.com/joinx', false],
    ['https://example.com/join/extra', false],
    ['https://example.com/setup', false],
    ['not a url', false],
    ['', false],
    [null, false],
    [undefined, false],
    [42, false],
  ])('%j → %s', (input, expected) => {
    expect(isJoinPageUrl(input)).toBe(expected);
  });
});
