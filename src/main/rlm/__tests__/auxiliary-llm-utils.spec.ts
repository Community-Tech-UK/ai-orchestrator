import { describe, it, expect } from 'vitest';
import {
  modelSizeScore,
  pickModelForTier,
  resolveSlotModel,
  workerEndpointHealthy,
  workerLoadedContexts,
  endpointAdvertisesModel,
  backfillSlotTiers,
  mergeMissingDefaultSlots,
  raiseSlotOutputBudget,
  DEFAULT_SLOT_TIERS,
} from '../auxiliary-llm-utils';
import { DEFAULT_SETTINGS } from '../../../shared/types/settings.types';
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

  describe('with loaded-model preference', () => {
    // gemma is loaded with a big context; the larger qwen-35b is NOT loaded.
    const ids = ['qwen/qwen3.6-35b-a3b', 'google/gemma-4-31b', 'nvidia/nemotron-3-nano-4b'];
    const loaded = new Map<string, number>([
      ['google/gemma-4-31b', 32768],
      ['nvidia/nemotron-3-nano-4b', 16384],
    ]);

    it('quality picks the loaded model with the largest context, not the bigger unloaded one', () => {
      // Without loaded info it would pick qwen-35b (largest size); with it, gemma wins.
      expect(pickModelForTier(ids, 'quality', loaded)).toBe('google/gemma-4-31b');
    });

    it('quick picks the smallest loaded model', () => {
      expect(pickModelForTier(ids, 'quick', loaded)).toBe('nvidia/nemotron-3-nano-4b');
    });

    it('falls back to size-based pick when nothing in the pool is loaded', () => {
      const otherLoaded = new Map<string, number>([['some-other-model', 8192]]);
      expect(pickModelForTier(ids, 'quality', otherLoaded)).toBe('qwen/qwen3.6-35b-a3b');
    });

    it('ignores an empty loaded map', () => {
      expect(pickModelForTier(ids, 'quality', new Map())).toBe('qwen/qwen3.6-35b-a3b');
    });
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

describe('workerLoadedContexts', () => {
  function node(loadedModels?: Array<{ id: string; contextLength: number }>): WorkerNodeInfo {
    return {
      id: 'node-1',
      capabilities: {
        localModelEndpoints: [
          { provider: 'openai-compatible', baseUrl: 'http://127.0.0.1:1234', models: ['a', 'b'], loadedModels, healthy: true },
        ],
      },
    } as unknown as WorkerNodeInfo;
  }

  it('maps loaded model ids to their context lengths', () => {
    const m = workerLoadedContexts(
      [node([{ id: 'a', contextLength: 32768 }, { id: 'b', contextLength: 4096 }])],
      'node-1', 'openai-compatible', 'http://127.0.0.1:1234',
    );
    expect(m.get('a')).toBe(32768);
    expect(m.get('b')).toBe(4096);
  });

  it('is empty when the worker reports no loaded models (older worker)', () => {
    expect(workerLoadedContexts([node(undefined)], 'node-1', 'openai-compatible', 'http://127.0.0.1:1234').size).toBe(0);
  });

  it('is empty for an unknown node', () => {
    expect(workerLoadedContexts([node([{ id: 'a', contextLength: 1 }])], 'other', 'openai-compatible', 'http://127.0.0.1:1234').size).toBe(0);
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

describe('raiseSlotOutputBudget', () => {
  it('raises a too-small budget up to the minimum', () => {
    const raw = JSON.stringify({ titleGeneration: { enabled: true, maxOutputTokens: 128 } });
    const out = raiseSlotOutputBudget(raw, 'titleGeneration', 512);
    expect(out).not.toBeNull();
    expect(JSON.parse(out!).titleGeneration.maxOutputTokens).toBe(512);
  });

  it('leaves a budget already at or above the minimum unchanged', () => {
    const raw = JSON.stringify({ titleGeneration: { maxOutputTokens: 512 } });
    expect(raiseSlotOutputBudget(raw, 'titleGeneration', 512)).toBeNull();
    expect(raiseSlotOutputBudget(JSON.stringify({ titleGeneration: { maxOutputTokens: 1024 } }), 'titleGeneration', 512)).toBeNull();
  });

  it('returns null when the slot is missing or has no numeric budget', () => {
    expect(raiseSlotOutputBudget(JSON.stringify({ other: { maxOutputTokens: 1 } }), 'titleGeneration', 512)).toBeNull();
    expect(raiseSlotOutputBudget(JSON.stringify({ titleGeneration: {} }), 'titleGeneration', 512)).toBeNull();
  });

  it('returns null for unparseable JSON', () => {
    expect(raiseSlotOutputBudget('{nope', 'titleGeneration', 512)).toBeNull();
  });
});

describe('mergeMissingDefaultSlots', () => {
  it('adds missing default slots without overwriting existing slot config', () => {
    const defaults = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as Record<string, unknown>;
    const persisted = { ...defaults };
    delete persisted['retrievalHypothesis'];

    const out = mergeMissingDefaultSlots(JSON.stringify(persisted));

    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!) as Record<string, unknown>;
    expect(parsed['retrievalHypothesis']).toEqual(defaults['retrievalHypothesis']);
    expect(mergeMissingDefaultSlots(out!)).toBeNull();
  });

  it('backfills the Part B branchScoring/subQueryExecution slots into legacy persisted JSON', () => {
    const defaults = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as Record<string, unknown>;
    const persisted = { ...defaults };
    delete persisted['branchScoring'];
    delete persisted['subQueryExecution'];

    const out = mergeMissingDefaultSlots(JSON.stringify(persisted));

    expect(out).not.toBeNull();
    const parsed = JSON.parse(out!) as Record<string, unknown>;
    expect(parsed['branchScoring']).toEqual(defaults['branchScoring']);
    expect(parsed['subQueryExecution']).toEqual(defaults['subQueryExecution']);
    expect(mergeMissingDefaultSlots(out!)).toBeNull();
  });

  it('returns null for unparseable JSON', () => {
    expect(mergeMissingDefaultSlots('{nope')).toBeNull();
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
    expect(DEFAULT_SLOT_TIERS.retrievalHypothesis).toBe('quick');
  });
});
