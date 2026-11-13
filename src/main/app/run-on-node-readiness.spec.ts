import { EventEmitter } from 'node:events';
import { describe, expect, it } from 'vitest';
import type { Instance } from '../../shared/types/instance.types';
import { waitForRunOnNodeReadiness } from './run-on-node-readiness';

function setup() {
  const manager = new EventEmitter();
  const controller = new AbortController();
  let complete!: () => void;
  let fail!: (error: Error) => void;
  let dispatched = false;
  const readyPromise = new Promise<void>((resolve, reject) => { complete = resolve; fail = reject; });
  const instance = { id: 'remote', status: 'initializing', readyPromise } as Instance;
  const startup = { signal: controller.signal, wasDispatched: (id: string) => id === instance.id && dispatched };
  const change = (status: Instance['status'], id = instance.id): void => {
    if (id === instance.id) instance.status = status;
    manager.emit('instance:state-changed', { instanceId: id, status });
  };
  return { manager, instance, startup, complete, fail, controller, change, dispatch: () => { dispatched = true; } };
}

describe('run_on_node initial input readiness', () => {
  it('ignores spawn activity and other sessions, then returns while the dispatched turn remains pending', async () => {
    const h = setup();
    let returned = false;
    const waiting = waitForRunOnNodeReadiness(h.manager, h.instance, h.startup).then(() => { returned = true; });
    h.change('busy');
    await Promise.resolve();
    expect(returned).toBe(false);
    h.dispatch(); h.change('idle'); h.change('busy', 'other');
    await Promise.resolve();
    expect(returned).toBe(false);
    h.change('busy');
    await waiting;
    expect(h.manager.listenerCount('instance:state-changed')).toBe(0);
    h.complete();
  });

  it('recognises input already dispatched before the listener attaches', async () => {
    const h = setup(); h.dispatch(); h.change('busy');
    await waitForRunOnNodeReadiness(h.manager, h.instance, h.startup);
    expect(h.manager.listenerCount('instance:state-changed')).toBe(0);
    h.complete();
  });

  it('propagates startup rejection and removes its listener', async () => {
    const h = setup();
    const waiting = waitForRunOnNodeReadiness(h.manager, h.instance, h.startup);
    h.fail(new Error('Worker account rejected'));
    await expect(waiting).rejects.toThrow('Worker account rejected');
    expect(h.manager.listenerCount('instance:state-changed')).toBe(0);
  });

  it('settles through readiness when initial input is held instead of dispatched', async () => {
    const h = setup();
    const waiting = waitForRunOnNodeReadiness(h.manager, h.instance, h.startup);
    h.change('idle'); h.complete();
    await waiting;
    expect(h.manager.listenerCount('instance:state-changed')).toBe(0);
  });

  it('propagates cancellation while leaving initialization owned by the caller', async () => {
    const h = setup();
    const waiting = waitForRunOnNodeReadiness(h.manager, h.instance, h.startup);
    h.controller.abort(new Error('Startup cancelled'));
    await expect(waiting).rejects.toThrow('Startup cancelled');
    expect(h.manager.listenerCount('instance:state-changed')).toBe(0);
    h.complete();
  });
});
