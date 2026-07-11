import { describe, expect, it, vi } from 'vitest';
import type { LocalModelInventoryEntry } from '../../shared/types/local-model-runtime.types';
import { LocalReviewerQualificationController } from './local-reviewer-qualification-controller';

const SELECTOR = 'lm://this-device/ollama/ollama/qwen';

function entry(overrides: Partial<LocalModelInventoryEntry> = {}): LocalModelInventoryEntry {
  return {
    selectorId: SELECTOR,
    source: 'this-device',
    endpointProvider: 'ollama',
    endpointId: 'ollama',
    modelId: 'qwen',
    displayName: 'Qwen on This device',
    healthy: true,
    loaded: true,
    capabilities: { streaming: true, multiTurn: true, toolUse: 'none', vision: 'unknown' },
    discoveredAt: 1,
    ...overrides,
  };
}

describe('LocalReviewerQualificationController', () => {
  it('resolves and explicitly retries a healthy this-device model', async () => {
    const target = {
      kind: 'local-model' as const,
      selectorId: SELECTOR,
      source: 'this-device' as const,
      endpointProvider: 'ollama' as const,
      endpointId: 'ollama',
      modelId: 'qwen',
    };
    const retry = vi.fn().mockResolvedValue({ status: 'verified' });
    const controller = new LocalReviewerQualificationController(
      { list: () => [entry()], resolveTarget: () => target },
      { retry },
    );

    await expect(controller.qualify(SELECTOR)).resolves.toEqual({ status: 'verified' });
    expect(retry).toHaveBeenCalledWith(target);
  });

  it.each([
    ['worker model', entry({ source: 'worker-node', nodeId: 'node-1' }), 'this-device'],
    ['unhealthy model', entry({ healthy: false }), 'healthy'],
    ['cloud-backed model', entry({ modelId: 'qwen:cloud' }), 'Cloud'],
  ])('rejects a %s without probing', async (_label, model, reason) => {
    const retry = vi.fn();
    const controller = new LocalReviewerQualificationController(
      { list: () => [model], resolveTarget: vi.fn() },
      { retry },
    );

    await expect(controller.qualify(model.selectorId)).resolves.toMatchObject({
      status: 'unverified',
      reason: expect.stringContaining(reason),
    });
    expect(retry).not.toHaveBeenCalled();
  });

  it('returns a bounded unavailable result for a stale selector', async () => {
    const controller = new LocalReviewerQualificationController(
      { list: () => [], resolveTarget: vi.fn() },
      { retry: vi.fn() },
    );

    await expect(controller.qualify(SELECTOR)).resolves.toEqual({
      status: 'unverified',
      reason: 'Local model is no longer available.',
    });
  });
});
