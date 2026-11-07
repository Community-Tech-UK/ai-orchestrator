import { describe, expect, it, vi } from 'vitest';
import { waitForPairing, WAITING_FOR_PAIRING_MESSAGE } from './wait-for-pairing';
import type { WorkerConfig } from './worker-config';

function config(overrides: Partial<WorkerConfig> = {}): WorkerConfig {
  return {
    nodeId: 'node-1',
    name: 'ct-test-mac',
    authToken: '',
    namespace: 'default',
    maxConcurrentInstances: 10,
    workingDirectories: [],
    reconnectIntervalMs: 5_000,
    heartbeatIntervalMs: 10_000,
    ...overrides,
  };
}

describe('waitForPairing', () => {
  it('reports waiting once, keeps the report fresh, and loads the config once it has an address', async () => {
    const status = { set: vi.fn(), touch: vi.fn() };
    const log = vi.fn();
    const mtimes = [1, 1, 1, 2];
    const modifiedAt = vi.fn(() => mtimes.shift() ?? 2);
    const readCoordinator = vi.fn(() => 'ws://192.168.0.95:4878');
    const load = vi.fn(() => config({ coordinatorUrl: 'ws://192.168.0.95:4878', authToken: 'pair-token' }));

    const paired = await waitForPairing({
      configPath: '/tmp/worker-node.json',
      status,
      load,
      readCoordinator,
      modifiedAt,
      sleep: async () => undefined,
      log,
    });

    expect(paired.coordinatorUrl).toBe('ws://192.168.0.95:4878');
    expect(status.set).toHaveBeenCalledTimes(1);
    expect(status.set).toHaveBeenCalledWith('waiting_for_pairing', { message: WAITING_FOR_PAIRING_MESSAGE });
    expect(status.touch).toHaveBeenCalledTimes(2);
    expect(readCoordinator).toHaveBeenCalledTimes(1);
    expect(load).toHaveBeenCalledTimes(1);
    expect(log.mock.calls.filter(([line]) => String(line).includes('not paired'))).toHaveLength(1);
  });

  it('only reads, never loads, an unpaired or half-written file while waiting', async () => {
    const status = { set: vi.fn(), touch: vi.fn() };
    // start 1; 2 unpaired; 2 unchanged; 3 unreadable; 3 again (retried, unpaired); 4 paired
    const mtimes = [1, 2, 2, 3, 3, 4];
    const modifiedAt = vi.fn(() => mtimes.shift() ?? 4);
    const readCoordinator = vi.fn()
      .mockReturnValueOnce(undefined)
      .mockImplementationOnce(() => { throw new Error('Unexpected end of JSON input'); })
      .mockReturnValueOnce(undefined)
      .mockReturnValueOnce('ws://192.168.0.95:4878');
    const load = vi.fn(() => config({ coordinatorUrl: 'ws://192.168.0.95:4878' }));

    const paired = await waitForPairing({
      configPath: '/tmp/worker-node.json',
      status,
      load,
      readCoordinator,
      modifiedAt,
      sleep: async () => undefined,
      log: vi.fn(),
    });

    expect(paired.coordinatorUrl).toBe('ws://192.168.0.95:4878');
    expect(readCoordinator).toHaveBeenCalledTimes(4);
    expect(load).toHaveBeenCalledTimes(1);
  });
});
