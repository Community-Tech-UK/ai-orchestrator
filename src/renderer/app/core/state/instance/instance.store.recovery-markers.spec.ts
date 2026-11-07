import { TestBed } from '@angular/core/testing';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService, IpcEventBusService } from '../../services/ipc';
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
import type { Instance, OutputMessage } from './instance.types';

/**
 * The "condensed context will attach on send" notice must end once the model
 * replies: a reply proves it has the history, so the notice would be untrue.
 */
describe('InstanceStore recovery markers on model reply', () => {
  let instanceOutput$: Subject<{ instanceId: string; message: OutputMessage }>;
  let clearRecoveryMarkers: ReturnType<typeof vi.fn>;
  let instance: Instance;

  beforeEach(() => {
    const streams = [
      'batchUpdate$', 'compactStatus$', 'fastToggled$', 'inputRequired$',
      'inputRequiredResolved$', 'instanceCreated$', 'instanceOutput$',
      'instanceRemoved$', 'instanceStateUpdate$', 'inputContextDelivered$', 'instanceTranscriptChunk$', 'orchestrationActivity$', 'yoloToggled$',
    ];
    const eventBus = Object.fromEntries(streams.map((name) => [name, new Subject<unknown>()]));
    instanceOutput$ = eventBus['instanceOutput$'] as typeof instanceOutput$;
    clearRecoveryMarkers = vi.fn();

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
        { provide: InstanceOutputStore, useValue: { queueOutput: vi.fn(), cleanupAll: vi.fn() } },
        { provide: InstanceMessagingStore, useValue: { clearRecoveryMarkers } },
      ],
    });

    TestBed.inject(InstanceStore);
    const stateService = TestBed.inject(InstanceStateService);
    instance = { id: 'session-1', status: 'busy', recoveryMethod: 'replay' } as unknown as Instance;
    stateService.state.update((current) => ({ ...current, instances: new Map([['session-1', instance]]) }));
  });

  afterEach(() => TestBed.resetTestingModule());

  const output = (type: OutputMessage['type']): void => {
    instanceOutput$.next({
      instanceId: 'session-1',
      message: { id: `m-${type}`, type, content: 'text', timestamp: 1 } as OutputMessage,
    });
  };

  it('clears the markers when the model replies or starts using a tool', () => {
    output('assistant');
    output('tool_use');

    expect(clearRecoveryMarkers).toHaveBeenCalledTimes(2);
    expect(clearRecoveryMarkers).toHaveBeenCalledWith('session-1', instance);
  });

  it('keeps the markers for system notices and errors', () => {
    output('system');
    output('error');

    expect(clearRecoveryMarkers).not.toHaveBeenCalled();
  });
});
