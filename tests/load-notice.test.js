import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

function read(name) {
  return readFileSync(new URL(`../src/${name}`, import.meta.url), 'utf8');
}

describe('connecting notice', () => {
  it('says the connection is still in progress and keeps the admin note secondary', () => {
    const html = read('load-notice.html');
    const css = read('load-notice.css');
    expect(html).toContain('<h1>Still connecting…</h1>');
    expect(html).not.toContain('<h1>Connecting…</h1>');
    expect(html).toContain("We're still connecting to the server and loading the game. This normally takes 15–20 seconds here.");
    expect(html).toContain("This delay could be shortened: the server's configuration could be optimized to improve client performance. If you want, copy the message below for the server admin to review.");
    expect(html).not.toContain('about a thousand unchanged files');
    expect(html).toContain('id="preview"');
    expect(html).toContain('>Copy message for the server admin</button>');
    expect(html).toContain('>Don\'t show again for this server</a>');
    expect(html).toContain('class="actions"');
    expect(html).toContain('class="busy"');
    expect(css).toContain('justify-content: space-between');
    expect(css).toContain('prefers-reduced-motion');
    expect(css).toContain('flc-connect-bar');
  });
});
