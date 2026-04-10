import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn().mockReturnValue('/tmp/test-home'),
    getAppPath: vi.fn().mockReturnValue('/tmp/test-app'),
  },
}));

vi.mock('../../orchestration/multi-verify-coordinator', () => ({
  getMultiVerifyCoordinator: vi.fn().mockReturnValue({
    on: vi.fn(),
  }),
}));

vi.mock('../../logging/logger', () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
    error: vi.fn(),
  }),
}));

import {
  OrchestratorPluginManager,
  _resetOrchestratorPluginManagerForTesting,
} from '../plugin-manager';

describe('emitHook', () => {
  beforeEach(() => {
    _resetOrchestratorPluginManagerForTesting();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it('is a public method on the plugin manager', () => {
    const manager = OrchestratorPluginManager.getInstance();
    expect(typeof manager.emitHook).toBe('function');
  });

  it('does not throw when no plugins are loaded', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    await expect(
      manager.emitHook('instance.stateChanged', {
        instanceId: 'test-1',
        previousState: 'idle',
        newState: 'busy',
        timestamp: Date.now(),
      }),
    ).resolves.not.toThrow();
  });

  it('catches errors from misbehaving plugin hooks', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    // Manually inject a cached plugin with a throwing hook
    const throwingHook = vi.fn(() => { throw new Error('Plugin crash!'); });
    (manager as any).cacheByWorkingDir.set('/tmp/test', {
      loadedAt: Date.now(),
      plugins: [{
        filePath: '/tmp/test/bad-plugin.js',
        hooks: { 'instance.stateChanged': throwingHook },
      }],
      errors: [],
    });

    // Should not throw
    await expect(
      manager.emitHook('instance.stateChanged', {
        instanceId: 'test-1',
        previousState: 'idle',
        newState: 'busy',
        timestamp: Date.now(),
      }),
    ).resolves.not.toThrow();

    // But the hook WAS called
    expect(throwingHook).toHaveBeenCalledOnce();
  });

  it('times out slow plugin hooks after 5 seconds', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    // Inject a plugin with a hook that never resolves
    const neverResolve = vi.fn(() => new Promise(() => {})); // hangs forever
    (manager as any).cacheByWorkingDir.set('/tmp/test', {
      loadedAt: Date.now(),
      plugins: [{
        filePath: '/tmp/test/slow-plugin.js',
        hooks: { 'instance.stateChanged': neverResolve },
      }],
      errors: [],
    });

    // Use fake timers to avoid waiting 5 real seconds
    vi.useFakeTimers();
    const hookPromise = manager.emitHook('instance.stateChanged', {
      instanceId: 'test-1',
      previousState: 'idle',
      newState: 'busy',
      timestamp: Date.now(),
    });

    // Advance time past the 5s timeout
    vi.advanceTimersByTime(6_000);

    // Should resolve (timeout caught, logged, continued)
    await expect(hookPromise).resolves.not.toThrow();
  });

  it('calls hooks from all cached working directories', async () => {
    const manager = OrchestratorPluginManager.getInstance();
    const hook1 = vi.fn();
    const hook2 = vi.fn();

    (manager as any).cacheByWorkingDir.set('/project-a', {
      loadedAt: Date.now(),
      plugins: [{ filePath: '/project-a/plugin.js', hooks: { 'session.created': hook1 } }],
      errors: [],
    });
    (manager as any).cacheByWorkingDir.set('/project-b', {
      loadedAt: Date.now(),
      plugins: [{ filePath: '/project-b/plugin.js', hooks: { 'session.created': hook2 } }],
      errors: [],
    });

    await manager.emitHook('session.created', { instanceId: 'i-1', sessionId: 's-1' });

    expect(hook1).toHaveBeenCalledWith({ instanceId: 'i-1', sessionId: 's-1' });
    expect(hook2).toHaveBeenCalledWith({ instanceId: 'i-1', sessionId: 's-1' });
  });
});
