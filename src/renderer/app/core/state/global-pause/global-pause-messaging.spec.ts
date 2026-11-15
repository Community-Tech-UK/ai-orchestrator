import { TestBed } from '@angular/core/testing';
import { computed, signal } from '@angular/core';
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { InstanceMessagingStore } from '../instance/instance-messaging.store';
import { InstanceStateService } from '../instance/instance-state.service';
import { InstanceListStore } from '../instance/instance-list.store';
import { QueuePersistenceService } from '../instance/queue-persistence.service';
import { IpcFacadeService } from '../../services/ipc';
import { GlobalPauseStore } from './global-pause.store';
import type { Instance } from '../instance/instance.types';

vi.mock('../../../../../shared/utils/id-generator', () => ({ generateId: () => 'new-bubble' }));

describe('restart pause message delivery', () => {
  const held = signal(true);
  const unreadable = signal(false);
  const sendInput = vi.fn(async () => ({ success: true }));
  const promote = vi.fn(async () => true);
  const pickUp = vi.fn(async () => { held.set(false); return true; });
  const wakeInstance = vi.fn(async (): Promise<{ success: boolean; error?: { message: string } }> => ({ success: true }));
  let messages: InstanceMessagingStore;
  let state: InstanceStateService;
  beforeEach(() => {
    vi.useFakeTimers(); vi.clearAllMocks(); held.set(true); unreadable.set(false);
    TestBed.configureTestingModule({ providers: [
      { provide: IpcFacadeService, useValue: { sendInput, wakeInstance, listInstances: vi.fn(async () => ({ success: true, data: [] })) } },
      { provide: InstanceListStore, useValue: {} },
      { provide: QueuePersistenceService, useValue: { notifyPromoting: promote, notifyEnqueued: vi.fn(), notifyCancelled: vi.fn(), getAdmissionId: vi.fn(), finishSend: vi.fn() } },
      { provide: GlobalPauseStore, useValue: { state: computed(() => ({ entries: [], heldInstanceIds: held() && !unreadable() ? ['chat'] : [] })),
        holdsAutomaticInput: () => held(), pickUp, error: () => null } },
    ] });
    state = TestBed.inject(InstanceStateService);
    state.addInstance({ id: 'chat', status: 'idle', provider: 'claude', outputBuffer: [], historyThreadId: 'thread' } as unknown as Instance);
    messages = TestBed.inject(InstanceMessagingStore);
    state.messageQueue.set(new Map([['chat', [{ message: 'saved question', userMessageId: 'saved-bubble' }]]]));
  });
  afterEach(() => { vi.clearAllTimers(); TestBed.resetTestingModule(); vi.useRealTimers(); });
  it('keeps queued text through idle while held, then sends as automatic input after release', async () => {
    messages.processMessageQueue('chat'); await vi.advanceTimersByTimeAsync(150);
    expect(sendInput).not.toHaveBeenCalled();
    expect(state.messageQueue().get('chat')?.[0]).toEqual({ message: 'saved question', userMessageId: 'saved-bubble' });
    held.set(false);
    messages.processMessageQueue('chat'); await vi.advanceTimersByTimeAsync(150);
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('chat', 'saved question', undefined, false, true, undefined, undefined, 'saved-bubble');
    expect(state.messageQueue().has('chat')).toBe(false);
    expect(pickUp).not.toHaveBeenCalled();
  });
  it('picks up the session only for a newly submitted user message', async () => {
    await messages.sendInput('chat', 'I will take over');
    expect(pickUp).toHaveBeenCalledWith('chat');
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('chat', 'I will take over', undefined, false, false, undefined, undefined, 'new-bubble');
  });
  it('reports a held queue, and Send now picks the session up and sends it', async () => {
    expect(messages.restartHold.isHeld('chat')).toBe(true);
    await messages.restartHold.sendNow('chat'); await vi.advanceTimersByTimeAsync(150);
    expect(pickUp).toHaveBeenCalledWith('chat');
    expect(sendInput).toHaveBeenCalledExactlyOnceWith('chat', 'saved question', undefined, false, true, undefined, undefined, 'saved-bubble');
    expect(messages.restartHold.isHeld('chat')).toBe(false);
  });
  it('Send now also releases a hold left by Stop, so leaving the pause actually sends', async () => {
    messages.parkQueueAfterInterrupt('chat');
    await messages.restartHold.sendNow('chat'); await vi.advanceTimersByTimeAsync(150);
    expect(messages.isQueueParked('chat')).toBe(false);
    expect(sendInput).toHaveBeenCalledOnce();
  });
  it('keeps the queue and every hold, and says so, when the session cannot leave the pause', async () => {
    pickUp.mockImplementationOnce(async () => false);
    messages.parkQueueAfterInterrupt('chat');
    await messages.restartHold.sendNow('chat'); await vi.advanceTimersByTimeAsync(150);
    expect(sendInput).not.toHaveBeenCalled();
    expect(messages.isQueueParked('chat')).toBe(true);
    expect(state.messageQueue().get('chat')?.length).toBe(1);
    expect(state.getInstance('chat')?.outputBuffer.at(-1)).toMatchObject({ type: 'error', content: expect.stringContaining('restart pause') });
  });
  it('wakes a sleeping session instead of sending into it', async () => {
    state.updateInstance('chat', { status: 'hibernated' });
    await messages.restartHold.sendNow('chat'); await vi.advanceTimersByTimeAsync(150);
    expect(wakeInstance).toHaveBeenCalledWith('chat');
    expect(sendInput).not.toHaveBeenCalled();
    expect(state.messageQueue().get('chat')?.length).toBe(1);
  });
  it('says how to wake a sleeping session when the wake fails', async () => {
    state.updateInstance('chat', { status: 'hibernated' });
    wakeInstance.mockImplementationOnce(async () => ({ success: false, error: { message: 'spawn failed' } }));
    await messages.restartHold.sendNow('chat');
    expect(state.getInstance('chat')?.outputBuffer.at(-1)).toMatchObject({ type: 'error', content: expect.stringContaining('Send any message to wake it') });
  });
  it('leaves a stopped session in the pause, so its queue is not cleared, and says to press Resume', async () => {
    state.updateInstance('chat', { status: 'failed' });
    await messages.restartHold.sendNow('chat'); await vi.advanceTimersByTimeAsync(2500);
    expect(pickUp).not.toHaveBeenCalled();
    expect(state.messageQueue().get('chat')?.length).toBe(1);
    expect(state.getInstance('chat')?.outputBuffer.at(-1)).toMatchObject({ type: 'error', content: expect.stringContaining('Press Resume') });
  });
  it('takes the session out of the pause once for a double click', async () => {
    await Promise.all([messages.restartHold.sendNow('chat'), messages.restartHold.sendNow('chat')]);
    expect(pickUp).toHaveBeenCalledOnce();
  });
  it('does not describe a restart pause when the pause state cannot be read', () => {
    unreadable.set(true);
    expect(messages.restartHold.isHeld('chat')).toBe(false);
  });
  it('does not report a hold when nothing is queued', () => {
    state.messageQueue.set(new Map());
    expect(messages.restartHold.isHeld('chat')).toBe(false);
  });
  it('keeps a message if pause begins during durable promotion', async () => {
    held.set(false);
    promote.mockImplementationOnce(async () => { held.set(true); return true; });
    messages.processMessageQueue('chat'); await vi.advanceTimersByTimeAsync(150);
    expect(sendInput).not.toHaveBeenCalled();
    expect(state.messageQueue().get('chat')?.length).toBe(1);
  });
});
