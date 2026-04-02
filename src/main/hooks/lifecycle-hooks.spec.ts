import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookManager } from './hook-manager';

// Mock electron
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-hooks' },
}));

describe('Lifecycle Hook Events', () => {
  beforeEach(() => {
    HookManager._resetForTesting();
  });

  it('triggers PreSampling hooks', async () => {
    const manager = HookManager.getInstance();
    const handler = vi.fn();
    manager.on('hook:executed', handler);

    manager.registerHook({
      id: 'pre-sampling-test',
      name: 'Pre-Sampling Test',
      event: 'PreSampling',
      enabled: true,
      handler: { type: 'command', command: 'echo "pre-sampling"' },
    });

    const results = await manager.triggerHooks('PreSampling', {
      instanceId: 'test',
      messageCount: 10,
      estimatedTokens: 5000,
    });

    expect(results).toHaveLength(1);
  });

  it('triggers PostSampling hooks', async () => {
    const manager = HookManager.getInstance();

    manager.registerHook({
      id: 'post-sampling-test',
      name: 'Post-Sampling Test',
      event: 'PostSampling',
      enabled: true,
      handler: { type: 'command', command: 'echo "post-sampling"' },
    });

    const results = await manager.triggerHooks('PostSampling', {
      instanceId: 'test',
      modelResponse: 'I will help you...',
      responseTokens: 500,
      modelId: 'claude-sonnet',
    });

    expect(results).toHaveLength(1);
  });
});
