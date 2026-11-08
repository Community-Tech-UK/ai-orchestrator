import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IpcFacadeService } from '../../services/ipc';
import { InstanceListStore } from './instance-list.store';
import { InstanceMessagingStore } from './instance-messaging.store';
import { InstanceStateService } from './instance-state.service';
import type { Instance, QueuedMessage } from './instance.types';
import { PauseStore } from '../pause/pause.store';
import type { PauseStatePayload } from '@contracts/schemas/pause';
import { DraftService } from '../../services/draft.service';
import { QueuePersistenceService } from './queue-persistence.service';

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
    wakeInstance: vi.fn(),
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
    ipcMock.wakeInstance.mockReset();
    ipcMock.wakeInstance.mockResolvedValue({ success: true });
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

  it('queues and wakes instead of sending into a hibernated session', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'hibernated' }));
    ipcMock.sendInput.mockResolvedValue({ success: true });

    await currentStore.sendInput('inst-1', 'are you there?');

    expect(ipcMock.sendInput).not.toHaveBeenCalled();
    expect(ipcMock.wakeInstance).toHaveBeenCalledWith('inst-1');
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);

    // The wake lands the instance on 'ready', which is what drains the queue.
    currentStateService.updateInstance('inst-1', { status: 'ready' });
    currentStore.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);

    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
  });

  it('delivers a retained-busy ready handoff once and keeps the session busy', async () => {
    const entry: QueuedMessage = { message: 'queued during inline compaction' };
    stateService!.addInstance(createInstance({ status: 'busy', provider: 'codex', adapterGeneration: 1 }));
    stateService!.messageQueue.set(new Map([['inst-1', [entry]]]));
    const persistence = TestBed.inject(QueuePersistenceService);
    const promote = vi.spyOn(persistence, 'promoteReadyHandoff').mockResolvedValue(entry);
    vi.spyOn(persistence, 'getAdmissionId').mockReturnValue('admission');
    ipcMock.sendInput.mockResolvedValue({ success: true });
    await Promise.all([
      store!.processReadyHandoff('inst-1', 'admission', 1),
      store!.processReadyHandoff('inst-1', 'admission', 1),
    ]);
    expect(promote).toHaveBeenCalledTimes(1);
    expect(ipcMock.sendInput).toHaveBeenCalledExactlyOnceWith('inst-1', entry.message, undefined, false, true, 'admission');
    expect(store!.getMessageQueue('inst-1')).toEqual([]);
    expect(stateService!.getInstance('inst-1')?.status).toBe('busy');
  });

  it('keeps the promoted object and admission when Pause wins after queue removal, then sends once on resume', async () => {
    const entry: QueuedMessage = { message: 'pause before send', seededAlready: true, retryAfterAt: Date.now() - 1 };
    stateService!.addInstance(createInstance({ status: 'idle' }));
    const pause = TestBed.inject(PauseStore);
    const persistence = TestBed.inject(QueuePersistenceService);
    const enqueue = vi.spyOn(persistence, 'notifyEnqueued').mockResolvedValue(undefined);
    vi.spyOn(persistence, 'notifyPromoting').mockResolvedValue(true);
    vi.spyOn(persistence, 'getAdmissionId').mockReturnValue('owned-promoted-row');
    pause.applyState({ isPaused: true, reasons: ['user'], pausedAt: Date.now(), lastChange: Date.now() });
    await store!.sendInputImmediate('inst-1', entry.message, undefined, 0, { queuedEntry: entry, skipUserBubble: true, retryAfterAt: entry.retryAfterAt }, true);
    expect(store!.getMessageQueue('inst-1')[0]).toBe(entry);
    expect(entry.retryAfterAt).toBeLessThan(Date.now());
    expect(ipcMock.sendInput).not.toHaveBeenCalled();
    expect(enqueue).toHaveBeenCalledWith('inst-1', entry, 'front');
    pause.applyState({ isPaused: false, reasons: [], pausedAt: null, lastChange: Date.now() });
    ipcMock.sendInput.mockResolvedValue({ success: true });
    store!.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);
    expect(ipcMock.sendInput).toHaveBeenCalledExactlyOnceWith('inst-1', entry.message, undefined, true, true, 'owned-promoted-row');
    expect(store!.getMessageQueue('inst-1')).toEqual([]);
  });

  it('keeps a provider-limit refusal behind backoff and waits for a later main-process ready edge', async () => {
    const entry: QueuedMessage = { message: 'queued through provider limit' };
    stateService!.addInstance(createInstance({ status: 'idle' }));
    stateService!.messageQueue.set(new Map([['inst-1', [entry]]]));
    const persistence = TestBed.inject(QueuePersistenceService);
    vi.spyOn(persistence, 'notifyPromoting').mockResolvedValue(true);
    vi.spyOn(persistence, 'getAdmissionId').mockReturnValueOnce('original-promotion').mockReturnValueOnce('retry-promotion');
    const finish = vi.spyOn(persistence, 'finishSend');
    ipcMock.sendInput.mockResolvedValueOnce({ success: false, error: { message: 'Queued input is waiting for the provider limit to clear' } })
      .mockResolvedValue({ success: true });
    store!.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);
    expect(finish).toHaveBeenCalledWith('inst-1', entry, false);
    const retry = store!.getMessageQueue('inst-1')[0];
    expect(retry).toMatchObject({ message: entry.message, retryCount: 1 });
    expect(retry.retryAfterAt).toBeGreaterThan(Date.now());
    expect(stateService!.getInstance('inst-1')?.status).toBe('busy');
    await vi.advanceTimersByTimeAsync(2_500);
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    stateService!.updateInstance('inst-1', { status: 'idle' });
    store!.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);
    expect(ipcMock.sendInput).toHaveBeenLastCalledWith('inst-1', entry.message, undefined, true, true, 'retry-promotion');
    expect(store!.getMessageQueue('inst-1')).toEqual([]);
  });

  it('retains the queued entry if Stop parks it while handoff promotion is awaiting', async () => {
    const entry: QueuedMessage = { message: 'park during promotion' };
    stateService!.addInstance(createInstance({ status: 'busy', provider: 'codex', adapterGeneration: 1 }));
    stateService!.messageQueue.set(new Map([['inst-1', [entry]]]));
    vi.spyOn(TestBed.inject(QueuePersistenceService), 'promoteReadyHandoff').mockImplementation(async () => {
      store!.parkQueueAfterInterrupt('inst-1');
      return entry;
    });
    await store!.processReadyHandoff('inst-1', 'admission', 1);
    expect(ipcMock.sendInput).not.toHaveBeenCalled();
    expect(store!.getMessageQueue('inst-1')).toEqual([entry]);
  });

  it('preserves a rejected ready handoff with backoff instead of retrying on every busy update', async () => {
    const entry: QueuedMessage = { message: 'preserve rejected handoff' };
    stateService!.addInstance(createInstance({ status: 'busy', provider: 'codex', adapterGeneration: 1 }));
    stateService!.messageQueue.set(new Map([['inst-1', [entry]]]));
    vi.spyOn(TestBed.inject(QueuePersistenceService), 'promoteReadyHandoff').mockResolvedValue(entry);
    ipcMock.sendInput.mockResolvedValue({ success: false, error: { message: 'Cannot send while compacting' } });
    await store!.processReadyHandoff('inst-1', 'admission', 1);
    expect(store!.getMessageQueue('inst-1')[0]).toMatchObject({ message: entry.message, retryCount: 1 });
    for (let index = 0; index < 10; index++) store!.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(250);
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
  });

  it('restores the text to the draft when waking a hibernated session fails', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'hibernated' }));
    ipcMock.wakeInstance.mockResolvedValue({
      success: false,
      error: { message: 'wake spawn failed' },
    });

    await currentStore.sendInput('inst-1', 'do not strand me');

    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
    expect(TestBed.inject(DraftService).getDraft('inst-1')).toBe('do not strand me');
    const instance = currentStateService.getInstance('inst-1');
    expect(instance?.outputBuffer[instance.outputBuffer.length - 1]).toMatchObject({
      type: 'error',
      content: expect.stringContaining('Failed to wake this session'),
    });
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
      content: "Your message wasn't sent.",
      metadata: { detail: 'Instance inst-1 is in error state and cannot accept input' },
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
    expect(currentStore.getMessageQueue('inst-1')).toEqual([
      { message: 'retry me', files: undefined, retryCount: 1, retryAfterAt: expect.any(Number) },
    ]);

    currentStateService.updateInstance('inst-1', { status: 'idle' });
    currentStore.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);

    expect(ipcMock.sendInput).toHaveBeenCalledTimes(2);
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
  });

  it('parks an active-turn collision until a genuine ready edge without timed retries', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ provider: 'codex' }));
    ipcMock.sendInput.mockResolvedValue({
      success: false,
      error: { message: 'Codex app-server runtime already has an active turn' },
    });

    await currentStore.sendInput('inst-1', 'continue');
    await vi.advanceTimersByTimeAsync(5000);

    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    expect(currentStateService.getInstance('inst-1')?.status).toBe('busy');
    expect(currentStore.getMessageQueue('inst-1')).toEqual([
      { message: 'continue', files: undefined, retryCount: 1, retryAfterAt: expect.any(Number) },
    ]);
  });

  it('parks an ACP active-turn collision without retrying or clearing busy', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ provider: 'cursor' }));
    ipcMock.sendInput.mockResolvedValue({
      success: false,
      error: {
        message: 'Cannot send message: the previous turn is still running. Wait for it to finish, or cancel/interrupt the current turn first.',
      },
    });

    await currentStore.sendInput('inst-1', 'continue');
    await vi.advanceTimersByTimeAsync(5000);

    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    expect(currentStateService.getInstance('inst-1')?.status).toBe('busy');
    expect(currentStore.getMessageQueue('inst-1')).toEqual([
      { message: 'continue', files: undefined, retryCount: 1, retryAfterAt: expect.any(Number) },
    ]);
  });

  // LT-652 — session xecsi91o3: 6 sends in 622 ms against one Compact turn, then dropped.
  it('LT-652: holds a Compact-turn rejection with backoff instead of a sub-second retry storm', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ provider: 'codex' }));
    ipcMock.sendInput.mockResolvedValue({
      success: false,
      error: {
        message: 'Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
      },
    });

    await currentStore.sendInput('inst-1', 'I never requested you to stop?!');
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);

    // The instance stays idle through a provider compaction, so the ready-status
    // drain in instance.store.ts keeps calling processMessageQueue — the exact
    // shape of the xecsi91o3 storm. None of these may re-send early.
    for (let i = 0; i < 5; i++) {
      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(120);
    }
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);
    expect(currentStore.getMessageQueue('inst-1')[0]).toMatchObject({
      message: 'I never requested you to stop?!',
      retryCount: 1,
      retryAfterAt: expect.any(Number),
    });

    // Past the old 5 × 2 s budget the message must still be alive (the compact
    // ran ~57 s in the incident), and the first backoffed retry is due at 15 s.
    await vi.advanceTimersByTimeAsync(14_000);
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    await vi.advanceTimersByTimeAsync(1_500);
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(2);
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);

    const instance = currentStateService.getInstance('inst-1');
    expect(
      instance?.outputBuffer.some((m) => m.content?.includes('after 5 retries') === true),
    ).toBe(false);
  });

  it('LT-652: delivers a held Compact-turn message once the provider stops rejecting', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ provider: 'codex' }));
    ipcMock.sendInput
      .mockResolvedValueOnce({
        success: false,
        error: {
          message: 'Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
        },
      })
      .mockResolvedValue({ success: true });

    await currentStore.sendInput('inst-1', 'after the compact');
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);

    await vi.advanceTimersByTimeAsync(16_000);
    await vi.advanceTimersByTimeAsync(200);

    expect(ipcMock.sendInput).toHaveBeenCalledTimes(2);
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
    expect(currentStateService.getInstance('inst-1')?.status).toBe('busy');
  });

  // Gate finding 2: the backoff gate must coalesce drains, not fan them out.
  it('LT-652: many drain attempts during a hold produce exactly one send at expiry', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ provider: 'codex' }));
    ipcMock.sendInput
      .mockResolvedValueOnce({
        success: false,
        error: {
          message: 'Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
        },
      })
      .mockResolvedValue({ success: true });

    await currentStore.sendInput('inst-1', 'hold me');
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);

    // Watchdog + ready-status edges all try to drain while the gate is shut.
    for (let i = 0; i < 10; i++) {
      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(200);
    }
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);

    // At expiry the 10 scheduled drains must collapse to ONE send.
    await vi.advanceTimersByTimeAsync(15_000);
    await vi.advanceTimersByTimeAsync(300);
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(2);
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
  });

  // Gate finding 3: losing a race to Pause must keep the backoff gate.
  it('LT-652: a paused re-queue keeps its retryAfterAt gate', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ provider: 'codex' }));
    ipcMock.sendInput.mockResolvedValue({
      success: false,
      error: {
        message: 'Codex error: failed to submit turn input: ActiveTurnNotSteerable { turn_kind: Compact }',
      },
    });

    await currentStore.sendInput('inst-1', 'gate me');
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);

    // Drain passes the gate, then Pause wins the race and re-queues.
    const pausedState: PauseStatePayload = {
      isPaused: true,
      reasons: ['user'],
      pausedAt: Date.now(),
      lastChange: Date.now(),
    };
    TestBed.inject(PauseStore).applyState(pausedState);
    await vi.advanceTimersByTimeAsync(16_000);
    await vi.advanceTimersByTimeAsync(200);

    const entry = currentStore.getMessageQueue('inst-1')[0];
    expect(entry).toMatchObject({ message: 'gate me', retryAfterAt: expect.any(Number) });
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
      content: "Your message didn't reach the session within 60s. Check the session is running, then send it again.",
      metadata: { detail: expect.stringContaining('Send input timed out after 60s.') },
    });
  });

  it.each(['cursor', 'copilot', 'grok'] as const)(
    'does not abandon a long-running %s ACP turn while the backend still owns it',
    async (provider) => {
      const currentStore = store!;
      const currentStateService = stateService!;
      currentStateService.addInstance(createInstance({ provider, status: 'idle' }));
      ipcMock.sendInput.mockImplementation(() => new Promise(() => undefined));

      void currentStore.sendInput('inst-1', `long ${provider} turn`);

      await vi.advanceTimersByTimeAsync(60 * 60_000 + 100);

      const instance = currentStateService.getInstance('inst-1');
      expect(instance?.status).toBe('busy');
      expect(instance?.outputBuffer).toEqual([]);
    },
  );

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

    expect(ipcMock.sendInput).toHaveBeenCalledWith('inst-1', 'Seeded prompt', undefined, true, true);
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

    expect(ipcMock.sendInput).toHaveBeenCalledWith('inst-1', 'continue here', undefined, false, true);
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

  describe('marking words a person typed (Plan Queue "Land anyway")', () => {
    const person = { kind: 'person', typedAt: expect.any(Number) };

    it('sends a typed message with the person origin, and an app-built message without it', async () => {
      const currentStore = store!;
      stateService!.addInstance(createInstance({ status: 'idle' }));
      ipcMock.sendInput.mockResolvedValue({ success: true });

      await currentStore.sendInput('inst-1', 'land it anyway', undefined, { typedByPerson: true });
      stateService!.updateInstance('inst-1', { status: 'idle' });
      await currentStore.sendInput('inst-1', 'Cross-model review flagged concerns');

      expect(ipcMock.sendInput).toHaveBeenNthCalledWith(1, 'inst-1', 'land it anyway', undefined, false, false, undefined, person);
      expect(ipcMock.sendInput).toHaveBeenNthCalledWith(2, 'inst-1', 'Cross-model review flagged concerns', undefined, false);
    });

    it('records the time the person typed, not the time the queued message is sent', async () => {
      const currentStore = store!;
      stateService!.addInstance(createInstance({ status: 'busy' }));
      ipcMock.sendInput.mockResolvedValue({ success: true });
      const typedAt = Date.now();

      await currentStore.sendInput('inst-1', 'typed while busy', undefined, { typedByPerson: true });
      await vi.advanceTimersByTimeAsync(60_000);
      stateService!.updateInstance('inst-1', { status: 'idle' });
      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(150);

      const origin = ipcMock.sendInput.mock.calls[0][6] as { kind: string; typedAt: number };
      expect(origin).toEqual({ kind: 'person', typedAt });
    });

    it('keeps the mark on a message typed while the session was busy and sent later, as a drained queue entry', async () => {
      const currentStore = store!;
      stateService!.addInstance(createInstance({ status: 'busy' }));
      ipcMock.sendInput.mockResolvedValue({ success: true });

      await currentStore.sendInput('inst-1', 'typed while busy', undefined, { typedByPerson: true });
      expect(currentStore.getMessageQueue('inst-1')[0].origin).toEqual(person);
      expect(ipcMock.sendInput).not.toHaveBeenCalled();

      stateService!.updateInstance('inst-1', { status: 'idle' });
      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(150);

      // A drained entry still goes out as automated input (it is not a fresh submission), now with the mark.
      expect(ipcMock.sendInput).toHaveBeenCalledWith('inst-1', 'typed while busy', undefined, false, true, undefined, person);
    });

    it('does not mark a queued app-built message, and a re-queued retry keeps its mark', async () => {
      const currentStore = store!;
      stateService!.addInstance(createInstance({ status: 'busy' }));
      await currentStore.sendInput('inst-1', 'review packet');
      expect(currentStore.getMessageQueue('inst-1')[0].origin).toBeUndefined();
      currentStore.clearMessageQueue('inst-1');

      ipcMock.sendInput.mockResolvedValueOnce({ success: false, error: { message: 'Instance is busy' } });
      ipcMock.sendInput.mockResolvedValue({ success: true });
      await currentStore.sendInput('inst-1', 'typed', undefined, { typedByPerson: true });
      stateService!.updateInstance('inst-1', { status: 'idle' });
      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(150);

      const requeued = currentStore.getMessageQueue('inst-1')[0];
      expect(requeued?.origin).toEqual(person);
    });

    it('carries the mark across a wake of a hibernated session and a restart of a terminated one', async () => {
      const currentStore = store!;
      stateService!.addInstance(createInstance({ status: 'hibernated' }));
      await currentStore.sendInput('inst-1', 'wake and land', undefined, { typedByPerson: true });
      expect(currentStore.getMessageQueue('inst-1')[0].origin).toEqual(person);
      currentStore.clearMessageQueue('inst-1');

      stateService!.updateInstance('inst-1', { status: 'terminated' });
      await currentStore.sendInput('inst-1', 'restart and land', undefined, { typedByPerson: true });
      expect(currentStore.getMessageQueue('inst-1')[0].origin).toEqual(person);
    });

    it('drops the mark when a queued message is promoted to a steer, and never marks a steer', async () => {
      const currentStore = store!;
      stateService!.addInstance(createInstance({ status: 'busy' }));
      await currentStore.sendInput('inst-1', 'typed while busy', undefined, { typedByPerson: true });

      await currentStore.steerQueuedMessage('inst-1', 0);
      expect(currentStore.getMessageQueue('inst-1')[0]).toMatchObject({ kind: 'steer' });
      expect(currentStore.getMessageQueue('inst-1')[0].origin).toBeUndefined();

    });

    it('never marks a steer sent to a running turn', async () => {
      const currentStore = store!;
      stateService!.addInstance(createInstance({ status: 'busy' }));
      await currentStore.steerInput('inst-1', 'redirect now');
      expect(ipcMock.steerInput).toHaveBeenCalledExactlyOnceWith('inst-1', 'redirect now', undefined);
    });
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

  describe('B7 — Stop parks the queue instead of draining it', () => {
    beforeEach(() => {
      // These tests deliberately let a send through, unlike the quota-park
      // block above which only ever asserts that nothing was sent. Without a
      // resolved response the drain path rejects on `response.success`.
      ipcMock.sendInput.mockResolvedValue({ success: true });
    });

    function parkedWithOneQueued() {
      const currentStore = store!;
      const currentStateService = stateService!;
      currentStateService.addInstance(createInstance({ status: 'idle' }));
      currentStateService.messageQueue.set(
        new Map([['inst-1', [{ message: 'queued before Stop' }]]]),
      );
      currentStore.parkQueueAfterInterrupt('inst-1');
      return currentStore;
    }

    it('holds the queue across the 2-second watchdog', async () => {
      const currentStore = parkedWithOneQueued();
      await vi.advanceTimersByTimeAsync(2100);
      expect(ipcMock.sendInput).not.toHaveBeenCalled();
      expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);
    });

    it('holds the queue against a direct drain on the next ready transition', async () => {
      const currentStore = parkedWithOneQueued();
      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(150);
      expect(ipcMock.sendInput).not.toHaveBeenCalled();
      expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);
    });

    it('sends once the user resumes', async () => {
      const currentStore = parkedWithOneQueued();
      currentStore.resumeParkedQueue('inst-1');
      await vi.advanceTimersByTimeAsync(150);
      expect(ipcMock.sendInput).toHaveBeenCalled();
    });

    it('does not park when Stop is pressed with an empty queue', async () => {
      const currentStore = store!;
      const currentStateService = stateService!;
      currentStateService.addInstance(createInstance({ status: 'idle' }));
      currentStore.parkQueueAfterInterrupt('inst-1');
      expect(currentStore.isQueueParked('inst-1')).toBe(false);

      // A message queued afterwards must still send: the user never asked to
      // hold this one.
      currentStateService.messageQueue.set(new Map([['inst-1', [{ message: 'later' }]]]));
      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(150);
      expect(ipcMock.sendInput).toHaveBeenCalled();
    });

    /**
     * The stale-flag scenario, driven through the REAL cancel path.
     *
     * An earlier version of this test emptied the queue by hand and then called
     * `processMessageQueue` itself — a call no UI action makes — so it proved
     * only that the self-heal function works, not that anything reaches it. The
     * production path is `onCancelQueuedMessage` -> `cancelQueuedMessage` ->
     * `removeFromQueue`, which touches no drain trigger at all: the flag
     * survived the emptied queue and then blocked the next, unrelated message
     * for that instance permanently.
     */
    it('does not strand a later message after every parked one is cancelled', async () => {
      const currentStore = store!;
      const currentStateService = stateService!;
      currentStateService.addInstance(createInstance({ status: 'idle' }));
      currentStateService.messageQueue.set(
        new Map([['inst-1', [{ message: 'first' }, { message: 'second' }]]]),
      );
      currentStore.parkQueueAfterInterrupt('inst-1');
      expect(currentStore.isQueueParked('inst-1')).toBe(true);

      // Cancel each parked message the way the composer does.
      currentStore.cancelQueuedMessage('inst-1', 1);
      expect(currentStore.isQueueParked('inst-1')).toBe(true);
      currentStore.cancelQueuedMessage('inst-1', 0);
      expect(currentStore.isQueueParked('inst-1')).toBe(false);

      // A completely unrelated later message must send normally.
      currentStateService.messageQueue.set(new Map([['inst-1', [{ message: 'brand new' }]]]));
      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(150);
      expect(ipcMock.sendInput).toHaveBeenCalled();
    });

    it('keeps the park while cancelling only some of the queue', async () => {
      const currentStore = store!;
      const currentStateService = stateService!;
      currentStateService.addInstance(createInstance({ status: 'idle' }));
      currentStateService.messageQueue.set(
        new Map([['inst-1', [{ message: 'first' }, { message: 'second' }]]]),
      );
      currentStore.parkQueueAfterInterrupt('inst-1');

      currentStore.cancelQueuedMessage('inst-1', 0);
      currentStore.processMessageQueue('inst-1');
      await vi.advanceTimersByTimeAsync(150);
      expect(ipcMock.sendInput).not.toHaveBeenCalled();
      expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);
    });

    it('clearing the queue releases the park', () => {
      const currentStore = parkedWithOneQueued();
      currentStore.clearMessageQueue('inst-1');
      expect(currentStore.isQueueParked('inst-1')).toBe(false);
    });

    it('parks only the stopped instance', () => {
      const currentStore = parkedWithOneQueued();
      expect(currentStore.isQueueParked('inst-2')).toBe(false);
    });
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

describe('InstanceMessagingStore — durable queue wiring (WS-A1 Phase B)', () => {
  let store: InstanceMessagingStore | undefined;
  let stateService: InstanceStateService | undefined;

  const ipcMock = {
    sendInput: vi.fn(),
    steerInput: vi.fn(),
    wakeInstance: vi.fn(),
    listInstances: vi.fn(),
  };

  const listStoreMock = {
    validateFiles: vi.fn(() => []),
    fileToAttachments: vi.fn(),
    interruptInstance: vi.fn(),
    restartInstance: vi.fn(),
  };

  const queuePersistenceMock = {
    notifyEnqueued: vi.fn(),
    notifyCancelled: vi.fn(),
    notifyPromoting: vi.fn().mockResolvedValue(true),
    rebindEntry: vi.fn(),
    getAdmissionId: vi.fn(() => undefined as string | undefined),
    finishSend: vi.fn(),
  };

  beforeEach(() => {
    vi.useFakeTimers();
    ipcMock.sendInput.mockReset();
    ipcMock.sendInput.mockResolvedValue({ success: true });
    ipcMock.steerInput.mockReset();
    ipcMock.steerInput.mockResolvedValue({ success: true });
    ipcMock.wakeInstance.mockReset();
    ipcMock.listInstances.mockReset();
    ipcMock.listInstances.mockResolvedValue({ success: true, data: [] });
    listStoreMock.validateFiles.mockReset();
    listStoreMock.validateFiles.mockReturnValue([]);
    listStoreMock.interruptInstance.mockReset();
    listStoreMock.interruptInstance.mockResolvedValue(true);
    listStoreMock.restartInstance.mockReset();
    queuePersistenceMock.notifyEnqueued.mockReset();
    queuePersistenceMock.notifyCancelled.mockReset();
    queuePersistenceMock.notifyPromoting.mockReset();
    queuePersistenceMock.notifyPromoting.mockResolvedValue(true);
    queuePersistenceMock.rebindEntry.mockReset();
    queuePersistenceMock.getAdmissionId.mockReset();
    queuePersistenceMock.finishSend.mockReset();

    TestBed.resetTestingModule();
    TestBed.configureTestingModule({
      providers: [
        InstanceMessagingStore,
        InstanceStateService,
        { provide: IpcFacadeService, useValue: ipcMock },
        { provide: InstanceListStore, useValue: listStoreMock },
        { provide: QueuePersistenceService, useValue: queuePersistenceMock },
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

  it('notifies the durable queue on enqueue while busy', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));

    await currentStore.sendInput('inst-1', 'queued while busy');

    expect(queuePersistenceMock.notifyEnqueued).toHaveBeenCalledWith(
      'inst-1',
      expect.objectContaining({ message: 'queued while busy' }),
      'back',
    );
  });

  it('promotes the exact drained QueuedMessage object before the send IPC call, and cancels nothing', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));

    await currentStore.sendInput('inst-1', 'drain me');
    const queuedEntry = currentStore.getMessageQueue('inst-1')[0];

    currentStateService.updateInstance('inst-1', { status: 'idle' });
    currentStore.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);

    expect(queuePersistenceMock.notifyPromoting).toHaveBeenCalledWith('inst-1', queuedEntry);
    expect(ipcMock.sendInput).toHaveBeenCalledTimes(1);
    // notifyPromoting must resolve BEFORE the send IPC fires.
    const promoteOrder = queuePersistenceMock.notifyPromoting.mock.invocationCallOrder[0];
    const sendOrder = ipcMock.sendInput.mock.invocationCallOrder[0];
    expect(promoteOrder).toBeLessThan(sendOrder);
    expect(queuePersistenceMock.notifyCancelled).not.toHaveBeenCalled();
  });

  it('passes the original admission identity once despite concurrent drain timers', async () => {
    stateService!.addInstance(createInstance({ status: 'idle' }));
    const entry: QueuedMessage = { message: 'send original once' };
    stateService!.messageQueue.set(new Map([['inst-1', [entry]]]));
    queuePersistenceMock.getAdmissionId.mockReturnValueOnce('original-admission');
    store!.processMessageQueue('inst-1'); store!.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);
    expect(ipcMock.sendInput).toHaveBeenCalledExactlyOnceWith('inst-1', entry.message, undefined, false, true, 'original-admission');
    expect(queuePersistenceMock.finishSend).toHaveBeenCalledExactlyOnceWith('inst-1', entry, true);
  });

  it('a failed durable promote leaves the message visibly queued instead of sending anyway (Finding 2)', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));
    queuePersistenceMock.notifyPromoting.mockResolvedValue(false);

    await currentStore.sendInput('inst-1', 'drain me');
    currentStateService.updateInstance('inst-1', { status: 'idle' });
    currentStore.processMessageQueue('inst-1');
    await vi.advanceTimersByTimeAsync(150);

    expect(queuePersistenceMock.notifyPromoting).toHaveBeenCalled();
    expect(ipcMock.sendInput).not.toHaveBeenCalled();
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(1);
    expect(currentStore.getMessageQueue('inst-1')[0]).toMatchObject({ message: 'drain me' });
  });

  it('cancelQueuedMessage removes the entry AND notifies the durable cancel', () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));
    const entry: QueuedMessage = { message: 'to cancel' };
    currentStateService.messageQueue.set(new Map([['inst-1', [entry]]]));

    const removed = currentStore.cancelQueuedMessage('inst-1', 0);

    expect(removed).toBe(entry);
    expect(currentStore.getQueuedMessageCount('inst-1')).toBe(0);
    expect(queuePersistenceMock.notifyCancelled).toHaveBeenCalledWith('inst-1', entry);
  });

  it('removeFromQueue (steer path) does NOT notify a cancel — steerQueuedMessage rebinds instead', async () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));
    const entry: QueuedMessage = { message: 'to steer' };
    currentStateService.messageQueue.set(new Map([['inst-1', [entry]]]));

    await currentStore.steerQueuedMessage('inst-1', 0);

    expect(queuePersistenceMock.notifyCancelled).not.toHaveBeenCalled();
    expect(queuePersistenceMock.rebindEntry).toHaveBeenCalledWith(entry, expect.objectContaining({ message: 'to steer', kind: 'steer' }));
  });

  it('clearMessageQueue notifies a durable cancel for every remaining entry', () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'busy' }));
    currentStateService.messageQueue.set(
      new Map([['inst-1', [{ message: 'm1' }, { message: 'm2' }]]]),
    );

    currentStore.clearMessageQueue('inst-1');

    expect(queuePersistenceMock.notifyCancelled).toHaveBeenCalledWith(
      'inst-1',
      [{ message: 'm1' }, { message: 'm2' }],
    );
  });

  it('clearMessageQueue on an already-empty queue does not call notifyCancelled', () => {
    const currentStore = store!;
    const currentStateService = stateService!;
    currentStateService.addInstance(createInstance({ status: 'idle' }));

    currentStore.clearMessageQueue('inst-1');

    expect(queuePersistenceMock.notifyCancelled).not.toHaveBeenCalled();
  });
});
