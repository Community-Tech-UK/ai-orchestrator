import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ElectronIpcService } from '../../services/ipc';
import { InstanceListStore } from './instance-list.store';
import { InstanceMessagingStore } from './instance-messaging.store';
import { InstanceStateService } from './instance-state.service';
import type { Instance } from './instance.types';

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
