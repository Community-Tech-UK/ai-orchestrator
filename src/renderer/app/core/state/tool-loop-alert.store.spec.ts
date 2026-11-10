/**
 * N2 — the store that lets a doom-loop detection outlive its toast.
 *
 * These drive the real store through a fake IPC channel and a fake instance
 * store, so the reaping rule (leave an active turn → alert clears) is exercised
 * rather than described.
 */
import { TestBed } from '@angular/core/testing';
import { signal } from '@angular/core';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { ToolLoopAlertStore } from './tool-loop-alert.store';
import { InstanceStore } from './instance.store';
import { IpcFacadeService } from '../services/ipc';

type Listener = (data: unknown) => void;

function setup(status = 'busy') {
  const listeners = new Map<string, Listener>();
  let cleanupCalls = 0;
  const instances = signal([{ id: 'i1', status }]);
  const calls: string[] = [];
  const interruptInstance = vi.fn(async (id: string) => { calls.push(`interrupt:${id}`); return true; });
  const parked = new Set<string>();
  const instanceStore = {
    instances,
    interruptInstance,
    isQueueParked: (id: string) => parked.has(id),
    parkQueueAfterInterrupt: vi.fn((id: string) => { calls.push(`park:${id}`); parked.add(id); }),
    resumeParkedQueue: vi.fn((id: string) => { calls.push(`resume:${id}`); parked.delete(id); }),
  };

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
      { provide: InstanceStore, useValue: instanceStore },
    ],
  });

  const store = TestBed.inject(ToolLoopAlertStore);
  const emit = (payload: Record<string, unknown>) =>
    listeners.get('instance:doom-loop')?.(payload);

  const critical = {
    instanceId: 'i1', detector: 'repeat-no-progress', severity: 'critical',
    toolName: 'Read', count: 9, windowDescription: '9 calls in 2 minutes', harnessStopping: false,
  };

  return { store, emit, instances, critical, calls, parked, interruptInstance, cleanups: () => cleanupCalls };
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

  it('offers no decision when Harness is stopping the turn itself, and withdraws an earlier one', () => {
    const { store, emit, critical } = setup();
    emit({ ...critical, harnessStopping: true });
    expect(store.hasCriticalAlert('i1')).toBe(false);
    emit(critical);
    emit({ ...critical, detector: 'runaway', harnessStopping: true });
    // A Stop click now would be a second interrupt, which main treats as "force it".
    expect(store.hasCriticalAlert('i1')).toBe(false);
  });

  it('exposes the detail the badge and actions need', () => {
    const { store, emit, critical } = setup();
    emit(critical);
    const alert = store.alertFor('i1');
    expect(alert?.toolName).toBe('Read');
    expect(alert?.count).toBe(9);
  });

  it('clears once the instance leaves the active turn', () => {
    const { store, emit, instances, critical } = setup();
    emit(critical);
    expect(store.hasCriticalAlert('i1')).toBe(true);
    instances.set([{ id: 'i1', status: 'idle' }]);
    expect(store.hasCriticalAlert('i1')).toBe(false);
  });

  it('does not bring an unanswered alert back on the next turn', () => {
    const { store, emit, instances, critical } = setup();
    emit(critical);
    instances.set([{ id: 'i1', status: 'idle' }]);
    TestBed.tick();
    instances.set([{ id: 'i1', status: 'busy' }]);
    TestBed.tick();
    expect(store.hasCriticalAlert('i1')).toBe(false);
    // A new detection in the new turn is still shown.
    emit(critical);
    expect(store.hasCriticalAlert('i1')).toBe(true);
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

  it('"Let it continue" drops the alert for good, not just for this turn', () => {
    const { store, emit, critical } = setup();
    emit(critical);
    store.letContinue('i1');
    expect(store.hasCriticalAlert('i1')).toBe(false);
  });

  it('"Stop this turn" holds the queue before interrupting, like the Stop button, then clears the alert', async () => {
    const { store, emit, critical, calls } = setup();
    emit(critical);
    await expect(store.stopTurn('i1')).resolves.toBe(true);
    expect(calls).toEqual(['park:i1', 'interrupt:i1']);
    expect(store.hasCriticalAlert('i1')).toBe(false);
  });

  it('a refused stop keeps asking and leaves the queue held, as the Stop button does', async () => {
    const { store, emit, critical, calls, interruptInstance } = setup();
    interruptInstance.mockResolvedValueOnce(false);
    emit(critical);
    await expect(store.stopTurn('i1')).resolves.toBe(false);
    // Releasing it here would send messages the user may have held back on purpose.
    expect(calls).toEqual(['park:i1']);
    expect(store.hasCriticalAlert('i1')).toBe(true);
    expect(store.isStopping('i1')).toBe(false);
  });

  it('"Let it continue" after a refused stop releases the queue that stop held', async () => {
    const { store, emit, critical, calls, interruptInstance } = setup();
    interruptInstance.mockResolvedValueOnce(false);
    emit(critical);
    await store.stopTurn('i1');
    store.letContinue('i1');
    expect(calls).toEqual(['park:i1', 'resume:i1']);
    expect(store.hasCriticalAlert('i1')).toBe(false);
  });

  it('"Let it continue" never releases a queue the user had already held', async () => {
    const { store, emit, critical, calls, parked, interruptInstance } = setup();
    parked.add('i1');
    interruptInstance.mockResolvedValueOnce(false);
    emit(critical);
    await store.stopTurn('i1');
    store.letContinue('i1');
    expect(calls).toEqual(['park:i1']);
  });

  it('a refused stop whose turn then ends leaves the queue held, as after Stop', async () => {
    const { store, emit, critical, calls, instances, interruptInstance } = setup();
    interruptInstance.mockResolvedValueOnce(false);
    emit(critical);
    await store.stopTurn('i1');
    instances.set([{ id: 'i1', status: 'idle' }]);
    TestBed.tick();
    instances.set([{ id: 'i1', status: 'busy' }]);
    emit(critical);
    store.letContinue('i1');
    // The new alert's "Let it continue" is not about the old refused stop.
    expect(calls).toEqual(['park:i1']);
  });

  it('forgets a refused stop\'s hold when its turn ends, even if Harness withdrew the alert first', async () => {
    const { store, emit, critical, calls, parked, instances, interruptInstance } = setup();
    interruptInstance.mockResolvedValueOnce(false);
    emit(critical);
    await store.stopTurn('i1');
    emit({ ...critical, detector: 'runaway', harnessStopping: true });
    instances.set([{ id: 'i1', status: 'idle' }]);
    TestBed.tick();
    // Next turn: the user holds the queue with Stop themselves, then a new alert arrives.
    instances.set([{ id: 'i1', status: 'busy' }]);
    parked.add('i1');
    emit(critical);
    store.letContinue('i1');
    expect(calls).toEqual(['park:i1']);
  });

  it('a stop that throws keeps asking, reports the failure and can be tried again', async () => {
    const { store, emit, critical, interruptInstance } = setup();
    interruptInstance.mockRejectedValueOnce(new Error('ipc down'));
    emit(critical);
    await expect(store.stopTurn('i1')).rejects.toThrow('ipc down');
    expect(store.hasCriticalAlert('i1')).toBe(true);
    expect(store.isStopping('i1')).toBe(false);
    await expect(store.stopTurn('i1')).resolves.toBe(true);
  });

  it('a second click while stopping sends no second interrupt, which main would treat as "force it"', async () => {
    const { store, emit, critical, interruptInstance } = setup();
    let finish!: (value: boolean) => void;
    interruptInstance.mockReturnValueOnce(new Promise<boolean>((resolve) => { finish = resolve; }));
    emit(critical);
    const first = store.stopTurn('i1');
    const second = store.stopTurn('i1');
    expect(store.isStopping('i1')).toBe(true);
    expect(store.isStopping('i2')).toBe(false);
    expect(interruptInstance).toHaveBeenCalledTimes(1);
    finish(true);
    await expect(Promise.all([first, second])).resolves.toEqual([true, true]);
    expect(store.isStopping('i1')).toBe(false);
  });

  it('treats a missing instance id as no alert rather than throwing', () => {
    const { store } = setup();
    expect(store.hasCriticalAlert(undefined)).toBe(false);
    expect(store.alertFor(undefined)).toBeNull();
  });

  it('a later detection replaces the earlier one for the same instance', () => {
    const { store, emit, critical } = setup();
    emit(critical);
    emit({ ...critical, toolName: 'Bash', count: 12 });
    expect(store.alertFor('i1')?.toolName).toBe('Bash');
  });

  it('unsubscribes from the channel when destroyed', () => {
    const { cleanups } = setup();
    TestBed.resetTestingModule();
    expect(cleanups()).toBe(1);
  });
});
