import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import type { AuxiliaryLlmSlotConfigMap } from '../../shared/types/auxiliary-llm.types';
import { AuxiliaryLlmService } from './auxiliary-llm-service';
import { generateWithOllama, listOllamaModels, probeOllamaEndpoint } from './auxiliary-model-client';
import { recordAuxiliaryAttribution } from '../core/system/cost-attribution';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }),
}));
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
// Exercise the real service and authorization path without the application ledger.
vi.mock('../core/system/cost-attribution', () => ({
  recordAuxiliaryAttribution: vi.fn(),
  reserveAuxiliarySpend: vi.fn(() => ({ allowed: true, spentUsd: 0 })),
}));

function configure(service: AuxiliaryLlmService): void {
  const slots = JSON.parse(DEFAULT_SETTINGS.auxiliaryLlmSlotsJson) as AuxiliaryLlmSlotConfigMap;
  slots.titleGeneration = { ...slots.titleGeneration, allowFrontierFallback: true };
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
}

describe('AuxiliaryLlmService helper backoff', () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(1_000);
    vi.resetAllMocks();
    AuxiliaryLlmService._resetForTesting();
    vi.mocked(probeOllamaEndpoint).mockResolvedValue(true);
    vi.mocked(listOllamaModels).mockResolvedValue([{
      id: 'test-model', name: 'test-model', provider: 'ollama', endpointId: 'test-local',
    }]);
  });

  afterEach(() => vi.useRealTimers());

  it('skips model and inventory work while paused, then retries at the deadline and clears on success', async () => {
    const service = AuxiliaryLlmService.getInstance();
    configure(service);
    const changed = vi.fn();
    service.on('auxiliary:helper-backoff-changed', changed);
    vi.mocked(generateWithOllama)
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockResolvedValueOnce('Recovered title');

    await service.generate('titleGeneration', 'system', 'user');
    await service.generate('titleGeneration', 'system', 'user');
    const inventoryCalls = vi.mocked(listOllamaModels).mock.calls.length;
    const paused = await service.generate('titleGeneration', 'system', 'user');

    expect(service.getHelperPauses()).toMatchObject([{
      slot: 'titleGeneration', failures: 2, pausedUntil: 61_000,
    }]);
    expect(paused.decision).toMatchObject({
      source: 'fallback', pausedUntil: 61_000, allowFrontierFallback: false,
    });
    expect(paused.decision.reason).toContain('Paused until');
    expect(generateWithOllama).toHaveBeenCalledTimes(2);
    expect(listOllamaModels).toHaveBeenCalledTimes(inventoryCalls);
    expect(changed.mock.calls.filter(([, transition]) => transition?.kind === 'paused')).toHaveLength(1);

    vi.setSystemTime(61_000);
    const recovered = await service.generate('titleGeneration', 'system', 'user');
    expect(recovered).toMatchObject({ text: 'Recovered title', decision: { source: 'local' } });
    expect(service.getHelperPauses()).toEqual([]);
    expect(changed.mock.calls.filter(([, transition]) => transition?.kind === 'resumed')).toHaveLength(1);
    expect(recordAuxiliaryAttribution).toHaveBeenCalledWith(expect.objectContaining({
      slot: 'titleGeneration', routedTo: 'local',
    }));
  });

  it('manual retry and settings change remove the pause without work during the pause', async () => {
    const service = AuxiliaryLlmService.getInstance();
    configure(service);
    vi.mocked(generateWithOllama).mockRejectedValue(new Error('model unavailable'));
    await service.generate('compression', 'system', 'user');
    await service.generate('compression', 'system', 'user');
    expect(service.getHelperPauses()).toHaveLength(1);
    const calls = vi.mocked(generateWithOllama).mock.calls.length;

    await service.generate('compression', 'system', 'user', { preserveInput: true });
    expect(generateWithOllama).toHaveBeenCalledTimes(calls);
    service.retryHelperNow('compression');
    expect(service.getHelperPauses()).toEqual([]);
    await service.generate('compression', 'system', 'user');
    expect(generateWithOllama).toHaveBeenCalledTimes(calls + 1);
    await service.generate('compression', 'system', 'user');
    expect(service.getHelperPauses()[0]?.pausedUntil).toBe(121_000);

    configure(service);
    expect(service.getHelperPauses()).toEqual([]);
    vi.mocked(generateWithOllama).mockResolvedValue('Summary');
    const result = await service.generate('compression', 'system', 'user', { preserveInput: true });
    expect(result).toMatchObject({ text: 'Summary', decision: { source: 'local' } });
  });

  it('keeps another helper slot routable when one slot has failed', async () => {
    const service = AuxiliaryLlmService.getInstance();
    configure(service);
    vi.mocked(generateWithOllama)
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockRejectedValueOnce(new Error('model unavailable'))
      .mockResolvedValueOnce('Summary');
    await service.generate('titleGeneration', 'system', 'user');
    await service.generate('titleGeneration', 'system', 'user');

    const result = await service.generate('compression', 'system', 'user');

    expect(result).toMatchObject({ text: 'Summary', decision: { source: 'local' } });
    expect(service.getHelperPauses()).toHaveLength(1);
    expect(generateWithOllama).toHaveBeenCalledTimes(3);
  });
});
