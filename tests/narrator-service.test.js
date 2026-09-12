import fs from 'fs';
import os from 'os';
import path from 'path';
import { describe, expect, it } from 'vitest';
import { createNarratorService } from '../electron/narrator-service.js';
import { applyCombatEvent, loadScoreboard, saveScoreboard } from '../electron/combat-stats.js';
import { ensureNarratorLayout, loadSession } from '../electron/narrator-store.js';

describe('createNarratorService', () => {
  it('keeps commentary and discussion contexts separate', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-svc-'));
    ensureNarratorLayout(root);
    const posted = [];
    /** @type {string[]} */
    const systems = [];
    const client = {
      chat: async ({ messages }) => {
        const sys = messages.find((m) => m.role === 'system');
        systems.push(sys ? sys.content : '');
        return { content: '{WGrog{x hits the orc.', model: 'loaded' };
      },
    };
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test-secret-value',
        model: 'test-model',
      }),
      clientFactory: () => client,
      postToFoundry: async (text) => {
        posted.push(text);
      },
      now: () => '2026-01-01T00:00:00.000Z',
    });

    const mud = await service.handleFoundryLine({
      speaker: 'Grog',
      text: 'I hit the orc',
      kind: 'ic',
    });
    expect(mud.ok).toBe(true);
    expect(mud.channel).toBe('commentary');
    expect(posted).toHaveLength(0);

    const q = await service.handleUserQuestion('What just happened?');
    expect(q.ok).toBe(true);
    expect(q.channel).toBe('discussion');
    expect(systems[0]).toContain('MASSACRE');
    expect(systems[1]).toMatch(/Q&A/);
    expect(loadSession(root, 'commentary').messages.some((m) => m.content.includes('What just happened'))).toBe(
      false,
    );
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not post to Foundry unless the toggle is on', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-post-'));
    ensureNarratorLayout(root);
    const posted = [];
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test-secret-value',
        model: 'test-model',
      }),
      clientFactory: () => ({
        chat: async () => ({ content: '{RMASSACRE{x', model: 'loaded' }),
      }),
      postToFoundry: async (text) => {
        posted.push(text);
      },
      now: () => '2026-01-01T00:00:00.000Z',
    });

    await service.handleFoundryLine({ speaker: 'Grog', text: 'crit', kind: 'roll' });
    expect(posted).toHaveLength(0);

    await service.setPostToFoundry(true);
    await service.handleFoundryLine({ speaker: 'Grog', text: 'crit again', kind: 'roll' });
    expect(posted).toHaveLength(1);
    expect(posted[0].content.startsWith('[MUD] ')).toBe(true);
    expect(posted[0].speakAs).toBe('ooc');
    expect(posted[0].user).toBeUndefined();
    expect(posted[0].userId).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('skips narrator echoes', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-echo-'));
    ensureNarratorLayout(root);
    let chats = 0;
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test-secret-value',
        model: 'test-model',
      }),
      clientFactory: () => ({
        chat: async () => {
          chats += 1;
          return { content: 'x', model: 'loaded' };
        },
      }),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const result = await service.handleFoundryLine({
      speaker: 'Chris',
      text: '[MUD] You MASSACRE the orc!',
      kind: 'ic',
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe('echo');
    expect(chats).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('still returns a captured MUD line when the AI server fails', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-fail-'));
    ensureNarratorLayout(root);
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: false,
        code: 'missing-env',
        message: 'AI provider not configured',
      }),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const result = await service.handleFoundryLine({
      speaker: 'Grog',
      text: 'Longsword 18 vs AC 14 hits',
      kind: 'roll',
    });
    expect(result.ok).toBe(false);
    expect(result.captured).toBe(true);
    expect(result.mudText).toContain('Grog');
    expect(result.mudText).toContain('Longsword 18 vs AC 14 hits');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not call LM for historical Foundry lines', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-hist-'));
    ensureNarratorLayout(root);
    let chats = 0;
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test-secret-value',
        model: 'test-model',
      }),
      clientFactory: () => ({
        chat: async () => {
          chats += 1;
          return { content: '{RMASSACRE{x', model: 'loaded' };
        },
      }),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const result = await service.handleFoundryLine({
      speaker: 'Grog',
      text: 'yesterday attack',
      kind: 'roll',
      historical: true,
    });
    expect(result.ok).toBe(true);
    expect(result.historical).toBe(true);
    expect(result.mudText).toContain('yesterday attack');
    expect(chats).toBe(0);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('asks the MUD agent to rewrite Foundry history as play-by-play', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-recap-'));
    ensureNarratorLayout(root);
    let chats = 0;
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test-secret-value',
        model: 'test-model',
      }),
      clientFactory: () => ({
        chat: async ({ messages }) => {
          chats += 1;
          const last = messages[messages.length - 1];
          expect(last.content).toContain('MUD play-by-play');
          expect(last.content).toContain('Longsword');
          expect(last.content).not.toMatch(/short recap/i);
          return { content: '{WGrog{x hit the orc.', model: 'loaded' };
        },
      }),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const result = await service.handleHistoryRecap([
      { speaker: 'Grog', text: 'Longsword 18 vs AC 14 hits', kind: 'roll' },
      { speaker: 'Orc', text: 'misses', kind: 'roll' },
    ]);
    expect(result.ok).toBe(true);
    expect(result.mudText).toContain('Grog');
    expect(chats).toBe(1);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('posts the last discussion answer to Foundry when asked to send to game chat', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-send-'));
    ensureNarratorLayout(root);
    const posted = [];
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test-secret-value',
        model: 'test-model',
      }),
      clientFactory: () => ({
        chat: async () => ({ content: 'Rina dealt 45', model: 'loaded' }),
      }),
      postToFoundry: async (payload) => {
        posted.push(payload);
        return { ok: true, path: 'create' };
      },
      now: () => '2026-01-01T00:00:00.000Z',
    });
    await service.handleUserQuestion('total damage');
    const send = await service.handleUserQuestion('send to the game chat');
    expect(posted).toHaveLength(1);
    expect(posted[0].content).toContain('[MUD]');
    expect(posted[0].content).toContain('Rina dealt 45');
    expect(send.ok).toBe(true);
    expect(send.posted).toBe(true);
    expect(send.text).toMatch(/Posted to Foundry chat/i);
    expect(send.text).not.toContain('Paste this');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('records combat totals and injects them into the play-by-play prompt', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-score-'));
    ensureNarratorLayout(root);
    /** @type {string[]} */
    const systems = [];
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test-secret-value',
        model: 'test-model',
      }),
      clientFactory: () => ({
        chat: async ({ messages }) => {
          const sys = messages.find((m) => m.role === 'system');
          systems.push(sys ? sys.content : '');
          return { content: '{WRina{x scorches the collector.', model: 'loaded' };
        },
      }),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    await service.handleFoundryLine({
      id: 'm1',
      speaker: 'Rina Silverthorn',
      text:
        'Scorching Ray 2nd Level Attack Damage Attack 1d20 + 5 Targets Scarlet Collector Scarlet Collector 21 Damage 2d6 + 12 17',
      kind: 'roll',
    });
    expect(loadScoreboard(root).actors['Rina Silverthorn'].dealt).toBe(17);
    expect(loadScoreboard(root).actors['Scarlet Collector'].taken).toBe(17);
    expect(systems[0]).toContain('SCOREBOARD');
    expect(systems[0]).toContain('Rina Silverthorn | 17');
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('clears persisted scores on /reset without calling the LM', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-reset-'));
    ensureNarratorLayout(root);
    let board = loadScoreboard(root);
    board.lastTimestamp = 99;
    board.lastId = 'keep-me';
    board = applyCombatEvent(board, 'a', {
      speaker: 'Rina',
      target: 'Orc',
      dealt: 17,
      taken: 17,
      healed: 0,
    });
    saveScoreboard(root, board);
    let chats = 0;
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test-secret-value',
        model: 'test-model',
      }),
      clientFactory: () => ({
        chat: async () => {
          chats += 1;
          return { content: 'should not run', model: 'loaded' };
        },
      }),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const result = await service.handleUserQuestion('/reset');
    expect(result.ok).toBe(true);
    expect(result.reset).toBe(true);
    expect(chats).toBe(0);
    expect(result.text).toMatch(/reset/i);
    const after = loadScoreboard(root);
    expect(after.actors).toEqual({});
    expect(after.events).toEqual({});
    expect(after.lastId).toBe('keep-me');
    expect(after.lastTimestamp).toBe(99);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not re-count Foundry lines at or before the cursor after /reset', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-reset-skip-'));
    ensureNarratorLayout(root);
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test-secret-value',
        model: 'test-model',
      }),
      clientFactory: () => ({
        chat: async () => ({ content: '{WRina{x hits.', model: 'loaded' }),
      }),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const ray =
      'Scorching Ray Attack Damage Attack 1d20 + 5 Targets Orc Orc 12 Damage 2d6 + 12 17';
    await service.handleFoundryLine({
      id: 'm1',
      timestamp: 100,
      speaker: 'Rina',
      text: ray,
      kind: 'roll',
    });
    await service.handleUserQuestion('/reset');
    await service.handleFoundryLine({
      id: 'm1',
      timestamp: 100,
      speaker: 'Rina',
      text: ray,
      kind: 'roll',
      historical: true,
    });
    expect(loadScoreboard(root).actors).toEqual({});
    await service.handleFoundryLine({
      id: 'm2',
      timestamp: 101,
      speaker: 'Rina',
      text:
        'Scorching Ray Attack Damage Attack 1d20 + 5 Targets Orc Orc 12 Damage 2d6 + 12 5',
      kind: 'roll',
    });
    expect(loadScoreboard(root).actors.Rina.dealt).toBe(5);
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('does not show play-by-play when the model emits SILENCE', async () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'flc-narr-silence-'));
    ensureNarratorLayout(root);
    const service = createNarratorService({
      rootDir: root,
      credsLoader: () => ({
        ok: true,
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'sk-test-secret-value',
        model: 'test-model',
      }),
      clientFactory: () => ({
        chat: async () => ({ content: 'SILENCE', model: 'loaded' }),
      }),
      now: () => '2026-01-01T00:00:00.000Z',
    });
    const result = await service.handleFoundryLine({
      speaker: '',
      text: 'Chat Log',
      kind: 'other',
    });
    expect(result.ok).toBe(true);
    expect(result.skipped).toBe('silence');
    expect(result.mudText).toBeUndefined();
    fs.rmSync(root, { recursive: true, force: true });
  });
});
