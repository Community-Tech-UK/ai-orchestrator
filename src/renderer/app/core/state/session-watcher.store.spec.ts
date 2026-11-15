import { TestBed } from '@angular/core/testing';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { SessionWatcherFlagPayload } from '@contracts/schemas/session-watcher';
import { SessionWatcherIpcService } from '../services/ipc/session-watcher-ipc.service';
import { InstanceStateService } from './instance/instance-state.service';
import { SessionWatcherStore } from './session-watcher.store';

const flag = (instanceId: string, overrides: Partial<SessionWatcherFlagPayload> = {}): SessionWatcherFlagPayload => ({
  instanceId, requestCount: 2, question: 'Shall I push it?', closing: 'Shall I push it?', stop: 'asked_to_continue', acceptsYes: true, since: 1, ...overrides,
});

describe('SessionWatcherStore', () => {
  let push: (flags: SessionWatcherFlagPayload[]) => void;
  const listFlags = vi.fn();
  const answerYes = vi.fn();
  const setMuted = vi.fn();
  const updateInstance = vi.fn();

  beforeEach(() => {
    vi.clearAllMocks();
    listFlags.mockResolvedValue({ success: true, data: [flag('a')] });
    TestBed.configureTestingModule({ providers: [
      { provide: SessionWatcherIpcService, useValue: { listFlags, answerYes, setMuted, onFlagsChanged: (cb: typeof push) => { push = cb; return () => undefined; } } },
      { provide: InstanceStateService, useValue: { updateInstance } },
    ] });
  });

  it('reads the current list once on start', async () => {
    const store = TestBed.inject(SessionWatcherStore);
    await store.initialize();
    expect(store.flags()).toEqual([flag('a')]);
    expect(store.flagFor('a')).toEqual(flag('a'));
    expect(store.flagFor('b')).toBeUndefined();
    expect(store.flagFor(undefined)).toBeUndefined();
  });

  it('starts only once', async () => {
    const store = TestBed.inject(SessionWatcherStore);
    await store.initialize(); await store.initialize();
    expect(listFlags).toHaveBeenCalledTimes(1);
  });

  it('replaces the whole list when main pushes a change', async () => {
    const store = TestBed.inject(SessionWatcherStore);
    await store.initialize();
    push([flag('b')]);
    expect(store.flags().map((item) => item.instanceId)).toEqual(['b']);
    push([]);
    expect(store.flags()).toEqual([]);
  });

  it('does not let a list read that finishes late overwrite a newer push', async () => {
    let finish: (value: unknown) => void = () => undefined;
    listFlags.mockReturnValueOnce(new Promise((resolve) => { finish = resolve; }));
    const store = TestBed.inject(SessionWatcherStore);
    const started = store.initialize();
    push([flag('new')]);
    finish({ success: true, data: [flag('old')] });
    await started;
    expect(store.flags().map((item) => item.instanceId)).toEqual(['new']);
  });

  it('sends the click for the stop shown and returns no error when it went through', async () => {
    answerYes.mockResolvedValue({ success: true });
    const store = TestBed.inject(SessionWatcherStore);
    expect(await store.answerYes(flag('a', { requestCount: 9 }))).toBeNull();
    expect(answerYes).toHaveBeenCalledWith({ instanceId: 'a', requestCount: 9 });
  });

  it('returns one fixed line when the click is refused, never the raw error', async () => {
    answerYes.mockResolvedValue({ success: false, error: { message: 'ECONNRESET at ipc-main-handler.ts:42' } });
    expect(await TestBed.inject(SessionWatcherStore).answerYes(flag('a'))).toBe('Your answer was not sent. Open the session to reply.');
  });

  it('shows a mute on the session once main has saved it', async () => {
    setMuted.mockResolvedValue({ success: true });
    expect(await TestBed.inject(SessionWatcherStore).setMuted('a', true)).toBeNull();
    expect(setMuted).toHaveBeenCalledWith({ instanceId: 'a', muted: true });
    expect(updateInstance).toHaveBeenCalledWith('a', { watcherMuted: true });
  });

  it('leaves the session as it was when the mute is refused', async () => {
    setMuted.mockResolvedValue({ success: false, error: { message: 'This session is no longer open.' } });
    expect(await TestBed.inject(SessionWatcherStore).setMuted('a', true)).toBe('Could not change this session.');
    expect(updateInstance).not.toHaveBeenCalled();
  });
});
