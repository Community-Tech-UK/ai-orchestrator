import { TestBed } from '@angular/core/testing';
import { describe, it, expect, beforeEach, vi } from 'vitest';
import type { GlobalPauseState } from '@contracts/schemas/global-pause';
import { GlobalPauseIpcService } from '../../services/ipc/global-pause-ipc.service';
import { GlobalPauseStore } from './global-pause.store';

const state = (patch: Partial<GlobalPauseState> = {}): GlobalPauseState => ({
  phase: 'none', since: null, reason: null, batchId: null, heldInstanceIds: [], entries: [],
  completedNotes: 0, totalNotes: 0, resumeInterrupted: false, stale: false, summary: null, ...patch,
});

describe('GlobalPauseStore', () => {
  let listener: (value: GlobalPauseState) => void;
  const unsubscribe = vi.fn();
  const ipc = {
    getState: vi.fn(), command: vi.fn(),
    onStateChanged: vi.fn((callback: typeof listener) => { listener = callback; return unsubscribe; }),
  };
  beforeEach(() => {
    vi.clearAllMocks();
    ipc.getState.mockResolvedValue({ success: true, data: state() });
    TestBed.configureTestingModule({ providers: [{ provide: GlobalPauseIpcService, useValue: ipc }] });
  });
  it('keeps the session hold until the authoritative state releases it', async () => {
    const store = TestBed.inject(GlobalPauseStore);
    await store.initialize();
    listener(state({ phase: 'ready', heldInstanceIds: ['chat'] }));
    expect(store.holdsAutomaticInput('chat')).toBe(true);
    expect(store.holdsAutomaticInput('other')).toBe(false);
    listener(state());
    expect(store.holdsAutomaticInput('chat')).toBe(false);
  });
  it('does not replace a newer pushed state with a stale startup response', async () => {
    let resolve!: (value: unknown) => void;
    ipc.getState.mockReturnValue(new Promise(r => { resolve = r; }));
    const store = TestBed.inject(GlobalPauseStore);
    const pending = store.initialize();
    listener(state({ phase: 'ready', heldInstanceIds: ['chat'] }));
    resolve({ success: true, data: state() });
    await pending;
    expect(store.state().phase).toBe('ready');
  });
  it('shows command failure without clearing the hold', async () => {
    const store = TestBed.inject(GlobalPauseStore);
    await store.initialize();
    listener(state({ phase: 'ready', heldInstanceIds: ['chat'] }));
    ipc.command.mockResolvedValue({ success: false, error: { message: 'Cannot resume yet' } });
    await store.command('resume');
    expect(store.error()).toBe('Cannot resume yet');
    expect(store.holdsAutomaticInput('chat')).toBe(true);
  });
  it('unsubscribes on destruction', async () => {
    const store = TestBed.inject(GlobalPauseStore);
    await store.initialize();
    TestBed.resetTestingModule();
    expect(unsubscribe).toHaveBeenCalledOnce();
  });
  it('keeps automatic queues safe when the initial state cannot be read, and permits retry', async () => {
    ipc.getState.mockResolvedValueOnce({ success: false, error: { message: 'Connection lost' } });
    const store = TestBed.inject(GlobalPauseStore);
    await store.initialize();
    expect(store.holdsAutomaticInput('any-session')).toBe(true);
    await store.initialize();
    expect(store.holdsAutomaticInput('any-session')).toBe(false);
    expect(store.error()).toBeNull();
  });
});
