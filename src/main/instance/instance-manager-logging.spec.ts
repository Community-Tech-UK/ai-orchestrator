import { describe, expect, it } from 'vitest';
import type { InstanceCreateConfig } from '../../shared/types/instance.types';
import { sanitizeCreateConfig } from './instance-manager-logging';

describe('sanitizeCreateConfig', () => {
  it('summarizes local-model runtime targets without endpoint URLs or secrets', () => {
    const config = {
      workingDirectory: '/tmp/project',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        selectorId: 'lm://worker-node/node-win/openai-compatible/openai-compatible/qwen',
        nodeId: 'node-win',
        nodeName: 'windows-pc',
        endpointProvider: 'openai-compatible',
        endpointId: 'openai-compatible',
        modelId: 'qwen',
        baseUrl: 'http://127.0.0.1:1234/v1',
        apiKey: 'secret-value',
      },
    } as unknown as InstanceCreateConfig;

    const sanitized = sanitizeCreateConfig(config) as Record<string, unknown>;

    expect(sanitized['modelRuntimeTarget']).toEqual({
      kind: 'local-model',
      source: 'worker-node',
      selectorId: 'lm://worker-node/node-win/openai-compatible/openai-compatible/qwen',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      endpointProvider: 'openai-compatible',
      endpointId: 'openai-compatible',
      modelId: 'qwen',
    });
    expect(JSON.stringify(sanitized)).not.toContain('127.0.0.1');
    expect(JSON.stringify(sanitized)).not.toContain('secret-value');
  });
});
