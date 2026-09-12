import { describe, expect, it } from 'vitest';
import { browserLikeUserAgent } from '../electron/user-agent.js';

const ELECTRON_UA =
  'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) chris-custom-flc-multios/0.2.0 Chrome/144.0.0.0 Electron/43.0.0 Safari/537.36';

describe('browserLikeUserAgent', () => {
  it('removes the Electron and app-name product tokens', () => {
    const ua = browserLikeUserAgent(ELECTRON_UA, 'chris-custom-flc-multios');
    expect(ua).toBe(
      'Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/144.0.0.0 Safari/537.36',
    );
    // PopOut!'s exact check
    expect(ua.toLowerCase().indexOf(' electron/')).toBe(-1);
  });

  it('works without an app name', () => {
    const ua = browserLikeUserAgent(ELECTRON_UA);
    expect(ua).not.toMatch(/Electron\//);
    expect(ua).toContain('chris-custom-flc-multios/0.2.0');
  });

  it('escapes regex characters in the app name', () => {
    const ua = browserLikeUserAgent('Mozilla/5.0 my.app+x/1.0 Electron/1.0 Safari/1', 'my.app+x');
    expect(ua).toBe('Mozilla/5.0 Safari/1');
  });

  it('tolerates empty input', () => {
    expect(browserLikeUserAgent('', 'x')).toBe('');
    expect(browserLikeUserAgent(undefined)).toBe('');
  });
});
