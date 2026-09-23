import { EventEmitter } from 'events';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import type { IpcResponse } from '../../shared/types/ipc.types';

type IpcHandler = (event: unknown, payload?: unknown) => Promise<IpcResponse>;
const handlers = vi.hoisted(() => new Map<string, IpcHandler>());

vi.mock('electron', () => ({
  ipcMain: {
    handle: vi.fn((channel: string, handler: IpcHandler) => {
      handlers.set(channel, handler);
    }),
  },
}));

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ debug: vi.fn(), error: vi.fn(), info: vi.fn(), warn: vi.fn() }),
}));

import { IPC_CHANNELS } from '../../shared/types/ipc.types';
import { _resetActionCircuitBreakerForTesting, getActionCircuitBreaker } from './action-circuit-breaker';
import { registerCircuitBreaker } from './circuit-breaker-registration';

function invoke(channel: string, payload?: unknown): Promise<IpcResponse> {
  const handler = handlers.get(channel);
  if (!handler) throw new Error(`No handler registered for ${channel}`);
  return handler({}, payload);
}

describe('registerCircuitBreaker', () => {
  beforeEach(() => {
    handlers.clear();
    _resetActionCircuitBreakerForTesting();
    registerCircuitBreaker({ costTracker: new EventEmitter() as never });
  });

  it('applies a valid config and returns the resulting config', async () => {
    const result = await invoke(IPC_CHANNELS.CIRCUIT_BREAKER_SET, { maxActions: 25, maxCostUsd: 2.5 });

    expect(result).toEqual({ success: true, data: { maxActions: 25, maxCostUsd: 2.5 } });
    expect(getActionCircuitBreaker().getConfig()).toEqual({ maxActions: 25, maxCostUsd: 2.5 });
  });

  it('keeps omitted fields unchanged (partial update, including an empty payload)', async () => {
    await invoke(IPC_CHANNELS.CIRCUIT_BREAKER_SET, { maxActions: 10, maxCostUsd: 1 });
    await invoke(IPC_CHANNELS.CIRCUIT_BREAKER_SET, { maxCostUsd: 3 });
    await invoke(IPC_CHANNELS.CIRCUIT_BREAKER_SET, undefined);

    expect(getActionCircuitBreaker().getConfig()).toEqual({ maxActions: 10, maxCostUsd: 3 });
  });

  it.each([
    ['a non-object payload', 'ten'],
    ['a string maxActions', { maxActions: '10' }],
    ['a negative maxCostUsd', { maxCostUsd: -1 }],
    ['an infinite maxActions', { maxActions: Number.POSITIVE_INFINITY }],
  ])('rejects %s without changing the config', async (_label, payload) => {
    const before = getActionCircuitBreaker().getConfig();

    const result = await invoke(IPC_CHANNELS.CIRCUIT_BREAKER_SET, payload);

    expect(result.success).toBe(false);
    expect(result.error?.code).toBe('VALIDATION_FAILED');
    expect(getActionCircuitBreaker().getConfig()).toEqual(before);
  });
});
