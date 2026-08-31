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

  it('omits crash-recovery cursor and transcript material from hook diagnostics', () => {
    const config: InstanceCreateConfig = {
      workingDirectory: '/tmp/project',
      sessionId: 'cursor-fixture-placeholder',
      historyThreadId: 'history-thread-fixture-placeholder',
      resume: true,
      initialOutputBuffer: [{
        id: 'message-fixture-id',
        timestamp: 1,
        type: 'tool_result',
        content: 'message-content-fixture-placeholder',
        metadata: { output: 'tool-output-fixture-placeholder' },
      }],
      metadata: {
        reason: 'crash-recovery',
        continuityRevival: true,
        sourceInstanceId: 'source-instance-fixture-placeholder',
      },
    };

    const sanitized = sanitizeCreateConfig(config) as Record<string, unknown>;
    const serialized = JSON.stringify(sanitized);

    expect(sanitized['sessionId']).toBe('[recovery session omitted]');
    expect(serialized).not.toContain('cursor-fixture-placeholder');
    expect(serialized).not.toContain('history-thread-fixture-placeholder');
    expect(serialized).not.toContain('source-instance-fixture-placeholder');
    expect(serialized).not.toContain('message-content-fixture-placeholder');
    expect(serialized).not.toContain('tool-output-fixture-placeholder');
  });
});
