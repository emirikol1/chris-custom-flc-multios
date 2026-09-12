import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import {
  appendMessage,
  ensureNarratorLayout,
  loadSession,
  loadSettings,
  readPrompt,
  saveSettings,
} from '../electron/narrator-store.js';

function tempRoot() {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narrator-'));
}

describe('narrator-store', () => {
  it('seeds prompts and defaults postToFoundry to false', () => {
    const root = tempRoot();
    try {
      ensureNarratorLayout(root);
      const mud = readPrompt(root, 'commentary');
      const talk = readPrompt(root, 'discussion');
      expect(mud).toContain('MASSACRE');
      expect(mud).toMatch(/stenographer|transcrib/i);
      expect(mud).toContain('SILENCE');
      expect(mud).not.toMatch(/unless the chat itself is quiet/i);
      expect(talk).toMatch(/Q&A/);
      expect(loadSettings(root).postToFoundry).toBe(false);
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('caps sessions at 80 messages', () => {
    const root = tempRoot();
    try {
      ensureNarratorLayout(root);
      for (let i = 0; i < 85; i += 1) {
        appendMessage(root, 'commentary', {
          role: 'user',
          content: `line ${i}`,
          at: `2026-01-01T00:00:${String(i).padStart(2, '0')}.000Z`,
        });
      }
      expect(loadSession(root, 'commentary').messages).toHaveLength(80);
      expect(loadSession(root, 'commentary').messages[0].content).toBe('line 5');
      expect(loadSession(root, 'commentary').messages[79].content).toBe('line 84');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('does not mix commentary and discussion', () => {
    const root = tempRoot();
    try {
      ensureNarratorLayout(root);
      appendMessage(root, 'commentary', {
        role: 'assistant',
        content: '{Rhit{x',
        at: '2026-01-01T00:00:00.000Z',
      });
      appendMessage(root, 'discussion', {
        role: 'user',
        content: 'what happened?',
        at: '2026-01-01T00:00:01.000Z',
      });
      expect(loadSession(root, 'commentary').messages).toHaveLength(1);
      expect(loadSession(root, 'discussion').messages).toHaveLength(1);
      expect(loadSession(root, 'discussion').messages[0].content).toBe(
        'what happened?',
      );
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });

  it('persists speak-as without a user id', () => {
    const root = tempRoot();
    try {
      ensureNarratorLayout(root);
      expect(loadSettings(root).speakAs).toBe('ooc');
      saveSettings(root, { speakAs: 'alias', alias: 'The MUD' });
      const settings = loadSettings(root);
      expect(settings.speakAs).toBe('alias');
      expect(settings.alias).toBe('The MUD');
      expect(settings).not.toHaveProperty('userId');
    } finally {
      fs.rmSync(root, { recursive: true, force: true });
    }
  });
});
