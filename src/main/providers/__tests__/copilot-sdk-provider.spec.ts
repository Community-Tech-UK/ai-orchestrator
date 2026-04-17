import { describe, it, expect } from 'vitest';
import { CopilotSdkProvider } from '../copilot-sdk-provider';
import type { ProviderConfig } from '@shared/types/provider.types';

const makeConfig = (): ProviderConfig => ({
  type: 'copilot',
  name: 'GitHub Copilot CLI',
  enabled: true,
});

describe('CopilotSdkProvider identity', () => {
  it('reports provider = copilot', () => {
    const p = new CopilotSdkProvider(makeConfig());
    expect(p.provider).toBe('copilot');
  });

  it('declares Wave 2 adapter capabilities', () => {
    const p = new CopilotSdkProvider(makeConfig());
    expect(p.capabilities).toEqual({
      interruption: true,
      permissionPrompts: false,
      sessionResume: true,
      streamingOutput: true,
      usageReporting: true,
      subAgents: false,
    });
  });

  it('getType returns copilot', () => {
    const p = new CopilotSdkProvider(makeConfig());
    expect(p.getType()).toBe('copilot');
  });

  it('reports inactive/null accessors before initialize', () => {
    const p = new CopilotSdkProvider(makeConfig());
    expect(p.isRunning()).toBe(false);
    expect(p.getPid()).toBeNull();
    expect(p.getUsage()).toBeNull();
  });

  it('populates currentUsage when a context event is processed', () => {
    const p = new CopilotSdkProvider(makeConfig());
    // Invoke the private updateUsageFromContext handler directly. This is the
    // same path the 'context' event listener registered in initialize() takes,
    // so it verifies the capability-declared usageReporting actually works
    // without needing to stand up the full Copilot SDK adapter.
    (p as unknown as { updateUsageFromContext: (c: { used: number; total: number; percentage: number }) => void })
      .updateUsageFromContext({ used: 1000, total: 200000, percentage: 0.5 });

    const usage = p.getUsage();
    expect(usage).not.toBeNull();
    expect(usage!.totalTokens).toBe(1000);
    expect(usage!.inputTokens).toBe(700);
    expect(usage!.outputTokens).toBe(300);
    expect(usage!.estimatedCost).toBeGreaterThan(0);
  });
});
