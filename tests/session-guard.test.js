import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { causeToken, createSessionGuard } from '../electron/session-guard.js';

const dirs = [];

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-session-'));
  dirs.push(dir);
  return path.join(dir, 'session-state.json');
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('createSessionGuard', () => {
  it('keeps a safe cause and drops a path or address', () => {
    expect(causeToken('renderer-crashed', 'crashed')).toBe('renderer-crashed.crashed');
    expect(causeToken('uncaught-exception', 'TypeError')).toBe('uncaught-exception.TypeError');
    expect(causeToken('renderer-crashed', '/home/cproctor/secret')).toBe('renderer-crashed');
    expect(causeToken('uncaught-exception', 'https://secret.example')).toBe('uncaught-exception');
    expect(causeToken('not-a-kind', 'crashed')).toBeNull();
  });

  it('records an unclean exit and a crash report flag for the next start', () => {
    const filePath = tempFile();
    const first = createSessionGuard({ filePath, client: '0.6.0' });
    expect(first.previous).toBeNull();
    first.note('renderer-crashed', 'oom');
    first.note('uncaught-exception', 'TypeError');
    first.markReported();
    const second = createSessionGuard({ filePath, client: '0.6.0' });
    expect(second.previous).toMatchObject({
      clean: false,
      client: '0.6.0',
      causes: ['renderer-crashed.oom', 'uncaught-exception.TypeError'],
      reported: true,
    });
    second.markClean();
    const third = createSessionGuard({ filePath, client: '0.6.0' });
    expect(third.previous).toBeNull();
  });

  it('treats a damaged file as an unclean exit', () => {
    const filePath = tempFile();
    fs.writeFileSync(filePath, '{', 'utf8');
    const guard = createSessionGuard({ filePath, client: '0.6.0' });
    expect(guard.previous).toMatchObject({ clean: false, causes: ['unclean-exit'] });
  });
});
