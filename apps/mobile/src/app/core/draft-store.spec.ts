import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_MAX_AGE_MS, DraftStore, mergeEarlyNewSessionDraft, parseNewSessionDraft } from './draft-store';

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    isNativePlatform: vi.fn(),
  },
}));

vi.mock('@capacitor/preferences', () => ({
  Preferences: {
    get: vi.fn(),
    set: vi.fn(),
  },
}));

describe('DraftStore', () => {
  let store: DraftStore;

  beforeEach(() => {
    vi.clearAllMocks();
    vi.useFakeTimers();
    vi.mocked(Capacitor.isNativePlatform).mockReturnValue(false);
    vi.mocked(Preferences.get).mockResolvedValue({ value: null });
    vi.mocked(Preferences.set).mockResolvedValue(undefined);
    store = new DraftStore();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('round-trips a saved draft and debounces the write', async () => {
    store.save('instance:a', 'half-typed message');
    await vi.advanceTimersByTimeAsync(500);

    expect(await store.load('instance:a')).toBe('half-typed message');
    expect(Preferences.set).toHaveBeenCalledTimes(1);
    const written = JSON.parse(vi.mocked(Preferences.set).mock.calls[0][0].value) as Record<
      string,
      { text: string }
    >;
    expect(written['instance:a'].text).toBe('half-typed message');
  });

  it('coalesces rapid keystrokes into one write', async () => {
    store.save('instance:a', 'h');
    store.save('instance:a', 'he');
    store.save('instance:a', 'hello');
    await vi.advanceTimersByTimeAsync(1000);

    expect(Preferences.set).toHaveBeenCalledTimes(1);
    expect(await store.load('instance:a')).toBe('hello');
  });

  it('clears a draft when text goes blank (message sent)', async () => {
    store.save('instance:a', 'draft');
    await vi.advanceTimersByTimeAsync(500);
    store.save('instance:a', '');
    await vi.advanceTimersByTimeAsync(500);

    expect(await store.load('instance:a')).toBe('');
  });

  it('drops stale drafts on load', async () => {
    const now = Date.now();
    vi.mocked(Preferences.get).mockResolvedValue({
      value: JSON.stringify({
        fresh: { text: 'keep', at: now - 60_000 },
        stale: { text: 'drop', at: now - DRAFT_MAX_AGE_MS - 1 },
      }),
    });
    store = new DraftStore();

    expect(await store.load('fresh')).toBe('keep');
    expect(await store.load('stale')).toBe('');
  });

  it('persists New Session text and configuration per host without attachments', async () => {
    const draft = { text: 'Draft A', directory: '/work/a', provider: 'codex', model: 'example-model', reasoningEffort: 'high' as const, attachments: [{ data: 'large-image-placeholder' }] };
    store.saveNewSession('host-a', draft);
    store.saveNewSession('host-b', { text: 'Draft B', directory: '/work/b', provider: 'auto' });
    await vi.advanceTimersByTimeAsync(500);
    expect(await store.loadNewSession('host-a')).toEqual({ text: 'Draft A', directory: '/work/a', provider: 'codex', model: 'example-model', reasoningEffort: 'high' });
    expect((await store.loadNewSession('host-b'))?.directory).toBe('/work/b');
    expect(JSON.stringify(vi.mocked(Preferences.set).mock.calls)).not.toContain('large-image-placeholder');
    vi.mocked(Preferences.get).mockResolvedValue({ value: vi.mocked(Preferences.set).mock.calls[0][0].value });
    store = new DraftStore();
    expect((await store.loadNewSession('host-a'))?.model).toBe('example-model');
    store.clearNewSession('host-a'); await vi.advanceTimersByTimeAsync(500);
    expect(await store.loadNewSession('host-a')).toBeNull();
    expect((await store.loadNewSession('host-b'))?.text).toBe('Draft B');
  });

  it('keeps attachment drafts in memory only and copies their arrays', async () => {
    const attachment = { name: 'image.jpg', type: 'image/jpeg', size: 1, data: 'image-placeholder' };
    const originals = [attachment];
    store.saveAttachments('instance:a', originals); originals.length = 0;
    const restored = store.attachments('instance:a');
    expect(restored).toEqual([attachment]); restored.length = 0;
    expect(store.attachments('instance:a')).toEqual([attachment]);
    store.save('instance:a', 'text'); await vi.advanceTimersByTimeAsync(500);
    expect(JSON.stringify(vi.mocked(Preferences.set).mock.calls)).not.toContain('image-placeholder');
    expect(new DraftStore().attachments('instance:a')).toEqual([]);
    store.saveAttachments('instance:a', []);
    expect(store.attachments('instance:a')).toEqual([]);
  });

  it('checks composer ownership after async storage has yielded before clearing', async () => {
    const first = store.claimNewSession('host-a');
    store.saveNewSession('host-a', { text: 'First', directory: '/a', provider: 'auto' }, first);
    await vi.advanceTimersByTimeAsync(500);
    const pendingClear = store.completeNewSession('host-a', first);
    const next = store.claimNewSession('host-a');
    store.saveNewSession('host-a', { text: 'Next', directory: '/b', provider: 'codex' }, next);
    store.saveAttachments('new-session:host-a', [{ name: 'new.jpg', type: 'image/jpeg', size: 1, data: 'placeholder' }], next);
    expect(await pendingClear).toBe(false);
    await vi.advanceTimersByTimeAsync(500);
    expect((await store.loadNewSession('host-a'))?.text).toBe('Next');
    expect(store.attachments('new-session:host-a')).toHaveLength(1);
    expect(await store.completeNewSession('host-a', next)).toBe(true);
    expect(await store.loadNewSession('host-a')).toBeNull();
    expect(store.attachments('new-session:host-a')).toEqual([]);
  });

  it('ignores an old queued save after a new composer claims the draft', async () => {
    const first = store.claimNewSession('host-a');
    store.saveNewSession('host-a', { text: 'Stale queued write', directory: '/a', provider: 'auto' }, first);
    const next = store.claimNewSession('host-a');
    store.saveNewSession('host-a', { text: 'New owner', directory: '/b', provider: 'auto' }, next);
    store.saveNewSession('host-a', { text: 'Late stale write', directory: '/a', provider: 'auto' }, first);
    await vi.advanceTimersByTimeAsync(500);
    expect((await store.loadNewSession('host-a'))?.text).toBe('New owner');
  });

  it('recovers legacy text atomically without consuming it for a stale composer', async () => {
    store.save('new-session', 'Legacy text'); await vi.advanceTimersByTimeAsync(500);
    const first = store.claimNewSession('host-a');
    const next = store.claimNewSession('host-a');
    const draft = { text: 'Current text\n\nLegacy text', directory: '/a', provider: 'auto' };
    expect(await store.recoverLegacyNewSession('host-a', first, draft, 'Legacy text')).toBe(false);
    expect(await store.load('new-session')).toBe('Legacy text');
    expect(await store.recoverLegacyNewSession('host-a', next, draft, 'Legacy text')).toBe(true);
    expect(await store.load('new-session')).toBe('');
    expect((await store.loadNewSession('host-a'))?.text).toBe(draft.text);
  });

  it('survives a corrupted store', async () => {
    vi.mocked(Preferences.get).mockResolvedValue({ value: 'not-json' });
    store = new DraftStore();

    expect(await store.load('anything')).toBe('');
  });
});

describe('Structured New Session recovery', () => {
  it.each(['', 'not-json', 'null', '[]', '{"text":42}', '{"text":"saved","directory":null,"provider":"auto"}'])('recovers early edits safely from invalid stored JSON %s', (serialized) => {
    const initial = { text: '', directory: '', provider: 'auto' };
    const early = { text: 'Early edit', directory: '/chosen', provider: 'codex' };
    expect(parseNewSessionDraft(serialized)).toBeNull();
    expect(parseNewSessionDraft(mergeEarlyNewSessionDraft(serialized, early, initial))).toEqual(expect.objectContaining(early));
  });

  it('validates optional settings and excludes images from structured recovery', () => {
    const initial = { text: '', directory: '', provider: 'auto' };
    const early = { ...initial, text: 'Early', attachments: [{ data: 'image-placeholder' }] };
    const recovered = mergeEarlyNewSessionDraft(JSON.stringify({ text: 'Saved', directory: '/saved', provider: 'codex', model: 42, reasoningEffort: 'invalid', attachments: [{ data: 'saved-image-placeholder' }] }), early, initial);
    expect(parseNewSessionDraft(recovered)).toEqual({ text: 'Early\n\nSaved', directory: '/saved', provider: 'codex', model: undefined, reasoningEffort: undefined });
    expect(recovered).not.toContain('image-placeholder');
  });
});
