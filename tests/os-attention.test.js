import { describe, expect, it } from 'vitest';
import { requestUserAttention } from '../electron/os-attention.js';

function fakeWindow(overrides = {}) {
  const calls = [];
  const win = {
    calls,
    isDestroyed: () => false,
    isFocused: () => false,
    flashFrame: (flag) => calls.push(flag),
    ...overrides,
  };
  return win;
}

describe('requestUserAttention', () => {
  it('flashes the window when it is not focused', () => {
    const win = fakeWindow();
    expect(requestUserAttention(win)).toBe(true);
    expect(win.calls).toEqual([true]);
  });

  it('does nothing when the window is already focused, destroyed, or missing', () => {
    const focused = fakeWindow({ isFocused: () => true });
    expect(requestUserAttention(focused)).toBe(false);
    expect(focused.calls).toEqual([]);

    const gone = fakeWindow({ isDestroyed: () => true });
    expect(requestUserAttention(gone)).toBe(false);
    expect(gone.calls).toEqual([]);

    expect(requestUserAttention(null)).toBe(false);
    expect(requestUserAttention({})).toBe(false);
  });
});
