import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService, IpcEventBusService } from '../../services/ipc';
import { StatsIpcService } from '../../services/ipc/stats-ipc.service';
import { ToastService } from '../../services/toast.service';
import { ProviderStateService } from '../../services/provider-state.service';
import { AutomationStore } from '../automation.store';
import { InstanceStore } from './instance.store';
import { InstanceListStore } from './instance-list.store';
import { InstanceSelectionStore } from './instance-selection.store';
import { InstanceOutputStore } from './instance-output.store';
import { InstanceMessagingStore } from './instance-messaging.store';
import type { Instance, OutputMessage } from './instance.types';
import { InstanceStateService } from './instance-state.service';
import { LIMITS } from '../../../../../shared/constants/limits';

describe('InstanceStore output and provider notices', () => {
  let output: Subject<{ instanceId: string; message: OutputMessage }>;
  const select = vi.fn();
  const navigate = vi.fn().mockResolvedValue(true);

  beforeEach(() => {
    vi.clearAllMocks();
    const streams = Object.fromEntries([
      'batchUpdate$', 'compactStatus$', 'fastToggled$', 'inputRequired$', 'inputRequiredResolved$',
      'instanceCreated$', 'instanceOutput$', 'instanceRemoved$', 'instanceStateUpdate$',
      'inputContextDelivered$', 'instanceTranscriptChunk$', 'orchestrationActivity$', 'yoloToggled$',
    ].map(name => [name, new Subject<unknown>()]));
    output = streams['instanceOutput$'] as typeof output;
    TestBed.configureTestingModule({ providers: [
      { provide: IpcEventBusService, useValue: streams },
      { provide: InstanceIpcService, useValue: {} },
      { provide: StatsIpcService, useValue: { statsRecordToolUsage: vi.fn().mockResolvedValue(undefined) } },
      { provide: ProviderStateService, useValue: { rememberFastModeForProvider: vi.fn() } },
      { provide: AutomationStore, useValue: {} },
      { provide: InstanceListStore, useValue: { loadInitialInstances: vi.fn() } },
      { provide: InstanceSelectionStore, useValue: { setSelectedInstance: select } },
      { provide: InstanceOutputStore, useValue: { queueOutput: vi.fn(), cleanupAll: vi.fn() } },
      { provide: InstanceMessagingStore, useValue: {} },
      { provide: Router, useValue: { navigate } },
    ] });
    TestBed.inject(InstanceStore);
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  it('keeps a refused Fast capability visible for that provider for this app run', () => {
    const state = TestBed.inject(InstanceStateService);
    state.state.update(value => ({ ...value, instances: new Map([['session-a',
      { id: 'session-a', provider: 'claude', status: 'ready', fastMode: true } as Instance]]) }));
    const fast = TestBed.inject(IpcEventBusService).fastToggled$ as Subject<unknown>;
    fast.next({ instanceId: 'session-a', fastMode: false, reason: 'unavailable' });
    expect(TestBed.inject(InstanceStore).fastUnavailableProviders().has('claude')).toBe(true);
    expect(TestBed.inject(InstanceStore).fastUnavailableProviders().has('codex')).toBe(false);
    fast.next({ instanceId: 'session-a', fastMode: false, reason: 'user' });
    expect(TestBed.inject(InstanceStore).fastUnavailableProviders().has('claude')).toBe(true);
    expect(state.getInstance('session-a')?.fastMode).toBe(false);
  });

  it('feeds assistant thinking through the same debouncer as a subsequent tool call', () => {
    vi.useFakeTimers();
    const store = TestBed.inject(InstanceStore);
    output.next({ instanceId: 'session-a', message: { id: 'thought', timestamp: Date.now(), type: 'assistant',
      content: '', thinking: [{ id: 'thinking-1', format: 'sdk', content: '**Checking the migration order**', tokenCount: 10 }] } });
    expect(store.liveActivities().get('session-a')).toBe('Thinking · Checking the migration order');
    output.next({ instanceId: 'session-a', message: { id: 'tool', timestamp: Date.now(), type: 'tool_use',
      content: '', metadata: { name: 'Read' } } });
    expect(store.liveActivities().get('session-a')).toBe('Thinking · Checking the migration order');
    vi.advanceTimersByTime(LIMITS.STATUS_DEBOUNCE_MS);
    expect(store.liveActivities().get('session-a')).toBe('Reading files');
  });

  it.each(['model-selection-degraded', 'pending-model-change-failed'])(
    'folds %s by session and offers a working Show session action', kind => {
      const emit = (instanceId: string, text: string) => output.next({ instanceId,
        message: { id: text, timestamp: Date.now(), type: 'system', content: text, metadata: { kind } } });
      emit('session-a', 'Requested model unavailable; using the provider default.');
      emit('session-a', 'The queued model change failed.');
      emit('session-b', 'The queued model change failed.');
      const toasts = TestBed.inject(ToastService).toasts();
      expect(toasts).toHaveLength(2);
      expect(toasts[0]).toMatchObject({ key: 'model-change:session-a', type: 'error', repeatCount: 2,
        text: 'The queued model change failed.', action: { label: 'Show session' } });
      toasts[0].action!.run();
      expect(select).toHaveBeenCalledWith('session-a');
      expect(navigate).toHaveBeenCalledWith(['/']);
    },
  );

  it('does not raise an error toast when a retired model was replaced by its equivalent', () => {
    output.next({ instanceId: 'session-a', message: { id: 'equivalent', timestamp: Date.now(), type: 'system',
      content: 'Model "grok-4.5-xhigh" is no longer available for cursor.',
      metadata: { kind: 'model-selection-degraded', fallbackKind: 'equivalent' } } });
    expect(TestBed.inject(ToastService).toasts()).toHaveLength(0);
  });
});
