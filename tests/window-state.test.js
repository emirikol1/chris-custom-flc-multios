import fs from 'fs';
import os from 'os';
import path from 'path';
import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createWindowStateStore,
  pickBounds,
  readStates,
  writeStates,
  SAVE_DEBOUNCE_MS,
} from '../electron/window-state.js';

const DEFAULTS = { width: 1280, height: 800 };
const PRIMARY = { workArea: { x: 0, y: 0, width: 1920, height: 1080 } };
const SECONDARY = { workArea: { x: 1920, y: 0, width: 1920, height: 1080 } };

function tempStateFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-window-state-'));
  return { dir, filePath: path.join(dir, 'nested', 'window-state.json') };
}

class FakeWindow extends EventEmitter {
  constructor(bounds = { x: 10, y: 20, width: 800, height: 600 }) {
    super();
    this.bounds = { ...bounds };
    this.normalBounds = { ...bounds };
    this.maximized = false;
    this.destroyed = false;
    this.getBounds = vi.fn(() => ({ ...this.bounds }));
    this.getNormalBounds = vi.fn(() => ({ ...this.normalBounds }));
    this.isMaximized = vi.fn(() => this.maximized);
    this.isDestroyed = vi.fn(() => this.destroyed);
  }
}

describe('pickBounds', () => {
  it('returns defaults with no position when saved is undefined', () => {
    expect(pickBounds(undefined, DEFAULTS, [PRIMARY])).toEqual({
      x: undefined,
      y: undefined,
      width: 1280,
      height: 800,
      maximized: false,
    });
  });

  it('inherits position and maximized from restored-state defaults when nothing is saved', () => {
    const inherited = { x: 120, y: 80, width: 900, height: 700, maximized: true };
    expect(pickBounds(undefined, inherited, [PRIMARY])).toEqual(inherited);
    // Saved state wins over inherited defaults, including explicit maximized=false.
    const saved = { x: 10, y: 20, width: 500, height: 400, maximized: false };
    expect(pickBounds(saved, inherited, [PRIMARY])).toEqual(saved);
    // Offscreen inherited position is dropped like a saved one would be.
    const off = { x: 9000, y: 9000, width: 900, height: 700 };
    expect(pickBounds(undefined, off, [PRIMARY]).x).toBeUndefined();
  });

  it('keeps a fully on-screen saved rect', () => {
    const saved = { x: 100, y: 100, width: 800, height: 600 };
    expect(pickBounds(saved, DEFAULTS, [PRIMARY])).toEqual({ ...saved, maximized: false });
  });

  it('drops x/y when the rect is entirely offscreen', () => {
    const saved = { x: 5000, y: 5000, width: 800, height: 600 };
    const result = pickBounds(saved, DEFAULTS, [PRIMARY]);
    expect(result.x).toBeUndefined();
    expect(result.y).toBeUndefined();
    expect(result.width).toBe(800);
    expect(result.height).toBe(600);
  });

  it('drops x/y when overlap is less than 100x100', () => {
    // Only 50px visible horizontally.
    const saved = { x: 1870, y: 100, width: 800, height: 600 };
    const result = pickBounds(saved, DEFAULTS, [PRIMARY]);
    expect(result.x).toBeUndefined();
    expect(result.y).toBeUndefined();
  });

  it('keeps x/y when partially overlapping by at least 100x100', () => {
    const saved = { x: 1820, y: -400, width: 800, height: 600 };
    const result = pickBounds(saved, DEFAULTS, [PRIMARY]);
    expect(result.x).toBe(1820);
    expect(result.y).toBe(-400);
  });

  it('keeps x/y when visible on a secondary display', () => {
    const saved = { x: 2500, y: 200, width: 800, height: 600 };
    expect(pickBounds(saved, DEFAULTS, [PRIMARY, SECONDARY])).toMatchObject({ x: 2500, y: 200 });
    expect(pickBounds(saved, DEFAULTS, [PRIMARY]).x).toBeUndefined();
  });

  it('falls back to defaults for tiny, non-integer, or non-finite sizes', () => {
    expect(pickBounds({ width: 199, height: 600 }, DEFAULTS, [PRIMARY])).toMatchObject({
      width: 1280,
      height: 600,
    });
    expect(pickBounds({ width: 800, height: 50 }, DEFAULTS, [PRIMARY])).toMatchObject({
      width: 800,
      height: 800,
    });
    expect(pickBounds({ width: 800.5, height: NaN }, DEFAULTS, [PRIMARY])).toMatchObject({
      width: 1280,
      height: 800,
    });
    expect(pickBounds({ width: '800', height: Infinity }, DEFAULTS, [PRIMARY])).toMatchObject({
      width: 1280,
      height: 800,
    });
  });

  it('uses default size for visibility check when saved size is invalid', () => {
    // 1280x800 default at (1800,100) overlaps 120px wide → kept.
    const result = pickBounds({ x: 1800, y: 100, width: 10, height: 10 }, DEFAULTS, [PRIMARY]);
    expect(result).toEqual({ x: 1800, y: 100, width: 1280, height: 800, maximized: false });
  });

  it('drops x/y when only one coordinate is present or non-finite', () => {
    expect(pickBounds({ x: 100, width: 800, height: 600 }, DEFAULTS, [PRIMARY]).x).toBeUndefined();
    expect(pickBounds({ x: 100, y: NaN, width: 800, height: 600 }, DEFAULTS, [PRIMARY]).y).toBeUndefined();
    expect(pickBounds({ x: '100', y: 100, width: 800, height: 600 }, DEFAULTS, [PRIMARY]).x).toBeUndefined();
  });

  it('handles maximized flag strictly as boolean true', () => {
    expect(pickBounds({ maximized: true }, DEFAULTS, [PRIMARY]).maximized).toBe(true);
    expect(pickBounds({ maximized: 'yes' }, DEFAULTS, [PRIMARY]).maximized).toBe(false);
    expect(pickBounds({ maximized: 1 }, DEFAULTS, [PRIMARY]).maximized).toBe(false);
    expect(pickBounds({}, DEFAULTS, [PRIMARY]).maximized).toBe(false);
  });

  it('drops x/y when displays list is empty or malformed', () => {
    const saved = { x: 100, y: 100, width: 800, height: 600 };
    expect(pickBounds(saved, DEFAULTS, []).x).toBeUndefined();
    expect(pickBounds(saved, DEFAULTS, undefined).x).toBeUndefined();
    expect(pickBounds(saved, DEFAULTS, [{}]).x).toBeUndefined();
  });
});

describe('readStates / writeStates', () => {
  let tmp;

  beforeEach(() => {
    tmp = tempStateFile();
  });

  afterEach(() => {
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('returns empty object when file is missing', () => {
    expect(readStates(tmp.filePath)).toEqual({});
  });

  it('round-trips states, creating parent directories and pretty JSON', () => {
    const states = {
      main: { x: 1, y: 2, width: 800, height: 600, maximized: false },
      narrator: { width: 400, height: 300, maximized: true },
    };
    writeStates(tmp.filePath, states);
    expect(fs.existsSync(tmp.filePath)).toBe(true);
    const raw = fs.readFileSync(tmp.filePath, 'utf8');
    expect(raw).toBe(JSON.stringify(states, null, 2));
    expect(readStates(tmp.filePath)).toEqual(states);
  });

  it('tolerates corrupt JSON', { timeout: 20000 }, () => {
    fs.mkdirSync(path.dirname(tmp.filePath), { recursive: true });
    fs.writeFileSync(tmp.filePath, '{ not json', 'utf8');
    expect(readStates(tmp.filePath)).toEqual({});
  });

  it('tolerates non-object JSON', () => {
    fs.mkdirSync(path.dirname(tmp.filePath), { recursive: true });
    fs.writeFileSync(tmp.filePath, '[1,2,3]', 'utf8');
    expect(readStates(tmp.filePath)).toEqual({});
    fs.writeFileSync(tmp.filePath, 'null', 'utf8');
    expect(readStates(tmp.filePath)).toEqual({});
  });

  it('writes an empty object for non-object states', () => {
    writeStates(tmp.filePath, null);
    expect(readStates(tmp.filePath)).toEqual({});
  });
});

describe('createWindowStateStore', () => {
  let tmp;

  beforeEach(() => {
    tmp = tempStateFile();
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    fs.rmSync(tmp.dir, { recursive: true, force: true });
  });

  it('throws without filePath', () => {
    expect(() => createWindowStateStore({})).toThrow(TypeError);
  });

  it('get/set/has store raw records and forgetPrefix removes a namespace', () => {
    const store = createWindowStateStore({ filePath: tmp.filePath, getDisplays: () => [PRIMARY] });
    writeStates(tmp.filePath, {
      join: { x: 1, y: 1, width: 900, height: 600 },
      'game:s1': { x: 1, y: 1, width: 1280, height: 800 },
      'game:s10': { x: 1, y: 1, width: 1280, height: 800 },
    });
    expect(store.has('join')).toBe(true);
    expect(store.has('nope')).toBe(false);
    store.set('game:s1:layout', { windows: [], savedAt: 'T' });
    store.set('game:s1:popout:document:Actor.x', { x: 5, y: 5, width: 400, height: 300 });
    expect(store.get('game:s1:layout')).toEqual({ windows: [], savedAt: 'T' });

    expect(store.forgetPrefix('game:s1')).toBe(3);
    const left = Object.keys(readStates(tmp.filePath)).sort();
    expect(left).toEqual(['game:s10', 'join']); // prefix match is exact-or-":" scoped
    store.set('join', undefined);
    expect(store.has('join')).toBe(false);
  });

  it('restore() uses saved state for the key filtered through pickBounds', () => {
    writeStates(tmp.filePath, {
      main: { x: 100, y: 100, width: 800, height: 600, maximized: true },
      offscreen: { x: 9000, y: 9000, width: 800, height: 600 },
    });
    const store = createWindowStateStore({ filePath: tmp.filePath, getDisplays: () => [PRIMARY] });

    expect(store.restore('main', DEFAULTS)).toEqual({
      x: 100,
      y: 100,
      width: 800,
      height: 600,
      maximized: true,
    });
    expect(store.restore('offscreen', DEFAULTS)).toEqual({
      x: undefined,
      y: undefined,
      width: 800,
      height: 600,
      maximized: false,
    });
    expect(store.restore('unknown', DEFAULTS)).toEqual({
      x: undefined,
      y: undefined,
      width: 1280,
      height: 800,
      maximized: false,
    });
  });

  it('track() debounces resize/move saves to a single write', () => {
    const store = createWindowStateStore({ filePath: tmp.filePath, getDisplays: () => [PRIMARY] });
    const win = new FakeWindow();
    const untrack = store.track(win, 'main');

    win.emit('resize');
    vi.advanceTimersByTime(100);
    win.bounds = win.normalBounds = { x: 30, y: 40, width: 900, height: 700 };
    win.emit('move');
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS - 1);
    expect(fs.existsSync(tmp.filePath)).toBe(false);

    vi.advanceTimersByTime(1);
    expect(readStates(tmp.filePath)).toEqual({
      main: { x: 30, y: 40, width: 900, height: 700, maximized: false },
    });
    expect(win.getNormalBounds).toHaveBeenCalledTimes(1);
    expect(win.getBounds).not.toHaveBeenCalled();
    untrack();
  });

  it('track() saves immediately on close and cancels pending debounce', () => {
    const store = createWindowStateStore({ filePath: tmp.filePath, getDisplays: () => [PRIMARY] });
    const win = new FakeWindow({ x: 5, y: 6, width: 640, height: 480 });
    store.track(win, 'main');

    win.emit('resize');
    win.emit('close');
    expect(readStates(tmp.filePath)).toEqual({
      main: { x: 5, y: 6, width: 640, height: 480, maximized: false },
    });
    expect(win.getNormalBounds).toHaveBeenCalledTimes(1);

    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
    expect(win.getNormalBounds).toHaveBeenCalledTimes(1);
  });

  it('track() records maximized=true and preserves prior normal bounds', () => {
    const store = createWindowStateStore({ filePath: tmp.filePath, getDisplays: () => [PRIMARY] });
    const win = new FakeWindow({ x: 10, y: 20, width: 800, height: 600 });
    store.track(win, 'main');

    win.emit('move');
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    win.maximized = true;
    win.emit('maximize');
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);

    expect(readStates(tmp.filePath)).toEqual({
      main: { x: 10, y: 20, width: 800, height: 600, maximized: true },
    });

    win.maximized = false;
    win.emit('unmaximize');
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(readStates(tmp.filePath).main.maximized).toBe(false);
  });

  it('track() falls back to getBounds when getNormalBounds is absent', () => {
    const store = createWindowStateStore({ filePath: tmp.filePath, getDisplays: () => [PRIMARY] });
    const win = new FakeWindow({ x: 1, y: 2, width: 300, height: 400 });
    win.getNormalBounds = undefined;
    store.track(win, 'main');
    win.emit('close');
    expect(win.getBounds).toHaveBeenCalledTimes(1);
    expect(readStates(tmp.filePath).main).toEqual({ x: 1, y: 2, width: 300, height: 400, maximized: false });
  });

  it('track() does not save when the window is destroyed', () => {
    const store = createWindowStateStore({ filePath: tmp.filePath, getDisplays: () => [PRIMARY] });
    const win = new FakeWindow();
    store.track(win, 'main');
    win.emit('resize');
    win.destroyed = true;
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS);
    expect(fs.existsSync(tmp.filePath)).toBe(false);
    win.emit('close');
    expect(fs.existsSync(tmp.filePath)).toBe(false);
  });

  it('untrack() removes listeners and clears the pending timer', () => {
    const store = createWindowStateStore({ filePath: tmp.filePath, getDisplays: () => [PRIMARY] });
    const win = new FakeWindow();
    const untrack = store.track(win, 'main');
    expect(win.listenerCount('resize')).toBe(1);
    expect(win.listenerCount('close')).toBe(1);

    win.emit('resize');
    untrack();
    vi.advanceTimersByTime(SAVE_DEBOUNCE_MS * 2);
    expect(fs.existsSync(tmp.filePath)).toBe(false);

    for (const event of ['resize', 'move', 'maximize', 'unmaximize', 'close']) {
      expect(win.listenerCount(event)).toBe(0);
    }
    win.emit('close');
    expect(fs.existsSync(tmp.filePath)).toBe(false);
  });

  it('track() preserves other keys in the same file', () => {
    writeStates(tmp.filePath, { other: { width: 500, height: 500, maximized: false } });
    const store = createWindowStateStore({ filePath: tmp.filePath, getDisplays: () => [PRIMARY] });
    const win = new FakeWindow();
    store.track(win, 'main');
    win.emit('close');
    const states = readStates(tmp.filePath);
    expect(Object.keys(states).sort()).toEqual(['main', 'other']);
    expect(states.other).toEqual({ width: 500, height: 500, maximized: false });
  });

  it('module loads without Electron; default getDisplays is only required lazily', () => {
    const store = createWindowStateStore({ filePath: tmp.filePath });
    expect(typeof store.restore).toBe('function');
    expect(typeof store.track).toBe('function');
  });
});
