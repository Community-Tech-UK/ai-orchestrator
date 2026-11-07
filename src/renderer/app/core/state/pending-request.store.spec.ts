import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { Subject } from 'rxjs';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { IpcEventBusService, type InputRequiredEvent, type InputRequiredResolvedEvent } from '../services/ipc/ipc-event-bus.service';
import { InstanceStore } from './instance.store';
import { PendingRequestStore } from './pending-request.store';

describe('PendingRequestStore', () => {
  const instances = signal([{ id: 'a', status: 'waiting_for_permission', yoloMode: false }]);
  let added: Subject<InputRequiredEvent>;
  let resolved: Subject<InputRequiredResolvedEvent>;
  let store: PendingRequestStore;
  beforeEach(() => {
    added = new Subject(); resolved = new Subject();
    instances.set([{ id: 'a', status: 'waiting_for_permission', yoloMode: false }]);
    TestBed.configureTestingModule({ providers: [
      { provide: InstanceStore, useValue: { instances } },
      { provide: IpcEventBusService, useValue: { inputRequired$: added, inputRequiredResolved$: resolved } },
    ] });
    store = TestBed.inject(PendingRequestStore);
  });
  afterEach(() => TestBed.resetTestingModule());
  const request = { instanceId: 'a', requestId: 'r', timestamp: 42, prompt: 'x'.repeat(200) };
  it('retains clipped permission text and tool name for background sessions', () => {
    added.next({ ...request, metadata: { type: 'deferred_permission', tool_name: 'Bash' } });
    expect(store.forInstance('a')).toEqual([{ instanceId: 'a', kind: 'permission', toolName: 'Bash', text: 'x'.repeat(140), since: 42 }]);
  });
  it('classifies questions and removes only the matching resolved request', () => {
    added.next({ ...request, metadata: { type: 'ask_user_question' } });
    expect(store.forInstance('a')[0].kind).toBe('question');
    resolved.next({ instanceId: 'other', requestId: 'r', reason: 'decided' });
    expect(store.forInstance('a')).toHaveLength(1);
    resolved.next({ instanceId: 'a', requestId: 'r', reason: 'decided' });
    expect(store.forInstance('a')).toEqual([]);
  });
  it('keeps each session own prompt when independent connections reuse a request id', () => {
    instances.set([
      { id: 'a', status: 'waiting_for_permission', yoloMode: false },
      { id: 'b', status: 'waiting_for_permission', yoloMode: false },
    ]);
    TestBed.tick();
    added.next({ instanceId: 'a', requestId: 'acp_permission:1', timestamp: 1, prompt: 'Session a prompt',
      metadata: { type: 'deferred_permission', tool_name: 'Bash' } });
    added.next({ instanceId: 'b', requestId: 'acp_permission:1', timestamp: 2, prompt: 'Session b prompt',
      metadata: { type: 'deferred_permission', tool_name: 'Bash' } });
    expect(store.forInstance('a').map((p) => p.text)).toEqual(['Session a prompt']);
    expect(store.forInstance('b').map((p) => p.text)).toEqual(['Session b prompt']);
    resolved.next({ instanceId: 'a', requestId: 'acp_permission:1', reason: 'decided' });
    expect(store.forInstance('a')).toEqual([]);
    expect(store.forInstance('b').map((p) => p.text)).toEqual(['Session b prompt']);
  });
  it('skips auto-approve sessions and guards missed resolutions at read time', () => {
    instances.update((items) => items.map((item) => ({ ...item, yoloMode: true })));
    added.next(request);
    instances.update((items) => items.map((item) => ({ ...item, yoloMode: false })));
    expect(store.forInstance('a')).toEqual([]);
    added.next(request);
    instances.update((items) => items.map((item) => ({ ...item, status: 'busy' })));
    expect(store.forInstance('a')).toEqual([]);
  });
  it('clears an answered question so the next waiting state shows only the new prompt', () => {
    instances.set([{ id: 'a', status: 'waiting_for_input', yoloMode: false }]);
    TestBed.tick();
    added.next({ instanceId: 'a', requestId: 'old-question', timestamp: 1,
      prompt: 'Old question already answered', metadata: { type: 'ask_user_question' } });
    expect(store.forInstance('a').map((p) => p.text)).toEqual(['Old question already answered']);
    instances.set([{ id: 'a', status: 'busy', yoloMode: false }]);
    TestBed.tick();
    expect(store.forInstance('a')).toEqual([]);
    instances.set([{ id: 'a', status: 'idle', yoloMode: false }]);
    TestBed.tick();
    instances.set([{ id: 'a', status: 'waiting_for_input', yoloMode: false }]);
    added.next({ instanceId: 'a', requestId: 'new-question', timestamp: 2,
      prompt: 'Current unanswered question', metadata: { type: 'ask_user_question' } });
    TestBed.tick();
    expect(store.forInstance('a').map((p) => p.text)).toEqual(['Current unanswered question']);
  });
  it('drops the requests of a removed session and keeps them gone when the id returns', () => {
    added.next({ ...request, requestId: 'gone', metadata: { type: 'ask_user_question' } });
    instances.set([]);
    TestBed.tick();
    instances.set([{ id: 'a', status: 'waiting_for_input', yoloMode: false }]);
    TestBed.tick();
    expect(store.forInstance('a')).toEqual([]);
  });
});
