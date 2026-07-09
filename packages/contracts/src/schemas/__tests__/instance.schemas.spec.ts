import { describe, expect, it } from 'vitest';
import {
  InstanceChangeModelPayloadSchema,
  InstanceCreatePayloadSchema,
  InstanceCreateWithMessagePayloadSchema,
} from '../instance.schemas';

describe('instance.schemas', () => {
  const maxCatalogModelId = `${'m'.repeat(509)}-v1`;
  const tooLongCatalogModelId = `${'m'.repeat(510)}-v1`;

  it('accepts reasoning effort when changing a model', () => {
    expect(InstanceChangeModelPayloadSchema.parse({
      instanceId: 'instance-1',
      model: 'sonnet[1m]',
      reasoningEffort: 'max',
    })).toEqual({
      instanceId: 'instance-1',
      model: 'sonnet[1m]',
      reasoningEffort: 'max',
    });
  });

  it('accepts null reasoning effort to restore provider defaults', () => {
    expect(InstanceChangeModelPayloadSchema.parse({
      instanceId: 'instance-1',
      model: 'sonnet',
      reasoningEffort: null,
    }).reasoningEffort).toBeNull();
  });

  it('accepts local model runtime targets on model change payloads', () => {
    const modelRuntimeTarget = {
      kind: 'local-model',
      source: 'worker-node',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      modelId: 'qwen2.5',
    } as const;

    expect(InstanceChangeModelPayloadSchema.parse({
      instanceId: 'instance-1',
      model: 'qwen2.5',
      modelRuntimeTarget,
    }).modelRuntimeTarget).toEqual(modelRuntimeTarget);
  });

  it('accepts bare mode on instance creation payloads', () => {
    expect(InstanceCreatePayloadSchema.parse({
      workingDirectory: '/repo',
      provider: 'claude',
      bareMode: true,
    }).bareMode).toBe(true);
  });

  it('accepts bare mode on create-with-message payloads', () => {
    expect(InstanceCreateWithMessagePayloadSchema.parse({
      workingDirectory: '/repo',
      message: 'hello',
      provider: 'claude',
      bareMode: true,
    }).bareMode).toBe(true);
  });

  it('accepts yolo mode on create-with-message payloads', () => {
    expect(InstanceCreateWithMessagePayloadSchema.parse({
      workingDirectory: '/repo',
      message: 'delete the stale copy',
      provider: 'codex',
      yoloMode: true,
    }).yoloMode).toBe(true);
  });

  it('rejects local-model runtime targets without selectorId', () => {
    expect(InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/repo',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        nodeId: 'node-win',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        modelId: 'qwen',
      },
    }).success).toBe(false);
  });

  it('rejects worker local-model runtime targets without nodeId', () => {
    expect(InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/repo',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
        modelId: 'qwen',
      },
    }).success).toBe(false);

    expect(InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/repo',
      message: 'hello',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
        modelId: 'qwen',
      },
    }).success).toBe(false);
  });

  it('rejects worker local-model runtime targets whose selector disagrees with target fields', () => {
    expect(InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/repo',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        nodeId: 'node-other',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
        modelId: 'qwen',
      },
    }).success).toBe(false);

    expect(InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/repo',
      message: 'hello',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        nodeId: 'node-win',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
        modelId: 'other-model',
      },
    }).success).toBe(false);
  });

  it('rejects whitespace-only worker local-model node ids', () => {
    expect(InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/repo',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        nodeId: '   ',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen',
        modelId: 'qwen',
      },
    }).success).toBe(false);
  });

  it('rejects this-device local-model runtime targets with nodeId', () => {
    expect(InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/repo',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'this-device',
        nodeId: 'node-win',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        selectorId: 'lm://this-device/ollama/ollama/qwen',
        modelId: 'qwen',
      },
    }).success).toBe(false);

    expect(InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/repo',
      message: 'hello',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'this-device',
        nodeId: 'node-win',
        endpointProvider: 'ollama',
        endpointId: 'ollama',
        selectorId: 'lm://this-device/ollama/ollama/qwen',
        modelId: 'qwen',
      },
    }).success).toBe(false);
  });

  it('accepts catalog-length model ids on instance create and model change payloads', () => {
    expect(maxCatalogModelId).toHaveLength(512);

    expect(InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/repo',
      provider: 'claude',
      model: maxCatalogModelId,
    }).success).toBe(true);
    expect(InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/repo',
      message: 'hello',
      provider: 'claude',
      model: maxCatalogModelId,
    }).success).toBe(true);
    expect(InstanceChangeModelPayloadSchema.safeParse({
      instanceId: 'instance-1',
      model: maxCatalogModelId,
    }).success).toBe(true);
  });

  it('rejects model ids beyond the catalog override limit', () => {
    expect(tooLongCatalogModelId).toHaveLength(513);

    expect(InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/repo',
      provider: 'claude',
      model: tooLongCatalogModelId,
    }).success).toBe(false);
    expect(InstanceChangeModelPayloadSchema.safeParse({
      instanceId: 'instance-1',
      model: tooLongCatalogModelId,
    }).success).toBe(false);
  });

  it('accepts local model runtime targets on create payloads', () => {
    const modelRuntimeTarget = {
      kind: 'local-model',
      source: 'worker-node',
      endpointProvider: 'ollama',
      endpointId: 'ollama',
      selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5',
      nodeId: 'node-win',
      nodeName: 'windows-pc',
      modelId: 'qwen2.5',
    } as const;

    expect(InstanceCreatePayloadSchema.parse({
      workingDirectory: '/repo',
      provider: 'auto',
      model: 'qwen2.5',
      modelRuntimeTarget,
    }).modelRuntimeTarget).toEqual(modelRuntimeTarget);

    expect(InstanceCreateWithMessagePayloadSchema.parse({
      workingDirectory: '/repo',
      message: 'hello',
      provider: 'auto',
      model: 'qwen2.5',
      modelRuntimeTarget,
    }).modelRuntimeTarget).toEqual(modelRuntimeTarget);
  });

  it('rejects invalid local model runtime targets', () => {
    expect(InstanceCreatePayloadSchema.safeParse({
      workingDirectory: '/repo',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        endpointProvider: 'unknown',
        endpointId: 'ollama',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5',
        nodeId: 'node-win',
        modelId: 'qwen2.5',
      },
    }).success).toBe(false);

    expect(InstanceCreateWithMessagePayloadSchema.safeParse({
      workingDirectory: '/repo',
      message: 'hello',
      modelRuntimeTarget: {
        kind: 'local-model',
        source: 'worker-node',
        endpointProvider: 'ollama',
        endpointId: '',
        selectorId: 'lm://worker-node/node-win/ollama/ollama/qwen2.5',
        modelId: 'qwen2.5',
      },
    }).success).toBe(false);
  });
});
