import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from '../../services/ipc';
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
    sessionId: 'session-1',
    workingDirectory: '/tmp/project',
    yoloMode: false,
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
  };

  const listStoreMock = {
    validateFiles: vi.fn(() => []),
    fileToAttachments: vi.fn(),
    interruptInstance: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    ipcMock.sendInput.mockReset();
    listStoreMock.validateFiles.mockReset();
    listStoreMock.validateFiles.mockReturnValue([]);
    listStoreMock.fileToAttachments.mockReset();
    listStoreMock.interruptInstance.mockReset();
    listStoreMock.interruptInstance.mockResolvedValue(true);
    TestBed.resetTestingModule();

    TestBed.configureTestingModule({
      providers: [
        InstanceMessagingStore,
        InstanceStateService,
        { provide: ElectronIpcService, useValue: ipcMock },
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

  it('queues steer messages ahead of passive queued messages and interrupts once', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));

    await currentStore.sendInput('inst-1', 'later');
    await currentStore.steerInput('inst-1', 'stop and do this');

    expect(ipcMock.sendInput).not.toHaveBeenCalled();
    expect(listStoreMock.interruptInstance).toHaveBeenCalledTimes(1);
    expect(listStoreMock.interruptInstance).toHaveBeenCalledWith('inst-1');
    expect(currentStore.getMessageQueue('inst-1')).toEqual([
      { message: 'stop and do this', files: undefined, kind: 'steer' },
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
});
