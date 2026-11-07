import { TestBed } from '@angular/core/testing';
import { Router } from '@angular/router';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { InstanceIpcService, IpcEventBusService } from '../../services/ipc';
import { StatsIpcService } from '../../services/ipc/stats-ipc.service';
import { ProviderStateService } from '../../services/provider-state.service';
import { AutomationStore } from '../automation.store';
import { InstanceStore } from './instance.store';
import { InstanceListStore } from './instance-list.store';
import { InstanceSelectionStore } from './instance-selection.store';
import { InstanceOutputStore } from './instance-output.store';
import { InstanceMessagingStore } from './instance-messaging.store';
import { InstanceStateService } from './instance-state.service';
import type { Instance } from './instance.types';
import type { InputRequiredEvent } from '../../services/ipc/ipc-event-bus.service';

describe('permission counts distinguish questions and settle by session and request', () => {
  let streams: Record<string, Subject<unknown>>;
  let store: InstanceStore;
  let state: InstanceStateService;
  const count = (id = 'a') => state.getInstance(id)?.pendingApprovalCount ?? 0;
  const request = (type: string, requestId = '1', instanceId = 'a') => {
    const event: InputRequiredEvent = { instanceId, requestId, prompt: 'Fixture request', timestamp: 1, metadata: { type } };
    streams['inputRequired$'].next(event);
  };
  const resolved = (requestId: string, instanceId = 'a') => streams['inputRequiredResolved$'].next({ instanceId, requestId, reason: 'decided' });

  beforeEach(() => {
    vi.useFakeTimers();
    streams = Object.fromEntries([
      'batchUpdate$', 'compactStatus$', 'fastToggled$', 'inputRequired$', 'inputRequiredResolved$',
      'instanceCreated$', 'instanceOutput$', 'instanceRemoved$', 'instanceStateUpdate$',
      'inputContextDelivered$', 'instanceTranscriptChunk$', 'orchestrationActivity$', 'yoloToggled$',
    ].map(name => [name, new Subject<unknown>()]));
    TestBed.configureTestingModule({ providers: [
      { provide: IpcEventBusService, useValue: streams },
      { provide: InstanceIpcService, useValue: {} },
      { provide: StatsIpcService, useValue: { statsRecordSessionEnd: vi.fn().mockResolvedValue(undefined) } },
      { provide: ProviderStateService, useValue: {} },
      { provide: AutomationStore, useValue: {} },
      { provide: InstanceListStore, useValue: { loadInitialInstances: vi.fn(), removeInstance: vi.fn() } },
      { provide: InstanceSelectionStore, useValue: {} },
      { provide: InstanceOutputStore, useValue: { cleanupAll: vi.fn(), cleanupInstance: vi.fn(), flushInstanceOutput: vi.fn() } },
      { provide: InstanceMessagingStore, useValue: { processMessageQueue: vi.fn(), clearQueueWithNotification: vi.fn() } },
      { provide: Router, useValue: {} },
    ] });
    store = TestBed.inject(InstanceStore);
    state = TestBed.inject(InstanceStateService);
    state.state.update(value => ({ ...value, instances: new Map(['a', 'b'].map(id => [id,
      { id, status: 'processing', pendingApprovalCount: 0, metadata: {}, restartEpoch: 0 } as Instance])) }));
  });
  afterEach(() => { TestBed.resetTestingModule(); vi.useRealTimers(); });

  it.each(['ask_user_question', 'acp_elicitation', 'mcp_elicitation', 'secret_required'])('does not count %s as a permission', type => {
    request(type);
    expect(count()).toBe(0);
    streams['instanceStateUpdate$'].next({ instanceId: 'a', status: 'idle' });
    vi.advanceTimersByTime(50);
    expect(count()).toBe(0);
  });

  it.each(['permission_denial', 'deferred_permission', 'codex_mcp_approval', 'acp_permission_request'])('counts %s once while processing', type => {
    request(type); request(type);
    expect(count()).toBe(1);
    streams['instanceStateUpdate$'].next({ instanceId: 'a', status: 'processing' });
    vi.advanceTimersByTime(50);
    expect(count()).toBe(1);
  });

  it('ignores duplicate and unknown settlements without consuming another pending request', () => {
    request('deferred_permission', 'first'); request('deferred_permission', 'second');
    resolved('first'); resolved('first'); resolved('missing');
    expect(count()).toBe(1);
    resolved('second'); expect(count()).toBe(0);
  });

  it('settles card responses by the same request identity as the resolved event', () => {
    request('deferred_permission', 'first'); request('deferred_permission', 'second');
    store.decrementPendingApproval('a', 'first'); resolved('first');
    expect(count()).toBe(1);
  });

  it('settles identical request IDs separately in two sessions', () => {
    request('acp_permission_request', '1', 'a'); request('acp_permission_request', '1', 'b');
    resolved('1', 'a'); resolved('1', 'a');
    expect(count('a')).toBe(0); expect(count('b')).toBe(1);
  });

  it('does not let a question settlement consume an actual permission', () => {
    request('deferred_permission', 'permission'); request('ask_user_question', 'question');
    resolved('question'); expect(count()).toBe(1);
  });

  it('keeps the existing waiting/input/busy batch ordering and clears old identities', () => {
    streams['instanceStateUpdate$'].next({ instanceId: 'a', status: 'waiting_for_permission' });
    request('deferred_permission', 'old');
    streams['instanceStateUpdate$'].next({ instanceId: 'a', status: 'busy' });
    vi.advanceTimersByTime(50); expect(count()).toBe(0);
    request('deferred_permission', 'new'); resolved('old'); expect(count()).toBe(1);
  });

  it('clears identities on removal and Auto-approve enablement', () => {
    request('deferred_permission');
    streams['instanceRemoved$'].next('a');
    request('deferred_permission', 'new'); resolved('1'); expect(count()).toBe(1);
    streams['yoloToggled$'].next({ instanceId: 'a', yoloMode: true }); expect(count()).toBe(0);
  });
  it.each([true, false])('does not resurrect identities discarded by a list resync, next event is a new request=%s', newRequest => {
    request('deferred_permission', 'old-one'); request('deferred_permission', 'old-two');
    state.setInstances(new Map([...state.state().instances].map(([id, instance]) => [id, { ...instance, pendingApprovalCount: 0 }])));
    if (newRequest) {
      request('deferred_permission', 'new');
      expect(count()).toBe(1);
      resolved('old-one'); expect(count()).toBe(1);
    } else {
      resolved('old-one'); expect(count()).toBe(0);
    }
  });
});
