import { afterEach, describe, expect, it, vi } from 'vitest';
import { LocalModelInventoryService } from '../local-model-inventory-service';
import type { RemoteNodeRosterEntry } from '../../../shared/types/worker-node.types';

function makeWorker(
  overrides: Partial<RemoteNodeRosterEntry> = {},
): RemoteNodeRosterEntry {
  return {
    id: 'node-win',
    name: 'windows-pc',
    status: 'connected',
    platform: 'win32',
    arch: 'x64',
    address: '100.64.0.2',
    connected: true,
    supportedClis: ['claude'],
    hasBrowserRuntime: false,
    hasBrowserMcp: false,
    hasAndroidMcp: false,
    hasDocker: false,
    activeInstances: 0,
    maxConcurrentInstances: 4,
    workingDirectories: ['C:\\work'],
    capabilities: {
      platform: 'win32',
      arch: 'x64',
      cpuCores: 16,
      totalMemoryMB: 32768,
      availableMemoryMB: 22000,
      supportedClis: ['claude'],
      hasBrowserRuntime: false,
      hasBrowserMcp: false,
      hasAndroidMcp: false,
      hasDocker: false,
      maxConcurrentInstances: 4,
      workingDirectories: ['C:\\work'],
      browsableRoots: ['C:\\work'],
      discoveredProjects: [],
      localModelEndpoints: [{
        provider: 'ollama',
        endpointId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        models: ['qwen2.5-coder:14b'],
        loadedModels: [{ id: 'qwen2.5-coder:14b', contextLength: 32768 }],
        healthy: true,
      }],
    },
    ...overrides,
  };
}

function fakeRoster(nodes: RemoteNodeRosterEntry[]): { list(): RemoteNodeRosterEntry[] } {
  return { list: () => nodes };
}

describe('LocalModelInventoryService', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('builds one inventory row per worker model without exposing baseUrl', () => {
    vi.spyOn(Date, 'now').mockReturnValue(1783468800000);
    const svc = new LocalModelInventoryService({ roster: fakeRoster([makeWorker()]) });

    const rows = svc.list();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5-coder%3A14b',
      source: 'worker-node',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen2.5-coder:14b',
      displayName: 'qwen2.5-coder:14b on windows-pc',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      platform: 'win32',
      healthy: true,
      loaded: true,
      loadedContextLength: 32768,
      capabilities: {
        streaming: true,
        multiTurn: true,
        toolUse: 'none',
        vision: 'unknown',
      },
      discoveredAt: 1783468800000,
    });
    expect(JSON.stringify(rows)).not.toContain('127.0.0.1');
  });

  it('resolves a healthy worker model into a runtime target', () => {
    const svc = new LocalModelInventoryService({ roster: fakeRoster([makeWorker()]) });
    const target = svc.resolveTarget(svc.list()[0].selectorId);

    expect(target).toMatchObject({
      kind: 'local-model',
      source: 'worker-node',
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5-coder%3A14b',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'qwen2.5-coder:14b',
    });
  });

  it('rejects unavailable worker model targets', () => {
    const worker = makeWorker({
      capabilities: {
        ...makeWorker().capabilities,
        localModelEndpoints: [{
          provider: 'openai-compatible',
          endpointId: 'openai-compatible',
          baseUrl: 'http://127.0.0.1:1234',
          models: ['qwen'],
          healthy: false,
        }],
      },
    });
    const svc = new LocalModelInventoryService({ roster: fakeRoster([worker]) });

    expect(() => svc.resolveTarget(svc.list()[0].selectorId)).toThrow(
      'Local model is no longer available',
    );
  });

  it('keeps disconnected worker models visible as unhealthy inventory rows', () => {
    const svc = new LocalModelInventoryService({
      roster: fakeRoster([makeWorker({
        status: 'disconnected',
        connected: false,
      })]),
    });

    const rows = svc.list();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5-coder%3A14b',
      healthy: false,
      loaded: true,
      nodeId: 'node-win',
      nodeName: 'windows-pc',
    });
    expect(() => svc.resolveTarget(rows[0].selectorId)).toThrow(
      'Local model is no longer available',
    );
  });

  it('refreshes coordinator-local model rows without exposing loopback URLs', async () => {
    vi.spyOn(Date, 'now').mockReturnValue(1783468800000);
    const svc = new LocalModelInventoryService({
      roster: fakeRoster([]),
      thisDeviceProbe: async () => [{
        provider: 'openai-compatible',
        endpointId: 'openai-compatible',
        baseUrl: 'http://127.0.0.1:1234',
        models: ['qwen-local'],
        loadedModels: [{ id: 'qwen-local', contextLength: 32768 }],
        healthy: true,
      }],
    });

    const rows = await svc.refresh();

    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      selectorId: 'lm://this-device/openai-compatible/openai-compatible/qwen-local',
      source: 'this-device',
      endpointProvider: 'openai-compatible',
      endpointId: 'openai-compatible',
      modelId: 'qwen-local',
      displayName: 'qwen-local on This device',
      healthy: true,
      loaded: true,
      loadedContextLength: 32768,
      discoveredAt: 1783468800000,
    });
    expect(JSON.stringify(rows)).not.toContain('127.0.0.1');
  });

  it('resolves coordinator-local model targets from refreshed inventory', async () => {
    const svc = new LocalModelInventoryService({
      roster: fakeRoster([]),
      thisDeviceProbe: async () => [{
        provider: 'ollama',
        endpointId: 'ollama',
        baseUrl: 'http://127.0.0.1:11434',
        models: ['llama3.2'],
        healthy: true,
      }],
    });

    const rows = await svc.refresh();
    const target = svc.resolveTarget(rows[0].selectorId);

    expect(target).toEqual({
      kind: 'local-model',
      selectorId: 'lm://this-device/ollama/ollama/llama3.2',
      source: 'this-device',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      modelId: 'llama3.2',
    });
  });
});
