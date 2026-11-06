import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import { AuxiliaryLlmService } from './auxiliary-llm-service';
import { generateWithOllama, listOllamaModels, probeOllamaEndpoint } from './auxiliary-model-client';
import { recordAuxiliaryAttribution } from '../core/system/cost-attribution';
import type { AuxiliaryLlmSlotConfigMap } from '../../shared/types/auxiliary-llm.types';

vi.mock('./token-counter', () => ({
  getTokenCounter: () => ({ countTokens: (text: string) => text.length }),
}));
vi.mock('./auxiliary-model-client', () => ({
  probeOllamaEndpoint: vi.fn(),
  listOllamaModels: vi.fn(),
  generateWithOllama: vi.fn(),
  probeOpenAiCompatibleEndpoint: vi.fn(),
  listOpenAiCompatibleModels: vi.fn(),
  generateWithOpenAiCompatible: vi.fn(),
}));
// No application cost ledger or database writes in this focused service test.
vi.mock('../core/system/cost-attribution', () => ({
  recordAuxiliaryAttribution: vi.fn(),
  reserveAuxiliarySpend: vi.fn(() => ({ allowed: true, spentUsd: 0 })),
}));

function configureCompression(maxInputTokens: number): AuxiliaryLlmService {
  const service = AuxiliaryLlmService.getInstance();
  const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;
  slots.compression = { ...slots.compression, maxInputTokens, allowFrontierFallback: false };
  service.configure({
    ...DEFAULT_SETTINGS,
    auxiliaryLlmRoutingMode: 'local-first',
    auxiliaryLlmUseLocalhostOllama: false,
    auxiliaryLlmEndpointsJson: JSON.stringify([{
      id: 'test-local', label: 'Local test endpoint', provider: 'ollama',
      baseUrl: 'http://127.0.0.1:11434', source: 'manual', enabled: true,
    }]),
    auxiliaryLlmSlotsJson: JSON.stringify(slots),
  });
  return service;
}

describe('AuxiliaryLlmService preserveInput', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    AuxiliaryLlmService._resetForTesting();
    vi.mocked(probeOllamaEndpoint).mockResolvedValue(true);
    vi.mocked(listOllamaModels).mockResolvedValue([{
      id: 'test-model', name: 'test-model', provider: 'ollama', endpointId: 'test-local',
    }]);
    vi.mocked(generateWithOllama).mockResolvedValue('A complete summary');
  });

  it('dispatches the exact fitted system and user text through the normal local route', async () => {
    const service = configureCompression(34_000);
    const system = 'S'.repeat(2_000);
    const user = 'U'.repeat(32_000);
    const truncations: unknown[] = [];
    service.on('auxiliary:input-truncated', event => truncations.push(event));

    const result = await service.generate('compression', system, user, { preserveInput: true });

    expect(result).toMatchObject({ text: 'A complete summary', decision: { source: 'local' } });
    expect(vi.mocked(generateWithOllama)).toHaveBeenCalledOnce();
    expect(vi.mocked(generateWithOllama).mock.calls[0]?.[1]).toMatchObject({
      systemPrompt: system, userPrompt: user,
    });
    expect(truncations).toEqual([]);
    expect(vi.mocked(recordAuxiliaryAttribution)).toHaveBeenCalledWith(expect.objectContaining({
      routedTo: 'local', usage: { inputTokens: 34_000, outputTokens: 18 },
    }));
  });

  it('rejects system and template overhead above the slot limit before any model work', async () => {
    const service = configureCompression(100);
    const system = 'Summary system instructions.';
    const user = `<prior_summary>${'U'.repeat(50)}</prior_summary>`;
    const truncations: unknown[] = [];
    service.on('auxiliary:input-truncated', event => truncations.push(event));

    await expect(service.generate('compression', system, user, { preserveInput: true }))
      .rejects.toThrow(/input limit/i);

    expect(probeOllamaEndpoint).not.toHaveBeenCalled();
    expect(listOllamaModels).not.toHaveBeenCalled();
    expect(generateWithOllama).not.toHaveBeenCalled();
    expect(recordAuxiliaryAttribution).not.toHaveBeenCalled();
    expect(truncations).toEqual([]);
  });

  it('rechecks the current compression limit if settings changed after fitting', async () => {
    const service = configureCompression(150);
    configureCompression(100);

    await expect(service.generate('compression', 'S'.repeat(25), 'U'.repeat(95), { preserveInput: true }))
      .rejects.toThrow(/input limit/i);
    expect(generateWithOllama).not.toHaveBeenCalled();
  });

  it('keeps ordinary prompt truncation and the truncation event', async () => {
    const service = configureCompression(100);
    const user = 'U'.repeat(200);
    const truncations: unknown[] = [];
    service.on('auxiliary:input-truncated', event => truncations.push(event));

    const result = await service.generate('compression', 'S'.repeat(10), user);

    expect(result.decision.source).toBe('local');
    expect(vi.mocked(generateWithOllama)).toHaveBeenCalledOnce();
    expect(vi.mocked(generateWithOllama).mock.calls[0]?.[1].userPrompt).not.toBe(user);
    expect(truncations).toEqual([{ slot: 'compression', originalTokens: 210, targetTokens: 90 }]);
  });
});
