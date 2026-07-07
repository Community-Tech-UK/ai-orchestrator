import { describe, it, expect, vi, beforeEach } from 'vitest';
import { HookManager } from '../hook-manager';
import { getHookEngine, _resetHookEngineForTesting } from '../hook-engine';

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
    _resetHookEngineForTesting();
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

  it('runs HookEngine lifecycle block rules before executable hooks', async () => {
    const manager = HookManager.getInstance();

    getHookEngine().registerRule({
      id: 'block-secret-prompt',
      name: 'Block Secret Prompt',
      enabled: true,
      event: 'UserPromptSubmit',
      conditions: [{ field: 'userPrompt', operator: 'contains', pattern: 'secret' }],
      action: 'block',
      message: 'Secret prompts must be reviewed first.',
      source: 'user',
      createdAt: Date.now(),
    });

    manager.registerHook({
      id: 'user-prompt-executable',
      name: 'User Prompt Executable',
      event: 'UserPromptSubmit',
      enabled: true,
      handler: { type: 'command', command: 'echo "should not run"' },
    });

    const result = await manager.triggerLifecycleHooks('UserPromptSubmit', {
      instanceId: 'test-block',
      sessionId: 'session-block',
      userPrompt: 'contains a secret value',
    });

    expect(result.blocked).toBe(true);
    expect(result.ruleResult.action).toBe('block');
    expect(result.executorResults).toHaveLength(0);
    expect(result.message).toContain('Secret prompts must be reviewed first.');
  });

  it('continues to executable hooks when HookEngine rules only warn', async () => {
    const manager = HookManager.getInstance();

    getHookEngine().registerRule({
      id: 'warn-long-prompt',
      name: 'Warn Long Prompt',
      enabled: true,
      event: 'UserPromptSubmit',
      conditions: [{ field: 'userPrompt', operator: 'contains', pattern: 'review' }],
      action: 'warn',
      message: 'Review prompt detected.',
      source: 'user',
      createdAt: Date.now(),
    });

    manager.registerHook({
      id: 'user-prompt-executable-warn',
      name: 'User Prompt Executable Warn',
      event: 'UserPromptSubmit',
      enabled: true,
      handler: { type: 'command', command: 'echo "runs after warn"' },
    });

    const result = await manager.triggerLifecycleHooks('UserPromptSubmit', {
      instanceId: 'test-warn',
      sessionId: 'session-warn',
      userPrompt: 'please review this change',
    });

    expect(result.blocked).toBe(false);
    expect(result.ruleResult.action).toBe('warn');
    expect(result.executorResults).toHaveLength(1);
    expect(result.executorResults[0].hookId).toBe('user-prompt-executable-warn');
  });
});
