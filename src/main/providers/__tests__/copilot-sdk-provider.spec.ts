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
});
