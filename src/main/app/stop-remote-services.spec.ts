import { beforeEach, describe, expect, it, vi } from 'vitest';

const calls = vi.hoisted(() => [] as string[]);
const mocks = vi.hoisted(() => ({
  healthStopAll: vi.fn(),
  connectionStop: vi.fn(),
  workerModeStop: vi.fn(),
  thinClientStop: vi.fn(),
}));

vi.mock('../remote-node', () => ({
  getWorkerNodeHealth: () => ({ stopAll: mocks.healthStopAll }),
  getWorkerNodeConnectionServer: () => ({ stop: mocks.connectionStop }),
}));
vi.mock('../remote-node/worker-mode-runtime-service', () => ({
  getWorkerModeRuntimeService: () => ({ stop: mocks.workerModeStop }),
}));
vi.mock('../event-bus/thin-client-ws-server', () => ({
  getThinClientWsServer: () => ({ stop: mocks.thinClientStop }),
}));

import { stopRemoteServices } from './stop-remote-services';

describe('stopRemoteServices', () => {
  beforeEach(() => {
    calls.length = 0;
    mocks.healthStopAll.mockReset().mockImplementation(() => { calls.push('health'); });
    mocks.connectionStop.mockReset().mockImplementation(() => { calls.push('connection'); });
    mocks.workerModeStop.mockReset().mockImplementation(() => { calls.push('worker-mode'); });
    mocks.thinClientStop.mockReset().mockImplementation(async () => { calls.push('thin-client'); });
  });

  it('stops the Run-while-Harness-is-open worker with the app, in the established order', async () => {
    await stopRemoteServices();

    expect(mocks.workerModeStop).toHaveBeenCalledOnce();
    expect(calls).toEqual(['health', 'connection', 'worker-mode', 'thin-client']);
  });

  it('still stops the remaining services when the worker-mode stop throws', async () => {
    mocks.workerModeStop.mockImplementation(() => { throw new Error('boom'); });

    await expect(stopRemoteServices()).resolves.toBeUndefined();

    expect(mocks.workerModeStop).toHaveBeenCalledOnce();
    expect(mocks.thinClientStop).toHaveBeenCalledOnce();
  });

  it('still stops the worker when an earlier service throws', async () => {
    mocks.healthStopAll.mockImplementation(() => { throw new Error('boom'); });
    mocks.connectionStop.mockImplementation(() => { throw new Error('boom'); });

    await stopRemoteServices();

    expect(mocks.workerModeStop).toHaveBeenCalledOnce();
    expect(mocks.thinClientStop).toHaveBeenCalledOnce();
  });
});
