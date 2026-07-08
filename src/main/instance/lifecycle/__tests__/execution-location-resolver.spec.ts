import { describe, expect, it } from 'vitest';
import { resolveExecutionLocation } from '../execution-location-resolver';

describe('resolveExecutionLocation', () => {
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
});
