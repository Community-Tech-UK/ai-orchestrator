import { Capacitor } from '@capacitor/core';
import { Preferences } from '@capacitor/preferences';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DRAFT_MAX_AGE_MS, DraftStore } from './draft-store';

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

  it('survives a corrupted store', async () => {
    vi.mocked(Preferences.get).mockResolvedValue({ value: 'not-json' });
    store = new DraftStore();

    expect(await store.load('anything')).toBe('');
  });
});
