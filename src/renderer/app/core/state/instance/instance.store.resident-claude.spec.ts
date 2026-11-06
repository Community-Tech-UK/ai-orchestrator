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
import { describeModelSwitchEffect } from '../../../features/models/model-switch-note';

/**
 * Plan 14d item 5: the pre-click switch note reads `instance.residentClaude`.
 * Main resolves that flag in background init, after the created event, so a
 * session created in this run only learns it from the state updates that
 * follow (the main side is pinned in
 * instance-lifecycle-resident-claude-renderer.spec.ts). Without adoption the
 * note says "starts a fresh session" while the real switch is live.
 */
describe('InstanceStore residentClaude adoption', () => {
  let eventBus: {
    instanceStateUpdate$: Subject<StateUpdate>;
    batchUpdate$: Subject<{ updates: StateUpdate[] }>;
  };
  let stateService: InstanceStateService;
  let batcher: UpdateBatcherService;

  /** What the renderer's created-event mapper produces: the flag is still unknown. */
  const createdSession = {
    id: 'claude-1',
    status: 'initializing',
    provider: 'claude',
    residentClaude: undefined,
    executionLocation: { type: 'local' },
    outputBuffer: [{ id: 'm1', type: 'user', content: 'hello', timestamp: 1 }],
  } as unknown as Instance;

  /** The pre-click line exactly as the header computes it from the store's instance. */
  function noteFor(instanceId: string): string | null {
    const inst = stateService.getInstance(instanceId)!;
    return describeModelSwitchEffect({
      provider: inst.provider,
      hasConversation: inst.outputBuffer.some((m) => m.type === 'user' || m.type === 'assistant'),
      usedTokens: null,
      residentClaude: inst.residentClaude,
      executionLocationType: inst.executionLocation?.type,
    });
  }

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
      instances: new Map([[createdSession.id, createdSession]]),
    }));
  });

  afterEach(() => TestBed.resetTestingModule());

  it('before the first update the note wrongly promises a fresh session (the defect this guards)', () => {
    expect(noteFor('claude-1')).toContain('starts a fresh Claude session');
  });

  it('adopts residentClaude from a batched update, and the note then says the switch happens in place', () => {
    eventBus.batchUpdate$.next({
      updates: [{ instanceId: 'claude-1', status: 'idle', residentClaude: true }],
    });
    batcher.forceFlush();

    expect(stateService.getInstance('claude-1')?.residentClaude).toBe(true);
    expect(noteFor('claude-1')).toContain('Switches in place');
  });

  it('keeps the flag through later status-only updates', () => {
    eventBus.batchUpdate$.next({
      updates: [{ instanceId: 'claude-1', status: 'idle', residentClaude: true }],
    });
    batcher.forceFlush();
    eventBus.batchUpdate$.next({ updates: [{ instanceId: 'claude-1', status: 'busy' }] });
    batcher.forceFlush();
    eventBus.batchUpdate$.next({ updates: [{ instanceId: 'claude-1', status: 'idle' }] });
    batcher.forceFlush();

    expect(stateService.getInstance('claude-1')?.residentClaude).toBe(true);
  });

  it('keeps the flag when a status-only update lands in the same batching window', () => {
    eventBus.batchUpdate$.next({
      updates: [
        { instanceId: 'claude-1', status: 'idle', residentClaude: true },
        { instanceId: 'claude-1', status: 'busy' },
      ],
    });
    batcher.forceFlush();

    expect(stateService.getInstance('claude-1')?.residentClaude).toBe(true);
  });

  it('keeps the flag when a later update in the same window names the field as undefined (structured clone keeps the key)', () => {
    eventBus.batchUpdate$.next({
      updates: [
        { instanceId: 'claude-1', status: 'idle', residentClaude: true },
        { instanceId: 'claude-1', status: 'busy', residentClaude: undefined },
      ],
    });
    batcher.forceFlush();

    expect(stateService.getInstance('claude-1')?.residentClaude).toBe(true);
  });

  it('adopts residentClaude from a direct state update (batched, and applied at once on error)', () => {
    eventBus.instanceStateUpdate$.next({ instanceId: 'claude-1', status: 'idle', residentClaude: true });
    batcher.forceFlush();
    expect(stateService.getInstance('claude-1')?.residentClaude).toBe(true);

    stateService.updateInstance('claude-1', { residentClaude: undefined });
    eventBus.instanceStateUpdate$.next({ instanceId: 'claude-1', status: 'error', residentClaude: true });
    expect(stateService.getInstance('claude-1')?.residentClaude).toBe(true);
  });

  it('lets main turn the flag off again', () => {
    eventBus.batchUpdate$.next({
      updates: [{ instanceId: 'claude-1', status: 'idle', residentClaude: true }],
    });
    batcher.forceFlush();
    eventBus.batchUpdate$.next({
      updates: [{ instanceId: 'claude-1', status: 'idle', residentClaude: false }],
    });
    batcher.forceFlush();

    expect(stateService.getInstance('claude-1')?.residentClaude).toBe(false);
    expect(noteFor('claude-1')).toContain('starts a fresh Claude session');
  });
});
