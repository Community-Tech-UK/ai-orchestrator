import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService, IpcEventBusService } from '../../services/ipc';
import { StatsIpcService } from '../../services/ipc/stats-ipc.service';
import { UpdateBatcherService, type StateUpdate } from '../../services/update-batcher.service';
import { ToastService } from '../../services/toast.service';
import { ProviderStateService } from '../../services/provider-state.service';
import { AutomationStore } from '../automation.store';
import { InstanceStore } from './instance.store';
import { InstanceStateService } from './instance-state.service';
import { InstanceListStore } from './instance-list.store';
import { InstanceSelectionStore } from './instance-selection.store';
import { InstanceOutputStore } from './instance-output.store';
import { InstanceMessagingStore } from './instance-messaging.store';
import type { Instance } from './instance.types';

/**
 * A parentless session adopted after creation (a Plan Queue worker whose
 * parent session was restored under a new id) must move under its parent in
 * the rail. The renderer learns the parent only from state updates.
 */
describe('InstanceStore parent adoption wiring', () => {
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
      'instanceRemoved$', 'instanceStateUpdate$', 'instanceTranscriptChunk$', 'orchestrationActivity$', 'yoloToggled$',
    ];
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
        'worker-1',
        { id: 'worker-1', status: 'busy', parentId: null } as unknown as Instance,
      ]]),
    }));
  });

  afterEach(() => TestBed.resetTestingModule());

  it('applies an adopted parent from a batched update and keeps it on later updates', () => {
    eventBus.batchUpdate$.next({ updates: [{ instanceId: 'worker-1', status: 'busy', parentId: 'parent-1' }] });
    batcher.forceFlush();
    expect(stateService.getInstance('worker-1')?.parentId).toBe('parent-1');

    eventBus.batchUpdate$.next({ updates: [{ instanceId: 'worker-1', status: 'idle' }] });
    batcher.forceFlush();
    expect(stateService.getInstance('worker-1')?.parentId).toBe('parent-1');
  });

  it('applies an adopted parent from a direct update', () => {
    eventBus.instanceStateUpdate$.next({ instanceId: 'worker-1', status: 'error', parentId: 'parent-1' });

    expect(stateService.getInstance('worker-1')?.parentId).toBe('parent-1');
  });
});
