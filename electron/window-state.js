const fs = require('fs');
const path = require('path');

const MIN_DIMENSION = 200;
const MIN_VISIBLE_PX = 100;
const SAVE_DEBOUNCE_MS = 250;
const TRACKED_EVENTS = ['resize', 'move', 'maximize', 'unmaximize'];

/**
 * Lazily loaded so requiring this module in tests (no Electron, no electron-log) does not crash.
 * Only control-plane info (key names, error names) is ever logged.
 * @returns {{ logInfo: Function, logWarn: Function }}
 */
function getLogger() {
  try {
    // eslint-disable-next-line global-require
    const { logInfo, logWarn } = require('./logger');
    return { logInfo, logWarn };
  } catch {
    return { logInfo: () => {}, logWarn: () => {} };
  }
}

/**
 * @typedef {{ x?: number, y?: number, width: number, height: number, maximized: boolean }} WindowState
 * @typedef {{ workArea: { x: number, y: number, width: number, height: number } }} DisplayLike
 */

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isFiniteNumber(value) {
  return typeof value === 'number' && Number.isFinite(value);
}

/**
 * @param {unknown} value
 * @returns {boolean}
 */
function isValidDimension(value) {
  return isFiniteNumber(value) && Number.isInteger(value) && value >= MIN_DIMENSION;
}

/**
 * Overlap area (px) between a rect and a display work area.
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {{ x: number, y: number, width: number, height: number }} area
 * @returns {{ w: number, h: number }}
 */
function overlapSize(rect, area) {
  const left = Math.max(rect.x, area.x);
  const top = Math.max(rect.y, area.y);
  const right = Math.min(rect.x + rect.width, area.x + area.width);
  const bottom = Math.min(rect.y + rect.height, area.y + area.height);
  return { w: right - left, h: bottom - top };
}

/**
 * @param {{ x: number, y: number, width: number, height: number }} rect
 * @param {DisplayLike[]} displays
 * @returns {boolean}
 */
function isVisibleOnAnyDisplay(rect, displays) {
  if (!Array.isArray(displays)) return false;
  return displays.some((display) => {
    const area = display && display.workArea;
    if (!area) return false;
    const { w, h } = overlapSize(rect, area);
    return w >= MIN_VISIBLE_PX && h >= MIN_VISIBLE_PX;
  });
}

/**
 * Pure: choose safe window bounds from a (possibly partial/missing) saved state.
 * @param {Partial<WindowState>|undefined|null} saved
 * @param {{ width: number, height: number }} defaults
 * @param {DisplayLike[]} displays
 * @returns {WindowState}
 */
function pickBounds(saved, defaults, displays) {
  const s = saved && typeof saved === 'object' ? saved : {};
  const width = isValidDimension(s.width) ? s.width : defaults.width;
  const height = isValidDimension(s.height) ? s.height : defaults.height;

  let x;
  let y;
  if (isFiniteNumber(s.x) && isFiniteNumber(s.y)) {
    const rect = { x: s.x, y: s.y, width, height };
    if (isVisibleOnAnyDisplay(rect, displays)) {
      x = s.x;
      y = s.y;
    }
  }

  return { x, y, width, height, maximized: s.maximized === true };
}

/**
 * @param {string} filePath
 * @returns {Record<string, Partial<WindowState>>}
 */
function readStates(filePath) {
  try {
    if (!fs.existsSync(filePath)) {
      return {};
    }
    const raw = fs.readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch (err) {
    getLogger().logWarn('window-state: read failed, using empty state', {
      error: err && err.name ? err.name : 'Error',
    });
    return {};
  }
}

/**
 * @param {string} filePath
 * @param {Record<string, Partial<WindowState>>} states
 */
function writeStates(filePath, states) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }
  const toWrite = states && typeof states === 'object' ? states : {};
  fs.writeFileSync(filePath, JSON.stringify(toWrite, null, 2), 'utf8');
}

/**
 * Default display provider; requires Electron lazily so tests can load this module.
 * @returns {DisplayLike[]}
 */
function defaultGetDisplays() {
  // eslint-disable-next-line global-require
  const { screen } = require('electron');
  return screen.getAllDisplays();
}

/**
 * @param {{ filePath: string, getDisplays?: () => DisplayLike[] }} options
 * @returns {{ restore: (key: string, defaults: { width: number, height: number }) => WindowState,
 *             track: (win: object, key: string) => () => void }}
 */
function createWindowStateStore({ filePath, getDisplays } = {}) {
  if (typeof filePath !== 'string' || !filePath) {
    throw new TypeError('createWindowStateStore requires a filePath');
  }
  const displaysProvider = typeof getDisplays === 'function' ? getDisplays : defaultGetDisplays;

  /**
   * @param {string} key
   * @param {{ width: number, height: number }} defaults
   * @returns {WindowState}
   */
  function restore(key, defaults) {
    return pickBounds(readStates(filePath)[key], defaults, displaysProvider());
  }

  /**
   * @param {object} win BrowserWindow-like
   * @param {string} key
   */
  function saveNow(win, key) {
    try {
      if (typeof win.isDestroyed === 'function' && win.isDestroyed()) return;
      const maximized = typeof win.isMaximized === 'function' ? Boolean(win.isMaximized()) : false;
      const states = readStates(filePath);
      const previous = states[key] && typeof states[key] === 'object' ? states[key] : {};
      let next;
      if (maximized) {
        // Keep the last known normal bounds so unmaximize restores sensibly.
        next = { ...previous, maximized: true };
      } else {
        const bounds = typeof win.getNormalBounds === 'function' ? win.getNormalBounds() : win.getBounds();
        next = {
          x: bounds.x,
          y: bounds.y,
          width: bounds.width,
          height: bounds.height,
          maximized: false,
        };
      }
      states[key] = next;
      writeStates(filePath, states);
    } catch (err) {
      getLogger().logWarn('window-state: save failed', {
        key,
        error: err && err.name ? err.name : 'Error',
      });
    }
  }

  /**
   * @param {object} win BrowserWindow-like (EventEmitter API)
   * @param {string} key
   * @returns {() => void} untrack
   */
  function track(win, key) {
    let timer = null;

    const clearTimer = () => {
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
    };

    const onDebounced = () => {
      clearTimer();
      timer = setTimeout(() => {
        timer = null;
        saveNow(win, key);
      }, SAVE_DEBOUNCE_MS);
    };

    const onClose = () => {
      clearTimer();
      saveNow(win, key);
    };

    for (const event of TRACKED_EVENTS) {
      win.on(event, onDebounced);
    }
    win.on('close', onClose);

    getLogger().logInfo('window-state: tracking window', { key });

    return function untrack() {
      clearTimer();
      for (const event of TRACKED_EVENTS) {
        win.removeListener(event, onDebounced);
      }
      win.removeListener('close', onClose);
    };
  }

  return { restore, track };
}

module.exports = {
  pickBounds,
  readStates,
  writeStates,
  createWindowStateStore,
  MIN_DIMENSION,
  MIN_VISIBLE_PX,
  SAVE_DEBOUNCE_MS,
};
