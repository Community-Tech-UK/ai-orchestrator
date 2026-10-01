import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService, IpcEventBusService } from '../../services/ipc';
import { StatsIpcService } from '../../services/ipc/stats-ipc.service';
import { UpdateBatcherService, type StateUpdate } from '../../services/update-batcher.service';
import { ToastService } from '../../services/toast.service';
import { ProviderStateService } from '../../services/provider-state.service';
import { AutomationStore } from '../automation.store';
import { isHiddenAutomationInstance } from '../../../features/instance-list/history-rail-filtering';
import { InstanceStore } from './instance.store';
import { InstanceStateService } from './instance-state.service';
import { InstanceListStore } from './instance-list.store';
import { InstanceSelectionStore } from './instance-selection.store';
import { InstanceOutputStore } from './instance-output.store';
import { InstanceMessagingStore } from './instance-messaging.store';
import type { Instance } from './instance.types';

/**
 * Store-level wiring for the sticky `automationRevealed` stamp. Without it, a
 * failed hidden automation session vanished from the project rail as soon as
 * the operator restarted it to carry on.
 */
describe('InstanceStore automationRevealed wiring', () => {
  let eventBus: {
    instanceStateUpdate$: Subject<StateUpdate>;
    batchUpdate$: Subject<{ updates: StateUpdate[] }>;
  };
  let stateService: InstanceStateService;
  let batcher: UpdateBatcherService;

  beforeEach(() => {
    const streams = [
      'batchUpdate$', 'compactStatus$', 'fastToggled$', 'inputRequired$',
      'inputRequiredResolved$', 'instanceCreated$', 'instanceOutput$',
      'instanceRemoved$', 'instanceStateUpdate$', 'orchestrationActivity$', 'yoloToggled$',
    ];
    // Every stream the store subscribes to; only the two update streams are driven.
    eventBus = Object.fromEntries(
      streams.map((name) => [name, new Subject<unknown>()]),
    ) as unknown as typeof eventBus;

    TestBed.configureTestingModule({
      providers: [
        { provide: IpcEventBusService, useValue: eventBus },
        { provide: InstanceIpcService, useValue: {} },
        { provide: StatsIpcService, useValue: { statsRecordSessionEnd: vi.fn().mockResolvedValue(undefined) } },
        { provide: ToastService, useValue: {} },
        { provide: ProviderStateService, useValue: {} },
        { provide: AutomationStore, useValue: {} },
        { provide: InstanceListStore, useValue: { loadInitialInstances: vi.fn() } },
        { provide: InstanceSelectionStore, useValue: {} },
        { provide: InstanceOutputStore, useValue: { flushInstanceOutput: vi.fn(), cleanupAll: vi.fn() } },
        {
          provide: InstanceMessagingStore,
          useValue: { processMessageQueue: vi.fn(), clearQueueWithNotification: vi.fn() },
        },
      ],
    });

    TestBed.inject(InstanceStore);
    stateService = TestBed.inject(InstanceStateService);
    batcher = TestBed.inject(UpdateBatcherService);

    stateService.state.update((current) => ({
      ...current,
      instances: new Map([[
        'hidden-1',
        {
          id: 'hidden-1',
          status: 'busy',
          metadata: { automationId: 'automation-1', automationHidden: true },
        } as unknown as Instance,
      ]]),
    }));
  });

  afterEach(() => TestBed.resetTestingModule());

  function railHides(): boolean {
    return isHiddenAutomationInstance(stateService.getInstance('hidden-1')!, false);
  }

  it('keeps a failed hidden run visible after the operator restarts it', () => {
    expect(railHides()).toBe(true);

    // Direct (unbatched) path: error updates bypass the batcher.
    eventBus.instanceStateUpdate$.next({ instanceId: 'hidden-1', status: 'error', automationRevealed: true });
    expect(stateService.getInstance('hidden-1')?.metadata?.['automationRevealed']).toBe(true);

    // "Try again": the restart settles to busy through the batched path.
    eventBus.batchUpdate$.next({ updates: [{ instanceId: 'hidden-1', status: 'busy' }] });
    batcher.forceFlush();

    expect(stateService.getInstance('hidden-1')?.status).toBe('busy');
    expect(railHides()).toBe(false);
  });

  it('applies the stamp arriving on a batched idle update (provider-limit reclassification)', () => {
    eventBus.batchUpdate$.next({
      updates: [{ instanceId: 'hidden-1', status: 'idle', automationRevealed: true }],
    });
    batcher.forceFlush();

    expect(stateService.getInstance('hidden-1')?.status).toBe('idle');
    expect(railHides()).toBe(false);
  });

  it('still hides a healthy hidden run', () => {
    eventBus.batchUpdate$.next({ updates: [{ instanceId: 'hidden-1', status: 'idle' }] });
    batcher.forceFlush();

    expect(railHides()).toBe(true);
  });
});
