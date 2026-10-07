import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { createIssueAckStore } from '../electron/issue-acks.js';

const dirs = [];

function tempFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-acks-'));
  dirs.push(dir);
  return path.join(dir, 'issue-acks.json');
}

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('createIssueAckStore', () => {
  it('keeps an acknowledgement across a new store and releases it', () => {
    const filePath = tempFile();
    const first = createIssueAckStore({ filePath });
    expect(first.ack('srv-1', 'local-disk-slow')).toBe(true);
    expect(first.ack('srv-1', 'not an id')).toBe(false);
    expect(first.ack('../etc', 'local-disk-slow')).toBe(false);
    const second = createIssueAckStore({ filePath });
    expect(second.list('srv-1')).toEqual(['local-disk-slow']);
    expect(second.release('srv-1', 'local-disk-slow')).toBe(true);
    expect(second.list('srv-1')).toEqual([]);
    expect(createIssueAckStore({ filePath }).list('srv-1')).toEqual([]);
  });
});
