import { beforeEach, describe, expect, it, vi } from 'vitest';

// Hoisted: the module under test builds its logger at import time, which runs
// before plain `const` initializers in this file.
const {
  mockResolveAuxiliaryWorkerModels,
  mockListOllamaModels,
  mockListOpenAiCompatibleModels,
  mockWarn,
} = vi.hoisted(() => ({
  mockResolveAuxiliaryWorkerModels: vi.fn(),
  mockListOllamaModels: vi.fn(),
  mockListOpenAiCompatibleModels: vi.fn(),
  mockWarn: vi.fn(),
}));

vi.mock('../auxiliary-discovery', () => ({
  resolveAuxiliaryWorkerModels: (...args: unknown[]) => mockResolveAuxiliaryWorkerModels(...args),
}));

vi.mock('../auxiliary-model-client', () => ({
  listOllamaModels: (...args: unknown[]) => mockListOllamaModels(...args),
  listOpenAiCompatibleModels: (...args: unknown[]) => mockListOpenAiCompatibleModels(...args),
  probeOllamaEndpoint: vi.fn(),
  probeOpenAiCompatibleEndpoint: vi.fn(),
}));

vi.mock('../auxiliary-api-key-resolver', () => ({
  resolveAuxiliaryEndpointApiKey: vi.fn(async () => undefined),
}));

vi.mock('../auxiliary-remote-hooks', () => ({
  auxiliaryRemoteHooks: { isNodeConnected: vi.fn(() => true), connectedWorkerNodes: vi.fn(() => []) },
}));

vi.mock('../auxiliary-llm-utils', () => ({
  workerEndpointHealthy: vi.fn(() => true),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: mockWarn, error: vi.fn(), debug: vi.fn() }),
}));

import {
  AuxiliaryResolutionWarningThrottle,
  listAuxiliaryModelsForRouting,
} from '../auxiliary-routing-diagnostics';

const workerEndpoint = {
  id: 'worker:node-1:ollama:127.0.0.1:11434',
  label: 'worker ollama',
  provider: 'ollama' as const,
  baseUrl: 'http://127.0.0.1:11434',
  enabled: true,
  source: 'worker-node' as const,
  workerNodeId: 'node-1',
};

describe('listAuxiliaryModelsForRouting', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('reports a real inventory as not-probe-failed', async () => {
    mockResolveAuxiliaryWorkerModels.mockResolvedValue([{ id: 'gemma4:31b' }, { id: 'gpt-oss:20b' }]);

    const inventory = await listAuxiliaryModelsForRouting(workerEndpoint, true);

    expect(inventory).toEqual({ ids: ['gemma4:31b', 'gpt-oss:20b'], probeFailed: false });
  });

  it('distinguishes an endpoint that genuinely advertises nothing', async () => {
    mockResolveAuxiliaryWorkerModels.mockResolvedValue([]);

    const inventory = await listAuxiliaryModelsForRouting(workerEndpoint, true);

    expect(inventory).toEqual({ ids: [], probeFailed: false });
  });

  it('flags a failed probe rather than reporting an empty inventory', async () => {
    // A 5s RPC timeout against a busy worker used to be indistinguishable from
    // "this endpoint has no models". Both still fall back, but they point at
    // completely different faults, so the recorded reason must tell them apart.
    mockResolveAuxiliaryWorkerModels.mockRejectedValue(new Error('RPC request timed out'));

    const inventory = await listAuxiliaryModelsForRouting(workerEndpoint, true);

    expect(inventory.probeFailed).toBe(true);
    expect(inventory.ids).toEqual([]);
    expect(mockWarn).toHaveBeenCalledWith(
      expect.stringContaining('inventory probe failed'),
      expect.objectContaining({ endpointId: workerEndpoint.id }),
    );
  });
});

describe('AuxiliaryResolutionWarningThrottle', () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('warns once per slot+reason inside the window, then again after it', () => {
    const throttle = new AuxiliaryResolutionWarningThrottle();

    throttle.warn('titleGeneration', 'health-unavailable', 0);
    throttle.warn('titleGeneration', 'health-unavailable', 60_000);
    expect(mockWarn).toHaveBeenCalledTimes(1);

    throttle.warn('titleGeneration', 'health-unavailable', 10 * 60_000);
    expect(mockWarn).toHaveBeenCalledTimes(2);
  });

  it('does not let one slot suppress a different slot or reason', () => {
    const throttle = new AuxiliaryResolutionWarningThrottle();

    throttle.warn('titleGeneration', 'health-unavailable', 0);
    throttle.warn('compression', 'health-unavailable', 0);
    throttle.warn('titleGeneration', 'role-not-routable', 0);

    expect(mockWarn).toHaveBeenCalledTimes(3);
  });
});
