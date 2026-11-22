import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * A magic prompt is a background one-shot Harness starts by itself, so once Google has retired the Gemini sign-in
 * here it must not land on Gemini, whether Gemini comes from the fast preference list or from the caller.
 * Unlike the exclusions spec, `gemini` maps to itself here, as `mapSettingsToDetectionType` does.
 */

const state = vi.hoisted(() => ({ installed: new Set<string>() }));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({ getAll: () => ({ providersExcludedFromAutomation: [] }) }),
}));
vi.mock('../../cli/cli-detection', () => ({
  isCliAvailable: vi.fn(async (type: string) => ({ installed: state.installed.has(type) })),
}));
vi.mock('../../cli/adapters/adapter-factory', () => ({
  mapSettingsToDetectionType: vi.fn((type: string) => type),
  resolveCliType: vi.fn(async (type: string) => type),
}));
vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({ createAdapter: vi.fn() })),
}));

import { MagicPromptService } from '../magic-prompt-service';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import { GeminiRetirementRecord, getGeminiRetirementRecord } from '../../providers/gemini-retirement-record';

function serviceCapturingProvider() {
  const createAdapter = vi.fn(() => ({
    sendMessage: async () => ({
      id: 'r1',
      role: 'assistant' as const,
      content: '{"summary":"s","keyPoints":[],"openQuestions":[],"nextSteps":[]}',
    }),
  }) as unknown as CliAdapter);
  return { service: new MagicPromptService({ createAdapter }), createAdapter };
}

describe('magic prompt provider choice once Google has retired the Gemini sign-in here', () => {
  beforeEach(() => {
    state.installed = new Set(['gemini', 'copilot']);
    GeminiRetirementRecord._resetForTesting();
    vi.clearAllMocks();
  });

  it('uses Gemini from the fast list until the sign-in is retired, then the next installed provider', async () => {
    const before = serviceCapturingProvider();
    await before.service.run({ id: 'recap', text: 'some conversation text' });
    expect(before.createAdapter).toHaveBeenCalledWith('gemini', expect.anything());

    getGeminiRetirementRecord().recordRetired();

    const after = serviceCapturingProvider();
    await after.service.run({ id: 'recap', text: 'some conversation text' });
    expect(after.createAdapter).toHaveBeenCalledWith('copilot', expect.anything());
  });

  it('does not use Gemini when the caller asks for it after the sign-in is retired', async () => {
    getGeminiRetirementRecord().recordRetired();
    const { service, createAdapter } = serviceCapturingProvider();

    await service.run({ id: 'recap', text: 'some conversation text', provider: 'gemini' });

    expect(createAdapter).toHaveBeenCalledWith('copilot', expect.anything());
  });
});
