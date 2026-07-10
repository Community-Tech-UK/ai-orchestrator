import { describe, it, expect, vi, beforeEach } from 'vitest';
import { YoloModeQueue, type YoloModeQueueDeps } from './yolo-mode-queue';
import type { Instance, InstanceStatus } from '../../../shared/types/instance.types';

/** Flush pending setImmediate callbacks. */
const flushMacrotasks = () => new Promise<void>((resolve) => setImmediate(resolve));

function makeInstance(status: InstanceStatus, yoloMode: boolean): Instance {
  return {
    id: 'inst-1',
    status,
    yoloMode,
    pendingYoloMode: undefined,
  } as unknown as Instance;
}

interface Harness {
  instance: Instance;
  queue: YoloModeQueue;
  setYoloMode: ReturnType<typeof vi.fn>;
  queueUpdate: ReturnType<typeof vi.fn>;
  emitYoloToggled: ReturnType<typeof vi.fn>;
}

function makeHarness(
  instance: Instance,
  setYoloImpl?: (id: string, desired: boolean) => Promise<Instance>,
): Harness {
  const setYoloMode = vi.fn(
    setYoloImpl ??
      (async (_id: string, desired: boolean) => {
        // Mirror the real setYoloMode: flip the live value + clear pending.
        instance.yoloMode = desired;
        instance.pendingYoloMode = undefined;
        return instance;
      }),
  );
  const queueUpdate = vi.fn();
  const emitYoloToggled = vi.fn();
  const deps: YoloModeQueueDeps = {
    getInstance: (id) => (id === instance.id ? instance : undefined),
    setYoloMode: setYoloMode as unknown as YoloModeQueueDeps['setYoloMode'],
    queueUpdate,
    emitYoloToggled,
  };
  return { instance, queue: new YoloModeQueue(deps), setYoloMode, queueUpdate, emitYoloToggled };
}

describe('YoloModeQueue', () => {
  beforeEach(() => vi.clearAllMocks());

  it('applies immediately when the instance is settled (idle)', async () => {
    const h = makeHarness(makeInstance('idle', false));
    await h.queue.requestToggle('inst-1');
    expect(h.setYoloMode).toHaveBeenCalledWith('inst-1', true);
    expect(h.instance.yoloMode).toBe(true);
    expect(h.instance.pendingYoloMode).toBeUndefined();
  });

  it('queues (does not apply) while busy and emits the pending state', async () => {
    const h = makeHarness(makeInstance('busy', false));
    await h.queue.requestToggle('inst-1');
    expect(h.setYoloMode).not.toHaveBeenCalled();
    expect(h.instance.pendingYoloMode).toBe(true);
    expect(h.instance.yoloMode).toBe(false);
    expect(h.emitYoloToggled).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      yoloMode: false,
      pendingYoloMode: true,
    });
  });

  it('cancels the pending change when toggled back while still busy', async () => {
    const h = makeHarness(makeInstance('busy', false));
    await h.queue.requestToggle('inst-1'); // queue ON
    expect(h.instance.pendingYoloMode).toBe(true);
    await h.queue.requestToggle('inst-1'); // toggle back to live (OFF) -> cancel
    expect(h.instance.pendingYoloMode).toBeUndefined();
    expect(h.setYoloMode).not.toHaveBeenCalled();
  });

  it('auto-applies a queued change when the instance settles', async () => {
    const inst = makeInstance('busy', false);
    const h = makeHarness(inst);
    await h.queue.requestToggle('inst-1'); // pending = true
    expect(h.setYoloMode).not.toHaveBeenCalled();

    // Simulate the turn finishing.
    inst.status = 'idle';
    h.queue.onSettled(inst);
    await flushMacrotasks();

    expect(h.setYoloMode).toHaveBeenCalledWith('inst-1', true);
    expect(inst.yoloMode).toBe(true);
    expect(inst.pendingYoloMode).toBeUndefined();
  });

  it('onSettled is a no-op when nothing is pending', async () => {
    const inst = makeInstance('idle', false);
    const h = makeHarness(inst);
    h.queue.onSettled(inst);
    await flushMacrotasks();
    expect(h.setYoloMode).not.toHaveBeenCalled();
  });

  it('does not schedule twice for overlapping settle transitions', async () => {
    const inst = makeInstance('idle', false);
    inst.pendingYoloMode = true;
    const h = makeHarness(inst);
    h.queue.onSettled(inst);
    h.queue.onSettled(inst); // second call before the macrotask runs
    await flushMacrotasks();
    expect(h.setYoloMode).toHaveBeenCalledTimes(1);
  });

  it('falls back to queuing when a settled apply loses a race to a new turn', async () => {
    const inst = makeInstance('idle', false);
    const h = makeHarness(inst, async () => {
      // A new turn started the instant we tried to apply.
      inst.status = 'busy';
      throw new Error('Cannot change YOLO mode while instance is busy.');
    });
    await h.queue.requestToggle('inst-1');
    expect(h.setYoloMode).toHaveBeenCalledTimes(1);
    // Instead of surfacing the error, it parked the request.
    expect(inst.pendingYoloMode).toBe(true);
    expect(h.emitYoloToggled).toHaveBeenCalledWith({
      instanceId: 'inst-1',
      yoloMode: false,
      pendingYoloMode: true,
    });
  });

  it('retries on the next settle if the apply runs while busy', async () => {
    const inst = makeInstance('busy', false);
    inst.pendingYoloMode = true;
    const h = makeHarness(inst);
    // onSettled guards on settled status, but force-schedule via a ready->busy race:
    inst.status = 'ready';
    h.queue.onSettled(inst);
    inst.status = 'busy'; // became busy again before the macrotask fires
    await flushMacrotasks();
    expect(h.setYoloMode).not.toHaveBeenCalled();
    expect(inst.pendingYoloMode).toBe(true); // retained for the next idle

    // Next genuine settle applies it.
    inst.status = 'idle';
    h.queue.onSettled(inst);
    await flushMacrotasks();
    expect(h.setYoloMode).toHaveBeenCalledWith('inst-1', true);
  });
});
