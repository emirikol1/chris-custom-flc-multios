import { describe, expect, it, vi } from 'vitest';
import { bringAllToFront } from '../electron/bring-to-front.js';

function fakeWin(overrides = {}) {
  const win = {
    isDestroyed: () => false,
    isMinimized: () => false,
    restore: vi.fn(),
    show: vi.fn(),
    moveTop: vi.fn(),
    focus: vi.fn(),
    setAlwaysOnTop: vi.fn(),
  };
  return Object.assign(win, overrides);
}

function firstCall(fn) {
  return fn.mock.invocationCallOrder[0];
}

describe('bringAllToFront', () => {
  it('restores minimized windows, shows and raises every live window, and focuses the caller last', () => {
    const minimized = fakeWin({ isMinimized: () => true });
    const other = fakeWin();
    const focusWin = fakeWin();

    bringAllToFront([minimized, other, focusWin], focusWin);

    expect(minimized.restore).toHaveBeenCalledTimes(1);
    expect(other.restore).not.toHaveBeenCalled();
    expect(focusWin.restore).not.toHaveBeenCalled();
    for (const win of [minimized, other, focusWin]) {
      expect(win.show).toHaveBeenCalledTimes(1);
      expect(win.moveTop).toHaveBeenCalledTimes(1);
      expect(firstCall(win.restore) || firstCall(win.show)).toBeLessThan(firstCall(win.moveTop));
    }
    expect(firstCall(minimized.restore)).toBeLessThan(firstCall(minimized.show));
    expect(firstCall(focusWin.focus)).toBeGreaterThan(firstCall(minimized.moveTop));
    expect(firstCall(focusWin.focus)).toBeGreaterThan(firstCall(other.moveTop));
    expect(firstCall(focusWin.focus)).toBeGreaterThan(firstCall(focusWin.moveTop));
    expect(focusWin.focus).toHaveBeenCalledTimes(1);
    expect(minimized.focus).not.toHaveBeenCalled();
    expect(other.focus).not.toHaveBeenCalled();
  });

  it('skips destroyed windows and still nudges the rest above other windows', () => {
    const dead = fakeWin({ isDestroyed: () => true });
    const live = fakeWin();
    const focusWin = fakeWin();

    bringAllToFront([dead, live, focusWin], focusWin);

    expect(dead.restore).not.toHaveBeenCalled();
    expect(dead.show).not.toHaveBeenCalled();
    expect(dead.moveTop).not.toHaveBeenCalled();
    expect(dead.focus).not.toHaveBeenCalled();
    expect(dead.setAlwaysOnTop).not.toHaveBeenCalled();
    expect(live.show).toHaveBeenCalledTimes(1);
    expect(live.moveTop).toHaveBeenCalledTimes(1);
    expect(live.setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
    expect(focusWin.setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
    expect(firstCall(focusWin.focus)).toBeLessThan(firstCall(focusWin.setAlwaysOnTop));
    const liveFalse = focusWin.setAlwaysOnTop.mock.invocationCallOrder[1];
    const otherFalse = live.setAlwaysOnTop.mock.invocationCallOrder[1];
    expect(liveFalse).toBeGreaterThan(otherFalse);
  });

  it('keeps going when one window throws', () => {
    const broken = fakeWin({
      show: vi.fn(() => {
        throw new Error('show failed');
      }),
    });
    const next = fakeWin({
      moveTop: vi.fn(() => {
        throw new Error('moveTop failed');
      }),
    });
    const focusWin = fakeWin({
      setAlwaysOnTop: vi.fn(() => {
        throw new Error('always on top failed');
      }),
    });

    expect(() => bringAllToFront([broken, next, focusWin], focusWin)).not.toThrow();
    expect(broken.moveTop).not.toHaveBeenCalled();
    expect(next.show).toHaveBeenCalledTimes(1);
    expect(focusWin.show).toHaveBeenCalledTimes(1);
    expect(focusWin.moveTop).toHaveBeenCalledTimes(1);
    expect(focusWin.focus).toHaveBeenCalledTimes(1);
    expect(next.setAlwaysOnTop.mock.calls).toEqual([[true], [false]]);
  });

  it('does not focus a destroyed caller and ignores a missing list', () => {
    const live = fakeWin();
    const gone = fakeWin({ isDestroyed: () => true });

    expect(() => bringAllToFront(null, null)).not.toThrow();
    bringAllToFront([live], gone);
    expect(live.show).toHaveBeenCalledTimes(1);
    expect(gone.focus).not.toHaveBeenCalled();
    expect(gone.setAlwaysOnTop).not.toHaveBeenCalled();
  });
});
