import { beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_SETTINGS } from '../../shared/types/settings.types';
import { AuxiliaryLlmService } from './auxiliary-llm-service';

vi.mock('../logging/logger', () => ({ getLogger: () => ({ warn: vi.fn(), info: vi.fn(), debug: vi.fn() }) }));
vi.mock('./token-counter', () => ({ getTokenCounter: () => ({ countTokens: (value: string) => value.length, truncateToTokens: (value: string) => value }) }));
beforeEach(() => AuxiliaryLlmService._resetForTesting());
describe('paused helpers skip endpoint resolution', () => {
  it('returns fallback with pausedUntil without a third probe; configure clears it', async () => {
    const service = AuxiliaryLlmService.getInstance(); service.configure(DEFAULT_SETTINGS);
    const resolve = vi.spyOn(service as unknown as { resolveEndpointForSlot: () => Promise<null> }, 'resolveEndpointForSlot').mockResolvedValue(null);
    await service.generate('titleGeneration', 'system', 'user');
    await service.generate('titleGeneration', 'system', 'user');
    const third = await service.generate('titleGeneration', 'system', 'user');
    expect(resolve).toHaveBeenCalledTimes(2);
    expect(third.decision.pausedUntil).toBeGreaterThan(Date.now());
    expect(third.decision.reason).toContain('Paused until');
    service.configure(DEFAULT_SETTINGS);
    await service.generate('titleGeneration', 'system', 'user');
    expect(resolve).toHaveBeenCalledTimes(3);
  });
});
