import { TestBed } from '@angular/core/testing';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService } from '../../renderer/app/core/services/ipc';
import { StatsIpcService } from '../../renderer/app/core/services/ipc/stats-ipc.service';
import { UpdateBatcherService, type StateUpdate } from '../../renderer/app/core/services/update-batcher.service';
import { ToastService } from '../../renderer/app/core/services/toast.service';
import { ProviderStateService } from '../../renderer/app/core/services/provider-state.service';
import { AutomationStore } from '../../renderer/app/core/state/automation.store';
import { InstanceStore } from '../../renderer/app/core/state/instance/instance.store';
import { InstanceStateService } from '../../renderer/app/core/state/instance/instance-state.service';
import { InstanceListStore } from '../../renderer/app/core/state/instance/instance-list.store';
import { InstanceSelectionStore } from '../../renderer/app/core/state/instance/instance-selection.store';
import { InstanceOutputStore } from '../../renderer/app/core/state/instance/instance-output.store';
import { InstanceMessagingStore } from '../../renderer/app/core/state/instance/instance-messaging.store';
import type { Instance } from '../../renderer/app/core/state/instance/instance.types';
import { InstanceStateManager } from '../../main/instance/instance-state';
import type { Instance as MainInstance } from '../../shared/types/instance.types';
import { InstanceBatchUpdateEventPayloadSchema } from '@contracts/schemas/instance';

// Keep the real IpcEventBusService and UpdateBatcherService: these packets enter
// through the registered IPC callbacks, never through private store methods.
describe('InstanceStore turn settlement over the real event bus', () => {
  let single: (update: StateUpdate) => void;
  let batch: (payload: { updates: StateUpdate[] }) => void;
  let state: InstanceStateService;
  let batcher: UpdateBatcherService;

  beforeEach(() => {
    const noop = () => () => undefined;
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceIpcService, useValue: {
        onInstanceStateUpdate: (next: typeof single) => { single = next; return () => undefined; },
        onBatchUpdate: (next: typeof batch) => { batch = next; return () => undefined; },
        onInstanceCreated: noop, onInstanceRemoved: noop, onInstanceTranscriptChunk: noop,
        onFastToggled: noop, onYoloToggled: noop, onOrchestrationActivity: noop,
        onCompactStatus: noop, onInputRequired: noop, onInputRequiredResolved: noop, onInputContextDelivered: noop,
      } },
      { provide: StatsIpcService, useValue: { statsRecordSessionEnd: vi.fn().mockResolvedValue(undefined) } },
      { provide: ToastService, useValue: {} },
      { provide: ProviderStateService, useValue: {} },
      { provide: AutomationStore, useValue: {} },
      { provide: InstanceListStore, useValue: { loadInitialInstances: vi.fn() } },
      { provide: InstanceSelectionStore, useValue: {} },
      { provide: InstanceOutputStore, useValue: { flushInstanceOutput: vi.fn(), cleanupAll: vi.fn() } },
      { provide: InstanceMessagingStore, useValue: { processMessageQueue: vi.fn(), clearQueueWithNotification: vi.fn() } },
    ] });
    TestBed.inject(InstanceStore);
    state = TestBed.inject(InstanceStateService);
    batcher = TestBed.inject(UpdateBatcherService);
    state.addInstance({ id: 'session', status: 'busy', activeTurnId: 'turn-current',
      restartEpoch: 3, adapterGeneration: 4, pendingApprovalCount: 2 } as Instance);
  });

  afterEach(() => TestBed.resetTestingModule());

  it('does not resurrect a turn when direct busy and settled packets share the renderer batching window', () => {
    single({ instanceId: 'session', status: 'busy', activeTurnId: 'turn-current' });
    single({ instanceId: 'session', status: 'idle' });
    batcher.forceFlush();
    expect(state.getInstance('session')?.activeTurnId).toBeUndefined();
  });

  it('does not resurrect a turn when a batch contains both busy and settled updates', () => {
    batch({ updates: [
      { instanceId: 'session', status: 'busy', activeTurnId: 'turn-current' },
      { instanceId: 'session', status: 'idle' },
    ] });
    batcher.forceFlush();
    expect(state.getInstance('session')?.activeTurnId).toBeUndefined();
  });

  it('settles an actual main queueUpdate packet after serialization and schema validation', () => {
    const main = new InstanceStateManager();
    const instance = { id: 'session', status: 'busy', activeTurnId: 'turn-current' } as MainInstance;
    main.setInstance(instance);
    main.on('batch-update', (payload) => {
      // Remote/JSON transports drop undefined. The event schema is passthrough,
      // so explicit turn fields survive it; no new null protocol is needed.
      batch(InstanceBatchUpdateEventPayloadSchema.parse(JSON.parse(JSON.stringify(payload))));
    });
    main.queueUpdate('session', 'busy', undefined, undefined, undefined, undefined, undefined,
      { activeTurnId: instance.activeTurnId });
    instance.status = 'idle';
    instance.activeTurnId = undefined; // markTurnInactiveIfSettled's live write
    main.queueUpdate('session', 'idle');
    main.destroy(); // flush the real coalesced main packet
    batcher.forceFlush();
    expect(state.getInstance('session')?.activeTurnId).toBeUndefined();
  });

  for (const path of ['single', 'batch'] as const) {
    const send = (update: Omit<StateUpdate, 'instanceId'>) => {
      const packet = { instanceId: 'session', ...update };
      if (path === 'single') single(packet);
      else batch({ updates: [packet] });
      batcher.forceFlush();
    };

    it.each(['idle', 'ready', 'error', 'failed', 'terminated', 'cancelled', 'superseded'])(`${path}: releases a settled %s turn without a clearing property`, (status) => {
      send({ status, lastTurnOutcome: status === 'idle' ? 'completed' : 'interrupted' });
      expect(state.getInstance('session')?.activeTurnId).toBeUndefined();
    });

    it(`${path}: releases an interrupted turn after the stop acknowledgement`, () => {
      send({ status: 'interrupting' });
      expect(state.getInstance('session')?.activeTurnId).toBe('turn-current');
      send({ status: 'idle', interruptPhase: 'completed', lastTurnOutcome: 'interrupted' });
      expect(state.getInstance('session')?.activeTurnId).toBeUndefined();
    });

    it(`${path}: preserves a live permission and an explicitly active question`, () => {
      send({ status: 'waiting_for_permission' });
      expect(state.getInstance('session')?.activeTurnId).toBe('turn-current');
      send({ status: 'waiting_for_input', activeTurnId: 'question-turn' });
      expect(state.getInstance('session')?.activeTurnId).toBe('question-turn');
      expect(state.getInstance('session')?.pendingApprovalCount).toBe(2);
    });

    it(`${path}: follows main's status-only waiting_for_input settlement`, () => {
      send({ status: 'waiting_for_input' });
      expect(state.getInstance('session')?.activeTurnId).toBeUndefined();
      expect(state.getInstance('session')?.pendingApprovalCount).toBe(2);
    });

    it(`${path}: a non-status update keeps the active turn`, () => {
      send({ currentModel: 'model-next' });
      expect(state.getInstance('session')?.activeTurnId).toBe('turn-current');
    });

    it(`${path}: an explicit newer active turn wins over a settled status`, () => {
      send({ status: 'idle', activeTurnId: 'turn-next', adapterGeneration: 5 });
      expect(state.getInstance('session')?.activeTurnId).toBe('turn-next');
    });

    it.each([{ restartEpoch: 2 }, { restartEpoch: 3, adapterGeneration: 3 }])(`${path}: an older lifecycle packet cannot clear a newer active turn (%j)`, (identity) => {
      send({ status: 'idle', ...identity });
      expect(state.getInstance('session')?.activeTurnId).toBe('turn-current');
    });
  }
});
