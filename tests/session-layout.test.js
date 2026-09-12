import { describe, expect, it } from 'vitest';
import {
  GAME_READY_SCRIPT,
  buildTagPopoutScript,
  buildIdentifyPopoutScript,
  FIT_POPOUT_SCRIPT,
  MAX_ENTRIES,
  SNAPSHOT_LAYOUT_SCRIPT,
  buildCloseUnlistedScript,
  buildRestoreScript,
  descriptorKey,
  desktopSignature,
  sameDesktop,
  layoutRecordFromSnapshot,
  layoutRecordKey,
  popoutBoundsKey,
  readLayout,
  removeEntry,
  sameLayout,
  sanitizeDescriptor,
  sanitizeEntry,
  sanitizePosition,
  shouldForgetOnFailure,
} from '../electron/session-layout.js';

const DOC = { kind: 'document', uuid: 'Actor.abc123' };
const TAB = { kind: 'sidebar', tab: 'chat' };
const APP = { kind: 'app', cls: 'CombatTracker' };
const parses = (src) => expect(() => new Function(`return ${src}`)).not.toThrow();

describe('sanitizeDescriptor', () => {
  it('accepts the three kinds', () => {
    expect(sanitizeDescriptor(DOC)).toEqual(DOC);
    expect(sanitizeDescriptor({ kind: 'document', uuid: 'Compendium.dnd5e.monsters.Actor.xyz' })).toEqual({
      kind: 'document',
      uuid: 'Compendium.dnd5e.monsters.Actor.xyz',
    });
    expect(sanitizeDescriptor(TAB)).toEqual(TAB);
    expect(sanitizeDescriptor(APP)).toEqual(APP);
  });

  it('rejects junk and transient dialogs', () => {
    expect(sanitizeDescriptor(null)).toBeNull();
    expect(sanitizeDescriptor('Actor.x')).toBeNull();
    expect(sanitizeDescriptor({ kind: 'document', uuid: '' })).toBeNull();
    expect(sanitizeDescriptor({ kind: 'document', uuid: 'has space' })).toBeNull();
    expect(sanitizeDescriptor({ kind: 'document', uuid: '<script>' })).toBeNull();
    expect(sanitizeDescriptor({ kind: 'sidebar', tab: '1bad' })).toBeNull();
    expect(sanitizeDescriptor({ kind: 'app', cls: 'a.b' })).toBeNull();
    expect(sanitizeDescriptor({ kind: 'app', cls: 'Dialog' })).toBeNull();
    expect(sanitizeDescriptor({ kind: 'app', cls: 'DialogV2' })).toBeNull();
    expect(sanitizeDescriptor({ kind: 'other', x: 1 })).toBeNull();
    expect(sanitizeDescriptor({ kind: 'document', uuid: 'x'.repeat(201) })).toBeNull();
  });
});

describe('sanitizePosition / sanitizeEntry', () => {
  it('keeps finite numbers, drops bad sizes and non-numbers', () => {
    expect(sanitizePosition({ left: 10.12345, top: 'auto', width: 0, height: 400, scale: 1 })).toEqual({
      left: 10.123,
      height: 400,
      scale: 1,
    });
    expect(sanitizePosition(null)).toEqual({});
  });

  it('normalizes mode/minimized', () => {
    expect(sanitizeEntry({ ...DOC, mode: 'popout', pos: { left: 1 }, minimized: true })).toEqual({
      ...DOC,
      mode: 'popout',
      pos: { left: 1 },
      minimized: true,
    });
    expect(sanitizeEntry({ ...TAB, mode: 'weird' })).toEqual({ ...TAB, mode: 'window', pos: {}, minimized: false });
    expect(sanitizeEntry({ kind: 'app', cls: 'Dialog', mode: 'window' })).toBeNull();
  });
});

describe('keys', () => {
  it('builds stable identity and window-state keys', () => {
    expect(descriptorKey(DOC)).toBe('document:Actor.abc123');
    expect(descriptorKey(TAB)).toBe('sidebar:chat');
    expect(descriptorKey(APP)).toBe('app:CombatTracker');
    expect(popoutBoundsKey('game:srv1', DOC)).toBe('game:srv1:popout:document:Actor.abc123');
    expect(layoutRecordKey('game:srv1')).toBe('game:srv1:layout');
  });
});

describe('layout records', () => {
  it('reads, dedupes, and sanitizes stored layouts', () => {
    expect(readLayout(undefined)).toEqual([]);
    expect(readLayout({ windows: 'nope' })).toEqual([]);
    const got = readLayout({
      windows: [{ ...DOC, mode: 'window' }, { ...DOC, mode: 'popout' }, 'junk', { ...TAB, pos: { left: 5 } }],
    });
    expect(got).toEqual([
      { ...DOC, mode: 'window', pos: {}, minimized: false },
      { ...TAB, mode: 'window', pos: { left: 5 }, minimized: false },
    ]);
  });

  it('builds a record from a page snapshot and caps size', () => {
    expect(layoutRecordFromSnapshot(null)).toBeNull();
    const raw = [];
    for (let i = 0; i < MAX_ENTRIES + 5; i += 1) {
      raw.push({ kind: 'document', uuid: `Actor.${i}`, mode: 'window', pos: { left: i } });
    }
    raw.push({ kind: 'app', cls: 'Dialog' });
    const displays = [{ bounds: { x: 1920, y: 0, width: 2560, height: 1440 } }, { bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
    const rec = layoutRecordFromSnapshot(raw, { now: () => 'T', displays });
    expect(rec.savedAt).toBe('T');
    expect(rec.windows).toHaveLength(MAX_ENTRIES);
    expect(rec.desktop).toEqual([
      { x: 0, y: 0, width: 1920, height: 1080 },
      { x: 1920, y: 0, width: 2560, height: 1440 },
    ]);
  });

  it('detects a changed desktop', () => {
    const one = [{ bounds: { x: 0, y: 0, width: 1920, height: 1080 } }];
    const two = [...one, { bounds: { x: 1920, y: 0, width: 1920, height: 1080 } }];
    const bigger = [{ bounds: { x: 0, y: 0, width: 2560, height: 1440 } }];
    expect(sameDesktop(one, one)).toBe(true);
    expect(sameDesktop(two, [two[1], two[0]])).toBe(true); // order-insensitive
    expect(sameDesktop(one, two)).toBe(false);
    expect(sameDesktop(one, bigger)).toBe(false);
    expect(sameDesktop([], [])).toBe(false); // unknown desktop never matches
    expect(sameDesktop(undefined, one)).toBe(false);
    // stored signature (plain rects) compares against live displays
    expect(sameDesktop(desktopSignature(one), one)).toBe(true);
  });

  it('removes by identity and compares structurally', () => {
    const layout = readLayout({ windows: [DOC, TAB] });
    expect(removeEntry(layout, { kind: 'document', uuid: 'Actor.abc123' })).toEqual(readLayout({ windows: [TAB] }));
    expect(sameLayout({ windows: layout }, { windows: readLayout({ windows: [DOC, TAB] }) })).toBe(true);
    expect(sameLayout({ windows: layout }, { windows: [] })).toBe(false);
    expect(sameLayout(null, undefined)).toBe(true);
  });
});

describe('page scripts', () => {
  it('are syntactically valid and self-contained', () => {
    parses(SNAPSHOT_LAYOUT_SCRIPT);
    parses(buildTagPopoutScript(7));
    parses(buildIdentifyPopoutScript(7));
    parses(FIT_POPOUT_SCRIPT);
    parses(GAME_READY_SCRIPT);
    expect(SNAPSHOT_LAYOUT_SCRIPT).toContain('ui.windows');
    expect(SNAPSHOT_LAYOUT_SCRIPT).toContain('foundry.applications');
    expect(buildTagPopoutScript(7)).toContain('__flcPopoutTag = 7');
    expect(buildIdentifyPopoutScript(7)).toContain('__flcPopoutTag === 7');
    expect(buildIdentifyPopoutScript('x')).toContain('=== NaN'); // never matches junk
    // PopOut! is a lexical class, never a window property.
    for (const src of [SNAPSHOT_LAYOUT_SCRIPT, GAME_READY_SCRIPT, buildIdentifyPopoutScript(1), buildRestoreScript({ kind: 'sidebar', tab: 'chat', mode: 'popout' })]) {
      expect(src).toContain("typeof PopoutModule !== 'undefined'");
      expect(src).not.toMatch(/window\.PopoutModule\s*&&/);
    }
    expect(FIT_POPOUT_SCRIPT).toContain('MutationObserver');
  });

  it('restore script embeds a sanitized entry', () => {
    const src = buildRestoreScript({ ...DOC, mode: 'window', pos: { left: 1, top: 2 }, minimized: true });
    parses(src);
    expect(src).toContain('"uuid":"Actor.abc123"');
    expect(src).toContain('"mode":"window"');
    expect(src).toContain('fromUuid');
    expect(src).toContain('setPosition');
    expect(buildRestoreScript({ kind: 'document', uuid: 'bad uuid', mode: 'window' })).toContain('(null)');
  });

  it('close-unlisted script receives the identity keys to keep', () => {
    const src = buildCloseUnlistedScript(readLayout({ windows: [DOC, TAB] }));
    parses(src);
    expect(src).toContain('["document:Actor.abc123","sidebar:chat"]');
    expect(src).toContain('Dialog');
  });
});

describe('shouldForgetOnFailure', () => {
  it('forgets missing objects, retries transient problems', () => {
    expect(shouldForgetOnFailure('not_found')).toBe(true);
    expect(shouldForgetOnFailure('no_sheet')).toBe(true);
    expect(shouldForgetOnFailure('no_popout_module')).toBe(false);
    expect(shouldForgetOnFailure('exception')).toBe(false);
    expect(shouldForgetOnFailure('render_failed')).toBe(false);
  });
});
