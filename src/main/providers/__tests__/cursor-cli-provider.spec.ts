import { describe, it, expect } from 'vitest';
import { CursorCliProvider } from '../cursor-cli-provider';
import type { ProviderConfig } from '@shared/types/provider.types';

const makeConfig = (): ProviderConfig => ({
  type: 'cursor',
  name: 'Cursor CLI',
  enabled: true,
});

describe('CursorCliProvider identity', () => {
  it('reports provider = cursor', () => {
    const p = new CursorCliProvider(makeConfig());
    expect(p.provider).toBe('cursor');
  });

  it('declares Wave 2 adapter capabilities', () => {
    const p = new CursorCliProvider(makeConfig());
    expect(p.capabilities).toEqual({
      interruption: true,
      permissionPrompts: false,
      sessionResume: true,
      streamingOutput: true,
      usageReporting: true,
      subAgents: false,
    });
  });

  it('getType returns cursor', () => {
    expect(new CursorCliProvider(makeConfig()).getType()).toBe('cursor');
  });

  it('reports inactive/null accessors before initialize', () => {
    const p = new CursorCliProvider(makeConfig());
    expect(p.isRunning()).toBe(false);
    expect(p.getPid()).toBeNull();
    expect(p.getUsage()).toBeNull();
  });

  it('populates currentUsage when a context event is processed', () => {
    const p = new CursorCliProvider(makeConfig());
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
