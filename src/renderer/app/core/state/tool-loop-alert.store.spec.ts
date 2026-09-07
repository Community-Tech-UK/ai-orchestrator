/**
 * N2 — the store that lets a doom-loop detection outlive its toast.
 *
 * These drive the real store through a fake IPC channel and a fake instance
 * store, so the reaping rule (leave an active turn → alert clears) is exercised
 * rather than described.
 */
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it } from 'vitest';

import { ToolLoopAlertStore } from './tool-loop-alert.store';
import { InstanceStore } from './instance.store';
import { IpcFacadeService } from '../services/ipc';

type Listener = (data: unknown) => void;

function setup(status = 'busy') {
  const listeners = new Map<string, Listener>();
  let cleanupCalls = 0;
  const instances = signal([{ id: 'i1', status }]);

  TestBed.resetTestingModule();
  TestBed.configureTestingModule({
    providers: [
      {
        provide: IpcFacadeService,
        useValue: {
          on: (channel: string, cb: Listener) => {
            listeners.set(channel, cb);
            return () => { cleanupCalls += 1; };
          },
        },
      },
      { provide: InstanceStore, useValue: { instances } },
    ],
  });

  const store = TestBed.inject(ToolLoopAlertStore);
  const emit = (payload: Record<string, unknown>) =>
    listeners.get('instance:doom-loop')?.(payload);

  const critical = {
    instanceId: 'i1', detector: 'repeat-no-progress', severity: 'critical',
    toolName: 'Read', count: 9, windowDescription: '9 calls in 2 minutes',
  };

  return { store, emit, instances, critical, cleanups: () => cleanupCalls };
}

describe('ToolLoopAlertStore (N2)', () => {
  beforeEach(() => TestBed.resetTestingModule());

  it('has no alert before anything is detected', () => {
    expect(setup().store.hasCriticalAlert('i1')).toBe(false);
  });

  it('records a critical detection against its own instance only', () => {
    const { store, emit, critical } = setup();
    emit(critical);
    expect(store.hasCriticalAlert('i1')).toBe(true);
    expect(store.hasCriticalAlert('i2')).toBe(false);
  });

  it('ignores a warning, which already has its toast', () => {
    const { store, emit, critical } = setup();
    emit({ ...critical, severity: 'warn' });
    expect(store.hasCriticalAlert('i1')).toBe(false);
  });

  it('exposes the detail the badge and actions need', () => {
    const { store, emit, critical } = setup();
    emit(critical);
    const alert = store.alertFor('i1');
    expect(alert?.toolName).toBe('Read');
    expect(alert?.windowDescription).toBe('9 calls in 2 minutes');
    expect(alert?.count).toBe(9);
  });

  it('clears once the instance leaves the active turn', () => {
    const { store, emit, instances, critical } = setup();
    emit(critical);
    expect(store.hasCriticalAlert('i1')).toBe(true);
    instances.set([{ id: 'i1', status: 'idle' }]);
    expect(store.hasCriticalAlert('i1')).toBe(false);
  });

  it('stays live across the other active-turn statuses', () => {
    const { store, emit, instances, critical } = setup();
    emit(critical);
    for (const status of ['processing', 'thinking_deeply', 'waiting_for_permission']) {
      instances.set([{ id: 'i1', status }]);
      expect(store.hasCriticalAlert('i1')).toBe(true);
    }
  });

  it('treats an instance that has disappeared as not looping', () => {
    const { store, emit, instances, critical } = setup();
    emit(critical);
    instances.set([]);
    expect(store.hasCriticalAlert('i1')).toBe(false);
  });

  it('acknowledge drops the alert for good, not just for this turn', () => {
    const { store, emit, critical } = setup();
    emit(critical);
    store.acknowledge('i1');
    expect(store.hasCriticalAlert('i1')).toBe(false);
  });

  it('treats a missing instance id as no alert rather than throwing', () => {
    const { store } = setup();
    expect(store.hasCriticalAlert(undefined)).toBe(false);
    expect(store.alertFor(undefined)).toBeNull();
  });

  it('a later detection replaces the earlier one for the same instance', () => {
    const { store, emit, critical } = setup();
    emit(critical);
    emit({ ...critical, toolName: 'Bash', windowDescription: '12 calls in 1 minute' });
    expect(store.alertFor('i1')?.toolName).toBe('Bash');
  });

  it('unsubscribes from the channel when destroyed', () => {
    const { cleanups } = setup();
    TestBed.resetTestingModule();
    expect(cleanups()).toBe(1);
  });
});
