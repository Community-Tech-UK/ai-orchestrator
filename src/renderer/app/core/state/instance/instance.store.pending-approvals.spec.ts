import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService, IpcEventBusService } from '../../services/ipc';
import type { InputRequiredResolvedEvent } from '../../services/ipc/ipc-event-bus.service';
import { StatsIpcService } from '../../services/ipc/stats-ipc.service';
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
 * The pending-approval badge counts requests a CLI raised. A card the model
 * raised itself never added to it, so its closing must not take one away.
 */
describe('InstanceStore pending approval count', () => {
  let resolved: Subject<InputRequiredResolvedEvent>;
  let inputRequired: Subject<unknown>;
  let stateService: InstanceStateService;

  beforeEach(() => {
    const streams = [
      'batchUpdate$', 'compactStatus$', 'fastToggled$', 'inputContextDelivered$',
      'instanceCreated$', 'instanceOutput$', 'instanceRemoved$', 'instanceStateUpdate$',
      'instanceTranscriptChunk$', 'orchestrationActivity$', 'yoloToggled$',
    ];
    resolved = new Subject<InputRequiredResolvedEvent>();
    inputRequired = new Subject<unknown>();
    const eventBus = {
      ...Object.fromEntries(streams.map((name) => [name, new Subject<unknown>()])),
      inputRequired$: inputRequired,
      inputRequiredResolved$: resolved,
    };

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
        { provide: InstanceMessagingStore, useValue: { processMessageQueue: vi.fn(), clearQueueWithNotification: vi.fn() } },
      ],
    });

    TestBed.inject(InstanceStore);
    stateService = TestBed.inject(InstanceStateService);
    stateService.state.update((current) => ({
      ...current,
      instances: new Map([[
        'i-1',
        { id: 'i-1', status: 'waiting_for_permission', pendingApprovalCount: 0 } as unknown as Instance,
      ]]),
    }));
    // Two permission requests are waiting; each is tracked by its own request id.
    for (const requestId of ['perm-1', 'perm-2']) {
      inputRequired.next({ instanceId: 'i-1', requestId, prompt: 'Allow?', timestamp: 1, metadata: { type: 'deferred_permission' } });
    }
  });

  afterEach(() => TestBed.resetTestingModule());

  const count = () => stateService.getInstance('i-1')?.pendingApprovalCount;

  it('drops one when a CLI request is settled without the person', () => {
    resolved.next({ instanceId: 'i-1', requestId: 'perm-1', reason: 'timeout' });

    expect(count()).toBe(1);
  });

  it('leaves the count alone when a card the model raised closes', () => {
    resolved.next({ instanceId: 'i-1', requestId: 'uar-1', reason: 'timeout', kind: 'user-action' });
    resolved.next({ instanceId: 'i-1', requestId: 'uar-2', reason: 'decided', kind: 'user-action' });

    expect(count()).toBe(2);
  });
});
