import { readFileSync } from 'node:fs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  AUTOLOGIN_ARMED_RESULT,
  AUTOLOGIN_POLL_MS,
  AUTOLOGIN_SKIP_KEY,
  AUTOLOGIN_TIMEOUT_MS,
  MATCH_USER_OPTION_SOURCE,
  buildAutologinBody,
  buildAutologinScript,
  buildLogoutIntentBody,
  buildLogoutIntentScript,
  isGamePageUrl,
  isJoinPageUrl,
  matchUserOption,
} from '../electron/foundry-autologin.js';

const OPTIONS = [
  { value: '', text: '' },
  { value: 'u1', text: 'Gamemaster' },
  { value: 'u2', text: 'Quinn' },
  { value: 'u3', text: 'Quincy' },
  { value: 'u4', text: '  Dana Scully ' },
];

// ---------------------------------------------------------------------------
// matchUserOption
// ---------------------------------------------------------------------------
describe('matchUserOption', () => {
  it('matches exact text', () => {
    expect(matchUserOption(OPTIONS, 'Quinn')).toBe('u2');
  });

  it('matches case-insensitively and trims both sides', () => {
    expect(matchUserOption(OPTIONS, '  qUiNn ')).toBe('u2');
    expect(matchUserOption(OPTIONS, 'dana scully')).toBe('u4');
  });

  it('prefers exact over prefix when both exist', () => {
    const opts = [
      { value: 'a', text: 'Quinn Harper' },
      { value: 'b', text: 'Quinn' },
    ];
    expect(matchUserOption(opts, 'quinn')).toBe('b');
  });

  it('falls back to a unique prefix match', () => {
    expect(matchUserOption(OPTIONS, 'game')).toBe('u1');
    expect(matchUserOption(OPTIONS, 'Dana')).toBe('u4');
  });

  it('returns null for an ambiguous prefix', () => {
    // "qu" matches both Quinn and Quincy
    expect(matchUserOption(OPTIONS, 'qu')).toBeNull();
  });

  it('ignores the blank placeholder option', () => {
    expect(matchUserOption(OPTIONS, '')).toBeNull();
    expect(matchUserOption(OPTIONS, '   ')).toBeNull();
    expect(matchUserOption([{ value: '', text: '' }], 'x')).toBeNull();
  });

  it('returns null with no options or bad input', () => {
    expect(matchUserOption([], 'Quinn')).toBeNull();
    expect(matchUserOption(undefined, 'Quinn')).toBeNull();
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
    ['Quinn', 'u2'],
    ['  qUiNn ', 'u2'],
    ['game', 'u1'],
    ['qu', null],
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
    const script = buildAutologinScript({ username: 'Quinn', password: 'hunter2' });
    expect(script.startsWith('(function (window, document) {')).toBe(true);
    expect(script.trimEnd().endsWith('})(window, document);')).toBe(true);
    expect(() => new Function(script)).not.toThrow();
  });

  it('embeds credentials only as one JSON literal', () => {
    const username = 'Quinn';
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

function makeSessionStorage(initial = {}) {
  const data = { ...initial };
  return {
    getItem(key) {
      return Object.prototype.hasOwnProperty.call(data, key) ? data[key] : null;
    },
    setItem(key, value) {
      data[key] = String(value);
    },
    removeItem(key) {
      delete data[key];
    },
  };
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

function run(win, doc, creds = { username: 'Quinn', password: 'hunter2' }) {
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
    run(win, dom.document, { username: 'qu', password: 'x' });
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
    run(win, dom.document, { username: 'Quinn', password: 'hunter2' });
    const serialized = JSON.stringify(win.statuses);
    expect(serialized).not.toContain('hunter2');
    expect(serialized).not.toContain('Quinn');
  });

  it('does not submit when the user intentionally logged out', () => {
    const win = makeFakeWindow();
    win.sessionStorage = makeSessionStorage({ [AUTOLOGIN_SKIP_KEY]: '1' });
    const dom = makeFakeDom();

    const result = run(win, dom.document);

    expect(result).toBe(AUTOLOGIN_ARMED_RESULT);
    expect(dom.button.clicks).toBe(0);
    expect(dom.select.value).toBe('');
    expect(dom.password.value).toBe('');
    expect(win.__flcAutologinDone).toBe(true);
    expect(win.statuses).toEqual([{ skipped: 'logout' }]);
    expect(win.sessionStorage.getItem(AUTOLOGIN_SKIP_KEY)).toBe('1');
    expect(vi.getTimerCount()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// isJoinPageUrl
// ---------------------------------------------------------------------------
function runLogout(win, doc) {
  const body = buildLogoutIntentBody();
  const fn = new Function('window', 'document', body);
  return fn(win, doc);
}

describe('logout intent marker', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it('builds a script that parses and does not touch credentials or location', () => {
    const script = buildLogoutIntentScript();
    expect(script.startsWith('(function (window, document) {')).toBe(true);
    expect(() => new Function(script)).not.toThrow();
    expect(script).not.toMatch(/\blocation\b/);
    expect(script).not.toMatch(/password|username|console\./);
    expect(script).toContain(JSON.stringify(AUTOLOGIN_SKIP_KEY));
  });

  it('clears a previous logout when the game page arms, then records the next logOut', () => {
    const calls = [];
    const win = {
      sessionStorage: makeSessionStorage({ [AUTOLOGIN_SKIP_KEY]: '1' }),
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
      game: {
        logOut(...args) {
          calls.push(args);
          return 'left';
        },
      },
    };
    const doc = { addEventListener() {} };

    runLogout(win, doc);
    expect(win.sessionStorage.getItem(AUTOLOGIN_SKIP_KEY)).toBeNull();

    const result = win.game.logOut('user');
    expect(result).toBe('left');
    expect(calls).toEqual([['user']]);
    expect(win.sessionStorage.getItem(AUTOLOGIN_SKIP_KEY)).toBe('1');
  });

  it('records a click on the logout control before Foundry handles it', () => {
    const win = {
      sessionStorage: makeSessionStorage(),
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
      game: { logOut() {} },
    };
    let click = null;
    const doc = {
      addEventListener(type, fn, capture) {
        if (type === 'click') click = { fn, capture };
      },
    };
    const icon = {
      closest(sel) {
        return String(sel).includes('[data-action="logout"]') ? icon : null;
      },
    };

    runLogout(win, doc);
    expect(click.capture).toBe(true);
    click.fn({ target: icon });
    expect(win.sessionStorage.getItem(AUTOLOGIN_SKIP_KEY)).toBe('1');

    win.sessionStorage.removeItem(AUTOLOGIN_SKIP_KEY);
    click.fn({ target: { closest() { return null; } } });
    expect(win.sessionStorage.getItem(AUTOLOGIN_SKIP_KEY)).toBeNull();
  });

  it('does not clear a logout that happened before a second inject on the same page', () => {
    const win = {
      sessionStorage: makeSessionStorage(),
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
      game: { logOut() {} },
    };
    const doc = { addEventListener() {} };

    runLogout(win, doc);
    win.game.logOut();
    runLogout(win, doc);

    expect(win.sessionStorage.getItem(AUTOLOGIN_SKIP_KEY)).toBe('1');
  });

  it('waits until game.logOut exists, then stops polling', () => {
    const win = {
      sessionStorage: makeSessionStorage(),
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
    };
    runLogout(win, { addEventListener() {} });
    expect(vi.getTimerCount()).toBe(1);

    win.game = { logOut() { return 'ok'; } };
    vi.advanceTimersByTime(250);
    expect(win.game.logOut()).toBe('ok');
    expect(win.sessionStorage.getItem(AUTOLOGIN_SKIP_KEY)).toBe('1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('keeps watching for game.logOut through a slow world load', () => {
    const win = {
      sessionStorage: makeSessionStorage(),
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
    };
    runLogout(win, { addEventListener() {} });
    vi.advanceTimersByTime(AUTOLOGIN_POLL_MS * 80);
    expect(vi.getTimerCount()).toBe(1);

    win.game = { logOut() { return 'left'; } };
    vi.advanceTimersByTime(AUTOLOGIN_POLL_MS);
    expect(win.game.logOut()).toBe('left');
    expect(win.sessionStorage.getItem(AUTOLOGIN_SKIP_KEY)).toBe('1');
    expect(vi.getTimerCount()).toBe(0);
  });

  it('tells the client to stay on the join screen before Foundry can wipe storage', () => {
    const intents = [];
    const storage = makeSessionStorage();
    storage.clear = () => {
      storage.removeItem(AUTOLOGIN_SKIP_KEY);
    };
    const win = {
      sessionStorage: storage,
      flcGame: {
        logoutIntent() {
          intents.push('intent');
        },
      },
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
      game: {
        logOut() {
          storage.clear();
          return 'left';
        },
      },
    };

    runLogout(win, { addEventListener() {} });
    expect(win.game.logOut()).toBe('left');
    expect(intents).toEqual(['intent']);
    expect(storage.getItem(AUTOLOGIN_SKIP_KEY)).toBeNull();
  });

  it('records a logout click inside an open shadow root', () => {
    const intents = [];
    const win = {
      sessionStorage: makeSessionStorage(),
      flcGame: {
        logoutIntent() {
          intents.push('intent');
        },
      },
      setInterval: (...args) => setInterval(...args),
      clearInterval: (...args) => clearInterval(...args),
      game: { logOut() {} },
    };
    let click = null;
    const doc = {
      addEventListener(type, fn, capture) {
        if (type === 'click') click = { fn, capture };
      },
    };
    const button = {
      closest(sel) {
        return String(sel).includes('[data-action="logout"]') ? button : null;
      },
    };
    const host = { closest() { return null; } };

    runLogout(win, doc);
    click.fn({
      target: host,
      composedPath() {
        return [button, host];
      },
    });

    expect(win.sessionStorage.getItem(AUTOLOGIN_SKIP_KEY)).toBe('1');
    expect(intents).toEqual(['intent']);
  });
});

describe('logout stays disconnected in the game window', () => {
  it('arms the logout watcher on the game page and pauses auto-login from that signal', () => {
    const gameWindow = readFileSync(new URL('../electron/game-window.js', import.meta.url), 'utf8');
    const preload = readFileSync(new URL('../electron/preload-game.js', import.meta.url), 'utf8');

    expect(gameWindow).toContain('buildLogoutIntentScript()');
    expect(gameWindow).toContain("ipcMain.on('foundry:logout-intent'");
    expect(gameWindow).toContain('autologin skipped after logout');
    expect(gameWindow).toContain('isGamePageUrl');
    expect(preload).toContain("ipcRenderer.sendSync('foundry:logout-intent')");
  });
});

describe('isGamePageUrl', () => {
  it.each([
    ['http://localhost:30000/game', true],
    ['https://foundry.example.com/game/', true],
    ['https://example.com/foundry/game', true],
    ['https://example.com/game?x=1#y', true],
    ['https://example.com/join', false],
    ['https://example.com/gameplay', false],
    ['https://example.com/game/extra', false],
    ['https://example.com/', false],
    ['not a url', false],
    ['', false],
    [null, false],
  ])('%j → %s', (input, expected) => {
    expect(isGamePageUrl(input)).toBe(expected);
  });
});

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
