import { describe, expect, it, vi } from 'vitest';
import { driftedOntoOtherWindow, UNBURY_DELAY_MS, UNBURY_RELEASE_MS, scheduleUnbury, unburyWindow } from '../electron/unbury-window.js';

describe('unburyWindow', () => {
  it('raises a buried window and does not leave it always on top', () => {
    vi.useFakeTimers();
    const calls = [];
    const win = {
      isDestroyed: () => false,
      isMinimized: () => true,
      restore: () => calls.push('restore'),
      setAlwaysOnTop: (on) => calls.push(`above:${on}`),
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
      moveTop: () => calls.push('moveTop'),
    };
    expect(unburyWindow(win)).toBe(true);
    expect(calls).toEqual(['restore', 'above:true', 'show', 'focus', 'moveTop']);
    vi.advanceTimersByTime(UNBURY_RELEASE_MS);
    expect(calls.at(-1)).toBe('above:false');
    vi.useRealTimers();
  });

  it('does nothing for a destroyed window', () => {
    const win = { isDestroyed: () => true, show: () => { throw new Error('nope'); } };
    expect(unburyWindow(win)).toBe(false);
  });
});

describe('scheduleUnbury', () => {
  it('raises the window once after the delay and skips a window closed before then', () => {
    vi.useFakeTimers();
    const calls = [];
    const win = {
      isDestroyed: () => false,
      isMinimized: () => false,
      setAlwaysOnTop: () => calls.push('above'),
      show: () => calls.push('show'),
      focus: () => calls.push('focus'),
      moveTop: () => calls.push('moveTop'),
    };
    const cancel = scheduleUnbury(win);
    expect(UNBURY_DELAY_MS).toBeGreaterThanOrEqual(1000);
    expect(UNBURY_DELAY_MS).toBeLessThanOrEqual(2000);
    vi.advanceTimersByTime(UNBURY_DELAY_MS - 1);
    expect(calls).toEqual([]);
    vi.advanceTimersByTime(1);
    expect(calls).toContain('show');
    expect(calls).toContain('focus');
    vi.advanceTimersByTime(UNBURY_RELEASE_MS);
    expect(calls.at(-1)).toBe('above');

    calls.length = 0;
    const closing = { ...win, isDestroyed: () => true, show: () => calls.push('show') };
    scheduleUnbury(closing);
    vi.advanceTimersByTime(UNBURY_DELAY_MS);
    expect(calls).toEqual([]);

    cancel();
    vi.useRealTimers();
  });

  it('puts the window back when the raise moves it', () => {
    vi.useFakeTimers();
    const bounds = { x: 10, y: 20, width: 800, height: 600 };
    const win = {
      isDestroyed: () => false,
      isMinimized: () => false,
      getBounds: () => ({ ...bounds }),
      setBounds: (next) => {
        bounds.x = next.x;
        bounds.y = next.y;
        bounds.width = next.width;
        bounds.height = next.height;
      },
      setAlwaysOnTop: () => {},
      show: () => {},
      focus: () => {
        bounds.x = 1050;
        bounds.y = 186;
      },
      moveTop: () => {},
    };
    expect(unburyWindow(win)).toBe(true);
    expect(bounds).toMatchObject({ x: 10, y: 20 });
    bounds.x = 1050;
    bounds.y = 186;
    vi.advanceTimersByTime(UNBURY_RELEASE_MS);
    expect(bounds).toMatchObject({ x: 10, y: 20 });
    vi.useRealTimers();
  });

  it('notices when a window is sitting on another window\'s saved spot', () => {
    expect(driftedOntoOtherWindow(
      { x: 1050, y: 186 },
      { x: 334, y: 770 },
      [{ x: 1050, y: 190 }],
    )).toBe(true);
    expect(driftedOntoOtherWindow(
      { x: 334, y: 770 },
      { x: 334, y: 770 },
      [{ x: 1050, y: 186 }],
    )).toBe(false);
  });
});
