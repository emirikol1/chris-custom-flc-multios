import { describe, expect, it } from 'vitest';
import {
  CONTEXT_MAX_CHARS,
  buildLmMessages,
  splitKeepLatest,
} from '../electron/narrator-context.js';

describe('splitKeepLatest', () => {
  it('keeps the newest messages and leaves older for compression', () => {
    const messages = [
      { role: 'user', content: 'old-a' },
      { role: 'assistant', content: 'old-b' },
      { role: 'user', content: 'new-a' },
      { role: 'assistant', content: 'new-b' },
    ];
    const { older, latest } = splitKeepLatest(messages, 12);
    expect(latest.map((m) => m.content).join(',')).toContain('new');
    expect(older.some((m) => m.content.startsWith('old'))).toBe(true);
    expect(latest[latest.length - 1].content).toBe('new-b');
  });
});

describe('buildLmMessages', () => {
  it('always starts with the system prompt and keeps all history when small', async () => {
    const built = await buildLmMessages({
      system: 'SYSTEM PROMPT',
      history: [
        { role: 'user', content: 'hi' },
        { role: 'assistant', content: 'yo' },
      ],
      userContent: 'next',
      compress: async () => {
        throw new Error('should not compress');
      },
    });
    expect(built.messages[0]).toEqual({ role: 'system', content: 'SYSTEM PROMPT' });
    expect(built.messages[built.messages.length - 1]).toEqual({
      role: 'user',
      content: 'next',
    });
    expect(built.compressed).toBe(false);
    expect(built.messages.map((m) => m.content)).toContain('yo');
  });

  it('compresses older history with the AI and keeps system plus latest', async () => {
    const olderChunks = [];
    const history = [];
    for (let i = 0; i < 40; i += 1) {
      history.push({ role: 'user', content: `old-turn-${i}-${'x'.repeat(400)}` });
      history.push({ role: 'assistant', content: `old-reply-${i}-${'y'.repeat(400)}` });
    }
    history.push({ role: 'user', content: 'LATEST-USER' });
    history.push({ role: 'assistant', content: 'LATEST-ASSISTANT' });

    const built = await buildLmMessages({
      system: 'SYSTEM PROMPT',
      history,
      userContent: 'What just happened?',
      maxChars: 6000,
      keepLatestChars: 800,
      compress: async (older) => {
        olderChunks.push(older);
        return 'SUMMARY: Grog hit the orc.';
      },
    });

    expect(built.compressed).toBe(true);
    expect(olderChunks).toHaveLength(1);
    expect(olderChunks[0].some((m) => String(m.content).startsWith('old-turn'))).toBe(
      true,
    );
    expect(olderChunks[0].some((m) => m.content === 'LATEST-ASSISTANT')).toBe(false);
    expect(built.messages[0].role).toBe('system');
    expect(built.messages[0].content).toBe('SYSTEM PROMPT');
    expect(built.messages.map((m) => m.content).join('\n')).toContain(
      'SUMMARY: Grog hit the orc.',
    );
    expect(built.messages.map((m) => m.content)).toContain('LATEST-ASSISTANT');
    expect(built.messages[built.messages.length - 1].content).toBe(
      'What just happened?',
    );
    const joined = built.messages.map((m) => m.content).join('');
    expect(joined.length).toBeLessThan(CONTEXT_MAX_CHARS);
  });
});
