import { describe, expect, it, vi } from 'vitest';
import type { WorkerNodeInfo } from '../../../../shared/types/worker-node.types';
import { resolveExecutionLocation } from '../execution-location-resolver';

describe('resolveExecutionLocation', () => {
  it('adds the native OpenCode 2 requirement before automatic worker selection', () => {
    const selectNode = vi.fn(() => ({ id: 'v2-worker' } as WorkerNodeInfo));
    expect(resolveExecutionLocation({ workingDirectory: '/repo', provider: 'opencode',
      additionalDirectories: ['C:\\shared'], nodePlacement: { preferPlatform: 'win32' } },
    { getNode: vi.fn(), selectNode })).toEqual({ type: 'remote', nodeId: 'v2-worker' });
    expect(selectNode).toHaveBeenCalledWith({ preferPlatform: 'win32', requiresCli: 'opencode', requiresOpenCodeMajor: 2 });
  });
  it('rejects an explicit v1 requirement rather than replacing it', () => {
    expect(() => resolveExecutionLocation({ workingDirectory: '/repo', provider: 'opencode',
      additionalDirectories: ['/shared'], nodePlacement: { requiresOpenCodeMajor: 1 } })).toThrow(/conflicts/);
  });
  it.each([undefined, 1])('rejects a forced worker with unknown/v1 OpenCode (%s) before routing', major => {
    expect(() => resolveExecutionLocation({ workingDirectory: '/repo', provider: 'opencode',
      additionalDirectories: ['/shared'], forceNodeId: 'old-worker' },
    { getNode: () => ({ status: 'connected', capabilities: { openCodeMajor: major } } as WorkerNodeInfo), selectNode: vi.fn() })).toThrow(/OpenCode 2/);
  });
  it('forces worker-node local-model targets onto their selected node', () => {
    expect(resolveExecutionLocation({
      workingDirectory: '/tmp/project',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
        nodeId: 'node-win',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
      },
    })).toEqual({ type: 'remote', nodeId: 'node-win' });
  });

  it('keeps coordinator-local local-model targets on this device', () => {
    expect(resolveExecutionLocation({
      workingDirectory: '/tmp/project',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'this-device',
        selectorId: 'lm://this-device/openai-compatible/openai-compatible/qwen',
        endpointProvider: 'openai-compatible',
        endpointId: 'openai-compatible',
        modelId: 'qwen',
      },
    })).toEqual({ type: 'local' });
  });

  it('rejects worker-node local-model targets without a node id', () => {
    expect(() => resolveExecutionLocation({
      workingDirectory: '/tmp/project',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
      },
    })).toThrow('Worker local-model runtime targets require a nodeId');
  });

  it('rejects worker-node local-model targets whose selector points at another node', () => {
    expect(() => resolveExecutionLocation({
      workingDirectory: '/tmp/project',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
        nodeId: 'node-other',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
      },
    })).toThrow('Local model runtime target does not match its selector');
  });

  it('rejects this-device local-model targets that include a node id', () => {
    expect(() => resolveExecutionLocation({
      workingDirectory: '/tmp/project',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'this-device',
        selectorId: 'lm://this-device/ollama/ollama/qwen',
        nodeId: 'node-win',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
      },
    })).toThrow('this-device local-model runtime targets cannot include nodeId');
  });

  it('fails closed instead of falling back locally when a forced node is unavailable', () => {
    expect(() => resolveExecutionLocation({
      workingDirectory: '/tmp/project',
      forceNodeId: 'disconnected-node',
    })).toThrow(/forced worker node "disconnected-node" is unavailable/i);
  });
});
