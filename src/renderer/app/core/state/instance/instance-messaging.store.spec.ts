import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../services/ipc';
import { InstanceListStore } from './instance-list.store';
import { InstanceMessagingStore } from './instance-messaging.store';
import { InstanceStateService } from './instance-state.service';
import type { Instance } from './instance.types';
import { PauseStore } from '../pause/pause.store';
import type { PauseStatePayload } from '@contracts/schemas/pause';
import { DraftService } from '../../services/draft.service';

function createInstance(overrides: Partial<Instance> = {}): Instance {
  return {
    id: 'inst-1',
    displayName: 'Instance 1',
    createdAt: Date.now(),
    historyThreadId: 'thread-1',
    parentId: null,
    childrenIds: [],
    agentId: 'build',
    agentMode: 'build',
    provider: 'claude',
    status: 'idle',
    contextUsage: {
      used: 0,
      total: 200000,
      percentage: 0,
    },
    lastActivity: Date.now(),
    providerSessionId: 'provider-session-1',
    sessionId: 'session-1',
    restartEpoch: 0,
    workingDirectory: '/tmp/project',
    yoloMode: false,
    launchMode: 'interactive',
    currentModel: undefined,
    outputBuffer: [],
    ...overrides,
  };
}

describe('InstanceMessagingStore', () => {
  let store: InstanceMessagingStore | undefined;
  let stateService: InstanceStateService | undefined;

  const ipcMock = {
    sendInput: vi.fn(),
    steerInput: vi.fn(),
    // Consumed by the InstanceStatusReconcilerService interval; resolves empty
    // so reconciliation is a no-op while timers are advanced in these tests.
    listInstances: vi.fn(),
  };

  const listStoreMock = {
    validateFiles: vi.fn(() => []),
    fileToAttachments: vi.fn(),
    interruptInstance: vi.fn(),
    restartInstance: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    ipcMock.sendInput.mockReset();
    ipcMock.steerInput.mockReset();
    ipcMock.steerInput.mockResolvedValue({ success: true });
    ipcMock.listInstances.mockReset();
    ipcMock.listInstances.mockResolvedValue({ success: true, data: [] });
    listStoreMock.validateFiles.mockReset();
    listStoreMock.validateFiles.mockReturnValue([]);
    listStoreMock.fileToAttachments.mockReset();
    listStoreMock.interruptInstance.mockReset();
    listStoreMock.interruptInstance.mockResolvedValue(true);
    listStoreMock.restartInstance.mockReset();
    listStoreMock.restartInstance.mockResolvedValue(true);
    TestBed.resetTestingModule();

    TestBed.configureTestingModule({
      providers: [
        InstanceMessagingStore,
        InstanceStateService,
        { provide: IpcFacadeService, useValue: ipcMock },
        { provide: InstanceListStore, useValue: listStoreMock },
      ],
    });

    store = TestBed.inject(InstanceMessagingStore);
    stateService = TestBed.inject(InstanceStateService);
  });

  afterEach(() => {
    clearInterval(
      (store as { queueWatchdog: ReturnType<typeof setInterval> | null } | undefined)
        ?.queueWatchdog ?? undefined
    );
    TestBed.resetTestingModule();
    vi.runOnlyPendingTimers();
    vi.useRealTimers();
    store = undefined;
    stateService = undefined;
  });

  it('stops retrying when the backend reports a permanent error state', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance());
    ipcMock.sendInput.mockResolvedValue({
      success: false,
      error: { message: 'Instance inst-1 is in error state and cannot accept input' },
    });

    await currentStore.sendInput('inst-1', 'ok');
    await vi.advanceTimersByTimeAsync(5000);

    const instance = currentStateService.getInstance('inst-1');
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    expect(instance?.status).toBe('error');
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
    expect(instance?.outputBuffer[instance.outputBuffer.length - 1]).toMatchObject({
      type: 'error',
      content: expect.stringContaining('Failed to send message'),
    });
  });

  it('treats "instance not found" as permanent and restores the text to the draft', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance());
    ipcMock.sendInput.mockResolvedValue({
      success: false,
      error: { message: 'Instance inst-1 not found' },
    });

    await currentStore.sendInput('inst-1', 'do not lose me');
    await vi.advanceTimersByTimeAsync(5000);

    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    expect(currentStateService.getInstance('inst-1')?.status).toBe('terminated');
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
    expect(TestBed.inject(DraftService).getDraft('inst-1')).toBe('do not lose me');
  });

  it('restores the draft when the instance terminates while the send waits out a respawn', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance());
    ipcMock.sendInput.mockResolvedValue({
      success: false,
      error: { message: 'Instance inst-1 terminated while waiting to deliver input (status: terminated)' },
    });

    await currentStore.sendInput('inst-1', 'wedged send');
    await vi.advanceTimersByTimeAsync(5000);

    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    expect(currentStateService.getInstance('inst-1')?.status).toBe('terminated');
    expect(TestBed.inject(DraftService).getDraft('inst-1')).toBe('wedged send');
  });

  it('never overwrites newer composer text when restoring a failed send', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance());
    TestBed.inject(DraftService).setDraft('inst-1', 'newer text the user typed');
    ipcMock.sendInput.mockResolvedValue({
      success: false,
      error: { message: 'Instance inst-1 not found' },
    });

    await currentStore.sendInput('inst-1', 'older failed message');
    await vi.advanceTimersByTimeAsync(5000);

    expect(TestBed.inject(DraftService).getDraft('inst-1')).toBe('newer text the user typed');
  });

  it('keeps respawning failures queued until the instance is ready again', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance());
    ipcMock.sendInput
      .mockResolvedValueOnce({
        success: false,
        error: { message: 'Instance inst-1 is respawning after interrupt. Please wait for it to be ready.' },
      })
      .mockResolvedValueOnce({ success: true });

    await currentStore.sendInput('inst-1', 'retry me');
    await vi.advanceTimersByTimeAsync(5000);

    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    expect(currentStateService.getInstance('inst-1')?.status).toBe('respawning');
    expect(currentStore.getMessageQueue('inst-1')).toEqual([{ message: 'retry me', files: undefined, retryCount: 1 }]);

    currentStateService.updateInstance('inst-1', { status: 'idle' });
    currentStore.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);

    expect(ipcMock.sendInput).toHaveBeenCalledTimes(2);
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
  });

  it('restores optimistic busy state when sendInput IPC never resolves', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'idle' }));
    ipcMock.sendInput.mockImplementation(() => new Promise(() => undefined));

    void currentStore.sendInput('inst-1', 'will hang');

    expect(currentStateService.getInstance('inst-1')?.status).toBe('busy');

    await vi.advanceTimersByTimeAsync(60_100);

    const instance = currentStateService.getInstance('inst-1');
    expect(instance?.status).toBe('idle');
    expect(instance?.outputBuffer[instance.outputBuffer.length - 1]).toMatchObject({
      type: 'error',
      content: expect.stringContaining('timed out'),
    });
  });

  it('does not show the renderer timeout for a long-running Cursor ACP turn before the backend timeout can resolve', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ provider: 'cursor', status: 'idle' }));
    ipcMock.sendInput.mockImplementation(() => new Promise(() => undefined));

    void currentStore.sendInput('inst-1', 'long cursor turn');

    await vi.advanceTimersByTimeAsync(60_100);

    let instance = currentStateService.getInstance('inst-1');
    expect(instance?.status).toBe('busy');
    expect(instance?.outputBuffer).toEqual([]);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    instance = currentStateService.getInstance('inst-1');
    expect(instance?.status).toBe('idle');
    expect(instance?.outputBuffer[instance.outputBuffer.length - 1]).toMatchObject({
      type: 'error',
      content: expect.stringContaining('timed out after 660s'),
    });
  });

  it('does not show the renderer timeout for a long-running Grok ACP turn before the backend timeout can resolve', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ provider: 'grok', status: 'idle' }));
    ipcMock.sendInput.mockImplementation(() => new Promise(() => undefined));

    void currentStore.sendInput('inst-1', 'long grok turn');

    await vi.advanceTimersByTimeAsync(60_100);

    let instance = currentStateService.getInstance('inst-1');
    expect(instance?.status).toBe('busy');
    expect(instance?.outputBuffer).toEqual([]);

    await vi.advanceTimersByTimeAsync(10 * 60_000);

    instance = currentStateService.getInstance('inst-1');
    expect(instance?.status).toBe('idle');
    expect(instance?.outputBuffer[instance.outputBuffer.length - 1]).toMatchObject({
      type: 'error',
      content: expect.stringContaining('timed out after 660s'),
    });
  });

  it('does not clear busy for long-running Codex turns at the renderer timeout boundary', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ provider: 'codex', status: 'idle' }));
    ipcMock.sendInput.mockImplementation(() => new Promise(() => undefined));

    void currentStore.sendInput('inst-1', 'long codex turn');

    await vi.advanceTimersByTimeAsync(11 * 60_000 + 100);

    const instance = currentStateService.getInstance('inst-1');
    expect(instance?.status).toBe('busy');
    expect(instance?.outputBuffer).toEqual([]);
  });

  it('replays seeded queued initial prompts without adding a duplicate user bubble', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance());
    currentStateService.messageQueue.set(
      new Map([
        [
          'inst-1',
          [
            {
              message: 'Seeded prompt',
              seededAlready: true,
            },
          ],
        ],
      ])
    );
    ipcMock.sendInput.mockResolvedValue({ success: true });

    currentStore.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);

    expect(ipcMock.sendInput).toHaveBeenCalledWith('inst-1', 'Seeded prompt', undefined, true);
  });

  it('clears replay recovery markers when the user sends the next message', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({
      restoreMode: 'replay-fallback',
      recoveryMethod: 'replay',
    }));
    ipcMock.sendInput.mockResolvedValue({ success: true });

    await currentStore.sendInput('inst-1', 'continue');

    const instance = currentStateService.getInstance('inst-1');
    expect(instance?.restoreMode).toBeUndefined();
    expect(instance?.recoveryMethod).toBeUndefined();
    expect(ipcMock.sendInput).toHaveBeenCalledWith('inst-1', 'continue', undefined, false);
  });

  it('routes sends from a superseded edit source to its replacement instance', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({
      id: 'source-1',
      status: 'superseded',
      supersededBy: 'replacement-1',
      cancelledForEdit: true,
    }));
    currentStateService.addInstance(createInstance({
      id: 'replacement-1',
      status: 'idle',
    }));
    ipcMock.sendInput.mockResolvedValue({ success: true });

    await currentStore.sendInput('source-1', 'Continue seamlessly');

    expect(ipcMock.sendInput).toHaveBeenCalledWith(
      'replacement-1',
      'Continue seamlessly',
      undefined,
      false
    );
    expect(currentStateService.getInstance('source-1')?.outputBuffer).toEqual([]);
  });

  it('queues a message and restarts the same instance when sending to a terminated session', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'terminated' }));
    ipcMock.sendInput.mockResolvedValue({ success: true });

    await currentStore.sendInput('inst-1', 'continue here');

    expect(listStoreMock.restartInstance).toHaveBeenCalledWith('inst-1');
    expect(ipcMock.sendInput).not.toHaveBeenCalled();
    expect(currentStore.getMessageQueue('inst-1')).toEqual([
      { message: 'continue here', files: undefined },
    ]);

    currentStateService.updateInstance('inst-1', { status: 'idle' });
    currentStore.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);

    expect(ipcMock.sendInput).toHaveBeenCalledWith('inst-1', 'continue here', undefined, false);
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
  });

  it('restores terminal queued messages as a system notice instead of an error', () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    const draftService = TestBed.inject(DraftService);
    currentStateService.addInstance(createInstance({ status: 'error' }));
    currentStateService.messageQueue.set(
      new Map([
        [
          'inst-1',
          [
            {
              message: 'Edit this queued message',
            },
          ],
        ],
      ])
    );

    currentStore.clearQueueWithNotification('inst-1');

    const instance = currentStateService.getInstance('inst-1');
    expect(draftService.getDraft('inst-1')).toBe('Edit this queued message');
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
    expect(instance?.outputBuffer[instance.outputBuffer.length - 1]).toMatchObject({
      type: 'system',
      metadata: {
        systemMessageKind: 'queue-restore',
      },
    });
  });

  it('preserves seeded queued metadata when a replay races with a paused state', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    const pauseStore = TestBed.inject(PauseStore);
    const pausedState: PauseStatePayload = {
      isPaused: true,
      reasons: ['user'],
      pausedAt: Date.now(),
      lastChange: Date.now(),
    };
    currentStateService.addInstance(createInstance());
    currentStateService.messageQueue.set(
      new Map([
        [
          'inst-1',
          [
            {
              message: 'Seeded prompt',
              seededAlready: true,
              hadAttachmentsDropped: true,
            },
          ],
        ],
      ])
    );
    ipcMock.sendInput.mockResolvedValue({ success: true });

    currentStore.processMessageQueue('inst-1');
    pauseStore.applyState(pausedState);
    await vi.advanceTimersByTimeAsync(150);

    expect(ipcMock.sendInput).not.toHaveBeenCalled();
    expect(currentStore.getMessageQueue('inst-1')).toEqual([
      {
        message: 'Seeded prompt',
        files: undefined,
        retryCount: 0,
        hadAttachmentsDropped: true,
        seededAlready: true,
      },
    ]);
  });

  it('delegates active-turn steer to the main process without local queue/interrupt races', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));

    await currentStore.sendInput('inst-1', 'later');
    await currentStore.steerInput('inst-1', 'stop and do this');

    expect(ipcMock.sendInput).not.toHaveBeenCalled();
    expect(ipcMock.steerInput).toHaveBeenCalledTimes(1);
    expect(ipcMock.steerInput).toHaveBeenCalledWith('inst-1', 'stop and do this', undefined);
    expect(listStoreMock.interruptInstance).not.toHaveBeenCalled();
    expect(currentStore.getMessageQueue('inst-1')).toEqual([
      { message: 'later', files: undefined },
    ]);
  });

  it('promotes a passive queued message to steer and interrupts once', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));

    await currentStore.sendInput('inst-1', 'first passive');
    await currentStore.sendInput('inst-1', 'second passive');
    await currentStore.steerQueuedMessage('inst-1', 1);

    expect(ipcMock.sendInput).not.toHaveBeenCalled();
    expect(listStoreMock.interruptInstance).toHaveBeenCalledTimes(1);
    expect(listStoreMock.interruptInstance).toHaveBeenCalledWith('inst-1');
    expect(currentStore.getMessageQueue('inst-1')).toEqual([
      { message: 'second passive', files: undefined, kind: 'steer' },
      { message: 'first passive', files: undefined },
    ]);
  });

  it('preserves queued metadata when promoting a queued message to steer', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));
    currentStateService.messageQueue.set(
      new Map([
        [
          'inst-1',
          [
            {
              message: 'Seeded prompt',
              retryCount: 2,
              seededAlready: true,
              hadAttachmentsDropped: true,
            },
          ],
        ],
      ])
    );

    await currentStore.steerQueuedMessage('inst-1', 0);

    expect(listStoreMock.interruptInstance).toHaveBeenCalledTimes(1);
    expect(currentStore.getMessageQueue('inst-1')).toEqual([
      {
        message: 'Seeded prompt',
        retryCount: 2,
        seededAlready: true,
        hadAttachmentsDropped: true,
        kind: 'steer',
      },
    ]);
  });

  it('does not send a second interrupt when steering right after Escape', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));

    currentStore.noteInterruptRequested('inst-1');
    await currentStore.steerInput('inst-1', 'new direction');

    expect(listStoreMock.interruptInstance).not.toHaveBeenCalled();
    expect(currentStore.getMessageQueue('inst-1')).toEqual([
      { message: 'new direction', files: undefined, kind: 'steer' },
    ]);
  });

  describe('quota-park gating (2026-07-11 park-fix)', () => {
    it('does not drain a quota-parked instance even though it sits at idle', async () => {
      const currentStore = store!;
      const currentStateService = stateService!;
      currentStateService.addInstance(createInstance({
        status: 'idle',
        waitReason: { kind: 'quota-park', provider: 'codex', resumeAt: Date.now() + 5 * 60_000 },
      }));
      currentStateService.messageQueue.set(
        new Map([['inst-1', [{ message: 'queued while parked' }]]])
      );

      // Let the 2s watchdog (drainAllReadyQueues) tick.
      await vi.advanceTimersByTimeAsync(2100);

      expect(ipcMock.sendInput).not.toHaveBeenCalled();
      expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);
    });

    it('does not drain via a direct processMessageQueue call while quota-parked', async () => {
      const currentStore = store!;
      const currentStateService = stateService!;
      currentStateService.addInstance(createInstance({
        status: 'idle',
        waitReason: { kind: 'quota-park', provider: 'codex', resumeAt: Date.now() + 5 * 60_000 },
      }));
      currentStateService.messageQueue.set(
        new Map([['inst-1', [{ message: 'queued while parked' }]]])
      );

      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(150);

      expect(ipcMock.sendInput).not.toHaveBeenCalled();
      expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);
    });

    it('queues a send instead of delivering it while the instance is quota-parked', async () => {
      const currentStore = store!;
      const currentStateService = stateService!;
      currentStateService.addInstance(createInstance({
        status: 'idle',
        waitReason: { kind: 'quota-park', provider: 'codex', resumeAt: Date.now() + 5 * 60_000 },
      }));

      await currentStore.sendInput('inst-1', 'are you there?');

      expect(ipcMock.sendInput).not.toHaveBeenCalled();
      expect(currentStore.getMessageQueue('inst-1')).toEqual([
        { message: 'are you there?', files: undefined },
      ]);
    });

    it('drains normally once the park clears on the next idle transition', async () => {
      const currentStore = store!;
      const currentStateService = stateService!;
      currentStateService.addInstance(createInstance({
        status: 'idle',
        waitReason: { kind: 'quota-park', provider: 'codex', resumeAt: Date.now() + 5 * 60_000 },
      }));
      currentStateService.messageQueue.set(
        new Map([['inst-1', [{ message: 'queued while parked' }]]])
      );
      ipcMock.sendInput.mockResolvedValue({ success: true });

      // Still parked — the watchdog must not drain it.
      await vi.advanceTimersByTimeAsync(2100);
      expect(ipcMock.sendInput).not.toHaveBeenCalled();

      // Park clears (mirrors main's resumeNow clearing waitReason before its
      // own resend) — the next idle transition should drain normally.
      currentStateService.updateInstance('inst-1', { waitReason: undefined });
      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(150);

      expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
      expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
    });
  });
});
