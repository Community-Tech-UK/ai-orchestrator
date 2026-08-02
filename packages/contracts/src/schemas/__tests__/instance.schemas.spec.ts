import { describe, expect, it } from 'vitest';
import {
  InstanceChangeModelPayloadSchema,
  InstanceCreatePayloadSchema,
  InstanceCreateWithMessagePayloadSchema,
  InstanceCompactStatusEventSchema,
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

  it('accepts a target provider for a cross-provider swap', () => {
    expect(InstanceChangeModelPayloadSchema.parse({
      instanceId: 'instance-1',
      model: 'gpt-5.5',
      provider: 'codex',
    }).provider).toBe('codex');
  });

  it('allows omitting the model when a provider is given (remembered default wins)', () => {
    const parsed = InstanceChangeModelPayloadSchema.parse({
      instanceId: 'instance-1',
      provider: 'codex',
    });
    expect(parsed.model).toBeUndefined();
    expect(parsed.provider).toBe('codex');
  });

  it('rejects payloads with neither model nor provider', () => {
    expect(InstanceChangeModelPayloadSchema.safeParse({
      instanceId: 'instance-1',
      reasoningEffort: 'high',
    }).success).toBe(false);
  });

  it('rejects the auto sentinel as a swap target', () => {
    expect(InstanceChangeModelPayloadSchema.safeParse({
      instanceId: 'instance-1',
      provider: 'auto',
    }).success).toBe(false);
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

  it('accepts reasoning effort on instance creation payloads', () => {
    // The field was missing entirely, so the picker's chosen effort could never
    // reach a new session and every fresh spawn fell back to the CLI default.
    expect(InstanceCreatePayloadSchema.parse({
      workingDirectory: '/repo',
      provider: 'codex',
      reasoningEffort: 'high',
    }).reasoningEffort).toBe('high');

    expect(InstanceCreateWithMessagePayloadSchema.parse({
      workingDirectory: '/repo',
      message: 'hello',
      provider: 'codex',
      reasoningEffort: 'high',
    }).reasoningEffort).toBe('high');
  });

  it('leaves reasoning effort unset on creation payloads that omit it', () => {
    expect(InstanceCreatePayloadSchema.parse({
      workingDirectory: '/repo',
      provider: 'codex',
    }).reasoningEffort).toBeUndefined();
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

/**
 * LT-018. `ContextUsageEventSchema` is `.strict()`, so an unknown key does not
 * get stripped — `safeParse` fails and `validateRendererEventPayload` drops the
 * whole event before `webContents.send`. `previousUsage`/`newUsage` are fed the
 * live `ContextUsage`, which carries `occupancyReported` whenever a provider
 * reports real occupancy — the ordinary case for a compaction, since compaction
 * is triggered *because* a real threshold was crossed. Omitting the field from
 * this schema therefore blocked `instance:compact-status` `completed` almost
 * every time, leaving the renderer permanently showing "compacting".
 */
describe('InstanceCompactStatusEventSchema contextUsage (LT-018)', () => {
  const usage = { used: 190_000, total: 200_000, percentage: 95, occupancyReported: true };

  it('accepts a completed event whose usage carries occupancyReported', () => {
    const parsed = InstanceCompactStatusEventSchema.safeParse({
      instanceId: 'inst-1',
      status: 'completed',
      success: true,
      method: 'native',
      blocking: false,
      previousUsage: usage,
      newUsage: { ...usage, used: 0, percentage: 0 },
    });

    expect(parsed.success).toBe(true);
  });

  it('still rejects a genuinely unknown key, so strictness is not weakened', () => {
    const parsed = InstanceCompactStatusEventSchema.safeParse({
      instanceId: 'inst-1',
      status: 'completed',
      success: true,
      method: 'native',
      blocking: false,
      previousUsage: { ...usage, bogusField: 1 },
    });

    expect(parsed.success).toBe(false);
  });
});
