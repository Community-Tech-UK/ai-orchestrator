import { describe, expect, it, vi } from 'vitest';
import { awaitInstanceInputReady, type InputReadyHost } from './instance-input-ready';
import type { Instance } from '../../shared/types/instance.types';

function session(status: Instance['status']): Instance {
  return { id: 'inst-1', status } as unknown as Instance;
}

function host(instance: Instance, overrides: Partial<InputReadyHost> = {}): InputReadyHost {
  return {
    wake: vi.fn(async () => { instance.status = 'idle'; }),
    runtimeChangeSettled: vi.fn(() => undefined),
    waitWithBudget: vi.fn((work: Promise<void>) => work),
    getInstance: (id) => (id === instance.id ? instance : undefined),
    ...overrides,
  };
}

describe('awaitInstanceInputReady — queued runtime changes', () => {
  it('holds a send to a sleeping session until the account move the wake set off has finished', async () => {
    const instance = session('hibernated');
    let finishMove!: () => void;
    const move = new Promise<void>((resolve) => { finishMove = resolve; });
    let moveInFlight = false;
    const h = host(instance, {
      // As in the app: the wake settles the session, which schedules the parked move.
      wake: vi.fn(async () => { instance.status = 'idle'; moveInFlight = true; }),
      runtimeChangeSettled: vi.fn(() => (moveInFlight ? move : undefined)),
    });

    let delivered = false;
    const ready = awaitInstanceInputReady(h, instance).then(() => { delivered = true; });
    await new Promise((resolve) => setImmediate(resolve));
    expect(h.wake).toHaveBeenCalledWith('inst-1');
    expect(delivered).toBe(false);

    finishMove();
    await ready;
    expect(delivered).toBe(true);
    expect(h.waitWithBudget).toHaveBeenCalledWith(move, instance, 'Instance runtime change timed out');
  });

  it('catches a move that an interrupt respawn sets off when it settles', async () => {
    const instance = session('respawning');
    let finishRespawn!: () => void;
    let finishMove!: () => void;
    const move = new Promise<void>((resolve) => { finishMove = resolve; });
    let moveInFlight = false;
    instance.respawnPromise = new Promise<void>((resolve) => { finishRespawn = resolve; })
      .then(() => { instance.status = 'idle'; moveInFlight = true; });
    const h = host(instance, { runtimeChangeSettled: vi.fn(() => (moveInFlight ? move : undefined)) });

    let delivered = false;
    const ready = awaitInstanceInputReady(h, instance).then(() => { delivered = true; });
    finishRespawn();
    await new Promise((resolve) => setImmediate(resolve));
    expect(delivered).toBe(false);

    finishMove();
    await ready;
    expect(delivered).toBe(true);
  });

  it('does not wait when nothing is moving', async () => {
    const instance = session('idle');
    const h = host(instance);
    await awaitInstanceInputReady(h, instance);
    expect(h.waitWithBudget).not.toHaveBeenCalled();
  });

  it('refuses the send if the change left the session unusable', async () => {
    const instance = session('idle');
    const h = host(instance, {
      runtimeChangeSettled: vi.fn(async () => { instance.status = 'failed'; }),
    });
    await expect(awaitInstanceInputReady(h, instance)).rejects.toThrow('terminated while waiting to deliver input');
  });

  it('passes on a change that outlives the wait budget so the renderer can re-queue', async () => {
    const instance = session('idle');
    const h = host(instance, {
      runtimeChangeSettled: vi.fn(() => new Promise<void>(() => undefined)),
      waitWithBudget: vi.fn(async (_work: Promise<void>, _instance: Instance, message: string) => { throw new Error(message); }),
    });
    await expect(awaitInstanceInputReady(h, instance)).rejects.toThrow('Instance runtime change timed out');
  });
});
