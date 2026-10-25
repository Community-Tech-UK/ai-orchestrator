import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { GlobalPauseEntry, GlobalPauseState } from '@contracts/schemas/global-pause';
import { GlobalPauseQueueController } from './global-pause-queue-controller.service';
import { GlobalPauseStore } from './global-pause.store';
import { QueuePersistenceService } from '../instance/queue-persistence.service';
import { InstanceStateService } from '../instance/instance-state.service';
import type { QueuedMessage } from '../instance/instance.types';

const entry: GlobalPauseEntry = {
  id: 'entry', kind: 'session', targetId: 'old', displayName: 'Starting session', workspace: null,
  provider: 'codex', originalInstanceId: 'old', historyThreadId: 'thread', providerSessionId: null,
  wasBusy: true, noteText: null, noteKind: 'basic', state: 'ready', voidReason: 'initial-prompt-queued', createdAt: 1, updatedAt: 1,
};

describe('GlobalPauseQueueController', () => {
  const snapshot = signal<GlobalPauseState>({ phase: 'ready', since: 1, reason: null, batchId: 'batch', heldInstanceIds: ['old'],
    entries: [entry], completedNotes: 1, totalNotes: 1, resumeInterrupted: false, stale: false, summary: null });
  const queue = signal(new Map<string, QueuedMessage[]>());
  const restore = vi.fn(async () => true);
  beforeEach(() => {
    vi.clearAllMocks(); queue.set(new Map()); snapshot.update(s => ({ ...s, entries: [{ ...entry }] }));
    TestBed.configureTestingModule({ providers: [
      { provide: GlobalPauseStore, useValue: { state: snapshot } },
      { provide: InstanceStateService, useValue: { messageQueue: queue } },
      { provide: QueuePersistenceService, useValue: { restorePauseQueue: restore } },
    ] });
  });
  it('loads a parked initial prompt once per identity, and preserves queued objects when revived', async () => {
    TestBed.inject(GlobalPauseQueueController); TestBed.tick();
    await Promise.resolve(); await Promise.resolve();
    expect(restore).toHaveBeenCalledWith('old', expect.any(Function));
    const pending = { message: 'pending with attachments' };
    queue.set(new Map([['old', [pending]]]));
    snapshot.update(s => ({ ...s, phase: 'resuming', entries: [{ ...entry, targetId: 'new' }] }));
    TestBed.tick(); await Promise.resolve(); await Promise.resolve();
    expect(queue().has('old')).toBe(false);
    expect(queue().get('new')?.[0]).toBe(pending);
    expect(restore).toHaveBeenCalledTimes(2);
    snapshot.update(s => ({ ...s })); TestBed.tick();
    expect(restore).toHaveBeenCalledTimes(2);
  });
});
