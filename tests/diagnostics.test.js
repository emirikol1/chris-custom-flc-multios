import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  buildDiagnosticsText,
  copyDiagnosticsText,
  diagnosticsFileName,
  saveDiagnosticsText,
  tailLines,
} from '../electron/diagnostics.js';

const dirs = [];

afterEach(() => {
  while (dirs.length) fs.rmSync(dirs.pop(), { recursive: true, force: true });
});

describe('diagnostics helpers', () => {
  it('tails lines and names the save file from the local date', () => {
    expect(tailLines('a\nb\nc\n', 2)).toBe('b\nc');
    expect(tailLines('a\r\nb\r\n', 5)).toBe('a\nb');
    expect(tailLines('', 3)).toBe('');
    expect(tailLines('only', 0)).toBe('');
    const named = diagnosticsFileName(new Date(2026, 9, 6, 23, 30));
    expect(named).toBe('flc-diagnostics-2026-10-06.txt');
  });

  it('builds the report plus a log section', () => {
    expect(buildDiagnosticsText({ report: 'report', logTail: 'line' })).toBe(
      'report\n\n--- main.log (last 200 lines) ---\nline',
    );
    expect(buildDiagnosticsText({ report: 'report', logTail: 'line', crashReports: '{"v":1}' })).toBe(
      'report\n\n--- main.log (last 200 lines) ---\nline\n\n--- crash reports ---\n{"v":1}',
    );
  });

  it('copies text and saves without returning a path', async () => {
    let copied = '';
    const copy = copyDiagnosticsText({
      clipboard: { writeText: (text) => { copied = text; } },
    }, 'hello');
    expect(copy).toEqual({ ok: true, bytes: Buffer.byteLength('hello') });
    expect(copied).toBe('hello');
    expect(copyDiagnosticsText({}, 'x')).toEqual({ ok: false, bytes: 0 });

    const canceled = await saveDiagnosticsText({
      dialog: { showSaveDialog: async () => ({ canceled: true }) },
      fs,
    }, 'body', { defaultPath: 'flc-diagnostics-2026-10-06.txt' });
    expect(canceled).toEqual({ ok: false, canceled: true });
    expect(canceled.filePath).toBeUndefined();

    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-diagnostics-'));
    dirs.push(dir);
    let asked = null;
    const saved = await saveDiagnosticsText({
      dialog: {
        showSaveDialog: async (opts) => {
          asked = opts;
          return { canceled: false, filePath: path.join(dir, 'out.txt') };
        },
      },
      fs,
    }, 'body', { defaultPath: path.join(dir, 'flc-diagnostics-2026-10-06.txt') });
    expect(saved).toEqual({ ok: true });
    expect(saved.filePath).toBeUndefined();
    expect(asked.defaultPath).toContain('flc-diagnostics-2026-10-06.txt');
    expect(fs.readFileSync(path.join(dir, 'out.txt'), 'utf8')).toBe('body');

    const failed = await saveDiagnosticsText({
      dialog: { showSaveDialog: async () => ({ canceled: false, filePath: path.join(dir, 'nope.txt') }) },
      fs: {
        promises: {
          writeFile: async () => {
            const err = new Error('nope');
            err.name = 'EACCES';
            throw err;
          },
        },
      },
    }, 'body');
    expect(failed).toEqual({ ok: false, error: 'EACCES' });
  });
});
