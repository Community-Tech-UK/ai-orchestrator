import { afterEach, describe, expect, it, vi } from 'vitest';

vi.mock('../logging/logger', () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), debug: vi.fn(), error: vi.fn() }),
}));

import { getBootstrapModules, resetBootstrapRegistryForTesting } from './index';
import { registerOrchestrationBootstrap } from './orchestration-bootstrap';
import { reportGeminiSignInOutcome, setGeminiSignInObserver } from '../cli/adapters/gemini-client-retired';
import { GeminiRetirementRecord, getGeminiRetirementRecord } from '../providers/gemini-retirement-record';

describe('registerOrchestrationBootstrap', () => {
  afterEach(() => {
    resetBootstrapRegistryForTesting();
    setGeminiSignInObserver(undefined);
    GeminiRetirementRecord._resetForTesting();
  });

  it('starts keeping the Gemini sign-in record, so Google\'s message from a Gemini run here is remembered', async () => {
    registerOrchestrationBootstrap();
    const module = getBootstrapModules().find((item) => item.name === 'Gemini sign-in record');
    expect(module?.failureMode).toBe('degraded');

    reportGeminiSignInOutcome('retired');
    expect(getGeminiRetirementRecord().isRetired()).toBe(false);

    await module?.init();
    reportGeminiSignInOutcome('retired');

    expect(getGeminiRetirementRecord().isRetired()).toBe(true);
  });
});
