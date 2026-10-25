import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceMessagingStore } from '../instance/instance-messaging.store';
import { InstanceStateService } from '../instance/instance-state.service';
import { InstanceListStore } from '../instance/instance-list.store';
import { QueuePersistenceService } from '../instance/queue-persistence.service';
import { IpcFacadeService } from '../../services/ipc';
import { GlobalPauseStore } from './global-pause.store';
import type { Instance } from '../instance/instance.types';

describe('restart pause message delivery', () => {
  const held = signal(true);
  const sendInput = vi.fn(async () => ({ success: true }));
  const promote = vi.fn(async () => true);
  const pickUp = vi.fn(async () => { held.set(false); return true; });
  let messages: InstanceMessagingStore;
  let state: InstanceStateService;
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); held.set(true);
    TestBed.configureTestingModule({ providers: [
      { provide: IpcFacadeService, useValue: { sendInput, listInstances: vi.fn(async () => ({ success: true, data: [] })) } },
      { provide: InstanceListStore, useValue: {} },
      { provide: QueuePersistenceService, useValue: { notifyPromoting: promote, notifyEnqueued: vi.fn(), notifyCancelled: vi.fn() } },
      { provide: GlobalPauseStore, useValue: { state: signal({ entries: [] }), holdsAutomaticInput: () => held(), pickUp } },
    ] });
    state = TestBed.inject(InstanceStateService);
    state.addInstance({ id: 'chat', status: 'idle', provider: 'claude', outputBuffer: [], historyThreadId: 'thread' } as unknown as Instance);
    messages = TestBed.inject(InstanceMessagingStore);
    state.messageQueue.set(new Map([['chat', [{ message: 'saved question' }]]]));
  });
  afterEach(() => { vi.clearAllTimers(); TestBed.resetTestingModule(); vi.useRealTimers(); });
  it('keeps queued text through idle while held, then sends as automatic input after release', async () => {
    messages.processMessageQueue('chat'); await vi.advanceTimersByTimeAsync(150);
    expect(sendInput).not.toHaveBeenCalled();
    expect(state.messageQueue().get('chat')?.[0].message).toBe('saved question');
    held.set(false);
    messages.processMessageQueue('chat'); await vi.advanceTimersByTimeAsync(150);
    expect(sendInput).toHaveBeenCalledWith('chat', 'saved question', undefined, false, true);
    expect(pickUp).not.toHaveBeenCalled();
  });
  it('picks up the session only for a newly submitted user message', async () => {
    await messages.sendInput('chat', 'I will take over');
    expect(pickUp).toHaveBeenCalledWith('chat');
    expect(sendInput).toHaveBeenCalledWith('chat', 'I will take over', undefined, false);
  });
  it('keeps a message if pause begins during durable promotion', async () => {
    held.set(false);
    promote.mockImplementationOnce(async () => { held.set(true); return true; });
    messages.processMessageQueue('chat'); await vi.advanceTimersByTimeAsync(150);
    expect(sendInput).not.toHaveBeenCalled();
    expect(state.messageQueue().get('chat')?.length).toBe(1);
  });
});
