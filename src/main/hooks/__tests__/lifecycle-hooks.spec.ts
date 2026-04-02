import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookManager } from '../hook-manager';

// Mock electron app
vi.mock('electron', () => ({
  app: { getPath: () => '/tmp/test-hooks' },
}));

// Mock the hook executor to avoid running real shell commands
vi.mock('../hook-executor', () => ({
  getHookExecutor: () => ({
    execute: vi.fn(async (hook: { id: string }) => ({
      hookId: hook.id,
      success: true,
      duration: 5,
      timestamp: Date.now(),
    })),
  }),
  HookExecutor: vi.fn(),
}));

describe('Lifecycle Hook Events', () => {
  beforeEach(() => {
    HookManager._resetForTesting();
  });

  it('triggers PreSampling hooks', async () => {
    const manager = HookManager.getInstance();

    manager.registerHook({
      id: 'pre-sampling-test',
      name: 'Pre-Sampling Test',
      event: 'PreSampling',
      enabled: true,
      handler: { type: 'command', command: 'echo "pre-sampling"' },
    });

    const results = await manager.triggerHooks('PreSampling', {
      instanceId: 'test',
    });

    expect(results).toHaveLength(1);
    expect(results[0].hookId).toBe('pre-sampling-test');
    expect(results[0].success).toBe(true);
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
    });

    expect(results).toHaveLength(1);
    expect(results[0].hookId).toBe('post-sampling-test');
    expect(results[0].success).toBe(true);
  });

  it('does not trigger PreSampling hooks on other events', async () => {
    const manager = HookManager.getInstance();

    manager.registerHook({
      id: 'pre-sampling-only',
      name: 'Pre-Sampling Only',
      event: 'PreSampling',
      enabled: true,
      handler: { type: 'command', command: 'echo "pre"' },
    });

    const results = await manager.triggerHooks('PostToolUse', {
      instanceId: 'test',
    });

    expect(results).toHaveLength(0);
  });
});
