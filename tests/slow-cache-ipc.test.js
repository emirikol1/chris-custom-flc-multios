import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { IPC } from '../electron/slow-cache-ipc.js';

const root = path.join(__dirname, '..');

function read(rel) {
  return fs.readFileSync(path.join(root, rel), 'utf8');
}

describe('slow-cache IPC names', () => {
  it('uses the slowcache channels from one module', () => {
    expect(IPC).toEqual({
      message: 'slowcache:message',
      copy: 'slowcache:copy',
      list: 'slowcache:list',
      dismiss: 'slowcache:dismiss',
      updated: 'slowcache:updated',
    });
    const preload = read('electron/preload.js');
    const notice = read('electron/preload-load-notice.js');
    const runtime = read('electron/slow-cache-runtime.js');
    expect(preload).toContain('IPC.list');
    expect(preload).toContain('IPC.copy');
    expect(preload).toContain('IPC.updated');
    expect(notice).toContain('slowcache:message');
    expect(notice).toContain('slowcache:copy');
    expect(notice).toContain('slowcache:dismiss');
    expect(runtime).toContain('IPC.message');
    expect(runtime).toContain('IPC.copy');
    expect(runtime).toContain('IPC.list');
    expect(runtime).toContain('IPC.dismiss');
  });
});
