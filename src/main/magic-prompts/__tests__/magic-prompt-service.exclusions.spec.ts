import { beforeEach, describe, expect, it, vi } from 'vitest';

/**
 * Covers the DEFAULT provider resolution path (not the injected-deps path the
 * main magic-prompt spec uses), because that is where the automation exclusion
 * lives. Asserted through the public `run()` result so the wiring is proven
 * end to end rather than by reaching into a private function.
 */

const state = vi.hoisted(() => ({
  excluded: [] as string[],
  installed: new Set<string>(),
}));

vi.mock('../../core/config/settings-manager', () => ({
  getSettingsManager: () => ({
    getAll: () => ({ providersExcludedFromAutomation: state.excluded }),
  }),
}));
vi.mock('../../cli/cli-detection', () => ({
  isCliAvailable: vi.fn(async (type: string) => ({ installed: state.installed.has(type) })),
}));
vi.mock('../../cli/adapters/adapter-factory', () => ({
  resolveCliType: vi.fn(async (type: string) => type),
}));
vi.mock('../../providers/provider-runtime-service', () => ({
  getProviderRuntimeService: vi.fn(() => ({ createAdapter: vi.fn() })),
}));

import { MagicPromptService } from '../magic-prompt-service';
import type { CliAdapter } from '../../cli/adapters/adapter-factory';
import { _resetAutomationProviderExclusionsForTesting } from '../../providers/automation-provider-exclusions';

function serviceCapturingProvider(): {
  service: MagicPromptService;
  createAdapter: ReturnType<typeof vi.fn>;
} {
  const createAdapter = vi.fn(() => ({
    sendMessage: async () => ({
      id: 'r1',
      role: 'assistant' as const,
      content:
        '{"summary":"s","keyPoints":[],"openQuestions":[],"nextSteps":[]}',
    }),
  }) as unknown as CliAdapter);
  // Only createAdapter is injected; resolveProvider stays on the real default
  // implementation, which is the code under test.
  return { service: new MagicPromptService({ createAdapter }), createAdapter };
}

describe('magic prompt provider resolution honours automation exclusions', () => {
  beforeEach(() => {
    state.excluded = [];
    state.installed = new Set(['copilot']);
    _resetAutomationProviderExclusionsForTesting();
    vi.clearAllMocks();
  });

  it('uses copilot from the fast preference list when nothing is excluded', async () => {
    const { service, createAdapter } = serviceCapturingProvider();

    const result = await service.run({ id: 'recap', text: 'some conversation text' });

    expect(result.ok).toBe(true);
    expect(createAdapter).toHaveBeenCalledWith('copilot', expect.anything());
  });

  it('skips an excluded provider in the fast preference list', async () => {
    state.excluded = ['copilot'];
    const { service, createAdapter } = serviceCapturingProvider();

    const result = await service.run({ id: 'recap', text: 'some conversation text' });

    expect(result).toMatchObject({
      ok: false,
      error: 'No CLI provider is available to run this command',
    });
    expect(createAdapter).not.toHaveBeenCalled();
  });

  it('falls past an excluded provider to the next installed one', async () => {
    state.excluded = ['copilot'];
    state.installed = new Set(['copilot', 'codex']);
    const { service, createAdapter } = serviceCapturingProvider();

    const result = await service.run({ id: 'recap', text: 'some conversation text' });

    expect(result.ok).toBe(true);
    expect(createAdapter).toHaveBeenCalledWith('codex', expect.anything());
  });

  it('ignores an explicitly requested provider that is excluded', async () => {
    // A magic prompt is background automation; a caller-supplied provider is
    // still an automatic choice, so the exclusion applies to it too.
    state.excluded = ['copilot'];
    state.installed = new Set(['copilot', 'codex']);
    const { service, createAdapter } = serviceCapturingProvider();

    const result = await service.run({
      id: 'recap',
      text: 'some conversation text',
      provider: 'copilot',
    });

    expect(result.ok).toBe(true);
    expect(createAdapter).toHaveBeenCalledWith('codex', expect.anything());
  });

  it('still honours an explicitly requested provider that is not excluded', async () => {
    state.excluded = ['copilot'];
    state.installed = new Set(['copilot', 'codex', 'claude']);
    const { service, createAdapter } = serviceCapturingProvider();

    const result = await service.run({
      id: 'recap',
      text: 'some conversation text',
      provider: 'codex',
    });

    expect(result.ok).toBe(true);
    expect(createAdapter).toHaveBeenCalledWith('codex', expect.anything());
  });
});
