import { describe, it, expect } from 'vitest';
import {
  modelSizeScore,
  pickModelForTier,
  resolveSlotModel,
  workerEndpointHealthy,
  endpointAdvertisesModel,
  backfillSlotTiers,
  DEFAULT_SLOT_TIERS,
} from '../auxiliary-llm-utils';
import type { AuxiliaryLlmSlotConfig } from '../../../shared/types/auxiliary-llm.types';
import type { WorkerNodeInfo } from '../../../shared/types/worker-node.types';

function slot(overrides: Partial<AuxiliaryLlmSlotConfig> = {}): AuxiliaryLlmSlotConfig {
  return {
    enabled: true,
    provider: 'auto',
    maxInputTokens: 16000,
    maxOutputTokens: 512,
    temperature: 0,
    timeoutMs: 30000,
    requireJson: false,
    allowFrontierFallback: false,
    ...overrides,
  };
}

describe('modelSizeScore', () => {
  it('extracts the largest <n>b marker', () => {
    expect(modelSizeScore('qwen/qwen3.6-35b-a3b')).toBe(35);
    expect(modelSizeScore('nvidia/nemotron-3-nano-4b')).toBe(4);
    expect(modelSizeScore('google/gemma-4-26b-a4b')).toBe(26);
    expect(modelSizeScore('qwen/qwen3.5-9b')).toBe(9);
  });

  it('returns 0 when there is no size marker', () => {
    expect(modelSizeScore('text-embedding-nomic-embed-text-v1.5')).toBe(0);
    expect(modelSizeScore('qwen3-coder-next')).toBe(0);
  });
});

describe('pickModelForTier', () => {
  const models = ['qwen/qwen3.6-35b-a3b', 'nvidia/nemotron-3-nano-4b', 'qwen/qwen3.5-9b'];

  it('picks the smallest model for the quick tier', () => {
    expect(pickModelForTier(models, 'quick')).toBe('nvidia/nemotron-3-nano-4b');
  });

  it('picks the largest model for the quality tier', () => {
    expect(pickModelForTier(models, 'quality')).toBe('qwen/qwen3.6-35b-a3b');
  });

  it('returns the first candidate when tier is unset', () => {
    expect(pickModelForTier(models)).toBe('qwen/qwen3.6-35b-a3b');
  });

  it('skips embedding models when chat models exist', () => {
    const withEmbed = ['text-embedding-nomic-embed-text-v1.5', 'qwen/qwen3.5-9b'];
    expect(pickModelForTier(withEmbed, 'quick')).toBe('qwen/qwen3.5-9b');
    expect(pickModelForTier(withEmbed)).toBe('qwen/qwen3.5-9b');
  });

  it('falls back to the first candidate when no sizes are known', () => {
    const noSizes = ['model-alpha', 'model-beta'];
    expect(pickModelForTier(noSizes, 'quick')).toBe('model-alpha');
  });

  it('returns undefined for an empty list', () => {
    expect(pickModelForTier([], 'quick')).toBeUndefined();
  });
});

describe('workerEndpointHealthy', () => {
  function node(healthy: boolean): WorkerNodeInfo {
    return {
      capabilities: {
        localModelEndpoints: [
          { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234', models: ['m'], healthy },
        ],
      },
      id: 'node-1',
    } as unknown as WorkerNodeInfo;
  }

  it('is true when the matching endpoint reports healthy', () => {
    expect(workerEndpointHealthy([node(true)], 'node-1', 'openai-compatible', 'http://127.0.0.1:1234')).toBe(true);
  });

  it('is false when the matching endpoint reports unhealthy (LM Studio down)', () => {
    expect(workerEndpointHealthy([node(false)], 'node-1', 'openai-compatible', 'http://127.0.0.1:1234')).toBe(false);
  });

  it('is false when no endpoint matches the provider/baseUrl', () => {
    expect(workerEndpointHealthy([node(true)], 'node-1', 'ollama', 'http://127.0.0.1:11434')).toBe(false);
  });

  it('is false when the node id is missing or unknown', () => {
    expect(workerEndpointHealthy([node(true)], undefined, 'openai-compatible', 'http://127.0.0.1:1234')).toBe(false);
    expect(workerEndpointHealthy([node(true)], 'other', 'openai-compatible', 'http://127.0.0.1:1234')).toBe(false);
  });
});

describe('resolveSlotModel', () => {
  it('prefers an explicit per-slot model pin over the tier model', () => {
    expect(resolveSlotModel(slot({ model: 'pinned' }), 'quality', 'q', 'big')).toBe('pinned');
  });

  it('uses the quick tier model for the quick tier', () => {
    expect(resolveSlotModel(slot(), 'quick', 'small', 'big')).toBe('small');
  });

  it('uses the quality tier model for the quality tier', () => {
    expect(resolveSlotModel(slot(), 'quality', 'small', 'big')).toBe('big');
  });

  it('returns undefined (auto) when the tier model is empty', () => {
    expect(resolveSlotModel(slot(), 'quick', '', '')).toBeUndefined();
  });

  it('returns undefined (auto) when tier is undefined', () => {
    expect(resolveSlotModel(slot(), undefined, 'small', 'big')).toBeUndefined();
  });
});

describe('endpointAdvertisesModel', () => {
  it('is true when the model is in the advertised list', () => {
    expect(endpointAdvertisesModel('worker-node', 'gemma', ['gemma', 'qwen'])).toBe(true);
  });

  it('is false when a non-empty list does not include the model', () => {
    expect(endpointAdvertisesModel('worker-node', 'missing', ['gemma'])).toBe(false);
    expect(endpointAdvertisesModel('manual', 'missing', ['gemma'])).toBe(false);
  });

  it('does NOT trust an empty list for worker-node endpoints (authoritative heartbeat)', () => {
    expect(endpointAdvertisesModel('worker-node', 'gemma', [])).toBe(false);
  });

  it('trusts the pin on an empty list for non-worker endpoints (transient probe failure)', () => {
    expect(endpointAdvertisesModel('manual', 'gemma', [])).toBe(true);
    expect(endpointAdvertisesModel('localhost', 'gemma', [])).toBe(true);
  });
});

describe('backfillSlotTiers', () => {
  it('adds the default tier to slots missing one and returns updated JSON', () => {
    const raw = JSON.stringify({ compression: { enabled: true }, loopScoring: { enabled: true } });
    const out = backfillSlotTiers(raw);
    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!);
    expect(parsed.compression.tier).toBe('quality');
    expect(parsed.loopScoring.tier).toBe('quick');
  });

  it('does not overwrite an explicit tier', () => {
    const raw = JSON.stringify({ compression: { enabled: true, tier: 'quick' } });
    const out = backfillSlotTiers(raw);
    // compression keeps its explicit 'quick'; nothing else to change → no-op.
    expect(out).toBeNull();
  });

  it('returns null when every slot already has a tier (no change)', () => {
    const raw = JSON.stringify({ loopScoring: { enabled: true, tier: 'quick' } });
    expect(backfillSlotTiers(raw)).toBeNull();
  });

  it('returns null for unparseable JSON', () => {
    expect(backfillSlotTiers('{not json')).toBeNull();
  });
});

describe('DEFAULT_SLOT_TIERS', () => {
  it('tags scoring/routing/title slots quick and content slots quality', () => {
    expect(DEFAULT_SLOT_TIERS.loopScoring).toBe('quick');
    expect(DEFAULT_SLOT_TIERS.routingClassification).toBe('quick');
    expect(DEFAULT_SLOT_TIERS.approvalScoring).toBe('quick');
    expect(DEFAULT_SLOT_TIERS.titleGeneration).toBe('quick');
    expect(DEFAULT_SLOT_TIERS.compression).toBe('quality');
    expect(DEFAULT_SLOT_TIERS.memoryDistillation).toBe('quality');
    expect(DEFAULT_SLOT_TIERS.webExtract).toBe('quality');
  });
});
