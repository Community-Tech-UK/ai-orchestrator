import { describe, it, expect, beforeEach, vi } from 'vitest';
import { PermissionRegistry } from '../permission-registry';
import { classifyToolCategory, evaluateOrchestrationCapability } from '../role-capability-policy';

describe('PermissionRegistry', () => {
  beforeEach(() => {
    PermissionRegistry._resetForTesting();
  });

  it('should register and resolve a permission', async () => {
    const registry = PermissionRegistry.getInstance();
    const promise = registry.requestPermission({
      id: 'perm-1', instanceId: 'inst-1', action: 'write_file',
      description: 'Write to /tmp/test.txt', createdAt: Date.now(), timeoutMs: 5000,
    });

    expect(registry.getPendingCount()).toBe(1);
    registry.resolve('perm-1', true, 'user');

    const decision = await promise;
    expect(decision.granted).toBe(true);
    expect(decision.decidedBy).toBe('user');
    expect(registry.getPendingCount()).toBe(0);
  });

  it('should deny on timeout', async () => {
    vi.useFakeTimers();
    const registry = PermissionRegistry.getInstance();
    const promise = registry.requestPermission({
      id: 'perm-2', instanceId: 'inst-1', action: 'delete_file',
      description: 'Delete /tmp/test.txt', createdAt: Date.now(), timeoutMs: 100,
    });

    vi.advanceTimersByTime(150);
    const decision = await promise;
    expect(decision.granted).toBe(false);
    expect(decision.decidedBy).toBe('timeout');
    vi.useRealTimers();
  });

  it('should handle resolving unknown request gracefully', () => {
    const registry = PermissionRegistry.getInstance();
    registry.resolve('nonexistent', true, 'user'); // Should not throw
  });

  it('should list pending requests', () => {
    const registry = PermissionRegistry.getInstance();
    registry.requestPermission({ id: 'a', instanceId: 'i1', action: 'bash', description: 'Run cmd', createdAt: Date.now(), timeoutMs: 5000 });
    registry.requestPermission({ id: 'b', instanceId: 'i2', action: 'write', description: 'Write file', createdAt: Date.now(), timeoutMs: 5000 });
    expect(registry.listPending()).toHaveLength(2);
  });

  it('should clean up on instance removal', () => {
    const registry = PermissionRegistry.getInstance();
    registry.requestPermission({ id: 'c', instanceId: 'remove-me', action: 'bash', description: 'Something', createdAt: Date.now(), timeoutMs: 60000 });
    expect(registry.getPendingCount()).toBe(1);
    registry.clearForInstance('remove-me');
    expect(registry.getPendingCount()).toBe(0);
  });

  it('extend() pushes the timeout out so the request survives past its original deadline', async () => {
    vi.useFakeTimers();
    try {
      const registry = PermissionRegistry.getInstance();
      const promise = registry.requestPermission({
        id: 'ext-1', instanceId: 'inst-1', action: 'desktop_computer_use_grant',
        description: 'Allow Computer Use for Calculator', createdAt: Date.now(), timeoutMs: 60_000,
      });

      // Extend by another 60s just before the original 60s deadline.
      vi.advanceTimersByTime(59_000);
      const extended = registry.extend('ext-1', 60_000);
      expect(extended).toBeDefined();

      // Past the ORIGINAL deadline (60_000ms total) the request must still be
      // pending — this is the behaviour the extend button exists to produce.
      vi.advanceTimersByTime(1_500);
      expect(registry.getPendingCount()).toBe(1);

      // Resolve manually before the extended window lapses so this test does
      // not depend on advancing all the way to the new deadline.
      registry.resolve('ext-1', true, 'user');
      const decision = await promise;
      expect(decision.granted).toBe(true);
      expect(decision.decidedBy).toBe('user');
    } finally {
      vi.useRealTimers();
    }
  });

  it('extend() on an unknown or already-resolved request is a safe no-op', () => {
    const registry = PermissionRegistry.getInstance();
    expect(registry.extend('does-not-exist', 60_000)).toBeUndefined();
  });

  it('getPending() returns the live request for a pending id and undefined otherwise', () => {
    const registry = PermissionRegistry.getInstance();
    registry.requestPermission({
      id: 'get-1', instanceId: 'inst-1', action: 'store_release_mutation',
      description: 'Allow App Store release', createdAt: Date.now(), timeoutMs: 5000,
    });
    expect(registry.getPending('get-1')?.action).toBe('store_release_mutation');
    expect(registry.getPending('missing')).toBeUndefined();
  });
});

describe('role capability policy', () => {
  it('allows parents to spawn children but blocks workers from spawning recursively', () => {
    const command = {
      action: 'spawn_child' as const,
      task: 'Review this patch',
    };

    expect(evaluateOrchestrationCapability('parent_orchestrator', command).allowed).toBe(true);
    const workerDecision = evaluateOrchestrationCapability('worker', command);
    expect(workerDecision.allowed).toBe(false);
    expect(workerDecision.reason).toContain('worker cannot spawn');
  });

  it('allows workers to report results', () => {
    const command = {
      action: 'report_result' as const,
      summary: 'done',
      success: true,
    };

    expect(evaluateOrchestrationCapability('worker', command).allowed).toBe(true);
  });

  it('applies result-reporting policy to legacy report commands', () => {
    const legacyCommand = {
      action: 'report_task_complete' as const,
      summary: 'done',
      success: true,
    };

    expect(evaluateOrchestrationCapability('worker', legacyCommand).allowed).toBe(true);
    expect(evaluateOrchestrationCapability('parent_orchestrator', legacyCommand).allowed).toBe(false);
  });

  it('blocks spawn requests for providers outside the role allowlist', () => {
    const command = {
      action: 'spawn_child' as const,
      task: 'Review this patch',
      provider: 'unknown-provider' as never,
    };

    const decision = evaluateOrchestrationCapability('parent_orchestrator', command);
    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('unknown-provider');
  });

  it('classifies tool commands and blocks disallowed role categories', () => {
    expect(classifyToolCategory('mcp__lsp__lsp_diagnostics')).toBe('read');
    expect(classifyToolCategory('mcp__webhook__send')).toBe('webhook');

    const decision = evaluateOrchestrationCapability('worker', {
      action: 'call_tool',
      toolId: 'mcp__webhook__send',
    });

    expect(decision.allowed).toBe(false);
    expect(decision.category).toBe('webhook');
  });

  it('denies filesystem write tools for reviewer roles', () => {
    const decision = evaluateOrchestrationCapability('reviewer', {
      action: 'call_tool',
      toolId: 'filesystem_write_file',
      args: { path: '/tmp/a' },
    });

    expect(decision.allowed).toBe(false);
    expect(decision.reason).toContain('filesystem_write');
  });
});
